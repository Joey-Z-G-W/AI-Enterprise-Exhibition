"""Tour HTTP integration: real answer/history/media; only external KB/model HTTP is simulated."""
import hashlib
import json

import pytest
from fastapi.testclient import TestClient

from exhibition_guide.config import AppConfig
from exhibition_guide.main import create_app
from test_concise_answer_http import external_services

SOURCE = "青山展厅采用开放布局。白云展厅采用分区布局。"


@pytest.fixture
def tour_app(tmp_path, external_services, request):
    image = b"reviewed-tour-image"
    (tmp_path / "photo.png").write_bytes(image)
    assets = []
    entries = [("qingshan", "青山展厅", "青山展厅采用开放布局。"), ("baiyun", "白云展厅", "白云展厅采用分区布局。")]
    if getattr(request, "param", None) == "extended":
        entries[1:1] = [("qingshan-second", "青山秋季展位", "青山秋季展位采用竖向布局。")]
        entries += [("ziyun", "紫云展厅", "紫云展厅采用环形布局。"), ("cafe", "SOLAR咖啡店", "SOLAR咖啡店采用两层布局。"), ("services", "锐伽服务", "锐伽提供品牌和空间设计服务。") ]
    source = "".join(e for _, _, e in entries)
    for case, name, evidence in entries:
        assets.append({"id": case, "kind": "image", "relative_path": "photo.png", "sha256": hashlib.sha256(image).hexdigest(), "mime": "image/png", "source_filename": "opening.md", "source_url": "https://fixture.example/tour", "alt": name + "设计效果图", "keywords": [name], "reviewed": True,
            "case_id": case, "case_name": name, "client_id": case.split("-")[0], "aliases": [name[:2]] if case != "cafe" else ["SOLAR", "咖啡店"], "category": "services" if case == "services" else "retail" if case == "cafe" else "exhibition", "angle": "layout", "facts": [{"id": case + "-layout", "text": evidence, "evidence": [evidence]}]})
    (tmp_path / "manifest.json").write_text(json.dumps({"assets": assets}))
    external_services["document"] = source
    external_services["chunks"] = [source]
    config = AppConfig.model_validate({"media": {"enabled": True, "root": str(tmp_path), "manifest": "manifest.json"}, "llm": {"enabled": True, "base_url": external_services["url"], "api_key": "fixture"}, "knowledge": {"base_url": external_services["url"], "kb_id": "offline-kb"}})
    with TestClient(create_app(config)) as client:
        yield client, external_services


def reply(state, case="qingshan", text="先看青山展厅，设计采用开放布局。"):
    state["replies"] = [({"verdict": "sufficient", "sentences": [{"text": text, "fact_ids": [case + "-layout"]}], "quotes": [{"snippet_index": 0, "excerpt": state["document"]}]}, "stop"), ({"grounded": [0], "images": [0]}, "stop")]


def question(client, seq=1, text="介绍一个展厅案例。", visitor="tour"):
    return client.post("/questions", json={"visitor_id": visitor, "turn_id": f"turn-{seq}", "turn_seq": seq, "question": text})


def played(client, seq=1, complete=True, visitor="tour"):
    return client.post(f"/visitors/{visitor}/playback", json={"turn_id": f"turn-{seq}", "turn_seq": seq, "sentence_ids": ["s1"] if complete else [], "completed": complete})


def test_natural_fact_plan_preserves_prose_and_tracks_only_completed_playback(tour_app):
    client, state = tour_app
    reply(state)
    response = question(client)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["text"] == "先看青山展厅，设计采用开放布局。"
    assert body["presentation"]["mode"] == "paragraph"
    assert body["presentation"]["sentences"][0]["asset_id"] == "qingshan"
    assert played(client, complete=False).status_code == 200
    reply(state)
    assert question(client, seq=2).status_code == 200
    assert "青山展厅" in state["queries"][-1]["query"]
    assert played(client, seq=2).status_code == 200
    reply(state, "baiyun", "再看白云展厅，这里的设计采用分区布局。")
    assert question(client, seq=3).status_code == 200
    assert "白云展厅" in state["queries"][-1]["query"]
    assert played(client, seq=3).status_code == 200
    exhausted = question(client, seq=4).json()
    assert "已介绍" in exhausted["text"] and "展厅" in exhausted["text"]
    reply(state)
    assert question(client, visitor="fresh").status_code == 200
    assert "青山展厅" in state["queries"][-1]["query"]


def test_unknown_or_cross_picture_fact_ids_never_select_an_image(tour_app):
    client, state = tour_app
    for seq, facts in enumerate([["made-up"], ["qingshan-layout", "baiyun-layout"]], 1):
        state["replies"] = [({"verdict": "sufficient", "sentences": [{"text": "两个展厅都有各自的布局设计。", "fact_ids": facts}], "quotes": [{"snippet_index": 0, "excerpt": SOURCE}]}, "stop")]
        response = question(client, seq=seq, visitor=f"scope-{seq}")
        assert response.status_code == 200, response.text
        assert response.json()["presentation"]["sentences"][0]["asset_id"] is None


