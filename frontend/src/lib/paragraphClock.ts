/** Native TTS offsets joined to the RTP timestamp of a presented, paired video frame.
 * This observes receiver presentation, never a wall-clock estimate of audio samples.
 */
export type Boundary = { text: string; start_ms: number; end_ms: number };
export function alignBoundaries(raw: unknown, sentences: { text: string }[], duration: number): Boundary[] | undefined {
  if (!Array.isArray(raw) || !raw.length || !Number.isFinite(duration) || duration <= 0) return;
  const normalize = (s: string) => s.replace(/[\s\p{P}\p{S}]/gu, "");
  let previous = -1;
  for (let i = 0; i < raw.length; i++) {
    const b = raw[i];
    if (!b || typeof b.text !== "string" || !Number.isFinite(b.start_ms) || !Number.isFinite(b.end_ms)
      || b.start_ms < 0 || b.start_ms <= previous || b.end_ms <= b.start_ms || b.end_ms > duration + 100
      || i + 1 < raw.length && b.end_ms - raw[i + 1]?.start_ms > 100) return;
    previous = b.start_ms;
  }
  // Edge occasionally includes up to 100 ms of the next sentence in a duration.
  // Clip only to the next native start (or the actual WAV end), never estimate speech speed.
  const native: Boundary[] = raw.map((b, i) => ({ ...b,
    end_ms: Math.min(b.end_ms, raw[i + 1]?.start_ms ?? duration) }));
  // Only whole native boundaries may be combined. Never interpolate by character count.
  const result: Boundary[] = []; let cursor = 0;
  for (const sentence of sentences) {
    const target = normalize(sentence.text); const start = cursor; let text = "";
    while (cursor < raw.length && text.length < target.length) text += normalize(native[cursor++].text);
    if (!target || text !== target) return;
    result.push({ text: sentence.text, start_ms: native[start].start_ms, end_ms: native[cursor - 1].end_ms });
  }
  return cursor === raw.length ? result : undefined;
}

type Frame = { generation: string; rtp_timestamp: number; segment_id: string | null; source_ms: number | null };
export type ParagraphClock = ReturnType<typeof createParagraphClock>;
export function createParagraphClock(video: HTMLVideoElement) {
  let generation: string | undefined, capable = false, closed = false;
  const frames = new Map<number, Frame>();
  let stamp: number | undefined, presentedAt = 0, mappedAt = 0;
  let owner: { segment: string; duration: number; progress: (ms: number) => void; unavailable: () => void; hide: () => void; initialLimit: number; last: number } | undefined;
  const clear = () => { owner = undefined; };
  const unavailable = () => { const old = owner; owner = undefined; old?.unavailable(); };
  const apply = (frame: Frame) => {
    if (!owner || frame.generation !== generation || frame.rtp_timestamp !== stamp) return;
    if (video.paused || video.muted || video.volume === 0 || video.readyState < 2 || performance.now() - presentedAt > 500) { unavailable(); return; }
    if (frame.segment_id !== owner.segment) return;
    const ms = frame.source_ms;
    if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0 || ms < owner.last) { unavailable(); return; }
    // A large unobserved jump cannot establish which sentence the visitor received.
    if (owner.last < 0 && ms > owner.initialLimit || owner.last >= 0 && ms - owner.last > 1500) { unavailable(); return; }
    mappedAt = performance.now(); owner.last = ms; owner.progress(ms);
  };
  const timer = window.setInterval(() => {
    if (owner && owner.last >= 0 && performance.now() - mappedAt > 1000) unavailable();
  }, 250);
  return {
    message(raw: unknown) {
      if (closed || !raw || typeof raw !== "object") return;
      const data = raw as Record<string, unknown>;
      if (data.type === "capabilities" && data.version === 1 && typeof data.generation === "string") {
        if (generation && generation !== data.generation) unavailable();
        generation = data.generation; capable = data.clock === "rtp-video";
        return;
      }
      if (data.type !== "frame" || data.version !== 1 || data.generation !== generation
        || !Number.isInteger(data.rtp_timestamp) || Number(data.rtp_timestamp) < 0 || Number(data.rtp_timestamp) > 0xffffffff) return;
      const frame = data as unknown as Frame;
      if (stamp !== undefined && ((frame.rtp_timestamp - stamp) | 0) < 0) return;
      frames.set(frame.rtp_timestamp, frame);
      while (frames.size > 512) frames.delete(frames.keys().next().value!);
      if (frame.rtp_timestamp === stamp) apply(frame);
    },
    presented(rtp: number | undefined) {
      if (closed || !Number.isInteger(rtp)) { if (owner) unavailable(); return; }
      if (stamp !== undefined && ((rtp! - stamp) | 0) <= 0) return;
      stamp = rtp; presentedAt = performance.now();
      const frame = frames.get(rtp!);
      if (frame) apply(frame);
      // Missing mappings clear the visual immediately without inventing progress.
      else if (owner && owner.last >= 0) owner.hide();
      for (const key of frames.keys()) if (((key - rtp!) | 0) < 0) frames.delete(key);
    },
    begin(segment: string, duration: number, progress: (ms: number) => void, onUnavailable: () => void, hide: () => void, initialLimit = 120) {
      clear();
      if (!capable || typeof video.requestVideoFrameCallback !== "function") return false;
      owner = { segment, duration, progress, unavailable: onUnavailable, hide, initialLimit, last: -1 }; return true;
    },
    cancel: clear,
    close() { closed = true; clear(); frames.clear(); window.clearInterval(timer); },
  };
}
