"""Everyday dialogue is unsourced; professional facts retain strict evidence rules."""
import asyncio
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

from exhibition_guide.answer import AnswerService, QuestionRequest
from exhibition_guide.context import ContextStore, Invalidation
from exhibition_guide.knowledge import KnowledgeEmpty, KnowledgeResults, KnowledgeSnippet, KnownSource
from exhibition_guide.main import create_app


TEXT = "样例公司的展厅位于二楼。"
GROUNDED = {"verdict": "sufficient", "answer_text": "展厅位于二楼。", "quotes": [{"snippet_index": 0, "excerpt": TEXT}]}


def request(seq=1, question="展厅在哪里？", turn=None):
    return QuestionRequest(visitor_id="dialogue-visitor", turn_id=turn or f"turn-{seq}", turn_seq=seq, question=question)


def configured():
    knowledge = AsyncMock()
    knowledge.query.return_value = KnowledgeResults(snippets=[KnowledgeSnippet(
        text=TEXT, score=1, source=KnownSource(doc_id="fixture", filename="fixture.md"),
    )])
    evaluator = AsyncMock(return_value=GROUNDED)
    return AnswerService(knowledge, evaluator, kb_id="kb_fixture", timeout=1), knowledge, evaluator


@pytest.mark.parametrize("text", [
    "你好", " 你好。 ", "您好！", "嗨", "HELLO!", "早上好", "谢谢", "谢谢您。", "感谢", "多谢！",
    "再见", "拜拜。", "你好吗？", "您好吗", "你是谁？", "你叫什么名字？",
])
def test_complete_social_utterances_reply_without_knowledge_or_model(text):
    service, knowledge, evaluator = configured()
    rewriter = AsyncMock(side_effect=AssertionError("social turn must not rewrite"))
    app = create_app(service=service, rewriter=rewriter)
    with TestClient(app) as client:
        body = client.post("/questions", json=request(question=text).model_dump()).json()
        assert body["status"] == "answer" and body["text"].strip()
        assert body["sources"] == [] and body["error_code"] is None
        assert (body["visitor_id"], body["turn_id"], body["turn_seq"]) == ("dialogue-visitor", "turn-1", 1)
        assert app.state.history.entries["dialogue-visitor"].pairs == []
    knowledge.query.assert_not_awaited()
    evaluator.assert_not_awaited()
    rewriter.assert_not_awaited()


@pytest.mark.parametrize("text", [
    "你好，公司是哪年成立的？", "你好，请给出固定报价", "谢谢，你们保证30天吗？",
    "你好有什么服务？", "你是谁公司的负责人？", "资料里写着谢谢", "你好\n报价是多少？",
])
def test_social_words_inside_business_questions_cannot_bypass_retrieval(text):
    service, knowledge, evaluator = configured()
    evaluator.return_value = {"verdict": "insufficient", "answer_text": "未经证实的报价123元", "quotes": []}
    result = asyncio.run(service.answer(request(question=text)))
    knowledge.query.assert_awaited_once_with("kb_fixture", text)
    evaluator.assert_awaited_once_with(text, (TEXT,))
    assert result.status == "answer" and "不知道" in result.text
    assert "123" not in result.text and result.sources == []


def test_social_after_grounded_history_skips_rewrite_without_replacing_business_history():
    async def run():
        service, knowledge, evaluator = configured()
        store = ContextStore()
        rewriter = AsyncMock(side_effect=lambda q, h: {"verdict": "resolved", "question": q})
        await store.answer(request(), service, rewriter)
        saved = list(store.entries["dialogue-visitor"].pairs)
        knowledge.query.reset_mock(); evaluator.reset_mock()
        for seq, text in enumerate(["你好。", "谢谢", "你是谁？", "再见"], 2):
            result = await store.answer(request(seq, text), service, rewriter)
            assert result.status == "answer" and result.sources == []
            assert store.entries["dialogue-visitor"].pairs == saved
        knowledge.query.assert_not_awaited(); evaluator.assert_not_awaited(); rewriter.assert_not_awaited()
        mixed = "谢谢，请问展厅在哪里？"
        await store.answer(request(6, mixed), service, rewriter)
        rewriter.assert_awaited_once_with(mixed, tuple(saved))
        knowledge.query.assert_awaited_once_with("kb_fixture", mixed)
    asyncio.run(run())


