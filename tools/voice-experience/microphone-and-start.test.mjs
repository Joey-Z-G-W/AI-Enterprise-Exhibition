import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {SubmissionGate,wav} from './core.mjs';
const source=(await fs.readFile(new URL('./app.mjs',import.meta.url),'utf8')).replace(/^import[^\n]+\n/,'');
const criteria=JSON.parse(await fs.readFile(new URL('./criteria.json',import.meta.url),'utf8'));
const assets={samples:[{id:'A',sha256:'offline-fixture',voice:'zh-CN-YunyangNeural'}],criteria_sha256:'offline-fixture'};
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject};};
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const response=value=>({ok:true,status:200,json:async()=>value,blob:async()=>new Blob(['fixture'])});
async function harness(t,options={}){
 const nodes=new Map(),calls=[],contexts=[],taps=[],instances=[],storage=new Map(),blobs=[],revoked=[],listeners={};let gumCalls=0,vadOptions,pc;
 const gumEntered=deferred(),offerEntered=deferred(),uploadEntered=deferred(),vadEntered=deferred();
 const node=id=>{if(!nodes.has(id))nodes.set(id,{disabled:false,textContent:'',hidden:true,currentTime:0,playCount:0,async play(){this.playCount++;if(id==='remote'&&options.remotePlay)await options.remotePlay;},pauseCount:0,pause(){this.pauseCount++;},addEventListener(){}});return nodes.get(id);};
 const track={kind:'audio',readyState:'live',stop(){this.readyState='ended';},getSettings(){return {echoCancellation:true,noiseSuppression:true,autoGainControl:true,sampleRate:48000,channelCount:1,deviceId:'PRIVATE_DEVICE',groupId:'PRIVATE_GROUP'};}};
 const stream={getTracks:()=>[track],getAudioTracks:()=>[track]};
 class Context{constructor(){this.state='running';this.sampleRate=48000;this.audioWorklet={addModule:async()=>{}};contexts.push(this);}async resume(){}async close(){this.state='closed';}createMediaStreamSource(){return {connect(){},disconnect(){}};}}
 class Tap{constructor(){this.port={postMessage(){},onmessage:null};taps.push(this);}connect(){}disconnect(){}}
 class Stream{constructor(){this.tracks=[];}getTracks(){return this.tracks;}addTrack(t){this.tracks.push(t);}}
 class PC{constructor(){pc=this;this.connectionState='new';this.iceGatheringState='complete';}addTransceiver(){}async createOffer(){return {type:'offer',sdp:'PRIVATE_SDP'};}async setLocalDescription(v){this.localDescription=v;}async setRemoteDescription(){this.connectionState='connected';this.onconnectionstatechange?.();}close(){this.connectionState='closed';}async getStats(){return new Map();}}
 const model={listening:false,destroyed:0,async start(){if(options.vadStart)await options.vadStart;this.listening=true;},async destroy(){this.destroyed++;this.listening=false;}};
 const handoff={lease:'offline-lease',handoff_id:'offline-simple',session_id:'sess_abc123',avatar_id:'fixture-avatar',tts_voice:'zh-CN-YunyangNeural',prepared_at:new Date().toISOString(),expires_at:new Date(Date.now()+1800000).toISOString()};
 if(options.consumed)storage.set('task20-v3-consumed-session',handoff.session_id);
 const sandbox={SubmissionGate,wav,performance,Date,FormData,Blob,Float32Array,ArrayBuffer,DataView,AbortSignal,console,
  URL:{createObjectURL(blob){blobs.push(blob);return 'blob:offline/'+blobs.length;},revokeObjectURL(url){revoked.push(url);}},
  setTimeout(fn,ms){const timer=setTimeout(fn,options.fastBudget&&ms>20000&&ms<=30000?5:ms);if(ms>1000&&!options.fastBudget)timer.unref();return timer;},clearTimeout,setInterval:()=>1,clearInterval(){},
  localStorage:{getItem:key=>storage.get(key)??null,setItem(key,value){if(options.storageFailure)throw Error('blocked');storage.set(key,value);}},
  navigator:{userAgent:'offline',mediaDevices:{getUserMedia(){gumCalls++;gumEntered.resolve();return options.gum??Promise.resolve(stream);}}},isSecureContext:true,
  document:{hidden:false,getElementById:node,addEventListener(name,fn){listeners[name]=fn;}},window:{addEventListener(name,fn){listeners[name]=fn;}},
  AudioContext:Context,AudioWorkletNode:Tap,MediaStream:Stream,RTCPeerConnection:PC,
  vad:{MicVAD:{new:async config=>{vadOptions=config;instances.push(model);vadEntered.resolve();return options.vadInit??model;}}},
  fetch:async(path,request)=>{
   calls.push({path,request});
   if(path==='/criteria.json')return response(criteria);
   if(path==='/assets/manifest.json')return response(assets);
   if(path==='/trial/prepare'){if(options.prepareFailure)throw Error('lost prepare response');return options.prepare??response(options.badHandoff?{}:handoff);}
   if(path==='/trial/release'){if(options.releaseFailure)throw Error('lost release response');return response({released:true});}
   if(path==='/assets/audio/A.wav')return options.audio??response({});
   if(path.endsWith('/ice-config'))return response({iceServers:[{urls:'stun:example.invalid'}],iceTransportPolicy:'all'});
   if(path.endsWith('/webrtc/offer')){offerEntered.resolve();return options.offer??response({type:'answer',sdp:'PRIVATE_ANSWER'});}
   if(path.endsWith('/speak_flashtalk_audio')){uploadEntered.resolve();return options.upload??response({session_id:handoff.session_id,status:'queued'});}
   if(path.endsWith('/interrupt')){if(options.interruptFailure)throw Error('controlled interrupt transport failure');return response({session_id:handoff.session_id,status:'interrupted'});}
   throw Error('Unexpected path');
  }
 };
 const api=await new vm.Script(`(async()=>{${source}\nreturn {startTest,cleanup,replayMine,evidence};})()`).runInNewContext(sandbox);
 const h={api,nodes,calls,contexts,taps,model,storage,track,stream,blobs,revoked,listeners,sandbox,gumEntered,offerEntered,uploadEntered,vadEntered,gumCount:()=>gumCalls,vad:()=>vadOptions,pc:()=>pc,emitMic(pcm=new Float32Array([.1,.2,.3])){taps[0].port.onmessage({data:{pcm,contextFrame:0,rate:48000}});}};
 t.after(()=>api.cleanup());return h;
}
test('no capture on load; one click owns one GUM/RTC/A, double click adds nothing',async t=>{
 const h=await harness(t);assert.equal(h.gumCount(),0);assert.equal(h.calls.filter(x=>x.path.startsWith('/api/')).length,0);
 await Promise.all([h.api.startTest(),h.api.startTest()]);assert.equal(h.gumCount(),1);assert.equal(h.calls.filter(x=>x.path.endsWith('/webrtc/offer')).length,1);assert.equal(h.calls.filter(x=>x.path.endsWith('/speak_flashtalk_audio')).length,1);
 assert.doesNotMatch(JSON.stringify(h.api.evidence()),/PRIVATE_DEVICE|PRIVATE_GROUP|PRIVATE_SDP|PRIVATE_ANSWER/);
});
test('unknown or invalid prepare prevents capture and forbids another create',async t=>{
 for(const options of [{prepareFailure:true},{badHandoff:true}]){const h=await harness(t,options);await h.api.startTest();await h.api.startTest();assert.equal(h.gumCount(),0);assert.equal(h.calls.filter(x=>x.path.startsWith('/api/')).length,0);assert.equal(h.calls.filter(x=>x.path==='/trial/prepare').length,1);assert.equal(h.nodes.get('start').disabled,true);}
});
test('GUM has finite setup timeout; late stream is stopped without VAD or RTC',async t=>{
 const d=deferred(),h=await harness(t,{gum:d.promise,fastBudget:true});await h.api.startTest();
 assert.ok(h.api.evidence().diagnostics.some(e=>e.type==='mic_gum_requested'));assert.equal(h.calls.filter(x=>x.path.startsWith('/api/')).length,0);
 d.resolve(h.stream);await flush();assert.equal(h.track.readyState,'ended');assert.equal(h.contexts.length,0);assert.ok(h.api.evidence().diagnostics.some(e=>e.type==='late_permission_tracks_stopped'));
});
test('manual stop while GUM pending prevents all downstream work and stops late tracks',async t=>{
 const d=deferred(),h=await harness(t,{gum:d.promise});const run=h.api.startTest();await h.gumEntered.promise;await h.api.cleanup();d.resolve(h.stream);await run;assert.equal(h.track.readyState,'ended');assert.equal(h.contexts.length,0);assert.equal(h.calls.filter(x=>x.path.startsWith('/api/')).length,0);
});
test('background while GUM pending performs the same epoch cleanup without RTC',async t=>{
 const d=deferred(),h=await harness(t,{gum:d.promise});const run=h.api.startTest();await h.gumEntered.promise;h.sandbox.document.hidden=true;h.listeners.visibilitychange();d.resolve(h.stream);await run;await h.api.cleanup();assert.equal(h.track.readyState,'ended');assert.ok(h.api.evidence().diagnostics.some(e=>e.type==='background_invalidates_trial'));
});
test('permission rejection is visible and sanitized; no downstream request',async t=>{
 const d=deferred(),h=await harness(t,{gum:d.promise});const run=h.api.startTest();await h.gumEntered.promise;d.reject(Object.assign(Error('PRIVATE_DEVICE'),{name:'NotAllowedError'}));await run;
 assert.ok(h.api.evidence().diagnostics.some(e=>e.error_name==='NotAllowedError'));assert.doesNotMatch(JSON.stringify(h.api.evidence()),/PRIVATE_DEVICE/);assert.equal(h.calls.filter(x=>x.path.startsWith('/api/')).length,0);
});
test('late VAD instance after stop is destroyed, tracks stopped, no RTC',async t=>{
 const d=deferred(),h=await harness(t,{vadInit:d.promise});const run=h.api.startTest();await h.vadEntered.promise;await h.api.cleanup();d.resolve(h.model);await run;assert.ok(h.model.destroyed>0);assert.equal(h.model.listening,false);assert.equal(h.track.readyState,'ended');assert.equal(h.calls.filter(x=>x.path.startsWith('/api/')).length,0);
});
test('late VAD start after stop cannot reopen capture',async t=>{
 const d=deferred(),h=await harness(t,{vadStart:d.promise});const run=h.api.startTest();await h.vadEntered.promise;await flush();await h.api.cleanup();d.resolve();await run;assert.equal(h.model.listening,false);assert.equal(h.track.readyState,'ended');assert.ok(!h.api.evidence().diagnostics.some(e=>e.type==='mic_started'));
});
test('stop during RTC answer wait blocks later A upload',async t=>{
 const d=deferred(),h=await harness(t,{offer:d.promise});const run=h.api.startTest();await h.offerEntered.promise;await h.api.cleanup();d.resolve(response({type:'answer',sdp:'PRIVATE_ANSWER'}));await run;assert.equal(h.calls.filter(x=>x.path.endsWith('/speak_flashtalk_audio')).length,0);assert.equal(h.track.readyState,'ended');
});
test('speech during pre-A preparation does not interrupt; real upload waits before final interrupt',async t=>{
 const offer=deferred(),upload=deferred(),h=await harness(t,{offer:offer.promise,upload:upload.promise});const run=h.api.startTest();await h.offerEntered.promise;
 h.vad().onSpeechRealStart();assert.equal(h.calls.filter(x=>x.path.endsWith('/interrupt')).length,0);h.vad().onSpeechEnd(new Float32Array([.1]));offer.resolve(response({type:'answer',sdp:'PRIVATE_ANSWER'}));await h.uploadEntered.promise;h.vad().onSpeechRealStart();await flush();assert.equal(h.calls.filter(x=>x.path.endsWith('/interrupt')).length,0);
 upload.resolve(response({session_id:'sess_abc123',status:'queued'}));await run;await flush();assert.equal(h.calls.filter(x=>x.path.endsWith('/interrupt')).length,1);assert.equal(h.nodes.get('remote').muted,true);
});
test('unknown upload result ends trial without retry or replaying submission',async t=>{
 const d=deferred(),h=await harness(t,{upload:d.promise});const run=h.api.startTest();await h.uploadEntered.promise;d.reject(Error('lost response'));await run;assert.equal(h.calls.filter(x=>x.path.endsWith('/speak_flashtalk_audio')).length,1);assert.equal(h.api.evidence().gate.unknown,true);assert.equal(h.track.readyState,'ended');
});
test('interrupt transport failure releases capture, preserves unknown and visible failure after stop/replay',async t=>{
 const h=await harness(t,{interruptFailure:true});await h.api.startTest();h.emitMic();h.vad().onSpeechRealStart();await flush();
 assert.equal(h.track.readyState,'ended','interrupt failure must release capture');assert.equal(h.model.listening,false);assert.ok(h.contexts.every(c=>c.state==='closed'));assert.equal(h.pc().connectionState,'closed');
 assert.equal(h.api.evidence().gate.unknown,true);assert.equal(h.api.evidence().gate.state,'stopped');assert.ok(h.api.evidence().diagnostics.some(e=>e.type==='interrupt_failed'));assert.ok(h.api.evidence().diagnostics.some(e=>e.type==='cleanup'&&e.capture_released));
 assert.match(h.nodes.get('status').textContent,/中断未确认/);assert.equal(h.nodes.get('start').disabled,false,'confirmed old-session release permits a fresh trial');assert.doesNotMatch(h.nodes.get('status').textContent,/controlled interrupt transport failure/);
 const requests=h.calls.length;await h.api.cleanup();await h.api.replayMine();assert.equal(h.calls.length,requests);assert.equal(h.gumCount(),1);assert.equal(h.api.evidence().gate.unknown,true);assert.match(h.nodes.get('status').textContent,/中断未确认/);
});
test('replay requires released capture, uses real VAD mic segment with prepad and never reopens media',async t=>{
 const h=await harness(t);await h.api.startTest();h.emitMic();const segment=new Float32Array([.4,-.3,.1,0]);h.vad().onSpeechStart();h.vad().onSpeechEnd(segment);
 await assert.rejects(h.api.replayMine(),/停止收音/);await h.api.cleanup();const count=h.calls.length;await h.api.replayMine();assert.equal(h.gumCount(),1);assert.equal(h.calls.length,count);assert.equal(h.track.readyState,'ended');assert.ok(h.contexts.every(c=>c.state==='closed'));
 const bytes=new DataView(await h.blobs[0].arrayBuffer());assert.equal(bytes.getUint32(24,true),16000);assert.equal(bytes.getUint32(40,true),segment.length*2);assert.equal(bytes.getInt16(44,true),Math.round(segment[0]*32767));
 await h.api.replayMine();assert.deepEqual(h.revoked,['blob:offline/1']);h.listeners.pagehide();assert.ok(h.revoked.includes('blob:offline/2'));
});
test('unfinished speech falls back to actual full microphone PCM with seekable controls',async t=>{
 const h=await harness(t);await h.api.startTest();h.emitMic(new Float32Array([.2,.1,0]));h.vad().onSpeechStart();await h.api.cleanup();await h.api.replayMine();
 assert.equal(h.api.evidence().diagnostics.at(-1).source,'full_microphone_recording');assert.equal(h.nodes.get('replayAudio').controls,true);assert.equal(new DataView(await h.blobs[0].arrayBuffer()).getUint32(24,true),48000);
});

