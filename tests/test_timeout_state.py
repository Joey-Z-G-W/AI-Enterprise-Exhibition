"""An expired native timer remains authoritative before the shared clock deadline."""

import asyncio
from types import SimpleNamespace

import pytest

from exhibition_guide.answer import AnswerService, QuestionRequest
from exhibition_guide.context import ContextStore
from exhibition_guide.knowledge import KnowledgeResults, KnowledgeSnippet, KnownSource


@pytest.mark.parametrize("stage", ["rewrite", "retrieval", "model"])
def test_expired_native_timeout_rejects_swallowed_result_before_deadline(stage, monkeypatch, record_property):
    async def run():
        store = ContextStore()
        snippet = KnowledgeResults(snippets=[KnowledgeSnippet(
            text="原文", score=1, source=KnownSource(doc_id="doc", filename="fixture.md"),
        )])
        decision = {"verdict": "sufficient", "answer_text": "不能迟到提交",
                    "quotes": [{"snippet_index": 0, "excerpt": "原文"}]}
        calls = []
        selected_stage = None

        async def bounded_stage(name, value):
            calls.append(name)
            if name == selected_stage:
                try:
                    await asyncio.Event().wait()
                except asyncio.CancelledError:
                    return value
            return value

        async def rewrite(question, history):
            return await bounded_stage("rewrite", {"verdict": "resolved", "question": question})

        async def query(*args):
            return await bounded_stage("retrieval", snippet)

        async def evaluate(*args):
            return await bounded_stage("model", decision)

        service = AnswerService(SimpleNamespace(query=query), evaluate, kb_id="kb", timeout=0.09)
        first = QuestionRequest(visitor_id="v", turn_id="turn-1", turn_seq=1, question="项目介绍")
        assert (await store.answer(first, service, rewrite)).status == "answer"
        history_before = list(store.entries["v"].pairs)
        calls.clear()
        selected_stage = stage
        stages = ["rewrite", "retrieval", "model"]
        target_index = stages.index(stage)
        loop = asyncio.get_running_loop()
        frozen_now = loop.time()
        native_timeout_at = asyncio.timeout_at
        timers, deadlines = [], []

        def controlled_timeout_at(deadline):
            # Native Timeout performs cancellation/uncancel itself. An immediate
            # timer models expiration while the business deadline is still ahead.
            when = frozen_now if len(timers) == target_index else deadline
            timer = native_timeout_at(when)
            timers.append(timer)
            deadlines.append(deadline)
            return timer

        # This patch belongs only to this asyncio.run loop and is restored even
        # when an assertion fails; no wall-clock delay or private timer API is used.
        with monkeypatch.context() as patch:
            patch.setattr(loop, "time", lambda: frozen_now)
            patch.setattr(asyncio, "timeout_at", controlled_timeout_at)
            result = await store.answer(first.model_copy(update={"turn_id": "turn-2", "turn_seq": 2}), service, rewrite)
            assert isinstance(timers[-1], asyncio.Timeout)
            assert timers[-1].expired()
            assert loop.time() < deadlines[-1]
            assert deadlines == [frozen_now + service.timeout] * (target_index + 1)
            assert asyncio.current_task().cancelling() == 0
            assert result.status == "error"
            assert result.error_code == stage + "_timeout"
            assert calls == stages[:target_index + 1]
            assert store.entries["v"].pairs == history_before
            record_property("native_timeout_expired", timers[-1].expired())
            record_property("loop_time_before_shared_deadline", loop.time() < deadlines[-1])
            record_property("history_unchanged", store.entries["v"].pairs == history_before)

    asyncio.run(run())
