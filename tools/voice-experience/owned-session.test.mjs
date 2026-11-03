import test from 'node:test';
import assert from 'node:assert/strict';
import {ownedSession,sessionConfig} from './owned-session.mjs';
const config={avatar_id:'fixture-avatar',tts_voice:'zh-CN-YunyangNeural'};
const ready={sid:'sess_aa',lease:'old',phase:'ready',initialized:true};
function fixture(record,route){let clock=0;const calls=[],saved=[];const owner=ownedSession({config,record,save:async value=>saved.push(value),now:()=>clock,sleep:async ms=>{clock+=ms;},fetchImpl:async(url,req)=>{const path=new URL(url).pathname;calls.push({path,...req});const result=await route(path,req,calls);return {status:result.status??200,json:async()=>result.data};}});return {owner,calls,saved};}
const data=state=>({data:{session_id:'sess_aa',state}});
test('DELETE acknowledgement alone cannot permit new POST; closed GET required',async()=>{
 let reads=0;const h=fixture(ready,(p,r)=>{if(p==='/sessions/sess_aa'&&r.method==='GET')return data(++reads<3?'ready':'closed');if(r.method==='DELETE')return data('closed');if(p==='/queue/status')return {data:{slot_occupied:false,queue_size:0}};if(r.method==='POST')return {data:{session_id:'sess_bb'}};return {data:{session_id:'sess_bb',state:'worker_ready'}};});
 const result=await h.owner.prepare();assert.equal(result.session_id,'sess_bb');const post=h.calls.findIndex(c=>c.method==='POST');assert.equal(h.calls.slice(0,post).filter(c=>c.method==='GET'&&c.path==='/sessions/sess_aa').length,3);assert.deepEqual(JSON.parse(h.calls[post].body),sessionConfig(config));
});
test('initialization late completion must precede DELETE even if a transient closed was seen',async()=>{
 let reads=0;const h=fixture({...ready,phase:'initializing',initialized:false},(p,r)=>r.method==='DELETE'?data('closed'):data(['initializing','closed','worker_ready','closed'][reads++]));
 await h.owner.release('old');assert.equal(h.calls.findIndex(c=>c.method==='DELETE'),3);assert.equal(h.owner.snapshot(),null);
});
test('initialization timeout quarantines without DELETE or new POST',async()=>{
 const h=fixture({...ready,phase:'initializing',initialized:false},()=>data('closed'));await assert.rejects(h.owner.prepare());assert.ok(h.calls.every(c=>c.method==='GET'));assert.equal(h.owner.snapshot().sid,'sess_aa');
});
test('unknown creation persists before request and cannot POST again',async()=>{
 const h=fixture(null,(p,r)=>{if(p==='/queue/status')return {data:{slot_occupied:false,queue_size:0}};assert.equal(h.owner.snapshot().phase,'create_unknown');throw Error('transport lost');});await assert.rejects(h.owner.prepare());await assert.rejects(h.owner.prepare());assert.equal(h.calls.filter(c=>c.method==='POST').length,1);
});
test('concurrent prepare rejected, stale lease cannot close current session',async()=>{
 let resolve;const pending=new Promise(r=>resolve=r);const h=fixture(null,async(p,r)=>{if(p==='/queue/status'){await pending;return {data:{slot_occupied:false,queue_size:0}};}if(r.method==='POST')return {data:{session_id:'sess_aa'}};return data('worker_ready');});const first=h.owner.prepare();await assert.rejects(h.owner.prepare(),e=>e.status===409);resolve();const result=await first;await assert.rejects(h.owner.release('stale'));assert.equal(h.owner.snapshot().lease,result.lease);assert.equal(h.calls.filter(c=>c.method==='DELETE').length,0);
});
