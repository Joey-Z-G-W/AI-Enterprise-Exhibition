export const MAX_SEGMENT_SAMPLES = 480000;
export const VOICE_RESOURCE_UNKNOWN = "语音识别资源的请求结果未确认，已暂停语音提交，等待片段已放弃；请断开后重新连接，再重新说出问题，也可选择预设问题。";

// A complete VAD segment, including its leading buffer. Never trim the first word.
export function segmentWav(samples: Float32Array): Blob {
  if (!samples.length || samples.length > MAX_SEGMENT_SAMPLES || samples.some(n => !Number.isFinite(n))) {
    throw Error("invalid voice segment");
  }
  const bytes = new ArrayBuffer(44 + samples.length * 2), view = new DataView(bytes);
  const text = (offset: number, value: string) => [...value].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  text(0, "RIFF"); view.setUint32(4, bytes.byteLength - 8, true); text(8, "WAVE"); text(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, "data"); view.setUint32(40, samples.length * 2, true);
  samples.forEach((n, i) => { const v = Math.max(-1, Math.min(1, n)); view.setInt16(44 + i * 2, Math.round(v * (v < 0 ? 32768 : 32767)), true); });
  return new Blob([bytes], { type: "audio/wav" });
}

export type VoiceCandidate = { duringResponse: boolean; releaseDuck: () => void };
type Waiting = { samples: Float32Array; epoch: number; expires: number; candidate: VoiceCandidate };
export type VoiceSegments = ReturnType<typeof createVoiceSegments>;
export function createVoiceSegments(
  ready: () => boolean,
  run: (samples: Float32Array, valid: () => boolean, candidate: VoiceCandidate) => Promise<"unknown" | void>,
  report: (text: string) => void,
  resourceUnknownChanged: (unknown: boolean) => void = () => {},
) {
  let epoch = 0, running = false, blocked = false, waiting: Waiting | undefined;
  let runningCandidate: VoiceCandidate | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  function clearWaiting() { waiting?.candidate.releaseDuck(); waiting = undefined; clearTimeout(timer); }
  function invalidate() { epoch++; clearWaiting(); runningCandidate?.releaseDuck(); }
  function quarantine() {
    blocked = true; clearWaiting();
    // This is a shared resource failure, not an old visitor's transcript.
    // It must explain the effect on the current epoch even when the old turn expired.
    resourceUnknownChanged(true);
    report(VOICE_RESOURCE_UNKNOWN);
  }
  function pump() {
    if (!waiting) return;
    if (Date.now() >= waiting.expires) { clearWaiting(); report("等待识别超过15秒，此段未提交，请稍后重说。"); return; }
    if (running || blocked || !ready()) return;
    const item = waiting; waiting = undefined; clearTimeout(timer); running = true; runningCandidate = item.candidate;
    const valid = () => item.epoch === epoch;
    void run(item.samples, valid, item.candidate).then(result => {
      if (result === "unknown") quarantine();
    }, quarantine).finally(() => { item.candidate.releaseDuck(); runningCandidate = undefined; running = false; pump(); });
  }
  return {
    enqueue(samples: Float32Array, candidate: VoiceCandidate) {
      if (!samples.length) { candidate.releaseDuck(); return; }
      if (samples.length > MAX_SEGMENT_SAMPLES || samples.some(n => !Number.isFinite(n))) { candidate.releaseDuck(); report("这段语音超过30秒或音频无效，未提交，请缩短后重说。"); return; }
      if (blocked) { candidate.releaseDuck(); report(VOICE_RESOURCE_UNKNOWN); return; }
      if (waiting && Date.now() >= waiting.expires) pump();
      if (waiting) { candidate.releaseDuck(); report("上一段仍在等待处理，此段未识别，请稍后重说。"); return; }
      waiting = { samples: samples.slice(), epoch, expires: Date.now() + 15000, candidate };
      timer = setTimeout(pump, 15000);
      report("语音片段已保留，等待识别…"); pump();
    },
    pump, invalidate,
    // Only an explicit user recovery may clear an unknown result, never an internal rebuild.
    recover() {
      if (!running && blocked) {
        blocked = false;
        resourceUnknownChanged(false);
        report("已重新允许语音提交，请在连接和收音就绪后重新说出问题。");
      }
    },
  };
}
