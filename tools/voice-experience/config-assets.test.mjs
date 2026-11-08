// Run the unchanged asset CLI and HTTP server in an isolated temporary deployment.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const root=path.dirname(fileURLToPath(import.meta.url));
async function fixture(t) {
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'voice-contract-'));
 t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 for(const name of ['prepare-assets.mjs','server.mjs','owned-session.mjs','core.mjs','criteria.json','index.html','app.mjs','pcm-worklet.js']) await fs.copyFile(path.join(root,name),path.join(dir,name));
 const config={avatar_id:'fixture-avatar',tts_voice:'zh-CN-YunyangNeural',sample_wav:'sample.wav'};
 await fs.writeFile(path.join(dir,'local.json'),JSON.stringify(config));
 const wav=Buffer.alloc(48);wav.write('RIFF');wav.write('WAVE',8);await fs.writeFile(path.join(dir,'sample.wav'),wav);
 const files=['@ricky0123/vad-web/dist/bundle.min.js','@ricky0123/vad-web/dist/vad.worklet.bundle.min.js','@ricky0123/vad-web/dist/silero_vad_v5.onnx',...['ort.wasm.min.js','ort-wasm-simd-threaded.mjs','ort-wasm-simd-threaded.wasm'].map(n=>'onnxruntime-web/dist/'+n)];
 for(const name of files){const target=path.join(dir,'node_modules',name);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,'external-package-fixture:'+name);}
 for(const [name,version] of [['@ricky0123/vad-web','0.0.31'],['onnxruntime-web','1.22.0']])await fs.writeFile(path.join(dir,'node_modules',name,'package.json'),JSON.stringify({version}));
 return {dir,config,run:()=>spawnSync(process.execPath,[path.join(dir,'prepare-assets.mjs')],{encoding:'utf8',timeout:10000})};
}
test('asset CLI validates configuration and copies declared package/audio bytes',async t=>{
 const {dir,config,run}=await fixture(t);
 assert.equal(run().status,0);
 const manifest=JSON.parse(await fs.readFile(path.join(dir,'assets/manifest.json')));
 assert.equal(manifest.assets.length,6);assert.equal(manifest.samples.length,1);
 for(const row of [...manifest.assets,...manifest.samples]){
  const bytes=await fs.readFile(path.join(dir,row.path));assert.equal(createHash('sha256').update(bytes).digest('hex'),row.sha256);assert.equal(bytes.length,row.bytes);
 }
 assert.deepEqual(await fs.readFile(path.join(dir,'sample.wav')),await fs.readFile(path.join(dir,'assets/audio/A.wav')));
 assert.doesNotMatch(JSON.stringify(manifest),/fixture-avatar|sample_wav/);
 for(const value of [{...config,avatar_id:''},{...config,base_url:'https://example.invalid/private'},{...config,sample_wav:'missing.wav'}]){
  await fs.writeFile(path.join(dir,'local.json'),JSON.stringify(value));const failed=run();assert.notEqual(failed.status,0);assert.doesNotMatch(failed.stderr,/example.invalid|private/);
 }
 await fs.writeFile(path.join(dir,'local.json'),JSON.stringify(config));
 await fs.writeFile(path.join(dir,'node_modules/onnxruntime-web/package.json'),JSON.stringify({version:'0.0.0'}));assert.notEqual(run().status,0);
 await fs.unlink(path.join(dir,'local.json'));assert.notEqual(run().status,0);
});
test('real server HTTP hides private files and rejects foreign sessions and malformed ownership requests',async t=>{
 const {dir,run}=await fixture(t);assert.equal(run().status,0);
 const child=spawn(process.execPath,[path.join(dir,'server.mjs')],{stdio:['ignore','pipe','pipe']});
 let logs='';child.stderr.on('data',b=>logs+=b);
 t.after(async()=>{if(child.exitCode===null){child.kill();await new Promise(resolve=>child.once('exit',resolve));}});
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('server startup timeout '+logs)),5000);child.stdout.once('data',()=>{clearTimeout(timer);resolve();});child.once('exit',code=>{clearTimeout(timer);reject(Error('isolated server failed to bind 5294: '+code+' '+logs));});});
 const request=(url,method='GET',body,origin='http://127.0.0.1:5294')=>fetch('http://127.0.0.1:5294'+url,{method,body,headers:{origin},signal:AbortSignal.timeout(3000)});
 assert.equal((await request('/')).status,200);
 for(const url of ['/local.json','/.runtime/owned.json','/config.example.json','/prepare-assets.mjs'])assert.equal((await request(url)).status,404);
 assert.equal((await request('/api/health')).status,403);
 assert.equal((await request('/api/sessions/sess_abc123/interrupt','POST','{}')).status,409);
 assert.equal((await request('/trial/prepare','POST','{}','http://example.invalid')).status,403);
 assert.equal((await request('/trial/prepare','POST','{"avatar_id":"other"}')).status,400);
 assert.equal((await request('/trial/release','POST','{"lease":"x","sid":"sess_abc123"}')).status,400);
});
