"""Reviewed local media catalog, served by ID and tied to verified answer sources."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
from typing import BinaryIO, Literal
from urllib.parse import urlsplit

from fastapi import HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator
from starlette.background import BackgroundTask
from starlette.responses import StreamingResponse

from exhibition_guide.answer import QuestionResponse
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
    sentences: list[Sentence]
    assets: list[PublicAsset]


class PresentedQuestionResponse(QuestionResponse):
    presentation: Presentation | None = None


def _sentences(text: str) -> list[str]:
    # Keep whitespace/closing punctuation verbatim; a decimal point is not a boundary.
    result, start, index = [], 0, 0
    while index < len(text):
        char = text[index]
        end = char in "。！？!?" or (char == "." and not (
            index > 0 and index + 1 < len(text) and text[index - 1].isdigit() and text[index + 1].isdigit()))
        if end:
            index += 1
            while index < len(text) and text[index] in "。！？!?.\"'”’）)":
                index += 1
            result.append(text[start:index])
            start = index
        else:
            index += 1
    if start < len(text):
        if text[start:].strip() or not result:
            result.append(text[start:])
        else:
            result[-1] += text[start:]
    return result


def _keyword_matches(keyword: str, text: str) -> bool:
    # Latin keywords must match whole words, so “car” cannot select “cart”.
    escaped = re.escape(keyword)
    left = r"(?<![A-Za-z0-9_])" if keyword[0].isascii() and keyword[0].isalnum() else ""
    right = r"(?![A-Za-z0-9_])" if keyword[-1].isascii() and keyword[-1].isalnum() else ""
    return re.search(left + escaped + right, text, flags=re.IGNORECASE) is not None


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

    def presentation(self, answer: QuestionResponse) -> Presentation | None:
        if answer.status != "answer" or not self.assets:
            return None
        parts = _sentences(answer.text)
        if not parts or len(parts) > 64:
            return None
        filenames = {s.source.filename for s in answer.sources if s.source.status == "known"}
        used, sentences, verified = {}, [], {}
        for index, text in enumerate(parts):
            selected = None
            for asset in self.assets.values():
                if asset.source_filename not in filenames or not any(_keyword_matches(k, text) for k in asset.keywords):
                    continue
                if asset.id not in verified:
                    try:
                        with self._open(asset):
                            verified[asset.id] = True
                    except (OSError, ValueError, RuntimeError):
                        verified[asset.id] = False
                if verified[asset.id]:
                    selected = asset.id
                    used[selected] = PublicAsset(id=asset.id, kind=asset.kind, url=f"/guide/media/{asset.id}", mime=asset.mime, alt=asset.alt)
                    break
            sentences.append(Sentence(id=f"s{index + 1}", text=text, asset_id=selected))
        return Presentation(sentences=sentences, assets=list(used.values())) if used else None

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
