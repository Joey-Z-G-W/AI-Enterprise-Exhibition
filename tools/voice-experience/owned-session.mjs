import {randomUUID} from 'node:crypto';
const base='http://127.0.0.1:8210';
export function sessionConfig(config){
 if(!config||typeof config.avatar_id!=='string'||!config.avatar_id.trim()||typeof config.tts_voice!=='string'||!config.tts_voice.trim())throw Error('请先配置 local.json 的 avatar_id 和 tts_voice');
 return Object.freeze({avatar_id:config.avatar_id,model:'quicktalk',tts_provider:'edge',stt_provider:'sensevoice',tts_voice:config.tts_voice,agent_enabled:false,memory_enabled:false,knowledge_enabled:false});
}
const failure=(message,status=409)=>Object.assign(Error(message),{status});

// One task-owned session only. Unknown creation is persisted before the one POST.
export function ownedSession({config,record=null,save,fetchImpl=fetch,now=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms))}){
 const configured=sessionConfig(config);
 let current=record,busy=false;
 if(current&&(!['create_unknown','initializing','ready','closing'].includes(current.phase)||typeof current.lease!=='string'||(current.sid!==null&&!/^sess_[a-f0-9]+$/.test(current.sid))))throw failure('Owned record needs operator review');
 const persist=async value=>{current=value;await save(value);};
 async function call(method,path,deadline,body){
  const remaining=deadline-now();if(remaining<=0)throw failure('等待上游状态超时，本轮已隔离。',504);
  const r=await fetchImpl(base+path,{method,headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(Math.max(1,Math.min(remaining,method==='POST'?30000:10000)))});
  const data=await r.json();return {status:r.status,data};
 }
 async function get(deadline){const r=await call('GET','/sessions/'+current.sid,deadline);if(r.status!==200&&r.status!==404)throw failure('无法确认本轮会话状态。',503);if(r.status===200&&r.data.session_id!==current.sid)throw failure('会话身份不符。');return r;}
 async function initialized(deadline){
  while(!current.initialized){
   const r=await get(deadline);
   if(r.status===200&&['worker_ready','ready','speaking','error'].includes(r.data.state)){await persist({...current,initialized:true});return r;}
   // A transient closed/404 does not establish that an independent init task ended.
   if(now()>=deadline)throw failure('初始化尚未确认结束，本轮已隔离。',504);
   await sleep(Math.min(200,Math.max(1,deadline-now())));
  }
  return get(deadline);
 }
 async function close(deadline){
  if(!current)return;
  if(!current.sid)throw failure('创建结果未知，禁止重新创建；请负责人核对。');
  let r=await initialized(deadline);
  if(r.status===404||r.data.state==='closed'){await persist(null);return;}
  if(current.phase!=='closing'){
   await persist({...current,phase:'closing'});
   const deleted=await call('DELETE','/sessions/'+current.sid,deadline);
   if(![200,202,404].includes(deleted.status))throw failure('关闭请求未确认，本轮已隔离。',503);
  }
  while(true){
   r=await get(deadline);if(r.status===404||r.data.state==='closed'){await persist(null);return;}
   if(now()>=deadline)throw failure('尚未确认旧会话关闭，禁止重新创建。',504);
   await sleep(Math.min(200,Math.max(1,deadline-now())));
  }
 }
 async function exclusive(action){if(busy)throw failure('本轮正在准备或释放，请勿重复操作。');busy=true;try{return await action();}finally{busy=false;}}
 return {
  owns:sid=>current?.sid===sid&&current.phase==='ready',
  snapshot:()=>current?{...current}:null,
  prepare:()=>exclusive(async()=>{
   const deadline=now()+90000;await close(deadline);
   const queue=await call('GET','/queue/status',deadline);
   if(queue.status!==200||queue.data.slot_occupied!==false||queue.data.queue_size!==0)throw failure('数字人正在使用，请稍后再试。');
   await persist({sid:null,lease:randomUUID(),initialized:false,phase:'create_unknown'});
   const created=await call('POST','/sessions',deadline,configured);
   if(created.status!==200||!/^sess_[a-f0-9]+$/.test(created.data.session_id))throw failure('创建结果未知，禁止重试；请负责人核对。',503);
   await persist({...current,sid:created.data.session_id,phase:'initializing'});
   const ready=await initialized(deadline);
   if(ready.status!==200||!['worker_ready','ready'].includes(ready.data.state))throw failure('数字人初始化未成功。',503);
   await persist({...current,phase:'ready'});
   return {session_id:current.sid,lease:current.lease,handoff_id:current.lease,state:ready.data.state,avatar_id:configured.avatar_id,tts_voice:configured.tts_voice};
  }),
  release:lease=>exclusive(async()=>{
   if(!current)return {released:true};
   if(lease!==current.lease)throw failure('旧轮次不能关闭新会话。');
   await close(now()+90000);return {released:true};
  })
 };
}
