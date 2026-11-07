"""External media service for the real aiortc/Chromium protocol integration.
The model boundary emits deterministic paired PCM/video through the real program manager.
"""
import asyncio
import socket
import os
import imageio_ffmpeg
os.environ.setdefault("OPENTALKING_FFMPEG_BIN", imageio_ffmpeg.get_ffmpeg_exe())
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'vendor/opentalking'))
import numpy as np
import uvicorn
from fastapi import FastAPI
from opentalking.core.types.frames import VideoFrameData
from opentalking.providers.rtc.aiortc.adapter import WebRTCSession
from opentalking.streaming.manager import ProgramOutputManager
from apps.api.routes.tts_preview import router

app = FastAPI()
app.include_router(router)
peers = []
tasks = []

@app.post('/offer')
async def offer(body: dict):
    peer = WebRTCSession(fps=25, sample_rate=16000)
    peers.append(peer)
    program = ProgramOutputManager(fps=25, sample_rate=16000, audio_tick_ms=20,
                                   max_video_frames=100, max_audio_ticks=200)
    async def video(item):
        await peer.video.put(VideoFrameData(item.data, item.width, item.height, item.timestamp_ms,
                                           item.guide_segment_id, item.guide_source_ms))
    async def audio(item):
        await peer.audio.put_pcm(item.data)
    program.add_branch('browser', video_callback=video, audio_callback=audio)
    answer = await peer.handle_offer(body['sdp'], body['type'])
    async def produce():
        while peer.pc.connectionState != 'connected':
            await asyncio.sleep(.02)
        await asyncio.sleep(.3)
        for i in range(125):
            frame = np.full((64,64,3), (i*2)%255, dtype=np.uint8)
            await program.offer_video(VideoFrameData(frame,64,64,i*40,'paragraph-fixture',i*40))
            samples = np.arange(640) + i*640
            pcm = (np.sin(samples * 2*np.pi*440/16000)*8000).astype(np.int16) if i >= 10 else np.zeros(640,dtype=np.int16)
            await program.offer_audio(pcm, sample_rate=16000)
            await asyncio.sleep(.04)
    tasks.append(asyncio.create_task(produce()))
    return {'sdp':answer.sdp,'type':answer.type}

@app.on_event('shutdown')
async def shutdown():
    for task in tasks:task.cancel()
    await asyncio.gather(*tasks,return_exceptions=True)
    for peer in peers:await peer.close()


# Model boundary substitution: deliberately non-cancellable native inference.
from types import SimpleNamespace
import threading
import time
from fastapi import HTTPException
from opentalking.providers.synthesis.audio2video_client import LocalAudio2VideoClient
native = {}
class DelayedModel:
    model_type = "fixture"
    def __init__(self, delay):
        self.delay = delay; self.running = threading.Event(); self.ended = False; self.loads = []
    def load_model(self, device):
        self.loads.append({"at": time.monotonic(), "old_running": self.running.is_set()})
    def load_avatar(self, path):
        return SimpleNamespace(extra={}, manifest=SimpleNamespace(fps=25, width=64, height=64, sample_rate=16000))
    def extract_features(self, chunk):
        return SimpleNamespace(vector=np.zeros((1,1)), frame_count=1)
    def infer(self, features, state):
        self.running.set(); time.sleep(self.delay); self.running.clear(); self.ended = True
        return [np.zeros((64,64,3),dtype=np.uint8)]
    def compose_frame(self, state, index, prediction):
        return VideoFrameData(prediction,64,64,index*40)

@app.post('/native/start')
async def native_start(body: dict):
    model = DelayedModel(body['delay'])
    client = LocalAudio2VideoClient(model, device='cpu')
    await client.init_session(avatar_path='fixture')
    task = asyncio.create_task(client.generate(np.zeros(640,dtype=np.int16)))
    native.update(model=model,client=client,task=task)
    while not model.running.is_set():await asyncio.sleep(.005)
    return {'started': True}

@app.post('/native/reset')
async def native_reset():
    native['task'].cancel()
    await asyncio.gather(native['task'],return_exceptions=True)
    start = time.monotonic()
    try:
        await native['client'].close()
    except TimeoutError:
        raise HTTPException(status_code=503, detail='native producer not stopped')
    await native['client'].connect()
    await native['client'].init_session(avatar_path='fixture')
    return {'elapsed_ms':(time.monotonic()-start)*1000,'ended':native['model'].ended,'loads':native['model'].loads}

@app.get('/native/status')
async def native_status():
    return {'running':native['model'].running.is_set(),'loads':native['model'].loads}


@app.post('/program/reset-audio')
async def reset_program_audio(body: dict):
    program = ProgramOutputManager(sample_rate=48000, audio_tick_ms=20)
    async def old_audio(item):
        await asyncio.sleep(.01)
    program.add_branch('receiver', audio_callback=old_audio)
    await program.offer_audio(np.full(640,15000,dtype=np.int16), sample_rate=16000)
    await program.detach_branch('receiver')
    if body['reset']:
        program.reset_audio_processing()
    captured = []
    async def new_audio(item):
        captured.append(item.data)
    program.add_branch('receiver', audio_callback=new_audio)
    await program.offer_audio(np.zeros(640,dtype=np.int16), sample_rate=16000)
    for _ in range(20):
        if captured:break
        await asyncio.sleep(.01)
    peak = int(np.max(np.abs(np.concatenate(captured))))
    await program.close()
    return {'peak':peak}


# Real public upload/reset routes, real single-process store; only remote worker
# HTTP is substituted for this API contract check (the live test covers the worker).
from apps.api.routes.sessions import router as session_router
from opentalking.core.in_memory_redis import InMemoryRedis
from opentalking.core.session_store import session_key
app.include_router(session_router)
app.state.redis = InMemoryRedis()
@app.on_event('startup')
async def seed_api_session():
    await app.state.redis.hset(session_key('fixture'), mapping={'session_id':'fixture','model':'quicktalk','state':'ready'})
@app.post('/webrtc/{session_id}/reset')
async def external_worker_reset(session_id: str, body: dict):
    return {'session_id':session_id,'status':'receiver_reset','generation':'fixture-generation'}
@app.get('/tasks')
async def queued_tasks():
    import json
    tasks = []
    while not app.state.redis.task_queue.empty():
        tasks.append(json.loads(app.state.redis.task_queue.get_nowait()))
    return {'tasks':tasks}

if __name__ == '__main__':
    sock=socket.socket();sock.bind(('127.0.0.1',0));sock.listen(128)
    app.state.settings = SimpleNamespace(worker_url='http://127.0.0.1:'+str(sock.getsockname()[1]))
    print('READY '+str(sock.getsockname()[1]),flush=True)
    server=uvicorn.Server(uvicorn.Config(app,log_level='error'))
    asyncio.run(server.serve(sockets=[sock]))
