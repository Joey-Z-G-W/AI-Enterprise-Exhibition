// Full system: React + real Python HTTP app/answer/history/knowledge/SDK/media + real MicVAD/ORT.
// Fixtures replace only external KB/LLM/STT/TTS/RTC and physical microphone/receiver input.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { createRequire } = require('node:module');
process.chdir(path.resolve(__dirname, '../..'));
const { Fixture } = require('./speech-browser-integration.cjs');
const { chromium } = createRequire(path.resolve('frontend/package.json'))('playwright-core');
const task = path.resolve(process.env.LANDSCAPE_SYSTEM_TASK || process.env.GUIDE_TEST_TASK_DIR || path.join(require('node:os').tmpdir(), 'exhibition-guide-integration'));
const run = 'landscape-system-' + (process.argv.includes('--red') ? 'red-' : 'green-') + Date.now();
const evidence = path.join(task, 'evidence', run), temp = path.join(task, 'tmp', run), mediaRoot = path.join(temp, 'media');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (!await check()) { if (Date.now() >= deadline) throw Error('Deadline: ' + label); await delay(25); }
}
function pcmWav(seconds = .8) {
  const samples = Math.round(16000 * seconds), bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) bytes.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 440 / 16000) * 6000), 44 + i * 2);
  return bytes;
}
function physicalDevices() {
  let mic, callback, stamp = 0;
  HTMLVideoElement.prototype.requestVideoFrameCallback = function(fn) { callback = fn; return ++stamp; };
  HTMLVideoElement.prototype.cancelVideoFrameCallback = function() { callback = null; };
  window.systemFrame = (segment, ms) => {
    const rtp = (++stamp * 3600) >>> 0;
    window.systemPeer.channel.onmessage?.({ data: JSON.stringify({type:'frame', version:1, generation:'system-peer', segment_id:segment, source_ms:ms, rtp_timestamp:rtp}) });
    const fn = callback; callback = null; fn?.(performance.now(), {rtpTimestamp:rtp});
  };
  Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async () => {
    const audio = new AudioContext({ sampleRate: 16000 }); await audio.resume();
    const destination = audio.createMediaStreamDestination(), track = destination.stream.getAudioTracks()[0];
    const settings = track.getSettings.bind(track), stop = track.stop.bind(track);
    track.getSettings = () => ({ ...settings(), echoCancellation: true });
    track.stop = () => { stop(); void audio.close(); };
    mic = { audio, destination };
    return destination.stream;
  } });
  window.systemMic = async () => {
    if (!mic || mic.audio.state === 'closed') throw Error('physical input is closed');
    const bytes = await fetch('/physical-input.wav').then(r => r.arrayBuffer());
    const buffer = await mic.audio.decodeAudioData(bytes), source = mic.audio.createBufferSource();
    source.buffer = buffer; source.connect(mic.destination); source.start();
    return { seconds: buffer.duration, samples: buffer.length, sampleRate: buffer.sampleRate };
  };
  window.RTCPeerConnection = class {
    iceGatheringState = 'complete'; connectionState = 'new'; iceConnectionState = 'new';
    constructor() { window.systemPeer = this; }
    createDataChannel() {
      const channel = {readyState:'open', send:()=>channel.onmessage?.({data:JSON.stringify({type:'capabilities',version:1,generation:'system-peer',clock:'rtp-video'})})};
      this.channel=channel; setTimeout(()=>channel.onopen?.(),0); return channel;
    }
    addTransceiver() {} async createOffer() { return { type: 'offer', sdp: 'external-fixture' }; }
    async setLocalDescription(offer) { this.localDescription = offer; }
    async setRemoteDescription() {
      const canvas = document.createElement('canvas'); canvas.width = 48; canvas.height = 48;
      const paint = canvas.getContext('2d'); this.timer = setInterval(() => { paint.fillStyle = '#246'; paint.fillRect(0, 0, 48, 48); }, 40);
      this.audio = new AudioContext({ sampleRate: 16000 }); await this.audio.resume();
      const destination = this.audio.createMediaStreamDestination();
      window.systemReceiver = seconds => {
        const buffer = this.audio.createBuffer(1, Math.round(seconds * 16000), 16000), values = buffer.getChannelData(0);
        for (let i = 0; i < values.length; i++) values[i] = Math.sin(i * 2 * Math.PI * 440 / 16000) * 6000 / 32768;
        const source = this.audio.createBufferSource(); source.buffer = buffer; source.connect(destination); source.start();
        return performance.now();
      };
      this.tracks = [...canvas.captureStream(25).getTracks(), ...destination.stream.getTracks()];
      this.connectionState = this.iceConnectionState = 'connected';
      this.tracks.forEach(track => this.ontrack?.({ track })); this.onconnectionstatechange?.();
    }
    close() { clearInterval(this.timer); this.tracks?.forEach(track => track.stop()); void this.audio?.close(); this.connectionState = 'closed'; }
  };
}
class ExternalMedia extends Fixture {
  constructor() { super(); this.scenario = 1; this.transcripts = []; this.transcriptPlans = []; }
  async handle(req, res) {
    if (req.url.endsWith('/transcribe')) {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks), start = body.indexOf(Buffer.from('RIFF'));
      assert.ok(start >= 0); const length = body.readUInt32LE(start + 4) + 8;
      assert.equal(body.toString('ascii', start + 8, start + 16), 'WAVEfmt ');
      assert.equal(body.readUInt16LE(start + 20), 1); assert.equal(body.readUInt16LE(start + 22), 1);
      assert.equal(body.readUInt32LE(start + 24), 16000); assert.equal(body.readUInt16LE(start + 34), 16);
      assert.ok(length > 32000 && start + length <= body.length, 'actual complete VAD speech PCM');
      let nonzero = 0; for (let offset = start + 44; offset + 1 < start + length; offset += 2) if (body.readInt16LE(offset)) nonzero++;
      assert.ok(nonzero > 16000, 'real speech waveform, not silence');
      const plan = this.transcriptPlans.shift(); assert.ok(plan, 'every external STT result is planned');
      this.transcripts.push({ text: plan, wavBytes: length, nonzeroSamples: nonzero, at: Date.now() });
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ session_id: req.url.split('/')[3], text: plan })); return true;
    }
    if (req.url === '/opentalking/tts/preview-aligned') {
      const chunks=[]; for await (const chunk of req) chunks.push(chunk);
      const body=JSON.parse(Buffer.concat(chunks));
      const sentences=body.text.match(/[^。！？]+[。！？]?/g);
      this.aligned ??= []; this.aligned.push(body.text);
      res.writeHead(200, {'content-type':'application/json'});
      res.end(JSON.stringify({audio_base64:pcmWav(sentences.length*.5).toString('base64'),duration_ms:sentences.length*500,
        timeline:sentences.map((text,i)=>({text,start_ms:i*500,end_ms:(i+1)*500}))})); return true;
    }
    if (req.url.endsWith('/webrtc/reset')) {
      for await (const chunk of req) {};
      res.writeHead(200, {'content-type':'application/json'}); res.end(JSON.stringify({status:'receiver_reset',session_id:this.sid(this.serial)})); return true;
    }
    if (req.url === '/opentalking/tts/preview') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk); const body = JSON.parse(Buffer.concat(chunks));
      const welcome = body.text.includes('您好，欢迎来到我们的展厅！'); this.tts.push({ text: body.text, welcome, done: true, at: Date.now() });
      res.writeHead(200, { 'content-type': 'audio/wav' }); res.end(pcmWav()); return true;
    }
    assert.ok(!req.url.startsWith('/guide/'), 'guide requests must reach real Python backend');
    return super.handle(req, res);
  }
}
let browser, page, vite, server, python, backend, fixture, speechInput, failNextAsset = false;
const diagnostics = [], results = [], guide = [], timings = [], staticAssets = new Map();
let pythonOutput = '';
const work = () => fixture.uploads.filter(x => !x.welcome && !x.demo);
const sid = () => fixture.sid(fixture.serial);
async function control(route, body) {
  const response = await fetch(backend + '/__test/' + route, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert.equal(response.status, 200); return response.json();
}
async function plan(text, question, history) { assert.equal((await control('plan', { text, question, history })).status, 'planned'); }
async function proxyGuide(req, res) {
  const chunks = []; for await (const chunk of req) chunks.push(chunk); const body = Buffer.concat(chunks);
  const pathname = req.url.slice('/guide'.length);
  const entry = { method: req.method, path: pathname, at: Date.now() }; if (body.length) entry.request = JSON.parse(body);
  const upstream = await fetch(backend + pathname, { method: req.method, headers: { 'content-type': req.headers['content-type'] || 'application/json', ...(req.headers.range ? { range: req.headers.range } : {}) }, ...(body.length ? { body } : {}) });
  const payload = Buffer.from(await upstream.arrayBuffer()); entry.status = upstream.status;
  if (pathname === '/questions') {
    entry.response = JSON.parse(payload);
    if (failNextAsset) { failNextAsset = false; await fs.writeFile(path.join(mediaRoot, 'broken.png'), 'asset changed after answer generation'); }
  }
  guide.push(entry);
  res.writeHead(upstream.status, Object.fromEntries([...upstream.headers].filter(([key]) => !['transfer-encoding', 'connection', 'content-encoding'].includes(key))));
  res.end(payload);
}
async function questionReady(previous) {
  await until(() => guide.filter(x => x.path === '/questions').length > previous, 'actual backend answer');
  const entry = guide.filter(x => x.path === '/questions').at(-1);
  assert.equal(entry.status, 200); assert.equal(entry.response.status, 'answer');
  assert.ok(entry.response.sources.length > 0); assert.ok(entry.response.presentation);
  assert.equal(entry.response.presentation.sentences.map(s => s.text).join(''), entry.response.text);
  return entry;
}
async function audioQuestion(text) {
  fixture.transcriptPlans.push(text); const previous = fixture.transcripts.length;
  const input = await page.evaluate(() => window.systemMic()); assert.ok(input.seconds > 1);
  await until(() => fixture.transcripts.length > previous, 'real PCM -> real VAD -> actual STT upload', 20000);
}
(async () => {
  await fs.mkdir(evidence, { recursive: true }); await fs.mkdir(mediaRoot, { recursive: true });
  speechInput = await fs.readFile(path.resolve(process.env.AUDIO_TEST_WAV || 'tests/fixtures/speech.wav'));
  for (const [url, mime] of [['/vad/silero_vad_v5.onnx', 'application/octet-stream'], ['/vad/vad.worklet.bundle.min.js', 'application/javascript'], ['/ort/ort-wasm-simd-threaded.mjs', 'application/javascript'], ['/ort/ort-wasm-simd-threaded.wasm', 'application/wasm']]) {
    const bytes = await fs.readFile(path.resolve('frontend/public' + url)); staticAssets.set(url, { bytes, mime, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
  }
  browser = await chromium.launchPersistentContext(path.join(temp, 'chrome-profile'), { channel: 'chrome', headless: true, viewport: { width: 1280, height: 900 }, args: ['--autoplay-policy=no-user-gesture-required'], env: { ...process.env, TMP: temp, TEMP: temp } });
  await browser.addInitScript(physicalDevices); page = await browser.newPage(); page.on('pageerror', error => diagnostics.push(error.message));
  page.on('console', message => {
    if (message.text().startsWith('guide_timing ')) {
      try { timings.push(JSON.parse(message.text().slice(13))); } catch (error) { diagnostics.push('Invalid public timing: ' + error.message); }
    }
  });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5X8AAAAASUVORK5CYII=', 'base64');
  const image = process.env.REAL_TEST_IMAGE ? await fs.readFile(path.resolve(process.env.REAL_TEST_IMAGE)) : png;
  const imagePath = process.env.REAL_TEST_IMAGE ? 'reviewed.jpg' : 'reviewed.png';
  const records = [];
  for (const [id, kind, relative, mime, bytes, keyword] of [['robot', 'image', imagePath, imagePath.endsWith('.jpg') ? 'image/jpeg' : 'image/png', image, '机器人'], ['broken', 'image', 'broken.png', 'image/png', png, '失效素材'], ['hall', 'image', 'hall.png', 'image/png', png, '展厅图片']]) {
    await fs.writeFile(path.join(mediaRoot, relative), bytes);
    records.push({ id, kind, relative_path: relative, mime, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), source_filename: 'opening.md', source_url: 'https://fixture.example/reviewed', alt: keyword, keywords: [keyword], reviewed: true, narrations: (id === 'robot' ? ['机器人介绍。', '机器人恢复说明。', '机器人正在介绍。', '机器人完成恢复。', '机器人继续说明。'] : id === 'broken' ? ['失效素材介绍。'] : ['展厅图片说明。']).map(text => ({ text, evidence: [text] })) });
  }
  await fs.writeFile(path.join(mediaRoot, 'manifest.json'), JSON.stringify({ assets: records }));
  const ready = path.join(temp, 'backend-ready.json');
  const pythonExecutable = process.env.GUIDE_PYTHON || path.resolve('.venv/bin/python');
  let pythonError;
  python = spawn(pythonExecutable, ['tests/landscape_system_server.py', '--media-root', mediaRoot, '--ready', ready], { env: { ...process.env, NO_PROXY: 'localhost,127.0.0.1', PYTHONIOENCODING: 'utf-8' }, stdio: ['ignore', 'pipe', 'pipe'] });
  python.on('error', error => { pythonError = error; });
  python.stdout.on('data', bytes => { pythonOutput += bytes.toString(); }); python.stderr.on('data', bytes => { pythonOutput += bytes.toString(); });
  await until(async () => { if (pythonError) throw Error('Cannot start Python; run tools/linux.sh setup or set GUIDE_PYTHON: ' + pythonError.message); if (python.exitCode !== null) throw Error('Python fixture exited: ' + pythonOutput); try { backend = JSON.parse(await fs.readFile(ready, 'utf8')).url; return (await fetch(backend + '/health')).ok; } catch { return false; } }, 'real backend startup');
  const { createServer } = await import(pathToFileURL(path.resolve('frontend/node_modules/vite/dist/node/index.js')).href);
  const react = (await import(pathToFileURL(path.resolve('frontend/node_modules/@vitejs/plugin-react/dist/index.js')).href)).default;
  vite = await createServer({ configFile: false, root: path.resolve('frontend'), plugins: [react()], cacheDir: path.join(temp, 'vite-cache'), server: { middlewareMode: true, hmr: false, watch: null } });
  fixture = new ExternalMedia();
  server = http.createServer((req, res) => { void (async () => {
    if (req.url.startsWith('/guide/')) return proxyGuide(req, res);
    if (req.url === '/physical-input.wav') { res.writeHead(200, { 'content-type': 'audio/wav' }); return res.end(speechInput); }
    const asset = staticAssets.get(new URL(req.url, 'http://fixture').pathname); if (asset) { res.writeHead(200, { 'content-type': asset.mime }); return res.end(asset.bytes); }
    if (!await fixture.handle(req, res)) vite.middlewares(req, res);
  })().catch(error => { diagnostics.push(error.stack); res.destroy(); }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  await page.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
  await page.goto(origin);
  await page.locator('.landscape-frame').waitFor({ state: 'visible' });
  assert.equal(await page.locator('.landscape-frame').count(), 1);
  await page.getByRole('button', { name: '连接数字人', exact: true }).click();
  await page.getByRole('button', { name: '对话记录', exact: true }).click();
  await page.getByRole('status', { name: '收音状态' }).filter({ hasText: '正在持续收音。' }).waitFor({ timeout: 30000 });
  await until(() => fixture.uploads.length === 1 && fixture.sse.has(sid()), 'welcome actual upload');
  fixture.emit(sid(), 'speech.media_started'); fixture.emit(sid(), 'speech.ended');
  await page.getByText('欢迎语播报结束，您可以继续提问', { exact: true }).waitFor();
  await page.getByRole('button', { name: '关闭记录', exact: true }).click();
  // Current paragraph protocol: one aligned TTS/upload, RTP-clocked image changes and actual playback receipt.
  async function frame(upload, ms, asset) {
    await page.waitForFunction(() => {const v=document.querySelector('.avatar-player video');return v&&v.readyState>=2&&!v.paused&&!v.muted;});
    await page.evaluate(({segment,ms})=>window.systemFrame(segment,ms), {segment:upload.segment_id,ms});
    if (asset) await until(async()=>await page.locator('[data-asset-id="'+asset+'"]').isVisible(), 'paragraph image '+asset);
    else await until(async()=>await page.locator('.material-player img').count()===0,'audio-only cue');
  }
  async function playParagraph(index, turnId, assets) {
    await until(()=>work().length>index,'paragraph upload');
    const upload=work()[index];
    fixture.emit(upload.sid,'speech.media_started'); fixture.emit(upload.sid,'speech.ended');
    for (let i=0;i<assets.length;i++) { await frame(upload,i*500,assets[i]); await delay(80); }
    await frame(upload,assets.length*500,null);
    await until(() => guide.some(entry =>
      entry.path.endsWith('/playback') &&
      entry.request?.turn_id === turnId &&
      entry.request.completed === true &&
      entry.status === 200
    ), 'successful playback receipt for turn ' + turnId);
  }
  await plan('机器人介绍。随后说明。展厅图片说明。', '公司提供哪些服务？', false);
  await page.locator('.preset-question').first().click();
  const first=await questionReady(0);
  assert.deepEqual(first.response.presentation.sentences.map(s=>s.asset_id),['robot',null,'hall']);
  await playParagraph(0,first.request.turn_id,['robot',null,'hall']);
  assert.equal(fixture.aligned[0],first.response.text);
  assert.equal(work().length,1,'one whole paragraph upload');
  results.push({name:'preset -> real answer/source/media -> aligned paragraph -> RTP pictures -> played receipt',status:'PASS'});

  await plan('失效素材介绍。机器人恢复说明。','请说明失效素材和机器人',true); failNextAsset=true;
  await audioQuestion('请说明失效素材和机器人');
  const second=await questionReady(1);
  assert.notEqual(second.request.turn_id, first.request.turn_id, 'each question has a distinct turn ID');
  assert.deepEqual(second.response.presentation.sentences.map(s=>s.asset_id),['broken','robot']);
  await playParagraph(1,second.request.turn_id,[null,'robot']);
  assert.ok(guide.some(x=>x.path==='/media/broken'&&x.status===404));
  assert.equal(fixture.aligned[1],second.response.text);
  assert.equal(fixture.serial,1); assert.equal(fixture.closed.length,0);
  results.push({name:'real microphone PCM/VAD -> STT -> contextual answer; failed image degrades and next image recovers',status:'PASS'});
  const providers=await control('state');
  assert.equal(providers.queries.length,2); assert.equal(providers.completions.length,3); assert.equal(providers.remaining_replies,0);
  assert.equal(fixture.transcripts.length,1);
  assert.deepEqual(diagnostics, []); assert.deepEqual(fixture.errors, []);
  await page.screenshot({ path: path.join(evidence, 'finished.png') });
  await fs.writeFile(path.join(evidence, 'provider-http.json'), JSON.stringify(providers, null, 2));
  await fs.writeFile(path.join(evidence, 'result.json'), JSON.stringify({ status: 'PASS', results, timings, actualImage: process.env.REAL_TEST_IMAGE || null,
    simulation: 'Actual React/backend/SDK/knowledge/history/catalog and real MicVAD/ORT. External providers/media peer and hardware input simulated. Receiver uses real PCM MediaStream; no app/VAD internal event triggered. No acoustic/device latency claim.' }, null, 2));
  console.log(JSON.stringify({ status: 'PASS', results, evidence }));
})().catch(async error => {
  let browserSnapshot;
  if (page && !page.isClosed()) {
    browserSnapshot = await page.evaluate(() => ({ at_ms: performance.now(), status: document.querySelector('.control-status')?.textContent,
      media: [...document.querySelectorAll('video,img')].map(element => ({ tag: element.tagName, asset: element.dataset.assetId, src: element.currentSrc, readyState: element.readyState, paused: element.paused, muted: element.muted, volume: element.volume, error: element.error?.code, naturalWidth: element.naturalWidth })),
      resources: performance.getEntriesByType('resource').filter(entry => entry.name.includes('/guide/media/')).map(entry => ({ name: entry.name, startTime: entry.startTime, duration: entry.duration, transferSize: entry.transferSize })) })).catch(() => null);
    await page.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => {}); await fs.writeFile(path.join(evidence, 'failure.html'), await page.content()).catch(() => {});
  }
  await fs.writeFile(path.join(evidence, 'result.json'), JSON.stringify({ status: 'FAIL', error: error.stack, results, diagnostics, timings, browserSnapshot, pythonOutput }, null, 2));
  console.error(error.stack); console.log(evidence); process.exitCode = 1;
}).finally(async () => {
  if (backend) await fs.writeFile(path.join(evidence, 'provider-final.json'), JSON.stringify(await control('state').catch(() => null), null, 2));
  await fs.writeFile(path.join(evidence, 'boundary.json'), JSON.stringify({ guide, timings, transcripts: fixture?.transcripts, tts: fixture?.tts.map(({ text, welcome }) => ({ text, welcome })), uploads: fixture?.uploads.map(({ sid, welcome, marker }) => ({ sid, welcome, marker })), diagnostics, pythonOutput,
    audio: speechInput ? { bytes: speechInput.length, sha256: crypto.createHash('sha256').update(speechInput).digest('hex') } : null,
    vad: [...staticAssets].map(([url, asset]) => ({ url, bytes: asset.bytes.length, sha256: asset.sha256 })) }, null, 2));
  fixture?.dispose(); await browser?.close(); await vite?.close();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  if (backend) await control('shutdown', {}).catch(() => {});
  if (python?.pid && python.exitCode === null) { await Promise.race([new Promise(resolve => python.once('exit', resolve)), delay(5000)]); if (python.exitCode === null) python.kill(); }
});
