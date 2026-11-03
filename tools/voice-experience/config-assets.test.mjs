import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {loadConfig,prepareAssets,assetFiles} from './prepare-assets.mjs';
import {sessionConfig} from './owned-session.mjs';
import {wav} from './core.mjs';
const root=path.dirname(fileURLToPath(import.meta.url));
async function fixture(){
 const artifacts=path.join(root,'.runtime');await fs.mkdir(artifacts,{recursive:true});const dir=await fs.mkdtemp(path.join(artifacts,'assets-test-'));
 const config={avatar_id:'fixture-avatar',tts_voice:'zh-CN-YunyangNeural',sample_wav:'sample.wav'};
 await fs.writeFile(path.join(dir,'local.json'),JSON.stringify(config));await fs.writeFile(path.join(dir,'sample.wav'),Buffer.from(wav([new Float32Array([.1,.2])],16000)));await fs.copyFile(path.join(root,'criteria.json'),path.join(dir,'criteria.json'));
 for(const [source] of assetFiles){const target=path.join(dir,'node_modules',source);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,'controlled asset fixture '+source);}
 for(const [name,version] of [['@ricky0123/vad-web','0.0.31'],['onnxruntime-web','1.22.0']])await fs.writeFile(path.join(dir,'node_modules',name,'package.json'),JSON.stringify({version}));
 return {dir,config};
}
test('config missing, empty placeholders and extra upstream config fail closed',async()=>{
 const {dir,config}=await fixture();await fs.unlink(path.join(dir,'local.json'));await assert.rejects(loadConfig(dir),/local.json/);
 for(const value of [{...config,avatar_id:''},{...config,tts_voice:''},{...config,sample_wav:''},{...config,base_url:'https://example.invalid/private'}]){
  await fs.writeFile(path.join(dir,'local.json'),JSON.stringify(value));await assert.rejects(loadConfig(dir),e=>!/example.invalid|private/.test(e.message));
 }
 assert.throws(()=>sessionConfig({}),/local.json/);
});
test('asset preparation copies pinned package bytes and local WAV without network',async()=>{
 const {dir,config}=await fixture();const loaded=await loadConfig(dir);assert.deepEqual(loaded,config);
 const manifest=await prepareAssets(dir);assert.equal(manifest.assets.length,6);assert.equal(manifest.samples.length,1);
 for(const row of [...manifest.assets,...manifest.samples]){
  const bytes=await fs.readFile(path.join(dir,row.path));assert.equal(createHash('sha256').update(bytes).digest('hex'),row.sha256);assert.equal(bytes.length,row.bytes);
 }
 assert.doesNotMatch(JSON.stringify(manifest),/fixture-avatar|sample_wav|assets-test-/);
 assert.deepEqual(await fs.readFile(path.join(dir,'sample.wav')),await fs.readFile(path.join(dir,'assets/audio/A.wav')));
 const fixed=sessionConfig(loaded);assert.equal(fixed.avatar_id,config.avatar_id);assert.equal(fixed.agent_enabled,false);assert.equal(fixed.memory_enabled,false);assert.equal(fixed.knowledge_enabled,false);
});
test('wrong dependency version and unreadable audio reject rather than generate substitutes',async()=>{
 const {dir,config}=await fixture();await fs.writeFile(path.join(dir,'node_modules/onnxruntime-web/package.json'),JSON.stringify({version:'0.0.0'}));await assert.rejects(prepareAssets(dir),/版本/);
 await fs.writeFile(path.join(dir,'node_modules/onnxruntime-web/package.json'),JSON.stringify({version:'1.22.0'}));await fs.writeFile(path.join(dir,'local.json'),JSON.stringify({...config,sample_wav:'missing.wav'}));await assert.rejects(prepareAssets(dir),/不会自动/);
});
import vm from 'node:vm';
test('actual server handler hides local config/runtime and rejects arbitrary proxy/config/foreign SID',async()=>{
 let handler,ownerCalls=0;
 const source=(await fs.readFile(new URL('./server.mjs',import.meta.url),'utf8')).split('\n').filter(line=>!line.startsWith('import ')).join('\n').replace('fileURLToPath(import.meta.url)',JSON.stringify(path.join(root,'server.mjs')));
 const fakeOwner={owns:()=>false,prepare:()=>{ownerCalls++;throw Error('must not prepare');},release:()=>{ownerCalls++;throw Error('must not release');}};
 await new vm.Script(`(async()=>{${source}})()`).runInNewContext({path,URL,Buffer,console,loadConfig:async()=>({tts_voice:'zh-CN-YunyangNeural'}),ownedSession:()=>fakeOwner,fs:{mkdir:async()=>{},readFile:async p=>p.endsWith('manifest.json')?JSON.stringify({samples:[{voice:'zh-CN-YunyangNeural'}]}):'null'},http:{createServer(fn){handler=fn;return {listen(){},close(){}};}},process:{on(){}}});
 async function request(url,method='GET',body='',origin='http://127.0.0.1:5294'){
  let status;const req={url,method,headers:{host:'127.0.0.1:5294',origin},async *[Symbol.asyncIterator](){if(body)yield Buffer.from(body);}};
  const res={headersSent:false,writeHead(code){status=code;this.headersSent=true;return this;},end(){}};await handler(req,res);return status;
 }
 for(const url of ['/local.json','/.runtime/owned.json','/config.example.json','/prepare-assets.mjs'])assert.equal(await request(url),404);
 assert.equal(await request('/api/health'),403);assert.equal(await request('/api/sessions/sess_abc123/interrupt','POST','{}'),409);
 assert.equal(await request('/trial/prepare','POST','{}','http://example.invalid'),403);
 assert.equal(await request('/trial/prepare','POST','{"avatar_id":"other"}'),400);
 assert.equal(await request('/trial/release','POST','{"lease":"x","sid":"sess_abc123"}'),400);assert.equal(ownerCalls,0);
});
