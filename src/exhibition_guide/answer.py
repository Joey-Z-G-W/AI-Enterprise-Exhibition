"""Answer decisions with server-validated quotes and caller-owned identity."""

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
from exhibition_guide.llm import ModelError


class _StrictModel(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid", revalidate_instances="always")


class QuestionRequest(_StrictModel):
    visitor_id: str = Field(min_length=1, max_length=128)
    turn_id: str = Field(min_length=1, max_length=128)
    turn_seq: int = Field(ge=1, le=9007199254740991)
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
    answer_text: str = Field(max_length=1000)
    quotes: list[EvidenceQuote] = Field(max_length=20)


# Production uses ModelEvidenceEvaluator; tests may inject an explicit substitute.
EvidenceEvaluator = Callable[[str, tuple[str, ...]], Awaitable[object]]


class AnswerSource(BaseModel):
    snippet_index: int
    excerpt: str
    source: KnownSource | UnknownSource = Field(discriminator="status")


class QuestionResponse(BaseModel):
    visitor_id: str
    turn_id: str
    turn_seq: int
    status: Literal["answer", "clarify", "handoff", "error"]
    text: str
    sources: list[AnswerSource] = Field(default_factory=list)
    error_code: str | None = None


def error_response(request: QuestionRequest, code: str) -> QuestionResponse:
    return QuestionResponse(
        visitor_id=request.visitor_id, turn_id=request.turn_id, turn_seq=request.turn_seq, status="error",
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

    async def answer(self, request: QuestionRequest, *, deadline: float | None = None) -> QuestionResponse:
        own_deadline = asyncio.get_running_loop().time() + self.timeout
        deadline = min(deadline, own_deadline) if deadline is not None else own_deadline
        try:
            async with asyncio.timeout_at(deadline) as retrieval_timer:
                retrieval = await self.knowledge.query(self.kb_id, request.question.strip())
        except TimeoutError:
            return error_response(request, "retrieval_timeout")
        except Exception:
            return error_response(request, "retrieval_failed")
        if asyncio.current_task().cancelling():
            raise asyncio.CancelledError
        if retrieval_timer.expired() or asyncio.get_running_loop().time() >= deadline:
            return error_response(request, "retrieval_timeout")
        if isinstance(retrieval, KnowledgeError):
            return error_response(request, f"retrieval_{retrieval.code}")
        identity = {"visitor_id": request.visitor_id, "turn_id": request.turn_id, "turn_seq": request.turn_seq}
        handoff = QuestionResponse(
            **identity, status="handoff", text="现有资料不足以可靠回答，请由现场销售为您确认。",
        )
        if isinstance(retrieval, KnowledgeEmpty):
            return handoff
        if not isinstance(retrieval, KnowledgeResults):
            return error_response(request, "retrieval_invalid_response")
        snippets = tuple(item.model_copy(deep=True) for item in retrieval.snippets)
        try:
            async with asyncio.timeout_at(deadline) as model_timer:
                raw_decision = await self.evaluator(
                    request.question.strip(), tuple(item.text for item in snippets),
                )
        except TimeoutError:
            return error_response(request, "model_timeout")
        except ModelError as error:
            safe_codes = {
                "timeout", "connection_failed", "authentication_failed", "insufficient_balance",
                "rate_limited", "model_unavailable", "service_unavailable", "request_rejected",
                "invalid_response", "empty_response", "incomplete_response", "not_configured",
                "transport_configuration_error", "invalid_request",
            }
            return error_response(request, f"model_{error.code}" if error.code in safe_codes else "model_failed")
        except Exception:
            return error_response(request, "model_failed")
        if asyncio.current_task().cancelling():
            raise asyncio.CancelledError
        if model_timer.expired() or asyncio.get_running_loop().time() >= deadline:
            return error_response(request, "model_timeout")
        try:
            decision = (
                EvidenceDecision.model_validate_json(raw_decision)
                if isinstance(raw_decision, str) else EvidenceDecision.model_validate(raw_decision)
            )
        except ValidationError:
            return error_response(request, "invalid_model_response")
        if decision.verdict in {"sufficient", "ambiguous"} and not decision.answer_text.strip():
            return error_response(request, "invalid_model_response")
        if decision.verdict == "sufficient" and not decision.quotes:
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
        if decision.verdict == "ambiguous":
            return QuestionResponse(**identity, status="clarify", text=decision.answer_text, sources=sources)
        if decision.verdict == "conflicting":
            return QuestionResponse(
                **identity, status="handoff", text="现有资料存在冲突，请由现场销售核实后为您确认。", sources=sources,
            )
        if decision.verdict == "insufficient":
            return handoff
        return QuestionResponse(
            **identity, status="answer",
            text=decision.answer_text,
            sources=sources,
        )
