import asyncio
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi.testclient import TestClient

from exhibition_guide.answer import AnswerService
from exhibition_guide.knowledge import (
    KnowledgeClient, KnowledgeEmpty, KnowledgeError, KnowledgeResults,
    KnowledgeSnippet, KnownSource, UnknownSource,
)
from exhibition_guide.main import app, get_answer_service


REQUEST = {"session_id": "visitors-a", "turn_id": "turn-1", "question": "电池容量是多少？"}
TEXT = "A产品的电池容量为50 kWh。"
DECISION = {"verdict": "sufficient", "quotes": [{"snippet_index": 0, "excerpt": TEXT}]}


def candidates(text=TEXT, source=None):
    return KnowledgeResults(snippets=[KnowledgeSnippet(
        text=text, score=1.0,
        source=source or KnownSource(doc_id="doc_a", filename="产品说明.pdf"),
    )])


@pytest.fixture
def client():
    with TestClient(app) as client:
        yield client
    app.dependency_overrides.clear()


def configure(retrieval=None, decision=None, *, timeout=1.0):
    knowledge = AsyncMock(spec=KnowledgeClient)
    knowledge.query.return_value = retrieval if retrieval is not None else candidates()
    evaluator = AsyncMock(return_value=decision if decision is not None else DECISION)
    service = AnswerService(knowledge, evaluator, kb_id="kb_demo", timeout=timeout)
    app.dependency_overrides[get_answer_service] = lambda: service
    return knowledge, evaluator


def test_default_is_explicitly_unconfigured(client):
    response = client.post("/questions", json=REQUEST)
    assert response.status_code == 503
    assert response.json() == {
        "session_id": "visitors-a", "turn_id": "turn-1", "status": "error",
        "text": "问答服务暂不可用，请联系现场销售。", "sources": [],
        "error_code": "service_not_configured",
    }


@pytest.mark.parametrize("field", ["session_id", "turn_id", "question"])
def test_blank_input_is_rejected(client, field):
    assert client.post("/questions", json={**REQUEST, field: " \n "}).status_code == 422


def test_answer_only_quotes_this_turn_with_server_owned_source(client):
    knowledge, evaluator = configure()
    response = client.post("/questions", json=REQUEST)
    body = response.json()
    assert response.status_code == 200
    assert body["status"] == "answer"
    assert body["text"] == "资料记载：\n" + TEXT
    assert body["session_id"] == REQUEST["session_id"]
    assert body["turn_id"] == REQUEST["turn_id"]
    assert body["sources"] == [{
        "snippet_index": 0, "excerpt": TEXT,
        "source": {"status": "known", "doc_id": "doc_a", "filename": "产品说明.pdf"},
    }]
    knowledge.query.assert_awaited_once_with("kb_demo", REQUEST["question"])
    evaluator.assert_awaited_once_with(REQUEST["question"], (TEXT,))


def test_unknown_source_remains_unknown_and_does_not_block_valid_excerpt(client):
    configure(candidates(source=UnknownSource(doc_id="")))
    body = client.post("/questions", json=REQUEST).json()
    assert body["status"] == "answer"
    assert body["sources"][0]["source"] == {"status": "unknown", "doc_id": "", "filename": None}


def test_empty_retrieval_hands_off_without_model_call(client):
    _, evaluator = configure(KnowledgeEmpty())
    body = client.post("/questions", json=REQUEST).json()
    assert body["status"] == "handoff"
    assert body["sources"] == []
    evaluator.assert_not_awaited()


@pytest.mark.parametrize("verdict,text,status", [
    ("insufficient", "B产品的外壳为蓝色。", "handoff"),
    ("conflicting", "A产品电池容量为50 kWh。另一份资料说A产品电池容量为70 kWh。", "handoff"),
    ("ambiguous", "A产品和B产品均有电池。", "clarify"),
])
def test_score_one_is_not_sufficient_and_semantic_decision_is_injected(client, verdict, text, status):
    # The fake supplies the semantic verdict; this does NOT test actual model quality.
    configure(candidates(text), {"verdict": verdict})
    response = client.post("/questions", json=REQUEST)
    assert response.status_code == 200
    assert response.json()["status"] == status
    assert response.json()["sources"] == []


