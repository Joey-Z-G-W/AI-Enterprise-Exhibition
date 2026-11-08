"""Public HTTP configuration never exposes private service values."""
from fastapi.testclient import TestClient
from exhibition_guide.config import AppConfig
from exhibition_guide.main import create_app


def test_default_ui_config():
    with TestClient(create_app()) as client:
        response = client.get("/ui-config")
    assert response.status_code == 200
    assert response.json() == {"avatar_id": "companion", "tts_voice": "zh-CN-XiaoxiaoNeural"}
    assert response.headers["x-guide-speech-mode"] == "paragraph"


def test_private_config_stays_outside_public_response_and_schema():
    config = AppConfig.model_validate({
        "llm": {"api_key": "fake-llm-secret", "base_url": "https://llm.invalid/v1"},
        "embedding": {"api_key": "fake-embedding-secret"},
        "knowledge": {"kb_id": "private-kb-id"},
        "avatar": {"avatar_id": "public-avatar", "tts_voice": "public-voice"},
    })
    with TestClient(create_app(config)) as client:
        response = client.get("/ui-config")
        schema = client.get("/openapi.json").json()["components"]["schemas"]["UIConfigResponse"]
    assert response.json() == {"avatar_id": "public-avatar", "tts_voice": "public-voice"}
    assert set(schema["properties"]) == {"avatar_id", "tts_voice"}
    assert schema["additionalProperties"] is False
    for secret in ["fake-llm-secret", "fake-embedding-secret", "private-kb-id", "llm.invalid"]:
        assert secret not in response.text
