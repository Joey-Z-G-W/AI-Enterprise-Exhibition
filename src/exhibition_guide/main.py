"""Independent application and process health endpoint."""

from fastapi import FastAPI

app = FastAPI(title="Exhibition Guide")


@app.get("/health")
def health() -> dict[str, str]:
    """Report process health without checking upstream services."""
    return {"status": "ok"}
