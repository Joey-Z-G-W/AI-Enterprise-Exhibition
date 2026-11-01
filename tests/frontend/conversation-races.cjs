// Reuse the actual-App handler harness; all dependencies are isolated doubles.
const fs = require('node:fs');
const base = fs.readFileSync('tests/frontend/visitor-races.cjs','utf8')
  .split('// Execute actual App handlers')[0]
  .replace('demoStatus, speechPending };','demoStatus, speechPending, conversation, updateConversation, conversationList, followConversation };');
const checks = String.raw`
const watchdog=setTimeout(()=>{console.error('Conversation checks timed out');process.exitCode=1;},10000);
function business(h,status='error',text='服务暂不可用',sources=[]){h.overrides.set('POST /guide/questions',init=>{const b=JSON.parse(init.body);return h.response({visitor_id:b.visitor_id,turn_id:b.turn_id,turn_seq:b.turn_seq,status,text,sources},status==='error'?503:200);});}
function media(h){h.overrides.set('POST /opentalking/tts/preview',()=>new Response(new Blob(['wav']),{headers:{'content-type':'audio/wav'}}));h.overrides.set('POST /opentalking/sessions/sess_1/speak_flashtalk_audio',()=>h.response({session_id:'sess_1',status:'queued'}));}
(async()=>{
 let count=0;
 // Cap includes errors/pending turns, not only successes; evicted late updates cannot reappend.
 {
  const h=harness();await h.render().connect();business(h);let oldest;
  for(let n=1;n<=25;n++){await h.render().sendQuestion(h.render().active.current,'问题'+n);if(n===1)oldest={...h.render().conversation[0]};}
  const rows=h.render().conversation;assert.equal(rows.length,20);assert.equal(rows[0].question,'问题6');assert.equal(rows[19].question,'问题25');assert.equal(rows[0].status,'error');
  h.render().updateConversation(oldest,{result:{text:'late'}});assert.equal(h.render().conversation.length,20);assert.equal(h.render().conversation[0].question,'问题6');count++;
 }
 // A grounded answer and source stay intact while a later turn is pending and then cancelled.
 {
  const h=harness();await h.render().connect();media(h);const sources=[{excerpt:'原文事实',source:{status:'known',filename:'公司介绍.md'}}];business(h,'answer','原文事实',sources);
  await h.render().sendQuestion(h.render().active.current,'第一问');h.render().active.current.events.emit('speech.ended');
  const first=h.render().conversation[0];assert.equal(first.status,'completed');assert.deepEqual(first.result.sources,sources);assert.equal(first.result.text,'原文事实');
  const late=deferred();let body;h.overrides.set('POST /guide/questions',init=>{body=JSON.parse(init.body);return late.promise;});
  const q=h.render().sendQuestion(h.render().active.current,'第二问');await flush();assert.equal(h.render().conversation[1].status,'pending');
  const visitor=h.render().visitorId.current;await h.render().disconnect();assert.equal(h.render().conversation[1].status,'cancelled');await h.render().connect();
  late.resolve(h.response({...body,status:'answer',text:'不应出现',sources:[]}));await q;
  assert.equal(h.render().visitorId.current,visitor);assert.equal(h.render().conversation[0].result.text,'原文事实');assert.equal(h.render().conversation[1].status,'cancelled');assert.equal(h.render().conversation[1].result,undefined);count++;
 }
 // New group clears synchronously; queued updates with the old visitor cannot restore content.
 {
  const h=harness();await h.render().connect();business(h);await h.render().sendQuestion(h.render().active.current,'旧组');const old=h.render().conversation[0];
  const reset=h.render().resetVisitor();assert.equal(h.render().conversation.length,0);h.render().updateConversation(old,{question:'迟到旧组'},true);assert.equal(h.render().conversation.length,0);await reset;count++;
 }
 // Voice row has no guessed question; final transcript and question use the same turn.
 {
  const h=harness();await h.render().connect();business(h);h.overrides.set('POST /opentalking/sessions/sess_1/transcribe',()=>h.response({session_id:'sess_1',text:'最终识别问题'}));
  const recording=h.render().beginRecording();await flush();const row=h.render().conversation[0];assert.equal(row.question,'');assert.equal(row.status,'recording');
  h.captures[0].finish({blob:new Blob(['voice']),filename:'voice.webm'});await recording;
  assert.equal(h.render().conversation.length,1);assert.equal(h.render().conversation[0].turnId,row.turnId);assert.equal(h.render().conversation[0].input,'voice');assert.equal(h.render().conversation[0].question,'最终识别问题');count++;
 }
 // Unfinished voice is cancelled on takeover, preserved on resume, never replaced by late PCM.
 {
  const h=harness();await h.render().connect();const recording=h.render().beginRecording();await flush();await h.render().takeOver();
  assert.equal(h.render().conversation[0].status,'cancelled');assert.equal(h.render().conversation[0].question,'');await h.render().connect('resume');
  h.captures[0].finish({blob:new Blob(['late']),filename:'voice.webm'});await recording;assert.equal(h.render().conversation[0].status,'cancelled');assert.equal(h.render().conversation[0].question,'');count++;
 }
 // Empty speech and STT failure have distinct truthful states and no submitted question.
 for(const result of ['empty','failure']){
  const h=harness();await h.render().connect();h.overrides.set('POST /opentalking/sessions/sess_1/transcribe',()=>result==='empty'?h.response({session_id:'sess_1',text:''}):h.response({detail:'failed'},502));
  const recording=h.render().beginRecording();await flush();h.captures[0].finish({blob:new Blob(['voice']),filename:'v.webm'});await recording;
  assert.equal(h.render().conversation[0].status,result==='empty'?'no_text':'error');assert.equal(h.render().conversation[0].question,'');assert.equal(h.requests.filter(r=>r.url==='/guide/questions').length,0);count++;
 }
 // Completed handoff is retained across human mode/resume rather than marked cancelled.
 {
  const h=harness();await h.render().connect();business(h,'handoff','请销售确认');await h.render().sendQuestion(h.render().active.current,'报价');
  assert.equal(h.render().mode,'human');assert.equal(h.render().conversation[0].status,'completed');assert.equal(h.render().conversation[0].result.status,'handoff');await h.render().connect('resume');assert.equal(h.render().conversation.length,1);count++;
 }
 console.log(JSON.stringify({status:'passed',checks:count,bound:20,scope:'Actual App handlers; no real media or model'}));
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>clearTimeout(watchdog));
`;
new Function('require',base+checks)(require);
