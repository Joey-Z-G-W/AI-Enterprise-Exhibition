import { useEffect, useRef, useState } from "react";
import { jsonRequest, messageFor, post, request, RequestError } from "./lib/api";
import { startPlayback, type Playback } from "./lib/webrtc";
import { recordingMessage } from "./lib/recording";
import { createContinuousCapture, type ContinuousCapture, type CaptureStatus } from "./lib/continuousCapture";
import { createVoiceSegments, segmentWav, VOICE_RESOURCE_UNKNOWN, type VoiceSegments, type VoiceCandidate } from "./lib/voiceSegments";
import { PRESET_QUESTIONS } from "./presetQuestions";
import { AvatarPlayer } from "./components/AvatarPlayer";
import { MaterialPlayer } from "./components/MaterialPlayer";
import { createPresentationCoordinator, readPresentation, type Presentation, type MaterialCommands } from "./lib/presentationCoordinator";
import { wavDuration } from "./lib/receiverClock";

const DEMO_TEXT = "欢迎来到我们的展厅。这是一段固定文本演示，用于体验数字人的声音与口型。";
const WELCOME_TEXT = "您好，欢迎来到我们的展厅！您可以直接向我提问，也可以选择下方的问题。我会根据现有资料为您介绍。";
const CANCELLATION_UNKNOWN = "旧问答取消尚未确认，新的问题暂不提交。请断开后重新连接并重新选择问题，或联系工作人员。";
type Connection = "idle" | "connecting" | "ready" | "playing" | "disconnecting" | "error";
type BusinessResult = {
  visitor_id: string; turn_id: string; turn_seq: number;
  status: "answer" | "clarify" | "handoff" | "error";
  text: string; error_code?: string | null;
  presentation?: unknown;
  sources: { excerpt: string; source: { status: "known" | "unknown"; filename: string | null } }[];
};
type UIConfig = Readonly<{ avatar_id: string; tts_voice: string }>;
type ActiveSession = {
  mediaSessionId: string | null; visitorId: string; controller: AbortController; playback?: Playback; events?: EventSource;
  uiConfig?: UIConfig;
  initializationDeadline?: number; initializationComplete?: boolean; upload?: Promise<boolean>; uploadUnknown?: boolean; mediaReady?: boolean; creation?: Promise<string>; creationRejected?: boolean; retirement?: Promise<boolean>;
};
type TurnIdentity = { visitorId: string; turnId: string; turnSeq: number };
type BusinessBarrier = { visitorId: string; through: number; status: "pending" | "unknown" | "confirmed"; promise: Promise<boolean> };
type ConversationTurn = TurnIdentity & {
  question: string; input: "text" | "voice";
  status: "requesting" | "recording" | "transcribing" | "pending" | "completed" | "cancelled" | "error" | "no_text";
  result?: BusinessResult; error?: string; speechStatus?: string;
};
const conversationLabels: Record<ConversationTurn["status"], string> = {
  requesting: "等待麦克风授权", recording: "正在录音", transcribing: "正在识别",
  pending: "正在查询资料", completed: "已完成", cancelled: "已取消", error: "处理失败", no_text: "未识别到文字",
};
type VoiceTurn = { visitorId: string; session: ActiveSession };
type Duck = { session: ActiveSession; element: HTMLVideoElement; original: number; value: number; candidates: Set<VoiceCandidate> };
const STOP_PHRASES = new Set(["停", "停止", "停下", "停一下", "先停一下", "暂停", "暂停一下", "先暂停", "别说了", "先别说了", "不要说了", "不要继续说了", "停止讲解", "暂停讲解", "安静一下"]);
const ACKNOWLEDGEMENTS = new Set(["好", "好的", "好啊", "好吧", "行", "可以", "是", "是的", "对", "对的", "对呀", "对啊", "知道了", "明白了", "了解了", "收到", "没错"]);

function speechIntent(text: string, duringResponse: boolean): "ignore" | "stop" | "question" {
  const whole = text.replace(/^[\s。！？!?.,，；;、:：]+|[\s。！？!?.,，；;、:：]+$/gu, "");
  if (STOP_PHRASES.has(whole)) return "stop";
  if (!whole || /^[嗯呃额唔啊哦噢\s。！？!?.,，；;、:：]+$/u.test(whole)) return "ignore";
  if (duringResponse && ACKNOWLEDGEMENTS.has(whole)) return "ignore";
  return "question";
}
type Timing = { trace: string; turnSeq: number; kind: "answer" | "demo" | "welcome"; started: number; finished?: boolean; rendered?: boolean };
type PreparedAudio = { blob: Blob } | { error: unknown };
type Speech = {
  session: ActiveSession; visitorId: string; turnId?: string; kind: "answer" | "demo" | "welcome";
  phase: "preparing" | "sent" | "playing" | "ended"; acknowledged: boolean;
  texts: string[]; index: number; future?: Promise<PreparedAudio>; timing: Timing;
  controller: AbortController; draining?: boolean; prepared?: Blob; mediaStarted: boolean;
  presentation?: Presentation; presentationToken?: number; receiverEnded?: boolean; segmentId?: string;
  audioOnlyFallback?: boolean; audioDuration?: number; serverEndedAt?: number; fallbackTimer?: number;
};

function recordTiming(timing: Timing, stage: string, segment = -1) {
  const now = performance.now();
  console.info("guide_timing", JSON.stringify({ trace: timing.trace, turnSeq: timing.turnSeq,
    kind: timing.kind, segment, stage, at_ms: now, elapsed_ms: now - timing.started }));
}

function endTiming(timing: Timing, stage: "cancelled" | "failed", segment = -1) {
  if (timing.finished) return;
  recordTiming(timing, stage, segment);
  timing.finished = true;
}

function answerSegments(text: string): string[] {
  // Natural boundaries only: retain every character, including spaces and punctuation.
  if (typeof Intl.Segmenter !== "function") return [text];
  const sentences = Array.from(new Intl.Segmenter("zh", { granularity: "sentence" }).segment(text), item => item.segment);
  return sentences.length && sentences.join("") === text ? sentences : [text];
}
const labels: Record<Connection, string> = {
  idle: "尚未连接", connecting: "正在准备数字人", ready: "媒体已连接，等待播放",
  playing: "画面播放中", disconnecting: "正在断开", error: "连接失败",
};
const answerLabels = { answer: "导览回答", clarify: "需要澄清", handoff: "资料暂无法确认", error: "服务暂不可用" };

function isUIConfig(value: unknown): value is UIConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const fields = Object.keys(value);
  if (fields.length !== 2 || !fields.includes("avatar_id") || !fields.includes("tts_voice")) return false;
  return Object.values(value).every((field) => typeof field === "string"
    && Array.from(field).length >= 1 && Array.from(field).length <= 128 && !/\s/u.test(field));
}

function isBusinessResult(value: unknown): value is BusinessResult {
  if (!value || typeof value !== "object") return false;
  const item = value as BusinessResult;
  return typeof item.visitor_id === "string" && !!item.visitor_id && typeof item.turn_id === "string" && !!item.turn_id && !("session_id" in item)
    && Number.isSafeInteger(item.turn_seq) && item.turn_seq > 0
    && Object.hasOwn(answerLabels, item.status) && typeof item.text === "string"
    && Array.isArray(item.sources) && item.sources.every((citation) =>
      citation && typeof citation.excerpt === "string" && citation.source
      && ["known", "unknown"].includes(citation.source.status)
      && (citation.source.status === "unknown" || typeof citation.source.filename === "string"));
}

