"""Public UI configuration stays independent of private service configuration."""

from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from exhibition_guide import main
from exhibition_guide.config import AppConfig
from exhibition_guide.main import UIConfigResponse, create_app


def test_default_ui_config_does_not_load_local_files(monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError("default app must not read local configuration")

    monkeypatch.setattr(main, "load_config", forbidden)
    monkeypatch.setattr(Path, "open", forbidden)
    with TestClient(create_app()) as client:
        response = client.get("/ui-config")
    assert response.status_code == 200
    assert response.json() == {
        "avatar_id": "companion", "tts_voice": "zh-CN-XiaoxiaoNeural",
    }


def test_custom_ui_config_projects_only_public_pair(monkeypatch):
    config = AppConfig.model_validate({
        "llm": {"api_key": "fake-llm-secret", "base_url": "https://llm.invalid/v1"},
        "embedding": {"api_key": "fake-embedding-secret", "base_url": "https://embedding.invalid/v1"},
        "knowledge": {"base_url": "https://knowledge.invalid", "kb_id": "private-kb-id"},
        "avatar": {"avatar_id": "public-avatar", "tts_voice": "public-voice"},
    })

    def forbidden(*args, **kwargs):
        raise AssertionError("public route must never serialize AppConfig")

    monkeypatch.setattr(AppConfig, "model_dump", forbidden)
    monkeypatch.setattr(AppConfig, "model_dump_json", forbidden)
    with TestClient(create_app(config)) as client:
        response = client.get("/ui-config")
        schema = client.get("/openapi.json").json()["components"]["schemas"]["UIConfigResponse"]
    assert response.status_code == 200
    assert response.json() == {"avatar_id": "public-avatar", "tts_voice": "public-voice"}
    for private in ("fake-llm-secret", "fake-embedding-secret", "llm.invalid", "embedding.invalid", "knowledge.invalid", "private-kb-id"):
        assert private not in response.text
    assert set(schema["properties"]) == {"avatar_id", "tts_voice"}
    assert set(schema["required"]) == {"avatar_id", "tts_voice"}
    assert schema["additionalProperties"] is False


@pytest.mark.parametrize("extra", ["api_key", "base_url", "kb_id", "path"])
def test_ui_response_rejects_additional_fields(extra):
    with pytest.raises(ValidationError):
        UIConfigResponse.model_validate({"avatar_id": "avatar", "tts_voice": "voice", extra: "private"})


def test_production_factory_still_loads_explicit_configuration(monkeypatch):
    calls = []

    def load():
        calls.append("load")
        return AppConfig.model_validate({"avatar": {"avatar_id": "configured-avatar", "tts_voice": "configured-voice"}})

    monkeypatch.setattr(main, "load_config", load)
    with TestClient(main.create_production_app()) as client:
        assert client.get("/ui-config").json() == {
            "avatar_id": "configured-avatar", "tts_voice": "configured-voice",
        }
    assert calls == ["load"]
