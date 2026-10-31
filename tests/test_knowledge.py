import asyncio
import json

import httpx
import pytest

from exhibition_guide.knowledge import KnowledgeClient


KB = "kb_demo"
PREFIX = f"/agent/knowledge-bases/{KB}"
CHUNK = {"doc_id": "doc_1", "text": "电池容量为 50 kWh。", "score": 1.0}
# The fixed upstream's full document-list response shape, including unused fields.
DOCUMENT = {
    "id": "doc_1", "kb_id": KB, "filename": "产品说明.pdf",
    "mime_type": "application/pdf", "bytes": 100, "sha256": "abc",
    "status": "ready", "error": None, "chunk_count": 1,
    "created_at": "2026-10-31T00:00:00Z", "updated_at": "2026-10-31T00:00:00Z",
    "index_phase": "", "retry_count": 0, "index_error": None, "generation": 0,
}


def query_payload(**changes):
    return {"available": True, "indexed": True, "reason": "", "results": [CHUNK], **changes}


def execute(query_response, documents_response=None, *, failing_endpoint=None, failure=None):
    requests = []

    def handle(request):
        requests.append(request)
        if request.url.path.endswith(failing_endpoint or "no-failure"):
            raise failure("simulated failure", request=request)
        if request.url.path == f"{PREFIX}/lightrag/query":
            return query_response
        assert request.url.path == f"{PREFIX}/documents"
        assert documents_response is not None, "unexpected document lookup"
        return documents_response

    async def run():
        async with httpx.AsyncClient(
            base_url="http://opentalking.invalid", transport=httpx.MockTransport(handle),
        ) as client:
            return await KnowledgeClient(client, timeout=2.5).query(KB, " 电池容量？ ", limit=4)

    return asyncio.run(run()), requests


def test_results_use_verified_filename_and_exact_upstream_protocol():
    result, requests = execute(
        httpx.Response(200, json=query_payload()),
        httpx.Response(200, json={"documents": [DOCUMENT]}),
    )
    assert result.status == "results"
    assert result.snippets[0].model_dump() == {
        "text": CHUNK["text"], "score": 1.0,
        "source": {"status": "known", "doc_id": "doc_1", "filename": "产品说明.pdf"},
    }
    assert [r.method for r in requests] == ["POST", "GET"]
    assert json.loads(requests[0].content) == {"query": "电池容量？", "limit": 4}
    assert all(set(r.extensions["timeout"].values()) == {2.5} for r in requests)


@pytest.mark.parametrize("doc_id,documents", [
    ("", [DOCUMENT]),  # Actual LightRAGKnowledgeIndex returns combined context with empty doc_id.
    ("doc_missing", [DOCUMENT]),
    ("doc_1", []),
    ("doc_1", [{**DOCUMENT, "kb_id": "another_kb"}]),
    ("doc_1", [{**DOCUMENT, "filename": " "}]),
    ("doc_1", [DOCUMENT, {**DOCUMENT, "filename": "另一个文件.pdf"}]),
])
def test_unverifiable_source_stays_unknown_without_parsing_context(doc_id, documents):
    chunk = {**CHUNK, "doc_id": doc_id, "text": "来源：产品说明.pdf\n电池容量为 50 kWh。"}
    result, _ = execute(
        httpx.Response(200, json=query_payload(results=[chunk])),
        httpx.Response(200, json={"documents": documents}),
    )
    assert result.status == "results"
    assert result.snippets[0].source.model_dump() == {
        "status": "unknown", "doc_id": doc_id, "filename": None,
    }


def test_empty_requires_successful_ready_index_and_zero_results():
    result, requests = execute(httpx.Response(200, json=query_payload(results=[])))
    assert result.model_dump() == {"status": "empty"}
    assert len(requests) == 1


@pytest.mark.parametrize("available,indexed,reason,code", [
    (False, False, "lightrag_not_installed", "unavailable"),
    (True, False, "index_not_found", "not_indexed"),
    (True, False, "index_empty", "not_indexed"),
    (True, False, "index_failed", "not_indexed"),
    (True, False, "", "not_indexed"),
    (True, True, "query_failed", "query_failed"),
    (True, True, "unexpected_failure", "upstream_error"),
])
@pytest.mark.parametrize("results", [[], [CHUNK]])
def test_upstream_error_flags_never_become_empty_or_results(available, indexed, reason, code, results):
    result, requests = execute(httpx.Response(200, json=query_payload(
        available=available, indexed=indexed, reason=reason, results=results,
    )))
    assert result.status == "error"
    assert result.code == code
    assert result.upstream_reason == reason
    assert len(requests) == 1


@pytest.mark.parametrize("endpoint", ["query", "documents"])
@pytest.mark.parametrize("status", [302, 400, 404, 500, 503])
def test_http_errors_on_either_endpoint_are_errors(endpoint, status):
    bad = httpx.Response(status, text="upstream error")
    result, _ = execute(
        bad if endpoint == "query" else httpx.Response(200, json=query_payload()),
        bad if endpoint == "documents" else None,
    )
    assert (result.status, result.code, result.endpoint, result.http_status) == (
        "error", "http_error", endpoint, status,
    )


@pytest.mark.parametrize("endpoint", ["query", "documents"])
@pytest.mark.parametrize("failure,code", [
    (httpx.ReadTimeout, "timeout"), (httpx.ConnectTimeout, "timeout"),
    (httpx.ConnectError, "transport_error"), (httpx.ReadError, "transport_error"),
])
def test_transport_failures_on_either_endpoint_are_errors(endpoint, failure, code):
    result, requests = execute(
        httpx.Response(200, json=query_payload()), failing_endpoint=endpoint, failure=failure,
    )
    assert (result.status, result.code, result.endpoint) == ("error", code, endpoint)
    assert len(requests) == (1 if endpoint == "query" else 2)  # No implicit retries.


@pytest.mark.parametrize("payload", [
    {}, [], None, query_payload(available="true"), query_payload(indexed=1),
    query_payload(reason=None), query_payload(results=None),
    query_payload(results=[{"doc_id": "doc_1", "text": "text"}]),
    query_payload(results=[{**CHUNK, "text": " "}]),
    query_payload(results=[{**CHUNK, "doc_id": None}]),
    query_payload(results=[{**CHUNK, "score": "1.0"}]),
])
def test_invalid_query_response_is_error(payload):
    result, _ = execute(httpx.Response(200, json=payload))
    assert (result.status, result.code, result.endpoint) == ("error", "invalid_response", "query")


@pytest.mark.parametrize("endpoint", ["query", "documents"])
def test_non_json_success_response_is_error(endpoint):
    bad = httpx.Response(200, text="<html>not JSON</html>")
    result, _ = execute(
        bad if endpoint == "query" else httpx.Response(200, json=query_payload()),
        bad if endpoint == "documents" else None,
    )
    assert (result.status, result.code, result.endpoint) == ("error", "invalid_response", endpoint)


@pytest.mark.parametrize("payload", [{}, {"documents": None}, {"documents": [{}]}, {"documents": [{**DOCUMENT, "filename": 2}]}])
def test_invalid_documents_response_is_error(payload):
    result, _ = execute(
        httpx.Response(200, json=query_payload()), httpx.Response(200, json=payload),
    )
    assert (result.status, result.code, result.endpoint) == ("error", "invalid_response", "documents")


def test_nonfinite_score_is_invalid_response():
    result, _ = execute(httpx.Response(200, content=(
        '{"available":true,"indexed":true,"reason":"","results":'
        '[{"doc_id":"doc_1","text":"text","score":NaN}]}'
    )))
    assert (result.status, result.code) == ("error", "invalid_response")
