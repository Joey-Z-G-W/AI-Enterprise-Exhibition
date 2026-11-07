"""Explicit offline and configured production application factories."""

from contextlib import AsyncExitStack, asynccontextmanager
from typing import Annotated

import httpx
from fastapi import Depends, FastAPI, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field

from exhibition_guide.answer import AnswerService, QuestionRequest, QuestionResponse, error_response
from exhibition_guide.config import AppConfig, load_config
from exhibition_guide.evidence_model import ModelEvidenceEvaluator, ModelQuestionRewriter
from exhibition_guide.context import ContextStore, Invalidation, Rewriter
from exhibition_guide.knowledge import KnowledgeClient
from exhibition_guide.llm import ModelClient
from exhibition_guide.tour import TourPlanner, PlaybackReceipt
from exhibition_guide.media import MediaCatalog, PresentedQuestionResponse
from starlette.concurrency import run_in_threadpool


class UIConfigResponse(BaseModel):
    """Only the public pair needed to create and voice a media session."""

    model_config = ConfigDict(strict=True, extra="forbid", frozen=True)
    avatar_id: str = Field(min_length=1, max_length=128, pattern=r"^\S+$")
    tts_voice: str = Field(min_length=1, max_length=128, pattern=r"^\S+$")


def get_answer_service(request: Request) -> AnswerService | None:
    return request.app.state.answer_service


def create_app(config: AppConfig | None = None, *, service: AnswerService | None = None, rewriter: Rewriter | None = None) -> FastAPI:
    """No filesystem configuration access; callers explicitly supply enabled config."""
    config = config if config is not None else AppConfig()
    media = MediaCatalog(config.media)

    @asynccontextmanager
    async def lifespan(application: FastAPI):
        application.state.answer_service = service
        async with AsyncExitStack() as stack:
            if service is None and config.llm.enabled and config.knowledge.kb_id:
                try:
                    http = await stack.enter_async_context(httpx.AsyncClient(base_url=config.knowledge.base_url))
                    model = await stack.enter_async_context(ModelClient(config.llm))
                except Exception:
                    # Initialization errors can contain proxy URLs; never expose raw inputs.
                    raise RuntimeError("Answer service initialization failed") from None
                application.state.answer_service = AnswerService(
                    KnowledgeClient(http), ModelEvidenceEvaluator(model, media),
                    kb_id=config.knowledge.kb_id, timeout=config.llm.timeout_seconds,
                    narration_resolver=media.resolve_narration, visual_resolver=media.resolve_visual,
                )
                application.state.rewriter = ModelQuestionRewriter(model)
            try:
                yield
            finally:
                application.state.history.clear()
                application.state.answer_service = None
                application.state.rewriter = rewriter

    application = FastAPI(title="Exhibition Guide", lifespan=lifespan)
    application.state.answer_service = service
    application.state.history = ContextStore(tour_planner=TourPlanner(media))
    application.state.rewriter = rewriter

    @application.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @application.get("/ui-config", response_model=UIConfigResponse)
    def ui_config(response: Response) -> UIConfigResponse:
        response.headers["X-Guide-Speech-Mode"] = "paragraph"
        return UIConfigResponse(
            avatar_id=config.avatar.avatar_id, tts_voice=config.avatar.tts_voice,
        )

    @application.get("/media/{asset_id}")
    @application.head("/media/{asset_id}", include_in_schema=False)
    def media_file(asset_id: str, request: Request) -> Response:
        return media.response(asset_id, request)

    @application.post("/questions", response_model=PresentedQuestionResponse, response_model_exclude_unset=True)
    async def questions(
        request: QuestionRequest, response: Response,
        answer_service: Annotated[AnswerService | None, Depends(get_answer_service)],
    ) -> QuestionResponse:
        result = (
            error_response(request, "service_not_configured")
            if answer_service is None else await application.state.history.answer(request, answer_service, application.state.rewriter)
        )
        if result.status == "error":
            response.status_code = (
                503 if result.error_code == "service_not_configured"
                else 429 if result.error_code == "visitor_capacity"
                else 409 if result.error_code in {"turn_stale", "turn_conflict", "turn_cancelled", "visitor_retired"}
                else 504 if result.error_code and result.error_code.endswith("_timeout") else 502
            )
        presentation = await run_in_threadpool(media.presentation, result)
        # Explicitly serialize legacy defaults (sources/error_code) while keeping
        # the sentence plan optional when the reviewed catalog is unavailable.
        payload = result.model_dump()
        if presentation is not None:
            payload["presentation"] = presentation
        return PresentedQuestionResponse.model_validate(payload)

    @application.post("/visitors/{visitor_id}/playback")
    async def playback_receipt(visitor_id: str, body: PlaybackReceipt) -> dict:
        try:
            return application.state.history.playback(visitor_id, body)
        except ValueError as error:
            raise HTTPException(409, str(error)) from None

    @application.post("/visitors/{visitor_id}/invalidate")
    async def invalidate(visitor_id: str, body: Invalidation) -> dict:
        if not visitor_id.strip() or len(visitor_id) > 128:
            raise HTTPException(422, "invalid visitor identity")
        try:
            return application.state.history.invalidate(visitor_id, body)
        except ValueError:
            raise HTTPException(429, "visitor_capacity") from None

    return application


def create_production_app() -> FastAPI:
    """Explicit uvicorn --factory entrypoint; only this factory reads local config."""
    return create_app(load_config())


# Safe default for process health and offline consumers; no implicit local reads.
app = create_app(AppConfig())
