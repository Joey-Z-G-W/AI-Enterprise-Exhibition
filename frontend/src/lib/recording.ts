/** One explicitly requested microphone capture; never starts on page load. */
export class RecordingError extends Error {
  constructor(public readonly kind: "permission" | "device" | "unsupported" | "empty" | "timeout" | "failed" | "cancelled") {
    super(kind);
  }
}

export type Recording = {
  result: Promise<{ blob: Blob; filename: string }>;
  stop: () => void;
  cancel: () => void;
};

export function startRecording(
  signal: AbortSignal, onRecording: () => void, onStopping: (limitReached: boolean) => void,
): Recording {
  let stream: MediaStream | undefined;
  let recorder: MediaRecorder | undefined;
  let finished = false;
  let stopping = false;
  let permissionTimer: ReturnType<typeof setTimeout>;
  let durationTimer: ReturnType<typeof setTimeout>;
  let stopTimer: ReturnType<typeof setTimeout>;
  const chunks: Blob[] = [];
  let resolve!: (value: { blob: Blob; filename: string }) => void;
  let reject!: (reason: RecordingError) => void;
  const result = new Promise<{ blob: Blob; filename: string }>((yes, no) => { resolve = yes; reject = no; });
  const stopTracks = () => stream?.getTracks().forEach((track) => { track.onended = null; track.stop(); });
  const finish = (error?: RecordingError, audio?: { blob: Blob; filename: string }) => {
    if (finished) return;
    finished = true;
    clearTimeout(permissionTimer);
    clearTimeout(durationTimer);
    clearTimeout(stopTimer);
    signal.removeEventListener("abort", cancel);
    if (recorder) {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      recorder.onerror = null;
      if (recorder.state !== "inactive") { try { recorder.stop(); } catch { /* tracks still close below */ } }
    }
    stopTracks();
    if (error) reject(error);
    else resolve(audio!);
  };
  const cancel = () => finish(new RecordingError("cancelled"));
  const stop = (limitReached = false) => {
    if (finished || stopping || !recorder) return;
    stopping = true;
    clearTimeout(durationTimer);
    stopTimer = setTimeout(() => finish(new RecordingError("timeout")), 5000);
    try {
      // stop() queues the final dataavailable/onstop events; the microphone closes now.
      recorder.stop();
      stopTracks();
      onStopping(limitReached);
    } catch { finish(new RecordingError("failed")); }
  };

  if (signal.aborted) cancel();
  else if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") finish(new RecordingError("unsupported"));
  else {
    signal.addEventListener("abort", cancel, { once: true });
    permissionTimer = setTimeout(() => finish(new RecordingError("timeout")), 20000);
    void navigator.mediaDevices.getUserMedia({ audio: true }).then((acquired) => {
      // Permission prompts cannot be aborted. A late grant must release its own stream.
      if (finished || signal.aborted) { acquired.getTracks().forEach((track) => track.stop()); return; }
      stream = acquired;
      clearTimeout(permissionTimer);
      try {
        const mimeType = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"]
          .find((type) => MediaRecorder.isTypeSupported(type));
        recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
        recorder.ondataavailable = (event) => { if (!finished && event.data.size) chunks.push(event.data); };
        recorder.onerror = () => finish(new RecordingError("failed"));
        recorder.onstop = () => {
          if (finished) return;
          const type = recorder?.mimeType || chunks[0]?.type || "audio/webm";
          const blob = new Blob(chunks, { type });
          const extension = type.includes("mp4") ? "mp4" : type.includes("ogg") ? "ogg" : "webm";
          finish(blob.size ? undefined : new RecordingError("empty"), { blob, filename: `question.${extension}` });
        };
        stream.getTracks().forEach((track) => { track.onended = () => { if (!stopping) finish(new RecordingError("failed")); }; });
        recorder.start();
        durationTimer = setTimeout(() => stop(true), 30000);
        onRecording();
      } catch { finish(new RecordingError("failed")); }
    }, (error: unknown) => {
      const name = error instanceof DOMException ? error.name : "";
      finish(new RecordingError(["NotAllowedError", "SecurityError"].includes(name) ? "permission"
        : ["NotFoundError", "OverconstrainedError"].includes(name) ? "device" : "failed"));
    });
  }
  return { result, stop: () => stop(false), cancel };
}

export function recordingMessage(error: unknown): string {
  if (!(error instanceof RecordingError)) return "语音识别暂不可用，请重试或选择预设问题。";
  return {
    permission: "未获得麦克风权限，请允许访问后重试，或选择预设问题。",
    device: "未找到可用麦克风，请检查设备后重试。",
    unsupported: "当前浏览器不支持录音，请使用支持录音的浏览器或选择预设问题。",
    empty: "没有录到有效音频，请重新录音。",
    timeout: "录音等待超时，本轮已取消，请重试。",
    failed: "录音未成功，麦克风已关闭，请重试。",
    cancelled: "本轮录音已取消。",
  }[error.kind];
}
