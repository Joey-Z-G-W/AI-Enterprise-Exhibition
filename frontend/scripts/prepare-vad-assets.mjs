import {readFile,copyFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
for(const [name,version] of [['@ricky0123/vad-web','0.0.31'],['onnxruntime-web','1.22.0']]){
 const found=JSON.parse(await readFile(path.join(root,'node_modules',name,'package.json'),'utf8')).version;
 if(found!==version)throw Error('VAD dependency version differs from verified version');
}
for(const [source,target] of [
 ['@ricky0123/vad-web/dist/vad.worklet.bundle.min.js','vad/vad.worklet.bundle.min.js'],
 ['@ricky0123/vad-web/dist/silero_vad_v5.onnx','vad/silero_vad_v5.onnx'],
 ...['ort-wasm-simd-threaded.mjs','ort-wasm-simd-threaded.wasm'].map(name=>['onnxruntime-web/dist/'+name,'ort/'+name]),
]){
 const destination=path.join(root,'public',target);await mkdir(path.dirname(destination),{recursive:true});await copyFile(path.join(root,'node_modules',source),destination);
}
console.log('Prepared verified local VAD/ORT assets');