@pytest.mark.parametrize("code,http_status", [("timeout", 504), ("not_indexed", 502)])
def test_retrieval_error_is_not_handoff(client, code, http_status):
    _, evaluator = configure(KnowledgeError(code=code, endpoint="query"))
    response = client.post("/questions", json=REQUEST)
    assert response.status_code == http_status
    assert response.json()["status"] == "error"
    assert response.json()["error_code"] == f"retrieval_{code}"
    evaluator.assert_not_awaited()


@pytest.mark.parametrize("stage", ["retrieval", "model"])
def test_dependency_exception_is_error_without_exposing_internal_message(client, stage):
    knowledge, evaluator = configure()
    target = knowledge.query if stage == "retrieval" else evaluator
    target.side_effect = RuntimeError("secret internal endpoint")
    response = client.post("/questions", json=REQUEST)
    assert response.status_code == 502
    assert response.json()["error_code"] == f"{stage}_failed"
    assert "secret" not in response.text


@pytest.mark.parametrize("stage", ["retrieval", "model"])
def test_dependency_deadline_is_enforced(client, stage):
    knowledge, evaluator = configure(timeout=0.01)

    async def slow(*args):
        await asyncio.sleep(60)

    target = knowledge.query if stage == "retrieval" else evaluator
    target.side_effect = slow
    response = client.post("/questions", json=REQUEST)
    assert response.status_code == 504
    assert response.json()["error_code"] == f"{stage}_timeout"


@pytest.mark.parametrize("decision", [
    {}, {"verdict": "sufficient"},
    {"verdict": "sufficient", "quotes": [{"snippet_index": 1, "excerpt": TEXT}]},
    {"verdict": "sufficient", "quotes": [{"snippet_index": 0, "excerpt": "续航为1000公里。"}]},
    {"verdict": "sufficient", "quotes": [{"snippet_index": 0, "excerpt": " "}]},
    {"verdict": "sufficient", "quotes": [{"snippet_index": True, "excerpt": TEXT}]},
    {"verdict": "sufficient", "quotes": [{"snippet_index": 0, "excerpt": TEXT, "filename": "伪造.pdf"}]},
])
def test_invalid_model_output_and_forged_citations_are_errors(client, decision):
    configure(decision=decision)
    response = client.post("/questions", json=REQUEST)
    assert response.status_code == 502
    assert response.json()["error_code"] == "invalid_model_response"
    assert response.json()["sources"] == []


def test_old_excerpt_cannot_be_reused_on_next_turn(client):
    knowledge, _ = configure()
    knowledge.query.side_effect = [candidates(), candidates("B产品没有容量资料。")]
    first = client.post("/questions", json=REQUEST)
    second = client.post("/questions", json={**REQUEST, "session_id": "visitors-b", "turn_id": "turn-2"})
    assert first.json()["status"] == "answer"
    assert second.json()["status"] == "error"
    assert second.json()["error_code"] == "invalid_model_response"
    assert second.json()["session_id"] == "visitors-b"
    assert second.json()["turn_id"] == "turn-2"
    assert second.json()["sources"] == []


def test_service_reuses_real_knowledge_client_with_mock_http_transport(client):
    def handle(request):
        if request.method == "POST":
            return httpx.Response(200, json={
                "available": True, "indexed": True, "reason": "",
                "results": [{"doc_id": "", "text": TEXT, "score": 1.0}],
            })
        return httpx.Response(200, json={"documents": []})

    async def override():
        async with httpx.AsyncClient(
            base_url="http://opentalking.invalid", transport=httpx.MockTransport(handle),
        ) as http:
            yield AnswerService(KnowledgeClient(http), AsyncMock(return_value=DECISION), kb_id="kb_demo")

    app.dependency_overrides[get_answer_service] = override
    response = client.post("/questions", json=REQUEST)
    assert response.status_code == 200
    assert response.json()["status"] == "answer"
    assert response.json()["sources"][0]["source"]["status"] == "unknown"
