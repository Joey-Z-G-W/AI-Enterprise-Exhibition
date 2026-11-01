from fastapi.testclient import TestClient

from exhibition_guide.main import create_app
from exhibition_guide.config import AppConfig


def test_health_returns_ok() -> None:
    with TestClient(create_app(AppConfig())) as client:
        response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
