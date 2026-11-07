/*
 * Adapted from OpenTalking apps/web/src/lib/webrtc.ts,
 * commit 8c739a5a6f114daf71aeace832a668c3ad60f536.
 * Apache-2.0; license: ../../licenses/OpenTalking-Apache-2.0.txt.
 * Changes: bounded negotiation, cancellation, media progress and explicit audio notice.
 */
import { jsonRequest, post, RequestError } from "./api";
import { createReceiverClock, type ReceiverClock } from "./receiverClock";

import { createParagraphClock, type ParagraphClock } from "./paragraphClock";
export type Playback = { close: () => void; isolate: () => void; receiver?: ReceiverClock; timeline?: ParagraphClock };

function waitUntil(check: () => boolean, signal: AbortSignal, milliseconds: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = performance.now() + milliseconds;
    let timer: number | undefined;
    const finish = (error?: RequestError) => {
      window.clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      if (error) reject(error); else resolve();
    };
    const cancel = () => finish(new RequestError("cancelled"));
    const poll = () => {
      if (signal.aborted) cancel();
      else if (check()) finish();
      else if (performance.now() >= deadline) finish(new RequestError("timeout"));
      else timer = window.setTimeout(poll, 100);
    };
    signal.addEventListener("abort", cancel, { once: true });
    poll();
  });
}

