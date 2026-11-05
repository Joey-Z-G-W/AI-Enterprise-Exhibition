"""HTTP integration: real routing/history/catalog; answer generation is an injected boundary.

The substitute supplies a completed answer, not media selection or validation.
Assets and manifests are real files; all assertions inspect HTTP contracts.
"""
import hashlib
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from exhibition_guide.answer import AnswerSource, QuestionResponse
from exhibition_guide.config import AppConfig
from exhibition_guide.knowledge import KnownSource, UnknownSource
from exhibition_guide.main import create_app
from test_concise_answer_http import SHORT, completion, external_services


class CompletedAnswer:
    timeout = 10.0

    def __init__(self, text="机器人速度为3.14米。欢迎参观！", source="guide.md", status="answer"):
        self.text, self.source, self.status = text, source, status

    async def answer(self, request, **kwargs):
        source = KnownSource(doc_id="doc", filename=self.source) if self.source else UnknownSource(doc_id="doc")
        return QuestionResponse(
            visitor_id=request.visitor_id, turn_id=request.turn_id, turn_seq=request.turn_seq,
            status=self.status, text=self.text,
            sources=[AnswerSource(snippet_index=0, excerpt="机器人", source=source)],
        )


@pytest.fixture
def catalog(tmp_path):
    content = b"\x89PNG\r\n\x1a\nreviewed-image"
    (tmp_path / "robot.png").write_bytes(content)
    record = dict(id="robot", kind="image", relative_path="robot.png",
                  sha256=hashlib.sha256(content).hexdigest(), mime="image/png",
                  source_filename="guide.md", source_url="https://company.example/guide",
                  alt="机器人", keywords=["机器人"], reviewed=True)
    return tmp_path, record, content


def configured(catalog, **changes):
    root, record, _ = catalog
    record = {**record, **changes}
    (root / "manifest.json").write_text(json.dumps({"assets": [record]}), encoding="utf-8")
    return AppConfig.model_validate({"media": {"enabled": True, "root": str(root), "manifest": "manifest.json"}})


def ask(client):
    return client.post("/questions", json={"visitor_id": "visitor", "turn_id": "turn", "turn_seq": 1, "question": "介绍机器人"})


def test_reviewed_asset_binds_only_matching_sentence_and_preserves_identity(catalog):
    with TestClient(create_app(configured(catalog), service=CompletedAnswer())) as client:
        response = ask(client)
        payload = response.json()
        presentation = payload["presentation"]
        assert response.status_code == 200
        assert [s["text"] for s in presentation["sentences"]] == ["机器人速度为3.14米。", "欢迎参观！"]
        assert [s["asset_id"] for s in presentation["sentences"]] == ["robot", None]
        assert len({s["id"] for s in presentation["sentences"]}) == 2
        assert presentation["assets"] == [{"id": "robot", "kind": "image", "url": "/guide/media/robot", "mime": "image/png", "alt": "机器人"}]
        assert (payload["visitor_id"], payload["turn_id"], payload["turn_seq"]) == ("visitor", "turn", 1)
        media = client.get("/media/robot")
        assert media.status_code == 200 and media.content == catalog[2]
        assert media.headers["content-type"] == "image/png"
        assert media.headers["x-content-type-options"] == "nosniff"


@pytest.mark.parametrize("text", ["机器人3.14米。 English sentence! 后续？", "机器人。\n 第二句。尾句", "机器人？！\" Done.", "机器人。" * 64])
def test_sentence_text_roundtrips_exactly(catalog, text):
    with TestClient(create_app(configured(catalog), service=CompletedAnswer(text))) as client:
        data = ask(client).json()
        assert "".join(s["text"] for s in data["presentation"]["sentences"]) == text


@pytest.mark.parametrize("service", [CompletedAnswer(source=None), CompletedAnswer(source="other.md"), CompletedAnswer(text="欢迎参观。"), CompletedAnswer(status="clarify"), CompletedAnswer(text="机器人。" * 65)])
def test_untrusted_nonmatching_or_oversized_answers_keep_legacy_payload(catalog, service):
    with TestClient(create_app(configured(catalog), service=service)) as client:
        assert "presentation" not in ask(client).json()


@pytest.mark.parametrize("changes", [
    {"relative_path": "../secret.png"}, {"relative_path": "C:\\private\\secret.png"},
    {"relative_path": "https://evil.example/image.png"}, {"relative_path": "robot.png:secret"},
    {"sha256": "0" * 64}, {"reviewed": False}, {"reviewed": 1}, {"mime": "image/svg+xml"},
    {"mime": "text/html"}, {"kind": "video"}, {"keywords": []}, {"keywords": [" "]}, {"keywords": ["。"]},
    {"source_url": "javascript:alert(1)"}, {"source_url": "https://user:secret@evil.example"},
    {"id": "../secret"}, {"source_filename": "../guide.md"},
])
def test_unsafe_asset_is_not_served_or_attached(catalog, changes):
    with TestClient(create_app(configured(catalog, **changes), service=CompletedAnswer())) as client:
        assert "presentation" not in ask(client).json()
        response = client.get("/media/robot")
        assert response.status_code == 404
        assert str(catalog[0]) not in response.text


def test_symlink_asset_cannot_escape_root(catalog):
    root, _, _ = catalog
    outside = root.parent / "private-media.png"
    outside.write_bytes(catalog[2])
    try:
        (root / "linked.png").symlink_to(outside)
    except OSError:
        pytest.skip("host lacks symlink privileges")
    with TestClient(create_app(configured(catalog, relative_path="linked.png"), service=CompletedAnswer())) as client:
        assert client.get("/media/robot").status_code == 404
        assert "presentation" not in ask(client).json()


