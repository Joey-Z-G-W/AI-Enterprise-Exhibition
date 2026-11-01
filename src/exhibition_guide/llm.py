"""Small asynchronous OpenAI-compatible adapter with safe error codes."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable
from typing import TypeVar

import httpx
from openai import (
    APIConnectionError, APIResponseValidationError, APIStatusError,
    APITimeoutError, AsyncOpenAI,
)

from exhibition_guide.config import ModelConfig

T = TypeVar("T")


class ModelError(RuntimeError):
    """Only a fixed code is public; never expose an SDK error or response body."""

    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


class ModelClient:
    def __init__(self, config: ModelConfig, *, http_client: httpx.AsyncClient | None = None):
        if not config.enabled:
            raise ModelError("not_configured")
        self.model = config.model
        self.timeout = config.timeout_seconds
        if http_client is None:
            try:
                # Keep HTTPX's default TLS verification and trust_env behavior.
                # Construct explicitly so malformed proxy configuration fails
                # safely before the SDK creates its cleanup wrapper.
                http_client = httpx.AsyncClient(timeout=self.timeout)
            except (httpx.InvalidURL, ValueError, ImportError, OSError):
                raise ModelError("transport_configuration_error") from None
        self._client = AsyncOpenAI(
            base_url=config.base_url, api_key=config.api_key.get_secret_value(),
            max_retries=0, timeout=self.timeout, http_client=http_client,
        )

    async def __aenter__(self) -> ModelClient:
        return self

    async def __aexit__(self, *_: object) -> None:
        await self.close()

    async def close(self) -> None:
        await self._client.close()

    async def _call(self, request: Awaitable[T], *, completion: bool = False) -> T:
        try:
            async with asyncio.timeout(self.timeout):
                return await request
        except (TimeoutError, APITimeoutError):
            raise ModelError("timeout") from None
        except APIConnectionError:
            raise ModelError("connection_failed") from None
        except APIStatusError as error:
            status = error.status_code
            if status in {401, 403}:
                code = "authentication_failed"
            elif status == 402:
                code = "insufficient_balance"
            elif status == 429:
                code = "rate_limited"
            elif status == 404 and completion:
                code = "model_unavailable"
            elif status >= 500:
                code = "service_unavailable"
            else:
                code = "request_rejected"
            # Known structured provider codes only, never parse/repeat messages.
            body = error.body
            if status == 400 and isinstance(body, dict) and body.get("code") in {
                "model_not_found", "model_not_available",
            }:
                code = "model_unavailable"
            raise ModelError(code) from None
        except (APIResponseValidationError, ValueError, TypeError):
            raise ModelError("invalid_response") from None

    async def available_models(self) -> tuple[str, ...]:
        result = await self._call(self._client.models.list())
        data = getattr(result, "data", None)
        if not isinstance(data, list):
            raise ModelError("invalid_response")
        ids = tuple(getattr(item, "id", None) for item in data)
        if any(not isinstance(item, str) or not item.strip() for item in ids):
            raise ModelError("invalid_response")
        return ids

    async def verify_model(self) -> tuple[str, ...]:
        ids = await self.available_models()
        if self.model not in ids:
            raise ModelError("model_unavailable")
        return ids

    async def complete(self, prompt: str, *, system: str = "", max_tokens: int = 128) -> str:
        if not isinstance(prompt, str) or not prompt.strip() or not isinstance(system, str):
            raise ModelError("invalid_request")
        if type(max_tokens) is not int or not 1 <= max_tokens <= 4096:
            raise ModelError("invalid_request")
        messages = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": prompt})
        response = await self._call(self._client.chat.completions.create(
            model=self.model, messages=messages, max_tokens=max_tokens,
            stream=False, extra_body={"thinking": {"type": "disabled"}},
        ), completion=True)
        choices = getattr(response, "choices", None)
        if not isinstance(choices, list) or len(choices) != 1:
            raise ModelError("invalid_response")
        choice = choices[0]
        content = getattr(getattr(choice, "message", None), "content", None)
        if content is None or (isinstance(content, str) and not content.strip()):
            raise ModelError("empty_response")
        if not isinstance(content, str):
            raise ModelError("invalid_response")
        if getattr(choice, "finish_reason", None) != "stop":
            raise ModelError("incomplete_response")
        return content
