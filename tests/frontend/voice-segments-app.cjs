const fs=require('node:fs');
const base=fs.readFileSync('tests/frontend/visitor-races.cjs','utf8').split('// Execute actual App handlers')[0];
const checks=String.raw`
const watchdog=setTimeout(()=>{console.error('Voice segment App checks timed out');process.exitCode=1;},10000);
(async()=>{
 let checks=0;
 const stt=h=>h.requests.filter(r=>r.url.endsWith('/transcribe'));
 const questions=h=>h.requests.filter(r=>r.url==='/guide/questions');
 const failAnswer=h=>h.overrides.set('POST /guide/questions',init=>h.response({...JSON.parse(init.body),status:'error',text:'offline',sources:[]},503));
 {
  const h=harness();await h.render().connect();failAnswer(h);h.overrides.set('POST /opentalking/sessions/sess_1/transcribe',()=>h.response({session_id:'sess_1',text:'第一句'}));
  h.continuous[0].segment(new Float32Array([-.2,.3]));await flush();assert.equal(stt(h).length,1);assert.equal(questions(h).length,1);assert.equal(JSON.parse(questions(h)[0].body).question,'第一句');
  assert.equal(stt(h)[0].timeoutMs,45000);const body=stt(h)[0].body;assert.equal(body.get('stt_provider'),'sensevoice');assert.equal(body.get('file').name,'speech.wav');assert.equal(body.get('file').size,48);assert.equal(h.continuous[0].stops,0);checks++;
 }
 for(const text of ['', 'x'.repeat(2001)]){
  const h=harness();await h.render().connect();h.overrides.set('POST /opentalking/sessions/sess_1/transcribe',()=>h.response({session_id:'sess_1',text}));h.continuous[0].segment(new Float32Array([.1]));await flush();assert.equal(stt(h).length,1);assert.equal(questions(h).length,0);assert.ok(h.render().recordingHint);checks++;
 }
 for(const action of ['stopMicrophone','resetVisitor','selectPreset']){
  const h=harness();await h.render().connect();failAnswer(h);const late=deferred();h.overrides.set('POST /opentalking/sessions/sess_1/transcribe',()=>late.promise);
  const owner=h.continuous[0];owner.segment(new Float32Array([.1]));await flush();owner.segment(new Float32Array([.2]));
  if(action==='selectPreset')await h.render().selectPreset('锐伽提供哪些服务？');else await h.render()[action]();await flush();const before=questions(h).length;
  late.resolve(h.response({session_id:'sess_1',text:'旧的语音'}));await flush();assert.equal(questions(h).length,before);assert.equal(stt(h).length,1);assert.ok(!h.markup().includes('旧的语音'));
  if(action==='selectPreset'){assert.equal(owner.stops,0);assert.ok(owner.discards>0);assert.equal(h.continuous.length,1);}checks++;
 }
 {
  const h=harness();await h.render().connect();failAnswer(h);const ready=deferred();h.overrides.set('GET /opentalking/sessions/sess_2',()=>ready.promise);
  const rebuilding=h.render().selectPreset('锐伽提供哪些服务？');await flush();h.continuous[0].segment(new Float32Array([.1]));await flush();assert.equal(stt(h).length,0);
  h.overrides.set('POST /opentalking/sessions/sess_2/transcribe',()=>h.response({session_id:'sess_2',text:'重建期间的新句子'}));ready.resolve(h.response({session_id:'sess_2',state:'ready'}));await rebuilding;await flush();
  assert.equal(stt(h).length,1);assert.match(stt(h)[0].url,/sess_2/);assert.equal(questions(h).length,2);assert.equal(h.continuous.length,1);checks++;
 }
 {
  const h=harness();await h.render().connect();const late=deferred();h.overrides.set('POST /opentalking/sessions/sess_1/transcribe',()=>late.promise);
  const owner=h.continuous[0];owner.segment(new Float32Array([.1]));await flush();owner.segment(new Float32Array([.2]));owner.segment(new Float32Array([.3]));assert.match(h.markup(),/此段未识别/);
  await h.advance(15000);assert.match(h.markup(),/15秒/);late.resolve(h.response({session_id:'sess_1',text:''}));await flush();assert.equal(stt(h).length,1);checks++;
 }
 {
  const h=harness();await h.render().connect();h.overrides.set('POST /opentalking/sessions/sess_1/transcribe',()=>Promise.reject(Error('unknown outcome')));h.continuous[0].segment(new Float32Array([.1]));await flush();
  h.continuous[0].segment(new Float32Array([.2]));await flush();assert.equal(stt(h).length,1);assert.match(h.markup(),/未确认/);assert.equal(questions(h).length,0);checks++;
 }
 {
  const h=harness();await h.render().connect();const answer=deferred();let body;h.overrides.set('POST /opentalking/sessions/sess_1/transcribe',()=>h.response({session_id:'sess_1',text:'已经提交'}));h.overrides.set('POST /guide/questions',init=>{body=JSON.parse(init.body);return answer.promise;});
  h.continuous[0].segment(new Float32Array([.1]));await flush();assert.equal(questions(h).length,1);h.render().stopMicrophone();await flush();assert.equal(h.render().active.current.controller.signal.aborted,false);
  answer.resolve(h.response({...body,status:'error',text:'正常完成',sources:[]},503));await flush();assert.equal(h.render().answer.text,'正常完成');checks++;
 }
 {
  const h=harness();await h.render().connect();const acknowledgement=deferred();const app=h.render();
  app.businessBarrier.current={visitorId:app.visitorId.current,through:0,status:'confirmed',promise:acknowledgement.promise};
  h.overrides.set('POST /opentalking/sessions/sess_1/transcribe',()=>h.response({session_id:'sess_1',text:'已识别尚未提交'}));
  h.continuous[0].segment(new Float32Array([.1]));await flush();assert.equal(stt(h).length,1);assert.equal(questions(h).length,0);assert.equal(h.render().voiceTurn.current,null);
  h.render().stopMicrophone();acknowledgement.resolve(true);await flush();assert.equal(questions(h).length,0);assert.match(h.markup(),/已取消/);checks++;
 }

 // Resource-level failure is visible even when its original visitor/capture is invalid.
 for(const boundary of ['visitor','capture'])for(const outcome of ['network','timeout','malformed','success']){
  const h=harness();await h.render().connect();const oldVisitor=h.render().visitorId.current,late=deferred();
  h.overrides.set('POST /opentalking/sessions/sess_1/transcribe',()=>late.promise);
  h.continuous[0].segment(new Float32Array([.1]));await flush();
  if(boundary==='visitor')await h.render().resetVisitor();
  await h.render().disconnect();await h.render().connect();await flush();
  const currentVisitor=h.render().visitorId.current,sid=h.render().active.current.mediaSessionId,owner=h.continuous.at(-1);
  assert.equal(currentVisitor===oldVisitor,boundary==='capture');assert.equal(h.continuous.length,2);
  h.overrides.set('POST /opentalking/sessions/'+sid+'/transcribe',()=>h.response({session_id:sid,text:''}));
  owner.segment(new Float32Array([.2]));await flush();assert.equal(stt(h).length,1);assert.match(h.render().recordingHint,/等待识别/);
  if(outcome==='network')late.reject(Error('old request transport failure'));
  if(outcome==='timeout')late.reject(new h.api.RequestError('timeout'));
  if(outcome==='malformed')late.resolve(h.response({session_id:'wrong-old-sid',text:'旧访客私有文字不可回填'}));
  if(outcome==='success')late.resolve(h.response({session_id:'sess_1',text:'旧访客私有文字不可回填'}));
  await flush();h.render().segments.current.pump();await flush();
  assert.ok(!h.markup().includes('旧访客私有文字不可回填'));assert.equal(questions(h).length,0);
  if(outcome==='success'){
   assert.equal(stt(h).length,2);assert.equal(stt(h)[1].url,'/opentalking/sessions/'+sid+'/transcribe');
   assert.doesNotMatch(h.markup(),/识别资源的请求结果未确认/);
  }else{
   assert.equal(stt(h).length,1);assert.match(h.markup(),/语音识别资源的请求结果未确认/);assert.match(h.markup(),/已暂停/);assert.match(h.markup(),/等待片段已放弃/);assert.match(h.markup(),/断开后重新连接/);
   owner.segment(new Float32Array([.3]));await flush();assert.equal(stt(h).length,1);
   await h.render().disconnect();await h.render().connect();await flush();const recoveredSid=h.render().active.current.mediaSessionId;assert.equal(h.render().visitorId.current,currentVisitor);
   h.overrides.set('POST /opentalking/sessions/'+recoveredSid+'/transcribe',()=>h.response({session_id:recoveredSid,text:''}));
   h.continuous.at(-1).segment(new Float32Array([.4]));await flush();assert.equal(stt(h).length,2);assert.equal(stt(h)[1].url,'/opentalking/sessions/'+recoveredSid+'/transcribe');assert.doesNotMatch(h.markup(),/识别资源的请求结果未确认/);
  }
  checks++;
 }

 // The persistent resource warning is independent of ordinary capture/progress text.
 for(const action of ['stopMicrophone','selectPreset','resetVisitor','takeOver','disconnect']){
  const h=harness();await h.render().connect();const owner=h.continuous[0];h.overrides.set('POST /opentalking/sessions/sess_1/transcribe',()=>Promise.reject(Error('unknown')));
  owner.segment(new Float32Array([.1]));await flush();assert.match(h.markup(),/aria-label="语音识别资源状态"/);
  h.overrides.set('POST /guide/questions',init=>h.response({...JSON.parse(init.body),status:'answer',text:'预设仍正常回答',sources:[]}));
  h.overrides.set('POST /opentalking/tts/preview',()=>new Response(new Blob(['wav']),{headers:{'content-type':'audio/wav'}}));
  h.overrides.set('POST /opentalking/sessions/sess_2/speak_flashtalk_audio',()=>h.response({session_id:'sess_2',status:'queued'}));
  if(action==='selectPreset')await h.render().selectPreset('锐伽提供哪些服务？');else await h.render()[action]();await flush();
  assert.match(h.markup(),/aria-label="语音识别资源状态"/);assert.match(h.markup(),/等待片段已放弃/);assert.match(h.markup(),/断开后重新连接/);assert.equal(stt(h).length,1);
  if(action==='selectPreset'){assert.equal(owner.stops,0);assert.equal(h.continuous.length,1);assert.equal(questions(h).length,1);assert.equal(h.render().answer.text,'预设仍正常回答');assert.equal(h.requests.filter(r=>r.url.endsWith('/speak_flashtalk_audio')).length,1);}
  if(h.render().active.current)await h.render().disconnect();await flush();assert.match(h.markup(),/aria-label="语音识别资源状态"/);
  await h.render().connect(action==='takeOver'?'resume':'connect');await flush();assert.doesNotMatch(h.markup(),/aria-label="语音识别资源状态"/);
  const sid=h.render().active.current.mediaSessionId;h.overrides.set('POST /opentalking/sessions/'+sid+'/transcribe',()=>h.response({session_id:sid,text:''}));
  h.continuous.at(-1).segment(new Float32Array([.2]));await flush();assert.equal(stt(h).length,2);checks++;
 }
 console.log(JSON.stringify({status:'passed',checks,scope:'actual App segment callbacks; isolated transport, no real device/model'}));
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>clearTimeout(watchdog));
`;
new Function('require',base+checks)(require);
