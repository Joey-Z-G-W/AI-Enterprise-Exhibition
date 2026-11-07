"""Ruika deployment contract: real catalog and archived images over HTTP."""
from pathlib import Path
import json

import pytest
from fastapi.testclient import TestClient

from exhibition_guide.config import load_config
from exhibition_guide.main import create_app
from test_media_api import CompletedAnswer, ask


@pytest.mark.parametrize("source,text,asset_id", [
    ("02-about-services.md", "锐伽是一家以研究定位为核心的品牌综合服务公司。", "ruika-services"),
    ("07-yanjan-exhibition.md", "延江股份案例是2019年的美国展会设计。", "ruika-yanjan"),
    ("03-video-cases.md", "千纸鹤男装《有态度的服装》是院线广告片案例。", "ruika-video"),
])
def test_ruika_answer_has_available_image(monkeypatch, source, text, asset_id):
    monkeypatch.chdir(Path(__file__).resolve().parents[1])
    with TestClient(create_app(load_config("config/ruika.example.toml"), service=ReviewedAnswer(text, source))) as client:
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
    with TestClient(create_app(load_config("config/ruika.example.toml"), service=CompletedAnswer("欢迎提问。", "02-about-services.md"))) as client:
        assert not ask(client).json()["presentation"]["assets"]


class ReviewedAnswer(CompletedAnswer):
    async def answer(self, request, **kwargs):
        response = await super().answer(request, **kwargs)
        response.sources[0].excerpt = Path("data/ruika/clean", self.source).read_text()
        return response


def test_reviewed_multiple_services_are_separate_and_never_first_keyword(monkeypatch):
    monkeypatch.chdir(Path(__file__).resolve().parents[1])
    text = "锐伽提供品牌策划设计服务。锐伽提供国际和国内展览设计服务。锐伽提供视频广告制作服务。"
    with TestClient(create_app(load_config("config/ruika.example.toml"), service=ReviewedAnswer(text, "01-home.md"))) as client:
        data = ask(client).json()
        assert data["text"] == text
        assert "".join(s["text"] for s in data["presentation"]["sentences"]) == text
        assert [s["asset_id"] for s in data["presentation"]["sentences"]] == ["home-brand", "home-space", "home-film"]


@pytest.mark.parametrize("source,text", [
    ("03-video-cases.md", "千纸鹤和暴龙的宣传片提升品牌价值。"),
    ("01-home.md", "锐伽提供品牌策划设计服务，同时制作企业宣传片。"),
    ("08-solar-cafe.md", "SOLAR门头采用木饰面和暖黄色灯光。"),
    ("09-huadi-office.md", "华地投资的品牌定位是市场定位的核心。"),
    ("10-bolon-shop.md", "暴龙店面新形象已于2019年落地。"),
    ("12-vemolly-brand.md", "薇茉丽面膜可以修复细胞。"),
])
def test_unreviewed_cross_image_or_unverified_claims_remain_audio_only(monkeypatch, source, text):
    monkeypatch.chdir(Path(__file__).resolve().parents[1])
    with TestClient(create_app(load_config("config/ruika.example.toml"), service=ReviewedAnswer(text, source))) as client:
        data = ask(client).json()
        assert data["text"] == text
        assert not data["presentation"]["assets"]
        assert all(s["asset_id"] is None for s in data["presentation"]["sentences"])
