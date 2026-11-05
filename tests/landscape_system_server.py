"""Loopback system fixture: real guide app; only external KB/LLM HTTP are simulated."""
import argparse
import json
from pathlib import Path
import socket

from fastapi import Body
import uvicorn

from exhibition_guide.config import AppConfig
from exhibition_guide.main import create_app
from test_concise_answer_http import completion, external_services


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--media-root", required=True)
    parser.add_argument("--ready", required=True)
    args = parser.parse_args()
    # Reuse the external provider's actual HTTP wire protocol, not a mock of any
    # AnswerService, ContextStore, KnowledgeClient, ModelClient or media method.
    provider = external_services.__wrapped__()
    state = next(provider)
    config = AppConfig.model_validate({
        "llm": {"enabled": True, "base_url": state["url"], "api_key": "system-fixture", "timeout_seconds": 10.0},
        "knowledge": {"base_url": state["url"], "kb_id": "offline-kb"},
        "media": {"enabled": True, "root": args.media_root, "manifest": "manifest.json"},
    })
    app = create_app(config)

    @app.post("/__test/plan")
    def plan(body: dict = Body()):
        if state["replies"]:
            return {"error": "previous external replies not consumed"}
        text = body["text"]
        state["document"] = text
        state["chunks"] = [text]
        if body.get("history"):
            state["replies"].append(({"verdict": "resolved", "question": body["question"]}, "stop"))
        state["replies"].append((completion(text, excerpt=text), "stop"))
        return {"status": "planned"}

    @app.get("/__test/state")
    def snapshot():
        return {"queries": state["queries"], "completions": state["completions"], "remaining_replies": len(state["replies"])}

    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", log_level="warning"))

    @app.post("/__test/shutdown")
    def shutdown():
        server.should_exit = True
        return {"status": "stopping"}

    Path(args.ready).write_text(json.dumps({"url": f"http://127.0.0.1:{listener.getsockname()[1]}"}), encoding="utf-8")
    try:
        server.run(sockets=[listener])
    finally:
        listener.close()
        provider.close()


if __name__ == "__main__":
    main()
