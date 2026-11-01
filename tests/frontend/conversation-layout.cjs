// Visual-only fixture renders the actual App JSX with explicit sample state.
// Handler/race behavior is covered by conversation-races.cjs, not this static page.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),http=require('node:http');
const root=process.cwd(),modules=path.join(root,'frontend/node_modules');
const ts=require(path.join(modules,'typescript')),React=require(path.join(modules,'react')),SSR=require(path.join(modules,'react-dom/server'));
const task=path.join(root,'docs/dev/20261101-展厅AI导览-实时打断问答与锐伽样例知识库');const dest=path.join(task,'tmp/task12-layout');fs.mkdirSync(dest,{recursive:true});
const fixture=Array.from({length:20},(_,i)=>({visitorId:'visual-only',turnId:'turn-'+i,input:i%2?'voice':'text',question:`隔离样例第${i+1}问：请介绍品牌设计与展厅服务。`,status:i===19?'cancelled':'completed',result:i===19?undefined:{visitor_id:'visual-only',turn_id:'turn-'+i,status:'answer',text:'此处为明确标记的布局样例文字，不是真实问答结果。用于检查中文换行、长来源和有界滚动。'.repeat(2),sources:[{excerpt:'用于布局验证的来源片段，不作为事实或知识库资料。',source:{status:'known',filename:'独立布局测试样例来源文件名用于窄屏换行验证.md'}}]},speechStatus:i===19?undefined:'播报已停止，文字保留。'}));
const hooks={...React,useRef:initial=>({current:initial}),useEffect:()=>{},useState:initial=>[Array.isArray(initial)?fixture:initial,()=>{}]};
const exported={};const code=ts.transpileModule(fs.readFileSync('frontend/src/App.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const config={exports:{}};vm.runInNewContext(ts.transpileModule(fs.readFileSync('frontend/src/presetQuestions.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,config);
vm.runInNewContext(code,{exports:exported,crypto:require('node:crypto').webcrypto,require:name=>name==='react'?hooks:name==='react/jsx-runtime'?require(path.join(modules,'react/jsx-runtime')):name==='./presetQuestions'?config.exports:{}});
const markup=SSR.renderToStaticMarkup(exported.default());const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>隔离布局样例</title><link rel="stylesheet" href="/style.css"><div style="padding:12px;background:#fee9bf;color:#443">隔离布局样例：不是实际访客对话；按钮不连接服务。20轮记录由测试显式注入。</div>${markup}</html>`;
fs.writeFileSync(path.join(dest,'page.html'),html);fs.copyFileSync('frontend/src/style.css',path.join(dest,'style.css'));
fs.writeFileSync(path.join(dest,'narrow.html'),'<!doctype html><meta charset="utf-8"><title>375px窄屏隔离布局</title><p>375px iframe：实际CSS响应布局，静态样例非真实对话。</p><iframe title="375px窄屏对话" src="/page.html#conversation-history" style="width:375px;height:740px;border:1px solid #999"></iframe>');
if(process.argv.includes('--serve'))http.createServer((req,res)=>{
 const name=({'/':'page.html','/page.html':'page.html','/narrow.html':'narrow.html','/style.css':'style.css'})[new URL(req.url,'http://localhost').pathname];
 if(!name){res.writeHead(404).end();return;}res.setHeader('content-type',name.endsWith('.css')?'text/css':'text/html; charset=utf-8');res.end(fs.readFileSync(path.join(dest,name)));
}).listen(5293,'127.0.0.1',()=>console.log(JSON.stringify({pid:process.pid,port:5293,scope:'static layout only; no API proxy'})));
else console.log(JSON.stringify({status:'generated',turns:20,directory:dest}));
