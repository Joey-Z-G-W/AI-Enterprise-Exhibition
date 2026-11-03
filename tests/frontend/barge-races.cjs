const fs=require('node:fs');
const base=fs.readFileSync('tests/frontend/visitor-races.cjs','utf8').split('// Execute actual App handlers')[0];
const checks=String.raw`
const watchdog=setTimeout(()=>{console.error('Barge-in checks timed out');process.exitCode=1;},10000);
const calls=(h,suffix)=>h.requests.filter(r=>r.url.endsWith(suffix));
function audio(h,id='sess_1'){
 h.overrides.set('POST /opentalking/tts/preview',()=>new Response(new Blob(['wav']),{headers:{'content-type':'audio/wav'}}));
 h.overrides.set('POST /opentalking/sessions/'+id+'/speak_flashtalk_audio',()=>h.response({session_id:id,status:'queued'}));
}
const errorBusiness=h=>h.overrides.set('POST /guide/questions',init=>h.response({...JSON.parse(init.body),status:'error',text:'offline',sources:[]},503));
(async()=>{
 let checks=0;
 {
  const h=harness(),gate=deferred();h.overrides.set('GET /opentalking/sessions/sess_1',()=>gate.promise);const connecting=h.render().connect();await flush();
  await h.continuous[0].realStart();assert.equal(h.created(),1);assert.equal(h.requests.filter(r=>r.method==='DELETE').length,0);
  gate.resolve(h.response({session_id:'sess_1',state:'ready'}));await connecting;await h.continuous[0].realStart();assert.equal(h.created(),1);checks++;console.log(JSON.stringify({completed:checks}));
 }
 // Late question result cannot return or synthesize; the triggering complete segment survives to the new SID.
 {
  const h=harness();await h.render().connect();const visitor=h.render().visitorId.current,owner=h.continuous[0],old=h.render().active.current,late=deferred(),ready=deferred();let oldBody;
  h.overrides.set('POST /guide/questions',init=>{oldBody=JSON.parse(init.body);return late.promise;});const question=h.render().sendQuestion(old,'old');await flush();
  h.overrides.set('GET /opentalking/sessions/sess_2',()=>ready.promise);const discards=owner.discards,recovery=owner.realStart();assert.equal(h.render().video.current.muted,true);assert.equal(old.controller.signal.aborted,true);assert.equal(owner.discards,discards);assert.equal(owner.stops,0);
  await flush();owner.segment(new Float32Array([-.25,.5]));await owner.realStart();await flush();assert.equal(calls(h,'/transcribe').length,0);assert.equal(h.created(),2);assert.equal(h.requests.filter(r=>r.method==='DELETE'&&r.url.endsWith('sess_2')).length,0);
  errorBusiness(h);h.overrides.set('POST /opentalking/sessions/sess_2/transcribe',()=>h.response({session_id:'sess_2',text:'完整插话'}));ready.resolve(h.response({session_id:'sess_2',state:'ready'}));await recovery;await flush();
  assert.equal(calls(h,'/transcribe').length,1);assert.match(calls(h,'/transcribe')[0].url,/sess_2/);const bytes=new DataView(await calls(h,'/transcribe')[0].body.get('file').arrayBuffer());assert.equal(bytes.getInt16(44,true),-8192);
  late.resolve(h.response({...oldBody,status:'answer',text:'旧回答不得回填',sources:[]}));await question;assert.ok(!h.markup().includes('旧回答不得回填'));assert.equal(calls(h,'/tts/preview').length,0);assert.equal(h.render().visitorId.current,visitor);assert.equal(h.continuous.length,1);checks++;console.log(JSON.stringify({completed:checks}));
 }
 {
  const h=harness();await h.render().connect();const late=deferred();h.overrides.set('POST /opentalking/tts/preview',()=>late.promise);const demo=h.render().playDemo();await flush();await h.continuous[0].realStart();
  late.resolve(new Response(new Blob(['late']),{headers:{'content-type':'audio/wav'}}));await demo;assert.equal(calls(h,'/speak_flashtalk_audio').length,0);assert.equal(h.created(),2);assert.equal(h.continuous.length,1);checks++;console.log(JSON.stringify({completed:checks}));
 }
 // Final interrupt is after upload settlement; DELETE200 and GETclosing do not release the replacement.
 {
  const h=harness();await h.render().connect();audio(h);const upload=deferred(),started=deferred(),closed=deferred(),old=h.render().active.current;h.overrides.set('POST /opentalking/sessions/sess_1/speak_flashtalk_audio',()=>{started.resolve();return upload.promise;});
  const demo=h.render().playDemo();await started.promise;const sent=calls(h,'/speak_flashtalk_audio')[0];assert.equal(sent.timeoutMs,30000);assert.equal(sent.signal,undefined);
  const recovery=h.continuous[0].realStart();await flush();assert.equal(calls(h,'/interrupt').length,0);assert.equal(h.created(),1);assert.equal(old.controller.signal.aborted,true);
  let gets=0;h.overrides.set('GET /opentalking/sessions/sess_1',()=>++gets===1?h.response({session_id:'sess_1',state:'closing'}):closed.promise);
  upload.resolve(h.response({session_id:'sess_1',status:'queued'}));await flush();assert.equal(calls(h,'/interrupt').length,1);assert.equal(h.requests.filter(r=>r.method==='DELETE').length,1);assert.equal(h.created(),1);await h.continuous[0].realStart();assert.equal(h.created(),1);
  closed.resolve(h.response({session_id:'sess_1',state:'closed'}));await recovery;await demo;assert.equal(h.created(),2);
  const interruptIndex=h.requests.findIndex(r=>r.url.endsWith('/interrupt')),deleteIndex=h.requests.findIndex(r=>r.method==='DELETE');assert.ok(deleteIndex>interruptIndex);
  audio(h,'sess_2');await h.render().playDemo();const currentSpeech=h.render().speech.current;old.events.emit('speech.ended');old.events.emit('speech.media_started');assert.equal(h.render().speech.current,currentSpeech);assert.equal(h.render().busy.current,true);checks++;console.log(JSON.stringify({completed:checks}));
 }
 for(const failure of ['network','timeout','sid','status']){
  const h=harness();await h.render().connect();audio(h);const upload=deferred(),started=deferred();h.overrides.set('POST /opentalking/sessions/sess_1/speak_flashtalk_audio',()=>{started.resolve();return upload.promise;});const demo=h.render().playDemo();await started.promise;const recovery=h.continuous[0].realStart();await flush();
  if(failure==='network')upload.reject(Error('network'));else if(failure==='timeout')upload.reject(new h.api.RequestError('timeout'));else upload.resolve(h.response({session_id:failure==='sid'?'wrong':'sess_1',status:failure==='status'?'interrupted':'queued'}));
  await recovery;await demo;assert.equal(h.created(),1);assert.equal(calls(h,'/interrupt').length,0);assert.equal(calls(h,'/speak_flashtalk_audio').length,1);assert.match(h.markup(),/媒体上传隔离/);assert.match(h.markup(),/上传结果未确认/);
  await h.render().connect();assert.equal(h.created(),1);assert.match(h.markup(),/上传结果未确认/);checks++;console.log(JSON.stringify({completed:checks}));
 }
 // New utterances do not renew an existing waiting segment's fixed deadline.
 {
  const h=harness();await h.render().connect();audio(h);const upload=deferred(),started=deferred();h.overrides.set('POST /opentalking/sessions/sess_1/speak_flashtalk_audio',()=>{started.resolve();return upload.promise;});const demo=h.render().playDemo();await started.promise;const recovery=h.continuous[0].realStart();h.continuous[0].segment(new Float32Array([.1]));
  await h.advance(10000);await h.continuous[0].realStart();await h.advance(5000);assert.match(h.markup(),/15秒/);upload.resolve(h.response({session_id:'sess_1',status:'queued'}));await recovery;await demo;assert.equal(calls(h,'/transcribe').length,0);checks++;console.log(JSON.stringify({completed:checks}));
 }
 // Ordinary lifecycle actions during a pending upload cannot reopen capture or submit discarded speech.
 for(const action of ['stopMicrophone','resetVisitor','takeOver','dispose']){
  const h=harness();await h.render().connect();audio(h);const owner=h.continuous[0],upload=deferred(),started=deferred(),visitor=h.render().visitorId.current;h.overrides.set('POST /opentalking/sessions/sess_1/speak_flashtalk_audio',()=>{started.resolve();return upload.promise;});const demo=h.render().playDemo();await started.promise;
  const recovery=owner.realStart();owner.segment(new Float32Array([.1]));await flush();const actionWork=action==='dispose'?h.dispose():h.render()[action]();await flush();assert.equal(owner.stops,1);assert.equal(h.created(),1);assert.equal(calls(h,'/interrupt').length,0);
  upload.resolve(h.response({session_id:'sess_1',status:'queued'}));await Promise.all([recovery,demo,actionWork]);await flush();assert.equal(calls(h,'/transcribe').length,0);assert.equal(h.continuous.length,1);assert.equal(owner.released,true);
  assert.equal(h.created(),['stopMicrophone','resetVisitor'].includes(action)?2:1);if(action==='resetVisitor')assert.notEqual(h.render().visitorId.current,visitor);checks++;console.log(JSON.stringify({completed:checks}));
 }
 // User reset/disconnect during the new QuickTalk init waits through transient closed, never closes ahead of init.
 for(const action of ['resetVisitor','disconnect']){
  const h=harness();await h.render().connect();audio(h);await h.render().playDemo();const original=deferred(),initialized=deferred(),getStarted=deferred();let gets=0;
  h.overrides.set('GET /opentalking/sessions/sess_2',()=>{gets++;if(gets===1){getStarted.resolve();return original.promise;}if(gets===2)return h.response({session_id:'sess_2',state:'closed'});if(gets===3)return initialized.promise;return h.response({session_id:'sess_2',state:h.states.get('sess_2')});});
  const recovery=h.continuous[0].realStart();await getStarted.promise;assert.equal(h.created(),2);const actionWork=h.render()[action]();await flush();assert.equal(h.requests.filter(r=>r.method==='DELETE'&&r.url.endsWith('sess_2')).length,0);assert.equal(h.created(),2);
  initialized.resolve(h.response({session_id:'sess_2',state:'worker_ready'}));await actionWork;original.resolve(h.response({session_id:'sess_2',state:'worker_ready'}));await recovery;assert.equal(h.requests.filter(r=>r.method==='DELETE'&&r.url.endsWith('sess_2')).length,1);assert.equal(h.created(),action==='resetVisitor'?3:2);assert.equal(h.continuous.length,1);checks++;console.log(JSON.stringify({completed:checks}));
 }
 {
  const h=harness();await h.render().connect();audio(h);await h.render().playDemo();h.overrides.set('POST /opentalking/sessions',()=>h.response({error:'unknown'},500));await h.continuous[0].realStart();
  const count=h.requests.filter(r=>r.url==='/opentalking/sessions'&&r.method==='POST').length;assert.equal(count,2);await h.render().connect();assert.equal(h.requests.filter(r=>r.url==='/opentalking/sessions'&&r.method==='POST').length,count);checks++;console.log(JSON.stringify({completed:checks}));
 }

 {
  const h=harness();await h.render().connect();const old=deferred();h.overrides.set('POST /guide/questions',()=>old.promise);const answering=h.render().sendQuestion(h.render().active.current,'old');await flush();
  const body=JSON.parse(calls(h,'/questions')[0].body),v=h.render().visitorId.current;
  h.overrides.set('POST /guide/visitors/'+v+'/invalidate',()=>Promise.reject(Error('ACK unknown')));
  await h.continuous[0].realStart();h.continuous[0].segment(new Float32Array([.1]));await flush();assert.equal(h.created(),2);assert.equal(calls(h,'/transcribe').length,0);assert.match(h.markup(),/取消尚未确认/);
  await h.advance(15000);assert.match(h.markup(),/15秒/);old.resolve(h.response({...body,status:'error',text:'late',sources:[]}));await answering;assert.equal(calls(h,'/transcribe').length,0);checks++;console.log(JSON.stringify({completed:checks}));
 }
 console.log(JSON.stringify({status:'passed',checks,scope:'actual App barge-in, upload/init/close barriers; isolated media and HTTP only'}));
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>clearTimeout(watchdog));
`;
new Function('require',base+checks)(require);
