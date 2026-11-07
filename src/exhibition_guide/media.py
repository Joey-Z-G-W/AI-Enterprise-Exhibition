"""Reviewed local media catalog, served by ID and tied to verified answer sources."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path, PurePosixPath
from typing import BinaryIO, Literal
from urllib.parse import urlsplit

from fastapi import HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator
from starlette.background import BackgroundTask
from starlette.responses import StreamingResponse

from exhibition_guide.answer import AnswerSource, QuestionResponse
from exhibition_guide.sentences import split_sentences as _sentences
from exhibition_guide.config import MediaConfig


_MIMES = {"image/png", "image/jpeg", "image/webp", "image/gif"}
_CHUNK = 1024 * 1024


def _relative(value: str) -> PurePosixPath:
    if not value or "\\" in value or ":" in value or "\x00" in value:
        raise ValueError("invalid relative path")
    path = PurePosixPath(value)
    if path.is_absolute() or any(part in {".", "..", ""} for part in value.split("/")):
        raise ValueError("invalid relative path")
    return path


class ReviewedNarration(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid", frozen=True)
    text: str = Field(min_length=1, max_length=500)
    evidence: list[str] = Field(min_length=1, max_length=8)

    @model_validator(mode="after")
    def single_sentence(self):
        if self.text != self.text.strip() or len(_sentences(self.text)) != 1 or not any(self.text.endswith(p) for p in "。！？!?."):
            raise ValueError("narration must be one complete sentence")
        if any(not part.strip() for part in self.evidence):
            raise ValueError("narration needs source evidence")
        return self


class ReviewedFact(ReviewedNarration):
    id: str = Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")


class _Asset(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid", frozen=True)
    id: str = Field(pattern=r"^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$")
    kind: Literal["image"]
    relative_path: str
    sha256: str = Field(pattern=r"^[0-9a-fA-F]{64}$")
    mime: str
    source_filename: str = Field(min_length=1, max_length=512)
    source_url: str = Field(max_length=2048)
    alt: str = Field(min_length=1, max_length=500)
    keywords: list[str] = Field(min_length=1, max_length=64)
    reviewed: bool
    narrations: list[ReviewedNarration] = Field(default_factory=list, max_length=24)
    case_id: str | None = None
    case_name: str | None = None
    client_id: str | None = None
    aliases: list[str] = Field(default_factory=list, max_length=16)
    category: Literal["exhibition", "retail", "office", "brand", "film", "services"] | None = None
    angle: str | None = None
    facts: list[ReviewedFact] = Field(default_factory=list, max_length=24)

    @model_validator(mode="after")
    def safe(self):
        if self.reviewed is not True:
            raise ValueError("asset is not reviewed")
        _relative(self.relative_path)
        if self.mime not in _MIMES:
            raise ValueError("unsupported media type")
        if self.source_filename != self.source_filename.strip() or any(c in self.source_filename for c in "/\\:"):
            raise ValueError("invalid source filename")
        if any(not k.strip() or k != k.strip() or len(k) > 128 or not any(c.isalnum() for c in k) for k in self.keywords):
            raise ValueError("invalid keyword")
        url = urlsplit(self.source_url)
        if (url.scheme not in {"https", "http"} or not url.hostname or url.username is not None
                or url.password is not None or any(c.isspace() for c in self.source_url)):
            raise ValueError("invalid source URL")
        _ = url.port
        return self


class Sentence(BaseModel):
    id: str
    text: str
    asset_id: str | None


class PublicAsset(BaseModel):
    id: str
    kind: Literal["image"]
    url: str
    mime: str
    alt: str


class Presentation(BaseModel):
    mode: Literal["paragraph"] | None = None
    sentences: list[Sentence]
    assets: list[PublicAsset]


class PresentedQuestionResponse(QuestionResponse):
    presentation: Presentation | None = None




class MediaCatalog:
    def __init__(self, config: MediaConfig):
        self.root: Path | None = None
        self.assets: dict[str, _Asset] = {}
        if not config.enabled:
            return
        try:
            root = Path(config.root)
            if root.is_symlink():
                return
            self.root = root.resolve(strict=True)
            manifest = self._path(config.manifest)
            with manifest.open("rb") as stream:
                raw = stream.read(2 * _CHUNK + 1)
            if len(raw) > 2 * _CHUNK:
                return
            data = json.loads(raw)
            if not isinstance(data, dict) or set(data) != {"assets"} or not isinstance(data["assets"], list) or len(data["assets"]) > 512:
                return
            seen = set()
            for item in data["assets"]:
                try:
                    asset = _Asset.model_validate(item)
                except (ValidationError, ValueError):
                    continue
                if asset.id in seen:
                    self.assets.clear()
                    return
                seen.add(asset.id)
                self.assets[asset.id] = asset
        except (OSError, ValueError, RuntimeError):
            self.assets.clear()

    def _path(self, relative: str) -> Path:
        if self.root is None:
            raise ValueError("media unavailable")
        path = self.root
        for part in _relative(relative).parts:
            path /= part
            if path.is_symlink():
                raise ValueError("media unavailable")
        resolved = path.resolve(strict=True)
        if not resolved.is_relative_to(self.root) or not resolved.is_file():
            raise ValueError("media unavailable")
        return resolved

    def _open(self, asset: _Asset) -> BinaryIO:
        path = self._path(asset.relative_path)
        stream = path.open("rb")
        try:
            # Compare the opened descriptor to the checked pathname, then hash and
            # serve from this same descriptor; no FileResponse path reopen race.
            if not os.path.samestat(os.fstat(stream.fileno()), self._path(asset.relative_path).stat()):
                raise ValueError("media unavailable")
            digest = hashlib.sha256()
            for chunk in iter(lambda: stream.read(_CHUNK), b""):
                digest.update(chunk)
            if digest.hexdigest() != asset.sha256.lower():
                raise ValueError("media unavailable")
            stream.seek(0)
            return stream
        except BaseException:
            stream.close()
            raise

    def playback_sentence_ids(self, answer: QuestionResponse) -> set[str]:
        # Plain audio-only answers still have valid playback receipts, but no
        # reviewed case/angle claims. Match the public plan's exact partition.
        parts = answer._visual_plan or _sentences(answer.text)
        return {f"s{i + 1}" for i in range(len(parts))}

    def cases(self) -> dict[str, dict]:
        result = {}
        for asset in self.assets.values():
            if asset.case_id and asset.category and asset.category != "services" and asset.facts:
                item = result.setdefault(asset.case_id, {"id": asset.case_id, "name": asset.case_name or asset.case_id,
                    "category": asset.category, "client_id": asset.client_id or asset.case_id, "aliases": asset.aliases, "angles": []})
                if asset.angle not in item["angles"]:
                    item["angles"].append(asset.angle)
        return result

    def visual_options(self, snippets: tuple[str, ...], tour: dict | None = None) -> list[dict]:
        result = []
        for asset in self.assets.values():
            if tour and tour.get("case_id") and asset.case_id != tour["case_id"]:
                continue
            facts = [f.model_dump() for f in asset.facts if all(any(e in s for s in snippets) for e in f.evidence)]
            if facts:
                result.append({"asset_id": asset.id, "case_id": asset.case_id, "case_name": asset.case_name,
                    "category": asset.category, "angle": asset.angle, "description": asset.alt, "facts": facts})
        return result

    def resolve_visual(self, ids: list[str], snapshot: list[AnswerSource], citations: list[AnswerSource], tour: dict | None) -> str | None:
        if not ids or len(set(ids)) != len(ids):
            return None
        cited = {s.source.filename for s in citations if s.source.status == "known"}
        matches = []
        for fact_id in ids:
            candidates = [(a, f) for a in self.assets.values() for f in a.facts if f.id == fact_id]
            if len(candidates) != 1:
                return None
            asset, fact = candidates[0]
            if asset.source_filename not in cited or (tour and tour.get("case_id") and asset.case_id != tour["case_id"]):
                return None
            if not all(any(s.source.status == "known" and s.source.filename == asset.source_filename
                           and evidence in s.excerpt for s in snapshot) for evidence in fact.evidence):
                return None
            matches.append(asset.id)
        return matches[0] if len(set(matches)) == 1 else None

    def narration_options(self, snippets: tuple[str, ...]) -> list[dict]:
        # Only offer optional wording supported by the current retrieval, never
        # enrich the answer with facts from the catalog or another turn.
        return [{"id": f"{asset.id}:{index + 1}", "text": n.text, "evidence": n.evidence}
                for asset in self.assets.values() for index, n in enumerate(asset.narrations)
                if all(any(e in snippet for snippet in snippets) for e in n.evidence)]

    def resolve_narration(self, narration_id: str, snapshot: list[AnswerSource], citations: list[AnswerSource]) -> str | None:
        cited = {s.source.filename for s in citations if s.source.status == "known"}
        for asset in self.assets.values():
            if asset.source_filename not in cited:
                continue
            for index, narration in enumerate(asset.narrations):
                if narration_id == f"{asset.id}:{index + 1}" and all(any(
                    source.source.status == "known" and source.source.filename == asset.source_filename
                    and evidence in source.excerpt for source in snapshot) for evidence in narration.evidence):
                    return narration.text
        return None

    def presentation(self, answer: QuestionResponse) -> Presentation | None:
        if answer.status != "answer" or not self.assets:
            return None
        parts = [s["text"] for s in answer._visual_plan] if answer._visual_plan else _sentences(answer.text)
        if not parts or len(parts) > 64:
            return None
        cited_files = {s.source.filename for s in answer.sources if s.source.status == "known"}
        snapshot = answer._verified_snippets or answer.sources
        used, sentences, verified = {}, [], {}
        for index, text in enumerate(parts):
            # Binding is a closed, reviewed sentence contract, never keyword ranking.
            # Evidence must be in this turn's verified source snapshot, from a cited file.
            candidates = [asset for asset in self.assets.values() if asset.source_filename in cited_files and any(
                narration.text == text.strip() and all(any(
                    source.source.status == "known"
                    and source.source.filename == asset.source_filename
                    and evidence in source.excerpt
                    for source in snapshot) for evidence in narration.evidence)
                for narration in asset.narrations)]
            if answer._visual_plan:
                approved = answer._visual_plan[index]["asset_id"]
                candidates = [self.assets[approved]] if approved in self.assets else []
            selected = None
            if len(candidates) == 1:
                asset = candidates[0]
                if asset.id not in verified:
                    try:
                        with self._open(asset):
                            verified[asset.id] = True
                    except (OSError, ValueError, RuntimeError):
                        verified[asset.id] = False
                if verified[asset.id]:
                    selected = asset.id
                    used[selected] = PublicAsset(id=asset.id, kind=asset.kind, url=f"/guide/media/{asset.id}", mime=asset.mime, alt=asset.alt)
            sentences.append(Sentence(id=f"s{index + 1}", text=text, asset_id=selected))
        return Presentation(sentences=sentences, assets=list(used.values()), mode="paragraph" if any(a.facts for a in self.assets.values()) else None)

    def response(self, asset_id: str, request: Request) -> Response:
        asset = self.assets.get(asset_id)
        if asset is None:
            raise HTTPException(404, "media unavailable")
        try:
            stream = self._open(asset)
        except (OSError, ValueError, RuntimeError):
            raise HTTPException(404, "media unavailable") from None
        size = os.fstat(stream.fileno()).st_size
        headers = {"X-Content-Type-Options": "nosniff", "Cache-Control": "no-store", "Content-Length": str(size)}
        if request.method == "HEAD":
            stream.close()
            return Response(media_type=asset.mime, headers=headers)

        def chunks():
            try:
                remaining = size
                while remaining > 0:
                    chunk = stream.read(min(_CHUNK, remaining))
                    if not chunk:
                        break
                    remaining -= len(chunk)
                    yield chunk
            finally:
                stream.close()

        return StreamingResponse(chunks(), media_type=asset.mime, headers=headers,
                                 background=BackgroundTask(stream.close))
