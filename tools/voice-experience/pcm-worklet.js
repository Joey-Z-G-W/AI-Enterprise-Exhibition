class PCMTap extends AudioWorkletProcessor {
 constructor(){super();this.active=true;this.port.onmessage=e=>{if(e.data==='stop'){this.active=false;this.port.postMessage({stopped:true});}};}
 process(inputs,outputs){
  if(!this.active)return false;
  const input=inputs[0]?.[0];if(input){const copy=input.slice();this.port.postMessage({pcm:copy,contextFrame:currentFrame,rate:sampleRate},[copy.buffer]);}
  // Intentionally silent sink: this branch measures PCM without playing it twice.
  for(const channel of outputs[0]||[])channel.fill(0);return true;
 }
}
registerProcessor('pcm-tap',PCMTap);
