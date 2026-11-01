import { useEffect, useRef, useState } from "react";
import { jsonRequest, messageFor, post, request, RequestError } from "./lib/api";
import { startPlayback, type Playback } from "./lib/webrtc";
import { recordingMessage, startRecording, type Recording } from "./lib/recording";

const DEMO_TEXT = "欢迎来到我们的展厅。这是一段固定文本演示，用于体验数字人的声音与口型。";
type Connection = "idle" | "connecting" | "ready" | "playing" | "disconnecting" | "error";
type BusinessResult = {
  session_id: string; turn_id: string;
  status: "answer" | "clarify" | "handoff" | "error";
  text: string; error_code?: string | null;
  sources: { excerpt: string; source: { status: "known" | "unknown"; filename: string | null } }[];
};
type ActiveSession = {
  id: string | null; controller: AbortController; playback?: Playback; events?: EventSource;
  creation?: Promise<string>; retirement?: Promise<boolean>;
};
type VoiceTurn = { session: ActiveSession; capture?: Recording };
const labels: Record<Connection, string> = {
  idle: "尚未连接", connecting: "正在准备数字人", ready: "媒体已连接，等待播放",
  playing: "画面播放中", disconnecting: "正在断开", error: "连接失败",
};
const answerLabels = { answer: "资料回答", clarify: "需要澄清", handoff: "请由销售接管", error: "服务暂不可用" };

function isBusinessResult(value: unknown): value is BusinessResult {
  if (!value || typeof value !== "object") return false;
  const item = value as BusinessResult;
  return typeof item.session_id === "string" && typeof item.turn_id === "string"
    && Object.hasOwn(answerLabels, item.status) && typeof item.text === "string"
    && Array.isArray(item.sources) && item.sources.every((citation) =>
      citation && typeof citation.excerpt === "string" && citation.source
      && ["known", "unknown"].includes(citation.source.status)
      && (citation.source.status === "unknown" || typeof citation.source.filename === "string"));
}

async function releaseSession(id: string): Promise<boolean> {
  const path = `/opentalking/sessions/${encodeURIComponent(id)}`;
  // These commands enqueue work. Only GET closed/404 confirms worker release.
  try { await request(`${path}/interrupt`, post({}), 3000); } catch { /* still attempt DELETE */ }
  try { await request(path, { method: "DELETE" }, 3000); } catch { /* verify actual state below */ }
  const deadline = Date.now() + 15000;
  try {
    while (Date.now() < deadline) {
      const response = await request(path, {}, Math.min(3000, deadline - Date.now()));
      if (response.status === 404) return true;
      if (!response.ok) return false;
      const body = await response.json();
      if (body.session_id !== id || typeof body.state !== "string") return false;
      if (body.state === "closed") return true;
      await new Promise((resolve) => window.setTimeout(resolve, 300));
    }
  } catch { return false; }
  return false;
}

