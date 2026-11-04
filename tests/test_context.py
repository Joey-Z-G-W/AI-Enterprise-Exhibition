import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
import httpx
from fastapi.testclient import TestClient

from exhibition_guide.answer import AnswerService, AnswerSource, QuestionRequest, QuestionResponse
from exhibition_guide.context import ContextStore, Invalidation
from exhibition_guide.evidence_model import ModelEvidenceEvaluator, ModelQuestionRewriter
from exhibition_guide.knowledge import KnowledgeResults, KnowledgeSnippet, KnownSource
from exhibition_guide.main import create_app
from exhibition_guide.config import ModelConfig
from exhibition_guide.llm import ModelClient


def request(seq=1, visitor="v", question="项目介绍", turn=None):
    return QuestionRequest(visitor_id=visitor, turn_id=turn or f"turn-{seq}", turn_seq=seq, question=question)


def answer(req, text="有依据的回答", status="answer"):
    return QuestionResponse(visitor_id=req.visitor_id, turn_id=req.turn_id, turn_seq=req.turn_seq,
        status=status, text=text, sources=[AnswerSource(snippet_index=0, excerpt="原文",
        source=KnownSource(doc_id="doc", filename="fixture.md"))])


def service(callback=None, timeout=1):
    async def immediate(req, **kwargs):
        return answer(req)
    return SimpleNamespace(timeout=timeout, answer=AsyncMock(side_effect=callback or immediate))


async def rewrite(question, history):
    return {"verdict": "resolved", "question": question}


def test_history_is_only_for_rewrite_and_each_answer_uses_fresh_evidence():
    async def run():
        model = SimpleNamespace(complete=AsyncMock(side_effect=[
            '{"verdict":"sufficient","answer_text":"项目介绍","quotes":[{"snippet_index":0,"excerpt":"原文"}]}',
            '{"verdict":"resolved","question":"该项目的材料是什么"}',
            '{"verdict":"sufficient","answer_text":"材料说明","quotes":[{"snippet_index":0,"excerpt":"原文"}]}',
            '{"verdict":"resolved","question":"公司成立时间"}',
            '{"verdict":"sufficient","answer_text":"新话题说明","quotes":[{"snippet_index":0,"excerpt":"原文"}]}',
        ]))
        knowledge = SimpleNamespace(query=AsyncMock(return_value=KnowledgeResults(snippets=[
            KnowledgeSnippet(text="原文", score=1, source=KnownSource(doc_id="doc", filename="fixture.md"))])))
        store = ContextStore()
        svc = AnswerService(knowledge, ModelEvidenceEvaluator(model), kb_id="kb")
        rewriter = ModelQuestionRewriter(model)
        for seq, text in enumerate(["项目介绍", "它的材料呢", "公司成立时间"], 1):
            assert (await store.answer(request(seq, question=text), svc, rewriter)).status == "answer"
        calls = [json.loads(call.args[0]) for call in model.complete.await_args_list]
        assert len(calls) == 5
        assert calls[1]["history"] == [{"question": "项目介绍", "answer": "项目介绍"}]
        assert all("history" not in calls[i] for i in [0, 2, 4])
        assert [c.args[1] for c in knowledge.query.await_args_list] == ["项目介绍", "该项目的材料是什么", "公司成立时间"]
        other = service()
        no_rewrite = AsyncMock(side_effect=AssertionError("cross visitor history"))
        assert (await store.answer(request(visitor="other"), other, no_rewrite)).status == "answer"
        no_rewrite.assert_not_awaited()
    asyncio.run(run())


def test_same_seq_inflight_and_completed_deduplicate_but_different_body_conflicts():
    async def run():
        entered, release = asyncio.Event(), asyncio.Event()
        async def delayed(req, **kwargs):
            entered.set()
            await release.wait()
            return answer(req)
        store, svc = ContextStore(), service(delayed)
        first = asyncio.create_task(store.answer(request(), svc, rewrite))
        await entered.wait()
        duplicate = asyncio.create_task(store.answer(request(), svc, rewrite))
        await asyncio.sleep(0)
        duplicate.cancel()
        with pytest.raises(asyncio.CancelledError):
            await duplicate
        assert not first.done()
        conflict = await store.answer(request(turn="different"), svc, rewrite)
        assert conflict.error_code == "turn_conflict"
        release.set()
        original = await first
        repeated = await store.answer(request(), svc, rewrite)
        assert repeated == original and repeated is not original
        svc.answer.assert_awaited_once()
        assert len(store.entries["v"].pairs) == 1
    asyncio.run(run())




