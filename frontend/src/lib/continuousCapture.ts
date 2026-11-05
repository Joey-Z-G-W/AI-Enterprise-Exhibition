import { MicVAD, Message } from "@ricky0123/vad-web";

export type CaptureStatus = "requesting" | "waiting" | "preparing" | "listening" | "closed" | "error";
export type ContinuousCapture = { listen: () => void; stop: () => Promise<boolean>; discardSegment: () => void; readonly released: boolean };
type SegmentCallbacks = { onSegment?: (audio: Float32Array) => void; onSpeechStart?: () => void; onSpeechRealStart?: () => void; onVADMisfire?: () => void };
type Report = (status: CaptureStatus, message: string) => void;

// vad-web 0.0.31 destroy() throws before model.release() when start() has not
// filled all four audio fields. This adapter is only for that incomplete path.
type PartialVAD = {
  model: { release: () => Promise<void> };
  _stream: MediaStream | null; _audioContext: AudioContext | null;
  _vadNode: AudioWorkletNode | null; _mediaStreamAudioSourceNode: MediaStreamAudioSourceNode | null;
};
export function createContinuousCapture(report: Report, callbacks: SegmentCallbacks = {}): ContinuousCapture {
  let stopped = false, ready = false, starting = false, released = false;
  let utterance = false, discarded = false;
  let stream: MediaStream | undefined, context: AudioContext | undefined, instance: MicVAD | undefined;
  let setupTimer: ReturnType<typeof setTimeout>, speechTimer: ReturnType<typeof setTimeout>;
  let closeContext: Promise<void> | undefined, releaseTask: Promise<boolean> | undefined;
  let failure = "";
  const pending: Promise<unknown>[] = [];
  const disposed = new WeakSet<object>();
  const stoppedTracks = new WeakSet<MediaStreamTrack>();
  const track = <T>(promise: Promise<T>): Promise<T> => { pending.push(promise); void promise.catch(() => {}); return promise; };
  const emit = (state: CaptureStatus, text: string) => { if (!stopped) report(state, text); };
  const stopTracks = () => stream?.getTracks().forEach(t => { t.onended = null; if (!stoppedTracks.has(t)) { stoppedTracks.add(t); t.stop(); } });
  const closeAudio = () => {
    if (!context || closeContext) return;
    closeContext = context.close(); void closeContext.catch(() => {});
  };
  async function dispose(vad: MicVAD) {
    if (disposed.has(vad)) return;
    disposed.add(vad);
    const partial = vad as unknown as PartialVAD;
    if (partial._stream && partial._audioContext && partial._vadNode && partial._mediaStreamAudioSourceNode) {
      await vad.destroy();
    } else {
      // Do not call start() on a late object just to make destroy() work.
      partial._mediaStreamAudioSourceNode?.disconnect();
      if (partial._vadNode) {
        partial._vadNode.port.postMessage(Message.SpeechStop);
        partial._vadNode.port.onmessage = null;
        partial._vadNode.disconnect();
      }
      if (!partial.model || typeof partial.model.release !== "function") throw Error("VAD cleanup contract changed");
      await partial.model.release();
    }
  }
  async function stop(): Promise<boolean> {
    if (!stopped) {
      stopped = true; clearTimeout(setupTimer); clearTimeout(speechTimer); stopTracks(); closeAudio();
      releaseTask = (async () => {
        await Promise.allSettled(pending);
        try {
          if (instance) await dispose(instance);
          if (closeContext) await closeContext;
          released = (!stream || stream.getTracks().every(t => t.readyState === "ended"))
            && (!context || context.state === "closed");
          if (!released) throw Error("capture resources still active");
          report(failure ? "error" : "closed", failure || "麦克风已关闭。");
          return true;
        } catch {
          failure = "麦克风资源释放未确认，请刷新页面后重试。"; report("error", failure); return false;
        }
      })();
    }
    let timer: ReturnType<typeof setTimeout>;
    try {
      return await Promise.race([releaseTask!, new Promise<boolean>(resolve => {
        timer = setTimeout(() => { report("error", failure || "正在等待麦克风准备操作结束，暂不能重新开启。"); resolve(false); }, 5000);
      })]);
    } finally { clearTimeout(timer!); }
  }
  function fail(text: string) { if (stopped) return; failure = text; report("error", text); void stop(); }
  async function beginListening() {
    if (stopped || !ready || !stream || starting) return;
    starting = true; emit("preparing", "正在准备持续收音…");
    setupTimer = setTimeout(() => fail("收音准备超时，麦克风已关闭。"), 30000);
    try {
      context = new AudioContext();
      await track(context.resume()); if (stopped) return;
      const created = track(MicVAD.new({
        model: "v5", positiveSpeechThreshold: .3, negativeSpeechThreshold: .25,
        redemptionMs: 1400, preSpeechPadMs: 800, minSpeechMs: 400,
        startOnLoad: false, submitUserSpeechOnPause: false, processorType: "AudioWorklet",
        baseAssetPath: "/vad/", onnxWASMBasePath: "/ort/", audioContext: context,
        ortConfig: ort => { ort.env.wasm.numThreads = 1; ort.env.wasm.proxy = false; },
        getStream: async () => { if (stopped || !stream) throw Error("capture stopped"); return stream; },
        pauseStream: async () => { stopTracks(); },
        resumeStream: async () => { throw Error("capture cannot reopen itself"); },
        onSpeechStart: () => { if (stopped || utterance) return; utterance = true; discarded = false; callbacks.onSpeechStart?.(); clearTimeout(speechTimer); speechTimer = setTimeout(() => fail("连续说话已达30秒，麦克风已关闭。"), 30000); },
        onSpeechRealStart: () => { if (!stopped && utterance && !discarded) callbacks.onSpeechRealStart?.(); },
        onSpeechEnd: audio => {
          clearTimeout(speechTimer);
          const accepted = !stopped && utterance && !discarded; utterance = false; discarded = false;
          if (accepted) callbacks.onSegment?.(audio);
        },
        onVADMisfire: () => { clearTimeout(speechTimer); utterance = false; discarded = false; if (!stopped) callbacks.onVADMisfire?.(); },
      }).then(vad => { instance = vad; return vad; }));
      const vad = await created; if (stopped) return;
      await track(vad.start()); if (stopped) return;
      clearTimeout(setupTimer);
      if (!vad.listening) throw Error("VAD did not start");
      emit("listening", "正在持续收音。");
    } catch { fail("收音未能开启，麦克风已关闭；可选择预设问题。"); }
  }
  // Permission is requested only when App calls this from an explicit connect/resume.
  queueMicrotask(() => emit("requesting", "请允许麦克风访问。"));
  setupTimer = setTimeout(() => fail("等待麦克风授权超时，已取消收音。"), 20000);
  try {
    const permission = navigator.mediaDevices?.getUserMedia({ video: false, audio: {
      echoCancellation: { exact: true }, noiseSuppression: true, autoGainControl: true, channelCount: 1,
    } });
    if (!permission) throw Error("unsupported");
    track(permission.then(acquired => {
      stream = acquired;
      if (stopped) { stopTracks(); return; }
      clearTimeout(setupTimer);
      if (stream.getAudioTracks()[0]?.getSettings().echoCancellation !== true) { fail("麦克风回声消除未开启，收音已关闭。"); return; }
      stream.getTracks().forEach(t => { t.onended = () => fail("麦克风连接已中断，请重新连接后重试。"); });
      emit("waiting", "麦克风已就绪，等待数字人连接。");
      void beginListening();
    }, () => { fail("未获得可用麦克风，请检查权限或选择预设问题。"); }));
  } catch { fail("当前浏览器无法开启麦克风，请选择预设问题。"); }
  return { listen() { ready = true; void beginListening(); }, stop, discardSegment() { if (utterance) discarded = true; }, get released() { return released; } };
}
