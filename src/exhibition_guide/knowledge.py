"""HTTP adapter for the pinned OpenTalking LightRAG protocol.

Results are retrieval candidates, never an assertion of sufficient evidence.
The caller owns the AsyncClient and its lifecycle; no retries are performed.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import math
import re
from typing import Literal
from urllib.parse import quote

import httpx
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator


class _WireModel(BaseModel):
    model_config = ConfigDict(strict=True, allow_inf_nan=False)


class _QueryRequest(_WireModel):
    query: str = Field(min_length=1)
    limit: int = Field(default=3, ge=1, le=20)


class _QueryChunk(_WireModel):
    doc_id: str
    text: str
    score: float

    @field_validator("text")
    @classmethod
    def nonblank_text(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("retrieval text must not be blank")
        return value


class _QueryResponse(_WireModel):
    available: bool
    indexed: bool
    reason: str
    results: list[_QueryChunk]


class _Document(_WireModel):
    # Only identity fields are consumed; the upstream also sends index metadata.
    id: str
    kb_id: str
    filename: str
    sha256: str = Field(pattern=r"^[0-9a-fA-F]{64}$")
    bytes: int = Field(ge=0)


class _DocumentsResponse(_WireModel):
    documents: list[_Document]


class KnownSource(BaseModel):
    status: Literal["known"] = "known"
    doc_id: str
    filename: str


class UnknownSource(BaseModel):
    status: Literal["unknown"] = "unknown"
    doc_id: str
    filename: None = None


class KnowledgeSnippet(BaseModel):
    text: str
    score: float
    source: KnownSource | UnknownSource = Field(discriminator="status")


class KnowledgeResults(BaseModel):
    status: Literal["results"] = "results"
    snippets: list[KnowledgeSnippet] = Field(min_length=1)


class KnowledgeEmpty(BaseModel):
    status: Literal["empty"] = "empty"


class KnowledgeError(BaseModel):
    status: Literal["error"] = "error"
    code: Literal[
        "unavailable", "not_indexed", "query_failed", "upstream_error",
        "http_error", "timeout", "transport_error", "invalid_response",
    ]
    endpoint: Literal["query", "documents", "file"]
    upstream_reason: str | None = None
    http_status: int | None = None


KnowledgeResult = KnowledgeResults | KnowledgeEmpty | KnowledgeError

MAX_RESPONSE_BYTES = 2 * 1024 * 1024
MAX_CHUNKS = 20
_CHUNKS_HEADER = "Document Chunks (Each entry has a reference_id refer to the `Reference Document List`):"
_REFERENCES_HEADER = "Reference Document List (Each entry starts with a [reference_id] that corresponds to entries in the Document Chunks):"


class _ContextChunk(_WireModel):
    model_config = ConfigDict(strict=True, extra="forbid")
    reference_id: str = Field(pattern=r"^[0-9]+$", max_length=32)
    content: str = Field(min_length=1, max_length=MAX_RESPONSE_BYTES)


def _unique_json(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


def _original_chunks(context: str) -> list[tuple[str, str]]:
    """Parse only the pinned context's original chunks, never graph summaries."""
    if context.count(_CHUNKS_HEADER) != 1 or context.count(_REFERENCES_HEADER) != 1:
        raise ValueError("unrecognized context sections")
    tail = context.split(_CHUNKS_HEADER, 1)[1]
    match = re.fullmatch(
        r"\n+```json\n(.+?)\n```\n+" + re.escape(_REFERENCES_HEADER) + r"\n+```\n(.+?)\n```\n*",
        tail, flags=re.DOTALL,
    )
    if match is None:
        raise ValueError("unrecognized context format")
    records = match[1].splitlines()
    if not 1 <= len(records) <= MAX_CHUNKS:
        raise ValueError("invalid chunk count")
    references = {}
    for line in match[2].splitlines():
        ref = re.fullmatch(r"\[([0-9]{1,32})\] (.+)", line)
        if ref is None or ref[1] in references:
            raise ValueError("ambiguous reference list")
        filename = ref[2]
        if filename != filename.strip() or any(char in filename for char in "/\\"):
            raise ValueError("invalid source filename")
        references[ref[1]] = filename
    chunks = []
    for line in records:
        chunk = _ContextChunk.model_validate(json.loads(line, object_pairs_hook=_unique_json))
        if not chunk.content.strip() or chunk.reference_id not in references:
            raise ValueError("missing original source")
        chunks.append((references[chunk.reference_id], chunk.content))
    return chunks


