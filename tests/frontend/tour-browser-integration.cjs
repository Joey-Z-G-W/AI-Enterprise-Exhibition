// <导览功能 | main | 集成产物可定向到任务目录，不依赖企业文档路径>
// Complete React / coordinator / player / WebRTC client against external HTTP, RTP and SSE boundaries.
const assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path'), http = require('node:http');
const { pathToFileURL } = require('node:url'), { createRequire } = require('node:module');
process.chdir(path.resolve(__dirname, '../..'));
const { chromium } = createRequire(path.resolve('frontend/package.json'))('playwright-core');
const { Fixture } = require('./speech-browser-integration.cjs');
const task = path.resolve(process.env.GUIDE_TEST_TASK_DIR || path.join(require('node:os').tmpdir(), 'exhibition-guide-integration'));
const dir = path.join(task, 'tmp', 'tour-browser-' + Date.now());
const texts = ['先看整体的开放布局。', '接着，这里的吊楣让品牌更醒目。', '内侧通过通透隔断划分区域。'];
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(check, label, ms = 8000) { const end = Date.now() + ms; while (!await check()) { if (Date.now() > end) throw Error(label); await sleep(20); } }
function wav() { const b = Buffer.alloc(44 + 32000 * 2); b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1,20); b.writeUInt16LE(1,22); b.writeUInt32LE(16000,24); b.writeUInt32LE(32000,28); b.writeUInt16LE(2,32); b.writeUInt16LE(16,34); b.write('data',36); b.writeUInt32LE(b.length-44,40); return b; }
class TourFixture extends Fixture {
 constructor() { super(); this.receipts=[]; this.resets=[]; this.ids=['one','two','three']; this.aligned=[]; this.heldReceipts=[]; }
 async handle(req,res) {
  const json = value => { res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(value)); };
  const body = async () => {const chunks=[];for await(const c of req)chunks.push(c);return JSON.parse(Buffer.concat(chunks));};
  if(req.url==='/guide/ui-config'){res.setHeader('X-Guide-Speech-Mode','paragraph');json({avatar_id:'fixture-avatar',tts_voice:'fixture-voice'});return true;}
  if(req.url==='/guide/questions'){const b=await body();this.questions.push(b);json({...b,status:'answer',text:texts.join(''),sources:[],presentation:{mode:'paragraph',sentences:texts.map((text,i)=>({id:'s'+(i+1),text,asset_id:this.ids[i]})),assets:[...new Set(this.ids.filter(Boolean))].map(id=>({id,kind:'image',url:'/guide/media/'+id,mime:'image/png',alt:id}))}});return true;}
  if(req.url.startsWith('/guide/media/')){res.writeHead(req.url.endsWith('missing')?404:200,{'content-type':'image/png'});res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5X8AAAAASUVORK5CYII=','base64'));return true;}
  if(req.url==='/opentalking/tts/preview-aligned'){const b=await body();this.aligned.push(b);json({audio_base64:wav().toString('base64'),duration_ms:2000,timeline:this.badTimeline?[{text:'错位文本',start_ms:0,end_ms:1500}]:texts.map((text,i)=>({text,start_ms:i*500,end_ms:(i+1)*500+(i<2?50:0)}))});return true;}
  if(req.url.endsWith('/playback')){const receipt=await body();this.receipts.push(receipt);if(this.holdReceipts)this.heldReceipts.push(()=>json({accepted:true}));else json({accepted:true});return true;}
  if(req.url.endsWith('/webrtc/reset')){this.resets.push(Date.now());json({session_id:this.sid(this.serial),status:'receiver_reset'});return true;}
  return super.handle(req,res);
 }
}
function platform(){
 Object.defineProperty(navigator.mediaDevices,'getUserMedia',{configurable:true,value:()=>Promise.reject(new DOMException('fixture denied','NotAllowedError'))});
 let callback, count=0;
 HTMLVideoElement.prototype.requestVideoFrameCallback=function(fn){callback=fn;return ++count;};
 HTMLVideoElement.prototype.cancelVideoFrameCallback=function(){callback=null;};
 window.present=(rtp)=>{const fn=callback;callback=null;fn?.(performance.now(),{rtpTimestamp:rtp});};
 window.rtcCount=0;
 window.RTCPeerConnection=class{
  constructor(){this.gen='pc-'+(++window.rtcCount);window.peer=this;}
  iceGatheringState='complete';connectionState='new';iceConnectionState='new';
  createDataChannel(){const c={readyState:'open',send:()=>c.onmessage?.({data:JSON.stringify({type:'capabilities',version:1,generation:this.gen,clock:'rtp-video'})})};this.channel=c;setTimeout(()=>c.onopen?.(),0);return c;}
  addTransceiver(){} async createOffer(){return{type:'offer',sdp:'fixture'};}async setLocalDescription(v){this.localDescription=v;}
  async setRemoteDescription(){const c=document.createElement('canvas');c.width=c.height=32;const p=c.getContext('2d');this.timer=setInterval(()=>{p.fillRect(0,0,32,32);},40);this.audio=new AudioContext();const d=this.audio.createMediaStreamDestination();this.tracks=[...c.captureStream(25).getTracks(),...d.stream.getTracks()];this.connectionState=this.iceConnectionState='connected';this.tracks.forEach(track=>this.ontrack?.({track}));this.onconnectionstatechange?.();}
  close(){clearInterval(this.timer);this.tracks?.forEach(t=>t.stop());void this.audio?.close();this.connectionState='closed';}
 };
 window.map=(segment,ms,stamp,generation)=>window.peer.channel.onmessage?.({data:JSON.stringify({type:'frame',version:1,generation:generation||window.peer.gen,segment_id:segment,source_ms:ms,rtp_timestamp:stamp})});
}
let browser,server,vite,page,fixture;const results=[],errors=[],measurements=[];
if (require.main === module) (async()=>{
 await fs.mkdir(dir,{recursive:true});const {createServer}=await import(pathToFileURL(path.resolve('frontend/node_modules/vite/dist/node/index.js')).href);const react=(await import(pathToFileURL(path.resolve('frontend/node_modules/@vitejs/plugin-react/dist/index.js')).href)).default;
 fixture=new TourFixture();fixture.scenario=1;
 server=http.createServer((req,res)=>void fixture.handle(req,res).then(done=>{if(!done)vite.middlewares(req,res);}).catch(e=>{errors.push(e.stack);res.destroy();}));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 vite=await createServer({configFile:false,root:path.resolve(process.env.TOUR_FRONTEND_ROOT||'frontend'),plugins:[react()],cacheDir:path.join(dir,'cache'),server:{middlewareMode:true,hmr:{server},watch:null}});
 browser=await chromium.launchPersistentContext(path.join(dir,'profile'),{channel:'chrome',headless:true,args:['--autoplay-policy=no-user-gesture-required']});await browser.addInitScript(platform);page=await browser.newPage();page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:'+server.address().port);await page.getByRole('button',{name:'连接数字人',exact:true}).click();await until(()=>fixture.uploads.length===1,'welcome upload');fixture.emit(fixture.sid(1),'speech.media_started');fixture.emit(fixture.sid(1),'speech.ended');await page.getByText('欢迎语播报结束，您可以继续提问',{exact:true}).waitFor();
 const work=()=>fixture.uploads.filter(x=>!x.welcome);
 async function question(){const n=work().length;await page.locator('.preset-question').first().click();await until(()=>work().length>n,'paragraph upload');assert.equal(fixture.aligned.at(-1)?.text,texts.join(''),'one natural paragraph TTS');return work().at(-1);}
 let stamp=0xffff0000;
 async function frame(upload,ms,{late=false,generation}={}){await page.waitForFunction(()=>{const v=document.querySelector(".avatar-player video");return v&&v.readyState>=2&&!v.paused&&!v.muted;});stamp=(stamp+3600)>>>0;const st=stamp;const start=Date.now();await page.evaluate(({id,ms,st,late,generation})=>{if(!late)window.map(id,ms,st,generation);window.present(st);},{id:upload.segment_id,ms,st,late,generation});if(late){await sleep(80);await page.evaluate(({id,ms,st})=>window.map(id,ms,st),{id:upload.segment_id,ms,st});}return start;}
 async function visible(id){await until(async()=>await page.locator('.material-player [data-asset-id="'+id+'"]').isVisible(),'visible '+id);}
 async function complete(upload){fixture.emit(upload.sid,'speech.media_started');fixture.emit(upload.sid,'speech.ended');for(const ms of [0,500,1000,1500,2000]){await frame(upload,ms);await sleep(50);}await until(()=>fixture.receipts.at(-1)?.completed,'played receipt');}
 let u=await question();assert.equal(fixture.aligned.length,1);fixture.emit(u.sid,'speech.media_started');fixture.emit(u.sid,'speech.ended');
 await frame(u,0);await visible('one');await sleep(400);assert.equal(await page.locator('[data-asset-id="one"]').isVisible(),true,'buffering cannot advance by elapsed time');
 let at=await frame(u,500,{late:true});await visible('two');measurements.push(Date.now()-at);assert.ok(measurements.at(-1)<=500);
 await frame(u,1000);await visible('three');await frame(u,1500);await frame(u,2000);await until(()=>fixture.receipts.at(-1)?.completed,'complete receipt');await until(async()=>await page.locator('.material-player img').count()===0,'end clears');assert.equal(work().length,1);assert.equal(await page.evaluate(()=>window.rtcCount),1);results.push('one TTS/upload, three RTP-cued pictures, buffer freeze, late current mapping, RTP wrap, no normal reconnect');
 fixture.ids=['one','missing','three'];u=await question();await complete(u);assert.equal(fixture.receipts.at(-1).sentence_ids.length,3);results.push('404 audio sentence still contributes playback memory');
 // Hold old upload ACK: cancel may mute immediately, but cannot reset or send the next paragraph first.
 fixture.holdUploads=true;u=await question();await frame(u,0);await visible('one');const uploads=work().length,resetCount=fixture.resets.length;const before=Date.now();await page.locator('.preset-question').nth(1).click();await sleep(200);assert.equal(fixture.resets.length,resetCount);assert.equal(work().length,uploads);assert.equal(await page.locator('.material-player img').count(),0);await page.evaluate(()=>{window.peer.connectionState='disconnected';window.peer.onconnectionstatechange?.();});fixture.holdUploads=false;u.release();await until(()=>fixture.resets.length===resetCount+1 && work().length===uploads+1,'bounded reset+next upload');assert.equal(fixture.serial,1,'SID preserved');assert.equal(await page.evaluate(()=>window.rtcCount),2);measurements.push({reset_ms:Date.now()-before});const next=work().at(-1);await frame(u,500,{generation:'pc-1'});assert.equal(await page.locator('.material-player img').count(),0);await complete(next);results.push('interrupt isolates immediately, ACK barrier, bounded same-SID PC replacement, old generation rejected');
 fixture.badTimeline=true;const receiptCount=fixture.receipts.length;u=await question();fixture.emit(u.sid,'speech.media_started');fixture.emit(u.sid,'speech.ended');await frame(u,0);await sleep(100);assert.equal(await page.locator('.material-player img').count(),0);assert.equal(fixture.receipts.length,receiptCount);results.push('invalid native alignment remains single audio upload, empty and no false played receipt');
 fixture.badTimeline=false;u=await question();fixture.holdReceipts=true;await frame(u,0);await frame(u,500);await until(()=>fixture.heldReceipts.length>0,'receipt held');const questionsBefore=fixture.questions.length,invalidationsBefore=fixture.calls.filter(c=>c.path.endsWith('/invalidate')).length;const beforeReceiptSwitch=work().length;await page.locator('.preset-question').nth(1).click();await sleep(250);assert.equal(fixture.questions.length,questionsBefore,'next question waits for played receipt before selection');assert.equal(fixture.calls.filter(c=>c.path.endsWith('/invalidate')).length,invalidationsBefore,'old turn is not invalidated before played receipt');fixture.holdReceipts=false;fixture.heldReceipts.splice(0).forEach(release=>release());await until(()=>work().length>beforeReceiptSwitch,'receipt ACK releases next question');await complete(work().at(-1));results.push('slow played receipt settles before invalidation and next-case selection');
 fixture.badTimeline=false;u=await question();const beforeGap=fixture.receipts.length;fixture.emit(u.sid,'speech.media_started');await frame(u,1000);await sleep(120);assert.equal(fixture.receipts.length,beforeGap,'first mapping in middle cannot consume unheard sentences');assert.equal(await page.locator('.material-player img').count(),0);results.push('first mapped frame gap fails closed without premature case memory');
 assert.deepEqual(errors,[]);await page.getByRole('button',{name:'断开',exact:true}).click();console.log(JSON.stringify({results,measurements,aligned:fixture.aligned.length,uploads:work().length,receipts:fixture.receipts},null,2));
})().catch(e=>{console.error(e.stack);process.exitCode=1;}).finally(async()=>{await browser?.close();fixture?.dispose();await vite?.close();if(server)await new Promise(r=>server.close(r));});

module.exports = { TourFixture, platform, texts };
