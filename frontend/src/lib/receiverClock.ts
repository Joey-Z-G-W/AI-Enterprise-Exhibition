export type ReceiverClock = ReturnType<typeof createReceiverClock>;
// Observe the received stream without connecting it to an output (no duplicate sound).
// This proves receiver activity, not acoustic speaker output or segment identity in SSE.
export function createReceiverClock(stream: MediaStream, video: HTMLVideoElement) {
  const context = new AudioContext();
  let source: MediaStreamAudioSourceNode;
  try { source = context.createMediaStreamSource(stream); }
  catch (error) { void context.close().catch(() => {}); throw error; }
  const analyser = context.createAnalyser();
  analyser.fftSize = 512; source.connect(analyser);
  const samples = new Float32Array(analyser.fftSize);
  let quietSince = context.currentTime, active = false, closed = false;
  let arm: { duration: number; signalled: boolean; eligible: boolean; start?: number; cued?: boolean; endedAt?: number; lossNotified?: boolean;
    onStart: () => void; onEnd: () => void; onUnavailable: (mayUseServerCompletion: boolean) => void } | undefined;
  const cueIfConfirmed = () => {
    // Both arrival orders are possible. Only join a server signal to a recent,
    // still-active receiver onset; never substitute SSE time for audio time.
    if (arm && !arm.cued && arm.signalled && arm.eligible && arm.start !== undefined
      && active && context.state === "running" && context.currentTime - arm.start <= .5
      && !video.paused && !video.muted && video.volume > 0) {
      arm.cued = true; arm.onStart();
    }
  };
  const checkUnavailable = () => {
    if (!arm) return;
    if (context.state !== "running" && !arm.lossNotified) {
      arm.lossNotified = true; arm.onUnavailable(false);
    }
    // This is explicitly an optional-observer failure, never a claim that the
    // receiver drained. Fall back only after server ended and a bounded grace.
    // While real activity remains observable it always wins over this deadline.
    const grace = Math.min(10000, Math.max(1500, arm.duration * 1000 + 500));
    if (arm.endedAt !== undefined && performance.now() - arm.endedAt >= grace
      && (context.state !== "running" || !active)) {
      const unavailable = arm; arm = undefined; unavailable.onUnavailable(true);
    }
  };
  const timer = window.setInterval(() => {
    if (closed) return;
    if (context.state !== "running") { checkUnavailable(); return; }
    analyser.getFloatTimeDomainData(samples);
    let power = 0; for (const sample of samples) power += sample * sample;
    const audible = Math.sqrt(power / samples.length) > .006, now = context.currentTime;
    if (audible && !active) {
      if (arm && arm.start === undefined) {
        arm.start = now;
      }
    }
    if (!audible && active) quietSince = now;
    active = audible;
    cueIfConfirmed();
    if (arm?.start !== undefined && now - arm.start >= arm.duration && !active && now - quietSince >= .18) {
      const finished = arm; arm = undefined; finished.onEnd();
    }
    checkUnavailable();
  }, 20);
  void context.resume().catch(() => {});
  return {
    async waitForQuiet(signal: AbortSignal) {
      const deadline = performance.now() + 10000;
      while (!closed && !signal.aborted && performance.now() < deadline) {
        if (context.state !== "running") return false;
        if (context.state === "running" && !active && context.currentTime - quietSince >= .18) return true;
        await new Promise(resolve => window.setTimeout(resolve, 20));
      }
      return false;
    },
    arm(duration: number, onStart: () => void, onEnd: () => void, onUnavailable: (mayUseServerCompletion: boolean) => void) {
      arm = { duration, signalled: false, eligible: !active && context.currentTime - quietSince >= .18, onStart, onEnd, onUnavailable };
    },
    signalStart() { if (arm) { arm.signalled = true; cueIfConfirmed(); } },
    signalEnd() { if (arm && arm.endedAt === undefined) arm.endedAt = performance.now(); },
    cancel() { arm = undefined; },
    close() { closed = true; arm = undefined; clearInterval(timer); source.disconnect(); analyser.disconnect(); void context.close().catch(() => {}); },
  };
}

export async function wavDuration(blob: Blob): Promise<number> {
  const buffer = await blob.arrayBuffer(), view = new DataView(buffer);
  const text = (at: number, n: number) => String.fromCharCode(...new Uint8Array(buffer, at, n));
  if (buffer.byteLength < 44 || text(0, 4) !== "RIFF" || text(8, 4) !== "WAVE") throw Error("Invalid WAV");
  let byteRate = 0, length = 0;
  for (let at = 12; at + 8 <= buffer.byteLength;) {
    const size = view.getUint32(at + 4, true); if (at + 8 + size > buffer.byteLength) throw Error("Truncated WAV");
    if (text(at, 4) === "fmt " && size >= 16) {
      if (![1, 3].includes(view.getUint16(at + 8, true))) throw Error("Unsupported WAV encoding");
      byteRate = view.getUint32(at + 16, true);
    }
    if (text(at, 4) === "data") length += size;
    at += 8 + size + size % 2;
  }
  const seconds = length / byteRate;
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 180) throw Error("Invalid WAV duration");
  return seconds;
}
