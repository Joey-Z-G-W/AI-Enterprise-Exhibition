// Actual App welcome/preset/fallback lifecycle. All transport and devices are isolated.
const fs=require('node:fs');
const base=fs.readFileSync('tests/frontend/visitor-races.cjs','utf8').split('// Execute actual App handlers')[0]
 .replace('demoStatus, speechPending };','demoStatus, speechPending, conversation, welcomeStatus };');
const checks=String.raw`
const watchdog=setTimeout(()=>{console.error('Welcome/preset checks timed out');process.exitCode=1;},10000);
const welcomePreviews=h=>[...h.welcomeRequests].filter(r=>r.url==='/opentalking/tts/preview');
const uploads=h=>h.requests.filter(r=>r.url.endsWith('/speak_flashtalk_audio'));
const W='您好，欢迎来到锐伽展厅！您可以直接向我提问，也可以选择下方的问题。我会根据现有资料为您介绍。';
function responseRound(h,status='answer',text='您好，我可以为您介绍展厅。'){
 const started=deferred();
 h.overrides.set('POST /guide/questions',init=>h.response({...JSON.parse(init.body),status,text,sources:[]}));
 h.overrides.set('POST /opentalking/tts/preview',init=>{assert.equal(JSON.parse(init.body).text,text);return new Response(new Blob(['reply']),{headers:{'content-type':'audio/wav'}});});
 const id=h.render().active.current.mediaSessionId;
 h.overrides.set('POST /opentalking/sessions/'+id+'/speak_flashtalk_audio',()=>{started.resolve();return h.response({session_id:id,status:'queued'});});
 return started;
}
(async()=>{
 let checks=0;
 // One explicit welcome, visible text and actual TTS configuration, and no business question.
 {
  const h=harness();await h.render().connect();const session=h.render().active.current,owner=h.continuous[0];
  await h.welcomeEntered('sess_1').promise;await session.upload;
  assert.equal(welcomePreviews(h).length,1);assert.equal(uploads(h).length,1);
  assert.deepEqual(JSON.parse(welcomePreviews(h)[0].body),{text:W,tts_provider:'edge',voice:'zh-CN-XiaoxiaoNeural'});
  assert.ok(h.markup().includes(W));assert.equal(h.render().speech.current.kind,'welcome');assert.equal(owner.listens,1);assert.equal(h.render().transition.current,null);
  await h.render().connect();assert.equal(welcomePreviews(h).length,1);assert.equal(h.created(),1);
  await finishWelcome(h);session.events.emit('speech.ended');assert.equal(h.render().speech.current,null);
  assert.equal(h.requests.filter(r=>r.url==='/guide/questions').length,0);checks++;
 }
 // Ended before welcome ACK retains the same gate; no extra welcome from duplicate ended.
 {
  const h=harness(),ack=deferred();h.welcomeTransport.upload=()=>ack.promise;await h.render().connect();
  await h.welcomeEntered('sess_1').promise;const session=h.render().active.current;session.events.emit('speech.ended');
  assert.equal(h.render().busy.current,true);assert.equal(h.render().speech.current.phase,'ended');
  ack.resolve(h.response({session_id:'sess_1',status:'queued'}));await session.upload;await flush();
  assert.equal(h.render().busy.current,false);assert.equal(h.render().speech.current,null);assert.equal(uploads(h).length,1);checks++;
 }
 // Barge during welcome preparation retires it; late audio cannot upload or greet the rebuilt SID.
 {
  const h=harness(),late=deferred();h.welcomeTransport.preview=()=>late.promise;await h.render().connect();
  const old=h.render().active.current,owner=h.continuous[0];assert.equal(h.render().speech.current.kind,'welcome');
  await owner.realStart();assert.equal(h.created(),2);assert.equal(old.controller.signal.aborted,true);assert.equal(owner.stops,0);
  late.resolve(new Response(new Blob(['late']),{headers:{'content-type':'audio/wav'}}));await flush();
  assert.equal(welcomePreviews(h).length,1);assert.equal(uploads(h).length,0);assert.equal(h.render().speech.current,null);checks++;
 }
 // Barge during welcome upload still waits for its independent ACK before final close.
 {
  const h=harness(),ack=deferred();h.welcomeTransport.upload=()=>ack.promise;await h.render().connect();await h.welcomeEntered('sess_1').promise;
  const old=h.render().active.current,recovery=h.continuous[0].realStart();await flush();
  assert.equal(h.created(),1);assert.equal(h.workRequests.filter(r=>r.method==='DELETE').length,0);
  ack.resolve(h.response({session_id:'sess_1',status:'queued'}));await recovery;
  assert.equal(h.created(),2);assert.equal(old.events.closed,true);assert.equal(welcomePreviews(h).length,1);assert.equal(h.render().speech.current,null);checks++;
 }
 // Explicit resume and new visitor each welcome once; neither resubmits an old question.
 {
  const h=harness();await h.render().connect();await finishWelcome(h);const visitor=h.render().visitorId.current;
  await h.render().takeOver();assert.equal(h.render().mode,'human');await h.render().connect('resume');await finishWelcome(h);
  assert.equal(h.render().visitorId.current,visitor);assert.equal(welcomePreviews(h).length,2);
  await h.render().resetVisitor();await finishWelcome(h);assert.notEqual(h.render().visitorId.current,visitor);
  assert.equal(welcomePreviews(h).length,3);assert.equal(uploads(h).length,3);assert.equal(h.requests.filter(r=>r.url==='/guide/questions').length,0);checks++;
 }
 // Idle presets and unsupported replies reuse media; stopped capture remains closed.
 for(const status of ['answer','handoff']){
  const h=harness();await h.render().connect();await finishWelcome(h);const session=h.render().active.current,owner=h.continuous[0];
  h.render().stopMicrophone();const text=status==='handoff'?'现有资料无法确认这个问题，请咨询现场销售。':'您好，很高兴为您讲解。';
  for(let n=0;n<2;n++){
   const entered=responseRound(h,status,text);await h.render().selectPreset('锐伽提供哪些服务？');await entered.promise;await session.upload;
   assert.equal(h.render().answer.text,text);assert.equal(h.render().conversation.at(-1).result.text,text);assert.equal(h.render().mode,'assistant');
   assert.equal(h.render().active.current,session);assert.equal(h.created(),1);assert.equal(owner.stops,1);assert.equal(h.continuous.length,1);
   session.events.emit('speech.ended');assert.equal(h.render().speech.current,null);assert.equal(h.render().busy.current,false);
  }
  const questions=h.workRequests.filter(r=>r.url==='/guide/questions').map(r=>JSON.parse(r.body));
  assert.equal(questions.length,2);assert.ok(questions.every(q=>q.question==='锐伽提供哪些服务？'));assert.notEqual(questions[0].turn_id,questions[1].turn_id);
  assert.equal(h.workRequests.filter(r=>r.method==='DELETE').length,0);assert.equal(welcomePreviews(h).length,1);
  assert.ok(h.markup().includes('id="conversation-history"'));assert.ok(h.markup().includes(text));assert.doesNotMatch(h.markup(),/模型待接入|↗|销售接管中/);checks++;
 }
 console.log(JSON.stringify({status:'passed',checks,scope:'real App handlers; welcome trace retained; viewport requires separate browser check'}));
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>clearTimeout(watchdog));
`;
new Function('require',base+checks)(require);
