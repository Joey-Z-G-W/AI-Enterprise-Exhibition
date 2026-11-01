"""Offline-verifiable answer contract; no production model is configured here."""

from __future__ import annotations

import asyncio
import math
from collections.abc import Awaitable, Callable
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from exhibition_guide.knowledge import (
    KnowledgeClient, KnowledgeEmpty, KnowledgeError, KnowledgeResults,
    KnownSource, UnknownSource,
)


class _StrictModel(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid", revalidate_instances="always")


class QuestionRequest(_StrictModel):
    visitor_id: str = Field(min_length=1, max_length=128)
    turn_id: str = Field(min_length=1, max_length=128)
    question: str = Field(min_length=1, max_length=2000)

    @field_validator("visitor_id", "turn_id", "question")
    @classmethod
    def nonblank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("must not be blank")
        return value


class EvidenceQuote(_StrictModel):
    snippet_index: int = Field(ge=0)
    excerpt: str = Field(min_length=1)


class EvidenceDecision(_StrictModel):
    verdict: Literal["sufficient", "ambiguous", "insufficient", "conflicting"]
    quotes: list[EvidenceQuote] = Field(default_factory=list)


# A future SDK adapter implements this callable. Only tests supply a fake today.
EvidenceEvaluator = Callable[[str, tuple[str, ...]], Awaitable[object]]


class AnswerSource(BaseModel):
    snippet_index: int
    excerpt: str
    source: KnownSource | UnknownSource = Field(discriminator="status")


class QuestionResponse(BaseModel):
    visitor_id: str
    turn_id: str
    status: Literal["answer", "clarify", "handoff", "error"]
    text: str
    sources: list[AnswerSource] = Field(default_factory=list)
    error_code: str | None = None


def error_response(request: QuestionRequest, code: str) -> QuestionResponse:
    return QuestionResponse(
        visitor_id=request.visitor_id, turn_id=request.turn_id, status="error",
        text="问答服务暂不可用，请联系现场销售。", error_code=code,
    )


class AnswerService:
    def __init__(
        self, knowledge: KnowledgeClient, evaluator: EvidenceEvaluator, *,
        kb_id: str, timeout: float = 10.0,
    ) -> None:
        if not kb_id.strip():
            raise ValueError("kb_id is required")
        if not math.isfinite(timeout) or timeout <= 0:
            raise ValueError("timeout must be finite and positive")
        self.knowledge = knowledge
        self.evaluator = evaluator
        self.kb_id = kb_id
        self.timeout = timeout

    async def answer(self, request: QuestionRequest) -> QuestionResponse:
        try:
            async with asyncio.timeout(self.timeout):
                retrieval = await self.knowledge.query(self.kb_id, request.question.strip())
        except TimeoutError:
            return error_response(request, "retrieval_timeout")
        except Exception:
            return error_response(request, "retrieval_failed")
        if isinstance(retrieval, KnowledgeError):
            return error_response(request, f"retrieval_{retrieval.code}")
        identity = {"visitor_id": request.visitor_id, "turn_id": request.turn_id}
        handoff = QuestionResponse(
            **identity, status="handoff", text="现有资料不足以可靠回答，请由现场销售为您确认。",
        )
        if isinstance(retrieval, KnowledgeEmpty):
            return handoff
        if not isinstance(retrieval, KnowledgeResults):
            return error_response(request, "retrieval_invalid_response")
        snippets = tuple(item.model_copy(deep=True) for item in retrieval.snippets)
        try:
            async with asyncio.timeout(self.timeout):
                raw_decision = await self.evaluator(
                    request.question.strip(), tuple(item.text for item in snippets),
                )
        except TimeoutError:
            return error_response(request, "model_timeout")
        except Exception:
            return error_response(request, "model_failed")
        try:
            decision = EvidenceDecision.model_validate(raw_decision)
        except ValidationError:
            return error_response(request, "invalid_model_response")
        if decision.verdict == "ambiguous":
            return QuestionResponse(
                **identity, status="clarify", text="请明确您想了解的产品或具体指标。",
            )
        if decision.verdict in {"insufficient", "conflicting"}:
            return handoff
        if not decision.quotes:
            return error_response(request, "invalid_model_response")
        sources = []
        for quote in decision.quotes:
            if (
                quote.snippet_index >= len(snippets)
                or not quote.excerpt.strip()
                or quote.excerpt not in snippets[quote.snippet_index].text
            ):
                return error_response(request, "invalid_model_response")
            sources.append(AnswerSource(
                snippet_index=quote.snippet_index, excerpt=quote.excerpt,
                source=snippets[quote.snippet_index].source,
            ))
        return QuestionResponse(
            **identity, status="answer",
            text="资料记载：\n" + "\n".join(source.excerpt for source in sources),
            sources=sources,
        )
