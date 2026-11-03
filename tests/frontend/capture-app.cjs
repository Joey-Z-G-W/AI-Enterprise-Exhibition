const fs=require('node:fs');
const base=fs.readFileSync('tests/frontend/visitor-races.cjs','utf8').split('// Execute actual App handlers')[0];
const checks=String.raw`
const watchdog=setTimeout(()=>{console.error('Capture App checks timed out');process.exitCode=1;},10000);
(async()=>{
 let checks=0;
 {
  const h=harness();assert.equal(h.continuous.length,0);const ready=deferred();h.overrides.set('GET /opentalking/sessions/sess_1',()=>ready.promise);
  const first=h.render().connect();await flush();await h.render().connect();assert.equal(h.continuous.length,1);assert.equal(h.continuous[0].listens,0);
  ready.resolve(h.response({session_id:'sess_1',state:'ready'}));await first;await flush();assert.equal(h.continuous[0].listens,1);assert.equal(h.render().captureStatus,'listening');
  assert.doesNotMatch(h.markup(),/>开始录音<|>结束录音并提问<|>停止播报并准备录音</);assert.match(h.markup(),/>停止录音</);checks++;
 }
 {
  const h=harness();await h.render().connect();const owner=h.continuous[0];h.overrides.set('POST /guide/questions',init=>h.response({...JSON.parse(init.body),status:'error',text:'offline',sources:[]},503));
  await h.render().selectPreset('锐伽提供哪些服务？');await flush();assert.equal(h.continuous.length,1);assert.equal(owner.stops,0);assert.equal(h.render().microphone.current,owner);
  h.render().stopMicrophone();await flush();await h.render().selectPreset('品牌设计包含哪些内容？');await flush();assert.equal(h.continuous.length,1);assert.equal(owner.stops,1);assert.equal(h.render().captureStatus,'closed');assert.equal(h.requests.filter(r=>r.url==='/guide/questions').length,2);checks++;
 }
 {
  const h=harness();await h.render().connect();const pending=deferred();let body;h.overrides.set('POST /guide/questions',init=>{body=JSON.parse(init.body);return pending.promise;});
  h.overrides.set('POST /opentalking/tts/preview',()=>new Response(new Blob(['wav']),{headers:{'content-type':'audio/wav'}}));h.overrides.set('POST /opentalking/sessions/sess_1/speak_flashtalk_audio',()=>h.response({session_id:'sess_1',status:'queued'}));
  const answering=h.render().sendQuestion(h.render().active.current,'已提交的问题');await flush();const session=h.render().active.current;const requestCount=h.requests.length;
  h.render().stopMicrophone();await flush();assert.equal(session.controller.signal.aborted,false);assert.equal(h.requests.length,requestCount);
  pending.resolve(h.response({...body,status:'answer',text:'回答继续',sources:[]}));await answering;assert.equal(h.requests.filter(r=>r.url.endsWith('/speak_flashtalk_audio')).length,1);assert.equal(h.continuous.length,1);checks++;
 }
 for(const action of ['disconnect','takeOver','dispose']){
  const h=harness();await h.render().connect();const owner=h.continuous[0];if(action==='dispose')h.dispose();else await h.render()[action]();await flush();assert.equal(owner.released,true);assert.equal(owner.stops,1);
  if(action==='takeOver'){await h.render().connect('resume');await flush();assert.equal(h.continuous.length,2);assert.equal(h.render().captureStatus,'listening');}checks++;
 }
 {
  assert.doesNotMatch(fs.readFileSync('frontend/src/App.tsx','utf8'),/startRecording|new MediaRecorder|async function beginRecording/);
  const h=harness();await h.render().connect();await h.render().requestMicrophone();assert.equal(h.continuous.length,1);assert.equal(h.captures.length,0);checks++;
 }
 console.log(JSON.stringify({status:'passed',checks,scope:'Actual App lifecycle, no microphone/API/model'}));
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>clearTimeout(watchdog));
`;
new Function('require',base+checks)(require);
