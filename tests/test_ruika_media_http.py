"""Ruika deployment contract: real catalog and archived images over HTTP."""
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from exhibition_guide.config import load_config
from exhibition_guide.main import create_app
from test_media_api import CompletedAnswer, ask


@pytest.mark.parametrize("source,text,asset_id", [
    ("02-about-services.md", "公司提供品牌定位、视觉设计和传播服务。", "ruika-services"),
    ("07-yanjan-exhibition.md", "延江展厅展示企业品牌和产品。", "ruika-yanjan"),
    ("03-video-cases.md", "千纸鹤是影视广告案例。", "ruika-video"),
])
def test_ruika_answer_has_available_image(monkeypatch, source, text, asset_id):
    monkeypatch.chdir(Path(__file__).resolve().parents[1])
    with TestClient(create_app(load_config("config/example.toml"), service=CompletedAnswer(text, source))) as client:
        response = ask(client)
        assert response.status_code == 200
        presentation = response.json().get("presentation")
        assert presentation, "Ruika deployment must enable the reviewed media catalog"
        assert presentation["sentences"][0]["asset_id"] == asset_id
        image = client.get(f"/media/{asset_id}")
        assert image.status_code == 200
        assert image.headers["content-type"] == "image/jpeg"
        assert image.content.startswith(b"\xff\xd8\xff")


def test_ruika_unmatched_answer_has_no_image(monkeypatch):
    monkeypatch.chdir(Path(__file__).resolve().parents[1])
    with TestClient(create_app(load_config("config/example.toml"), service=CompletedAnswer("欢迎提问。", "02-about-services.md"))) as client:
        assert "presentation" not in ask(client).json()
