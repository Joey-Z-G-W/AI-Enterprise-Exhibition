"""Configuration tests use only explicit temporary paths and fake credentials."""

from pathlib import Path
import traceback

import pytest
from pydantic import ValidationError

from exhibition_guide.config import AppConfig, AvatarConfig, ConfigError, load_config


def write_config(tmp_path, text):
    path = tmp_path / "input.toml"
    path.write_text(text, encoding="utf-8")
    return path


def test_missing_file_and_public_example_are_unconfigured(tmp_path):
    missing = load_config(tmp_path / "missing.toml")
    example = load_config(Path(__file__).parents[1] / "config/example.toml")
    assert missing == example
    assert not example.llm.enabled and not example.embedding.enabled
    assert example.llm.api_key.get_secret_value() == ""
    assert example.knowledge.kb_id == ""
    assert example.avatar.tts_voice == "zh-CN-XiaoxiaoNeural"


def test_independent_credentials_and_explicit_fields(tmp_path):
    path = write_config(tmp_path, '''
[llm]
enabled = true
api_key = "fake-llm-secret"
timeout_seconds = 12.5
[embedding]
enabled = true
api_key = "fake-embedding-secret"
base_url = "http://localhost:8222/v1/"
dimensions = 512
[knowledge]
kb_id = "kb_demo"
[avatar]
avatar_id = "custom_demo"
tts_voice = "custom-voice"
''')
    config = load_config(path)
    assert config.llm.api_key.get_secret_value() == "fake-llm-secret"
    assert config.embedding.api_key.get_secret_value() == "fake-embedding-secret"
    assert config.embedding.base_url == "http://localhost:8222/v1"
    assert config.llm.timeout_seconds == 12.5
    assert config.knowledge.kb_id == "kb_demo"
    assert config.avatar.avatar_id == "custom_demo"
    assert config.avatar.tts_voice == "custom-voice"
    for output in (str(config), repr(config), str(config.model_dump()), config.model_dump_json()):
        assert "fake-llm-secret" not in output
        assert "fake-embedding-secret" not in output


@pytest.mark.parametrize("body", [
    '[llm]\nenabled = true',
    '[llm]\nenabled = true\napi_key = "   "',
    '[llm]\nenabled = true\napi_key = "fake-secret"\n[embedding]\nenabled = true',
    '[llm]\napi_key = { nested = "fake-secret" }',
    '[llm]\napi_key = ["fake-secret"]',
    '[llm]\nbase_url = "https://fake-secret@example.com"',
    '[llm]\nbase_url = "https://example.com/?key=fake-secret"',
    '[llm]\nbase_url = "file:///fake-secret"',
    '[llm]\nmodel = " "\napi_key = "fake-secret"',
    '[llm]\ntimeout_seconds = nan\napi_key = "fake-secret"',
    '[llm]\ntimeout_seconds = 0\napi_key = "fake-secret"',
    '[embedding]\ndimensions = -1\napi_key = "fake-secret"',
    '[embedding]\ndimensions = "512"\napi_key = "fake-secret"',
    '[avatar]\navatar_id = " "\n[llm]\napi_key = "fake-secret"',
    '[avatar]\ntts_voice = " "\n[llm]\napi_key = "fake-secret"',
    '[avatar]\ntts_voice = "' + 'v' * 129 + '"\n[llm]\napi_key = "fake-secret"',
    '[knowledge]\nkb_id = "invalid id"\n[llm]\napi_key = "fake-secret"',
    '[llm]\nunknown = "fake-secret"',
    '[llm]\napi_key = "fake-secret"\nthis is invalid',
])
def test_invalid_configuration_never_exposes_input(tmp_path, body, caplog):
    with pytest.raises(ConfigError) as caught:
        load_config(write_config(tmp_path, body))
    output = "".join(traceback.format_exception(caught.value))
    assert "fake-secret" not in output + str(caught.value) + repr(caught.value) + caplog.text
    assert caught.value.__suppress_context__


def test_direct_model_validation_error_display_hides_bad_secret():
    with pytest.raises(ValidationError) as caught:
        AppConfig.model_validate({"llm": {"api_key": {"value": "fake-secret"}}})
    assert "fake-secret" not in str(caught.value)
    assert "fake-secret" not in repr(caught.value)


def test_unreadable_path_is_safe(tmp_path):
    with pytest.raises(ConfigError, match="cannot be read"):
        load_config(tmp_path)


def test_invalid_utf8_is_safe(tmp_path):
    path = tmp_path / "input.toml"
    path.write_bytes(b'api_key="fake-secret"\xff')
    with pytest.raises(ConfigError, match="UTF-8 TOML"):
        load_config(path)


@pytest.mark.parametrize("field", ["avatar_id", "tts_voice"])
@pytest.mark.parametrize("value", ["", " ", " voice", "voice ", "two voices", "voice\n", "\t", "v" * 129, 123, None])
def test_avatar_pair_rejects_invalid_values(field, value):
    with pytest.raises(ValidationError):
        AvatarConfig.model_validate({field: value})


@pytest.mark.parametrize("length", [1, 128])
def test_avatar_pair_accepts_length_boundaries(length):
    pair = AvatarConfig(avatar_id="a" * length, tts_voice="v" * length)
    assert len(pair.avatar_id) == len(pair.tts_voice) == length
