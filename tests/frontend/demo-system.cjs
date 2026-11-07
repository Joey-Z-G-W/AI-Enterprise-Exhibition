// System test: real React UI, FastAPI, SQLite and Chromium; no application mocks.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '../..');
const { chromium } = createRequire(path.join(root, 'frontend/package.json'))('playwright-core');
const task = path.resolve(process.env.GUIDE_TEST_TASK_DIR || path.join(root, 'docs/dev/20261107-课程项目-展厅AI导览高分交付分批规划'));
const run = `demo-system-${Date.now()}`;
const tmp = path.join(task, 'tmp', run);
const evidence = path.join(task, 'evidence', run);
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
let child, browser, logs = '', base = process.env.DEMO_BASE_URL;
const external = Boolean(base);
async function freePort() { const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; }
async function ready() { for (let i = 0; i < 100; i++) { if (child && child.exitCode !== null) throw Error(`server exited: ${logs}`); try { if ((await fetch(`${base}/health`)).ok) return; } catch {} await sleep(100); } throw Error(`server readiness timeout: ${logs}`); }
async function stopServer() { if (!child || child.exitCode !== null) return; const c = child; c.kill('SIGTERM'); await Promise.race([new Promise(r => c.once('exit', r)), sleep(5000).then(() => { if (c.exitCode === null) c.kill('SIGKILL'); })]); child = undefined; }
let port;
async function startServer() {
 const python = process.env.GUIDE_PYTHON || path.join(root, '.venv/bin/python');
 child = spawn(python, ['-m', 'uvicorn', 'exhibition_guide.demo:create_demo_app', '--factory', '--host', '127.0.0.1', '--port', String(port)], { cwd: root, env: { ...process.env, PYTHONPATH: path.join(root, 'src'), GUIDE_DEMO_DB: path.join(tmp, 'guide.sqlite3'), GUIDE_STATIC_DIR: path.join(root, 'frontend/dist'), GUIDE_RELEASE_ID: 'system-test-release', GUIDE_DEMO_COOKIE_NAME: 'guide_system_test' }, stdio: ['ignore', 'pipe', 'pipe'] });
 child.stdout.on('data', x => logs += x); child.stderr.on('data', x => logs += x); await ready();
}
async function session(page) { return page.evaluate(async () => (await fetch('/api/session')).json()); }
async function chooseExample(page, label) { await page.getByRole('button', { name: label, exact: true }).click(); await page.getByRole('button', { name: 'Ask the guide', exact: true }).click(); }
(async () => {
 await fs.mkdir(tmp, { recursive: true }); await fs.mkdir(evidence, { recursive: true });
 if (!external) { port = await freePort(); base = `http://127.0.0.1:${port}`; await startServer(); } else await ready();
 browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
 const a = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
 const b = await browser.newContext({ viewport: { width: 1000, height: 900 } });
 const page = await a.newPage(); const other = await b.newPage();
 const pageErrors=[]; page.on('pageerror', e => pageErrors.push(e.message));
 await page.goto(base);
 await page.getByRole('heading', { name: 'Future Commons', exact: true }).waitFor();
 await page.getByText('No questions yet.', { exact: true }).waitFor();
 assert.match(await page.locator('body').innerText(), /not a live LLM/i);
 await page.getByRole('button', { name: 'Explore Aster Pavilion', exact: true }).click();
 await chooseExample(page, 'Supported: solar power');
 await page.locator('[data-answer-status="supported"]').first().waitFor();
 assert.match(await page.locator('[data-answer-status="supported"]').first().innerText(), /48 rooftop solar panels/);
 assert.match(await page.locator('[data-answer-status="supported"]').first().innerText(), /aster-power/);
 await page.getByRole('button', { name: 'Rate 5 out of 5', exact: true }).first().click();
 await page.getByText('Saved rating: 5/5', { exact: true }).waitFor();
 const saved = await session(page); assert.equal(saved.history.length, 1);
 await page.reload(); await page.getByText('Saved rating: 5/5', { exact: true }).waitFor();
 assert.equal((await session(page)).history[0].id, saved.history[0].id);
 await other.goto(base); await other.getByText('No questions yet.', { exact: true }).waitFor();
 const otherState = await session(other); assert.notEqual(otherState.visitor_id, saved.visitor_id);
 const denied = await other.evaluate(async id => (await fetch(`/api/questions/${id}/feedback`, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({request_id:crypto.randomUUID(),rating:1})})).status, saved.history[0].id);
 assert.equal(denied, 404); assert.equal((await session(page)).history[0].feedback, 5);
 for (const [label,status] of [['Unknown: outside the catalog','unknown'],['Ambiguous: which pavilion?','ambiguous'],['Conflicting: opening date','conflicting']]) {
  await chooseExample(page,label); await page.locator(`[data-answer-status="${status}"]`).first().waitFor();
 }
 assert.equal((await session(page)).history.length, 4);
 const retry = await page.evaluate(async () => { const body={request_id:crypto.randomUUID(),question:'How does Aster Pavilion generate power?'}; const send=async value=>{const r=await fetch('/api/questions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(value)});return {status:r.status,data:await r.json()};}; return [await send(body),await send(body),await send({...body,question:'different'})]; });
 assert.equal(retry[0].status,201); assert.equal(retry[0].data.id,retry[1].data.id); assert.equal(retry[2].status,409);
 if (!external) { await stopServer(); await startServer(); await page.reload(); await page.getByText('Saved rating: 5/5', {exact:true}).waitFor(); assert.equal((await session(page)).history.length,5); }
 await page.screenshot({ path: path.join(evidence,'sample-journey.png'), fullPage:true });
 await page.getByRole('button',{name:'Clear history',exact:true}).click();
 await page.getByRole('button',{name:'Confirm clear history',exact:true}).click();
 await page.getByText('No questions yet.',{exact:true}).waitFor();
 assert.equal((await session(page)).history.length,0);
 await chooseExample(page,'Supported: solar power'); await page.locator('[data-answer-status="supported"]').waitFor();
 const previous=(await session(page)).visitor_id;
 await page.getByRole('button',{name:'New visitor',exact:true}).click();
 await page.getByRole('button',{name:'Confirm new visitor',exact:true}).click();
 await page.getByText('No questions yet.',{exact:true}).waitFor();
 assert.notEqual((await session(page)).visitor_id,previous);
 await page.setViewportSize({width:390,height:844});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false);
 await page.screenshot({path:path.join(evidence,'mobile.png'),fullPage:true});
 assert.deepEqual(pageErrors,[]);
 const report={status:'PASS',base,mode:external?'external-deployment':'owned-local-server',checks:['real UI sample browsing','supported citation','unknown/ambiguous/conflicting','feedback save','reload persistence','independent browser visitors','cross-visitor feedback rejection','request retry idempotency/conflict','clear history','new visitor','mobile no horizontal overflow'],restartPersistence:external?'not performed here; deployment owner must verify container restart':'PASS',health:await (await fetch(`${base}/health`)).json()};
 await fs.writeFile(path.join(evidence,'result.json'),JSON.stringify(report,null,2)); console.log(JSON.stringify(report,null,2));
})().catch(async e=>{console.error(e);process.exitCode=1; if (browser) { const pages=browser.contexts().flatMap(c=>c.pages()); if(pages[0]) await pages[0].screenshot({path:path.join(evidence,'failure.png'),fullPage:true}).catch(()=>{}); }}).finally(async()=>{if(browser)await browser.close();await stopServer();await fs.writeFile(path.join(evidence,'server.log'),logs);});
