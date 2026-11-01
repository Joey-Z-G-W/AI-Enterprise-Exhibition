"""Explicit offline and configured production application factories."""

from contextlib import AsyncExitStack, asynccontextmanager
from typing import Annotated

import httpx
from fastapi import Depends, FastAPI, Request, Response

from exhibition_guide.answer import AnswerService, QuestionRequest, QuestionResponse, error_response
from exhibition_guide.config import AppConfig, load_config
from exhibition_guide.evidence_model import ModelEvidenceEvaluator
from exhibition_guide.knowledge import KnowledgeClient
from exhibition_guide.llm import ModelClient


def get_answer_service(request: Request) -> AnswerService | None:
    return request.app.state.answer_service


def create_app(config: AppConfig | None = None, *, service: AnswerService | None = None) -> FastAPI:
    """No filesystem configuration access; callers explicitly supply enabled config."""
    config = config if config is not None else AppConfig()

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
                    KnowledgeClient(http), ModelEvidenceEvaluator(model),
                    kb_id=config.knowledge.kb_id, timeout=config.llm.timeout_seconds,
                )
            try:
                yield
            finally:
                application.state.answer_service = None

    application = FastAPI(title="Exhibition Guide", lifespan=lifespan)
    application.state.answer_service = service

    @application.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @application.post("/questions", response_model=QuestionResponse)
    async def questions(
        request: QuestionRequest, response: Response,
        answer_service: Annotated[AnswerService | None, Depends(get_answer_service)],
    ) -> QuestionResponse:
        result = (
            error_response(request, "service_not_configured")
            if answer_service is None else await answer_service.answer(request)
        )
        if result.status == "error":
            response.status_code = (
                503 if result.error_code == "service_not_configured"
                else 504 if result.error_code and result.error_code.endswith("_timeout") else 502
            )
        return result

    return application


def create_production_app() -> FastAPI:
    """Explicit uvicorn --factory entrypoint; only this factory reads local config."""
    return create_app(load_config())


# Safe default for process health and offline consumers; no implicit local reads.
app = create_app(AppConfig())
