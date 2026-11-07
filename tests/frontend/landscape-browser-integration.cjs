// Real React, coordinator, players, API and receiver observation. Only external HTTP/SSE/RTC/device boundaries are simulated.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { pathToFileURL } = require('node:url');
const { createRequire } = require('node:module');
process.chdir(path.resolve(__dirname, '../..'));
const { chromium } = createRequire(path.resolve('frontend/package.json'))('playwright-core');
const { Fixture } = require('./speech-browser-integration.cjs');
const task = path.resolve('docs/dev/20261104-展厅导览-横屏16比9数字人与逐句资料配图');
const evidence = path.join(task, 'evidence', 'landscape-' + (process.argv.includes('--red') ? 'red-' : 'green-') + Date.now());
const temp = path.join(task, 'tmp', 'landscape-' + Date.now());
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(check, label, timeout = 8000) { const end = Date.now() + timeout; while (!await check()) { if (Date.now() > end) throw Error(label); await sleep(20); } }
const texts = ['第一句话。', '第二句话。', '第三句话。', '第四句话。', '第五句话。'];
function plan(ids = ['one', 'two', 'three', 'four', 'five']) {
  return { sentences: texts.map((text, i) => ({ id: 'sentence-' + i, text, asset_id: ids[i] })), assets: [...new Set(ids.filter(Boolean))].map(id => ({ id, kind: 'image', url: '/guide/media/' + id, mime: 'image/png', alt: id })) };
}
function wav() { const b = Buffer.alloc(44 + 16000 * 2 * 0.8); b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(b.length - 44, 40); return b; }
class LandscapeFixture extends Fixture {
  constructor() { super(); this.text = texts.join(''); this.presentation = plan(); this.media = []; this.heldMedia = []; }
  dispose() { for (const r of this.heldMedia) r.destroy(); super.dispose(); }
  async handle(req, res) {
    if (req.url.startsWith('/guide/media/')) {
      this.media.push(req.url);
      if (req.url.endsWith('slow')) { this.heldMedia.push(res); return true; }
      res.writeHead(req.url.endsWith('missing') ? 404 : 200, { 'content-type': 'image/png' }); res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5X8AAAAASUVORK5CYII=', 'base64')); return true;
    }
    if (req.url === '/guide/questions') {
      const chunks = []; for await (const c of req) chunks.push(c); const b = JSON.parse(Buffer.concat(chunks)); this.questions.push(b);
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ visitor_id: b.visitor_id, turn_id: b.turn_id, turn_seq: b.turn_seq, status: 'answer', text: this.text, sources: [], presentation: this.presentation })); return true;
    }
    if (req.url === '/opentalking/tts/preview') {
      const chunks = []; for await (const c of req) chunks.push(c); const b = JSON.parse(Buffer.concat(chunks)); this.tts.push({ text: b.text, welcome: b.text.includes('您好，欢迎来到我们的展厅！'), done: true }); res.writeHead(200, { 'content-type': 'audio/wav' }); res.end(wav()); return true;
    }
    return super.handle(req, res);
  }
}
function platform() {
  Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: () => Promise.reject(new DOMException('fixture denied', 'NotAllowedError')) });
  window.RTCPeerConnection = class {
    iceGatheringState = 'complete'; connectionState = 'new'; iceConnectionState = 'new';
    addTransceiver() {} async createOffer() { return { type: 'offer', sdp: 'fixture' }; } async setLocalDescription(v) { this.localDescription = v; }
    async setRemoteDescription() {
      const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 32; const paint = canvas.getContext('2d');
      this.timer = setInterval(() => { paint.fillStyle = '#345'; paint.fillRect(0, 0, 32, 32); }, 40);
      this.audio = new AudioContext(); const dest = this.audio.createMediaStreamDestination(); const osc = this.audio.createOscillator(); const gain = this.audio.createGain(); gain.gain.value = 0; osc.connect(gain).connect(dest); osc.start();
      window.receiverAudio = (seconds, amplitude = .2) => { gain.gain.cancelScheduledValues(this.audio.currentTime); gain.gain.setValueAtTime(amplitude, this.audio.currentTime); gain.gain.setValueAtTime(0, this.audio.currentTime + seconds); };
      this.tracks = [...canvas.captureStream(25).getTracks(), ...dest.stream.getTracks()]; this.connectionState = this.iceConnectionState = 'connected'; this.tracks.forEach(track => this.ontrack?.({ track })); this.onconnectionstatechange?.();
    }
    close() { clearInterval(this.timer); this.tracks?.forEach(t => t.stop()); void this.audio?.close(); this.connectionState = 'closed'; }
  };
}
let browser, vite, page, server, fixture;
const results = [], diagnostics = [], cueDelays = [];
const work = () => fixture.uploads.filter(x => !x.welcome);
async function question(presentation = plan()) { fixture.presentation = presentation; const start = work().length; await page.locator('.preset-question').first().click(); await until(() => work().length > start, 'first sentence upload'); return start; }
async function sentence(index, asset) {
  await until(() => work().length > index, 'sentence upload ' + index);
  fixture.emit(fixture.sid(1), 'speech.media_started');
  await sleep(80);
  const audioAt = await page.evaluate(() => { window.receiverAudio(.8); return performance.now(); });
  fixture.emit(fixture.sid(1), 'speech.ended');
  if (asset) {
    await until(async () => await page.locator('.material-player [data-asset-id="' + asset + '"]').isVisible(), 'visible material ' + asset);
    const delay = await page.evaluate(() => performance.now()) - audioAt;
    cueDelays.push({ index, asset, delay_ms: delay }); assert.ok(delay <= 500, 'simulated receiver-audio to material visible <= 500ms');
  }
  else await until(async () => await page.locator('.material-player img, .material-player video').count() === 0, 'black null material');
  await sleep(180); assert.equal(work().length, index + 1, 'SSE ended cannot replace still audible sentence');
  await sleep(820);
}
(async () => {
  await fs.mkdir(evidence, { recursive: true }); await fs.mkdir(temp, { recursive: true });
  const { createServer } = await import(pathToFileURL(path.resolve('frontend/node_modules/vite/dist/node/index.js')).href);
  const react = (await import(pathToFileURL(path.resolve('frontend/node_modules/@vitejs/plugin-react/dist/index.js')).href)).default;
  fixture = new LandscapeFixture(); fixture.scenario = 1;
  server = http.createServer((req, res) => { void fixture.handle(req, res).then(handled => { if (!handled) vite.middlewares(req, res); }).catch(e => { diagnostics.push(e.stack); res.destroy(); }); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  // Isolate Vite's development socket on this fixture's ephemeral HTTP port.
  // A shared default HMR port can otherwise reload another concurrent suite.
  vite = await createServer({ configFile: false, root: path.resolve('frontend'), plugins: [react()], cacheDir: path.join(temp, 'vite-cache'), server: { middlewareMode: true, hmr: { server }, watch: null } });
  browser = await chromium.launchPersistentContext(path.join(temp, 'profile'), { channel: 'chrome', headless: true, viewport: { width: 1280, height: 900 }, args: ['--autoplay-policy=no-user-gesture-required'], env: { ...process.env, TMP: temp, TEMP: temp } });
  await browser.addInitScript(platform); page = await browser.newPage(); page.on('pageerror', e => diagnostics.push(e.message));
  await page.goto('http://127.0.0.1:' + server.address().port, { waitUntil: 'networkidle' });
    await page.locator('.landscape-frame').waitFor();
  assert.equal(await page.locator('.landscape-frame').count(), 1, '16:9 landscape frame must exist');
  for (const [width, height] of [[1280, 900], [1920, 1080], [900, 600]]) {
    await page.setViewportSize({ width, height });
    await until(async () => { const rect = await page.locator('.landscape-frame').boundingBox(); return Math.abs(rect.width - Math.min(width, height * 16 / 9)) < 1; }, 'resize committed');
    const box = await page.locator('.landscape-frame').boundingBox(); assert.ok(Math.abs(box.width / box.height - 16 / 9) < .01);
    const avatar = await page.locator('.avatar-player').boundingBox(), material = await page.locator('.material-player').boundingBox(); assert.ok(Math.abs(material.width / avatar.width - 2) < .01);
    const controls = await page.locator('.control-bar').boundingBox(); assert.ok(controls.y + controls.height <= height + 1);
    assert.ok(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight && document.documentElement.scrollWidth <= innerWidth));
  }
  await page.setViewportSize({ width: 1280, height: 900 }); results.push('16:9 layout and persistent controls');
  await page.getByRole('button', { name: '连接数字人', exact: true }).click(); await until(() => fixture.uploads.length === 1 && fixture.sse.has(fixture.sid(1)), 'welcome');
  fixture.emit(fixture.sid(1), 'speech.media_started'); fixture.emit(fixture.sid(1), 'speech.ended');
  await page.getByText('欢迎语播报结束，您可以继续提问', { exact: true }).waitFor();
  await question(); fixture.emit(fixture.sid(1), 'speech.media_started'); await sleep(250);
  assert.equal(await page.locator('.material-player img, .material-player video').count(), 0, 'server started without receiver audio must remain black');
  for (let i = 0; i < 5; i++) await sentence(i, ['one', 'two', 'three', 'four', 'five'][i]);
  await until(async () => await page.locator('.material-player img').count() === 0, 'answer ended clears material');
  assert.deepEqual(fixture.tts.filter(t => !t.welcome).map(t => t.text), texts); results.push('five actual WAV sentences and receive-audio gated images; drain and end clear');
  let start = await question(plan(['one', 'one', null, 'missing', 'five']));
  await sentence(start, 'one'); const imageHandle = await page.locator('.material-player img').elementHandle();
  await sentence(start + 1, 'one'); assert.equal(await imageHandle.evaluate(el => el.isConnected), true, 'same asset keeps element');
  await sentence(start + 2, null); await sentence(start + 3, null); await sentence(start + 4, 'five'); results.push('same image retained; null and 404 black; audio continues');
  for (const rejected of [{ kind: 'video', mime: 'video/mp4' }, { kind: 'image', mime: 'video/webm' }]) {
    const unsupported = plan(['unsupported', null, null, null, null]); Object.assign(unsupported.assets[0], rejected);
    const closed = fixture.closed.length; start = await question(unsupported);
    await sleep(200);
    assert.equal(fixture.media.includes('/guide/media/unsupported'), false, 'unsupported material must never be requested');
    assert.equal(await page.locator('.material-player video, .material-player img').count(), 0);
    for (let i = 0; i < 2; i++) {
      await until(() => work().length > start + i, 'legacy speech survives unsupported material');
      fixture.emit(fixture.sid(1), 'speech.media_started'); fixture.emit(fixture.sid(1), 'speech.ended');
    }
    await page.getByRole('button', { name: '对话记录', exact: true }).click();
    await page.getByText('回答播报结束', { exact: true }).last().waitFor();
    await page.getByRole('button', { name: '关闭记录', exact: true }).click();
    assert.equal(fixture.closed.length, closed); assert.equal(fixture.serial, 1);
    results.push('unsupported material ' + rejected.kind + '/' + rejected.mime + ': no fetch or display, legacy speech continues');
  }
  start = await question(plan(['slow', null, null, null, null])); await until(() => fixture.heldMedia.length > 0, 'slow preload requested');
  fixture.emit(fixture.sid(1), 'speech.media_started'); await page.evaluate(() => window.receiverAudio(.8)); fixture.emit(fixture.sid(1), 'speech.ended'); await sleep(100);
  await page.locator('.preset-question').nth(1).click();
  for (const res of fixture.heldMedia) if (!res.destroyed) { res.writeHead(200, { 'content-type': 'image/png' }); res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5X8AAAAASUVORK5CYII=', 'base64')); }
  await sleep(200); assert.equal(await page.locator('.material-player img, .material-player video').count(), 0, 'cancelled late resource never paints');
  await page.getByRole('button', { name: '断开', exact: true }).click(); await until(() => fixture.closed.length === 1, 'disconnect stale preload scenario');
  await page.getByRole('button', { name: '连接数字人', exact: true }).click(); await until(() => fixture.serial === 2 && fixture.sse.has(fixture.sid(2)) && fixture.uploads.some(x => x.sid === fixture.sid(2) && x.welcome), 'reconnect welcome');
  fixture.emit(fixture.sid(2), 'speech.media_started'); fixture.emit(fixture.sid(2), 'speech.ended'); await page.getByText('欢迎语播报结束，您可以继续提问', { exact: true }).waitFor();
  results.push('new question clears immediately; late old preload cannot paint; disconnect reconnect recovers');
  const invalid = plan(); invalid.assets[0].url = 'https://invalid.example/track'; start = await question(invalid);
  fixture.emit(fixture.sid(2), 'speech.media_started'); await page.evaluate(() => window.receiverAudio(.8)); fixture.emit(fixture.sid(2), 'speech.ended');
  await sleep(200); assert.equal(await page.locator('.material-player img, .material-player video').count(), 0); results.push('invalid plan keeps material black and answer survives');
  await page.getByRole('button', { name: '断开', exact: true }).click(); await until(() => fixture.closed.length === 2, 'disconnect');
  assert.equal(await page.locator('.material-player img, .material-player video').count(), 0); results.push('disconnect clears material');
  assert.deepEqual(diagnostics, []); await page.screenshot({ path: path.join(evidence, 'layout.png') });
  for (const failure of ['unavailable', 'suspended']) {
    await page.close(); page = await browser.newPage();
    await page.addInitScript(mode => {
      const original = AudioContext.prototype.createMediaStreamSource;
      AudioContext.prototype.createMediaStreamSource = function(stream) {
        if (mode === 'unavailable') throw new DOMException('External browser AudioContext unavailable', 'NotSupportedError');
        void this.suspend(); this.resume = () => Promise.resolve(); return original.call(this, stream);
      };
    }, failure);
    await page.goto('http://127.0.0.1:' + server.address().port, { waitUntil: 'networkidle' });
    await page.locator('.landscape-frame').waitFor();
    const serial = fixture.serial + 1;
    await page.getByRole('button', { name: '连接数字人', exact: true }).click();
    await until(() => fixture.sse.has(fixture.sid(serial)) && fixture.uploads.some(x => x.sid === fixture.sid(serial) && x.welcome), 'clock fallback welcome');
    fixture.emit(fixture.sid(serial), 'speech.media_started'); fixture.emit(fixture.sid(serial), 'speech.ended');
    await page.getByText('欢迎语播报结束，您可以继续提问', { exact: true }).waitFor();
    fixture.presentation = plan(); const initial = work().length, closed = fixture.closed.length;
    await page.locator('.preset-question').first().click();
    await until(() => work().length > initial, 'clock failure must preserve answer speech: ' + failure, 12000);
    assert.equal(fixture.closed.length, closed, 'observer failure cannot close avatar');
    assert.equal(await page.locator('.material-player img, .material-player video').count(), 0);
    fixture.emit(fixture.sid(serial), 'speech.media_started'); fixture.emit(fixture.sid(serial), 'speech.ended');
    await until(() => work().length > initial + 1, 'fallback tail remains speakable');
    fixture.emit(fixture.sid(serial), 'speech.media_started'); fixture.emit(fixture.sid(serial), 'speech.ended');
    await page.getByRole('button', { name: '对话记录', exact: true }).click(); await page.getByText('回答播报结束', { exact: true }).waitFor();
    await page.getByRole('button', { name: '断开', exact: true }).click(); await until(() => fixture.closed.length === closed + 1, 'fallback scenario cleanup');
    results.push('receiver clock ' + failure + ': black materials, legacy speech continues');
  }
  for (const failure of ['low-amplitude', 'silent', 'runtime-suspend', 'long-active']) {
    await page.close(); page = await browser.newPage();
    await page.addInitScript(() => {
      const original = AudioContext.prototype.createMediaStreamSource;
      AudioContext.prototype.createMediaStreamSource = function(stream) {
        window.suspendReceiverObservation = () => this.suspend();
        return original.call(this, stream);
      };
    });
    await page.goto('http://127.0.0.1:' + server.address().port, { waitUntil: 'networkidle' });
    await page.locator('.landscape-frame').waitFor();
    const serial = fixture.serial + 1, closed = fixture.closed.length;
    await page.getByRole('button', { name: '连接数字人', exact: true }).click();
    await until(() => fixture.sse.has(fixture.sid(serial)) && fixture.uploads.some(x => x.sid === fixture.sid(serial) && x.welcome), 'runtime fallback welcome');
    fixture.emit(fixture.sid(serial), 'speech.media_started'); fixture.emit(fixture.sid(serial), 'speech.ended');
    await page.getByText('欢迎语播报结束，您可以继续提问', { exact: true }).waitFor();
    fixture.presentation = plan(); const initial = await question();
    const originalStream = await page.locator('.avatar-player video').evaluateHandle(v => v.srcObject);
    fixture.emit(fixture.sid(serial), 'speech.media_started');
    await sleep(60);
    if (failure !== 'silent') await page.evaluate(mode => window.receiverAudio(mode === 'long-active' ? 2.4 : .8, mode === 'low-amplitude' ? .001 : .2), failure);
    if (failure === 'runtime-suspend') {
      await until(async () => await page.locator('.material-player img').isVisible(), 'material before running observer suspension');
      await page.evaluate(() => window.suspendReceiverObservation());
    }
    fixture.emit(fixture.sid(serial), 'speech.ended');
    if (failure === 'long-active') {
      await sleep(1800); assert.equal(work().length, initial + 1, 'observable audio cannot be cut by fallback grace deadline');
      await until(() => work().length > initial + 1, 'long observable audio drains naturally');
      assert.equal(fixture.closed.length, closed); assert.equal(fixture.serial, serial);
      await page.getByRole('button', { name: '断开', exact: true }).click(); await until(() => fixture.closed.length === closed + 1, 'long audio cleanup');
      results.push('active receiver audio longer than fixture WAV cannot be truncated by fallback deadline'); continue;
    }
    await until(() => work().length > initial + 1, 'unobservable audio must continue after bounded fallback: ' + failure, 6000);
    assert.equal(fixture.closed.length, closed, 'unobservable receiver must not close RTC');
    assert.equal(fixture.serial, serial, 'unobservable receiver must not replace SID');
    assert.equal(await page.locator('.avatar-player video').evaluate((v, stream) => v.srcObject === stream, originalStream), true);
    assert.equal(await page.locator('.material-player img, .material-player video').count(), 0, 'unobservable receiver disables plan');
    for (let i = 1; i < 5; i++) {
      await until(() => work().length > initial + i, 'fallback sentence ' + i);
      fixture.emit(fixture.sid(serial), 'speech.media_started'); fixture.emit(fixture.sid(serial), 'speech.ended');
    }
    await page.getByRole('button', { name: '对话记录', exact: true }).click(); await page.getByText('回答播报结束', { exact: true }).waitFor();
    assert.equal(fixture.closed.length, closed); assert.equal(fixture.serial, serial);
    await page.getByRole('button', { name: '断开', exact: true }).click(); await until(() => fixture.closed.length === closed + 1, 'runtime fallback cleanup');
    results.push('receiver ' + failure + ': bounded fallback completes remaining sentences with same RTC and black material');
  }
  for (const ordering of ['audio-first-100ms', 'audio-first-200ms', 'late-700ms', 'audio-ended', 'no-audio']) {
    await page.close(); page = await browser.newPage();
    await page.goto('http://127.0.0.1:' + server.address().port, { waitUntil: 'networkidle' }); await page.locator('.landscape-frame').waitFor();
    const serial = fixture.serial + 1, closed = fixture.closed.length;
    await page.getByRole('button', { name: '连接数字人', exact: true }).click();
    await until(() => fixture.sse.has(fixture.sid(serial)) && fixture.uploads.some(x => x.sid === fixture.sid(serial) && x.welcome), 'ordering welcome');
    fixture.emit(fixture.sid(serial), 'speech.media_started'); fixture.emit(fixture.sid(serial), 'speech.ended');
    await page.getByText('欢迎语播报结束，您可以继续提问', { exact: true }).waitFor();
    const initial = await question(plan());
    const audioAt = await page.evaluate(mode => { if (mode !== 'no-audio') window.receiverAudio(mode === 'audio-ended' ? .15 : 1.2); return performance.now(); }, ordering);
    await sleep(ordering === 'late-700ms' ? 700 : ordering === 'audio-ended' ? 300 : ordering === 'audio-first-200ms' ? 200 : 100);
    assert.equal(await page.locator('.material-player img, .material-player video').count(), 0, 'audio alone cannot select material before SSE');
    fixture.emit(fixture.sid(serial), 'speech.media_started');
    if (ordering.startsWith('audio-first')) {
      await until(async () => await page.locator('.material-player [data-asset-id="one"]').isVisible(), 'audio before SSE must still cue within 500ms', 1000);
      const delay = await page.evaluate(() => performance.now()) - audioAt;
      assert.ok(delay <= 500, 'audio before SSE selects material <=500ms from actual receive activity');
      cueDelays.push({ ordering, asset: 'one', delay_ms: delay });
      await page.evaluate(() => { window.materialMutations = 0; new MutationObserver(() => window.materialMutations++).observe(document.querySelector('.material-surface'), { childList: true }); });
      for (let repeat = 0; repeat < 3; repeat++) fixture.emit(fixture.sid(serial), 'speech.media_started');
      await sleep(120); assert.equal(await page.evaluate(() => window.materialMutations), 0, 'duplicate SSE cannot repeat cue or replace material');
    } else {
      await sleep(180); assert.equal(await page.locator('.material-player img, .material-player video').count(), 0, 'late or ended or absent audio must remain black');
    }
    fixture.emit(fixture.sid(serial), 'speech.ended');
    await until(() => work().length > initial + 1, 'ordering preserves sentence drain or optional-observer fallback');
    assert.equal(fixture.serial, serial); assert.equal(fixture.closed.length, closed);
    await page.getByRole('button', { name: '断开', exact: true }).click(); await until(() => fixture.closed.length === closed + 1, 'ordering cleanup');
    results.push(ordering + ': activity and SSE converge once only inside 500ms; late or unconfirmed material stays black');
  }
  await fs.writeFile(path.join(evidence, 'result.json'), JSON.stringify({ status: 'PASS', results, diagnostics, cueDelays, simulation: 'Manufactured PCM WAV duration and independently generated sine MediaStream; no real TTS waveform or acoustic device measurement.' }, null, 2)); console.log(JSON.stringify({ status: 'PASS', results, cueDelays, evidence }));
})().catch(async error => {
  await page?.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => {});
  const red = process.argv.includes('--red') && error.message.includes('16:9 landscape frame must exist') || process.argv.includes('--clock-red') && error.message.includes('clock failure must preserve answer speech') || process.argv.includes('--runtime-clock-red') && error.message.includes('unobservable audio must continue after bounded fallback');
  await fs.writeFile(path.join(evidence, 'result.json'), JSON.stringify({ status: red ? 'EXPECTED_RED' : 'FAIL', error: error.stack, results, diagnostics }, null, 2)); console.error(error.stack); console.log(evidence); process.exitCode = red ? 42 : 1;
}).finally(async () => { fixture?.dispose(); await browser?.close(); await vite?.close(); if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)); } });
