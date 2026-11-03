"""Single-worker bounded visitor history and explicit cancellation watermarks."""
from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
import time

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from exhibition_guide.answer import AnswerService, QuestionRequest, QuestionResponse, error_response
from exhibition_guide.evidence_model import RewriteDecision
from exhibition_guide.llm import ModelError

Rewriter = Callable[[str, tuple[tuple[str, str], ...]], Awaitable[object]]


class Invalidation(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")
    through_turn_seq: int = Field(ge=0, le=9007199254740991)
    retire: bool = False


@dataclass
class _Turn:
    request: QuestionRequest
    future: asyncio.Future
    task: asyncio.Task
    valid: bool = True


@dataclass
class _Visitor:
    expires: float
    highest: int = 0
    cancelled: int = 0
    retired: bool = False
    pairs: list[tuple[str, str]] = field(default_factory=list)
    turn: _Turn | None = None


class ContextStore:
    """Mutations are synchronous on the app event loop; no locks span I/O."""
    def __init__(self, *, clock: Callable[[], float] = time.monotonic):
        self.clock = clock
        self.entries: dict[str, _Visitor] = {}

    def _stop(self, entry: _Visitor) -> None:
        turn = entry.turn
        if turn is None or not turn.valid:
            return
        turn.valid = False
        if not turn.future.done():
            turn.future.set_result(error_response(turn.request, "turn_cancelled"))
            if turn.task is not asyncio.current_task():
                turn.task.cancel()

    def _expire(self) -> None:
        for key, entry in list(self.entries.items()):
            if entry.expires <= self.clock():
                self._stop(entry)
                del self.entries[key]

    def _entry(self, visitor: str) -> _Visitor | None:
        self._expire()
        if visitor not in self.entries:
            if len(self.entries) >= 64:
                return None
            self.entries[visitor] = _Visitor(self.clock() + 600)
        return self.entries[visitor]

    def invalidate(self, visitor: str, invalidation: Invalidation) -> dict:
        entry = self._entry(visitor)
        if entry is None:
            raise ValueError("visitor_capacity")
        advanced = invalidation.through_turn_seq > entry.cancelled or (invalidation.retire and not entry.retired)
        entry.cancelled = max(entry.cancelled, invalidation.through_turn_seq)
        entry.highest = max(entry.highest, entry.cancelled)
        entry.retired = entry.retired or invalidation.retire
        if entry.retired:
            entry.pairs.clear()
        if entry.turn and (entry.retired or entry.turn.request.turn_seq <= entry.cancelled):
            self._stop(entry)
        if advanced:
            entry.expires = self.clock() + 600
        return {"visitor_id": visitor, "cancelled_through": entry.cancelled, "retired": entry.retired}

    def clear(self) -> None:
        for entry in self.entries.values():
            self._stop(entry)
        self.entries.clear()

    def _current(self, visitor: str, entry: _Visitor, turn: _Turn) -> bool:
        self._expire()
        return self.entries.get(visitor) is entry and entry.turn is turn and turn.valid and not entry.retired

    async def answer(self, request: QuestionRequest, service: AnswerService, rewriter: Rewriter | None) -> QuestionResponse:
        entry = self._entry(request.visitor_id)
        if entry is None:
            return error_response(request, "visitor_capacity")
        if entry.retired:
            return error_response(request, "visitor_retired")
        if request.turn_seq <= entry.cancelled or request.turn_seq < entry.highest:
            return error_response(request, "turn_stale")
        if request.turn_seq == entry.highest:
            old = entry.turn
            if old is None or old.request != request:
                return error_response(request, "turn_conflict")
            # Cancelling a duplicate HTTP request must not cancel the original.
            try:
                async with asyncio.timeout(service.timeout):
                    return (await asyncio.shield(old.future)).model_copy(deep=True)
            except TimeoutError:
                return error_response(request, "model_timeout")
        self._stop(entry)
        turn = _Turn(request.model_copy(deep=True), asyncio.get_running_loop().create_future(), asyncio.current_task())
        entry.turn = turn
        entry.highest = request.turn_seq
        entry.expires = self.clock() + 600
        history = tuple(entry.pairs)
        deadline = asyncio.get_running_loop().time() + service.timeout
        query = request.question
        stage = "rewrite"
        try:
            result = None
            if history:
                if rewriter is None:
                    result = error_response(request, "rewrite_not_configured")
                else:
                    # Only rewriting owns this timeout. The answer service retains
                    # retrieval/model stage errors under the same absolute deadline.
                    async with asyncio.timeout_at(deadline) as rewrite_timer:
                        raw = await rewriter(query, history)
                    if rewrite_timer.expired() or asyncio.get_running_loop().time() >= deadline:
                        raise TimeoutError
                    rewritten = RewriteDecision.model_validate_json(raw) if isinstance(raw, str) else RewriteDecision.model_validate(raw)
                    if not rewritten.question.strip():
                        raise ValueError("empty rewrite")
                    if rewritten.verdict == "ambiguous":
                        result = QuestionResponse(visitor_id=request.visitor_id, turn_id=request.turn_id,
                            turn_seq=request.turn_seq, status="clarify", text=rewritten.question)
                    else:
                        query = rewritten.question
            if not self._current(request.visitor_id, entry, turn):
                return error_response(request, "turn_cancelled")
            if result is None:
                stage = "model"
                result = await service.answer(request.model_copy(update={"question": query}), deadline=deadline)
        except asyncio.CancelledError:
            if self._current(request.visitor_id, entry, turn):
                entry.cancelled = max(entry.cancelled, request.turn_seq)
                self._stop(entry)
                raise
            result = error_response(request, "turn_cancelled")
        except TimeoutError:
            result = error_response(request, f"{stage}_timeout")
        except (ValidationError, ValueError):
            result = error_response(request, "invalid_rewrite_response")
        except ModelError as error:
            code = error.code if error.code in {"timeout", "connection_failed", "authentication_failed", "rate_limited", "model_unavailable", "service_unavailable", "empty_response", "incomplete_response", "invalid_response"} else "failed"
            result = error_response(request, "rewrite_" + code)
        except Exception:
            result = error_response(request, "rewrite_failed")
        if not self._current(request.visitor_id, entry, turn):
            return error_response(request, "turn_cancelled")
        if asyncio.current_task().cancelling():
            entry.cancelled = max(entry.cancelled, request.turn_seq)
            self._stop(entry)
            raise asyncio.CancelledError
        if asyncio.get_running_loop().time() >= deadline and result.status != "error":
            result = error_response(request, f"{stage}_timeout")
        if result.status == "answer" and result.sources and all(source.source.status == "known" for source in result.sources):
            entry.pairs.append((query, result.text))
            while len(entry.pairs) > 6 or sum(len(q) + len(a) for q, a in entry.pairs) > 12000:
                entry.pairs.pop(0)
            entry.expires = self.clock() + 600
        turn.future.set_result(result.model_copy(deep=True))
        return result
