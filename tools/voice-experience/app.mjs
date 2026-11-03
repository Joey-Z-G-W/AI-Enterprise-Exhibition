import {SubmissionGate,wav} from './core.mjs';
const $=id=>document.getElementById(id), now=()=>performance.now();
const criteria=await fetch('/criteria.json').then(r=>r.json()), assets=await fetch('/assets/manifest.json').then(r=>r.json());
const events=[], diagnostics=[], frames=[], recordings=[], taps=[], contexts=[], trackedStreams=[], urls=[];
let gate=new SubmissionGate(),epoch=0,ctx=null,micVad=null,micStream=null,peer=null,receiver=null,statsTimer=null,limitTimer=null,segmentTimer=null;
let microphoneBusy=false,connectBusy=false,smokeBusy=false,ending=false,stopped=false,sessionId='',lastInterrupt=null;
let environment=null, syntheticResult=null, remoteFirstBySubmission=false;
let handoff=null,startBusy=false,cleanupPromise=null,captureReleased=false,replayUrl=null,speechPending=false,replayNeedsFull=false;
let terminalFailure='';
let pendingPrepare=null,managedLease=null,ownershipUnknown=false;
const log=(type,data={})=>{const entry={t_ms:now(),type,...data};events.push(entry);if(events.length>15000)events.shift();if(type!=='pcm_meter'){diagnostics.push(entry);$('connectionDiagnostics').textContent=JSON.stringify(diagnostics,null,2);}$('details').textContent=JSON.stringify({gate:gate.state,unknown:gate.unknown,events:events.slice(-24)},null,2);};
const say=s=>$('status').textContent=terminalFailure?`${terminalFailure}\n${s}`:s;
const cfg={model:'v5',positiveSpeechThreshold:criteria.vad.positiveSpeechThreshold,negativeSpeechThreshold:criteria.vad.negativeSpeechThreshold,redemptionMs:criteria.vad.redemptionMs,preSpeechPadMs:criteria.vad.preSpeechPadMs,minSpeechMs:criteria.vad.minSpeechMs,submitUserSpeechOnPause:false,startOnLoad:false,processorType:'AudioWorklet',baseAssetPath:'/assets/vad/',onnxWASMBasePath:'/assets/ort/',ortConfig:o=>{o.env.wasm.numThreads=1;o.env.wasm.proxy=false;}};
const stopTracks=s=>s?.getTracks().forEach(t=>t.stop());
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function bounded(promise,ms=15000){let timer;try{return await Promise.race([promise,new Promise((_,r)=>{timer=setTimeout(()=>r(Error('操作超时；结果可能未知')),ms);})]);}finally{clearTimeout(timer);}}
async function request(path,body,timeoutMs=45000){const started=now();log('http_start',{operation:path.split('/').at(-1)});try{const response=await fetch('/api'+path,{method:body===undefined?'GET':'POST',body:body instanceof FormData?body:body===undefined?undefined:JSON.stringify(body),headers:body instanceof FormData||body===undefined?{}:{'Content-Type':'application/json'},signal:AbortSignal.timeout(timeoutMs)});log('http_response',{operation:path.split('/').at(-1),status:response.status,elapsed_ms:now()-started});if(!response.ok)throw Error('API失败；提交结果按未知处理');return await response.json();}catch(e){log('http_unknown',{operation:path.split('/').at(-1)});throw e;}}
function frozenEnvironment(){
 if(environment)return;
 environment={trial:handoff.handoff_id,browser:navigator.userAgent,secure_context:isSecureContext,assets,criteria,clock:{performance_time_origin:performance.timeOrigin}};
 $('remote').volume=.7;log('environment_frozen');
}
function current(token){return token===epoch&&!stopped;}
async function audioContext(token){
 if(!current(token))throw Error('本轮已停止');
 if(!ctx||ctx.state==='closed'){ctx=new AudioContext();contexts.push(ctx);await ctx.audioWorklet.addModule('/pcm-worklet.js');}
 if(!current(token))throw Error('本轮已停止');
 await ctx.resume();if(!current(token))throw Error('本轮已停止');return ctx;
}
async function disposeLate(instance,stream){
 stopTracks(stream);try{await bounded(instance?.destroy(),5000);}catch{log('late_vad_destroy_error');}
 log('late_setup_resources_released');
}
async function tap(stream,kind,token){
 const context=await audioContext(token);if(!current(token))return;
 const source=context.createMediaStreamSource(stream),node=new AudioWorkletNode(context,'pcm-tap');const record={kind,rate:context.sampleRate,chunks:[],started_ms:now(),sample_count:0};recordings.push(record);
 const entry={source,node,record,ended:false};taps.push(entry);let meterSamples=0,meterPower=0,meterStart=0;
 node.port.onmessage=e=>{if(e.data.stopped){entry.ended=true;log('tap_worklet_stopped',{kind});return;}if(token!==epoch)return;const {pcm,contextFrame,rate}=e.data;if(!pcm)return;record.chunks.push(pcm);record.sample_count+=pcm.length;
  if(!meterSamples)meterStart=contextFrame;for(const x of pcm)meterPower+=x*x;meterSamples+=pcm.length;
  if(meterSamples>=rate/20){const rms=Math.sqrt(meterPower/meterSamples);log('pcm_meter',{kind,rms,context_frame:meterStart,context_time_s:meterStart/rate,delivery_context_time_s:context.currentTime,samples:meterSamples});
   if(kind==='remote'&&remoteFirstBySubmission&&rms>.01){remoteFirstBySubmission=false;log('first_remote_energy_candidate',{rms,classification:'unclassified A/B; listen and correlate WAV, not a speech or drain verdict'});}
   meterSamples=0;meterPower=0;
  }
  if(record.sample_count>rate*120){log('recording_cap',{kind});void cleanup();}
 };source.connect(node);node.connect(context.destination);return entry;
}
async function startMic(){
 if(microphoneBusy||micVad||ending||stopped)throw Error('本轮正在准备或已结束');
 frozenEnvironment();const token=epoch,deadline=now()+30000;microphoneBusy=true;
 const step=p=>bounded(p,Math.max(1,deadline-now()));
 try {
  log('mic_gum_requested');say('正在开启麦克风，请允许访问；最多等待30秒。');
  const pending=navigator.mediaDevices.getUserMedia({video:false,audio:{echoCancellation:{exact:true},noiseSuppression:true,autoGainControl:true,channelCount:1}}).then(stream=>{
   trackedStreams.push(stream);
   if(!current(token)){stopTracks(stream);log('late_permission_tracks_stopped');throw Error('本轮已停止');}
   micStream=stream;return stream;
  });
  const stream=await step(pending);if(!current(token))throw Error('本轮已停止');
  log('mic_gum_resolved');const settings=stream.getAudioTracks()[0].getSettings();
  const safeSettings={echoCancellation:settings.echoCancellation,noiseSuppression:settings.noiseSuppression,autoGainControl:settings.autoGainControl,sampleRate:settings.sampleRate,channelCount:settings.channelCount};
  environment.microphone={alias:'microphone-1',settings:safeSettings};
  $('device').textContent=`实际AEC=${String(settings.echoCancellation)}，采样率=${settings.sampleRate}`;
  log('mic_settings',{settings:safeSettings});if(settings.echoCancellation!==true)throw Error('麦克风回声消除未开启，无法开始本轮。');
  log('mic_pcm_start');await step(tap(stream,'microphone',token));if(!current(token))throw Error('本轮已停止');log('mic_pcm_ready');
  const context=await step(audioContext(token));log('mic_vad_init_start');
  const pendingVad=vad.MicVAD.new({...cfg,audioContext:context,getStream:async()=>{if(!current(token)){stopTracks(stream);throw Error('本轮已停止');}return stream;},pauseStream:async s=>stopTracks(s),resumeStream:async()=>{throw Error('本轮不可自动重开麦克风');},
   onFrameProcessed:(p,frame)=>{if(!current(token))return;frames.push({t_ms:now(),sample_count:frame.length,isSpeech:p.isSpeech});},
   onSpeechStart:()=>{if(!current(token))return;speechPending=true;log('vad_start');clearTimeout(segmentTimer);segmentTimer=setTimeout(()=>{log('continuous_speech_cap_30s');void cleanup();},30000);},
   onVADMisfire:()=>{if(!current(token))return;speechPending=false;clearTimeout(segmentTimer);log('vad_misfire');},
   onSpeechRealStart:()=>{if(!current(token))return;speechPending=true;const t=now();log('vad_real_start');$('remote').muted=true;log('local_mute_set',{latency_ms:now()-t,actual_muted:$('remote').muted});if(sessionId&&['uploading','playing'].includes(gate.state))void interrupt().catch(error);},
   onSpeechEnd:audio=>{if(!current(token))return;speechPending=false;clearTimeout(segmentTimer);recordings.push({kind:`segment-${recordings.filter(r=>r.kind.startsWith('segment')).length+1}`,rate:16000,chunks:[audio.slice(0,16000*30)],sample_count:Math.min(audio.length,16000*30),ended_ms:now()});log('vad_segment_end',{samples:audio.length,seconds:audio.length/16000});}
  }).then(async instance=>{if(!current(token)){await disposeLate(instance,stream);throw Error('本轮已停止');}micVad=instance;return instance;});
  const instance=await step(pendingVad);if(!current(token))throw Error('本轮已停止');log('mic_vad_ready');
  await step(Promise.resolve(instance.start()).then(async()=>{if(!current(token)){await disposeLate(instance,stream);throw Error('本轮已停止');}}));
  if(!current(token))throw Error('本轮已停止');log('mic_started');
  limitTimer=setTimeout(()=>void cleanup(),120000);
 }catch(e){log('mic_setup_failed',{error_name:['NotAllowedError','NotFoundError','NotReadableError','OverconstrainedError','AbortError'].includes(e?.name)?e.name:'setup_timeout_or_cancelled'});throw e;}
 finally{microphoneBusy=false;}
}
async function connect(){
 if(peer||connectBusy||ending||smokeBusy||stopped)throw Error('已有连接、正在检查或本轮已结束；结束后请重新载入');
 frozenEnvironment();const sid=handoff.session_id;if(!/^sess_[a-f0-9]+$/.test(sid))throw Error('请填写负责人移交的会话ID');
 const token=epoch;connectBusy=true;let candidate;
 try {
  log('rtc_phase',{phase:'fetch_ice_config'});say('正在读取数字人连接配置（最多10秒）…');
  let iceConfig;
  try{iceConfig=await request('/sessions/webrtc/ice-config',undefined,10000);}catch{throw Error('连接配置读取失败或超时，未提交RTC offer；请交负责人核对。');}
  if(token!==epoch)throw Error('连接已取消，未提交RTC offer');
  if(!iceConfig||!Array.isArray(iceConfig.iceServers)||!['all','relay'].includes(iceConfig.iceTransportPolicy))throw Error('连接配置格式无效，未提交RTC offer；请交负责人核对。');
  log('rtc_ice_config',{server_count:iceConfig.iceServers.length,policy:iceConfig.iceTransportPolicy});
  // Use the same server-provided ICE settings as the deployed frontend. Never export URLs/credentials/SDP.
  candidate=new RTCPeerConnection({iceServers:iceConfig.iceServers,iceTransportPolicy:iceConfig.iceTransportPolicy});peer=candidate;sessionId=sid;receiver=new MediaStream();trackedStreams.push(receiver);$('remote').srcObject=receiver;
  candidate.ontrack=event=>{if(token!==epoch){event.track.stop();return;}receiver.addTrack(event.track);log('rtc_track',{kind:event.track.kind});
   if(event.track.kind==='audio')void tap(new MediaStream([event.track]),'remote',token).catch(error);
   void $('remote').play().catch(()=>{say('浏览器阻止外放，请点击“允许外放声音”。');log('autoplay_blocked');});
  };
  candidate.onconnectionstatechange=()=>log('rtc_state',{state:candidate.connectionState});
  candidate.oniceconnectionstatechange=()=>log('rtc_ice_state',{state:candidate.iceConnectionState});
  candidate.onicegatheringstatechange=()=>log('rtc_gathering_state',{state:candidate.iceGatheringState});
  candidate.onsignalingstatechange=()=>log('rtc_signaling_state',{state:candidate.signalingState});
  candidate.addTransceiver('video',{direction:'recvonly'});candidate.addTransceiver('audio',{direction:'recvonly'});
  await bounded((async()=>{log('rtc_phase',{phase:'create_offer'});await candidate.setLocalDescription(await candidate.createOffer());log('rtc_phase',{phase:'gather_candidates'});const until=now()+8000;while(candidate.iceGatheringState!=='complete'&&now()<until){if(token!==epoch)throw Error('取消连接');await wait(100);}if(token!==epoch)throw Error('取消连接');
   log('rtc_phase',{phase:'submit_offer'});const answer=await request(`/sessions/${sid}/webrtc/offer`,{type:'offer',sdp:candidate.localDescription.sdp});if(token!==epoch)throw Error('取消连接');log('rtc_phase',{phase:'apply_answer'});await candidate.setRemoteDescription(answer);log('rtc_phase',{phase:'wait_connected'});
   while(candidate.connectionState!=='connected'){if(token!==epoch||['failed','closed'].includes(candidate.connectionState))throw Error('RTC未连接');await wait(100);}
  })(),60000);
  if(token!==epoch)throw Error('取消连接');log('rtc_connected');statsTimer=setInterval(async()=>{if(token!==epoch)return;try{const stats=await candidate.getStats();stats.forEach(s=>{if(s.type==='inbound-rtp')log('rtc_stats',{kind:s.kind,bytes:s.bytesReceived,packets:s.packetsReceived,packets_lost:s.packetsLost,jitter:s.jitter,frames_decoded:s.framesDecoded});});}catch{}},1000);
  say('数字人已连接，正在准备说话。');
 }catch(e){candidate?.close();if(peer===candidate){peer=null;sessionId='';}log('rtc_phase',{phase:'failed_or_cancelled'});throw Error(candidate?'RTC连接失败或超时；请查看下方完整连接诊断并交负责人核对，本轮不重试。':e.message.startsWith('连接')?e.message:'连接配置无法使用，未提交RTC offer；请交负责人核对。');}finally{connectBusy=false;}
}
async function uploadA(){
 if(!sessionId||peer?.connectionState!=='connected'||!micVad?.listening)throw Error('准备尚未完成');
 const token=epoch,submissionEpoch=gate.epoch,deadline=now()+30000;
 const check=()=>{if(!current(token)||submissionEpoch!==gate.epoch)throw Error('本轮已停止，未发送音频');};
 async function quiet(){
  check();
  if(speechPending){$('remote').muted=true;log('sample_waiting_for_speech_end');say('我先听您说，您说完后数字人再开口。');}
  while(speechPending){check();if(now()>=deadline)throw Error('等待说话结束超时');await wait(50);}
  check();
 }
 await quiet();
 const blob=await fetch('/assets/audio/A.wav',{signal:AbortSignal.timeout(10000)}).then(r=>{if(!r.ok)throw Error('样音读取失败');return r.blob();});
 await quiet();
 // Play while muted; speech may start during this asynchronous autoplay boundary.
 $('remote').muted=true;await $('remote').play();await quiet();check();
 $('remote').muted=false;remoteFirstBySubmission=true;
 log('upload_requested',{sample:'A',sample_sha256:assets.samples.find(s=>s.id==='A').sha256});
 await gate.upload(async()=>{check();const sid=sessionId;const form=new FormData();form.append('file',blob,'A.wav');const result=await request(`/sessions/${sid}/speak_flashtalk_audio`,form);if(result.session_id!==sid||result.status!=='queued')throw Error('上传结果未知');});
 log('upload_settled',{sample:'A',state:gate.state});
 if(current(token))say('稍等数字人开口；听到声音后，直接开口打断。结束后点“停止”。');
}
async function interrupt(){
 if(!sessionId)throw Error('无已移交会话');$('remote').muted=true;
 const sid=sessionId;log('interrupt_intent',{pending_upload:!!gate.pending});
 try{
  await gate.interrupt(async()=>{log('final_interrupt_sent');const result=await request(`/sessions/${sid}/interrupt`,{});if(result.session_id!==sid||result.status!=='interrupted')throw Error('中断回执异常');lastInterrupt=now();log('final_interrupt_response',{drain_ack:false});});
 }catch{
  terminalFailure='数字人中断未确认，本轮已结束；请负责人核对后再测试。';
  log('interrupt_failed',{unknown:gate.unknown});
  await cleanup();return;
 }
 if(!stopped)say(gate.unknown?'本轮发送结果不确定，请停止并交负责人确认。':'已检测到您开口，并静音本地数字人。说完后点“停止”，再回放自己的声音。');log('interrupt_settled',{state:gate.state});
}
async function trialRequest(action,body){
 const response=await fetch('/trial/'+action,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(100000)});
 if(!response.ok)throw Error('本轮会话状态尚未确认，请负责人核对。');
 return response.json();
}
function cleanup(){
 if(cleanupPromise)return cleanupPromise;
 ending=true;stopped=true;++epoch;replayNeedsFull=speechPending;gate.stop();clearInterval(statsTimer);clearTimeout(limitTimer);clearTimeout(segmentTimer);
 $('start').disabled=true;$('stop').disabled=true;$('replay').disabled=true;
 const instance=micVad,preparing=pendingPrepare;micVad=null;trackedStreams.forEach(stopTracks);peer?.close();peer=null;$('remote').muted=true;$('remote').pause();$('remote').srcObject=null;
 for(const t of taps){t.node.port.postMessage('stop');t.source.disconnect();t.node.disconnect();}
 cleanupPromise=(async()=>{
  try{if(instance)await bounded(instance.destroy(),5000);}catch{log('vad_destroy_error');}
  for(const context of contexts)if(context.state!=='closed')try{await bounded(context.close(),3000);}catch{log('context_close_error');}
  captureReleased=trackedStreams.every(s=>s.getTracks().every(t=>t.readyState==='ended'))&&contexts.every(c=>c.state==='closed');
  try{
   const prepared=preparing?await preparing:null;
   const lease=managedLease||prepared?.lease;
   if(lease){const result=await trialRequest('release',{lease});if(result.released!==true)throw Error('关闭未确认');managedLease=null;log('owned_session_released');}
  }catch{ownershipUnknown=true;terminalFailure=terminalFailure||'会话关闭或创建结果尚未确认；请负责人核对，暂不能重新测试。';log('owned_session_unknown');}
  log('cleanup',{track_states:trackedStreams.flatMap(s=>s.getTracks().map(t=>({kind:t.kind,state:t.readyState}))),contexts:contexts.map(c=>c.state),capture_released:captureReleased,upstream_session_state:ownershipUnknown?'unknown':'released',unresolved_upload:!!gate.pending});
  ending=false;$('start').disabled=ownershipUnknown||!captureReleased;$('replay').disabled=!captureReleased||!recordings.some(r=>r.kind==='microphone'&&r.sample_count>0);
  say(captureReleased?'本轮已停止。可以回放自己的声音，也可以再次开始测试。':'正在等待收音资源释放，请交负责人核对。');
 })();return cleanupPromise;
}
async function startTest(){
 if(startBusy||ending||ownershipUnknown||(stopped&&!captureReleased))return;
 startBusy=true;
 // A new user click may replace local replay only after the previous owned session was released.
 $('replayAudio').pause();if(replayUrl){URL.revokeObjectURL(replayUrl);replayUrl=null;}$('replayAudio').hidden=true;$('replayAudio').removeAttribute?.('src');
 if(stopped){
  events.length=diagnostics.length=frames.length=recordings.length=taps.length=contexts.length=trackedStreams.length=0;
  gate=new SubmissionGate();ctx=null;micStream=null;receiver=null;environment=null;handoff=null;sessionId='';lastInterrupt=null;
  cleanupPromise=null;pendingPrepare=null;captureReleased=false;speechPending=false;replayNeedsFull=false;terminalFailure='';stopped=false;++epoch;
 }
 $('start').disabled=true;$('stop').disabled=false;$('replay').disabled=true;
 const token=epoch;
 try{
  say('正在准备本轮测试…');
  pendingPrepare=trialRequest('prepare',{});
  const data=await pendingPrepare;
  if(!data.lease||!data.handoff_id||!/^sess_[a-f0-9]+$/.test(data.session_id)||typeof data.avatar_id!=='string'||!data.avatar_id||data.tts_voice!==assets.samples.find(s=>s.id==='A').voice)throw Error('会话准备结果未知');
  if(!current(token))return;
  managedLease=data.lease;handoff=data;log('trial_prepared');await startMic();if(!current(token))return;
  await connect();if(!current(token))return;await uploadA();
 }catch(e){
  const wasCurrent=current(token);log('start_failed',{stage:diagnostics.filter(x=>x.type.startsWith('mic_')||x.type==='rtc_phase').at(-1)?.type||'prepare'});
  if(wasCurrent){if(!managedLease)ownershipUnknown=true;await cleanup();say('本轮准备失败或等待超时，已停止收音。请查看诊断或交负责人核对。');}
 }finally{startBusy=false;}
}
async function replayMine(){
 if(!stopped||ending||!captureReleased)throw Error('请先停止收音，再回放。');
 const segments=recordings.filter(r=>r.kind.startsWith('segment-')&&r.chunks.length);
 const mic=recordings.find(r=>r.kind==='microphone'&&r.sample_count>0);
 if(!mic)throw Error('本轮还没有录到声音。');
 const useSegments=!replayNeedsFull&&segments.length>0;
 const chunks=useSegments?segments.flatMap(r=>r.chunks):mic.chunks,rate=useSegments?16000:mic.rate;
 const player=$('replayAudio');player.pause();if(replayUrl)URL.revokeObjectURL(replayUrl);
 replayUrl=URL.createObjectURL(new Blob([wav(chunks,rate)],{type:'audio/wav'}));player.src=replayUrl;player.hidden=false;player.controls=true;
 log('local_replay',{source:useSegments?'vad_microphone_segments':'full_microphone_recording',seconds:chunks.reduce((n,a)=>n+a.length,0)/rate});
 say(useSegments?'正在回放您刚才说的话（保留原语音片段开头）。':'正在回放本轮完整收音，可拖动进度条跳过准备阶段。');
 await player.play();
}
function evidence(){return {schema_version:1,probe_version:'voice-experience-v4',status:'human_pending_not_formal_acceptance',environment,synthetic_result:syntheticResult,events,diagnostics,frames,gate:{state:gate.state,unknown:gate.unknown},recordings:recordings.map(({chunks,...meta})=>meta),limitations:['No LLM/STT requests','No server SSE/thread logs or correlated drain acknowledgement','RMS is unclassified; A/B old-voice identity requires waveform/listening analysis','Manual onset markers are not precise human onset','Speaker/human first syllable listening not performed by this page','Local delayed-submit test is not a service-side delayed request','No claim of general same-session safety']};}
function error(e){log('operation_error',{message:String(e.message).replace(/sess_[a-f0-9]+/g,'session-redacted')});say(e.message);}
for(const [id,action] of Object.entries({start:startTest,stop:cleanup,replay:replayMine}))$(id).onclick=()=>Promise.resolve().then(action).catch(error);
window.addEventListener('pagehide',()=>{void cleanup();$('replayAudio').pause();if(replayUrl)URL.revokeObjectURL(replayUrl);});
document.addEventListener('visibilitychange',()=>{if(document.hidden&&!stopped){log('background_invalidates_trial');if(startBusy||microphoneBusy||micVad||peer)void cleanup();}});
window.probeEvidence=()=>evidence();
log('page_ready',{automatic_media_operations:0,criteria_sha256:assets.criteria_sha256});
