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
from test_concise_answer_http import ORIGINAL, SHORT, completion, external_services


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
                  alt="机器人", keywords=["机器人"], reviewed=True,
                  narrations=[{"text": "机器人速度为3.14米。", "evidence": ["机器人"]}])
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
        assert not ask(client).json().get("presentation", {}).get("assets")


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
        assert not ask(client).json().get("presentation", {}).get("assets")
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
        assert not ask(client).json().get("presentation", {}).get("assets")


def test_hash_is_rechecked_after_startup_and_recovers(catalog):
    with TestClient(create_app(configured(catalog), service=CompletedAnswer())) as client:
        (catalog[0] / "robot.png").write_bytes(b"changed")
        assert client.get("/media/robot").status_code == 404
        assert not ask(client).json().get("presentation", {}).get("assets")
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


@pytest.mark.parametrize("mime", ["video/mp4", "video/webm"])
def test_video_catalog_entries_are_rejected(catalog, mime):
    with TestClient(create_app(configured(catalog, kind="video", mime=mime), service=CompletedAnswer())) as client:
        assert not ask(client).json().get("presentation", {}).get("assets")
        assert client.get("/media/robot").status_code == 404
        assert client.head("/media/robot").status_code == 404


def test_image_get_and_head_ignore_video_range_requests(catalog):
    config = configured(catalog)
    with TestClient(create_app(config)) as client:
        full = client.get("/media/robot")
        assert full.status_code == 200 and full.content == catalog[2]
        head = client.head("/media/robot")
        assert head.status_code == 200 and head.content == b""
        assert head.headers["content-length"] == str(len(catalog[2]))
        for header in ["bytes=2-5", "bytes=3-", "bytes=-4"]:
            response = client.get("/media/robot", headers={"Range": header})
            assert response.status_code == 200 and response.content == catalog[2]
            assert "content-range" not in response.headers
        assert "accept-ranges" not in full.headers


def test_media_enabled_keeps_existing_error_status_and_json(catalog):
    with TestClient(create_app(configured(catalog))) as client:
        response = ask(client)
        assert response.status_code == 503
        assert response.json()["error_code"] == "service_not_configured"
        assert "presentation" not in response.json()


def test_real_answer_sdk_knowledge_and_media_work_together(catalog, external_services):
    """Only the external KB/model HTTP endpoints are simulated in this full assembly."""
    media_config = configured(catalog, source_filename="opening.md", keywords=["青山展馆"],
                              narrations=[{"text": SHORT.split("。")[0] + "。", "evidence": [ORIGINAL]}])
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
        assert not ask(client).json().get("presentation", {}).get("assets")


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
        assert bool(data.get("presentation", {}).get("assets")) is accepted
        assert client.get("/media/robot").status_code == (200 if accepted else 404)


def test_mixed_claim_sentence_cannot_attach_first_keyword_image(catalog):
    text = "机器人速度为3.14米，同时咖啡店采用木质装修。"
    with TestClient(create_app(configured(catalog), service=CompletedAnswer(text))) as client:
        data = ask(client).json()
        assert data["text"] == text
        assert not any(s["asset_id"] for s in data.get("presentation", {}).get("sentences", []))


def test_all_missing_images_preserve_every_sentence(catalog):
    with TestClient(create_app(configured(catalog), service=CompletedAnswer())) as client:
        (catalog[0] / "robot.png").unlink()
        data = ask(client).json()
        assert [s["text"] for s in data["presentation"]["sentences"]] == ["机器人速度为3.14米。", "欢迎参观！"]
        assert [s["asset_id"] for s in data["presentation"]["sentences"]] == [None, None]


def test_same_reviewed_text_requires_current_source_evidence(catalog):
    config = configured(catalog, narrations=[{"text": "机器人速度为3.14米。", "evidence": ["已核验的速度依据"]}])
    with TestClient(create_app(config, service=CompletedAnswer())) as client:
        assert not ask(client).json()["presentation"]["assets"]


