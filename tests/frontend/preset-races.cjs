const fs = require('node:fs');
const base = fs.readFileSync('tests/frontend/visitor-races.cjs','utf8').split('// Execute actual App handlers')[0]
  .replace('demoStatus, speechPending };','demoStatus, speechPending, conversation, presetRequest, presetPreparing };');
const checks = String.raw`
const Q=['公司提供哪些服务？','品牌设计包含哪些内容？','有哪些展厅或展览空间案例？'];
const calls=h=>h.workRequests.filter(r=>r.url==='/guide/questions');
function business(h){h.overrides.set('POST /guide/questions',init=>{const b=JSON.parse(init.body);return h.response({visitor_id:b.visitor_id,turn_id:b.turn_id,turn_seq:b.turn_seq,status:'error',text:'unavailable',sources:[]},503);});}
const watchdog=setTimeout(()=>{console.error('Preset checks timed out');process.exitCode=1;},10000);
(async()=>{
 let checks=0;
 // Rapid clicks share a single close/create barrier and send only the final selection.
 {
  const h=harness();await h.render().connect();await finishWelcome(h);business(h);const visitor=h.render().visitorId.current;
  await startBusyDemo(h);const gate=deferred();h.overrides.set('GET /opentalking/sessions/sess_1',()=>gate.promise);
  const first=h.render().selectPreset(Q[0]);await flush();await h.render().selectPreset(Q[1]);await h.render().selectPreset(Q[2]);
  assert.equal(h.created(),1);assert.equal(calls(h).length,0);
  gate.resolve(h.response({session_id:'sess_1',state:'closed'}));await first;await finishWelcome(h);await flush();
  assert.equal(h.created(),2);assert.equal(calls(h).length,1);const b=JSON.parse(calls(h)[0].body);assert.equal(b.question,Q[2]);assert.equal(b.visitor_id,visitor);
  assert.equal(h.render().conversation.map(r=>r.status).join(','),'cancelled,cancelled,error');assert.equal(h.render().conversation[2].input,'text');assert.equal(h.captures.length,0);checks++;
 }
 // Pending business response cannot overwrite or start old speech after replacement.
 {
  const h=harness();await h.render().connect();await finishWelcome(h);const late=deferred();h.overrides.set('POST /guide/questions',()=>late.promise);
  const old=h.render().sendQuestion(h.render().active.current,'old');await flush();const body=JSON.parse(calls(h)[0].body);business(h);
  await h.render().selectPreset(Q[0]);await flush();late.resolve(h.response({...body,status:'answer',text:'late',sources:[]}));await old;
  assert.equal(h.render().conversation[0].status,'cancelled');assert.equal(h.render().conversation[0].result,undefined);assert.equal(h.workRequests.filter(r=>r.url==='/opentalking/tts/preview').length,0);checks++;
 }
 // Upload acknowledgement must settle before close/replacement; old SSE still cannot affect the new turn.
 {
  const h=harness();await h.render().connect();await finishWelcome(h);const oldSession=h.render().active.current,upload=deferred(),started=deferred();
  h.overrides.set('POST /guide/questions',init=>h.response({...JSON.parse(init.body),status:'answer',text:'old answer',sources:[]}));
  h.overrides.set('POST /opentalking/tts/preview',()=>new Response(new Blob(['wav']),{headers:{'content-type':'audio/wav'}}));
  h.overrides.set('POST /opentalking/sessions/sess_1/speak_flashtalk_audio',()=>{started.resolve();return upload.promise;});
  const old=h.render().sendQuestion(oldSession,'old');await started.promise;assert.equal(h.render().speech.current.phase,'sent');business(h);
  const replacing=h.render().selectPreset(Q[1]);await flush();assert.equal(h.created(),1);
  upload.resolve(h.response({session_id:'sess_1',status:'queued'}));await replacing;await finishWelcome(h);await flush();const last=h.render().conversation[1];
  oldSession.events.emit('speech.media_started');oldSession.events.emit('speech.ended');await old;
  assert.equal(h.render().conversation[1].turnId,last.turnId);assert.equal(h.render().conversation[1].speechStatus,undefined);assert.equal(oldSession.controller.signal.aborted,true);assert.equal(h.created(),2);checks++;
 }
 // A stopped/discarded microphone result must never become STT or a second business question.
 for(const ended of [false,true]){
  const h=harness();await h.render().connect();await finishWelcome(h);business(h);const voice=h.render().beginRecording();await flush();
  if(ended)h.captures[0].stop();await h.render().selectPreset(Q[0]);await flush();
  assert.equal(h.captures[0].cancelled,true);h.captures[0].finish({blob:new Blob(['unfinished']),filename:'voice.webm'});await voice;
  assert.equal(h.workRequests.filter(r=>r.url.endsWith('/transcribe')).length,0);assert.equal(calls(h).length,1);assert.equal(h.captures.length,1);assert.equal(h.render().conversation[0].status,'cancelled');checks++;
 }
 // An in-flight STT response is ignored after choosing a preset.
 {
  const h=harness();await h.render().connect();await finishWelcome(h);business(h);const late=deferred();h.overrides.set('POST /opentalking/sessions/sess_1/transcribe',()=>late.promise);
  const voice=h.render().beginRecording();await flush();h.captures[0].finish({blob:new Blob(['voice']),filename:'voice.webm'});await flush();
  await h.render().selectPreset(Q[0]);await flush();late.resolve(h.response({session_id:'sess_1',text:'discarded transcript'}));await voice;
  assert.equal(calls(h).length,1);assert.equal(h.render().conversation[0].question,'');assert.equal(h.render().conversation[0].status,'cancelled');checks++;
 }
 // Reset during close invalidates the queued selection. Only the new visitor connection survives.
 {
  const h=harness();await h.render().connect();await finishWelcome(h);business(h);await startBusyDemo(h);const visitor=h.render().visitorId.current,gate=deferred();h.overrides.set('GET /opentalking/sessions/sess_1',()=>gate.promise);
  const chosen=h.render().selectPreset(Q[0]);await flush();const reset=h.render().resetVisitor();await flush();gate.resolve(h.response({session_id:'sess_1',state:'closed'}));await Promise.all([chosen,reset]);await flush();
  assert.notEqual(h.render().visitorId.current,visitor);assert.equal(h.render().conversation.length,0);assert.equal(calls(h).length,0);assert.equal(h.created(),2);checks++;
 }
 // Unknown release never creates another session or submits a question; it terminates with an error row.
 {
  const h=harness();await h.render().connect();await finishWelcome(h);business(h);await startBusyDemo(h);h.overrides.set('GET /opentalking/sessions/sess_1',()=>h.response({},502));
  await h.render().selectPreset(Q[0]);await flush();assert.equal(h.created(),1);assert.equal(calls(h).length,0);assert.equal(h.render().conversation[0].status,'error');assert.equal(h.render().presetPreparing,false);checks++;
 }
 console.log(JSON.stringify({status:'passed',checks,scope:'actual App handlers, isolated API/media; no live sessions'}));
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>clearTimeout(watchdog));
`;
new Function('require',base+checks)(require);

