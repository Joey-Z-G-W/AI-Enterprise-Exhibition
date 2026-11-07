"""Answer decisions with server-validated quotes and caller-owned identity."""

from __future__ import annotations

import asyncio
import math
from collections.abc import Awaitable, Callable
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, PrivateAttr, ValidationError, field_validator, model_validator

from exhibition_guide.knowledge import (
    KnowledgeClient, KnowledgeEmpty, KnowledgeError, KnowledgeResults,
    KnownSource, UnknownSource,
)
from exhibition_guide.llm import ModelError
from exhibition_guide.sentences import split_sentences


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


class EvidenceSentence(_StrictModel):
    narration_id: str | None = Field(default=None, min_length=1, max_length=128)
    text: str | None = Field(default=None, min_length=1, max_length=1000)
    fact_ids: list[str] = Field(default_factory=list, max_length=16)

    @model_validator(mode="after")
    def one_choice(self):
        if self.narration_id is not None and self.fact_ids:
            raise ValueError("legacy narration cannot include visual facts")
        if (self.narration_id is None) == (self.text is None):
            raise ValueError("select one narration or one free sentence")
        if self.text is not None and (not self.text.strip() or len(split_sentences(self.text)) != 1):
            raise ValueError("free text must be one sentence")
        return self


class EvidenceDecision(_StrictModel):
    verdict: Literal["sufficient", "ambiguous", "insufficient", "conflicting"]
    answer_text: str = Field(default="", max_length=1000)
    sentences: list[EvidenceSentence] | None = Field(default=None, min_length=1, max_length=64)
    quotes: list[EvidenceQuote] = Field(max_length=20)


# Production uses ModelEvidenceEvaluator; tests may inject an explicit substitute.
EvidenceEvaluator = Callable[[str, tuple[str, ...]], Awaitable[object]]


_SOCIAL_REPLIES = {
    **dict.fromkeys(
        ("你好", "您好", "你好呀", "你好啊", "嗨", "哈喽", "hello", "hi", "早上好", "下午好", "晚上好", "早安"),
        "您好，欢迎来到展厅！您想先了解什么？",
    ),
    **dict.fromkeys(("谢谢", "谢谢你", "谢谢您", "感谢", "感谢你", "多谢"),
        "不客气！还想了解什么，您可以继续问我。"),
    **dict.fromkeys(("再见", "拜拜", "回头见", "bye", "goodbye"),
        "再见，祝您参观愉快！"),
    **dict.fromkeys(("你好吗", "您好吗", "最近好吗"),
        "我在这里，随时可以帮您介绍展厅资料。您想先了解什么？"),
    **dict.fromkeys(("你是谁", "您是谁", "你叫什么", "你叫什么名字"),
        "我是展厅的AI导览助手，可以帮您了解展厅资料；不确定的信息我会说明。"),
}


def social_reply(question: str) -> str | None:
    """Only complete social utterances; never strip a business clause or match a substring."""
    normalized = question.strip().strip("。！？!?.,，；;").strip().casefold()
    return _SOCIAL_REPLIES.get(normalized)


class AnswerSource(BaseModel):
    snippet_index: int
    excerpt: str
    source: KnownSource | UnknownSource = Field(discriminator="status")


