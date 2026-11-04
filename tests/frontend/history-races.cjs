const fs = require('node:fs');
const base = fs.readFileSync('tests/frontend/visitor-races.cjs','utf8').split('// Execute actual App handlers')[0]
  .replace('demoStatus, speechPending };','demoStatus, speechPending, conversation, turnSequence, businessBarrier, invalidateBusiness };');
const checks = String.raw`
const calls=h=>h.workRequests.filter(r=>r.url==='/guide/questions');
const cancellations=h=>h.workRequests.filter(r=>r.url.endsWith('/invalidate'));
function business(h){h.overrides.set('POST /guide/questions',init=>{const b=JSON.parse(init.body);return h.response({visitor_id:b.visitor_id,turn_id:b.turn_id,turn_seq:b.turn_seq,status:'error',text:'unavailable',sources:[]},503);});}
const watchdog=setTimeout(()=>{console.error('History checks timed out');process.exitCode=1;},10000);
(async()=>{
 let checks=0;
 // Sequence survives internal media rebuild and starts over only for a different visitor.
 {
  const h=harness();await h.render().connect();await finishWelcome(h);business(h);const visitor=h.render().visitorId.current;
  await h.render().sendQuestion(h.render().active.current,'one');
  await h.render().disconnect();await h.render().connect();await finishWelcome(h);
  await h.render().sendQuestion(h.render().active.current,'two');
  assert.deepEqual(calls(h).map(r=>JSON.parse(r.body).turn_seq),[1,2]);
  assert.equal(h.render().visitorId.current,visitor);
  await h.render().resetVisitor();await finishWelcome(h);await h.render().sendQuestion(h.render().active.current,'new group');
  assert.equal(JSON.parse(calls(h)[2].body).turn_seq,1);
  assert.notEqual(JSON.parse(calls(h)[2].body).visitor_id,visitor);checks++;
 }
 // Same visitor reconnect alone cannot erase unknown status; its single explicit retry can also fail.
 {
  const h=harness();await h.render().connect();await finishWelcome(h);business(h);await h.render().sendQuestion(h.render().active.current,'first');
  const v=h.render().visitorId.current;
  h.overrides.set('POST /guide/visitors/'+v+'/invalidate',()=>Promise.reject(Error('no ACK')));
  await h.render().disconnect();await flush();assert.match(h.markup(),/business-warning[^>]*>[^<]*取消尚未确认/);
  await h.render().connect();await finishWelcome(h);await flush();
  assert.equal(h.render().connection,'playing');assert.equal(h.render().visitorId.current,v);
  assert.match(h.markup(),/business-warning[^>]*>[^<]*取消尚未确认/);
  assert.equal(cancellations(h).length,2);assert.equal(calls(h).length,1);checks++;
 }
 // Pending cancellation remains visible through ready/playing; connect does not duplicate an in-flight retry.
 {
  const h=harness();await h.render().connect();await finishWelcome(h);business(h);await h.render().sendQuestion(h.render().active.current,'first');
  const v=h.render().visitorId.current,gate=deferred();
  h.overrides.set('POST /guide/visitors/'+v+'/invalidate',()=>gate.promise);
  await h.render().disconnect();await h.render().connect();await finishWelcome(h);
  assert.equal(h.render().connection,'playing');assert.equal(cancellations(h).length,1);
  assert.match(h.markup(),/business-warning[^>]*>正在确认旧问答取消/);
  gate.resolve(h.response({visitor_id:v,cancelled_through:1,retired:false}));await flush();
  assert.doesNotMatch(h.markup(),/class="notice business-warning"/);assert.equal(calls(h).length,1);checks++;
 }
 // A successful explicit reconnect retry acknowledges the same watermark and restores submission.
 {
  const h=harness();await h.render().connect();await finishWelcome(h);business(h);await h.render().sendQuestion(h.render().active.current,'first');
  const v=h.render().visitorId.current;
  h.overrides.set('POST /guide/visitors/'+v+'/invalidate',()=>Promise.reject(Error('lost ACK')));
  await h.render().disconnect();await flush();
  h.overrides.set('POST /guide/visitors/'+v+'/invalidate',init=>{
   assert.equal(JSON.parse(init.body).through_turn_seq,1);return h.response({visitor_id:v,cancelled_through:1,retired:false});
  });
  await h.render().connect();await finishWelcome(h);await flush();assert.equal(cancellations(h).length,2);
  assert.doesNotMatch(h.markup(),/class="notice business-warning"/);
  await h.render().sendQuestion(h.render().active.current,'second');assert.equal(calls(h).length,2);checks++;
 }
 // Lower/old visitor acknowledgements cannot clear another active warning; explicit group reset may clear it.
 {
  const h=harness();await h.render().connect();await finishWelcome(h);const old=h.render().visitorId.current,low=deferred(),high=deferred();
  h.overrides.set('POST /guide/visitors/'+old+'/invalidate',init=>{
   const b=JSON.parse(init.body);if(b.retire)return h.response({visitor_id:old,cancelled_through:b.through_turn_seq,retired:true});
   return b.through_turn_seq===1?low.promise:high.promise;
  });
  const first=h.render().invalidateBusiness(old,1),second=h.render().invalidateBusiness(old,2);
  low.resolve(h.response({visitor_id:old,cancelled_through:1,retired:false}));await first;await finishWelcome(h);
  assert.match(h.markup(),/business-warning[^>]*>正在确认旧问答取消/);
  await h.render().resetVisitor();await finishWelcome(h);assert.doesNotMatch(h.markup(),/class="notice business-warning"/);
  const next=h.render().visitorId.current,newGate=deferred();
  h.overrides.set('POST /guide/visitors/'+next+'/invalidate',()=>newGate.promise);
  const third=h.render().invalidateBusiness(next,1);
  high.resolve(h.response({visitor_id:old,cancelled_through:2,retired:false}));await second;
  assert.match(h.markup(),/business-warning[^>]*>正在确认旧问答取消/);
  newGate.reject(Error('new group unknown'));await third;
  assert.match(h.markup(),/business-warning[^>]*>[^<]*取消尚未确认/);checks++;
 }
 // Cancellation has an independent signal and a newer question waits for its acknowledgement.
 {
  const h=harness();await h.render().connect();await finishWelcome(h);business(h);
  await h.render().sendQuestion(h.render().active.current,'one');
  await startBusyDemo(h);const old=h.render().active.current,v=old.visitorId,gate=deferred();
  h.overrides.set('POST /guide/visitors/'+v+'/invalidate',()=>gate.promise);
  const selected=h.render().selectPreset('品牌设计包含哪些内容？');await flush();
  assert.equal(old.controller.signal.aborted,true);
  assert.equal(cancellations(h).at(-1).signal,undefined);
  assert.equal(JSON.parse(cancellations(h).at(-1).body).through_turn_seq,1);
  assert.equal(calls(h).length,1);
  gate.resolve(h.response({visitor_id:v,cancelled_through:1,retired:false}));await selected;
  assert.equal(calls(h).length,2);assert.equal(JSON.parse(calls(h)[1].body).turn_seq,2);
  assert.equal(h.captures.length,0);checks++;
 }
 // An unknown cancellation result blocks submission rather than claiming server cancellation.
 {
  const h=harness();await h.render().connect();await finishWelcome(h);business(h);await h.render().sendQuestion(h.render().active.current,'one');
  await startBusyDemo(h);const v=h.render().visitorId.current;
  h.overrides.set('POST /guide/visitors/'+v+'/invalidate',()=>Promise.reject(Error('lost ack')));
  await h.render().selectPreset('品牌设计包含哪些内容？');
  await flush();assert.equal(calls(h).length,1);assert.match(h.markup(),/business-warning[^>]*>[^<]*取消尚未确认/);
  assert.match(h.render().questionError,/断开后重新连接/);assert.match(h.render().conversation.at(-1).error,/取消尚未确认/);checks++;
 }
 // Late failed retirement cannot overwrite a new group's response or prompt.
 {
  const h=harness();await h.render().connect();await finishWelcome(h);business(h);await h.render().sendQuestion(h.render().active.current,'old');
  const v=h.render().visitorId.current,gate=deferred();
  h.overrides.set('POST /guide/visitors/'+v+'/invalidate',()=>gate.promise);
  const reset=h.render().resetVisitor();await flush();await h.render().sendQuestion(h.render().active.current,'new');
  const notice=h.render().notice,error=h.render().questionError;
  gate.reject(Error('late retirement unknown'));await reset;await flush();
  assert.equal(h.render().notice,notice);assert.equal(h.render().questionError,error);
  assert.equal(h.render().conversation.length,1);assert.equal(h.render().conversation[0].question,'new');checks++;
 }
 // A failed old barrier after detach must not mark a newer turn with a confirmed higher watermark.
 {
  const h=harness();await h.render().connect();await finishWelcome(h);business(h);await h.render().sendQuestion(h.render().active.current,'first');
  const v=h.render().visitorId.current,low=deferred(),high=deferred();
  h.overrides.set('POST /guide/visitors/'+v+'/invalidate',init=>JSON.parse(init.body).through_turn_seq===1?low.promise:high.promise);
  await h.render().disconnect();await h.render().connect();await finishWelcome(h);
  const blocked=h.render().sendQuestion(h.render().active.current,'second');await flush();
  const next=h.render().invalidateBusiness(v,2);h.render().turnSequence.current=2;
  const latest=h.render().sendQuestion(h.render().active.current,'third');await flush();
  high.resolve(h.response({visitor_id:v,cancelled_through:2,retired:false}));await next;await latest;
  const notice=h.render().notice,error=h.render().questionError;
  low.reject(Error('late old cancellation'));await blocked;await flush();
  assert.equal(calls(h).length,2);assert.equal(JSON.parse(calls(h)[1].body).turn_seq,3);
  assert.equal(h.render().notice,notice);assert.equal(h.render().questionError,error);checks++;
 }
 // Old retirement acknowledgement arrives after the new visitor response; no new state is cleared.
 {
  const h=harness();await h.render().connect();await finishWelcome(h);business(h);await h.render().sendQuestion(h.render().active.current,'old');
  const v=h.render().visitorId.current,gate=deferred();
  h.overrides.set('POST /guide/visitors/'+v+'/invalidate',()=>gate.promise);
  const reset=h.render().resetVisitor();await flush();
  const next=h.render().visitorId.current;assert.notEqual(next,v);
  await h.render().sendQuestion(h.render().active.current,'new');
  assert.equal(calls(h).length,2);assert.equal(JSON.parse(calls(h)[1].body).visitor_id,next);
  gate.resolve(h.response({visitor_id:v,cancelled_through:1,retired:true}));await reset;
  assert.equal(h.render().conversation.length,1);assert.equal(h.render().conversation[0].question,'new');
  assert.equal(h.render().turnSequence.current,1);checks++;
 }
 // A late smaller watermark acknowledgement cannot replace the current barrier.
 {
  const h=harness();await h.render().connect();await finishWelcome(h);business(h);const v=h.render().visitorId.current;
  const low=deferred(),high=deferred();
  h.overrides.set('POST /guide/visitors/'+v+'/invalidate',init=>JSON.parse(init.body).through_turn_seq===1?low.promise:high.promise);
  const one=h.render().invalidateBusiness(v,1);const two=h.render().invalidateBusiness(v,2);
  h.render().turnSequence.current=2;
  const question=h.render().sendQuestion(h.render().active.current,'third');await flush();
  low.resolve(h.response({visitor_id:v,cancelled_through:1,retired:false}));await one;await flush();
  assert.equal(calls(h).length,0);
  high.resolve(h.response({visitor_id:v,cancelled_through:2,retired:false}));await two;await question;
  assert.equal(JSON.parse(calls(h)[0].body).turn_seq,3);checks++;
 }
 // Wrong/missing sequence cannot render or trigger TTS, even if both UUIDs match.
 for(const fault of ['missing','wrong','string']){
  const h=harness();await h.render().connect();await finishWelcome(h);
  h.overrides.set('POST /guide/questions',init=>{const b=JSON.parse(init.body),r={...b,status:'answer',text:'wrong',sources:[]};
    if(fault==='missing')delete r.turn_seq;else r.turn_seq=fault==='wrong'?b.turn_seq+1:String(b.turn_seq);return h.response(r);});
  await h.render().sendQuestion(h.render().active.current,'one');
  assert.equal(h.render().answer,null);assert.ok(h.render().questionError);
  assert.equal(h.workRequests.filter(r=>r.url==='/opentalking/tts/preview').length,0);checks++;
 }
 console.log(JSON.stringify({status:'passed',checks,scope:'actual App handlers, independent cancel signal/late watermark/visitor/seq; isolated doubles only'}));
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>clearTimeout(watchdog));
`;
new Function('require',base+checks)(require);