function isPrecreationRejection(status: number, body: unknown): boolean {
  if (!body || typeof body !== "object" || Object.keys(body).length !== 1 || !("detail" in body)) return false;
  const detail = body.detail;
  // Fixed upstream validates these before session_service.create_session (routes/sessions.py).
  if (status === 404) return detail === "avatar not found" || detail === "persona not found";
  if (status === 400 && typeof detail === "string") {
    return ["invalid avatar_id", "avatar_id and model are required unless persona_id is provided",
      "user_id is too long", "user_id must not contain whitespace"].includes(detail)
      || detail.startsWith("invalid avatar: ")
      || detail.startsWith("model 'quicktalk' is not yet supported on this deployment. Currently available: ");
  }
  // FastAPI request-body validation runs before the create handler; other 422 bodies are unknown.
  return status === 422 && Array.isArray(detail) && detail.length > 0 && detail.every((entry: unknown) => {
    if (!entry || typeof entry !== "object") return false;
    const error = entry as { loc?: unknown; type?: unknown; msg?: unknown };
    return Array.isArray(error.loc) && error.loc[0] === "body"
      && error.loc.every((part: unknown) => typeof part === "string" || (typeof part === "number" && Number.isInteger(part)))
      && typeof error.type === "string" && !!error.type && typeof error.msg === "string" && !!error.msg;
  });
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
  const material = useRef<MaterialCommands>(null);
  const coordinator = useRef(createPresentationCoordinator(() => material.current));
  const [historyOpen, setHistoryOpen] = useState(false);
  const [frameScale, setFrameScale] = useState(() => Math.min(innerWidth / 1920, innerHeight / 1080));
  useEffect(() => {
    const resize = () => setFrameScale(Math.min(innerWidth / 1920, innerHeight / 1080));
    window.addEventListener("resize", resize); return () => window.removeEventListener("resize", resize);
  }, []);
  const visitorId = useRef<string | null>(null);
  const turnSequence = useRef(0);
  const businessBarrier = useRef<BusinessBarrier | null>(null);
  if (visitorId.current === null) visitorId.current = crypto.randomUUID();
  const active = useRef<ActiveSession | null>(null);
  const retired = useRef<ActiveSession | null>(null);
  const bargeRecovery = useRef<object | null>(null);
  const modeRef = useRef<"assistant" | "human">("assistant");
  const transition = useRef<object | null>(null);
  const visitorReset = useRef<object | null>(null);
  const generation = useRef(0);
  const busy = useRef(false);
  const voiceTurn = useRef<VoiceTurn | null>(null);
  const voiceSubmission = useRef<object | null>(null);
  const utteranceCandidate = useRef<(VoiceCandidate & { realSpeech: boolean }) | null>(null);
  const duck = useRef<Duck | null>(null);
  const switchDuck = useRef<VoiceCandidate | null>(null);
  const microphone = useRef<ContinuousCapture | null>(null);
  const segments = useRef<VoiceSegments | null>(null);
  const [voiceResourceUnknown, setVoiceResourceUnknown] = useState(false);
  const [captureStatus, setCaptureStatus] = useState<CaptureStatus>("closed");
  const [captureHint, setCaptureHint] = useState("麦克风已关闭。");
  const speechTimer = useRef<number>();
  const speech = useRef<Speech | null>(null);
  const pendingSpeech = useRef<Speech | null>(null);
  const questionTurn = useRef<TurnIdentity & { session: ActiveSession; spoken: boolean; settled: boolean; controller: AbortController; timing: Timing } | null>(null);
  const [connection, setConnection] = useState<Connection>("idle");
  const [mode, setMode] = useState<"assistant" | "human">("assistant");
  const [transitioning, setTransitioning] = useState(false);
  const [resettingVisitor, setResettingVisitor] = useState(false);
  const [handoff, setHandoff] = useState({ question: "", reason: "" });
  const [notice, setNotice] = useState("");
  const [businessWarning, setBusinessWarning] = useState("");
  const [mediaWarning, setMediaWarning] = useState("");
  const [soundBlocked, setSoundBlocked] = useState(false);
  const [question, setQuestion] = useState("");
  const [submittedQuestion, setSubmittedQuestion] = useState("");
  const [answer, setAnswer] = useState<BusinessResult | null>(null);
  const [questionError, setQuestionError] = useState("");
  const [pending, setPending] = useState(false);
  const [demoStatus, setDemoStatus] = useState("");
  const [welcomeStatus, setWelcomeStatus] = useState("");
  const [speechPending, setSpeechPending] = useState(false);
  const [answerSpeechStatus, setAnswerSpeechStatus] = useState("");
  const [recordingState, setRecordingState] = useState<"idle" | "requesting" | "recording" | "transcribing">("idle");
  const [recordingHint, setRecordingHint] = useState("");
  const [conversation, setConversation] = useState<ConversationTurn[]>([]);
  const conversationList = useRef<HTMLDivElement>(null);
  const followConversation = useRef(true);
  const [presetPreparing, setPresetPreparing] = useState(false);
  const current = (session: ActiveSession) => modeRef.current === "assistant"
    && active.current === session && session.visitorId === visitorId.current && !session.controller.signal.aborted;
  // The audible old segment keeps its identity while a newer question is prepared.
  const currentSpeech = (item: Speech) => current(item.session) && item.visitorId === visitorId.current && speech.current === item;
  const preparingSpeech = (item: Speech) => current(item.session) && !item.controller.signal.aborted
    && !item.draining && (speech.current === item || pendingSpeech.current === item);
  const setSpeechStatus = (item: Speech, text: string) => {
    if (item.kind === "demo") setDemoStatus(text);
    else if (item.kind === "welcome") setWelcomeStatus(text);
    else {
      if (questionTurn.current?.turnId === item.turnId) setAnswerSpeechStatus(text);
      if (item.turnId) updateConversation({ visitorId: item.visitorId, turnId: item.turnId }, { speechStatus: text });
    }
  };

  if (!segments.current) segments.current = createVoiceSegments(
    () => {
      const session = active.current, barrier = businessBarrier.current;
      return !!session?.mediaReady && current(session) && !transition.current && !visitorReset.current
        && !bargeRecovery.current
        && (barrier?.visitorId !== visitorId.current || barrier.status === "confirmed");
    },
    (samples, valid, candidate) => submitRecordedAudio(samples, valid, candidate),
    setRecordingHint,
    setVoiceResourceUnknown,
  );

  function restoreDuck() {
    const state = duck.current;
    duck.current = null;
    if (state && active.current === state.session && video.current === state.element
      && state.element.volume === state.value) state.element.volume = state.original;
  }

  function releaseSwitchDuck() {
    switchDuck.current?.releaseDuck();
    switchDuck.current = null;
    setPresetPreparing(false);
  }

  function newVoiceCandidate(): VoiceCandidate & { realSpeech: boolean } {
    let released = false;
    const candidate: VoiceCandidate & { realSpeech: boolean } = {
      duringResponse: busy.current || speech.current !== null,
      realSpeech: false,
      releaseDuck: () => {
        if (released) return;
        released = true;
        const state = duck.current;
        if (state?.candidates.delete(candidate) && state.candidates.size === 0) restoreDuck();
      },
    };
    return candidate;
  }

  function duckCandidate(candidate: VoiceCandidate) {
    const session = active.current, element = video.current;
    if (!session || !current(session) || !element) return;
    let state = duck.current;
    if (!state || state.session !== session || state.element !== element) {
      restoreDuck();
      state = { session, element, original: element.volume, value: Math.min(element.volume, 0.2), candidates: new Set() };
      duck.current = state;
    } else if (element.volume !== state.value) {
      // A new onset may duck again, but remember the user's latest volume setting.
      state.original = element.volume; state.value = Math.min(element.volume, 0.2);
    }
    state.candidates.add(candidate);
    element.volume = state.value;
  }

  function discardVoice(keepUtterance = false) {
    voiceSubmission.current = null;
    setRecordingHint("");
    segments.current?.invalidate();
    if (!keepUtterance) {
      utteranceCandidate.current?.releaseDuck();
      utteranceCandidate.current = null;
    }
    // A submitted replacement owns its own duck until media_started or failure.
    // Stopping capture releases only the candidate owners above.
    if (!keepUtterance) microphone.current?.discardSegment();
    const turn = voiceTurn.current;
    if (turn) {
      voiceTurn.current = null;
      setRecordingState("idle");
    }
  }

  function stopMicrophone() {
    discardVoice();
    const owner = microphone.current;
    setCaptureStatus("closed");
    setCaptureHint("麦克风已关闭，已提交的回答可继续播报。");
    if (owner) void owner.stop().then(released => {
      if (released && microphone.current === owner) microphone.current = null;
    });
  }

  function requestMicrophone() {
    segments.current?.recover();
    if (microphone.current) return;
    setCaptureStatus("requesting");
    setCaptureHint("请允许麦克风访问。");
    const visitor = visitorId.current;
    const owner = createContinuousCapture((status, hint) => queueMicrotask(() => {
      if (microphone.current !== owner) return;
      setCaptureStatus(status); setCaptureHint(hint);
      if (status === "closed" || status === "error") discardVoice();
      if (owner.released) microphone.current = null;
    }), { onSpeechStart: () => {
      if (microphone.current !== owner || visitorId.current !== visitor || modeRef.current !== "assistant") return;
      utteranceCandidate.current?.releaseDuck();
      utteranceCandidate.current = newVoiceCandidate();
    }, onSegment: audio => {
      if (microphone.current !== owner || visitorId.current !== visitor || modeRef.current !== "assistant") return;
      const candidate = utteranceCandidate.current ?? newVoiceCandidate();
      utteranceCandidate.current = null;
      segments.current?.enqueue(audio, candidate);
    }, onSpeechRealStart: () => {
      if (microphone.current === owner && visitorId.current === visitor && modeRef.current === "assistant"
        && utteranceCandidate.current) {
        utteranceCandidate.current.realSpeech = true;
        duckCandidate(utteranceCandidate.current);
      }
    }, onVADMisfire: () => {
      if (microphone.current !== owner || visitorId.current !== visitor) return;
      utteranceCandidate.current?.releaseDuck(); utteranceCandidate.current = null;
    } });
    microphone.current = owner;
  }

  function updateConversation(identity: Pick<TurnIdentity, "visitorId" | "turnId"> & Partial<TurnIdentity>, patch: Partial<ConversationTurn>, append = false) {
    setConversation((rows) => {
      // Check inside the queued updater too: reset may run before React applies it.
      if (identity.visitorId !== visitorId.current) return rows;
      const index = rows.findIndex((row) => row.visitorId === identity.visitorId && row.turnId === identity.turnId);
      if (index < 0) return append
        ? [...rows, { ...identity, turnSeq: identity.turnSeq ?? 0, question: "", input: "text" as const, status: "pending" as const, ...patch }].slice(-20)
        : rows;
      if (rows[index].status === "cancelled") return rows;
      return rows.map((row, position) => position === index ? { ...row, ...patch } : row);
    });
  }

  useEffect(() => {
    const list = conversationList.current;
    if (list && followConversation.current) list.scrollTop = list.scrollHeight;
  }, [conversation]);

  useEffect(() => {
    const turn = questionTurn.current;
    if (!answer || !turn || turn.visitorId !== answer.visitor_id || turn.turnId !== answer.turn_id
      || turn.turnSeq !== answer.turn_seq || turn.timing.rendered) return;
    // React has committed the answer DOM; this is not a measurement of screen paint.
    turn.timing.rendered = true;
    recordTiming(turn.timing, "answer_render_committed");
  }, [answer]);

  function matchesSpeechEvent(item: Speech, event: Event) {
    try {
      const payload = JSON.parse((event as MessageEvent).data);
      return !!item.segmentId && payload.session_id === item.session.mediaSessionId && payload.segment_id === item.segmentId;
    } catch { return false; }
  }

  function finishSpeech(item: Speech) {
    if (!currentSpeech(item) || item.phase !== "ended" || !item.acknowledged) return;
    if (!item.draining && !item.mediaStarted) {
      window.clearTimeout(speechTimer.current);
      item.session.playback?.receiver?.cancel();
      if (item.presentationToken !== undefined) coordinator.current.end(item.presentationToken);
      endTiming(item.timing, "failed", item.index);
      item.controller.abort();
      item.future = undefined;
      setSpeechStatus(item, "未确认本段开始播放，已停止后续播报；文字保留，您可以重新提问。");
      speech.current = null;
      releaseSwitchDuck();
      refreshBusy();
      segments.current?.pump();
      return;
    }
    if (item.presentation && !item.receiverEnded) return;
    if (!item.draining && item.audioOnlyFallback && item.serverEndedAt !== undefined) {
      // No receiver clock can prove drain here. Stay black and allow a whole
      // WAV plus margin after the server producer ended, for every fallback segment.
      const remaining = item.serverEndedAt + Math.max(1500, (item.audioDuration ?? 0) * 1000 + 500) - performance.now();
      if (remaining > 0) {
        if (item.fallbackTimer === undefined) item.fallbackTimer = window.setTimeout(() => {
          item.fallbackTimer = undefined; finishSpeech(item);
        }, remaining);
        return;
      }
      recordTiming(item.timing, "audio_only_completion_guard", item.index);
    }
    window.clearTimeout(speechTimer.current);
    recordTiming(item.timing, "segment_complete", item.index);
    if (item.presentationToken !== undefined) coordinator.current.sentenceEnd(item.presentationToken, item.index);
    if (!item.draining && item.index + 1 < item.texts.length) {
      const prepared = item.future;
      item.future = undefined;
      item.index += 1;
      item.phase = "preparing";
      item.acknowledged = false;
      item.mediaStarted = false;
      void playSpeechSegment(item, prepared);
      return;
    }
    if (!item.draining) item.timing.finished = true;
    if (item.presentationToken !== undefined) coordinator.current.end(item.presentationToken);
    setSpeechStatus(item, item.draining ? "当前段已结束，旧回答后续不再播报。" : item.kind === "welcome" ? "欢迎语播报结束，您可以继续提问" : item.kind === "demo" ? "固定文本播报结束" : "回答播报结束");
    item.controller.abort();
    speech.current = null;
    promotePreparedSpeech();
    refreshBusy();
    segments.current?.pump();
  }

  function refreshBusy() {
    busy.current = !!speech.current || !!pendingSpeech.current || !!(questionTurn.current && !questionTurn.current.settled);
    setSpeechPending(!!speech.current || !!pendingSpeech.current);
  }

  function promotePreparedSpeech() {
    const item = pendingSpeech.current;
    if (speech.current || !item?.prepared || !preparingSpeech(item) || item.session.uploadUnknown) return;
    pendingSpeech.current = null;
    speech.current = item;
    const blob = item.prepared;
    item.prepared = undefined;
    void playSpeechSegment(item, Promise.resolve({ blob }));
  }

  function newTurn(): TurnIdentity {
    return { visitorId: visitorId.current!, turnId: crypto.randomUUID(), turnSeq: ++turnSequence.current };
  }

  function invalidateBusiness(visitor: string, through: number, retire = false): Promise<boolean> {
    if (through === 0 && !retire) return Promise.resolve(true);
    const barrier: BusinessBarrier = { visitorId: visitor, through, status: "pending", promise: Promise.resolve(false) };
    businessBarrier.current = barrier;
    if (visitorId.current === visitor) setBusinessWarning("正在确认旧问答取消；确认前不会提交新的问题。");
    barrier.promise = (async () => {
      try {
        // Independent request: the media AbortController is about to be aborted.
        const result = await jsonRequest<{ visitor_id: string; cancelled_through: number; retired: boolean }>(
          `/guide/visitors/${encodeURIComponent(visitor)}/invalidate`, post({ through_turn_seq: through, retire }), 3000,
        );
        return result.visitor_id === visitor && Number.isSafeInteger(result.cancelled_through)
          && result.cancelled_through >= through && (!retire || result.retired === true);
      } catch { return false; }
    })().then((confirmed) => {
      barrier.status = confirmed ? "confirmed" : "unknown";
      if (businessBarrier.current === barrier && visitorId.current === visitor) {
        setBusinessWarning(confirmed ? "" : CANCELLATION_UNKNOWN);
        segments.current?.pump();
      }
      return confirmed;
    });
    return barrier.promise;
  }

  function detach(cancelBusiness = true, keepCapture = false, keepUtterance = false): ActiveSession | null {
    coordinator.current.clear();
    bargeRecovery.current = null;
    if (!keepCapture) stopMicrophone();
    else discardVoice(keepUtterance);
    releaseSwitchDuck();
    restoreDuck();
    if (cancelBusiness) {
      const visitor = active.current?.visitorId ?? visitorId.current!;
      void invalidateBusiness(visitor, turnSequence.current);
    }
    questionTurn.current?.controller.abort();
    if (pendingSpeech.current) endTiming(pendingSpeech.current.timing, "cancelled", pendingSpeech.current.index);
    pendingSpeech.current?.controller.abort();
    pendingSpeech.current = null;
    generation.current += 1;
    const session = active.current;
    if (session) setConversation((rows) => rows.map((row) =>
      row.visitorId === session.visitorId && ["requesting", "recording", "transcribing", "pending"].includes(row.status)
        ? { ...row, status: "cancelled" } : row));
    active.current = null;
    if (session) retired.current = session;
    transition.current = null;
    setTransitioning(false);
    voiceTurn.current = null;
    session?.controller.abort();
    session?.events?.close();
    session?.playback?.close();
    window.clearTimeout(speechTimer.current);
    if (speech.current) {
      speech.current.controller.abort();
      endTiming(speech.current.timing, "cancelled", speech.current.index);
      speech.current.future = undefined;
      setSpeechStatus(speech.current, "播报已停止，文字保留。");
    }
    if (questionTurn.current) endTiming(questionTurn.current.timing, "cancelled");
    speech.current = null;
    questionTurn.current = null;
    busy.current = false;
    setPending(false);
    setSpeechPending(false);
    setSoundBlocked(false);
    setRecordingState("idle");
    setRecordingHint("");
    return session;
  }

  async function closeRetired(): Promise<boolean> {
    const session = retired.current;
    if (!session) return true;
    // No creation promise means POST has not started (configuration may still
    // be pending). Its late result is identity-guarded and cannot create media.
    if (!session.creation && !session.mediaSessionId) {
      if (retired.current === session) retired.current = null;
      return true;
    }
    if (session.retirement) return session.retirement;
    session.retirement = (async () => {
      // HTTP abort is not a remote upload cancellation acknowledgement. Do not
      // put final interrupt/close ahead of a potentially late audio enqueue.
      if (session.uploadUnknown || (session.upload && !await session.upload)) return false;
      if (retired.current !== session) return false;
      // A cancelled creation can still return a server ID; never create another meanwhile.
      if (!session.mediaSessionId) {
        try { session.mediaSessionId = await session.creation ?? null; }
        catch { if (!session.creationRejected) return false; }
        if (retired.current !== session) return false;
      }
      // QuickTalk initialization is independent of close commands. A transient
      // closed/404 before initialization completes cannot authorize replacement.
      if (session.mediaSessionId && !session.creationRejected && !session.initializationComplete) {
        const deadline = session.initializationDeadline!;
        try {
          while (!session.initializationComplete && Date.now() < deadline) {
            const response = await request(`/opentalking/sessions/${encodeURIComponent(session.mediaSessionId)}`, {}, Math.min(3000, deadline - Date.now()));
            if (retired.current !== session) return false;
            if (response.ok) {
              const state = await response.json();
              if (retired.current !== session || state.session_id !== session.mediaSessionId) return false;
              session.initializationComplete = ["worker_ready", "ready", "speaking", "error"].includes(state.state);
            } else if (response.status !== 404) return false;
            if (!session.initializationComplete) await new Promise(resolve => window.setTimeout(resolve, 750));
            if (retired.current !== session) return false;
          }
        } catch { return false; }
        if (!session.initializationComplete || retired.current !== session) return false;
      }
      const closed = session.creationRejected === true || (session.mediaSessionId ? await releaseSession(session.mediaSessionId) : false);
      if (closed && retired.current === session) { retired.current = null; setMediaWarning(""); }
      return closed;
    })();
    try { return await session.retirement; }
    finally { session.retirement = undefined; }
  }

  async function disconnect(failure = "") {
    if (failure) {
      if (speech.current) endTiming(speech.current.timing, "failed", speech.current.index);
      if (questionTurn.current) endTiming(questionTurn.current.timing, "failed");
    }
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
    const untranscribed = !visitorReset.current && voiceTurn.current && recordingState !== "idle";
    setHandoff({
      question: visitorReset.current ? "" : text ?? (pending ? submittedQuestion : question.trim() || submittedQuestion),
      reason: reason + (untranscribed ? " 本轮录音已取消，尚未获得文字。" : ""),
    });
    modeRef.current = "human";
    setMode("human");
    await disconnect();
  }

  useEffect(() => {
    const dispose = () => {
      bargeRecovery.current = null;
      voiceSubmission.current = null;
      segments.current?.invalidate();
      utteranceCandidate.current?.releaseDuck(); utteranceCandidate.current = null;
      releaseSwitchDuck();
      restoreDuck();
      const capture = microphone.current; microphone.current = null; void capture?.stop();
      void fetch(`/guide/visitors/${encodeURIComponent(visitorId.current!)}/invalidate`, {
        ...post({ through_turn_seq: turnSequence.current, retire: true }), keepalive: true,
      }).catch(() => {}); // best effort only; no claim of an acknowledged retirement
      const session = active.current;
      active.current = null;
      if (session) retired.current = session;
      generation.current += 1;
      transition.current = null;
      visitorReset.current = null;
      questionTurn.current?.controller.abort();
      if (pendingSpeech.current) endTiming(pendingSpeech.current.timing, "cancelled", pendingSpeech.current.index);
      pendingSpeech.current?.controller.abort();
      pendingSpeech.current = null;
      voiceTurn.current = null;
      session?.controller.abort();
      session?.events?.close();
      session?.playback?.close();
      window.clearTimeout(speechTimer.current);
      if (speech.current) {
        speech.current.controller.abort();
        endTiming(speech.current.timing, "cancelled", speech.current.index);
        speech.current.future = undefined;
      }
      if (questionTurn.current) endTiming(questionTurn.current.timing, "cancelled");
      speech.current = null;
      questionTurn.current = null;
      // Best effort during page exit; retain the same upload/init/GET-close
      // barriers instead of issuing an early close ahead of a pending upload.
      void closeRetired();
    };
    window.addEventListener("pagehide", dispose);
    return () => { window.removeEventListener("pagehide", dispose); dispose(); };
  }, []);

  async function connect(intent: "connect" | "resume" | "barge" | "reset" | "preset" = "connect") {
    if (active.current || transition.current || (visitorReset.current && intent !== "reset")
      || (connection === "disconnecting" && intent !== "reset")
      || (modeRef.current === "human" && intent !== "resume" && intent !== "reset")) return;
    const token = {};
    if (intent === "connect" || intent === "resume") requestMicrophone();
    transition.current = token;
    setTransitioning(true);
    const barrier = businessBarrier.current;
    // Explicit reconnect can retry an unknown watermark once; internal media
    // rebuilding neither retries it nor treats connection success as its ACK.
    if ((intent === "connect" || intent === "resume") && barrier?.visitorId === visitorId.current && barrier.status === "unknown") {
      void invalidateBusiness(barrier.visitorId, barrier.through);
    }
    const epoch = generation.current;
    setNotice("正在确认旧会话已关闭…");
    const released = await closeRetired();
    if (transition.current !== token || epoch !== generation.current) return;
    if (!released) {
      stopMicrophone();
      transition.current = null;
      setTransitioning(false);
      setNotice("旧会话释放未确认，保持声画关闭；请重试或联系工作人员。");
      return;
    }
    modeRef.current = "assistant";
    setMode("assistant");
    const session: ActiveSession = { mediaSessionId: null, visitorId: visitorId.current!, controller: new AbortController() };
    active.current = session;
    generation.current += 1;
    setConnection("connecting");
    setNotice("");
    setDemoStatus("");
    setQuestionError("");
    let welcomeSession: ActiveSession | undefined;
    try {
      const config = await jsonRequest<unknown>("/guide/ui-config", { signal: session.controller.signal }, 10000);
      if (!current(session)) return;
      if (!isUIConfig(config)) throw new RequestError("response");
      session.uiConfig = Object.freeze({ avatar_id: config.avatar_id, tts_voice: config.tts_voice });
      // Let creation return its ID after a local cancel so the abandoned session can be deleted.
      session.creation = request("/opentalking/sessions", post({
        avatar_id: session.uiConfig.avatar_id, model: "quicktalk", tts_provider: "edge", stt_provider: "sensevoice",
        tts_voice: session.uiConfig.tts_voice, agent_enabled: false, memory_enabled: false, knowledge_enabled: false,
      }), 30000).then(async (response) => {
        let created: unknown;
        try { created = await response.json(); } catch { throw new RequestError("response"); }
        if (!response.ok) {
          session.creationRejected = isPrecreationRejection(response.status, created);
          throw new RequestError("response");
        }
        if (!created || typeof created !== "object" || !("session_id" in created)
          || typeof created.session_id !== "string" || !created.session_id) throw new RequestError("response");
        session.initializationDeadline = Date.now() + 180000;
        return created.session_id;
      });
      session.mediaSessionId = await session.creation;
      if (!current(session)) { await closeRetired(); return; }
      const deadline = session.initializationDeadline!;
      while (true) {
        const status = await jsonRequest<{ state: string }>(`/opentalking/sessions/${encodeURIComponent(session.mediaSessionId)}`, { signal: session.controller.signal });
        if (!current(session)) return;
        if (["worker_ready", "ready", "speaking"].includes(status.state)) { session.initializationComplete = true; break; }
        if (status.state === "error") session.initializationComplete = true;
        if (["error", "closed"].includes(status.state)) throw new RequestError("response");
        if (Date.now() > deadline) throw new RequestError("timeout");
        await new Promise((resolve) => window.setTimeout(resolve, 750));
      }
      session.events = new EventSource(`/opentalking/sessions/${encodeURIComponent(session.mediaSessionId)}/events`);
      session.events.addEventListener("speech.media_started", event => {
        const item = speech.current;
        if (item && item.session === session && currentSpeech(item) && matchesSpeechEvent(item, event) && ["sent", "playing"].includes(item.phase)) {
          if (item.mediaStarted) return;
          if (item.presentation) session.playback?.receiver?.signalStart();
          recordTiming(item.timing, "media_started", item.index);
          item.phase = "playing";
          item.mediaStarted = true;
          if (!item.draining && item.turnId === questionTurn.current?.turnId) releaseSwitchDuck();
          setSpeechStatus(item, item.kind === "welcome" ? "欢迎语正在播报" : item.kind === "demo" ? "固定文本正在播报" : "回答正在播报");
        }
      });
      session.events.addEventListener("speech.ended", event => {
        const item = speech.current;
        if (!item || item.session !== session || !currentSpeech(item) || !matchesSpeechEvent(item, event) || !["sent", "playing"].includes(item.phase)) return;
        item.serverEndedAt = performance.now();
        recordTiming(item.timing, "ended_signal", item.index);
        if (item.presentation) session.playback?.receiver?.signalEnd();
        item.phase = "ended";
        // Keep the operation locked until its HTTP acknowledgement has also settled.
        finishSpeech(item);
      });
      session.events.onerror = () => {
        if (current(session)) void disconnect("状态连接已中断，请重新连接数字人。");
      };
      session.playback = await startPlayback(session.mediaSessionId, video.current!, session.controller.signal,
        () => { if (current(session)) setSoundBlocked(true); },
        () => { if (current(session)) void disconnect("音视频连接已断开，请重新连接。"); },
      );
      if (!current(session)) { session.playback.close(); return; }
      await jsonRequest(`/opentalking/sessions/${encodeURIComponent(session.mediaSessionId)}/start`, post({}, session.controller.signal));
      if (current(session)) {
        session.mediaReady = true;
        if (utteranceCandidate.current?.realSpeech) duckCandidate(utteranceCandidate.current);
        setConnection(video.current?.paused ? "ready" : "playing");
        microphone.current?.listen();
        if (["connect", "resume", "reset"].includes(intent)) welcomeSession = session;
      }
    } catch (error) {
      if (current(session)) await disconnect(!session.creation
        ? "人物与音色配置加载失败，未创建会话。请检查业务服务后重新连接。"
        : session.creationRejected ? "创建请求已被拒绝，未创建新会话。请检查服务后重试。" : messageFor(error));
    } finally {
      if (transition.current === token) {
        transition.current = null;
        setTransitioning(false);
        // Start after releasing the connection gate so speech can be recognized during welcome.
        if (welcomeSession && current(welcomeSession)) void speakText(welcomeSession, WELCOME_TEXT, "welcome");
        segments.current?.pump();
      }
    }
  }

  async function resetVisitor() {
    if (visitorReset.current) return;
    const token = {};
    visitorReset.current = token;
    const retirement = invalidateBusiness(visitorId.current!, turnSequence.current, true);
    // Business identity changes only for a new group, before cancelling old async work.
    visitorId.current = crypto.randomUUID();
    turnSequence.current = 0;
    setBusinessWarning("");
    detach(false);
    // Clear after detach, which may otherwise leave the previous speech-stop notice.
    setQuestion("");
    setSubmittedQuestion("");
    setAnswer(null);
    setConversation([]);
    followConversation.current = true;
    setQuestionError("");
    setHandoff({ question: "", reason: "" });
    setNotice("");
    setRecordingHint("");
    setDemoStatus("");
    setAnswerSpeechStatus("");
    modeRef.current = "assistant";
    setMode("assistant");
    setConnection("idle");
    setResettingVisitor(true);
    try {
      // The existing transition token also makes takeover/unload cancel this reconnection.
      await connect("reset");
      if (!await retirement && visitorReset.current === token && turnSequence.current === 0) setNotice("新访客已隔离；旧访客服务端清理尚未确认，请联系工作人员核实。");
    } finally {
      if (visitorReset.current === token) {
        visitorReset.current = null;
        setResettingVisitor(false);
      }
    }
  }

  async function stopSpeech(owner: ContinuousCapture | null) {
    // Only an explicit, complete stop command uses the hard retirement path.
    if (bargeRecovery.current) return;
    const session = active.current;
    if (!session?.mediaReady || !current(session) || transition.current || visitorReset.current
      || (!busy.current && !speech.current && !voiceTurn.current)) return;
    if (video.current) video.current.muted = true;
    detach(true, true, true); // Preserve another utterance already in progress during STT.
    const token = {};
    bargeRecovery.current = token;
    voiceSubmission.current = token;
    setConnection("idle");
    setNotice("已收到停止指令，正在停止旧播报。");
    try {
      await connect("barge");
      const next = active.current;
      const maySubmit = () => voiceSubmission.current === token && microphone.current === owner;
      if (!maySubmit() || bargeRecovery.current !== token || !next?.mediaReady || !current(next)) return;
      voiceSubmission.current = null;
      setNotice("播报已停止，您可以继续提问。");
    }
    finally {
      if (bargeRecovery.current === token) { bargeRecovery.current = null; segments.current?.pump(); }
    }
  }

  async function selectPreset(text: string) {
    const session = active.current;
    if (!PRESET_QUESTIONS.some((question) => question === text) || visitorReset.current || !session?.mediaReady
      || !current(session) || transition.current || bargeRecovery.current) return;
    discardVoice();
    setRecordingHint("未提交录音已丢弃；选择问题不改变麦克风状态。");
    switchQuestion(session, text, "text");
  }

  function switchQuestion(session: ActiveSession, text: string, input: "text" | "voice", maySubmit?: () => boolean) {
    if (!current(session) || !session.mediaReady || transition.current || bargeRecovery.current) return;
    coordinator.current.clear();
    if (session.uploadUnknown) {
      setMediaWarning("旧音频上传结果未确认，新的语音不会提交；请联系现场工作人员。");
      return;
    }
    const previous = questionTurn.current;
    const through = turnSequence.current;
    if (previous) {
      previous.controller.abort();
      endTiming(previous.timing, "cancelled");
      if (!previous.settled) updateConversation(previous, { status: "cancelled" });
    }
    if (pendingSpeech.current) endTiming(pendingSpeech.current.timing, "cancelled", pendingSpeech.current.index);
    pendingSpeech.current?.controller.abort();
    pendingSpeech.current = null;
    const old = speech.current;
    if (old) {
      old.draining = true;
      endTiming(old.timing, "cancelled", old.index);
      old.controller.abort(); // Cancels only TTS, never the independent upload ACK.
      old.future = undefined;
      if (old.phase === "preparing") {
        // Nothing from this segment was uploaded, so there is no ended to await.
        speech.current = null;
        window.clearTimeout(speechTimer.current);
      }
    }
    if (speech.current && !switchDuck.current) {
      switchDuck.current = newVoiceCandidate();
      duckCandidate(switchDuck.current);
    }
    setPresetPreparing(true);
    setQuestion(text);
    // Watermark only the old turns; sendQuestion allocates the strictly newer one.
    if (through > 0) void invalidateBusiness(session.visitorId, through);
    void sendQuestion(session, text, undefined, input, maySubmit);
  }

  async function sendQuestion(session: ActiveSession, text: string, identity?: TurnIdentity, input: "text" | "voice" = identity ? "voice" : "text", maySubmit?: () => boolean) {
    if (!current(session)) return;
    const turnIdentity = identity ?? newTurn();
    const turn = { session, ...turnIdentity, spoken: false, settled: false, controller: new AbortController(), timing: {
      trace: crypto.randomUUID(), turnSeq: turnIdentity.turnSeq, kind: "answer" as const, started: performance.now(),
    } };
    if (turn.visitorId !== visitorId.current) return;
    questionTurn.current = turn;
    busy.current = true;
    const valid = () => current(session) && questionTurn.current === turn;
    updateConversation(turn, { question: text, input, status: "pending" }, true);
    setPending(true);
    setSubmittedQuestion(text);
    setAnswer(null);
    setQuestionError("");
    setAnswerSpeechStatus("");
    try {
      let barrier;
      do {
        barrier = businessBarrier.current;
        const confirmed = barrier?.visitorId !== turn.visitorId || await barrier.promise;
        if (!valid()) return;
        // A superseded acknowledgement must not paint an error for the latest turn.
        if (businessBarrier.current !== barrier) continue;
        if (!confirmed) {
          endTiming(turn.timing, "failed");
          setQuestionError(CANCELLATION_UNKNOWN);
          updateConversation(turn, { status: "error", error: CANCELLATION_UNKNOWN });
          return;
        }
      } while (businessBarrier.current !== barrier && businessBarrier.current?.visitorId === turn.visitorId);
      // Stopping capture may discard recognized speech until this exact submission
      // boundary. Once POST starts, its answer has an independent lifecycle.
      if (maySubmit && !maySubmit()) {
        endTiming(turn.timing, "cancelled");
        updateConversation(turn, { status: "cancelled" });
        return;
      }
      recordTiming(turn.timing, "question_started");
      const response = await request("/guide/questions", post({ visitor_id: turn.visitorId, turn_id: turn.turnId, turn_seq: turn.turnSeq, question: text }, turn.controller.signal), 30000);
      let body: unknown;
      try { body = await response.json(); } catch { throw new RequestError("response"); }
      if (!isBusinessResult(body) || body.visitor_id !== turn.visitorId || body.turn_id !== turn.turnId || body.turn_seq !== turn.turnSeq) throw new RequestError("response");
      if (!response.ok && body.status !== "error") throw new RequestError("response");
      if (valid()) {
        recordTiming(turn.timing, "question_ready");
        setAnswer(body);
        updateConversation(turn, { result: body, status: body.status === "error" ? "error" : "completed" });
        setPending(false);
        if (body.status === "answer" || body.status === "clarify" || body.status === "handoff") await speakText(session, body.text, "answer", turn.turnId, readPresentation(body.presentation, body.text));
        else endTiming(turn.timing, "failed");
      }
    } catch (error) {
      if (valid()) {
        endTiming(turn.timing, "failed");
        setQuestionError(messageFor(error));
        updateConversation(turn, { status: "error", error: messageFor(error) });
      }
    } finally {
      turn.settled = true;
      if (valid()) {
        if (!pendingSpeech.current && (!speech.current || speech.current.turnId !== turn.turnId)) releaseSwitchDuck();
        refreshBusy(); setPending(false); segments.current?.pump();
      }
    }
  }

  // Candidate recognition is independent of the old answer; it must not cancel it.
  async function submitRecordedAudio(samples: Float32Array, segmentValid: () => boolean, candidate: VoiceCandidate): Promise<"unknown" | void> {
    const session = active.current;
    if (visitorReset.current || !session?.mediaSessionId || !current(session)
      || !session.mediaReady) return;
    const owner = microphone.current;
    const turn: VoiceTurn = { session, visitorId: visitorId.current! };
    voiceTurn.current = turn;
    const valid = () => current(session) && turn.visitorId === visitorId.current && voiceTurn.current === turn
      && microphone.current === owner && segmentValid();
    setRecordingState("transcribing");
    setRecordingHint("正在确认这段语音，原回答继续保留。");
    try {
      if (!valid()) return;
      const form = new FormData();
      form.set("file", segmentWav(samples), "speech.wav");
      form.set("stt_provider", "sensevoice");
      const transcript = await jsonRequest<{ session_id: string; text: string }>(
        `/opentalking/sessions/${encodeURIComponent(session.mediaSessionId)}/transcribe`,
        { method: "POST", body: form }, 45000,
      );
      if (transcript.session_id !== session.mediaSessionId || typeof transcript.text !== "string") throw new RequestError("response");
      if (!valid()) return;
      const text = transcript.text.trim();
      if (text.length > 2000) { setRecordingHint("识别内容过长，原回答继续；请缩短问题后重说。"); return; }
      const intent = speechIntent(text, candidate.duringResponse);
      if (intent === "ignore") { setRecordingHint("未确认新的问题，继续原回答与监听。"); return; }
      candidate.releaseDuck();
      const interrupting = busy.current || speech.current !== null;
      voiceTurn.current = null;
      setRecordingState("idle");
      if (intent === "stop") {
        setRecordingHint("已收到停止指令，未提交问答。");
        if (interrupting) await stopSpeech(owner);
        return;
      }
      setQuestion(text);
      setRecordingHint("已确认新的问题。");
      const token = {};
      voiceSubmission.current = token;
      switchQuestion(session, text, "voice", () => voiceSubmission.current === token
        && microphone.current === owner && segmentValid());
    } catch (error) {
      if (valid()) {
        const message = error instanceof RequestError && error.kind === "timeout"
          ? "语音识别超时，请重试或选择预设问题。" : recordingMessage(error);
        setRecordingHint(message);
      }
      return "unknown";
    } finally {
      candidate.releaseDuck();
      if (valid()) {
        voiceTurn.current = null;
        setRecordingState("idle");
      }
    }
  }

  async function playDemo() {
    const session = active.current;
    if (visitorReset.current || !session?.mediaSessionId || !current(session) || busy.current) return;
    await speakText(session, DEMO_TEXT, "demo");
  }

  async function speakText(session: ActiveSession, text: string, kind: Speech["kind"], turnId?: string, presentation?: Presentation) {
    const sessionId = session.mediaSessionId;
    if (!sessionId || !current(session) || (kind !== "answer" && (speech.current || pendingSpeech.current))) return;
    if (kind === "answer") {
      const turn = questionTurn.current;
      if (!turn || turn.session !== session || turn.turnId !== turnId || turn.visitorId !== visitorId.current || turn.spoken) return;
      turn.spoken = true;
    }
    const timing = kind === "answer" ? questionTurn.current!.timing
      : { trace: crypto.randomUUID(), turnSeq: 0, kind, started: performance.now() };
    const item: Speech = { session, visitorId: session.visitorId, turnId, kind, phase: "preparing", acknowledged: false,
      texts: presentation ? presentation.sentences.map(s => s.text) : kind === "answer" ? answerSegments(text) : [text], index: 0, timing, controller: new AbortController(), mediaStarted: false, presentation };
    item.controller.signal.addEventListener("abort", () => {
      window.clearTimeout(item.fallbackTimer); item.fallbackTimer = undefined;
      if (item.draining) finishSpeech(item);
    }, { once: true });
    if (presentation && turnId) item.presentationToken = coordinator.current.begin({ visitorId: session.visitorId, turnId, sessionId, generation: generation.current }, presentation);
    if (!text.trim() || Array.from(text).length > 1000) {
      endTiming(timing, "failed");
      setSpeechStatus(item, !text.trim() ? "回答没有可播报文字，仅保留文字显示。" : "回答超过 1000 字，无法自动播报；完整文字已保留。");
      return;
    }
    pendingSpeech.current = item;
    busy.current = true;
    setSpeechPending(true);
    setSpeechStatus(item, kind === "welcome" ? "正在准备欢迎语" : kind === "demo" ? "正在合成固定演示语音" : "正在合成回答语音");
    const audio = await prepareSpeechAudio(item, 0);
    if (!preparingSpeech(item) || pendingSpeech.current !== item) return;
    if ("error" in audio) {
      pendingSpeech.current = null;
      item.controller.abort();
      endTiming(item.timing, "failed");
      setSpeechStatus(item, `语音合成未完成，文字已保留。${messageFor(audio.error)}`);
      releaseSwitchDuck();
      refreshBusy();
      if (kind !== "answer") await disconnect(`播报未完成。${messageFor(audio.error)}`);
      return;
    }
    item.prepared = audio.blob;
    promotePreparedSpeech();
  }

  async function prepareSpeechAudio(item: Speech, index: number): Promise<PreparedAudio> {
    try {
      if (!preparingSpeech(item) || !item.session.uiConfig) throw new RequestError("cancelled");
      recordTiming(item.timing, "tts_started", index);
      const audio = await request("/opentalking/tts/preview", post({ text: item.texts[index], tts_provider: "edge",
        voice: item.session.uiConfig.tts_voice }, item.controller.signal), 45000);
      if (!preparingSpeech(item)) throw new RequestError("cancelled");
      if (!audio.ok || !audio.headers.get("content-type")?.includes("audio/wav")) throw new RequestError("response");
      // request() has already read the entire HTTP body inside its timeout.
      recordTiming(item.timing, "tts_ready", index);
      const blob = await audio.blob();
      if (!preparingSpeech(item)) throw new RequestError("cancelled");
      return { blob };
    } catch (error) {
      // A future segment can fail before it is consumed: never leave a rejecting promise.
      return { error };
    }
  }

  async function playSpeechSegment(item: Speech, prepared?: Promise<PreparedAudio>) {
    const { session, kind } = item;
    const sessionId = session.mediaSessionId;
    const index = item.index;
    try {
      if (!sessionId || !currentSpeech(item) || item.draining) return;
      item.segmentId = crypto.randomUUID(); item.serverEndedAt = undefined; item.audioDuration = 0;
      const audio = await (prepared ?? prepareSpeechAudio(item, index));
      if (!currentSpeech(item) || item.draining || item.index !== index) return;
      if ("error" in audio) throw audio.error;
      if (item.presentation || item.audioOnlyFallback) {
        try { item.audioDuration = await wavDuration(audio.blob); } catch { /* Observer will fail closed. */ }
      }
      if (item.presentationToken !== undefined) {
        const ready = await coordinator.current.prepareSentence(item.presentationToken, index, item.controller.signal);
        if (!currentSpeech(item) || item.draining || item.index !== index) return;
        recordTiming(item.timing, ready ? "image_decoded" : "sentence_audio_only", index);
      }
      if (item.presentation) {
        const receiver = session.playback?.receiver;
        const duration = item.audioDuration ?? 0; let ready = false;
        try { ready = duration > 0 && !!receiver && await receiver.waitForQuiet(item.controller.signal); }
        catch { /* Presentation observation is optional; no upload has happened yet. */ }
        if (!currentSpeech(item) || item.draining || item.index !== index) return;
        if (!ready) {
          if (item.presentationToken !== undefined) coordinator.current.end(item.presentationToken);
          item.presentation = undefined; item.presentationToken = undefined; item.audioOnlyFallback = true;
          receiver?.cancel();
          recordTiming(item.timing, "receiver_unavailable_audio_only", index);
        } else {
        item.receiverEnded = false;
        receiver!.arm(duration, () => {
          if (!currentSpeech(item) || item.draining || item.index !== index) return;
          recordTiming(item.timing, "receiver_audio_started", index);
          if (item.presentationToken !== undefined) coordinator.current.cue(item.presentationToken, index);
        }, () => {
          if (!currentSpeech(item) || item.index !== index) return;
          recordTiming(item.timing, "receiver_audio_drained", index);
          if (item.presentationToken !== undefined) coordinator.current.sentenceEnd(item.presentationToken, index);
          item.receiverEnded = true; finishSpeech(item);
        }, mayUseServerCompletion => {
          if (!currentSpeech(item) || item.index !== index) return;
          if (item.presentationToken !== undefined) coordinator.current.end(item.presentationToken);
          item.presentationToken = undefined;
          if (!mayUseServerCompletion) return;
          // Optional visual observation failed. Retain ACK/media_started/ended
          // checks and queued WAVs; never report this as receiver_audio_drained.
          recordTiming(item.timing, "receiver_unobservable_server_fallback", index);
          item.presentation = undefined; item.audioOnlyFallback = true;
          finishSpeech(item);
        });
        }
      }
      const form = new FormData();
      form.set("segment_id", item.segmentId);
      form.set("file", audio.blob, kind === "welcome" ? "welcome.wav" : kind === "demo" ? "fixed-demo.wav" : "answer.wav");
      item.phase = "sent";
      setSpeechStatus(item, kind === "welcome" ? "正在发送欢迎语" : kind === "demo" ? "正在发送演示语音" : "正在发送回答语音");
      speechTimer.current = window.setTimeout(() => {
        if (currentSpeech(item) && item.index === index) {
          endTiming(item.timing, "failed", index);
          void disconnect("播报等待超时，文字已保留，媒体已关闭，请重新连接。");
        }
      }, Math.max(90000, ((item.audioDuration ?? 0) * 2 + 30) * 1000));
      recordTiming(item.timing, "upload_started", index);
      session.upload = (async () => {
        try {
          const result = await jsonRequest<{ session_id: string; status: string; segment_id: string }>(
            `/opentalking/sessions/${encodeURIComponent(sessionId)}/speak_flashtalk_audio`,
            { method: "POST", body: form }, 30000,
          );
          if (result.session_id !== sessionId || result.status !== "queued" || result.segment_id !== item.segmentId) throw new RequestError("response");
          return true;
        } catch {
          session.uploadUnknown = true;
          setMediaWarning("旧音频上传结果未确认，媒体已隔离，不会创建新会话或重传；请联系现场工作人员。");
          return false;
        }
      })();
      // Start just one future TTS only after this upload has been submitted.
      // It may finish or fail early, but cannot upload before ACK + ended below.
      if (index + 1 < item.texts.length) item.future = prepareSpeechAudio(item, index + 1);
      const uploaded = await session.upload;
      if (!currentSpeech(item) || item.index !== index) return;
      if (!uploaded) throw new RequestError("response");
      recordTiming(item.timing, "upload_ack", index);
      item.acknowledged = true;
      if (item.phase === "sent") setSpeechStatus(item, "语音已排队，等待实际播放");
      finishSpeech(item);
    } catch (error) {
      if (currentSpeech(item)) {
        endTiming(item.timing, "failed", index);
        await disconnect(`播报未完成，文字已保留。${messageFor(error)}`);
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
  return <main className="landscape-frame" style={{ transform: `translate(-50%, -50%) scale(${frameScale})` }}>
    <div className="presentation-stage">
      <AvatarPlayer ref={video} onPlaying={() => {
        if (active.current && !active.current.controller.signal.aborted) setConnection(value => value === "ready" ? "playing" : value);
      }}>
        {!connected && <div className="stage-placeholder"><div className="orbit"><span>AI</span></div><h1>{mode === "human" ? "请与现场销售交流" : "欢迎来到展厅"}</h1><p>{mode === "human" ? "麦克风与数字人声画已关闭" : connection === "connecting" ? "正在准备形象与音视频连接…" : "连接数字人，开始现场体验"}</p></div>}
        {soundBlocked && <button className="sound-button" onClick={() => void enableSound()}>开启声音</button>}
        {connected && <span className="sound-caption">{soundBlocked ? "当前静音 · 请开启声音" : "声音已启用"}</span>}
      </AvatarPlayer>
      <MaterialPlayer ref={material} />
    </div>
    <section className="control-bar" aria-label="导览控制">
      <div className="control-heading">
        <a className="brand" href="/" aria-label="展厅导览首页"><span className="brand-mark">展</span><span>展厅 · AI 导览</span></a>
        <span className={`status-pill ${connected ? "online" : ""}`} role="status"><i />{mode === "human" ? "销售接管中" : labels[connection]}</span>
        <div className="button-row">
          <button className="primary" disabled={resettingVisitor || mode === "human" || transitioning || !["idle", "error"].includes(connection)} onClick={() => void connect()}>连接数字人</button>
          <button className="secondary" disabled={!active.current || connection === "disconnecting"} onClick={() => void disconnect()}>断开</button>
          <button className="takeover-button" disabled={mode === "human"} onClick={() => void takeOver()}>销售接管</button>
          <button className="secondary" disabled={resettingVisitor} onClick={() => void resetVisitor()}>{resettingVisitor ? "正在准备新访客…" : "新一组访客"}</button>
          <button className="recording-stop" disabled={captureStatus === "closed" || captureStatus === "error"} onClick={stopMicrophone}>停止录音</button>
          <button className="secondary" disabled={resettingVisitor || mode === "human" || !connected || speechPending || pending} onClick={() => void playDemo()}>{speechPending && speech.current?.kind === "demo" ? "演示处理中…" : "播放固定演示"}</button>
          <button className="secondary" aria-expanded={historyOpen} aria-controls="conversation-history" onClick={() => setHistoryOpen(!historyOpen)}>对话记录</button>
        </div>
      </div>
      <div className="preset-questions" aria-label="推荐问题">
        {PRESET_QUESTIONS.map(text => <button type="button" key={text} className="preset-question" disabled={resettingVisitor || mode === "human" || !connected || transitioning} onClick={() => void selectPreset(text)}>{text}</button>)}
      </div>
      <div className="control-status">
        <p className="preset-hint" role="status">{presetPreparing ? "正在准备新回答，当前段结束后会接着播报，人物保持连接…" : "点击问题或直接说话，开始了解展厅。"}</p>
        <p role="status" aria-label="收音状态">{captureHint}</p>
        {recordingHint && <p role="status" aria-label="语音识别状态">{recordingHint}</p>}
        {welcomeStatus && <small role="status">{welcomeStatus}</small>}
        {demoStatus && <small role="status">{demoStatus}</small>}
        {notice && <p className="notice" role="alert">{notice}</p>}
        {businessWarning && <p className="notice business-warning" role="alert">{businessWarning}</p>}
        {mediaWarning && <p className="notice" role="alert" aria-label="媒体上传隔离">{mediaWarning}</p>}
        {voiceResourceUnknown && <p className="notice" role="alert" aria-label="语音识别资源状态">{VOICE_RESOURCE_UNKNOWN}</p>}
      </div>
      {mode === "human" && <aside className="handoff-panel" role="status">
        <h3>销售接管中</h3><p>{handoff.reason}</p><p><strong>待接管问题：</strong>{handoff.question || "尚无文字问题，请直接向销售说明。"}</p>
        <button className="secondary" disabled={resettingVisitor || transitioning || connection === "disconnecting"} onClick={() => void connect("resume")}>{transitioning ? "正在确认会话关闭…" : "恢复问答"}</button>
      </aside>}
    </section>
    <section id="conversation-history" className={`conversation-history ${historyOpen ? "is-open" : ""}`} aria-labelledby="conversation-title">
      <div className="conversation-history-heading"><button className="secondary history-close" onClick={() => setHistoryOpen(false)}>关闭记录</button>
        <div><span className="eyebrow">本组访客</span><h2 id="conversation-title">对话记录</h2><p>保留最近20轮 · 语音仅显示最终识别文字</p></div>
        <button className="secondary" onClick={() => {
          followConversation.current = true;
          if (conversationList.current) conversationList.current.scrollTop = conversationList.current.scrollHeight;
        }}>查看最新</button>
      </div>
      <div className="conversation-log" ref={conversationList} role="log" aria-label="本组最近20轮对话" aria-live="polite" tabIndex={0}
        onScroll={() => {
          const list = conversationList.current;
          if (list) followConversation.current = list.scrollHeight - list.scrollTop - list.clientHeight < 48;
        }}>
        {conversation.length === 0 ? <p className="conversation-empty">尚无对话。选择问题或完成录音后，问题、回答和来源会保留在这里。</p> : conversation.map((turn, index) => <article className="conversation-turn" key={`${turn.visitorId}:${turn.turnId}`} aria-label={`第${index + 1}轮对话`}>
          <div className="conversation-turn-heading"><span>{turn.input === "voice" ? "语音提问" : "文字提问"}</span><span className={`turn-status ${turn.status}`}>{turn.result && turn.status === "completed" ? answerLabels[turn.result.status] : conversationLabels[turn.status]}</span></div>
          <p className="conversation-question">{turn.question || (turn.status === "cancelled" ? "录音已取消，未获得最终识别文字。" : turn.status === "no_text" ? "未识别到文字，本轮未提问。" : "尚未获得最终识别文字。")}</p>
          {turn.result && <div className="conversation-answer"><span className="eyebrow">导览回答</span><p className="answer-text">{turn.result.status === "error" ? (turn.result.error_code === "service_not_configured" ? "问答服务尚未配置，暂时无法回答，请联系现场销售。" : "问答服务暂不可用，请联系现场销售。") : turn.result.text}</p>
            {turn.result.sources.length > 0 && <details className="conversation-sources"><summary>资料来源（{turn.result.sources.length}）</summary>{turn.result.sources.map((citation, sourceIndex) => <div className="sources" key={sourceIndex}><strong>{citation.source.status === "known" ? citation.source.filename : "来源未知"}</strong><p>{citation.excerpt}</p></div>)}</details>}
          </div>}
          {turn.error && <p className="notice">{turn.error}</p>}
          {turn.speechStatus && <p className="muted">{turn.speechStatus}</p>}
          {turn.status === "cancelled" && turn.question && <p className="muted">本轮处理已取消，迟到结果不会更新此记录。</p>}
        </article>)}
      </div>
    </section>
  </main>;
}
