import http from 'node:http';import fs from 'node:fs/promises';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {ownedSession} from './owned-session.mjs';
import {loadConfig} from './prepare-assets.mjs';
const root=path.dirname(fileURLToPath(import.meta.url));const port=5294;
const config=await loadConfig(root);
let manifest;try{manifest=JSON.parse(await fs.readFile(path.join(root,'assets/manifest.json'),'utf8'));}catch{throw Error('请先运行 npm run prepare-assets');}
if(manifest.samples?.[0]?.voice!==config.tts_voice)throw Error('声音配置已改变，请重新运行 npm run prepare-assets');
await fs.mkdir(path.join(root,'.runtime'),{recursive:true});
const ownedPath=path.join(root,'.runtime/owned.json');
let record=null;try{record=JSON.parse(await fs.readFile(ownedPath,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
const owner=ownedSession({config,record,save:value=>fs.writeFile(ownedPath,JSON.stringify(value),'utf8')});
const types={'.html':'text/html; charset=utf-8','.js':'application/javascript','.mjs':'application/javascript','.json':'application/json','.wasm':'application/wasm','.onnx':'application/octet-stream','.wav':'audio/wav'};
const allowed=(method,p)=>method==='GET'&&p==='/sessions/webrtc/ice-config'||method==='POST'&&/^\/sessions\/sess_[a-f0-9]+\/(webrtc\/offer|speak_flashtalk_audio|interrupt)$/.test(p);
const server=http.createServer(async(req,res)=>{
 try {
  if(req.headers.host!==`127.0.0.1:${port}`&&req.headers.host!==`localhost:${port}`){res.writeHead(403).end();return;}
  const url=new URL(req.url,`http://127.0.0.1:${port}`);
  if(url.pathname.startsWith('/trial/')){
   if(req.method!=='POST'||req.headers.origin!==`http://${req.headers.host}`||url.search||!['/trial/prepare','/trial/release'].includes(url.pathname)){res.writeHead(403).end();return;}
   let text='';for await(const chunk of req){text+=chunk;if(Buffer.byteLength(text)>2048){res.writeHead(413).end();return;}}
   let input;try{input=JSON.parse(text||'{}');}catch{res.writeHead(400).end();return;}
   const prepare=url.pathname==='/trial/prepare';
   if(!input||Array.isArray(input)||typeof input!=='object'||(prepare?Object.keys(input).length!==0:Object.keys(input).length!==1||typeof input.lease!=='string'||input.lease.length>80)){res.writeHead(400).end();return;}
   try{const result=await (prepare?owner.prepare():owner.release(input.lease));res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'}).end(JSON.stringify(result));}
   catch(e){res.writeHead(e.status||503,{'content-type':'application/json','cache-control':'no-store'}).end(JSON.stringify({error:'会话准备或释放未确认，请负责人核对。'}));}return;
  }
  if(url.pathname.startsWith('/api/')){
   const p=url.pathname.slice(4);
   if(!allowed(req.method,p)||url.search){res.writeHead(403).end('Endpoint not allowed');return;}
   const sid=p.match(/^\/sessions\/(sess_[a-f0-9]+)\//)?.[1];if(sid&&!owner.owns(sid)){res.writeHead(409).end('Session is not owned by this trial');return;}
   if(req.method==='POST'&&req.headers.origin!==`http://${req.headers.host}`){res.writeHead(403).end('Same-origin required');return;}
   let size=0;const body=[];for await(const chunk of req){size+=chunk.length;if(size>16*1024*1024){res.writeHead(413).end();return;}body.push(chunk);}
   const upstream=await fetch('http://127.0.0.1:8210'+p,{method:req.method,headers:req.headers['content-type']?{'content-type':req.headers['content-type']}:{},body:req.method==='POST'?Buffer.concat(body):undefined,signal:AbortSignal.timeout(45000)});
   res.writeHead(upstream.status,{'content-type':upstream.headers.get('content-type')||'application/json','cache-control':'no-store'});res.end(Buffer.from(await upstream.arrayBuffer()));return;
  }
  if(req.method!=='GET'){res.writeHead(405).end();return;}
  const requested=decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname);
  if(!/^\/(index\.html|app\.mjs|core\.mjs|pcm-worklet\.js|criteria\.json|assets\/[\w./-]+)$/.test(requested)){res.writeHead(404).end();return;}
  const target=path.resolve(root,'.'+requested);if(!target.startsWith(root+path.sep)){res.writeHead(403).end();return;}
  res.writeHead(200,{'content-type':types[path.extname(target)]||'application/octet-stream','cache-control':'no-store','content-security-policy':"default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self'; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; object-src 'none'",'x-content-type-options':'nosniff'});res.end(await fs.readFile(target));
 }catch{if(!res.headersSent)res.writeHead(502);res.end('Local probe request failed; upstream outcome may be unknown');}
});
server.listen(port,'127.0.0.1',()=>console.log(JSON.stringify({service:'realtime-probe',pid:process.pid,port,host:'127.0.0.1',started:new Date().toISOString(),root})));
process.on('SIGINT',()=>server.close());process.on('SIGTERM',()=>server.close());