export async function startPlayback(
  sessionId: string,
  video: HTMLVideoElement,
  signal: AbortSignal,
  onSoundBlocked: () => void,
  onFailure: () => void,
  negotiationMs = 60000,
): Promise<Playback> {
  if (signal.aborted) throw new RequestError("cancelled");
  const lifetime = new AbortController();
  const stream = new MediaStream();
  let pc: RTCPeerConnection | undefined;
  let closed = false;
  let receiver: ReceiverClock | undefined;
  const timeline = createParagraphClock(video);
  const isolate = () => {
    video.muted = true; video.pause(); video.srcObject = null; timeline.cancel(); receiver?.cancel();
    window.clearInterval(progressTimer);
    if (pc) { pc.onconnectionstatechange = null; pc.oniceconnectionstatechange = null; }
  };
  let cancellation = new RequestError("cancelled");
  let negotiationTimer: number | undefined;
  let progressTimer: number | undefined;
  let frameCallback: number | undefined;
  let seenFrame = false;
  let lastProgress = performance.now();
  const resumeObservation = () => { lastProgress = performance.now(); };
  const close = () => {
    if (closed) return;
    closed = true;
    signal.removeEventListener("abort", close);
    document.removeEventListener("visibilitychange", resumeObservation);
    window.clearTimeout(negotiationTimer);
    window.clearInterval(progressTimer);
    if (frameCallback !== undefined) video.cancelVideoFrameCallback(frameCallback);
    lifetime.abort();
    receiver?.close();
    timeline.close();
    if (pc) {
      pc.ontrack = null;
      pc.onconnectionstatechange = null;
      pc.oniceconnectionstatechange = null;
      pc.close();
    }
    stream.getTracks().forEach((track) => track.stop());
    if (video.srcObject === stream) {
      video.pause();
      video.srcObject = null;
    }
  };
  const fail = () => {
    if (closed) return;
    close();
    onFailure();
  };
  // Browser WebRTC promises are not abortable: reject our waiter and close the PC.
  // The attached handlers also consume any eventual late resolution/rejection.
  const guarded = <T,>(operation: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
    const cancel = () => reject(cancellation);
    lifetime.signal.addEventListener("abort", cancel, { once: true });
    operation.then(resolve, reject).finally(() => lifetime.signal.removeEventListener("abort", cancel));
    if (lifetime.signal.aborted) cancel();
  });
  signal.addEventListener("abort", close, { once: true });
  // One deadline covers configuration, browser promises, ICE, offer HTTP and connection.
  negotiationTimer = window.setTimeout(() => {
    cancellation = new RequestError("timeout");
    close();
  }, negotiationMs);
  try {
    const config = await guarded(jsonRequest<{ iceServers?: RTCIceServer[]; iceTransportPolicy?: RTCIceTransportPolicy }>(
      "/opentalking/sessions/webrtc/ice-config", { signal: lifetime.signal },
    ));
    if (closed) throw cancellation;
    pc = new RTCPeerConnection({
      iceServers: Array.isArray(config.iceServers) ? config.iceServers : [],
      iceTransportPolicy: config.iceTransportPolicy === "relay" ? "relay" : "all",
    });
    const peer = pc;
    if (typeof peer.createDataChannel === "function") {
      const channel = peer.createDataChannel("guide-timeline", { ordered: true });
      channel.onopen = () => channel.send("capabilities");
      channel.onmessage = event => { try { timeline.message(JSON.parse(event.data)); } catch { /* Invalid sideband never advances playback. */ } };
    }
    video.srcObject = stream;
    video.autoplay = true;
    video.playsInline = true;
    video.muted = false;
    const play = async () => {
      try { await video.play(); } catch {
        if (closed) return;
        video.muted = true;
        onSoundBlocked();
        if (!closed) await video.play().catch(() => {});
      }
    };
    peer.ontrack = ({ track }) => {
      if (closed) { track.stop(); return; }
      if (!stream.getTracks().some((item) => item.id === track.id)) stream.addTrack(track);
      void play();
    };
    peer.onconnectionstatechange = () => {
      if (["failed", "disconnected", "closed"].includes(peer.connectionState)) fail();
    };
    peer.oniceconnectionstatechange = () => {
      if (["failed", "disconnected", "closed"].includes(peer.iceConnectionState)) fail();
    };
    peer.addTransceiver("video", { direction: "recvonly" });
    peer.addTransceiver("audio", { direction: "recvonly" });
    const offer = await guarded(peer.createOffer());
    if (closed) throw cancellation;
    await guarded(peer.setLocalDescription(offer));
    if (closed) throw cancellation;
    // Non-trickle offer: bounded candidate collection stays within the total deadline.
    await guarded(waitUntil(() => peer.iceGatheringState === "complete", lifetime.signal, 8000).catch((error) => {
      if (!(error instanceof RequestError && error.kind === "timeout")) throw error;
    }));
    if (closed) throw cancellation;
    const answer = await guarded(jsonRequest<{ sdp: string; type: RTCSdpType }>(
      `/opentalking/sessions/${encodeURIComponent(sessionId)}/webrtc/offer`,
      post({ sdp: peer.localDescription?.sdp, type: "offer" }, lifetime.signal), 30000,
    ));
    if (closed) throw cancellation;
    await guarded(peer.setRemoteDescription(answer));
    if (closed) throw cancellation;
    await guarded(waitUntil(
      () => peer.connectionState === "connected" && stream.getVideoTracks().length > 0 && stream.getAudioTracks().length > 0,
      lifetime.signal, 30000,
    ));
    if (closed) throw cancellation;
    window.clearTimeout(negotiationTimer);
    try { receiver = createReceiverClock(stream, video); } catch { /* No confirmed receiver clock: presentation stays black. */ }
    // Idle avatars still deliver frames; silence is not a failure. Prefer presented
    // video frames, then decoded frame count, then ready video playback time.
    let previousProgress = video.getVideoPlaybackQuality?.().totalVideoFrames ?? video.currentTime;
    const presented = (_now: number, metadata: VideoFrameCallbackMetadata) => {
      if (closed) return;
      timeline.presented((metadata as VideoFrameCallbackMetadata & { rtpTimestamp?: number }).rtpTimestamp);
      seenFrame = true;
      lastProgress = performance.now();
      frameCallback = video.requestVideoFrameCallback(presented);
    };
    if (typeof video.requestVideoFrameCallback === "function") {
      frameCallback = video.requestVideoFrameCallback(presented);
    }
    lastProgress = performance.now();
    document.addEventListener("visibilitychange", resumeObservation);
    progressTimer = window.setInterval(() => {
      // Background suspension is not proof of healthy playback. Resume with a
      // fresh bounded observation window; do not falsely disconnect hidden tabs.
      if (document.hidden || closed) return;
      if (typeof video.requestVideoFrameCallback !== "function") {
        const progress = video.getVideoPlaybackQuality?.().totalVideoFrames ?? video.currentTime;
        if (video.readyState >= 2 && !video.paused && progress > previousProgress) {
          seenFrame = true;
          lastProgress = performance.now();
        }
        previousProgress = progress;
      }
      // Muted autoplay is attempted above. If even that is blocked, no frames
      // still ends in the existing failure UI; a pending play() cannot hang us.
      if (performance.now() - lastProgress >= (seenFrame ? 10000 : 15000)) fail();
    }, 500);
    void play();
    return { close, isolate, receiver, timeline };
  } catch (error) {
    close();
    throw error;
  }
}