test('speech crossing RTC readiness defers A until speech end',async t=>{
 const offer=deferred(),h=await harness(t,{offer:offer.promise});const run=h.api.startTest();await h.offerEntered.promise;
 h.vad().onSpeechStart();h.vad().onSpeechRealStart();offer.resolve(response({type:'answer',sdp:'fixture'}));await flush();
 assert.equal(h.calls.filter(x=>x.path.endsWith('/speak_flashtalk_audio')).length,0);assert.equal(h.nodes.get('remote').muted,true);
 h.vad().onSpeechEnd(new Float32Array([.1]));await run;assert.equal(h.calls.filter(x=>x.path.endsWith('/speak_flashtalk_audio')).length,1);
});
test('speech starts during WAV fetch: stop while waiting never unmutes or uploads',async t=>{
 const audio=deferred(),h=await harness(t,{audio:audio.promise});const run=h.api.startTest();await h.offerEntered.promise;await flush();
 h.vad().onSpeechStart();h.vad().onSpeechRealStart();audio.resolve(response({}));await flush();await h.api.cleanup();await run;
 assert.equal(h.calls.filter(x=>x.path.endsWith('/speak_flashtalk_audio')).length,0);assert.equal(h.nodes.get('remote').muted,true);
});
test('retest pauses replay and creates once only after previous release',async t=>{
 const h=await harness(t);await h.api.startTest();h.emitMic();await h.api.cleanup();await h.api.replayMine();const before=h.nodes.get('replayAudio').pauseCount;
 await Promise.all([h.api.startTest(),h.api.startTest()]);assert.ok(h.nodes.get('replayAudio').pauseCount>before);
 const paths=h.calls.map(x=>x.path);assert.equal(paths.filter(p=>p==='/trial/prepare').length,2);assert.ok(paths.indexOf('/trial/release')<paths.lastIndexOf('/trial/prepare'));assert.equal(h.gumCount(),2);
});
test('stop during late prepare releases its owned lease without starting capture',async t=>{
 const prepare=deferred(),h=await harness(t,{prepare:prepare.promise});const run=h.api.startTest();await flush();const stopped=h.api.cleanup();
 prepare.resolve(response({lease:'late',handoff_id:'late',session_id:'sess_abc123',avatar_id:'fixture-avatar',tts_voice:'zh-CN-YunyangNeural'}));await Promise.all([run,stopped]);
 assert.equal(h.gumCount(),0);assert.equal(h.calls.filter(x=>x.path==='/trial/release').length,1);assert.equal(JSON.parse(h.calls.find(x=>x.path==='/trial/release').request.body).lease,'late');
});
test('unknown release blocks retest while retaining local replay',async t=>{
 const h=await harness(t,{releaseFailure:true});await h.api.startTest();h.emitMic();await h.api.cleanup();await h.api.replayMine();await h.api.startTest();
 assert.equal(h.calls.filter(x=>x.path==='/trial/prepare').length,1);assert.equal(h.nodes.get('start').disabled,true);assert.match(h.nodes.get('status').textContent,/尚未确认/);
});

test('speech during asynchronous play remains muted until speech end',async t=>{
 const play=deferred(),h=await harness(t,{remotePlay:play.promise});const run=h.api.startTest();await h.offerEntered.promise;await flush();
 h.vad().onSpeechStart();h.vad().onSpeechRealStart();play.resolve();await flush();assert.equal(h.nodes.get('remote').muted,true);assert.equal(h.calls.filter(x=>x.path.endsWith('/speak_flashtalk_audio')).length,0);
 h.vad().onSpeechEnd(new Float32Array([.2]));await run;assert.equal(h.calls.filter(x=>x.path.endsWith('/speak_flashtalk_audio')).length,1);
});