export default function App() {
  const video = useRef<HTMLVideoElement>(null);
  const active = useRef<ActiveSession | null>(null);
  const retired = useRef<ActiveSession | null>(null);
  const modeRef = useRef<"assistant" | "human">("assistant");
  const transition = useRef<object | null>(null);
  const generation = useRef(0);
  const busy = useRef(false);
  const voiceTurn = useRef<VoiceTurn | null>(null);
  const demoTimer = useRef<number>();
  const demoPhase = useRef<"idle" | "preparing" | "sent" | "playing">("idle");
  const [connection, setConnection] = useState<Connection>("idle");
  const [mode, setMode] = useState<"assistant" | "human">("assistant");
  const [transitioning, setTransitioning] = useState(false);
  const [handoff, setHandoff] = useState({ question: "", reason: "" });
  const [notice, setNotice] = useState("");
  const [soundBlocked, setSoundBlocked] = useState(false);
  const [question, setQuestion] = useState("");
  const [submittedQuestion, setSubmittedQuestion] = useState("");
  const [answer, setAnswer] = useState<BusinessResult | null>(null);
  const [questionError, setQuestionError] = useState("");
  const [pending, setPending] = useState(false);
  const [demoStatus, setDemoStatus] = useState("");
  const [demoPending, setDemoPending] = useState(false);
  const [recordingState, setRecordingState] = useState<"idle" | "requesting" | "recording" | "transcribing">("idle");
  const [recordingHint, setRecordingHint] = useState("");
  const current = (session: ActiveSession) => modeRef.current === "assistant"
    && active.current === session && !session.controller.signal.aborted;

  function detach(): ActiveSession | null {
    generation.current += 1;
    const session = active.current;
    active.current = null;
    if (session) retired.current = session;
    transition.current = null;
    setTransitioning(false);
    voiceTurn.current?.capture?.cancel();
    voiceTurn.current = null;
    session?.controller.abort();
    session?.events?.close();
    session?.playback?.close();
    window.clearTimeout(demoTimer.current);
    demoPhase.current = "idle";
    busy.current = false;
    setPending(false);
    setDemoPending(false);
    setSoundBlocked(false);
    setRecordingState("idle");
    setRecordingHint("");
    return session;
  }

  async function closeRetired(): Promise<boolean> {
    const session = retired.current;
    if (!session) return true;
    if (session.retirement) return session.retirement;
    session.retirement = (async () => {
      // A cancelled creation can still return a server ID; never create another meanwhile.
      if (!session.id) {
        try { session.id = await session.creation ?? null; } catch { return false; }
      }
      const closed = session.id ? await releaseSession(session.id) : false;
      if (closed && retired.current === session) retired.current = null;
      return closed;
    })();
    try { return await session.retirement; }
    finally { session.retirement = undefined; }
  }

  async function disconnect(failure = "") {
    detach();
    const epoch = generation.current;
    setConnection("disconnecting");
    setDemoStatus("");
    setNotice(failure);
    const released = await closeRetired();
    if (epoch !== generation.current) return;
    setConnection(failure ? "error" : "idle");
    if (!released) setNotice("画面和声音已关闭，但旧会话释放未确认；不会开启新会话，请重试或联系工作人员。");
  }

  async function takeOver(reason = "销售已手动接管。", text?: string) {
    if (modeRef.current === "human") return;
    const untranscribed = voiceTurn.current && recordingState !== "idle";
    setHandoff({
      question: text ?? (pending ? submittedQuestion : question.trim() || submittedQuestion),
      reason: reason + (untranscribed ? " 本轮录音已取消，尚未获得文字。" : ""),
    });
    modeRef.current = "human";
    setMode("human");
    await disconnect();
  }

  useEffect(() => {
    const dispose = () => {
      const session = active.current;
      active.current = null;
      if (session) retired.current = session;
      generation.current += 1;
      transition.current = null;
      voiceTurn.current?.capture?.cancel();
      voiceTurn.current = null;
      session?.controller.abort();
      session?.events?.close();
      session?.playback?.close();
      window.clearTimeout(demoTimer.current);
      const id = retired.current?.id;
      if (id) {
        void fetch(`/opentalking/sessions/${encodeURIComponent(id)}/interrupt`, { method: "POST", keepalive: true }).catch(() => {});
        void fetch(`/opentalking/sessions/${encodeURIComponent(id)}`, { method: "DELETE", keepalive: true }).catch(() => {});
      }
    };
    window.addEventListener("pagehide", dispose);
    return () => { window.removeEventListener("pagehide", dispose); dispose(); };
  }, []);

  async function connect(intent: "connect" | "resume" | "record" = "connect") {
    if (active.current || transition.current || connection === "disconnecting"
      || (modeRef.current === "human" && intent !== "resume")) return;
    const token = {};
    transition.current = token;
    setTransitioning(true);
    const epoch = generation.current;
    setNotice("正在确认旧会话已关闭…");
    const released = await closeRetired();
    if (transition.current !== token || epoch !== generation.current) return;
    if (!released) {
      transition.current = null;
      setTransitioning(false);
      setNotice("旧会话释放未确认，保持声画关闭；请重试或联系工作人员。");
      return;
    }
    modeRef.current = "assistant";
    setMode("assistant");
    const session: ActiveSession = { id: null, controller: new AbortController() };
    active.current = session;
    generation.current += 1;
    setConnection("connecting");
    setNotice("");
    setDemoStatus("");
    setQuestionError("");
    try {
      // Let creation return its ID after a local cancel so the abandoned session can be deleted.
      session.creation = jsonRequest<{ session_id: string }>("/opentalking/sessions", post({
        avatar_id: "companion", model: "quicktalk", tts_provider: "edge", stt_provider: "sensevoice",
        tts_voice: "zh-CN-XiaoxiaoNeural", agent_enabled: false, memory_enabled: false, knowledge_enabled: false,
      }), 30000).then((created) => {
        if (typeof created.session_id !== "string" || !created.session_id) throw new RequestError("response");
        return created.session_id;
      });
      session.id = await session.creation;
      if (!current(session)) { await closeRetired(); return; }
      const deadline = Date.now() + 180000;
      while (true) {
        const status = await jsonRequest<{ state: string }>(`/opentalking/sessions/${encodeURIComponent(session.id)}`, { signal: session.controller.signal });
        if (!current(session)) return;
        if (["worker_ready", "ready", "speaking"].includes(status.state)) break;
        if (["error", "closed"].includes(status.state)) throw new RequestError("response");
        if (Date.now() > deadline) throw new RequestError("timeout");
        await new Promise((resolve) => window.setTimeout(resolve, 750));
      }
      session.events = new EventSource(`/opentalking/sessions/${encodeURIComponent(session.id)}/events`);
      session.events.addEventListener("speech.media_started", () => {
        if (current(session) && ["sent", "playing"].includes(demoPhase.current)) {
          demoPhase.current = "playing";
          setDemoStatus("固定文本正在播报");
        }
      });
      session.events.addEventListener("speech.ended", () => {
        if (!current(session) || !["sent", "playing"].includes(demoPhase.current)) return;
        window.clearTimeout(demoTimer.current);
        demoPhase.current = "idle";
        setDemoPending(false);
        busy.current = false;
        setDemoStatus("固定文本播报结束");
      });
      session.events.onerror = () => {
        if (current(session)) void disconnect("状态连接已中断，请重新连接数字人。");
      };
      session.playback = await startPlayback(session.id, video.current!, session.controller.signal,
        () => { if (current(session)) setSoundBlocked(true); },
        () => { if (current(session)) void disconnect("音视频连接已断开，请重新连接。"); },
      );
      if (!current(session)) { session.playback.close(); return; }
      await jsonRequest(`/opentalking/sessions/${encodeURIComponent(session.id)}/start`, post({}, session.controller.signal));
      if (current(session)) {
        setConnection(video.current?.paused ? "ready" : "playing");
        if (intent === "record") setRecordingHint("旧播报已隔离，新会话就绪。请再次点击“开始录音”，此时尚未采集。");
      }
    } catch (error) {
      if (current(session)) await disconnect(messageFor(error));
    } finally {
      if (transition.current === token) { transition.current = null; setTransitioning(false); }
    }
  }

  async function prepareRecording() {
    if (modeRef.current !== "assistant" || !active.current || demoPhase.current === "idle" || transition.current) return;
    detach();
    setConnection("idle");
    setDemoStatus("旧播报已停止，正在准备新的录音会话。");
    await connect("record");
  }

  async function submitQuestion(event: React.FormEvent) {
    event.preventDefault();
    const session = active.current;
    const text = question.trim();
    if (!session?.id || !current(session) || !text || busy.current) return;
    busy.current = true;
    await sendQuestion(session, text);
  }

  async function sendQuestion(session: ActiveSession, text: string) {
    setPending(true);
    setSubmittedQuestion(text);
    setAnswer(null);
    setQuestionError("");
    const turnId = crypto.randomUUID();
    try {
      const response = await request("/guide/questions", post({ session_id: session.id, turn_id: turnId, question: text }, session.controller.signal), 30000);
      let body: unknown;
      try { body = await response.json(); } catch { throw new RequestError("response"); }
      if (!isBusinessResult(body) || body.session_id !== session.id || body.turn_id !== turnId) throw new RequestError("response");
      if (!response.ok && body.status !== "error") throw new RequestError("response");
      if (current(session)) {
        setAnswer(body);
        if (body.status === "handoff") await takeOver(body.text, text);
      }
    } catch (error) {
      if (current(session)) setQuestionError(messageFor(error));
    } finally {
      if (current(session)) { busy.current = false; setPending(false); }
    }
  }

  async function beginRecording() {
    const session = active.current;
    if (!session?.id || !current(session) || busy.current || demoPhase.current !== "idle"
      || !["ready", "playing"].includes(connection)) return;
    const turn: VoiceTurn = { session };
    voiceTurn.current = turn;
    const valid = () => current(session) && voiceTurn.current === turn;
    busy.current = true;
    setRecordingState("requesting");
    setRecordingHint("请允许本轮麦克风访问；未开始前不会录音。");
    try {
      turn.capture = startRecording(session.controller.signal,
        () => { if (valid()) { setRecordingState("recording"); setRecordingHint("正在录音，最长30秒。说完请点击结束。"); } },
        (limitReached) => { if (valid()) { setRecordingState("transcribing"); setRecordingHint(limitReached ? "已达30秒上限，麦克风已关闭，正在识别…" : "麦克风已关闭，正在识别…"); } },
      );
      const audio = await turn.capture.result;
      if (!valid()) return;
      setRecordingState("transcribing");
      setRecordingHint("麦克风已关闭，正在识别…");
      const form = new FormData();
      form.set("file", audio.blob, audio.filename);
      form.set("stt_provider", "sensevoice");
      const transcript = await jsonRequest<{ session_id: string; text: string }>(
        `/opentalking/sessions/${encodeURIComponent(session.id)}/transcribe`,
        { method: "POST", body: form, signal: session.controller.signal }, 45000,
      );
      if (!valid()) return;
      if (transcript.session_id !== session.id || typeof transcript.text !== "string") throw new RequestError("response");
      const text = transcript.text.trim();
      if (!text) { setRecordingHint("没有识别到文字，请靠近麦克风重新录音。"); return; }
      if (text.length > 2000) { setRecordingHint("识别内容过长，请缩短问题后重新录音。"); return; }
      setQuestion(text);
      setRecordingState("idle");
      setRecordingHint("语音已识别并提交，麦克风已关闭。");
      await sendQuestion(session, text);
    } catch (error) {
      if (valid()) setRecordingHint(error instanceof RequestError && error.kind === "timeout"
        ? "语音识别超时，请重试或输入文字。" : recordingMessage(error));
    } finally {
      turn.capture?.cancel();
      if (valid()) {
        voiceTurn.current = null;
        busy.current = false;
        setRecordingState("idle");
      }
    }
  }

  async function playDemo() {
    const session = active.current;
    if (!session?.id || !current(session) || busy.current) return;
    busy.current = true;
    demoPhase.current = "preparing";
    setDemoPending(true);
    setDemoStatus("正在合成固定演示语音");
    try {
      const audio = await request("/opentalking/tts/preview", post({ text: DEMO_TEXT, tts_provider: "edge", voice: "zh-CN-XiaoxiaoNeural" }, session.controller.signal), 45000);
      if (!audio.ok || !audio.headers.get("content-type")?.includes("audio/wav")) throw new RequestError("response");
      const blob = await audio.blob();
      if (!current(session)) return;
      const form = new FormData();
      form.set("file", blob, "fixed-demo.wav");
      demoPhase.current = "sent";
      setDemoStatus("正在发送演示语音");
      demoTimer.current = window.setTimeout(() => {
        if (current(session)) void disconnect("演示播放等待超时，已关闭媒体，请重新连接。");
      }, 90000);
      const result = await jsonRequest<{ status: string }>(`/opentalking/sessions/${encodeURIComponent(session.id)}/speak_flashtalk_audio`, { method: "POST", body: form, signal: session.controller.signal }, 30000);
      if (!current(session)) return;
      if (result.status !== "queued") throw new RequestError("response");
      if (demoPhase.current === "sent") setDemoStatus("演示语音已排队，等待实际播放");
    } catch (error) {
      if (current(session)) {
        await disconnect(messageFor(error));
      }
    }
  }

  async function enableSound() {
    const session = active.current;
    if (!video.current || !session || !current(session)) return;
    video.current.muted = false;
    try { await video.current.play(); if (current(session)) setSoundBlocked(false); }
    catch { if (current(session)) setSoundBlocked(true); }
  }

  const connected = connection === "ready" || connection === "playing";
  return <main>
    <header className="topbar">
      <a className="brand" href="/" aria-label="展厅导览首页"><span className="brand-mark">展</span><span>展厅 · AI 导览<small>现场体验 / 单组访客</small></span></a>
      <span className="mode-note">真实数字人体验 <span>·</span> 问答模型待接入</span>
    </header>
    <div className="workspace">
      <section className="stage-panel" aria-label="数字人">
        <div className="stage-heading"><span className="eyebrow">现场导览</span><span className={`status-pill ${connected ? "online" : ""}`} role="status"><i />{mode === "human" ? "销售接管中" : labels[connection]}</span></div>
        <div className="video-stage">
          <video ref={video} playsInline autoPlay aria-label="数字人实时画面" onPlaying={() => {
            if (active.current && !active.current.controller.signal.aborted) setConnection((value) => value === "ready" ? "playing" : value);
          }} />
          {!connected && <div className="stage-placeholder"><div className="orbit"><span>AI</span></div><h1>{mode === "human" ? "请与现场销售交流" : "欢迎来到展厅"}</h1><p>{mode === "human" ? "麦克风与数字人声画已关闭" : connection === "connecting" ? "正在准备形象与音视频连接…" : "连接数字人，开始现场体验"}</p></div>}
          {soundBlocked && <button className="sound-button" onClick={() => void enableSound()}>开启声音</button>}
          {connected && <span className="sound-caption">{soundBlocked ? "当前静音 · 请开启声音" : "声音已启用"}</span>}
        </div>
        <div className="stage-controls">
          <div><strong>展厅讲解员</strong><span>固定形象 · 实时音视频</span></div>
          <div className="button-row">
            <button className="primary" disabled={mode === "human" || transitioning || !["idle", "error"].includes(connection)} onClick={() => void connect()}>连接数字人</button>
            <button className="secondary" disabled={!active.current || connection === "disconnecting"} onClick={() => void disconnect()}>断开</button>
            <button className="takeover-button" disabled={mode === "human"} onClick={() => void takeOver()}>销售接管</button>
          </div>
        </div>
        {notice && <p className="notice" role="alert">{notice}</p>}
      </section>
      <section className="conversation-panel" aria-label="问题与回答">
        <div className="section-heading"><span className="eyebrow">资料问答</span><h2>您想了解什么？</h2><p>输入产品或方案问题，查看回答和资料来源。</p></div>
        {mode === "human" && <aside className="handoff-panel" role="status">
          <h3>销售接管中</h3><p>{handoff.reason}</p>
          <p><strong>待接管问题：</strong>{handoff.question || "尚无文字问题，请直接向销售说明。"}</p>
          <small>问答、录音与自动播报已暂停。恢复后开启全新会话，不重发旧问题。</small>
          <button className="secondary" disabled={transitioning || connection === "disconnecting"} onClick={() => void connect("resume")}>{transitioning ? "正在确认会话关闭…" : "恢复问答"}</button>
        </aside>}
        <form onSubmit={submitQuestion}>
          <label htmlFor="question">您的问题</label>
          <textarea id="question" maxLength={2000} value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="例如：这款产品的电池容量是多少？" disabled={mode === "human" || pending || recordingState !== "idle"} rows={3} />
          <div className="form-footer"><span>{question.length} / 2000</span><button className="primary" disabled={mode === "human" || !connected || pending || demoPending || recordingState !== "idle" || !question.trim()}>{pending ? "正在查询…" : "提交问题 ↗"}</button></div>
        </form>
        <div className="recording-controls">
          <button className={recordingState === "recording" ? "recording-stop" : "secondary"}
            disabled={mode === "human" || !connected || transitioning || pending || ["requesting", "transcribing"].includes(recordingState)}
            onClick={() => demoPending ? void prepareRecording() : recordingState === "recording" ? voiceTurn.current?.capture?.stop() : void beginRecording()}>
            {demoPending ? "停止播报并准备录音" : recordingState === "recording" ? "结束录音并提问" : recordingState === "requesting" ? "等待麦克风授权…" : recordingState === "transcribing" ? "正在识别语音…" : "开始录音"}
          </button>
          <span>{demoPending ? "先停止播报，准备好后再次点击录音" : "点击才采集 · 最长30秒"}</span>
          {recordingHint && <p role="status">{recordingHint}</p>}
        </div>
        <div className="answer-area" aria-live="polite">
          {submittedQuestion && <p className="submitted"><span>本轮问题</span>{submittedQuestion}</p>}
          {pending ? <p className="muted">正在获取资料回答，请稍候…</p> : questionError ? <p className="notice" role="alert">{questionError}</p> : answer ? <>
            <span className={`answer-label ${answer.status}`}>{answerLabels[answer.status]}</span>
            <p className="answer-text">{answer.status === "error" ? (answer.error_code === "service_not_configured" ? "问答服务尚未配置真实模型，暂时无法回答。您可以体验下方的固定文本播报。" : "问答服务暂不可用，请联系现场销售。") : answer.text}</p>
            {answer.sources.length > 0 && <div className="sources"><h3>本轮资料来源</h3>{answer.sources.map((citation, index) => <div key={index}><strong>{citation.source.status === "known" ? citation.source.filename : "来源未知"}</strong><p>{citation.excerpt}</p></div>)}</div>}
          </> : <div className="answer-empty"><span>答</span><p>回答会显示在这里<small>尚未接入真实问答模型，提交后会明确提示服务状态。</small></p></div>}
        </div>
        <aside className="demo-panel">
          <div className="demo-heading"><h3>固定文本播报</h3><span>非 LLM</span></div>
          <p>{DEMO_TEXT}</p><small>仅体验声音与口型，不作为您问题的答案。</small>
          <button className="secondary" disabled={mode === "human" || !connected || demoPending || pending || recordingState !== "idle"} onClick={() => void playDemo()}>{demoPending ? "演示处理中…" : "播放固定演示"}</button>
          {demoStatus && <p className="demo-status" role="status">{demoStatus}</p>}
        </aside>
      </section>
    </div>
    <footer>有需要时，请联系现场销售继续为您讲解。<span>展厅导览 · 最小原型</span></footer>
  </main>;
}
