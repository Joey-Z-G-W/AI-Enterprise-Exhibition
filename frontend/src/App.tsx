import { useEffect, useRef, useState } from "react";
import { jsonRequest, messageFor, post, request, RequestError } from "./lib/api";
import { startPlayback, type Playback } from "./lib/webrtc";

const DEMO_TEXT = "欢迎来到我们的展厅。这是一段固定文本演示，用于体验数字人的声音与口型。";
type Connection = "idle" | "connecting" | "ready" | "playing" | "disconnecting" | "error";
type BusinessResult = {
  session_id: string; turn_id: string;
  status: "answer" | "clarify" | "handoff" | "error";
  text: string; error_code?: string | null;
  sources: { excerpt: string; source: { status: "known" | "unknown"; filename: string | null } }[];
};
type ActiveSession = { id: string | null; controller: AbortController; playback?: Playback; events?: EventSource };
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
  try {
    const response = await request(`/opentalking/sessions/${encodeURIComponent(id)}`, { method: "DELETE" }, 10000);
    return response.ok || response.status === 404;
  } catch { return false; }
}

export default function App() {
  const video = useRef<HTMLVideoElement>(null);
  const active = useRef<ActiveSession | null>(null);
  const generation = useRef(0);
  const busy = useRef(false);
  const demoTimer = useRef<number>();
  const demoPhase = useRef<"idle" | "preparing" | "sent" | "playing">("idle");
  const [connection, setConnection] = useState<Connection>("idle");
  const [notice, setNotice] = useState("");
  const [soundBlocked, setSoundBlocked] = useState(false);
  const [question, setQuestion] = useState("");
  const [submittedQuestion, setSubmittedQuestion] = useState("");
  const [answer, setAnswer] = useState<BusinessResult | null>(null);
  const [questionError, setQuestionError] = useState("");
  const [pending, setPending] = useState(false);
  const [demoStatus, setDemoStatus] = useState("");
  const [demoPending, setDemoPending] = useState(false);
  const current = (session: ActiveSession) => active.current === session && !session.controller.signal.aborted;

  function detach(): ActiveSession | null {
    generation.current += 1;
    const session = active.current;
    active.current = null;
    session?.controller.abort();
    session?.events?.close();
    session?.playback?.close();
    window.clearTimeout(demoTimer.current);
    demoPhase.current = "idle";
    busy.current = false;
    setPending(false);
    setDemoPending(false);
    setSoundBlocked(false);
    return session;
  }

  async function disconnect(failure = "") {
    const session = detach();
    const epoch = generation.current;
    setConnection("disconnecting");
    setDemoStatus("");
    setNotice(failure);
    const released = session?.id ? await releaseSession(session.id) : true;
    if (epoch !== generation.current) return;
    setConnection(failure ? "error" : "idle");
    if (!released) setNotice("画面和声音已关闭，但服务端会话释放未确认，请联系工作人员。");
  }

  useEffect(() => {
    const dispose = () => {
      const session = active.current;
      active.current = null;
      session?.controller.abort();
      session?.events?.close();
      session?.playback?.close();
      window.clearTimeout(demoTimer.current);
      if (session?.id) void fetch(`/opentalking/sessions/${encodeURIComponent(session.id)}`, { method: "DELETE", keepalive: true }).catch(() => {});
    };
    window.addEventListener("pagehide", dispose);
    return () => { window.removeEventListener("pagehide", dispose); dispose(); };
  }, []);

  async function connect() {
    if (active.current || connection === "disconnecting") return;
    const session: ActiveSession = { id: null, controller: new AbortController() };
    active.current = session;
    generation.current += 1;
    setConnection("connecting");
    setNotice("");
    setDemoStatus("");
    setAnswer(null);
    setSubmittedQuestion("");
    setQuestionError("");
    try {
      // Let creation return its ID after a local cancel so the abandoned session can be deleted.
      const created = await jsonRequest<{ session_id: string }>("/opentalking/sessions", post({
        avatar_id: "companion", model: "quicktalk", tts_provider: "edge", stt_provider: "sensevoice",
        tts_voice: "zh-CN-XiaoxiaoNeural", agent_enabled: false, memory_enabled: false, knowledge_enabled: false,
      }), 30000);
      if (typeof created.session_id !== "string" || !created.session_id) throw new RequestError("response");
      session.id = created.session_id;
      if (!current(session)) { await releaseSession(session.id); return; }
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
      if (current(session)) setConnection(video.current?.paused ? "ready" : "playing");
    } catch (error) {
      if (current(session)) await disconnect(messageFor(error));
    }
  }

  async function submitQuestion(event: React.FormEvent) {
    event.preventDefault();
    const session = active.current;
    const text = question.trim();
    if (!session?.id || !current(session) || !text || busy.current) return;
    busy.current = true;
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
      if (current(session)) setAnswer(body);
    } catch (error) {
      if (current(session)) setQuestionError(messageFor(error));
    } finally {
      if (current(session)) { busy.current = false; setPending(false); }
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
        <div className="stage-heading"><span className="eyebrow">现场导览</span><span className={`status-pill ${connected ? "online" : ""}`} role="status"><i />{labels[connection]}</span></div>
        <div className="video-stage">
          <video ref={video} playsInline autoPlay aria-label="数字人实时画面" onPlaying={() => {
            if (active.current && !active.current.controller.signal.aborted) setConnection((value) => value === "ready" ? "playing" : value);
          }} />
          {!connected && <div className="stage-placeholder"><div className="orbit"><span>AI</span></div><h1>欢迎来到展厅</h1><p>{connection === "connecting" ? "正在准备形象与音视频连接…" : "连接数字人，开始现场体验"}</p></div>}
          {soundBlocked && <button className="sound-button" onClick={() => void enableSound()}>开启声音</button>}
          {connected && <span className="sound-caption">{soundBlocked ? "当前静音 · 请开启声音" : "声音已启用"}</span>}
        </div>
        <div className="stage-controls">
          <div><strong>展厅讲解员</strong><span>固定形象 · 实时音视频</span></div>
          <div className="button-row">
            <button className="primary" disabled={!["idle", "error"].includes(connection)} onClick={() => void connect()}>连接数字人</button>
            <button className="secondary" disabled={!active.current || connection === "disconnecting"} onClick={() => void disconnect()}>断开</button>
          </div>
        </div>
        {notice && <p className="notice" role="alert">{notice}</p>}
      </section>
      <section className="conversation-panel" aria-label="问题与回答">
        <div className="section-heading"><span className="eyebrow">资料问答</span><h2>您想了解什么？</h2><p>输入产品或方案问题，查看回答和资料来源。</p></div>
        <form onSubmit={submitQuestion}>
          <label htmlFor="question">您的问题</label>
          <textarea id="question" maxLength={2000} value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="例如：这款产品的电池容量是多少？" disabled={pending} rows={3} />
          <div className="form-footer"><span>{question.length} / 2000</span><button className="primary" disabled={!connected || pending || demoPending || !question.trim()}>{pending ? "正在查询…" : "提交问题 ↗"}</button></div>
        </form>
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
          <button className="secondary" disabled={!connected || demoPending || pending} onClick={() => void playDemo()}>{demoPending ? "演示处理中…" : "播放固定演示"}</button>
          {demoStatus && <p className="demo-status" role="status">{demoStatus}</p>}
        </aside>
      </section>
    </div>
    <footer>有需要时，请联系现场销售继续为您讲解。<span>展厅导览 · 最小原型</span></footer>
  </main>;
}
