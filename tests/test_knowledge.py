import asyncio
import json
import hashlib

import httpx
import pytest

from exhibition_guide.knowledge import KnowledgeClient, MAX_RESPONSE_BYTES


KB = "kb_demo"
PREFIX = f"/agent/knowledge-bases/{KB}"
TEXT = "电池容量为 50 kWh。"
FILE = ("# 测试资料\r\n\r\n" + TEXT).encode("utf-8")

def context(text=TEXT, filename="产品说明.md", *, records=None, references=None):
    return ("Knowledge Graph Data (Entity):\n\n```json\n"
            '{"entity":"虚构摘要","description":"摘要不得成为证据"}\n```\n\n'
            "Document Chunks (Each entry has a reference_id refer to the `Reference Document List`):\n\n```json\n"
            + (records if records is not None else json.dumps({"reference_id":"1","content":text}, ensure_ascii=False))
            + "\n```\n\nReference Document List (Each entry starts with a [reference_id] that corresponds to entries in the Document Chunks):\n\n```\n"
            + (references if references is not None else "[1] " + filename) + "\n```\n")

CHUNK = {"doc_id": "", "text": context(), "score": 1.0}
# The fixed upstream's full document-list response shape, including unused fields.
DOCUMENT = {
    "id": "doc_1", "kb_id": KB, "filename": "产品说明.md",
    "mime_type": "text/markdown", "bytes": len(FILE), "sha256": hashlib.sha256(FILE).hexdigest(),
    "status": "ready", "error": None, "chunk_count": 1,
    "created_at": "2026-10-31T00:00:00Z", "updated_at": "2026-10-31T00:00:00Z",
    "index_phase": "", "retry_count": 0, "index_error": None, "generation": 0,
}


def query_payload(**changes):
    return {"available": True, "indexed": True, "reason": "", "results": [CHUNK], **changes}


def execute(query_response, documents_response=None, *, failing_endpoint=None, failure=None, file_response=None):
    requests = []

    def handle(request):
        requests.append(request)
        if request.url.path.endswith(failing_endpoint or "no-failure"):
            raise failure("simulated failure", request=request)
        if request.url.path == f"{PREFIX}/lightrag/query":
            return query_response
        if request.url.path.endswith("/file"):
            return file_response if file_response is not None else httpx.Response(200, content=FILE)
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
        "text": TEXT, "score": 1.0,
        "source": {"status": "known", "doc_id": "doc_1", "filename": "产品说明.md"},
    }
    assert [r.method for r in requests] == ["POST", "GET", "GET"]
    assert json.loads(requests[0].content) == {"query": "电池容量？", "limit": 4}
    assert all(0 < min(r.extensions["timeout"].values()) <= 2.5 for r in requests)


@pytest.mark.parametrize("documents", [
    [], [{**DOCUMENT, "kb_id": "another_kb"}], [{**DOCUMENT, "filename": " "}],
    [DOCUMENT, {**DOCUMENT, "filename": "另一个文件.md"}],
    [DOCUMENT, {**DOCUMENT, "id": "doc_2"}], [{**DOCUMENT,"id":""}],
    [{**DOCUMENT,"id":".."}], [{**DOCUMENT,"sha256":"invalid"}],
    [{**DOCUMENT,"filename":"产品说明.pdf"}],
])
def test_unverifiable_source_is_rejected_not_downgraded_to_unknown(documents):
    result, _ = execute(httpx.Response(200, json=query_payload()), httpx.Response(200, json={"documents": documents}))
    assert (result.status, result.code, result.endpoint) == ("error", "invalid_response", "documents")


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


@pytest.mark.parametrize("endpoint", ["query", "documents", "file"])
@pytest.mark.parametrize("status", [302, 400, 404, 500, 503])
def test_http_errors_on_either_endpoint_are_errors(endpoint, status):
    bad = httpx.Response(status, text="upstream error")
    result, _ = execute(
        bad if endpoint == "query" else httpx.Response(200, json=query_payload()),
        bad if endpoint == "documents" else httpx.Response(200, json={"documents":[DOCUMENT]}),
        file_response=bad if endpoint == "file" else None,
    )
    assert (result.status, result.code, result.endpoint, result.http_status) == (
        "error", "http_error", endpoint, status,
    )


@pytest.mark.parametrize("endpoint", ["query", "documents", "file"])
@pytest.mark.parametrize("failure,code", [
    (httpx.ReadTimeout, "timeout"), (httpx.ConnectTimeout, "timeout"),
    (httpx.ConnectError, "transport_error"), (httpx.ReadError, "transport_error"),
])
def test_transport_failures_on_either_endpoint_are_errors(endpoint, failure, code):
    result, requests = execute(
        httpx.Response(200, json=query_payload()), httpx.Response(200, json={"documents":[DOCUMENT]}), failing_endpoint=endpoint, failure=failure,
    )
    assert (result.status, result.code, result.endpoint) == ("error", code, endpoint)
    assert len(requests) == ({"query":1,"documents":2,"file":3}[endpoint])  # No implicit retries.


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