@pytest.mark.parametrize("tour_app", ["extended"], indirect=True)
def test_three_clients_before_same_client_event_and_truthful_category_exhaustion(tour_app):
    client, state = tour_app
    for seq, (case, name) in enumerate([("qingshan", "青山展厅"), ("baiyun", "白云展厅"),
                                      ("ziyun", "紫云展厅"), ("qingshan-second", "青山秋季展位")], 1):
        reply(state, case, name + "有明确的布局设计。")
        assert question(client, seq).status_code == 200
        assert state["queries"][-1]["query"].startswith(name)
        assert played(client, seq).status_code == 200
    assert "已介绍完" in question(client, 5).json()["text"]
    reply(state, "cafe", "SOLAR咖啡店采用两层布局。")
    assert question(client, 6, "介绍咖啡馆案例").status_code == 200
    assert played(client, 6).status_code == 200
    assert "已介绍完" in question(client, 7, "还有别的咖啡馆案例吗").json()["text"]
    assert "青山" not in question(client, 8, "还有别的咖啡馆案例吗").json()["text"]


def test_partial_ordered_receipts_audio_only_memory_and_followup_priority(tour_app):
    client, state = tour_app
    state["replies"] = [({"verdict": "sufficient", "sentences": [
        {"text": "青山展厅采用开放布局。", "fact_ids": ["qingshan-layout"]},
        {"text": "这里的布局是开放的。", "fact_ids": ["qingshan-layout"]}],
        "quotes": [{"snippet_index": 0, "excerpt": SOURCE}]}, "stop"),
        ({"grounded": [0, 1], "images": []}, "stop")]
    body = question(client).json()
    assert all(s["asset_id"] is None for s in body["presentation"]["sentences"])
    def receipt(ids, completed=False, **extra):
        return client.post("/visitors/tour/playback", json={"turn_id": "turn-1", "turn_seq": 1,
            "sentence_ids": ids, "completed": completed, **extra})
    for ids in [["s2"], ["s1", "s1"], ["s9"]]:
        assert receipt(ids).status_code == 409
    assert receipt(["s1"], True).status_code == 409
    assert receipt(["s1"]).status_code == 200
    assert receipt(["s1"]).status_code == 200
    reply(state)
    assert question(client, 2, "这个案例的尺寸是多少").status_code == 200
    assert state["queries"][-1]["query"].startswith("青山展厅")
    assert receipt(["s1", "s2"], True).status_code == 409
    assert played(client, 2, visitor="other").status_code == 409
    assert played(client, 2).status_code == 200
    reply(state)
    assert question(client, 3, "再讲一遍").status_code == 200
    assert state["queries"][-1]["query"].startswith("青山展厅")
    reply(state, "baiyun", "白云展厅采用分区布局。")
    assert question(client, 4, "不要刚才的青山，换一个展厅").status_code == 200
    assert state["queries"][-1]["query"].startswith("白云展厅")


def test_semantic_reviewer_failure_keeps_answer_and_rejects_cross_picture_prose(tour_app):
    client, state = tour_app
    reply(state)
    state["replies"][-1] = ({"grounded": [], "images": []}, "stop")
    body = question(client).json()
    assert body["status"] == "answer" and body["text"] == "先看青山展厅，设计采用开放布局。"
    assert body["presentation"]["sentences"][0]["asset_id"] is None
    assert played(client).json()["completed_cases"] == []
    reply(state)
    state["replies"].pop()  # External reviewer HTTP 500: optional graphics must not fail the answer.
    response = question(client, 2)
    assert response.status_code == 200
    assert response.json()["presentation"]["sentences"][0]["asset_id"] is None


@pytest.mark.parametrize("prompt,expected", [
    ("这个案例不要讲尺寸，讲材料", "青山展厅"),
    ("换成白云案例", "白云展厅"),
    ("除了青山，再讲白云", "白云展厅"),
    ("空间设计案例", "白云展厅"),
])
def test_natural_intent_priority_after_actual_playback(tour_app, prompt, expected):
    client, state = tour_app
    reply(state)
    assert question(client).status_code == 200
    assert played(client).status_code == 200
    reply(state, "baiyun" if expected == "白云展厅" else "qingshan", expected + "有布局设计。")
    assert question(client, 2, prompt).status_code == 200
    assert state["queries"][-1]["query"].startswith(expected)


@pytest.mark.parametrize("tour_app", ["extended"], indirect=True)
def test_service_playback_does_not_pollute_case_category_or_deictic_focus(tour_app):
    client, state = tour_app
    reply(state, "services", "锐伽提供品牌和空间设计服务。")
    assert question(client, text="详细介绍你们的服务").status_code == 200
    assert played(client).json()["completed_cases"] == []
    reply(state)
    result = question(client, 2, "介绍一个案例").json()
    assert result["text"] == "先看青山展厅，设计采用开放布局。"
    assert state["queries"][-1]["query"].startswith("青山展厅")
    assert played(client, 2).status_code == 200
    reply(state, "services", "锐伽提供品牌和空间设计服务。")
    assert question(client, 3, "详细介绍你们的服务").status_code == 200
    assert played(client, 3).status_code == 200
    state["replies"] = [({"verdict": "resolved", "question": "锐伽的服务具体包括什么？"}, "stop"),
        ({"verdict": "sufficient", "answer_text": "锐伽提供品牌和空间设计服务。",
          "quotes": [{"snippet_index": 0, "excerpt": state["document"]}]}, "stop")]
    assert question(client, 4, "这个具体包括什么？").status_code == 200
    assert "青山" not in state["queries"][-1]["query"]


def test_plain_audio_answer_receipt_is_valid_without_claiming_case_memory(tour_app):
    client, state = tour_app
    state["replies"] = [({"verdict": "sufficient", "answer_text": "青山展厅采用开放布局。",
        "quotes": [{"snippet_index": 0, "excerpt": SOURCE}]}, "stop")]
    body = question(client).json()
    assert body["presentation"]["sentences"][0]["asset_id"] is None
    receipt = played(client)
    assert receipt.status_code == 200, receipt.text
    assert receipt.json()["completed_cases"] == []
