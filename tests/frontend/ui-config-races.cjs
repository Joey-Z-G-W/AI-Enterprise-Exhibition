// Actual App handlers with isolated transport/capture; no local config or services.
const fs=require('node:fs');
const base=fs.readFileSync('tests/frontend/visitor-races.cjs','utf8').split('// Execute actual App handlers')[0];
const checks=String.raw`
const watchdog=setTimeout(()=>{console.error('UI config checks timed out');process.exitCode=1;},10000);
const configPath='GET /guide/ui-config';
const A={avatar_id:'fixture-avatar-a',tts_voice:'fixture-voice-a'};
const B={avatar_id:'fixture-avatar-b',tts_voice:'fixture-voice-b'};
const C={avatar_id:'fixture-avatar-c',tts_voice:'fixture-voice-c'};
const creates=h=>h.workRequests.filter(r=>r.url==='/opentalking/sessions'&&r.method==='POST');
const previews=h=>h.workRequests.filter(r=>r.url==='/opentalking/tts/preview').map(r=>JSON.parse(r.body));
function media(h,id,started){
 h.overrides.set('POST /opentalking/tts/preview',()=>new Response(new Blob(['wav']),{headers:{'content-type':'audio/wav'}}));
 h.overrides.set('POST /opentalking/sessions/'+id+'/speak_flashtalk_audio',()=>{started?.resolve();return h.response({session_id:id,status:'queued'});});
}
function answer(h){h.overrides.set('POST /guide/questions',init=>h.response({...JSON.parse(init.body),status:'answer',text:'fixture answer',sources:[]}));}
(async()=>{
 let checks=0;
 // Explicit backend defaults remain supported; the frontend makes no fallback.
 {
  const h=harness();await h.render().connect();await finishWelcome(h);
  const get=h.workRequests.find(r=>r.url==='/guide/ui-config'),created=creates(h)[0];
  assert.equal(get.timeoutMs,10000);assert.ok(get.signal);assert.ok(h.workRequests.indexOf(get)<h.workRequests.indexOf(created));
  assert.equal(JSON.parse(created.body).avatar_id,'companion');assert.equal(JSON.parse(created.body).tts_voice,'zh-CN-XiaoxiaoNeural');checks++;
 }
 // Snapshot survives changed backend configuration; every new media session reads anew.
 {
  const h=harness();let config={...A};h.overrides.set(configPath,()=>h.response(config));await h.render().connect();await finishWelcome(h);
  const old=h.render().active.current,visitor=h.render().visitorId.current,owner=h.continuous[0];
  assert.equal(Object.isFrozen(old.uiConfig),true);assert.equal(old.uiConfig.avatar_id,A.avatar_id);
  config={...B};media(h,'sess_1');await h.render().playDemo();assert.equal(previews(h).at(-1).voice,A.tts_voice);
  old.events.emit('speech.ended');answer(h);await h.render().sendQuestion(old,'fixture question');assert.equal(previews(h).at(-1).voice,A.tts_voice);
  await owner.realStart();assert.equal(h.created(),2);assert.equal(h.continuous.length,1);assert.equal(owner.stops,0);assert.equal(h.render().visitorId.current,visitor);
  assert.equal(JSON.parse(creates(h)[1].body).avatar_id,B.avatar_id);assert.equal(JSON.parse(creates(h)[1].body).tts_voice,B.tts_voice);
  media(h,'sess_2');await h.render().playDemo();assert.equal(previews(h).at(-1).voice,B.tts_voice); // Still speaking: replacement must load the next snapshot.
  config={...C};const uploaded=deferred();media(h,'sess_3',uploaded);await h.render().selectPreset('公司提供哪些服务？');await uploaded.promise;
  assert.equal(JSON.parse(creates(h)[2].body).avatar_id,C.avatar_id);assert.equal(previews(h).at(-1).voice,C.tts_voice);
  assert.equal(h.workRequests.filter(r=>r.url==='/guide/ui-config').length,3);assert.equal(h.continuous.length,1);assert.equal(owner.stops,0);assert.equal(h.render().visitorId.current,visitor);checks++;
 }
 // Reject all malformed/config transport responses, without entering unknown-create isolation.
 const malformed=[null,[],{}, {avatar_id:'a'}, {...A,extra:'no'}, {...A,avatar_id:7}, {...A,tts_voice:null},
  {...A,avatar_id:''}, {...A,tts_voice:''}, {...A,avatar_id:'has space'}, {...A,tts_voice:'bad\nvoice'},
  {...A,avatar_id:'x'.repeat(129)}, {...A,tts_voice:'x'.repeat(129)}];
 for(const fault of [...malformed,'http','json','network','timeout']){
  const h=harness();h.overrides.set(configPath,()=>{
   if(fault==='network')throw Error('transport');if(fault==='timeout')throw new h.api.RequestError('timeout');
   if(fault==='http')return h.response({detail:'failed'},503);if(fault==='json')return new Response('{');
   return h.response(fault);
  });
  await h.render().connect();await finishWelcome(h);assert.equal(creates(h).length,0);assert.equal(h.render().active.current,null);assert.equal(h.render().retired.current,null);
  assert.match(h.markup(),/人物与音色配置加载失败/);assert.doesNotMatch(h.markup(),/旧会话释放未确认/);assert.equal(h.continuous[0].released,true);
  h.overrides.set(configPath,()=>h.response(A));await h.render().connect();await finishWelcome(h);assert.equal(creates(h).length,1);assert.equal(JSON.parse(creates(h)[0].body).avatar_id,A.avatar_id);checks++;
 }
 // Maximum Unicode character counts are accepted rather than UTF16-code-unit length.
 {
  const h=harness(),config={avatar_id:'界'.repeat(128),tts_voice:'😀'.repeat(128)};h.overrides.set(configPath,()=>h.response(config));await h.render().connect();await finishWelcome(h);
  assert.equal(creates(h).length,1);assert.equal(JSON.parse(creates(h)[0].body).tts_voice,config.tts_voice);checks++;
 }
 // A late cancelled config cannot submit or overwrite a new visitor/session, on either success or failure.
 for(const action of ['disconnect','resetVisitor','takeOver','dispose'])for(const late of ['success','failure']){
  const h=harness(),pending=deferred(),started=deferred();let count=0;
  h.overrides.set(configPath,()=>{if(++count===1){started.resolve();return pending.promise;}return h.response(B);});
  const connecting=h.render().connect();await started.promise;const old=h.render().active.current,owner=h.continuous[0],visitor=h.render().visitorId.current;
  if(action==='dispose')h.dispose();else await h.render()[action]();
  assert.equal(old.controller.signal.aborted,true);assert.equal(owner.released,true);assert.equal(creates(h).length,action==='resetVisitor'?1:0);
  if(action==='disconnect')await h.render().connect();await finishWelcome(h);if(action==='takeOver')await h.render().connect('resume');await finishWelcome(h);
  const active=h.render().active.current,notice=h.render().notice,owners=h.continuous.length;
  if(late==='success')pending.resolve(h.response(A));else pending.reject(Error('late configuration failure'));
  await connecting;await finishWelcome(h);assert.equal(h.render().active.current,active);assert.equal(h.render().notice,notice);assert.equal(h.continuous.length,owners);
  assert.equal(creates(h).length,action==='dispose'?0:1);assert.equal(h.render().retired.current,null);
  if(action==='resetVisitor')assert.notEqual(h.render().visitorId.current,visitor);
  if(active)assert.equal(active.uiConfig.tts_voice,B.tts_voice);checks++;
 }
 // Competing explicit clicks share one precreation operation.
 {
  const h=harness(),pending=deferred(),started=deferred();h.overrides.set(configPath,()=>{started.resolve();return pending.promise;});
  const first=h.render().connect();await started.promise;await h.render().connect();await finishWelcome(h);assert.equal(creates(h).length,0);
  pending.resolve(h.response(A));await first;await finishWelcome(h);assert.equal(creates(h).length,1);assert.equal(h.workRequests.filter(r=>r.url==='/guide/ui-config').length,1);assert.equal(h.continuous.length,1);checks++;
 }
 // Once POST started, unknown outcomes remain quarantined; config success does not weaken that boundary.
 for(const failure of ['network','http','malformed']){
  const h=harness();h.overrides.set('POST /opentalking/sessions',()=>{
   if(failure==='network')throw Error('unknown');return failure==='http'?h.response({detail:'unknown'},500):h.response({wrong:'shape'});
  });
  await h.render().connect();await finishWelcome(h);assert.equal(creates(h).length,1);assert.ok(h.render().retired.current?.creation);assert.match(h.markup(),/旧会话释放未确认/);
  await h.render().connect();await finishWelcome(h);assert.equal(creates(h).length,1);assert.equal(h.workRequests.filter(r=>r.url==='/guide/ui-config').length,1);checks++;
 }
 console.log(JSON.stringify({status:'passed',checks,scope:'actual App configuration snapshots and cancellation; isolated transport/capture'}));
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>clearTimeout(watchdog));
`;
new Function('require',base+checks)(require);
