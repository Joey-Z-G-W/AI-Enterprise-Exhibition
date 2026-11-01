const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require(path.resolve('frontend/node_modules/typescript'));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
let source = fs.readFileSync('frontend/src/App.tsx', 'utf8');
source = source.slice(0, source.indexOf('  const connected =')) + `
  return { connect, disconnect, takeOver, prepareRecording, beginRecording, playDemo, selectPreset, sendQuestion,
    active, retired, video, modeRef, voiceTurn, speech, questionTurn, busy, transition, resetVisitor, visitorReset, visitorId, resettingVisitor,
    mode, connection, notice, handoff, question, answer, recordingHint, setQuestion, pending, submittedQuestion, questionError, answerSpeechStatus, demoStatus, speechPending };
}`;
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;

function harness() {
  let cursor = 0, serial = 0, now = 0;
  const hooks = [], requests = [], captures = [], playbacks = [];
  const overrides = new Map(), states = new Map();
  const response = (body, status = 200, headers) => new Response(JSON.stringify(body), { status, headers });
  const api = {
    post: (body, signal) => ({ method: 'POST', body: JSON.stringify(body), signal }),
    RequestError: class extends Error { constructor(kind) { super(kind); this.kind = kind; } },
    messageFor: () => 'request failed',
    request: async (url, init = {}) => {
      const method = init.method || 'GET'; requests.push({ url, method, signal: init.signal, body: init.body });
      const custom = overrides.get(`${method} ${url}`);
      if (custom) return custom(init);
      if (url === '/opentalking/sessions' && method === 'POST') {
        const id = `sess_${++serial}`; states.set(id, 'ready'); return response({ session_id: id });
      }
      const id = url.split('/')[3];
      if (url.endsWith('/interrupt')) return response({ status: 'interrupted' });
      if (method === 'DELETE') { states.set(id, 'closed'); return response({ status: 'closed' }); }
      if (url.endsWith('/start')) return response({ status: 'started' });
      if (method === 'GET') return response({ session_id: id, state: states.get(id) });
      throw new Error(`unhandled request ${method} ${url}`);
    },
  };
  api.jsonRequest = async (...args) => { const result = await api.request(...args); if (!result.ok) throw new api.RequestError('response'); return result.json(); };
  const react = {
    useRef: (initial) => { const index = cursor++; return hooks[index] ??= { current: initial }; },
    useState: (initial) => { const index = cursor++; if (!(index in hooks)) hooks[index] = initial; return [hooks[index], (value) => { hooks[index] = typeof value === 'function' ? value(hooks[index]) : value; }]; },
    useEffect: () => {},
  };
  const exported = {};
  const sandbox = {
    exports: exported, AbortController, Response, Blob, FormData, crypto: require('node:crypto').webcrypto,
    Date: { now: () => now },
    window: { setTimeout: (callback, delay) => { if (delay === 300 || delay === 750) queueMicrotask(() => { now += delay; callback(); }); return 1; }, clearTimeout: () => {} },
    EventSource: class { handlers = {}; addEventListener(name, callback) { this.handlers[name] = callback; } emit(name) { this.handlers[name]?.(); } close() { this.closed = true; } },
    require: (name) => {
      if (name === './presetQuestions') {
        const config = { exports: {} };
        vm.runInNewContext(ts.transpileModule(fs.readFileSync('frontend/src/presetQuestions.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, config);
        return config.exports;
      }
      if (name === 'react') return react;
      if (name === './lib/api') return api;
      if (name === './lib/webrtc') return { startPlayback: async (id, video, signal) => {
        const playback = { id, closed: false, close() { this.closed = true; video.srcObject = null; } };
        playbacks.push(playback); signal.addEventListener('abort', () => playback.close()); return playback;
      } };
      if (name === './lib/recording') return { recordingMessage: () => 'recording error', startRecording: (signal, started) => {
        const result = deferred(); const capture = { result: result.promise, cancelled: false, cancel() { this.cancelled = true; /* Simulate a permission/capture promise that can settle after cancel. */ }, stop() {}, finish: result.resolve };
        captures.push(capture); signal.addEventListener('abort', () => capture.cancel()); started(); return capture;
      } };
      throw new Error(name);
    },
  };
  vm.runInNewContext(compiled, sandbox);
  const render = () => { cursor = 0; return exported.default(); };
  const app = render(); app.video.current = { paused: false, srcObject: null };
  return { render, requests, overrides, states, captures, playbacks, response, created: () => serial };
}

// Execute actual App handlers with isolated API/media/hook doubles, never real devices.
const questionCalls=h=>h.requests.filter(r=>r.url==='/guide/questions');
const previews=h=>h.requests.filter(r=>r.url==='/opentalking/tts/preview');
function errorAnswer(h) {
  h.overrides.set('POST /guide/questions',init=>{
    const body=JSON.parse(init.body);
    assert.deepEqual(Object.keys(body).sort(),['question','turn_id','visitor_id']);
    return h.response({visitor_id:body.visitor_id,turn_id:body.turn_id,status:'error',text:'unconfigured',sources:[],error_code:'service_not_configured'},503);
  });
}
function answerFixture(h) {
  h.overrides.set('POST /guide/questions',init=>h.response({...JSON.parse(init.body),status:'answer',text:'本轮可靠文字',sources:[]}));
  h.overrides.set('POST /opentalking/tts/preview',()=>new Response(new Blob(['wav']),{headers:{'content-type':'audio/wav'}}));
  for(const id of ['sess_1','sess_2'])h.overrides.set(`POST /opentalking/sessions/${id}/speak_flashtalk_audio`,()=>h.response({session_id:id,status:'queued'}));
}
function blank(h){const a=h.render();assert.equal(a.question,'');assert.equal(a.submittedQuestion,'');assert.equal(a.answer,null);assert.equal(a.handoff.question,'');assert.equal(a.questionError,'');}
const watchdog=setTimeout(()=>{console.error('Race checks failed to settle');process.exitCode=1;},10000);
(async()=>{
 let checks=0;
 // V1 survives disconnect/reconnect and human takeover/resume; turns change, no auto resend.
 {
  const h=harness();const visitor=h.render().visitorId.current;await h.render().connect();errorAnswer(h);
  await h.render().sendQuestion(h.render().active.current,'第一问');const first=JSON.parse(questionCalls(h)[0].body);
  assert.equal(first.visitor_id,visitor);assert.notEqual(first.visitor_id,'sess_1');
  await h.render().disconnect();await h.render().connect();assert.equal(h.render().active.current.mediaSessionId,'sess_2');
  assert.equal(h.render().visitorId.current,visitor);await h.render().sendQuestion(h.render().active.current,'第二问');
  const second=JSON.parse(questionCalls(h)[1].body);assert.equal(second.visitor_id,visitor);assert.notEqual(second.turn_id,first.turn_id);
  await h.render().takeOver();await h.render().connect('resume');assert.equal(h.render().visitorId.current,visitor);assert.equal(questionCalls(h).length,2);checks++;
 }
 // Recording allocates a business turn before permission/STT, then preserves it through questions.
 {
  const h=harness();await h.render().connect();errorAnswer(h);
  h.overrides.set('POST /opentalking/sessions/sess_1/transcribe',()=>h.response({session_id:'sess_1',text:'录音问题'}));
  const recording=h.render().beginRecording();await flush();const identity=h.render().voiceTurn.current;
  h.captures[0].finish({blob:new Blob(['voice']),filename:'question.webm'});await recording;
  const body=JSON.parse(questionCalls(h)[0].body);assert.equal(body.turn_id,identity.turnId);assert.equal(body.visitor_id,identity.visitorId);checks++;
 }
 // Reset atomically changes V, clears text, and duplicates cannot allocate V3/create M3.
 {
  const h=harness();await h.render().connect();const old=h.render().visitorId.current;h.render().setQuestion('旧组问题');
  const closed=deferred();h.overrides.set('GET /opentalking/sessions/sess_1',()=>closed.promise);
  const reset=h.render().resetVisitor();const next=h.render().visitorId.current;assert.notEqual(next,old);blank(h);
  const duplicate=h.render().resetVisitor();assert.equal(h.render().visitorId.current,next);assert.equal(h.created(),1);
  closed.resolve(h.response({session_id:'sess_1',state:'closed'}));await Promise.all([reset,duplicate]);
  assert.equal(h.created(),2);assert.equal(h.render().active.current.visitorId,next);blank(h);checks++;
 }
 // Stubborn delayed permission/capture and already sent STT cannot submit for V2.
 for(const stage of ['capture','stt']){
  const h=harness();await h.render().connect();const late=deferred(),started=deferred();
  h.overrides.set('POST /opentalking/sessions/sess_1/transcribe',()=>{started.resolve();return late.promise;});
  const recording=h.render().beginRecording();await flush();
  if(stage==='stt'){h.captures[0].finish({blob:new Blob(['voice']),filename:'q.webm'});await started.promise;}
  await h.render().resetVisitor();assert.equal(h.captures[0].cancelled,true);
  if(stage==='capture')h.captures[0].finish({blob:new Blob(['late']),filename:'q.webm'});
  else late.resolve(h.response({session_id:'sess_1',text:'旧组转写'}));
  await recording;blank(h);assert.equal(questionCalls(h).length,0);checks++;
 }
 // Late questions cannot repaint V2 or call TTS.
 {
  const h=harness();await h.render().connect();const late=deferred();let body;
  h.overrides.set('POST /guide/questions',init=>{body=JSON.parse(init.body);return late.promise;});
  const q=h.render().sendQuestion(h.render().active.current,'旧组问题');await flush();await h.render().resetVisitor();
  late.resolve(h.response({...body,status:'answer',text:'旧组回答',sources:[]}));await q;blank(h);assert.equal(previews(h).length,0);checks++;
 }
 // TTS/upload/SSE from old media cannot unlock or finish the new media's active speech.
 for(const stage of ['preview','upload'])for(const change of ['reset','record-rebuild']){
  const h=harness();await h.render().connect();const old=h.render().active.current,visitor=old.visitorId;answerFixture(h);
  const late=deferred(),started=deferred();const endpoint=stage==='preview'?'/opentalking/tts/preview':'/opentalking/sessions/sess_1/speak_flashtalk_audio';
  h.overrides.set('POST '+endpoint,()=>{started.resolve();return late.promise;});
  const q=h.render().sendQuestion(old,'旧问');await started.promise;
  if(change==='reset')await h.render().resetVisitor();else await h.render().prepareRecording();
  const next=h.render().active.current;assert.equal(next.mediaSessionId,'sess_2');assert.equal(next.visitorId===visitor,change==='record-rebuild');
  answerFixture(h);await h.render().playDemo();const liveSpeech=h.render().speech.current;assert.ok(liveSpeech);
  late.resolve(stage==='preview'?new Response(new Blob(['wav']),{headers:{'content-type':'audio/wav'}}):h.response({session_id:'sess_1',status:'queued'}));await q;
  old.events.emit('speech.media_started');old.events.emit('speech.ended');assert.equal(h.render().speech.current,liveSpeech);assert.equal(h.render().busy.current,true);
  assert.equal(h.requests.filter(r=>r.url==='/opentalking/sessions/sess_2/speak_flashtalk_audio').length,1);checks++;
 }
 // Bad business identity envelopes, including media SID in visitor field, are rejected.
 for(const fault of ['visitor','turn','missing-visitor','missing-turn','media-as-visitor','legacy-field']){
  const h=harness();await h.render().connect();h.overrides.set('POST /guide/questions',init=>{
   const body=JSON.parse(init.body),result={visitor_id:body.visitor_id,turn_id:body.turn_id,status:'answer',text:'wrong',sources:[]};
   if(fault==='visitor')result.visitor_id='other';if(fault==='turn')result.turn_id='other';if(fault==='missing-visitor')delete result.visitor_id;
   if(fault==='missing-turn')delete result.turn_id;if(fault==='media-as-visitor')result.visitor_id='sess_1';if(fault==='legacy-field'){result.session_id='sess_1';delete result.visitor_id;}
   return h.response(result);
  });await h.render().sendQuestion(h.render().active.current,'问题');assert.equal(h.render().answer,null);assert.ok(h.render().questionError);assert.equal(previews(h).length,0);checks++;
 }
 // Upstream STT still validates media SID, not business visitor ID.
 {
  const h=harness();await h.render().connect();h.overrides.set('POST /opentalking/sessions/sess_1/transcribe',()=>h.response({session_id:h.render().visitorId.current,text:'bad-media'}));
  const recording=h.render().beginRecording();await flush();h.captures[0].finish({blob:new Blob(['v']),filename:'q.webm'});await recording;
  assert.equal(questionCalls(h).length,0);assert.match(h.render().recordingHint,/error/);checks++;
 }
 // A trusted precreation422 allows explicit retry without changing V2; unknown5xx cannot.
 for(const status of [422,500]){
  const h=harness();await h.render().connect();const v1=h.render().visitorId.current;
  h.overrides.set('POST /opentalking/sessions',()=>h.response(status===422?{detail:[{loc:['body','avatar_id'],type:'missing',msg:'required'}]}:{error:'unknown'},status));
  await h.render().resetVisitor();const v2=h.render().visitorId.current;assert.notEqual(v2,v1);blank(h);assert.equal(h.render().active.current,null);
  h.overrides.delete('POST /opentalking/sessions');await h.render().connect();assert.equal(h.render().visitorId.current,v2);
  if(status===422){assert.equal(h.created(),2);assert.equal(h.render().active.current.visitorId,v2);}else{assert.equal(h.created(),1);assert.equal(h.render().active.current,null);}
  checks++;
 }
 // A creation response lost entirely remains isolated across group reset/retry.
 {
  const h=harness();h.overrides.set('POST /opentalking/sessions',()=>Promise.reject(Error('lost')));await h.render().connect();
  await h.render().resetVisitor();const v=h.render().visitorId.current;h.overrides.delete('POST /opentalking/sessions');await h.render().connect();
  assert.equal(h.created(),0);assert.equal(h.render().active.current,null);assert.equal(h.render().visitorId.current,v);checks++;
 }
 console.log(JSON.stringify({status:'passed',checks,groups:5,scope:'Actual App handlers via isolated React/API/media doubles; no real services, microphone, history or GPU.'}));
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>clearTimeout(watchdog));