class KnowledgeClient:
    """Use an AsyncClient with base_url set to the OpenTalking API origin."""

    def __init__(self, client: httpx.AsyncClient, *, timeout: float = 10.0) -> None:
        if not math.isfinite(timeout) or timeout <= 0:
            raise ValueError("timeout must be finite and positive")
        self._client = client
        self._timeout = timeout

    async def _read(self, method: str, path: str, deadline: float, **kwargs: object) -> bytes:
        remaining = deadline - asyncio.get_running_loop().time()
        if remaining <= 0:
            raise TimeoutError
        async with asyncio.timeout_at(deadline):
            async with self._client.stream(method, path, timeout=remaining, follow_redirects=False, **kwargs) as response:
                response.raise_for_status()
                data = bytearray()
                async for part in response.aiter_bytes():
                    data.extend(part)
                    if len(data) > MAX_RESPONSE_BYTES:
                        raise ValueError("upstream response exceeds size bound")
                return bytes(data)

    async def query(self, kb_id: str, query: str, *, limit: int = 3) -> KnowledgeResult:
        if not kb_id.strip() or kb_id in {".", ".."}:
            raise ValueError("kb_id is required")
        request = _QueryRequest(query=query.strip(), limit=limit)
        base_path = f"/agent/knowledge-bases/{quote(kb_id, safe='')}"
        endpoint: Literal["query", "documents", "file"] = "query"
        deadline = asyncio.get_running_loop().time() + self._timeout
        try:
            payload = _QueryResponse.model_validate_json(await self._read(
                "POST", f"{base_path}/lightrag/query", deadline, json=request.model_dump(),
            ))
            if not payload.available:
                return KnowledgeError(
                    code="unavailable", endpoint=endpoint, upstream_reason=payload.reason,
                )
            if not payload.indexed:
                return KnowledgeError(
                    code="not_indexed", endpoint=endpoint, upstream_reason=payload.reason,
                )
            if payload.reason:
                return KnowledgeError(
                    code="query_failed" if payload.reason == "query_failed" else "upstream_error",
                    endpoint=endpoint, upstream_reason=payload.reason,
                )
            if not payload.results:
                return KnowledgeEmpty()
            # Fixed upstream emits one empty-ID context envelope. Do not silently
            # accept a changed/direct-text protocol and pass summaries as evidence.
            if len(payload.results) != 1 or payload.results[0].doc_id != "":
                raise ValueError("unrecognized context envelope")
            context = payload.results[0]
            chunks = _original_chunks(context.text)

            endpoint = "documents"
            documents = _DocumentsResponse.model_validate_json(await self._read(
                "GET", f"{base_path}/documents", deadline,
            )).documents
            by_filename: dict[str, list[_Document]] = {}
            ids: set[str] = set()
            for document in documents:
                if not document.id.strip() or document.id in {".", ".."} or document.id in ids or document.kb_id != kb_id:
                    raise ValueError("ambiguous document identity")
                ids.add(document.id)
                by_filename.setdefault(document.filename, []).append(document)
            selected = {}
            for filename, _ in chunks:
                candidates = by_filename.get(filename, [])
                if len(candidates) != 1 or not filename.lower().endswith((".md", ".txt")):
                    raise ValueError("unverified original document")
                document = candidates[0]
                if document.bytes > MAX_RESPONSE_BYTES:
                    raise ValueError("original document exceeds size bound")
                selected[filename] = document
            # This request-local dictionary prevents duplicate downloads; no persistent cache.
            originals = {}
            endpoint = "file"
            for filename, document in selected.items():
                content = await self._read("GET", f"{base_path}/documents/{quote(document.id, safe='')}/file", deadline)
                if len(content) != document.bytes or hashlib.sha256(content).hexdigest() != document.sha256.lower():
                    raise ValueError("source content changed")
                originals[filename] = content.decode("utf-8").replace("\r\n", "\n").replace("\r", "\n")
            snippets = []
            for filename, text in chunks:
                if text not in originals[filename]:
                    raise ValueError("chunk is not original text")
                document = selected[filename]
                snippets.append(KnowledgeSnippet(text=text, score=context.score,
                    source=KnownSource(doc_id=document.id, filename=document.filename)))
            return KnowledgeResults(snippets=snippets[:limit])
        except (TimeoutError, httpx.TimeoutException):
            return KnowledgeError(code="timeout", endpoint=endpoint)
        except httpx.HTTPStatusError as exc:
            return KnowledgeError(
                code="http_error", endpoint=endpoint, http_status=exc.response.status_code,
            )
        except httpx.RequestError:
            return KnowledgeError(code="transport_error", endpoint=endpoint)
        except (ValidationError, ValueError):
            return KnowledgeError(code="invalid_response", endpoint=endpoint)