def test_verified_snapshot_binds_short_quote_and_survives_replay_without_leaking(catalog, external_services):
    media_config = configured(catalog, source_filename="opening.md", narrations=[
        {"text": SHORT.split("。")[0] + "。", "evidence": [ORIGINAL]},
    ])
    config = AppConfig.model_validate({
        "media": media_config.media.model_dump(),
        "llm": {"enabled": True, "base_url": external_services["url"], "api_key": "offline-fixture"},
        "knowledge": {"base_url": external_services["url"], "kb_id": "offline-kb"},
    })
    external_services["replies"] = [(completion(excerpt="青山展馆"), "stop")]
    body = {"visitor_id": "snapshot", "turn_id": "one", "turn_seq": 1, "question": "开放时间？"}
    with TestClient(create_app(config)) as client:
        first = client.post("/questions", json=body)
        assert first.status_code == 200
        data = first.json()
        assert data["presentation"]["sentences"][0]["asset_id"] == "robot"
        assert data["sources"][0]["excerpt"] == "青山展馆"
        assert "_verified_snippets" not in first.text and ORIGINAL not in first.text
        assert "_verified_snippets" not in client.get("/openapi.json").text
        assert client.post("/questions", json=body).json() == data
        assert len(external_services["completions"]) == 1
        # Another item in the same file is not licensed by the quoted filename.
        external_services["replies"] = [(completion("青山展馆和咖啡店都已开放。", excerpt="青山展馆"), "stop")]
        other = client.post("/questions", json={**body, "visitor_id": "other"}).json()
        assert not other["presentation"]["assets"]
        # The archived wording alone cannot supply evidence missing this turn.
        external_services["chunks"] = ["青山展馆不提供免费停车服务。"]
        external_services["replies"] = [(completion(excerpt="青山展馆"), "stop")]
        unsupported = client.post("/questions", json={**body, "visitor_id": "unsupported"}).json()
        assert not unsupported["presentation"]["assets"]


def test_structured_sentence_ids_build_one_canonical_answer_before_history(catalog, external_services):
    root, record, _ = catalog
    first = SHORT.split("。")[0] + "。"
    last = "节假日安排另行通知。"
    entries = [
        {**record, "source_filename": "opening.md", "narrations": [{"text": first, "evidence": [ORIGINAL]}]},
        {**record, "id": "holiday", "source_filename": "opening.md", "narrations": [{"text": last, "evidence": [last]}]},
    ]
    (root / "manifest.json").write_text(json.dumps({"assets": entries}), encoding="utf-8")
    config = AppConfig.model_validate({
        "media": {"enabled": True, "root": str(root), "manifest": "manifest.json"},
        "llm": {"enabled": True, "base_url": external_services["url"], "api_key": "offline-fixture"},
        "knowledge": {"base_url": external_services["url"], "kb_id": "offline-kb"},
    })
    structured = {"verdict": "sufficient", "sentences": [{"narration_id": "robot:1"}, {"narration_id": "holiday:1"}],
                  "quotes": [{"snippet_index": 0, "excerpt": "青山展馆"}]}
    external_services["replies"] = [(structured, "stop"), ({"verdict": "resolved", "question": "青山展馆何时开放？"}, "stop"), (completion(), "stop")]
    body = {"visitor_id": "planned", "turn_id": "one", "turn_seq": 1, "question": "开放安排？"}
    with TestClient(create_app(config)) as client:
        response = client.post("/questions", json=body)
        assert response.status_code == 200, response.text
        data = response.json()
        assert data["text"] == first + last == SHORT
        assert [s["asset_id"] for s in data["presentation"]["sentences"]] == ["robot", "holiday"]
        assert "".join(s["text"] for s in data["presentation"]["sentences"]) == data["text"]
        assert client.post("/questions", json=body).json() == data
        followup = client.post("/questions", json={**body, "turn_id": "two", "turn_seq": 2, "question": "它何时开放？"})
        assert followup.status_code == 200
        rewrite = json.loads(external_services["completions"][1]["messages"][1]["content"])
        assert rewrite["history"] == [{"question": body["question"], "answer": SHORT}]
        for parts in [[{"narration_id": "not-a-reviewed-id"}], [{"narration_id": "robot:1", "text": "不能同时提交。"}], [{"text": "第一句。第二句。"}]]:
            external_services["replies"] = [({**structured, "sentences": parts}, "stop")]
            invalid = client.post("/questions", json={**body, "visitor_id": str(parts)})
            assert invalid.status_code == 502
            assert invalid.json()["error_code"] == "invalid_model_response"