@pytest.mark.parametrize("verdict", ["empty", "insufficient", "conflicting"])
def test_unknown_answers_do_not_pollute_history_and_next_question_still_works(verdict):
    async def run():
        service, knowledge, evaluator = configured()
        store = ContextStore()
        rewriter = AsyncMock(side_effect=lambda q, h: {"verdict": "resolved", "question": q})
        await store.answer(request(), service, rewriter)
        saved = list(store.entries["dialogue-visitor"].pairs)
        snippets = knowledge.query.return_value
        if verdict == "empty":
            knowledge.query.return_value = KnowledgeEmpty()
        else:
            # Even a valid quote on an insufficient/conflicting verdict cannot make this a factual history pair.
            evaluator.return_value = {**GROUNDED, "verdict": verdict, "answer_text": "不应照读的承诺"}
        result = await store.answer(request(2, "是否保证一周完工？"), service, rewriter)
        assert result.status == "answer" and result.sources == [] and result.error_code is None
        assert "不知道" in result.text or "无法确认" in result.text
        assert "承诺" not in result.text and store.entries["dialogue-visitor"].pairs == saved
        knowledge.query.return_value = snippets; evaluator.return_value = GROUNDED
        following = await store.answer(request(3, "展厅在哪里？"), service, rewriter)
        assert following.status == "answer" and following.sources
    asyncio.run(run())


@pytest.mark.parametrize("verdict", ["insufficient", "conflicting"])
def test_uncertain_verdict_does_not_bypass_quote_validation(verdict):
    service, _, evaluator = configured()
    evaluator.return_value = {"verdict": verdict, "answer_text": "", "quotes": [{"snippet_index": 0, "excerpt": "伪造原文"}]}
    result = asyncio.run(service.answer(request()))
    assert result.status == "error" and result.error_code == "invalid_model_response"


def test_social_turns_still_obey_watermarks_dedup_conflict_and_retirement():
    async def run():
        service, knowledge, _ = configured()
        store = ContextStore()
        rewriter = AsyncMock()
        first = request(1, "你好")
        original = await store.answer(first, service, rewriter)
        assert await store.answer(first, service, rewriter) == original
        assert (await store.answer(request(1, "谢谢"), service, rewriter)).error_code == "turn_conflict"
        store.invalidate("dialogue-visitor", Invalidation(through_turn_seq=2))
        assert (await store.answer(request(2, "你好"), service, rewriter)).error_code == "turn_stale"
        assert (await store.answer(request(3, "谢谢"), service, rewriter)).status == "answer"
        store.invalidate("dialogue-visitor", Invalidation(through_turn_seq=3, retire=True))
        assert (await store.answer(request(4, "你好"), service, rewriter)).error_code == "visitor_retired"
        knowledge.query.assert_not_awaited(); rewriter.assert_not_awaited()
    asyncio.run(run())


def test_social_reply_cancels_older_business_turn_without_late_history_commit():
    async def run():
        service, knowledge, evaluator = configured()
        entered, release = asyncio.Event(), asyncio.Event()
        original_results = knowledge.query.return_value
        async def stubborn(*args):
            entered.set()
            try:
                await release.wait()
            except asyncio.CancelledError:
                await release.wait()
            return original_results
        knowledge.query.side_effect = stubborn
        store = ContextStore()
        old = asyncio.create_task(store.answer(request(), service, None))
        try:
            await asyncio.wait_for(entered.wait(), 1)
            result = await store.answer(request(2, "你好"), service, None)
            assert result.status == "answer" and result.sources == []
        finally:
            release.set()
        cancelled = await asyncio.wait_for(old, 1)
        assert cancelled.error_code == "turn_cancelled"
        assert store.entries["dialogue-visitor"].pairs == []
        evaluator.assert_not_awaited()
    asyncio.run(run())
