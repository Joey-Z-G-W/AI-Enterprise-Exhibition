const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const ts=require(path.resolve('frontend/node_modules/typescript'));
const source=fs.readFileSync('frontend/src/lib/continuousCapture.ts','utf8');
const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject};};
const flush=async()=>{for(let i=0;i<40;i++)await Promise.resolve();};
function fixture(options={}){
 let callbacks;const segments=[];
 const reports=[],contexts=[],instances=[],timers=new Map();let timerId=0,gumCalls=0,vadCalls=0,settings;
 const gum=deferred(),created=deferred(),worklet=deferred(),resume=deferred();
 const track={kind:'audio',readyState:'live',stops:0,onended:null,stop(){this.stops++;this.readyState='ended';},getSettings(){return {echoCancellation:true};}};
 const stream={getTracks:()=>[track],getAudioTracks:()=>[track]};
 class Context{state='running';closes=0;constructor(){contexts.push(this);}async resume(){if(options.resumePending)await resume.promise;}async close(){this.closes++;this.state='closed';}}
 function vad(config){
  callbacks=config;
  const instance={model:{releases:0,async release(){this.releases++;}},_stream:null,_audioContext:null,_vadNode:null,_mediaStreamAudioSourceNode:null,listening:false,starts:0,destroys:0,
   async start(){this.starts++;this._stream=await config.getStream();this._audioContext=config.audioContext;if(options.workletPending)await worklet.promise;this._vadNode={port:{messages:[],postMessage(m){this.messages.push(m);}},disconnects:0,disconnect(){this.disconnects++;}};this._mediaStreamAudioSourceNode={disconnects:0,disconnect(){this.disconnects++;}};this.listening=true;},
   async destroy(){this.destroys++;if(!this._stream||!this._audioContext||!this._vadNode||!this._mediaStreamAudioSourceNode)throw Error('actual library incomplete destroy path');if(options.destroyFailure)throw Error('unrelated destroy failure');this._vadNode.port.postMessage('SPEECH_STOP');this.listening=false;await config.pauseStream(this._stream);this._mediaStreamAudioSourceNode.disconnect();await this.model.release();}
  };instances.push(instance);return instance;
 }
 const exported={};vm.runInNewContext(code,{exports:exported,queueMicrotask,WeakSet,Promise,AudioContext:Context,navigator:{mediaDevices:{getUserMedia(config){gumCalls++;settings=config;return gum.promise;}}},setTimeout(fn,ms){const id=++timerId;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id),require(name){if(name!=='@ricky0123/vad-web')throw Error(name);return {Message:{SpeechStop:'SPEECH_STOP'},MicVAD:{new(config){vadCalls++;const instance=vad(config);return options.newPending?created.promise.then(()=>instance):Promise.resolve(instance);}}};}});
 const owner=exported.createContinuousCapture((state,message)=>reports.push({state,message}),{onSegment:audio=>segments.push(audio)});
 return {owner,reports,contexts,instances,track,stream,segments,callbacks:()=>callbacks,gum,created,worklet,resume,timers,gumCount:()=>gumCalls,vadCount:()=>vadCalls,settings:()=>settings};
}
test('one permission request; ready gates VAD; repeated listen and stop never duplicate resources',async()=>{
 const h=fixture();h.gum.resolve(h.stream);await flush();assert.equal(h.gumCount(),1);assert.equal(h.vadCount(),0);assert.equal(h.reports.at(-1).state,'waiting');assert.equal(h.settings().audio.echoCancellation.exact,true);
 h.owner.listen();h.owner.listen();await flush();assert.equal(h.vadCount(),1);assert.equal(h.instances[0].starts,1);assert.equal(h.reports.at(-1).state,'listening');await h.owner.stop();await h.owner.stop();
 assert.equal(h.track.stops,1);assert.equal(h.contexts[0].closes,1);assert.equal(h.instances[0].model.releases,1);assert.equal(h.instances[0].destroys,1);assert.equal(h.owner.released,true);
});
test('stop before permission resolves closes late stream and never creates VAD',async()=>{
 const h=fixture();h.owner.listen();const stopped=h.owner.stop();h.gum.resolve(h.stream);await stopped;await flush();assert.equal(h.track.stops,1);assert.equal(h.vadCount(),0);assert.equal(h.owner.released,true);assert.ok(!h.reports.some(x=>x.state==='listening'));
});
test('stop during model new releases late unstarted model once through exact incomplete adapter',async()=>{
 const h=fixture({newPending:true});h.gum.resolve(h.stream);h.owner.listen();await flush();assert.equal(h.vadCount(),1);const stopped=h.owner.stop();assert.equal(h.track.readyState,'ended');h.created.resolve();await stopped;
 assert.equal(h.instances[0].starts,0);assert.equal(h.instances[0].destroys,0);assert.equal(h.instances[0].model.releases,1);assert.equal(h.contexts[0].closes,1);assert.equal(h.owner.released,true);
});
test('stop during worklet initialization releases late nodes/model and cannot revive listening',async()=>{
 const h=fixture({workletPending:true});h.gum.resolve(h.stream);h.owner.listen();await flush();assert.equal(h.instances[0].starts,1);const stopped=h.owner.stop();assert.equal(h.track.readyState,'ended');assert.equal(h.contexts[0].state,'closed');h.worklet.resolve();await stopped;
 assert.equal(h.instances[0].listening,false);assert.equal(h.instances[0].model.releases,1);assert.equal(h.instances[0].destroys,1);assert.equal(h.instances[0]._mediaStreamAudioSourceNode.disconnects,1);assert.deepEqual(h.instances[0]._vadNode.port.messages,['SPEECH_STOP']);assert.ok(!h.reports.some(x=>x.state==='listening'));
});
test('late context resume after stop cannot construct VAD or reopen track',async()=>{
 const h=fixture({resumePending:true});h.gum.resolve(h.stream);h.owner.listen();await flush();const stopped=h.owner.stop();h.resume.resolve();await stopped;assert.equal(h.vadCount(),0);assert.equal(h.contexts[0].closes,1);assert.equal(h.track.stops,1);
});
test('permission denial and finite permission timeout produce visible failure; late grants clean up',async()=>{
 const denied=fixture();denied.gum.reject(Error('permission'));await flush();assert.equal(denied.reports.at(-1).state,'error');assert.equal(denied.vadCount(),0);assert.equal(denied.owner.released,true);
 const timed=fixture();[...timed.timers.values()].find(t=>t.ms===20000).fn();timed.gum.resolve(timed.stream);await flush();assert.equal(timed.track.readyState,'ended');assert.equal(timed.vadCount(),0);assert.equal(timed.owner.released,true);assert.ok(timed.reports.some(x=>/超时/.test(x.message)));
});
test('device track ended stops the whole owner; listen cannot auto-reacquire',async()=>{
 const h=fixture();h.gum.resolve(h.stream);h.owner.listen();await flush();h.track.onended();await flush();h.owner.listen();await flush();assert.equal(h.gumCount(),1);assert.equal(h.instances[0].model.releases,1);assert.equal(h.contexts[0].state,'closed');assert.equal(h.reports.at(-1).state,'error');
});
test('unrelated normal destroy failure is reported, never claimed released or retried',async()=>{
 const h=fixture({destroyFailure:true});h.gum.resolve(h.stream);h.owner.listen();await flush();assert.equal(await h.owner.stop(),false);assert.equal(await h.owner.stop(),false);assert.equal(h.owner.released,false);assert.equal(h.instances[0].destroys,1);assert.equal(h.instances[0].model.releases,0);assert.match(h.reports.at(-1).message,/释放未确认/);
});