@pytest.mark.parametrize("operation", ["invalidate", "newer", "retire", "expire"])
def test_late_owner_even_swallowing_cancel_cannot_commit_or_revive_entry(operation):
    async def run():
        clock = [0.0]
        store = ContextStore(clock=lambda: clock[0])
        entered, release, cancelled = asyncio.Event(), asyncio.Event(), asyncio.Event()
        async def stubborn(req, **kwargs):
            entered.set()
            try:
                await release.wait()
            except asyncio.CancelledError:
                cancelled.set()
                await release.wait()
            return answer(req, "迟到旧答案")
        old = asyncio.create_task(store.answer(request(turn="zz-old"), service(stubborn), rewrite))
        await entered.wait()
        old_entry = store.entries["v"]
        if operation == "expire":
            clock[0] = 601
            assert (await store.answer(request(turn="aa-new"), service(), rewrite)).status == "answer"
            assert store.entries["v"] is not old_entry
        elif operation == "newer":
            assert (await store.answer(request(2, turn="aa-new"), service(), rewrite)).status == "answer"
        else:
            store.invalidate("v", Invalidation(through_turn_seq=1, retire=operation == "retire"))
        await cancelled.wait()
        release.set()
        assert (await old).error_code == "turn_cancelled"
        assert all(a != "迟到旧答案" for _, a in store.entries["v"].pairs)
        if operation in {"invalidate", "retire"}:
            assert not store.entries["v"].pairs
            late = await store.answer(request(2 if operation == "retire" else 1), service(), rewrite)
            assert late.error_code == ("visitor_retired" if operation == "retire" else "turn_stale")
        assert (await store.answer(request(visitor="new-group"), service(), rewrite)).status == "answer"
    asyncio.run(run())


def test_watermark_order_ttl_and_capacity_include_retired_without_eviction():
    async def run():
        clock = [0.0]
        store = ContextStore(clock=lambda: clock[0])
        store.invalidate("v", Invalidation(through_turn_seq=10))
        expires = store.entries["v"].expires
        clock[0] = 100
        assert store.invalidate("v", Invalidation(through_turn_seq=2))["cancelled_through"] == 10
        assert store.entries["v"].expires == expires
        assert (await store.answer(request(9), service(), rewrite)).error_code == "turn_stale"
        assert store.entries["v"].expires == expires
        for i in range(63):
            store.invalidate(f"retired-{i}", Invalidation(through_turn_seq=0, retire=True))
        assert len(store.entries) == 64
        assert (await store.answer(request(visitor="overflow"), service(), rewrite)).error_code == "visitor_capacity"
        with pytest.raises(ValueError, match="visitor_capacity"):
            store.invalidate("overflow", Invalidation(through_turn_seq=1))
        assert "v" in store.entries
        clock[0] = 701
        assert (await store.answer(request(visitor="after-expiry"), service(), rewrite)).status == "answer"
        assert list(store.entries) == ["after-expiry"]
    asyncio.run(run())


def test_history_pair_and_character_bounds_and_only_success_commits():
    async def run():
        store = ContextStore()
        for seq in range(1, 9):
            await store.answer(request(seq), service(), rewrite)
        assert len(store.entries["v"].pairs) == 6
        async def long_answer(req, **kwargs):
            return answer(req, "a" * 1000)
        for seq in range(9, 16):
            await store.answer(request(seq, question="q" * 2000), service(long_answer), rewrite)
        assert len(store.entries["v"].pairs) == 4
        assert sum(len(q)+len(a) for q,a in store.entries["v"].pairs) == 12000
        before = list(store.entries["v"].pairs)
        for seq, status in enumerate(["clarify", "handoff", "error"], 16):
            async def unsuccessful(req, **kwargs):
                return answer(req, status=status)
            await store.answer(request(seq), service(unsuccessful), rewrite)
        assert store.entries["v"].pairs == before
    asyncio.run(run())


