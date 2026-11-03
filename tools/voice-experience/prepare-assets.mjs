import {readFile,writeFile,mkdir,copyFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

export const assetFiles=[
 ['@ricky0123/vad-web/dist/bundle.min.js','vad/bundle.min.js'],
 ['@ricky0123/vad-web/dist/vad.worklet.bundle.min.js','vad/vad.worklet.bundle.min.js'],
 ['@ricky0123/vad-web/dist/silero_vad_v5.onnx','vad/silero_vad_v5.onnx'],
 ...['ort.wasm.min.js','ort-wasm-simd-threaded.mjs','ort-wasm-simd-threaded.wasm'].map(name=>['onnxruntime-web/dist/'+name,'ort/'+name]),
];
const versions={'@ricky0123/vad-web':'0.0.31','onnxruntime-web':'1.22.0'};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function loadConfig(root){
 let config;
 try{config=JSON.parse(await readFile(path.join(root,'local.json'),'utf8'));}
 catch{throw Error('缺少或无法读取 local.json；请参照 config.example.json 配置本机头像、声音和 WAV 路径。');}
 if(!config||typeof config!=='object'||Array.isArray(config)||Object.keys(config).sort().join(',')!=='avatar_id,sample_wav,tts_voice'
  ||typeof config.avatar_id!=='string'||!/^[-A-Za-z0-9_]{1,128}$/.test(config.avatar_id)
  ||typeof config.tts_voice!=='string'||!/^[-A-Za-z0-9]{1,128}$/.test(config.tts_voice)
  ||typeof config.sample_wav!=='string'||!config.sample_wav.trim()||config.sample_wav!==config.sample_wav.trim()||!config.sample_wav.toLowerCase().endsWith('.wav'))
  throw Error('local.json 必须显式填写有效 avatar_id、tts_voice、sample_wav；不支持额外配置项。');
 return Object.freeze(config);
}
export async function prepareAssets(root,dependencies=path.join(root,'node_modules')){
 const config=await loadConfig(root);
 for(const [name,version] of Object.entries(versions)){
  let found;try{found=JSON.parse(await readFile(path.join(dependencies,name,'package.json'),'utf8')).version;}catch{throw Error('缺少锁定 VAD/ORT 包；请先 npm ci 或指定已有 node_modules 目录。');}
  if(found!==version)throw Error('VAD/ORT 版本不匹配，请按 package-lock.json 准备依赖。');
 }
 let audio;try{audio=await readFile(path.resolve(root,config.sample_wav));}catch{throw Error('无法读取本机 sample_wav；不会自动生成或请求 TTS。');}
 if(audio.length<44||audio.toString('ascii',0,4)!=='RIFF'||audio.toString('ascii',8,12)!=='WAVE')throw Error('sample_wav 必须是 WAV 文件。');
 const rows=[];
 for(const [source,target] of assetFiles){
  const dest=path.join(root,'assets',target);await mkdir(path.dirname(dest),{recursive:true});await copyFile(path.join(dependencies,source),dest);
  const raw=await readFile(dest);rows.push({path:'assets/'+target,bytes:raw.length,sha256:hash(raw)});
 }
 await mkdir(path.join(root,'assets/audio'),{recursive:true});await writeFile(path.join(root,'assets/audio/A.wav'),audio);
 const manifest={packages:versions,assets:rows,samples:[{id:'A',path:'assets/audio/A.wav',voice:config.tts_voice,sha256:hash(audio),bytes:audio.length}],criteria_sha256:hash(await readFile(path.join(root,'criteria.json')))};
 await writeFile(path.join(root,'assets/manifest.json'),JSON.stringify(manifest,null,2)+'\n');return manifest;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const root=path.dirname(fileURLToPath(import.meta.url));
 try{const result=await prepareAssets(root,process.argv[2]?path.resolve(process.argv[2]):undefined);console.log(JSON.stringify({status:'prepared',assets:result.assets.length,samples:result.samples.length}));}
 catch(error){console.error(error.message);process.exitCode=1;}
}