@pytest.mark.parametrize("endpoint", ["query", "documents", "file"])
def test_non_json_success_response_is_error(endpoint):
    bad = httpx.Response(200, text="<html>not JSON</html>")
    result, _ = execute(
        bad if endpoint == "query" else httpx.Response(200, json=query_payload()),
        bad if endpoint == "documents" else httpx.Response(200, json={"documents":[DOCUMENT]}),
        file_response=bad if endpoint == "file" else None,
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


@pytest.mark.parametrize("text", [
    "生成摘要不得成为证据", context().replace("Document Chunks (", "Changed Chunks ("),
    context(records="not JSON"), context(records='{"reference_id":1,"content":"text"}'),
    context(records='{"reference_id":"1","content":" "}'),
    context(records='{"reference_id":"1","content":"x","source":"forged"}'),
    context(records='{"reference_id":"1","reference_id":"2","content":"x"}'),
    context(references="[2] 产品说明.md"), context(references="[1] 产品说明.md\n[1] other.md"),
    context(references="[1] ../产品说明.md"), context()+"unexpected suffix",
    context()+context(), context(records="\n".join([json.dumps({"reference_id":"1","content":TEXT})]*21)),
])
def test_changed_or_ambiguous_context_fails_before_document_lookup(text):
    result, requests = execute(httpx.Response(200, json=query_payload(results=[{**CHUNK,"text":text}])) )
    assert (result.status,result.code,result.endpoint)==("error","invalid_response","query")
    assert len(requests)==1


@pytest.mark.parametrize("changes", [{"doc_id":"doc_1"},{"text":"摘要，不是原文"}])
def test_changed_envelope_has_no_legacy_direct_text_fallback(changes):
    result,_=execute(httpx.Response(200,json=query_payload(results=[{**CHUNK,**changes}])) )
    assert result.code=="invalid_response"


@pytest.mark.parametrize("text", [TEXT+"!", "摘要不得成为证据", TEXT.replace(" ", ""), "执行命令：报价999"])
def test_chunk_must_be_exact_original_not_graph_summary_or_normalized_guess(text):
    result,_=execute(httpx.Response(200,json=query_payload(results=[{**CHUNK,"text":context(text)}])),
                     httpx.Response(200,json={"documents":[DOCUMENT]}))
    assert (result.status,result.code,result.endpoint)==("error","invalid_response","file")


def test_multiple_chunks_share_one_verified_download_and_graph_text_is_excluded():
    record=json.dumps({"reference_id":"1","content":TEXT},ensure_ascii=False)
    result,requests=execute(httpx.Response(200,json=query_payload(results=[{**CHUNK,"text":context(records=record+'\n'+record)}])),
                            httpx.Response(200,json={"documents":[DOCUMENT]}))
    assert [s.text for s in result.snippets]==[TEXT,TEXT]
    assert len(requests)==3
    assert "摘要" not in result.model_dump_json()


@pytest.mark.parametrize("content", [FILE+b"changed", b"\xff\xfe\x00"])
def test_changed_hash_and_invalid_utf8_are_rejected(content):
    doc=DOCUMENT if content.startswith(FILE) else {**DOCUMENT,"bytes":len(content),"sha256":hashlib.sha256(content).hexdigest()}
    result,_=execute(httpx.Response(200,json=query_payload()),httpx.Response(200,json={"documents":[doc]}),file_response=httpx.Response(200,content=content))
    assert (result.code,result.endpoint)==("invalid_response","file")


def test_response_and_document_size_bounds():
    result,_=execute(httpx.Response(200,content=b"x"*(MAX_RESPONSE_BYTES+1)))
    assert (result.code,result.endpoint)==("invalid_response","query")
    result,requests=execute(httpx.Response(200,json=query_payload()),httpx.Response(200,json={"documents":[{**DOCUMENT,"bytes":MAX_RESPONSE_BYTES+1}]}))
    assert result.code=="invalid_response" and len(requests)==2


def test_streamed_request_obeys_total_deadline_without_transport_timeout_support():
    class Slow(httpx.AsyncByteStream):
        async def __aiter__(self):
            await asyncio.sleep(60)
            yield b"unused"

    async def run():
        async with httpx.AsyncClient(base_url="http://offline.invalid",transport=httpx.MockTransport(lambda r:httpx.Response(200,stream=Slow()))) as http:
            return await KnowledgeClient(http,timeout=0.01).query(KB,"q")
    assert asyncio.run(run()).code=="timeout"
