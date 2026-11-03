import test from 'node:test'; import assert from 'node:assert/strict';
import {SubmissionGate,wav} from './core.mjs';
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject}};
test('late upload settles before final interrupt; no concurrent upload',async()=>{
 const g=new SubmissionGate(),d=deferred(),events=[];const u=g.upload(()=>d.promise.then(()=>events.push('upload')));
 await assert.rejects(g.upload(async()=>{})); const i=g.interrupt(async()=>events.push('interrupt'));
 assert.deepEqual(events,[]);d.resolve();await Promise.all([u,i]);assert.deepEqual(events,['upload','interrupt']);
 assert.equal(g.state,'awaiting_observation');g.conditionalResume();assert.equal(g.state,'ready');
});
test('lost upload response cannot be released even after interrupt success',async()=>{
 const g=new SubmissionGate();await assert.rejects(g.upload(async()=>{throw Error('timeout')}));await g.interrupt(async()=>{});
 assert.equal(g.state,'quarantined');assert.throws(()=>g.conditionalResume());await assert.rejects(g.upload(async()=>{}));
});
test('stop prevents late response or queued interrupt from reopening',async()=>{
 const g=new SubmissionGate(),d=deferred();const u=g.upload(()=>d.promise);let calls=0;const i=g.interrupt(async()=>{calls++});
 g.stop();d.resolve();await Promise.all([u,i]);assert.equal(g.state,'stopped');assert.equal(calls,0);assert.throws(()=>g.conditionalResume());
});
test('interrupt failure quarantines and WAV preserves first samples',async()=>{
 const g=new SubmissionGate();await assert.rejects(g.interrupt(async()=>{throw Error('network')}));assert.throws(()=>g.conditionalResume());
 const v=new DataView(wav([new Float32Array([.5,-.5])],16000));assert.equal(v.getUint32(24,true),16000);assert.equal(v.getUint32(40,true),4);assert.equal(v.getInt16(44,true),16384);
});
test('late failure and late interrupt acknowledgement cannot resurrect stopped gate',async()=>{
 const g=new SubmissionGate(),d=deferred();const u=g.upload(()=>d.promise);g.stop();d.reject(Error('lost'));await assert.rejects(u);assert.equal(g.state,'stopped');
 const h=new SubmissionGate(),e=deferred();const i=h.interrupt(()=>e.promise);h.stop();e.resolve();await i;assert.equal(h.state,'stopped');
});
