// Actual App pipeline; isolated HTTP/capture, no live microphone, model or media.
const fs=require('node:fs');
const base=fs.readFileSync('tests/frontend/visitor-races.cjs','utf8').split('// Execute actual App handlers')[0]
 .replace('demoStatus, speechPending };','demoStatus, speechPending, conversation, turnSequence };');
const checks=String.raw`
const watchdog=setTimeout(()=>{console.error('Continuous answer chain timed out');process.exitCode=1;},10000);
const calls=(h,suffix)=>h.requests.filter(r=>r.url.endsWith(suffix));
function round(h,sid,text,answer,status='answer',questionGate){
 const r={sid,text,answer,status,stt:deferred(),question:deferred(),preview:deferred(),upload:deferred(),ack:deferred()};
 h.overrides.set('POST /opentalking/sessions/'+sid+'/transcribe',init=>{r.file=init.body.get('file');r.stt.resolve();return h.response({session_id:sid,text});});
 h.overrides.set('POST /guide/questions',init=>{r.body=JSON.parse(init.body);r.question.resolve();return questionGate?questionGate.promise:h.response({...r.body,status,text:answer,sources:[]});});
 h.overrides.set('POST /opentalking/tts/preview',init=>{r.previewBody=JSON.parse(init.body);r.preview.resolve();return new Response(new Blob(['wav']),{headers:{'content-type':'audio/wav'}});});
 h.overrides.set('POST /opentalking/sessions/'+sid+'/speak_flashtalk_audio',()=>{r.upload.resolve();return r.ack.promise;});
 return r;
}
async function finish(h,r,order='ack-first'){
 const session=h.render().active.current;
 if(order==='ended-first'){
  session.events.emit('speech.ended');assert.equal(h.render().busy.current,true);assert.equal(h.render().speech.current.phase,'ended');
  r.ack.resolve(h.response({session_id:r.sid,status:'queued'}));await session.upload;
 }else{
  r.ack.resolve(h.response({session_id:r.sid,status:'queued'}));await session.upload;
  assert.equal(h.render().busy.current,true);assert.ok(h.render().speech.current);session.events.emit('speech.media_started');session.events.emit('speech.ended');
 }
}
(async()=>{
 let checks=0;
 // Three full normal cycles. Identical text in rounds2/3 is not a duplicate turn.
 {
  const h=harness();await h.render().connect();const owner=h.continuous[0],visitor=h.render().visitorId.current,ids=[],seq=[];
  for(let i=0;i<3;i++){
   const r=round(h,'sess_1',i?'相同问题':'第一问',i?'相同回答':'第一答');
   await owner.realStart();owner.segment(new Float32Array([-.25,.5]));await r.upload.promise;
   assert.equal(h.render().answer.text,r.answer);assert.equal(r.previewBody.text,r.answer);assert.equal(h.render().conversation.at(-1).result.text,r.previewBody.text);
   assert.equal(r.body.question,r.text);assert.equal(r.body.visitor_id,visitor);ids.push(r.body.turn_id);seq.push(r.body.turn_seq);
   assert.equal(new DataView(await r.file.arrayBuffer()).getInt16(44,true),-8192);
   assert.equal(calls(h,'/transcribe').at(-1).timeoutMs,45000);assert.equal(calls(h,'/questions').at(-1).timeoutMs,30000);
   assert.equal(calls(h,'/tts/preview').at(-1).timeoutMs,45000);assert.equal(calls(h,'/speak_flashtalk_audio').at(-1).timeoutMs,30000);
   await finish(h,r);assert.equal(h.render().speech.current,null);assert.equal(h.render().busy.current,false);
   h.render().active.current.events.emit('speech.ended');assert.equal(h.render().speech.current,null);
  }
  assert.equal(new Set(ids).size,3);assert.deepEqual(seq,[1,2,3]);
  for(const suffix of ['/transcribe','/questions','/tts/preview','/speak_flashtalk_audio'])assert.equal(calls(h,suffix).length,3);
  assert.equal(h.render().conversation.length,3);assert.equal(h.continuous.length,1);assert.equal(owner.stops,0);assert.equal(owner.listens,1);assert.equal(h.created(),1);checks++;
 }
 // The waiting-slot boundary is exercised directly; not a simulated physical VAD timeline.
 // Only the vendor's normal single-ended publication contract is assumed.
 for(const order of ['ack-first','ended-first']){
  const h=harness();await h.render().connect();const owner=h.continuous[0],r=round(h,'sess_1','第一段','第一答');owner.segment(new Float32Array([.1]));await r.upload.promise;
  const next=round(h,'sess_1','等待段','等待答');owner.segment(new Float32Array([.2]));assert.equal(calls(h,'/transcribe').length,1);
  const session=h.render().active.current;
  if(order==='ack-first'){
   r.ack.resolve(h.response({session_id:'sess_1',status:'queued'}));await session.upload;assert.equal(calls(h,'/transcribe').length,1);assert.equal(h.render().busy.current,true);session.events.emit('speech.ended');
  }else{
   session.events.emit('speech.ended');assert.equal(calls(h,'/transcribe').length,1);assert.equal(h.render().busy.current,true);r.ack.resolve(h.response({session_id:'sess_1',status:'queued'}));await session.upload;
  }
  await next.upload.promise;assert.equal(calls(h,'/transcribe').length,2);assert.equal(calls(h,'/speak_flashtalk_audio').length,2);
  assert.notEqual(next.body.turn_id,r.body.turn_id);await finish(h,next);assert.equal(h.render().busy.current,false);checks++;
 }
 // Capture stop is independent after the business POST. A preset then works without recapture.
 {
  const h=harness();await h.render().connect();const owner=h.continuous[0],visitor=h.render().visitorId.current,gate=deferred();
  const r=round(h,'sess_1','已提交的问题','停止后回答','answer',gate);owner.segment(new Float32Array([.1]));await r.question.promise;
  h.render().stopMicrophone();assert.equal(owner.released,true);assert.equal(h.render().active.current.controller.signal.aborted,false);
  gate.resolve(h.response({...r.body,status:'answer',text:r.answer,sources:[]}));await r.upload.promise;assert.equal(r.previewBody.text,r.answer);await finish(h,r);
  const preset=round(h,'sess_2','unused','预设回答');await h.render().selectPreset('锐伽提供哪些服务？');await preset.upload.promise;await finish(h,preset);
  assert.equal(preset.body.visitor_id,visitor);assert.notEqual(preset.body.turn_id,r.body.turn_id);assert.equal(preset.body.turn_seq,2);
  assert.equal(calls(h,'/transcribe').length,1);assert.equal(calls(h,'/questions').length,2);assert.equal(calls(h,'/speak_flashtalk_audio').length,2);
  assert.equal(h.continuous.length,1);assert.equal(owner.released,true);assert.equal(h.render().microphone.current,null);checks++;
 }
 // Integrate the accepted17 recovery path with a complete new segment and answer.
 {
  const h=harness();await h.render().connect();const owner=h.continuous[0],visitor=h.render().visitorId.current,old=h.render().active.current,gate=deferred();
  const prior=round(h,'sess_1','old','旧答','answer',gate),work=h.render().sendQuestion(old,'旧问题');await prior.question.promise;
  const next=round(h,'sess_2','插话完整问题','新回答');const recovery=owner.realStart();owner.segment(new Float32Array([-.5,.1]));await recovery;await next.upload.promise;
  assert.equal(new DataView(await next.file.arrayBuffer()).getInt16(44,true),-16384);assert.equal(next.body.visitor_id,visitor);assert.equal(h.continuous.length,1);assert.equal(owner.stops,0);assert.equal(h.created(),2);
  const speech=h.render().speech.current;old.events.emit('speech.ended');assert.equal(h.render().speech.current,speech);assert.equal(h.render().busy.current,true);
  gate.resolve(h.response({...prior.body,status:'answer',text:'旧答禁止回填',sources:[]}));await work;assert.equal(calls(h,'/tts/preview').length,1);assert.equal(h.render().answer.text,'新回答');await finish(h,next);checks++;
 }
 // Whole-answer failures retain available text, never retry, and still permit manual takeover.
 // STT unknown/45s isolation is reused from the existing voice-segments App suite.
 for(const stage of ['business-error','business-identity','preview','upload']){
  const h=harness();await h.render().connect();const session=h.render().active.current;
  const r=round(h,'sess_1','问题','保留的回答');
  if(stage==='business-error')h.overrides.set('POST /guide/questions',init=>h.response({...JSON.parse(init.body),status:'error',text:'业务失败',sources:[]},503));
  if(stage==='business-identity')h.overrides.set('POST /guide/questions',init=>h.response({...JSON.parse(init.body),turn_id:'wrong',status:'answer',text:'拒绝错配',sources:[]}));
  if(stage==='preview')h.overrides.set('POST /opentalking/tts/preview',()=>{throw new h.api.RequestError('timeout');});
  if(stage==='upload')h.overrides.set('POST /opentalking/sessions/sess_1/speak_flashtalk_audio',()=>{throw new h.api.RequestError('timeout');});
  await h.render().sendQuestion(session,'问题');assert.equal(calls(h,'/questions').length,1);assert.equal(h.render().conversation[0].question,'问题');
  if(stage.startsWith('business'))assert.equal(calls(h,'/tts/preview').length,0);else assert.equal(h.render().conversation[0].result.text,'保留的回答');
  if(stage==='business-error')assert.equal(h.render().answer.status,'error');
  if(stage==='business-identity')assert.ok(h.render().questionError);
  if(stage==='preview')assert.match(h.markup(),/播报未完成/);
  if(stage==='upload'){assert.match(h.markup(),/上传结果未确认/);assert.equal(calls(h,'/speak_flashtalk_audio').length,1);}
  await h.render().takeOver();assert.equal(h.render().mode,'human');assert.equal(h.continuous[0].released,true);assert.equal(h.created(),1);checks++;
 }
 for(const text of ['', '长'.repeat(1001)]){
  const h=harness();await h.render().connect();round(h,'sess_1','问题',text);await h.render().sendQuestion(h.render().active.current,'问题');
  assert.equal(h.render().answer.text,text);assert.equal(h.render().conversation[0].result.text,text);assert.equal(calls(h,'/tts/preview').length,0);assert.equal(calls(h,'/speak_flashtalk_audio').length,0);assert.ok(h.render().answerSpeechStatus);assert.equal(h.render().busy.current,false);checks++;
 }
 {
  const h=harness();await h.render().connect();const r=round(h,'sess_1','不完整问题','请说明哪个案例','clarify');const work=h.render().sendQuestion(h.render().active.current,'不完整问题');await r.upload.promise;
  assert.equal(h.render().answer.status,'clarify');assert.equal(r.previewBody.text,h.render().answer.text);await finish(h,r,'ended-first');await work;assert.equal(calls(h,'/speak_flashtalk_audio').length,1);assert.equal(h.render().busy.current,false);checks++;
 }
 console.log(JSON.stringify({status:'passed',checks,scope:'isolated actual App chain; normal serial single-ended SSE contract only; no physical media claims'}));
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>clearTimeout(watchdog));
`;
new Function('require',base+checks)(require);
