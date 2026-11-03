const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const ts=require(path.resolve('frontend/node_modules/typescript'));
const code=ts.transpileModule(fs.readFileSync('frontend/src/lib/voiceSegments.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
function fixture(){
 let now=0,serial=0,ready=true;const timers=new Map(),runs=[],reports=[],resourceStates=[],exports={};
 vm.runInNewContext(code,{exports,Blob,Date:{now:()=>now},setTimeout(fn,ms){const id=++serial;timers.set(id,{fn,at:now+ms});return id;},clearTimeout:id=>timers.delete(id)});
 const queue=exports.createVoiceSegments(()=>ready,(audio,valid)=>{const done=deferred();runs.push({audio,valid,...done});return done.promise;},text=>reports.push(text),unknown=>resourceStates.push(unknown));
 return {queue,runs,reports,resourceStates,exports,setReady:value=>ready=value,advance:async(ms)=>{now+=ms;for(const [id,t]of [...timers])if(t.at<=now){timers.delete(id);t.fn();}await flush();}};
}
test('16k mono WAV retains first buffered sample, sign and order; rejects invalid or overlong complete arrays',async()=>{
 const h=fixture(),wav=h.exports.segmentWav(new Float32Array([-.5,0,.25,1]));const bytes=await wav.arrayBuffer(),v=new DataView(bytes);
 assert.equal(wav.type,'audio/wav');assert.equal(bytes.byteLength,52);assert.equal(v.getUint32(24,true),16000);assert.equal(v.getUint16(22,true),1);assert.equal(v.getUint16(34,true),16);
 assert.equal(v.getInt16(44,true),-16384);assert.equal(v.getInt16(48,true),8192);assert.equal(v.getInt16(50,true),32767);
 assert.equal(h.exports.segmentWav(new Float32Array(480000)).size,960044);
 for(const audio of [new Float32Array(),new Float32Array(480001),new Float32Array([NaN])])assert.throws(()=>h.exports.segmentWav(audio));
});
test('single active plus single waiting, overflow visible; accepted audio copied; FIFO runs only once',async()=>{
 const h=fixture(),audio=new Float32Array([.2]);h.queue.enqueue(audio);audio[0]=.9;h.queue.enqueue(new Float32Array([.4]));h.queue.enqueue(new Float32Array([.6]));
 assert.equal(h.runs.length,1);assert.ok(h.runs[0].audio[0]<.3);assert.match(h.reports.at(-1),/未识别/);
 h.runs[0].resolve();await flush();assert.equal(h.runs.length,2);h.queue.pump();assert.equal(h.runs.length,2);h.runs[1].resolve();await flush();
});
test('media rebuilding holds unbound segment; 15s expiry never renews on pump',async()=>{
 const h=fixture();h.setReady(false);h.queue.enqueue(new Float32Array([.1]));await h.advance(10000);h.queue.pump();await h.advance(5000);h.setReady(true);h.queue.pump();assert.equal(h.runs.length,0);assert.match(h.reports.at(-1),/15秒/);
 h.queue.enqueue(new Float32Array([.2]));assert.equal(h.runs.length,1);h.runs[0].resolve();await flush();
});
test('stop/reset invalidates active result, drops waiting, and cannot open second in-flight request',async()=>{
 const h=fixture();h.queue.enqueue(new Float32Array([.1]));h.queue.enqueue(new Float32Array([.2]));h.queue.invalidate();assert.equal(h.runs[0].valid(),false);
 h.queue.enqueue(new Float32Array([.3]));assert.equal(h.runs.length,1);h.runs[0].resolve();await flush();assert.equal(h.runs.length,2);assert.ok(h.runs[1].audio[0]>.25);h.runs[1].resolve();await flush();
});
test('unknown request outcome blocks automatic submission and requires explicit recovery',async()=>{
 const h=fixture();h.queue.enqueue(new Float32Array([.1]));h.queue.enqueue(new Float32Array([.2]));h.runs[0].resolve('unknown');await flush();h.queue.enqueue(new Float32Array([.3]));h.queue.pump();assert.equal(h.runs.length,1);assert.match(h.reports.at(-1),/未确认/);
 h.queue.recover();h.queue.enqueue(new Float32Array([.4]));assert.equal(h.runs.length,2);h.runs[1].resolve();await flush();
});
test('zero samples produce no request; long/nonfinite audio visibly rejected',()=>{
 const h=fixture();h.queue.enqueue(new Float32Array());h.queue.enqueue(new Float32Array(480001));h.queue.enqueue(new Float32Array([Infinity]));assert.equal(h.runs.length,0);assert.equal(h.reports.length,2);assert.match(h.reports[0],/30秒/);
});

test('late unknown reports current resource pause and discarded waiting segment across epochs; recovery does not replay it',async()=>{
 const h=fixture();h.queue.enqueue(new Float32Array([.1]));h.queue.invalidate();h.queue.recover();h.queue.enqueue(new Float32Array([.2]));
 h.runs[0].resolve('unknown');await flush();assert.equal(h.runs.length,1);assert.match(h.reports.at(-1),/资源.*未确认/);assert.match(h.reports.at(-1),/等待片段已放弃/);
 h.queue.invalidate();assert.match(h.reports.at(-1),/已暂停/);h.queue.recover();h.queue.pump();assert.equal(h.runs.length,1);
 h.queue.enqueue(new Float32Array([.3]));assert.equal(h.runs.length,2);assert.ok(h.runs[1].audio[0]>.25);h.runs[1].resolve();await flush();
});

test('resource state persists independently of progress and epoch; only settled explicit recovery clears it',async()=>{
 const h=fixture();h.queue.enqueue(new Float32Array([.1]));h.queue.recover();assert.equal(h.resourceStates.length,0);
 h.runs[0].resolve('unknown');await flush();assert.deepEqual(h.resourceStates,[true]);
 h.queue.invalidate();h.queue.pump();h.queue.enqueue(new Float32Array([.2]));h.queue.invalidate();assert.deepEqual(h.resourceStates,[true]);assert.equal(h.runs.length,1);
 h.queue.recover();assert.deepEqual(h.resourceStates,[true,false]);h.queue.recover();assert.deepEqual(h.resourceStates,[true,false]);
 h.queue.enqueue(new Float32Array([.3]));assert.equal(h.runs.length,2);h.runs[1].resolve();await flush();
});