test('complete VAD segment preserves leading samples, emits once; preset discard and misfire do not stop capture',async()=>{
 const h=fixture();h.gum.resolve(h.stream);h.owner.listen();await flush();const c=h.callbacks(),audio=new Float32Array([.15,-.25,.4]);
 c.onSpeechStart();c.onSpeechEnd(audio);c.onSpeechEnd(audio);assert.equal(h.segments.length,1);assert.equal(h.segments[0],audio);
 c.onSpeechStart();h.owner.discardSegment();c.onSpeechEnd(audio);assert.equal(h.segments.length,1);assert.equal(h.track.readyState,'live');
 c.onSpeechStart();c.onVADMisfire();c.onSpeechEnd(audio);assert.equal(h.segments.length,1);
 c.onSpeechStart();c.onSpeechEnd(audio);assert.equal(h.segments.length,2);await h.owner.stop();c.onSpeechStart();c.onSpeechEnd(audio);assert.equal(h.segments.length,2);
});
test('30 second speech timer closes capture and cannot submit a partial or late segment',async()=>{
 const h=fixture();h.gum.resolve(h.stream);h.owner.listen();await flush();const c=h.callbacks();c.onSpeechStart();[...h.timers.values()].find(t=>t.ms===30000).fn();await flush();c.onSpeechEnd(new Float32Array(16));assert.equal(h.segments.length,0);assert.equal(h.owner.released,true);assert.match(h.reports.at(-1).message,/30秒/);
});
