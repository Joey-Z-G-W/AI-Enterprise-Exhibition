const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require(path.resolve('frontend/node_modules/typescript'));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
let source = fs.readFileSync('frontend/src/App.tsx', 'utf8');
source = source.slice(0, source.indexOf('  const connected =')) + `
  return { connect, disconnect, takeOver, bargeIn, bargeRecovery, submitRecordedAudio, stopMicrophone, requestMicrophone, microphone, segments, businessBarrier, captureStatus, captureHint, playDemo, selectPreset, sendQuestion,
    active, retired, video, modeRef, voiceTurn, speech, questionTurn, busy, transition, resetVisitor, visitorReset, visitorId, resettingVisitor,
    mode, connection, notice, handoff, question, answer, recordingHint, setQuestion, pending, submittedQuestion, questionError, answerSpeechStatus, demoStatus, speechPending };
}`;
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const markupCompiled = ts.transpileModule(fs.readFileSync('frontend/src/App.tsx', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;

function harness() {
  let cursor = 0, serial = 0, now = 0;
  const hooks = [], requests = [], captures = [], continuous = [], playbacks = [], effects = [];
  const listeners = new Map(), timers = new Map(); let timerSerial=0;
  const overrides = new Map(), states = new Map();
  // Welcome is real App work. Keep its complete trace separately from later business assertions.
  const welcomeRequests = new Set(), welcomeUploads = new Map(), welcomeTransport = {};
  const welcomeEntered = id => { if (!welcomeUploads.has(id)) welcomeUploads.set(id,deferred()); return welcomeUploads.get(id); };
  const response = (body, status = 200, headers) => new Response(JSON.stringify(body), { status, headers });
  const api = {
    post: (body, signal) => ({ method: 'POST', body: JSON.stringify(body), signal }),
    RequestError: class extends Error { constructor(kind) { super(kind); this.kind = kind; } },
    messageFor: () => 'request failed',
    request: async (url, init = {}, timeoutMs) => {
      const method = init.method || 'GET'; requests.push({ url, method, signal: init.signal, body: init.body, timeoutMs });
      const recorded=requests.at(-1);
      if(url==='/opentalking/tts/preview' && JSON.parse(init.body).text==='您好，欢迎来到锐伽展厅！您可以直接向我提问，也可以选择下方的问题。我会根据现有资料为您介绍。') {
        welcomeRequests.add(recorded);
        return welcomeTransport.preview ? welcomeTransport.preview(init) : new Response(new Blob(['welcome']),{headers:{'content-type':'audio/wav'}});
      }
      if(url.endsWith('/speak_flashtalk_audio') && init.body.get('file').name==='welcome.wav') {
        welcomeRequests.add(recorded);const id=url.split('/')[3];welcomeEntered(id).resolve(recorded);
        return welcomeTransport.upload ? welcomeTransport.upload(init,id) : response({session_id:id,status:'queued'});
      }
      const custom = overrides.get(`${method} ${url}`);
      if (custom) return custom(init);
      if (url === '/guide/ui-config' && method === 'GET') return response({avatar_id:'companion',tts_voice:'zh-CN-XiaoxiaoNeural'});
      if (url.startsWith('/guide/visitors/') && url.endsWith('/invalidate')) { const b=JSON.parse(init.body); return response({visitor_id:decodeURIComponent(url.split('/')[3]),cancelled_through:b.through_turn_seq,retired:b.retire}); }
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
    useEffect: (effect, deps) => { const index=cursor++; if (!(index in hooks)) { hooks[index]=true; if(deps?.length===0) effects.push(effect()); } },
  };
  const exported = {};
  const sandbox = {
    exports: exported, queueMicrotask, fetch:(...args)=>api.request(...args), AbortController, Response, Blob, FormData, crypto: require('node:crypto').webcrypto,
    Date: { now: () => now },
    setTimeout:(fn,ms)=>{const id=++timerSerial;timers.set(id,{fn,at:now+ms});return id;},clearTimeout:id=>timers.delete(id),
    window: { addEventListener:(name,fn)=>listeners.set(name,fn), removeEventListener:(name)=>listeners.delete(name), setTimeout: (callback, delay) => { if (delay === 300 || delay === 750) queueMicrotask(() => { now += delay; callback(); }); return 1; }, clearTimeout: () => {} },
    EventSource: class { handlers = {}; addEventListener(name, callback) { this.handlers[name] = callback; } emit(name) { this.handlers[name]?.(); } close() { this.closed = true; } },
    require: (name) => {
      if (name === 'react/jsx-runtime') return require(path.resolve('frontend/node_modules/react/jsx-runtime'));
      if (name === './presetQuestions') {
        const config = { exports: {} };
        vm.runInNewContext(ts.transpileModule(fs.readFileSync('frontend/src/presetQuestions.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, config);
        return config.exports;
      }
      if (name === 'react') return react;
      if (name === './lib/api') return api;
      if(name === './lib/voiceSegments'){const module={exports:{}};vm.runInNewContext(ts.transpileModule(fs.readFileSync('frontend/src/lib/voiceSegments.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{...sandbox,exports:module.exports});return module.exports;}
      if (name === './lib/continuousCapture') return {createContinuousCapture(report,callbacks={}) {
        const owner={released:false,stops:0,listens:0,discards:0,discardSegment(){this.discards++;},realStart(){if(!this.released)return callbacks.onSpeechRealStart?.();},segment(audio){if(!this.released)callbacks.onSegment?.(audio);},listen(){if(!this.released){this.listens++;report('listening','正在持续收音。');}},async stop(){this.stops++;this.released=true;report('closed','麦克风已关闭。');return true;}};
        continuous.push(owner);return owner;
      }};
      if (name === './lib/webrtc') return { startPlayback: async (id, video, signal) => {
        const playback = { id, closed: false, close() { this.closed = true; video.srcObject = null; } };
        playbacks.push(playback); signal.addEventListener('abort', () => playback.close()); return playback;
      } };
      if (name === './lib/recording') return {recordingMessage: () => 'recording error'};
      throw new Error(name);
    },
  };
  vm.runInNewContext(compiled, sandbox);
  const markupExports = {};
  vm.runInNewContext(markupCompiled, { ...sandbox, exports: markupExports });
  const render = () => { cursor = 0; const app=exported.default();
    app.beginRecording=()=>{const audio=deferred();const capture={cancelled:false,cancel(){this.cancelled=true;},stop(){},finish:audio.resolve};captures.push(capture);app.active.current.controller.signal.addEventListener('abort',()=>capture.cancel());return app.submitRecordedAudio(audio.promise);};
    return app;
  };
  const markup = () => { cursor = 0; return require(path.resolve('frontend/node_modules/react-dom/server')).renderToStaticMarkup(markupExports.default()); };
  const app = render(); app.video.current = { paused: false, srcObject: null };
  return { render, markup, api, requests, welcomeRequests, welcomeTransport, welcomeEntered,
    get workRequests(){return requests.filter(r=>!welcomeRequests.has(r));},
    overrides, states, captures, continuous, playbacks, advance:async(ms)=>{now+=ms;for(const [id,t] of [...timers])if(t.at<=now){timers.delete(id);t.fn();}await flush();}, dispose:()=>effects.forEach(fn=>fn?.()), listeners, response, created: () => serial };
}

async function finishWelcome(h) {
  const item=h.render().speech.current;
  if(!item || item.kind!=='welcome') return; // Failed/cancelled connection or internal rebuild has none.
  const session=item.session;
  const upload=await h.welcomeEntered(session.mediaSessionId).promise;
  assert.equal(upload.timeoutMs,30000);assert.equal(upload.signal,undefined);
  await session.upload;
  assert.equal(item.acknowledged,true);assert.equal(h.render().busy.current,true);
  session.events.emit('speech.media_started');session.events.emit('speech.ended');
  assert.equal(h.render().speech.current,null);assert.equal(h.render().busy.current,false);
  assert.equal([...h.welcomeRequests].filter(r=>r.url===upload.url).length,1);
}

async function startBusyDemo(h) {
  // Safety tests requiring media retirement start a real pending speech instead of assuming idle replacement.
  const id=h.render().active.current.mediaSessionId;
  const keys=['POST /opentalking/tts/preview','POST /opentalking/sessions/'+id+'/speak_flashtalk_audio'];
  const previous=keys.map(k=>h.overrides.get(k));
  h.overrides.set(keys[0],()=>new Response(new Blob(['demo']),{headers:{'content-type':'audio/wav'}}));
  h.overrides.set(keys[1],()=>h.response({session_id:id,status:'queued'}));
  await h.render().playDemo();assert.equal(h.render().speech.current.kind,'demo');assert.equal(h.render().busy.current,true);
  keys.forEach((k,i)=>previous[i]?h.overrides.set(k,previous[i]):h.overrides.delete(k));
}

// Execute actual App handlers with isolated API/media/hook doubles, never real devices.
const questionCalls=h=>h.workRequests.filter(r=>r.url==='/guide/questions');
const previews=h=>h.workRequests.filter(r=>r.url==='/opentalking/tts/preview');
function errorAnswer(h) {
  h.overrides.set('POST /guide/questions',init=>{
    const body=JSON.parse(init.body);
    assert.deepEqual(Object.keys(body).sort(),['question','turn_id','turn_seq','visitor_id']);
    return h.response({visitor_id:body.visitor_id,turn_id:body.turn_id,turn_seq:body.turn_seq,status:'error',text:'unconfigured',sources:[],error_code:'service_not_configured'},503);
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
  const h=harness();const visitor=h.render().visitorId.current;await h.render().connect();await finishWelcome(h);errorAnswer(h);
  await h.render().sendQuestion(h.render().active.current,'第一问');const first=JSON.parse(questionCalls(h)[0].body);
  assert.equal(first.visitor_id,visitor);assert.notEqual(first.visitor_id,'sess_1');
  await h.render().disconnect();await h.render().connect();await finishWelcome(h);assert.equal(h.render().active.current.mediaSessionId,'sess_2');
  assert.equal(h.render().visitorId.current,visitor);await h.render().sendQuestion(h.render().active.current,'第二问');
  const second=JSON.parse(questionCalls(h)[1].body);assert.equal(second.visitor_id,visitor);assert.notEqual(second.turn_id,first.turn_id);
  await h.render().takeOver();await h.render().connect('resume');await finishWelcome(h);assert.equal(h.render().visitorId.current,visitor);assert.equal(questionCalls(h).length,2);checks++;
 }
 // Recording allocates a business turn before permission/STT, then preserves it through questions.
 {
  const h=harness();await h.render().connect();await finishWelcome(h);errorAnswer(h);
  h.overrides.set('POST /opentalking/sessions/sess_1/transcribe',()=>h.response({session_id:'sess_1',text:'录音问题'}));
  const recording=h.render().beginRecording();await flush();const identity=h.render().voiceTurn.current;
  h.captures[0].finish({blob:new Blob(['voice']),filename:'question.webm'});await recording;
  const body=JSON.parse(questionCalls(h)[0].body);assert.equal(body.turn_id,identity.turnId);assert.equal(body.visitor_id,identity.visitorId);checks++;
 }
 // Reset atomically changes V, clears text, and duplicates cannot allocate V3/create M3.
 {
  const h=harness();await h.render().connect();await finishWelcome(h);const old=h.render().visitorId.current;h.render().setQuestion('旧组问题');
  const closed=deferred();h.overrides.set('GET /opentalking/sessions/sess_1',()=>closed.promise);
  const reset=h.render().resetVisitor();const next=h.render().visitorId.current;assert.notEqual(next,old);blank(h);
  const duplicate=h.render().resetVisitor();assert.equal(h.render().visitorId.current,next);assert.equal(h.created(),1);
  closed.resolve(h.response({session_id:'sess_1',state:'closed'}));await Promise.all([reset,duplicate]);await finishWelcome(h);
  assert.equal(h.created(),2);assert.equal(h.render().active.current.visitorId,next);blank(h);checks++;
 }
 // Stubborn delayed permission/capture and already sent STT cannot submit for V2.
 for(const stage of ['capture','stt']){
  const h=harness();await h.render().connect();await finishWelcome(h);const late=deferred(),started=deferred();
  h.overrides.set('POST /opentalking/sessions/sess_1/transcribe',()=>{started.resolve();return late.promise;});
  const recording=h.render().beginRecording();await flush();
  if(stage==='stt'){h.captures[0].finish({blob:new Blob(['voice']),filename:'q.webm'});await started.promise;}
  await h.render().resetVisitor();await finishWelcome(h);assert.equal(h.captures[0].cancelled,true);
  if(stage==='capture')h.captures[0].finish({blob:new Blob(['late']),filename:'q.webm'});
  else late.resolve(h.response({session_id:'sess_1',text:'旧组转写'}));
  await recording;blank(h);assert.equal(questionCalls(h).length,0);checks++;
 }
 // Late questions cannot repaint V2 or call TTS.
 {
  const h=harness();await h.render().connect();await finishWelcome(h);const late=deferred();let body;
  h.overrides.set('POST /guide/questions',init=>{body=JSON.parse(init.body);return late.promise;});
  const q=h.render().sendQuestion(h.render().active.current,'旧组问题');await flush();await h.render().resetVisitor();await finishWelcome(h);
  late.resolve(h.response({...body,status:'answer',text:'旧组回答',sources:[]}));await q;blank(h);assert.equal(previews(h).length,0);checks++;
 }
 // TTS/upload/SSE from old media cannot unlock or finish the new media's active speech.
 for(const stage of ['preview','upload'])for(const change of ['reset','barge-rebuild']){
  const h=harness();await h.render().connect();await finishWelcome(h);const old=h.render().active.current,visitor=old.visitorId;answerFixture(h);
  const late=deferred(),started=deferred();const endpoint=stage==='preview'?'/opentalking/tts/preview':'/opentalking/sessions/sess_1/speak_flashtalk_audio';
  h.overrides.set('POST '+endpoint,()=>{started.resolve();return late.promise;});
  const q=h.render().sendQuestion(old,'旧问');await started.promise;
  const replacing=change==='reset'?h.render().resetVisitor():h.continuous[0].realStart();await flush();
  if(stage==='upload'){assert.equal(h.created(),1);late.resolve(h.response({session_id:'sess_1',status:'queued'}));}
  await replacing;await finishWelcome(h);
  const next=h.render().active.current;assert.equal(next.mediaSessionId,'sess_2');assert.equal(next.visitorId===visitor,change==='barge-rebuild');
  answerFixture(h);await h.render().playDemo();const liveSpeech=h.render().speech.current;assert.ok(liveSpeech);
  if(stage==='preview')late.resolve(new Response(new Blob(['wav']),{headers:{'content-type':'audio/wav'}}));await q;
  old.events.emit('speech.media_started');old.events.emit('speech.ended');assert.equal(h.render().speech.current,liveSpeech);assert.equal(h.render().busy.current,true);
  assert.equal(h.workRequests.filter(r=>r.url==='/opentalking/sessions/sess_2/speak_flashtalk_audio').length,1);checks++;
 }
 // Bad business identity envelopes, including media SID in visitor field, are rejected.
 for(const fault of ['visitor','turn','missing-visitor','missing-turn','media-as-visitor','legacy-field']){
  const h=harness();await h.render().connect();await finishWelcome(h);h.overrides.set('POST /guide/questions',init=>{
   const body=JSON.parse(init.body),result={visitor_id:body.visitor_id,turn_id:body.turn_id,turn_seq:body.turn_seq,status:'answer',text:'wrong',sources:[]};
   if(fault==='visitor')result.visitor_id='other';if(fault==='turn')result.turn_id='other';if(fault==='missing-visitor')delete result.visitor_id;
   if(fault==='missing-turn')delete result.turn_id;if(fault==='media-as-visitor')result.visitor_id='sess_1';if(fault==='legacy-field'){result.session_id='sess_1';delete result.visitor_id;}
   return h.response(result);
  });await h.render().sendQuestion(h.render().active.current,'问题');assert.equal(h.render().answer,null);assert.ok(h.render().questionError);assert.equal(previews(h).length,0);checks++;
 }
 // Upstream STT still validates media SID, not business visitor ID.
 {
  const h=harness();await h.render().connect();await finishWelcome(h);h.overrides.set('POST /opentalking/sessions/sess_1/transcribe',()=>h.response({session_id:h.render().visitorId.current,text:'bad-media'}));
  const recording=h.render().beginRecording();await flush();h.captures[0].finish({blob:new Blob(['v']),filename:'q.webm'});await recording;
  assert.equal(questionCalls(h).length,0);assert.match(h.render().recordingHint,/error/);checks++;
 }
 // A trusted precreation422 allows explicit retry without changing V2; unknown5xx cannot.
 for(const status of [422,500]){
  const h=harness();await h.render().connect();await finishWelcome(h);const v1=h.render().visitorId.current;
  h.overrides.set('POST /opentalking/sessions',()=>h.response(status===422?{detail:[{loc:['body','avatar_id'],type:'missing',msg:'required'}]}:{error:'unknown'},status));
  await h.render().resetVisitor();await finishWelcome(h);const v2=h.render().visitorId.current;assert.notEqual(v2,v1);blank(h);assert.equal(h.render().active.current,null);
  h.overrides.delete('POST /opentalking/sessions');await h.render().connect();await finishWelcome(h);assert.equal(h.render().visitorId.current,v2);
  if(status===422){assert.equal(h.created(),2);assert.equal(h.render().active.current.visitorId,v2);}else{assert.equal(h.created(),1);assert.equal(h.render().active.current,null);}
  checks++;
 }
 // A creation response lost entirely remains isolated across group reset/retry.
 {
  const h=harness();h.overrides.set('POST /opentalking/sessions',()=>Promise.reject(Error('lost')));await h.render().connect();await finishWelcome(h);
  await h.render().resetVisitor();await finishWelcome(h);const v=h.render().visitorId.current;h.overrides.delete('POST /opentalking/sessions');await h.render().connect();await finishWelcome(h);
  assert.equal(h.created(),0);assert.equal(h.render().active.current,null);assert.equal(h.render().visitorId.current,v);checks++;
 }
 console.log(JSON.stringify({status:'passed',checks,groups:5,scope:'Actual App handlers via isolated React/API/media doubles; no real services, microphone, history or GPU.'}));
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>clearTimeout(watchdog));
