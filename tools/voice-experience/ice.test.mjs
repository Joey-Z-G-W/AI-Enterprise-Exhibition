import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {SubmissionGate,wav} from './core.mjs';

const source=(await fs.readFile(new URL('./app.mjs',import.meta.url),'utf8')).replace(/^import[^\n]+\n/,'');
const criteria=JSON.parse(await fs.readFile(new URL('./criteria.json',import.meta.url),'utf8'));
const assets={samples:[{id:'A',sha256:'offline-fixture',voice:'zh-CN-YunyangNeural'}],criteria_sha256:'offline-fixture'};
const response=(value,status=200)=>({ok:status===200,status,json:async()=>value});
const config={iceServers:[{urls:'turn:example.invalid',username:'PRIVATE_USER',credential:'PRIVATE_PASSWORD'}],iceTransportPolicy:'relay'};
async function harness(configRequest,{offerFailure=false,fastTimeout=false}={}){
 const nodes=new Map(),calls=[],pcs=[],timeouts=[];
 const element=id=>{if(!nodes.has(id))nodes.set(id,{value:id==='sid'?'sess_abc123':id==='noise'?'安静室内':'30',checked:true,textContent:'',disabled:false,play:async()=>{},pause(){}});return nodes.get(id);};
 class Stream{getTracks(){return []}}
 class PC{
  constructor(settings){this.settings=settings;this.connectionState='new';this.iceConnectionState='new';this.iceGatheringState='complete';pcs.push(this);}
  addTransceiver(){}
  async createOffer(){if(offerFailure)throw Error('PRIVATE_PASSWORD unsafe diagnostic');return {type:'offer',sdp:'PRIVATE_SDP'};}
  async setLocalDescription(value){this.localDescription=value;this.signalingState='have-local-offer';this.onsignalingstatechange?.();this.onicegatheringstatechange?.();}
  async setRemoteDescription(){this.iceConnectionState='connected';this.oniceconnectionstatechange?.();this.connectionState='connected';this.onconnectionstatechange?.();}
  close(){this.connectionState='closed';this.onconnectionstatechange?.();}
 }
 const sandbox={SubmissionGate,wav,console,performance,FormData,Blob,URL,Float32Array,ArrayBuffer,DataView,setTimeout,clearTimeout,setInterval:()=>1,clearInterval(){},navigator:{userAgent:'offline',platform:'test'},isSecureContext:true,MediaStream:Stream,RTCPeerConnection:PC,document:{getElementById:element,addEventListener(){}},window:{addEventListener(){}},AbortSignal:{timeout(ms){timeouts.push(ms);if(!fastTimeout)return AbortSignal.timeout(ms);const c=new AbortController();setTimeout(()=>c.abort(Error('timeout')),2);return c.signal;}},fetch:async(path,options)=>{
  if(path==='/criteria.json')return response(criteria);
  if(path==='/assets/manifest.json')return response(assets);
  calls.push({path,options});
  if(path.endsWith('/ice-config'))return configRequest(options);
  if(path.endsWith('/webrtc/offer'))return response({type:'answer',sdp:'PRIVATE_ANSWER'});
  throw Error('Unexpected request');
 }};
 const api=await new vm.Script(`(async()=>{${source}\nhandoff={session_id:'sess_abc123',handoff_id:'offline-ice'};return {connect,cleanup,evidence,log};})()`).runInNewContext(sandbox);
 return {api,nodes,calls,pcs,timeouts};
}
test('actual connect uses server ICE unchanged before offer, diagnostics redact credentials and SDP',async()=>{
 const h=await harness(async()=>response(config));await h.api.connect();
 assert.deepEqual(h.calls.map(x=>x.path),['/api/sessions/webrtc/ice-config','/api/sessions/sess_abc123/webrtc/offer']);
 assert.equal(h.pcs[0].settings.iceServers,config.iceServers);assert.equal(h.pcs[0].settings.iceTransportPolicy,'relay');assert.equal(h.timeouts[0],10000);
 for(let i=0;i<50;i++)h.api.log('pcm_meter',{rms:0});
 const visible=h.nodes.get('connectionDiagnostics').textContent;
 assert.match(visible,/fetch_ice_config/);assert.match(visible,/rtc_ice_state/);assert.match(visible,/rtc_connected/);assert.doesNotMatch(visible,/pcm_meter|PRIVATE_|example\.invalid/);
 assert.doesNotMatch(JSON.stringify(h.api.evidence()),/PRIVATE_|example\.invalid/);
 await h.api.cleanup();
});
test('HTTP config rejection results in zero peer and zero offer',async()=>{
 const h=await harness(async()=>response({},503));await assert.rejects(h.api.connect(),/配置读取失败/);assert.equal(h.pcs.length,0);assert.equal(h.calls.length,1);
});
test('missing or malformed config cannot silently fall back to empty ICE',async()=>{
 for(const invalid of [{},{iceServers:[],iceTransportPolicy:'unknown'},null]){
  const h=await harness(async()=>response(invalid));await assert.rejects(h.api.connect(),/配置格式无效/);assert.equal(h.pcs.length,0);assert.equal(h.calls.length,1);
 }
});
test('config request has an aborting deadline, no offer after timeout',async()=>{
 const h=await harness(({signal})=>new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>reject(signal.reason),{once:true});}),{fastTimeout:true});
 await assert.rejects(h.api.connect(),/超时/);assert.equal(h.timeouts[0],10000);assert.equal(h.pcs.length,0);assert.equal(h.calls.length,1);
});
test('cleanup during config fetch prevents late response from creating peer or offer',async()=>{
 let finish,started;const ready=new Promise(r=>started=r);
 const h=await harness(()=>{started();return new Promise(r=>finish=r)});const pending=h.api.connect();await ready;await h.api.cleanup();finish(response(config));
 await assert.rejects(pending,/取消/);assert.equal(h.pcs.length,0);assert.equal(h.calls.length,1);
});
test('peer errors close peer and expose only sanitized failure phase',async()=>{
 const h=await harness(async()=>response(config),{offerFailure:true});await assert.rejects(h.api.connect(),/RTC连接失败/);
 assert.equal(h.pcs[0].connectionState,'closed');assert.equal(h.calls.length,1);assert.match(h.nodes.get('connectionDiagnostics').textContent,/failed_or_cancelled/);
 assert.doesNotMatch(JSON.stringify(h.api.evidence()),/PRIVATE_|example\.invalid/);
});
