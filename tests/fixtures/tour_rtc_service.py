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


from types import SimpleNamespace

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
if __name__ == '__main__':
    sock=socket.socket();sock.bind(('127.0.0.1',0));sock.listen(128)
    app.state.settings = SimpleNamespace(worker_url='http://127.0.0.1:'+str(sock.getsockname()[1]))
    print('READY '+str(sock.getsockname()[1]),flush=True)
    server=uvicorn.Server(uvicorn.Config(app,log_level='error'))
    asyncio.run(server.serve(sockets=[sock]))
