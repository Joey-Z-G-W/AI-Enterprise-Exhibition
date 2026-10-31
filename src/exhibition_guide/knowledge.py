"""HTTP adapter for the pinned OpenTalking LightRAG protocol.

Results are retrieval candidates, never an assertion of sufficient evidence.
The caller owns the AsyncClient and its lifecycle; no retries are performed.
"""

from __future__ import annotations

import math
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
    endpoint: Literal["query", "documents"]
    upstream_reason: str | None = None
    http_status: int | None = None


KnowledgeResult = KnowledgeResults | KnowledgeEmpty | KnowledgeError


class KnowledgeClient:
    """Use an AsyncClient with base_url set to the OpenTalking API origin."""

    def __init__(self, client: httpx.AsyncClient, *, timeout: float = 10.0) -> None:
        if not math.isfinite(timeout) or timeout <= 0:
            raise ValueError("timeout must be finite and positive")
        self._client = client
        self._timeout = timeout

    async def query(self, kb_id: str, query: str, *, limit: int = 3) -> KnowledgeResult:
        if not kb_id.strip() or kb_id in {".", ".."}:
            raise ValueError("kb_id is required")
        request = _QueryRequest(query=query.strip(), limit=limit)
        base_path = f"/agent/knowledge-bases/{quote(kb_id, safe='')}"
        endpoint: Literal["query", "documents"] = "query"
        try:
            response = await self._client.post(
                f"{base_path}/lightrag/query",
                json=request.model_dump(),
                timeout=self._timeout,
                follow_redirects=False,
            )
            response.raise_for_status()
            payload = _QueryResponse.model_validate(response.json())
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

            endpoint = "documents"
            response = await self._client.get(
                f"{base_path}/documents", timeout=self._timeout, follow_redirects=False,
            )
            response.raise_for_status()
            documents = _DocumentsResponse.model_validate(response.json()).documents
            # A duplicate ID or wrong KB cannot establish an unambiguous source.
            by_id: dict[str, list[_Document]] = {}
            for document in documents:
                by_id.setdefault(document.id, []).append(document)
            snippets = []
            for chunk in payload.results:
                candidates = by_id.get(chunk.doc_id, []) if chunk.doc_id.strip() else []
                source: KnownSource | UnknownSource = UnknownSource(doc_id=chunk.doc_id)
                if len(candidates) == 1:
                    document = candidates[0]
                    if document.kb_id == kb_id and document.filename.strip():
                        source = KnownSource(doc_id=chunk.doc_id, filename=document.filename)
                snippets.append(KnowledgeSnippet(text=chunk.text, score=chunk.score, source=source))
            return KnowledgeResults(snippets=snippets)
        except httpx.TimeoutException:
            return KnowledgeError(code="timeout", endpoint=endpoint)
        except httpx.HTTPStatusError as exc:
            return KnowledgeError(
                code="http_error", endpoint=endpoint, http_status=exc.response.status_code,
            )
        except httpx.RequestError:
            return KnowledgeError(code="transport_error", endpoint=endpoint)
        except (ValidationError, ValueError):
            return KnowledgeError(code="invalid_response", endpoint=endpoint)