def test_hash_is_rechecked_after_startup_and_recovers(catalog):
    with TestClient(create_app(configured(catalog), service=CompletedAnswer())) as client:
        (catalog[0] / "robot.png").write_bytes(b"changed")
        assert client.get("/media/robot").status_code == 404
        assert "presentation" not in ask(client).json()
        (catalog[0] / "robot.png").write_bytes(catalog[2])
        assert client.get("/media/robot").content == catalog[2]


@pytest.mark.parametrize("manifest", ["{bad json", '{"assets": []}', '{"assets": "bad"}'])
def test_invalid_catalog_does_not_block_answers(catalog, manifest):
    config = configured(catalog)
    (catalog[0] / "manifest.json").write_text(manifest, encoding="utf-8")
    with TestClient(create_app(config, service=CompletedAnswer())) as client:
        response = ask(client)
        assert response.status_code == 200 and response.json()["status"] == "answer"
        assert "presentation" not in response.json()
        assert client.get("/media/robot").status_code == 404


def test_missing_catalog_and_private_config_are_safe(catalog):
    config = configured(catalog)
    (catalog[0] / "manifest.json").unlink()
    with TestClient(create_app(config, service=CompletedAnswer())) as client:
        assert ask(client).status_code == 200
        assert client.get("/ui-config").json() == {"avatar_id": "companion", "tts_voice": "zh-CN-XiaoxiaoNeural"}
        assert str(catalog[0]) not in client.get("/openapi.json").text
        assert client.get("/media/unknown").status_code == 404


def test_disabled_media_never_reads_files_and_preserves_exact_json(monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError("disabled media must not access local files")
    monkeypatch.setattr(Path, "open", forbidden)
    with TestClient(create_app(service=CompletedAnswer())) as client:
        data = ask(client).json()
        assert set(data) == {"visitor_id", "turn_id", "turn_seq", "status", "text", "sources", "error_code"}
        assert data["error_code"] is None
        assert client.get("/media/unknown").status_code == 404


def test_video_get_head_and_byte_ranges(catalog):
    config = configured(catalog, kind="video", mime="video/mp4")
    with TestClient(create_app(config)) as client:
        full = client.get("/media/robot")
        assert full.status_code == 200 and full.content == catalog[2]
        head = client.head("/media/robot")
        assert head.status_code == 200 and head.content == b""
        assert head.headers["content-length"] == str(len(catalog[2]))
        for header, expected in [("bytes=2-5", catalog[2][2:6]), ("bytes=3-", catalog[2][3:]), ("bytes=-4", catalog[2][-4:])]:
            response = client.get("/media/robot", headers={"Range": header})
            assert response.status_code == 206 and response.content == expected
            assert response.headers["content-range"].endswith("/" + str(len(catalog[2])))
        assert client.get("/media/robot", headers={"Range": "bytes=9999-"}).status_code == 416
        assert client.get("/media/robot", headers={"Range": "bytes=0-1,3-4"}).status_code == 416


def test_media_enabled_keeps_existing_error_status_and_json(catalog):
    with TestClient(create_app(configured(catalog))) as client:
        response = ask(client)
        assert response.status_code == 503
        assert response.json()["error_code"] == "service_not_configured"
        assert "presentation" not in response.json()


def test_real_answer_sdk_knowledge_and_media_work_together(catalog, external_services):
    """Only the external KB/model HTTP endpoints are simulated in this full assembly."""
    media_config = configured(catalog, source_filename="opening.md", keywords=["青山展馆"])
    config = AppConfig.model_validate({
        "media": media_config.media.model_dump(),
        "llm": {"enabled": True, "base_url": external_services["url"], "api_key": "offline-fixture"},
        "knowledge": {"base_url": external_services["url"], "kb_id": "offline-kb"},
    })
    external_services["replies"] = [(completion(), "stop")]
    with TestClient(create_app(config)) as client:
        response = client.post("/questions", json={"visitor_id": "assembled", "turn_id": "one", "turn_seq": 1, "question": "青山展馆的开放时间？"})
        assert response.status_code == 200, response.text
        data = response.json()
        assert data["text"] == SHORT
        assert data["sources"][0]["source"]["filename"] == "opening.md"
        assert "".join(s["text"] for s in data["presentation"]["sentences"]) == SHORT
        assert data["presentation"]["sentences"][0]["asset_id"] == "robot"
        assert data["presentation"]["sentences"][1]["asset_id"] is None
        assert client.get("/media/robot").content == catalog[2]


def test_latin_keyword_does_not_match_a_different_word(catalog):
    with TestClient(create_app(configured(catalog, keywords=["car"]), service=CompletedAnswer(text="A cart is available."))) as client:
        assert "presentation" not in ask(client).json()


def test_manifest_cannot_escape_media_root(catalog):
    configured(catalog)
    config = AppConfig.model_validate({"media": {"enabled": True, "root": str(catalog[0]), "manifest": "../manifest.json"}})
    with TestClient(create_app(config, service=CompletedAnswer())) as client:
        assert ask(client).status_code == 200
        assert client.get("/media/robot").status_code == 404


@pytest.mark.parametrize("length, accepted", [(500, True), (501, False)])
def test_alt_length_matches_browser_contract(catalog, length, accepted):
    with TestClient(create_app(configured(catalog, alt="图" * length), service=CompletedAnswer())) as client:
        data = ask(client).json()
        assert ("presentation" in data) is accepted
        assert client.get("/media/robot").status_code == (200 if accepted else 404)
