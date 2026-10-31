/*
 * Adapted from OpenTalking apps/web/src/lib/webrtc.ts,
 * commit 8c739a5a6f114daf71aeace832a668c3ad60f536.
 * Apache-2.0; license: ../../licenses/OpenTalking-Apache-2.0.txt.
 * Changes: bounded requests, cancellation, failure cleanup and explicit audio notice.
 */
import { jsonRequest, post, RequestError } from "./api";

export type Playback = { close: () => void };

async function waitUntil(check: () => boolean, signal: AbortSignal, milliseconds: number): Promise<void> {
  const deadline = Date.now() + milliseconds;
  while (!check()) {
    if (signal.aborted) throw new RequestError("cancelled");
    if (Date.now() >= deadline) throw new RequestError("timeout");
    await new Promise((resolve) => window.setTimeout(resolve, 100));
  }
  if (signal.aborted) throw new RequestError("cancelled");
}

export async function startPlayback(
  sessionId: string,
  video: HTMLVideoElement,
  signal: AbortSignal,
  onSoundBlocked: () => void,
  onFailure: () => void,
): Promise<Playback> {
  const config = await jsonRequest<{ iceServers?: RTCIceServer[]; iceTransportPolicy?: RTCIceTransportPolicy }>(
    "/opentalking/sessions/webrtc/ice-config", { signal },
  );
  if (signal.aborted) throw new RequestError("cancelled");
  const pc = new RTCPeerConnection({
    iceServers: Array.isArray(config.iceServers) ? config.iceServers : [],
    iceTransportPolicy: config.iceTransportPolicy === "relay" ? "relay" : "all",
  });
  const stream = new MediaStream();
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    signal.removeEventListener("abort", close);
    pc.close();
    stream.getTracks().forEach((track) => track.stop());
    if (video.srcObject === stream) {
      video.pause();
      video.srcObject = null;
    }
  };
  signal.addEventListener("abort", close, { once: true });
  video.srcObject = stream;
  video.autoplay = true;
  video.playsInline = true;
  video.muted = false;
  const play = async () => {
    try { await video.play(); } catch {
      if (closed) return;
      video.muted = true;
      onSoundBlocked();
      await video.play().catch(() => {});
    }
  };
  pc.ontrack = ({ track }) => {
    if (closed) { track.stop(); return; }
    if (!stream.getTracks().some((item) => item.id === track.id)) stream.addTrack(track);
    void play();
  };
  pc.onconnectionstatechange = () => {
    if (!closed && ["failed", "disconnected", "closed"].includes(pc.connectionState)) onFailure();
  };
  pc.oniceconnectionstatechange = () => {
    if (!closed && ["failed", "disconnected", "closed"].includes(pc.iceConnectionState)) onFailure();
  };
  try {
    pc.addTransceiver("video", { direction: "recvonly" });
    pc.addTransceiver("audio", { direction: "recvonly" });
    await pc.setLocalDescription(await pc.createOffer());
    // Non-trickle offer; use gathered candidates after a bounded collection period.
    await waitUntil(() => pc.iceGatheringState === "complete", signal, 8000).catch((error) => {
      if (!(error instanceof RequestError && error.kind === "timeout")) throw error;
    });
    const answer = await jsonRequest<{ sdp: string; type: RTCSdpType }>(
      `/opentalking/sessions/${encodeURIComponent(sessionId)}/webrtc/offer`,
      post({ sdp: pc.localDescription?.sdp, type: "offer" }, signal), 30000,
    );
    if (signal.aborted) throw new RequestError("cancelled");
    await pc.setRemoteDescription(answer);
    await waitUntil(
      () => pc.connectionState === "connected" && stream.getVideoTracks().length > 0 && stream.getAudioTracks().length > 0,
      signal, 30000,
    );
    void play();
    return { close };
  } catch (error) {
    close();
    throw error;
  }
}