class QuestionResponse(BaseModel):
    # Request-local, source-verified retrieval snapshot; never serialized to clients.
    _verified_snippets: list[AnswerSource] = PrivateAttr(default_factory=list)
    _visual_plan: list[dict] = PrivateAttr(default_factory=list)
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
        narration_resolver: Callable[[str, list[AnswerSource], list[AnswerSource]], str | None] | None = None,
        visual_resolver: Callable | None = None,
    ) -> None:
        if not kb_id.strip():
            raise ValueError("kb_id is required")
        if not math.isfinite(timeout) or timeout <= 0:
            raise ValueError("timeout must be finite and positive")
        self.knowledge = knowledge
        self.evaluator = evaluator
        self.kb_id = kb_id
        self.timeout = timeout
        self.narration_resolver = narration_resolver
        self.visual_resolver = visual_resolver

    async def answer(self, request: QuestionRequest, *, deadline: float | None = None, tour: dict | None = None) -> QuestionResponse:
        own_deadline = asyncio.get_running_loop().time() + self.timeout
        deadline = min(deadline, own_deadline) if deadline is not None else own_deadline
        identity = {"visitor_id": request.visitor_id, "turn_id": request.turn_id, "turn_seq": request.turn_seq}
        social = social_reply(request.question)
        if social is not None:
            if asyncio.current_task().cancelling():
                raise asyncio.CancelledError
            if asyncio.get_running_loop().time() >= deadline:
                return error_response(request, "retrieval_timeout")
            return QuestionResponse(**identity, status="answer", text=social)
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
        unknown = QuestionResponse(
            **identity, status="answer", text="这个问题我还不知道，现有资料不足以可靠回答。您可以继续问我其他问题。",
        )
        if isinstance(retrieval, KnowledgeEmpty):
            return unknown
        if not isinstance(retrieval, KnowledgeResults):
            return error_response(request, "retrieval_invalid_response")
        snippets = tuple(item.model_copy(deep=True) for item in retrieval.snippets)
        try:
            async with asyncio.timeout_at(deadline) as model_timer:
                evaluate_tour = getattr(self.evaluator, "evaluate_tour", None)
                if tour is not None and evaluate_tour is not None:
                    raw_decision = await evaluate_tour(request.question.strip(), tuple(item.text for item in snippets), tour)
                else:
                    raw_decision = await self.evaluator(request.question.strip(), tuple(item.text for item in snippets))
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
        if decision.verdict in {"sufficient", "ambiguous"} and not decision.answer_text.strip() and not decision.sentences:
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
        snapshot = [AnswerSource(snippet_index=index, excerpt=item.text, source=item.source)
                    for index, item in enumerate(snippets)]
        answer_text = decision.answer_text
        visual_plan = []
        if decision.sentences is not None:
            if decision.verdict != "sufficient" or decision.answer_text:
                return error_response(request, "invalid_model_response")
            parts = []
            for sentence in decision.sentences:
                text = sentence.text
                if sentence.narration_id is not None:
                    text = self.narration_resolver(sentence.narration_id, snapshot, sources) if self.narration_resolver else None
                if text is None:
                    return error_response(request, "invalid_model_response")
                parts.append(text)
                if sentence.text is not None:
                    asset = self.visual_resolver(sentence.fact_ids, snapshot, sources, tour) if self.visual_resolver else None
                    visual_plan.append({"text": text, "asset_id": asset, "fact_asset_id": asset, "fact_ids": sentence.fact_ids})
                else:
                    visual_plan.append({"text": text, "asset_id": None})
            answer_text = "".join(parts)
            if len(answer_text) > 1000:
                return error_response(request, "invalid_model_response")
        if decision.verdict == "ambiguous":
            return QuestionResponse(**identity, status="clarify", text=decision.answer_text, sources=sources)
        if decision.verdict == "conflicting":
            return QuestionResponse(
                **identity, status="answer", text="现有资料存在冲突，我目前无法确认正确答案。您可以继续问我其他问题。",
            )
        if decision.verdict == "insufficient":
            return unknown
        reviewer = getattr(self.evaluator, "review_visual", None)
        if reviewer and any(s.get("asset_id") for s in visual_plan):
            try:
                # Optional visual review shares the turn deadline but cannot discard a valid answer.
                async with asyncio.timeout_at(min(deadline - 0.25, asyncio.get_running_loop().time() + 10)):
                    review = await reviewer(visual_plan, tuple(s.text for s in snippets))
                for index, sentence in enumerate(visual_plan):
                    if index not in review["images"] or index not in review["grounded"]:
                        sentence["asset_id"] = None
                    if index not in review["grounded"]:
                        sentence["fact_asset_id"] = None
            except (TimeoutError, ModelError, ValueError, TypeError, KeyError):
                for sentence in visual_plan:
                    sentence["asset_id"] = None
                    sentence["fact_asset_id"] = None
        response = QuestionResponse(
            **identity, status="answer", text=answer_text, sources=sources,
        )
        response._verified_snippets = snapshot
        if decision.sentences and any(s.fact_ids for s in decision.sentences):
            response._visual_plan = visual_plan
        return response
