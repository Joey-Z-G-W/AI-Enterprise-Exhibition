import asyncio
import json
import traceback

import httpx
import pytest

from exhibition_guide.config import ModelConfig
from exhibition_guide.llm import ModelClient, ModelError


def config(timeout=1.0):
    return ModelConfig(enabled=True, api_key="fake-secret", timeout_seconds=timeout)


def completion(content=" 连接成功。 ", finish="stop"):
    return {"id": "test", "object": "chat.completion", "created": 0,
            "model": "deepseek-flash", "choices": [
                {"index": 0, "message": {"role": "assistant", "content": content},
                 "finish_reason": finish}]}


def test_real_sdk_wire_contract_and_model_preflight():
    requests = []
    def handler(request):
        requests.append(request)
        if request.url.path == "/models":
            return httpx.Response(200, json={"object": "list", "data": [
                {"id": "deepseek-flash", "object": "model", "owned_by": "deepseek"}]})
        return httpx.Response(200, json=completion())
    async def run():
        http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        async with ModelClient(config(), http_client=http) as model:
            assert await model.verify_model() == ("deepseek-flash",)
            assert await model.complete("测试", system="简短回复", max_tokens=32) == " 连接成功。 "
        assert http.is_closed
    asyncio.run(run())
    assert len(requests) == 2
    payload = json.loads(requests[1].content)
    assert requests[1].url.path == "/chat/completions"
    assert payload == {"model": "deepseek-flash", "messages": [
        {"role": "system", "content": "简短回复"}, {"role": "user", "content": "测试"}],
        "max_tokens": 32, "stream": False, "thinking": {"type": "disabled"}}


@pytest.mark.parametrize("status,code", [
    (400, "request_rejected"), (401, "authentication_failed"),
    (403, "authentication_failed"), (402, "insufficient_balance"),
    (404, "model_unavailable"), (429, "rate_limited"), (503, "service_unavailable"),
])
def test_http_errors_are_safe_and_never_retried(status, code, caplog):
    seen = []
    def handler(request):
        seen.append(request)
        return httpx.Response(status, json={"error": {"message": "fake-secret upstream detail"}})
    async def run():
        async with ModelClient(config(), http_client=httpx.AsyncClient(
            transport=httpx.MockTransport(handler))) as model:
            with pytest.raises(ModelError) as caught:
                await model.complete("测试")
            assert caught.value.code == code
            assert "fake-secret" not in "".join(traceback.format_exception(caught.value)) + caplog.text
    asyncio.run(run())
    assert len(seen) == 1


@pytest.mark.parametrize("body,expected", [
    ({}, "invalid_response"),
    ({"choices": []}, "invalid_response"),
    (completion(""), "empty_response"),
    (completion(None), "empty_response"),
    (completion("text", "length"), "incomplete_response"),
    (completion(["wrong type"]), "invalid_response"),
])
def test_invalid_or_empty_completion(body, expected):
    async def run():
        http = httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(200, json=body)))
        async with ModelClient(config(), http_client=http) as model:
            with pytest.raises(ModelError, match=expected):
                await model.complete("测试")
    asyncio.run(run())


@pytest.mark.parametrize("data,expected", [
    ({"data": [{"id": "other-model"}]}, "model_unavailable"),
    ({}, "invalid_response"), ({"data": [{"id": 123}]}, "invalid_response"),
])
def test_preflight_never_substitutes_model(data, expected):
    seen = []
    def handler(request):
        seen.append(request)
        return httpx.Response(200, json=data)
    async def run():
        async with ModelClient(config(), http_client=httpx.AsyncClient(
            transport=httpx.MockTransport(handler))) as model:
            with pytest.raises(ModelError, match=expected):
                await model.verify_model()
    asyncio.run(run())
    assert len(seen) == 1 and seen[0].url.path == "/models"


@pytest.mark.parametrize("error_type,expected", [
    (httpx.ReadTimeout, "timeout"), (httpx.ConnectError, "connection_failed"),
])
def test_transport_errors(error_type, expected):
    def handler(request):
        raise error_type("fake-secret", request=request)
    async def run():
        async with ModelClient(config(), http_client=httpx.AsyncClient(
            transport=httpx.MockTransport(handler))) as model:
            with pytest.raises(ModelError, match=expected):
                await model.complete("测试")
    asyncio.run(run())


def test_overall_deadline_and_caller_cancellation():
    async def run():
        started = asyncio.Event()
        stopped = asyncio.Event()
        async def handler(_):
            started.set()
            try:
                await asyncio.sleep(10)
            finally:
                stopped.set()
        async with ModelClient(config(0.02), http_client=httpx.AsyncClient(
            transport=httpx.MockTransport(handler))) as model:
            with pytest.raises(ModelError, match="timeout"):
                await model.complete("测试")
            assert stopped.is_set()
        started.clear()
        stopped.clear()
        async with ModelClient(config(), http_client=httpx.AsyncClient(
            transport=httpx.MockTransport(handler))) as model:
            pending = asyncio.create_task(model.complete("测试"))
            await started.wait()
            pending.cancel()
            with pytest.raises(asyncio.CancelledError):
                await pending
            assert stopped.is_set()
    asyncio.run(run())


def test_disabled_config_fails_without_client():
    with pytest.raises(ModelError, match="not_configured"):
        ModelClient(ModelConfig())


def test_default_http_client_constructs_and_closes_without_network(monkeypatch):
    monkeypatch.setenv("NO_PROXY", "localhost,127.0.0.1")
    # A configured proxy remains honored; construction makes no request.
    monkeypatch.setenv("HTTPS_PROXY", "http://proxy.example:8080")
    async def run():
        async with ModelClient(config()) as model:
            http = model._client._client
            assert http.trust_env is True
            assert not http.is_closed
        assert http.is_closed
    asyncio.run(run())


def test_default_http_client_rejects_bad_proxy_configuration_safely(monkeypatch, caplog):
    monkeypatch.setenv("NO_PROXY", "fake-secret-host:invalid")
    async def run():
        with pytest.raises(ModelError, match="transport_configuration_error") as caught:
            ModelClient(config())
        assert "fake-secret" not in "".join(traceback.format_exception(caught.value)) + caplog.text
    asyncio.run(run())