@pytest.mark.parametrize("raw,expected", [
    ("not json", "invalid_rewrite_response"),
    ({"verdict":"resolved", "question":" ", "extra":True}, "invalid_rewrite_response"),
    ({"verdict":"ambiguous", "question":"哪个项目？"}, None),
])
def test_invalid_or_ambiguous_rewrite_never_queries_or_commits(raw, expected):
    async def run():
        store, svc = ContextStore(), service()
        await store.answer(request(), svc, rewrite)
        before = list(store.entries["v"].pairs)
        rewriter = AsyncMock(return_value=raw)
        result = await store.answer(request(2), svc, rewriter)
        assert result.error_code == expected
        assert result.status == ("clarify" if expected is None else "error")
        svc.answer.assert_awaited_once()
        rewriter.assert_awaited_once()
        assert store.entries["v"].pairs == before
    asyncio.run(run())


@pytest.mark.parametrize("stage", ["rewrite", "retrieval", "model"])
@pytest.mark.parametrize("swallow_cancel", [False, True])
def test_all_stages_share_deadline_and_reject_cancel_swallowing_result(stage, swallow_cancel):
    async def run():
        store = ContextStore()
        await store.answer(request(), service(), rewrite)
        snippet = KnowledgeResults(snippets=[KnowledgeSnippet(text="原文", score=1,
            source=KnownSource(doc_id="doc", filename="fixture.md"))])
        decision = {"verdict":"sufficient", "answer_text":"不能迟到提交", "quotes":[{"snippet_index":0, "excerpt":"原文"}]}
        calls = []
        async def bounded_stage(name, result):
            calls.append(name)
            if name == stage:
                try:
                    await asyncio.sleep(60)
                except asyncio.CancelledError:
                    if not swallow_cancel:
                        raise
                    return result
            await asyncio.sleep(0.015)
            return result
        async def rewrite_call(q, h):
            return await bounded_stage("rewrite", {"verdict":"resolved", "question":q})
        async def query(*args):
            return await bounded_stage("retrieval", snippet)
        async def evaluate(*args):
            return await bounded_stage("model", decision)
        svc = AnswerService(SimpleNamespace(query=query), evaluate, kb_id="kb", timeout=0.09)
        start = asyncio.get_running_loop().time()
        result = await store.answer(request(2), svc, rewrite_call)
        elapsed = asyncio.get_running_loop().time() - start
        assert result.error_code == stage + "_timeout"
        assert elapsed < 0.16  # Scheduling tolerance, not a new per-stage budget.
        assert calls == ["rewrite", "retrieval", "model"][:["rewrite", "retrieval", "model"].index(stage)+1]
        assert len(store.entries["v"].pairs) == 1
    asyncio.run(run())


def test_http_protocol_strict_seq_retirement_and_cancel_ack():
    app = create_app(service=service(), rewriter=rewrite)
    with TestClient(app) as client:
        body = request().model_dump()
        for seq in [0, -1, True, "1", 1.5, 9007199254740992]:
            assert client.post("/questions", json={**body, "turn_seq":seq}).status_code == 422
        assert client.post("/questions", json={k:v for k,v in body.items() if k != "turn_seq"}).status_code == 422
        assert client.post("/questions", json=body).json()["turn_seq"] == 1
        ack = client.post("/visitors/v/invalidate", json={"through_turn_seq":1}).json()
        assert ack == {"visitor_id":"v", "cancelled_through":1, "retired":False}
        assert client.post("/questions", json=body).status_code == 409
        assert client.post("/visitors/v/invalidate", json={"through_turn_seq":1, "retire":True}).status_code == 200
        late = client.post("/questions", json=request(2).model_dump())
        assert late.status_code == 409 and late.json()["error_code"] == "visitor_retired"
        assert client.post("/questions", json=request(visitor="next").model_dump()).status_code == 200
