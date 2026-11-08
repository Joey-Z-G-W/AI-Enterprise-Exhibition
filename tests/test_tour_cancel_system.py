"""Opt-in real worker HTTP/SSE system test for cancel-before-upload queue ordering.
Run with TOUR_LIVE_ORIGIN=http://127.0.0.1:8210 against the local GPU service.
"""
import asyncio
import io
import json
import os
from pathlib import Path
import time
import uuid
import wave

import httpx
import pytest


@pytest.mark.acceptance
def test_cancel_receipt_blocks_later_queued_upload_but_allows_new_segment():
    assert os.getenv("TOUR_LIVE_ORIGIN"), "真实取消验收缺少 TOUR_LIVE_ORIGIN"
    async def run():
        origin = os.environ["TOUR_LIVE_ORIGIN"]
        events = []
        sid = None
        listener = None
        async with httpx.AsyncClient(base_url=origin, timeout=30, trust_env=False) as client:
            async def listen():
                async with client.stream("GET", f"/sessions/{sid}/events", timeout=None) as response:
                    event = ""
                    async for line in response.aiter_lines():
                        if line.startswith("event: "):
                            event = line[7:]
                        if line.startswith("data: "):
                            try:
                                events.append({"event": event, **json.loads(line[6:])})
                            except ValueError:
                                pass
            try:
                response = await client.post("/sessions", json={"avatar_id": "companion", "model": "quicktalk",
                    "tts_provider": "edge", "tts_voice": "zh-CN-XiaoxiaoNeural", "stt_provider": "sensevoice",
                    "agent_enabled": False, "memory_enabled": False, "knowledge_enabled": False})
                response.raise_for_status()
                sid = response.json()["session_id"]
                async with asyncio.timeout(90):
                    while (await client.get(f"/sessions/{sid}")).json()["state"] not in {"worker_ready", "ready"}:
                        await asyncio.sleep(.2)
                listener = asyncio.create_task(listen())
                await asyncio.sleep(.2)
                cancelled = "cancel-before-enqueue-" + uuid.uuid4().hex
                wav = io.BytesIO()
                with wave.open(wav, "wb") as output:
                    output.setnchannels(1); output.setsampwidth(2); output.setframerate(16000)
                    output.writeframes(bytes(6400))
                boundary = "guide-slow-multipart"
                prefix = (f'--{boundary}\r\nContent-Disposition: form-data; name="segment_id"\r\n\r\n{cancelled}\r\n'
                          f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="late.wav"\r\n'
                          'Content-Type: audio/wav\r\n\r\n').encode()
                began, release = asyncio.Event(), asyncio.Event()
                async def slow_body():
                    yield prefix + wav.getvalue()[:100]
                    began.set()
                    await release.wait()
                    yield wav.getvalue()[100:] + f'\r\n--{boundary}--\r\n'.encode()
                pending_upload = asyncio.create_task(client.post(f"/sessions/{sid}/speak_flashtalk_audio",
                    content=slow_body(), headers={"Content-Type": f"multipart/form-data; boundary={boundary}"}))
                await began.wait()
                await asyncio.sleep(.1)
                started = time.monotonic()
                reset = await client.post(f"/sessions/{sid}/webrtc/reset", json={"segment_id": cancelled})
                assert reset.status_code == 200, reset.text
                assert reset.json()["status"] == "receiver_reset"
                reset_ms = (time.monotonic() - started) * 1000
                segment = "control-" + uuid.uuid4().hex
                upload = await client.post(f"/sessions/{sid}/speak_flashtalk_audio",
                    data={"segment_id": segment}, files={"file": ("control.wav", wav.getvalue(), "audio/wav")})
                assert upload.status_code == 200, upload.text
                assert upload.json()["segment_id"] == segment
                async with asyncio.timeout(20):
                    while not any(e.get("segment_id") == segment and e["event"] == "speech.started" for e in events):
                        await asyncio.sleep(.02)
                # The old body finishes only after the new control has actually started.
                release.set()
                late = await pending_upload
                assert late.status_code == 409, late.text
                assert late.json()["detail"] == "GUIDE_SEGMENT_CANCELLED"
                replay = await client.post(f"/sessions/{sid}/speak_flashtalk_audio",
                    data={"segment_id": cancelled}, files={"file": ("old.wav", wav.getvalue(), "audio/wav")})
                assert replay.status_code == 409, replay.text
                async with asyncio.timeout(20):
                    while not any(e.get("segment_id") == segment and e["event"] == "speech.ended" for e in events):
                        await asyncio.sleep(.02)
                assert not any(e.get("segment_id") == cancelled for e in events), events
                result = {"session_id": sid, "cancelled_segment": cancelled, "new_segment": segment,
                    "reset_ms": reset_ms, "probe_elapsed_ms": (time.monotonic() - started) * 1000, "events": events,
                    "assertion": "upload body started before reset, finished after ACK and got 409; replay also 409; new control started before old body finished and completed with its own ended"}
                destination = os.getenv("TOUR_CANCEL_EVIDENCE")
                if destination:
                    Path(destination).write_text(json.dumps(result, ensure_ascii=False, indent=2))
            finally:
                if sid:
                    await client.delete(f"/sessions/{sid}")
                if listener:
                    listener.cancel()
                    await asyncio.gather(listener, return_exceptions=True)
    asyncio.run(run())
