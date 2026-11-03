export class SubmissionGate {
  constructor() { this.epoch=0; this.state='ready'; this.pending=null; this.unknown=false; }
  async upload(operation) {
    if(this.state!=='ready'||this.pending||this.unknown) throw Error('提交闸门未开放');
    const token=this.epoch; this.state='uploading';
    const pending=Promise.resolve().then(operation); this.pending=pending;
    try { await pending; if(token===this.epoch) this.state='playing'; }
    catch(e) { this.unknown=true; if(this.state!=='stopped')this.state='quarantined'; throw e; }
    finally { if(this.pending===pending) this.pending=null; }
  }
  async interrupt(operation) {
    if(this.state==='stopped') throw Error('本轮已停止');
    if(this.state==='draining') throw Error('正在等待最后中断');
    ++this.epoch; this.state='draining';
    if(this.pending) { try { await this.pending; } catch { this.unknown=true; } }
    if(this.state==='stopped') return;
    try { await operation(); if(this.state!=='stopped')this.state=this.unknown?'quarantined':'awaiting_observation'; }
    catch(e) { this.unknown=true; if(this.state!=='stopped')this.state='quarantined'; throw e; }
  }
  conditionalResume() {
    if(this.unknown||this.pending||this.state!=='awaiting_observation') throw Error('未知结果或未完成中断，禁止恢复');
    this.state='ready';
  }
  stop() { ++this.epoch; this.state='stopped'; }
}
export function wav(chunks,rate) {
  const length=chunks.reduce((n,a)=>n+a.length,0), buffer=new ArrayBuffer(44+length*2), view=new DataView(buffer);
  const text=(o,s)=>[...s].forEach((c,i)=>view.setUint8(o+i,c.charCodeAt(0)));
  text(0,'RIFF');view.setUint32(4,36+length*2,true);text(8,'WAVE');text(12,'fmt ');view.setUint32(16,16,true);
  view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,rate,true);view.setUint32(28,rate*2,true);
  view.setUint16(32,2,true);view.setUint16(34,16,true);text(36,'data');view.setUint32(40,length*2,true);
  let offset=44; for(const chunk of chunks) for(const x of chunk) { view.setInt16(offset,Math.round(Math.max(-1,Math.min(1,x))*32767),true);offset+=2; }
  return buffer;
}
