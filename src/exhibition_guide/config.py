"""Local TOML configuration; loading never contacts a service or logs credentials."""

from __future__ import annotations

from pathlib import Path
import tomllib
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, SecretStr, ValidationError, field_validator, model_validator


class ConfigError(ValueError):
    """Safe public error containing no file contents or validation input."""


class _ConfigModel(BaseModel):
    model_config = ConfigDict(
        strict=True, extra="forbid", hide_input_in_errors=True,
        frozen=True, validate_default=True,
    )


def _endpoint(value: str) -> str:
    try:
        url = urlsplit(value)
        valid = (
            value == value.strip() and not any(char.isspace() for char in value)
            and url.scheme in {"http", "https"} and bool(url.hostname)
            and url.username is None and url.password is None
            and not url.query and not url.fragment
        )
        _ = url.port
    except ValueError:
        valid = False
    if not valid:
        raise ValueError("must be an HTTP(S) endpoint without credentials, query or fragment")
    return value.rstrip("/")


class ModelConfig(_ConfigModel):
    enabled: bool = False
    base_url: str = "https://api.deepseek.com"
    model: str = "deepseek-flash"
    api_key: SecretStr = Field(default_factory=lambda: SecretStr(""), repr=False)
    timeout_seconds: float = Field(default=30.0, gt=0, le=300, allow_inf_nan=False)

    _valid_endpoint = field_validator("base_url")(_endpoint)

    @field_validator("model")
    @classmethod
    def valid_model(cls, value: str) -> str:
        if not value.strip() or value != value.strip():
            raise ValueError("model must be nonblank without surrounding whitespace")
        return value

    @model_validator(mode="after")
    def enabled_requires_key(self) -> ModelConfig:
        key = self.api_key.get_secret_value()
        if self.enabled and (not key.strip() or key != key.strip()):
            raise ValueError("enabled service requires a nonblank API key without surrounding whitespace")
        return self


class EmbeddingConfig(ModelConfig):
    base_url: str = "http://127.0.0.1:8220/v1"
    model: str = "BAAI/bge-small-zh-v1.5"
    dimensions: int = Field(default=512, gt=0, le=65536)


class KnowledgeConfig(_ConfigModel):
    base_url: str = "http://127.0.0.1:8210"
    kb_id: str = Field(default="", max_length=128)

    _valid_endpoint = field_validator("base_url")(_endpoint)

    @field_validator("kb_id")
    @classmethod
    def valid_id(cls, value: str) -> str:
        if value != value.strip() or any(char.isspace() for char in value):
            raise ValueError("knowledge base ID must not contain whitespace")
        return value


class AvatarConfig(_ConfigModel):
    avatar_id: str = Field(default="companion", min_length=1, max_length=128)

    @field_validator("avatar_id")
    @classmethod
    def valid_id(cls, value: str) -> str:
        if not value.strip() or any(char.isspace() for char in value):
            raise ValueError("avatar ID must be nonblank without whitespace")
        return value


class AppConfig(_ConfigModel):
    llm: ModelConfig = Field(default_factory=ModelConfig)
    embedding: EmbeddingConfig = Field(default_factory=EmbeddingConfig)
    knowledge: KnowledgeConfig = Field(default_factory=KnowledgeConfig)
    avatar: AvatarConfig = Field(default_factory=AvatarConfig)


def load_config(path: str | Path = Path("config/local.toml")) -> AppConfig:
    """Read an explicit path (default relative to service working directory).

    A missing file means unconfigured. Invalid existing files fail closed with a
    safe message; callers must not expose raw TOML or Pydantic error inputs.
    """
    try:
        with Path(path).open("rb") as stream:
            data = tomllib.load(stream)
    except FileNotFoundError:
        return AppConfig()
    except (tomllib.TOMLDecodeError, UnicodeError):
        raise ConfigError("Configuration is not valid UTF-8 TOML") from None
    except OSError:
        raise ConfigError("Configuration cannot be read") from None
    try:
        return AppConfig.model_validate(data)
    except ValidationError:
        raise ConfigError("Configuration fields are invalid") from None
