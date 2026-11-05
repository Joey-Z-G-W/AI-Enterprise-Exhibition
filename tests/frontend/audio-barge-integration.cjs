// Real speech PCM -> browser MediaStream -> real MicVAD/ORT/AudioWorklet -> real App.
// Only microphone hardware, RTC peer and external HTTP services are fixtures.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { createRequire } = require('node:module');
process.chdir(path.resolve(__dirname, '../..'));
const { Fixture, platformFixture } = require('./speech-browser-integration.cjs');
const requireFrontend = createRequire(path.resolve('frontend/package.json'));
const { chromium } = requireFrontend('playwright-core');
const task = path.resolve(process.env.SPEECH_TEST_TASK_DIR || 'docs/problem/20261105-2d7782d-语音打断-起声即取消与附和误打断');
const red = process.argv.includes('--red');
const racesOnly = process.argv.includes('--races-only');
const switchExtrasOnly = process.argv.includes('--switch-extras-only');
const run = (red ? 'red-' : 'green-') + Date.now();
const evidence = path.join(task, 'evidence', 'audio-' + run);
const temp = path.join(task, 'tmp', 'audio-' + run);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 12000) {
  const end = Date.now() + timeout;
  while (!await check()) { if (Date.now() >= end) throw Error('Deadline: ' + label); await delay(25); }
}
async function bounded(promise, label, ms = 6000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(label + ' cleanup timeout')), ms); })]); }
  finally { clearTimeout(timer); }
}
// This driver supplies physical-input PCM only. It never accesses App or VAD internals.
function audioInputFixture() {
  let device;
  Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async () => {
    const context = new AudioContext({ sampleRate: 16000 });
    await context.resume();
    const destination = context.createMediaStreamDestination();
    const track = destination.stream.getAudioTracks()[0];
    const settings = track.getSettings.bind(track);
    // Hardware capability is simulated; this does not claim acoustic echo cancellation.
    track.getSettings = () => ({ ...settings(), echoCancellation: true });
    const stop = track.stop.bind(track);
    track.stop = () => { stop(); void context.close(); };
    device = { context, destination, source: null };
    return destination.stream;
  } });
  window.audioTestInput = {
    async play({ silence = false, short = false } = {}) {
      if (!device || device.context.state === 'closed') throw Error('Test input is not open');
      const pcm = await fetch('/audio-fixture.wav').then(r => r.arrayBuffer());
      let buffer = await device.context.decodeAudioData(pcm);
      if (silence) buffer = device.context.createBuffer(1, 8000, 16000);
      const source = device.context.createBufferSource(); source.buffer = buffer;
      source.connect(device.destination); device.source = source; device.startedAt = device.context.currentTime;
      source.start(0, 0, short ? .15 : buffer.duration);
      return { seconds: buffer.duration, sampleRate: buffer.sampleRate, samples: buffer.length };
    },
    stop() { device?.source?.stop(); },
    secondsPlayed() { return device ? device.context.currentTime - device.startedAt : 0; },
  };
}
class AudioFixture extends Fixture {
  constructor() { super(); this.transcripts = []; this.transcriptText = ''; this.invalidations = []; this.requests = []; this.pendingTranscripts = []; this.transcriptPlans = []; }
  dispose() { super.dispose(); for (const entry of this.pendingTranscripts) if (!entry.done) entry.res.destroy(); }
  async handle(req, res) {
    this.requests.push({ method: req.method, path: req.url, at: Date.now() });
    if (req.url.endsWith('/invalidate')) this.invalidations.push({ at: Date.now() });
    if (req.url.endsWith('/transcribe')) {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks), sid = req.url.split('/')[3];
      const start = body.indexOf(Buffer.from('RIFF'));
      const entry = { sid, bytes: body.length, wavBytes: start >= 0 ? body.readUInt32LE(start + 4) + 8 : 0, at: Date.now() };
      assert.ok(start >= 0 && entry.wavBytes >= 44 && start + entry.wavBytes <= body.length, 'STT receives a complete WAV');
      assert.equal(body.toString('ascii', start + 8, start + 16), 'WAVEfmt ');
      assert.equal(body.readUInt16LE(start + 20), 1, 'PCM format');
      assert.equal(body.readUInt16LE(start + 22), 1, 'mono microphone segment');
      assert.equal(body.readUInt32LE(start + 24), 16000, '16 kHz segment');
      assert.equal(body.readUInt16LE(start + 34), 16, '16 bit segment');
      assert.equal(body.toString('ascii', start + 36, start + 40), 'data');
      entry.format = { encoding: 'PCM', channels: 1, sampleRate: 16000, bits: 16 };
      let nonzero = 0, peak = 0;
      for (let offset = start + 44; offset + 1 < start + entry.wavBytes; offset += 2) {
        const sample = body.readInt16LE(offset); if (sample) nonzero++; peak = Math.max(peak, Math.abs(sample));
      }
      entry.nonzeroSamples = nonzero; entry.peakPCM16 = peak;
      assert.ok(nonzero > 0, 'STT receives actual speech PCM, not an empty/silent fixture');
      this.transcripts.push(entry);
      const plan = this.transcriptPlans.shift() || { text: this.transcriptText };
      const pending = { res, done: false, release: () => {
        if (pending.done || res.destroyed) return; pending.done = true;
        res.writeHead(plan.code || 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(plan.invalid ? { session_id: 'wrong-session', text: plan.text } : { session_id: sid, text: plan.text }));
      } };
      this.pendingTranscripts.push(pending); if (!plan.hold) pending.release(); return true;
    }
    return super.handle(req, res);
  }
}
let browser, vite, server, page, fixture, origin, audio;
const staticAssets = new Map();
const results = [], consoleMessages = [];
let scenarioNumber = 0;
async function scenario(name, test, { idle = false } = {}) {
  fixture = new AudioFixture();
  const owner = fixture; owner.scenario = ++scenarioNumber;
  server = http.createServer((req, res) => {
    const asset = staticAssets.get(new URL(req.url, 'http://fixture').pathname);
    if (asset) { res.writeHead(200, { 'content-type': asset.mime }); res.end(asset.bytes); return; }
    if (req.url === '/audio-fixture.wav') { res.writeHead(200, { 'content-type': 'audio/wav' }); res.end(audio); return; }
    void owner.handle(req, res).then(handled => { if (!handled) vite.middlewares(req, res); }).catch(error => { owner.errors.push(error.message); res.destroy(); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = 'http://127.0.0.1:' + server.address().port;
  page = await browser.newPage();
  await page.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
  page.on('console', message => consoleMessages.push({ level: message.type(), text: message.text(), at: Date.now() }));
  page.on('pageerror', error => owner.errors.push(error.message));
  try {
  await page.goto(origin);
  await page.getByRole('button', { name: '连接数字人', exact: true }).click();
  await page.getByRole('button', { name: '对话记录', exact: true }).click();
  await page.getByRole('status', { name: '收音状态' }).filter({ hasText: '正在持续收音。' }).waitFor({ timeout: 30000 });
  await until(() => owner.uploads.length === 1, 'welcome submitted');
  owner.emit(owner.sid(1), 'speech.media_started');
  await until(() => page.locator('video').evaluate(v => !v.muted && v.volume === 1), 'initial playback volume');
  if (idle) {
    owner.emit(owner.sid(1), 'speech.ended');
    await page.getByText('欢迎语播报结束，您可以继续提问', { exact: true }).waitFor();
  }
  await test(owner);
  assert.deepEqual(owner.errors, [], 'no browser or fixture errors');
  results.push({ name, status: 'PASS' }); console.log(JSON.stringify(results.at(-1)));
  } catch (error) {
    await fs.writeFile(path.join(evidence, 'scenario-' + owner.scenario + '-failure.html'), await page.content());
    await page.screenshot({ path: path.join(evidence, 'scenario-' + owner.scenario + '-failure.png') });
    throw error;
  } finally {
    try { await bounded(page.close(), 'page'); }
    finally { owner.dispose(); server.closeAllConnections(); await bounded(new Promise(resolve => server.close(resolve)), 'listener'); server = undefined; }
    await fs.writeFile(path.join(evidence, 'scenario-' + owner.scenario + '-boundary.json'), JSON.stringify({ name, calls: owner.calls, requests: owner.requests, transcripts: owner.transcripts, errors: owner.errors, closed: owner.closed }, null, 2));
  }
}
const volume = () => page.locator('video').evaluate(v => ({ volume: v.volume, muted: v.muted }));
async function playSpeech() {
  const input = await page.evaluate(() => window.audioTestInput.play());
  assert.ok(input.samples > 16000, 'real speech input exceeds one second'); return input;
}
async function transcribe(f, plan) {
  const previous = f.transcripts.length; f.transcriptPlans.push(plan); await playSpeech();
  await until(() => f.transcripts.length === previous + 1, 'real VAD segment reaches STT', 12000);
  return f.pendingTranscripts[previous];
}
async function restored() { await until(async () => { const state = await volume(); return state.volume === 1 && !state.muted; }, 'original audio volume restored'); }
function noReplacement(f, initial = 0) {
  assert.equal(f.closed.length, 0, 'current SID retained');
  assert.equal(f.invalidations.length, initial, 'old business retained');
  assert.equal(f.calls.filter(c => c.path.endsWith('/interrupt')).length, 0, 'no media interrupt');
  assert.equal(f.questions.length, 0, 'no business question from ignored utterance');
  assert.equal(f.serial, 1, 'no replacement SID');
}
async function finishLatest(f) {
  await until(() => f.uploads.some(x => !x.welcome && !x.demo), 'answer upload');
  const sid = f.sid(f.serial);
  f.emit(sid, 'speech.media_started'); f.emit(sid, 'speech.ended');
  await page.locator('.conversation-turn').last().getByText('回答播报结束', { exact: true }).waitFor();
}
async function suite() {
  await scenario('real PCM onset and empty transcript preserve playback', async owner => {
  const before = owner.invalidations.length;
  const pcm = await playSpeech();
  await until(async () => owner.invalidations.length > before || await page.locator('video').evaluate(v => v.muted || v.volume < 1), 'real VAD onset visible effect');
  assert.equal(owner.invalidations.length, before, 'speech onset must not invalidate current answer');
  assert.equal(owner.closed.length, 0, 'onset keeps current media session');
  assert.equal(owner.transcripts.length, 0, 'speech has not ended yet');
  assert.ok(await page.locator('video').evaluate(v => !v.muted && v.volume < 1), 'onset ducks without replacing playback');
  await until(() => owner.transcripts.length === 1, 'empty transcription', 12000);
  await restored(); noReplacement(owner, before);
  });
  if (red) throw Error('Expected onset cancellation was not reproduced');
  await scenario('silence and brief PCM do not create a speech turn', async f => {
    await page.evaluate(() => window.audioTestInput.play({ silence: true })); await delay(2200);
    await page.evaluate(() => window.audioTestInput.play({ short: true })); await delay(2200);
    await restored(); noReplacement(f); assert.equal(f.transcripts.length, 0);
  });
  await scenario('busy complete backchannels do not cancel', async f => {
    await transcribe(f, { text: '嗯' }); await restored(); noReplacement(f);
    const pending = await transcribe(f, { text: '好的', hold: true });
    f.emit(f.sid(1), 'speech.ended'); await page.getByText('欢迎语播报结束，您可以继续提问', { exact: true }).waitFor();
    pending.release(); await restored(); noReplacement(f); // Keep onset snapshot even if old speech ends before STT.
  });
  await scenario('acknowledgement prefix with question interrupts after STT', async f => {
    f.text = '新问题的完整回答。';
    const old = f.sid(1); const pending = await transcribe(f, { text: '嗯，多少钱？', hold: true });
    noReplacement(f); assert.ok((await volume()).volume <= .2);
    pending.release(); await until(() => f.questions.length === 1, 'valid question submission');
    assert.equal(f.questions[0].question, '嗯，多少钱？'); assert.equal(f.closed.length, 0);
    await until(() => f.tts.filter(t => !t.welcome).length === 1, 'new WAV prepares during old speech');
    assert.equal(f.uploads.length, 1); f.emit(old, 'speech.ended');
    await finishLatest(f); assert.equal(f.serial, 1);
  });
  await scenario('short stop command ends speech without model request', async f => {
    await transcribe(f, { text: '停' });
    await until(() => f.closed.length === 1 || f.calls.some(c => c.path.endsWith('/interrupt')), 'explicit stop effect');
    assert.equal(f.questions.length, 0);
  });
  await scenario('idle acknowledgement remains a business question', async f => {
    f.text = '为您继续介绍。'; await transcribe(f, { text: '好的' });
    await until(() => f.questions.length === 1, 'idle acknowledgement question');
    assert.equal(f.questions[0].question, '好的'); await finishLatest(f);
    assert.equal(f.closed.length, 0); assert.equal(f.serial, 1);
  }, { idle: true });
  await scenario('negated stop is a normal question', async f => {
    f.text = '继续为您介绍。'; await transcribe(f, { text: '不要停' });
    await until(() => f.questions.length === 1, 'negated stop submitted');
    assert.equal(f.questions[0].question, '不要停'); f.emit(f.sid(1), 'speech.ended'); await finishLatest(f);
  });
  await scenario('invalid STT response restores volume without replacing answer', async f => {
    await transcribe(f, { text: '无效返回', invalid: true }); await restored(); noReplacement(f);
  });
  await scenario('real 45 second STT timeout restores volume', async f => {
    await transcribe(f, { text: '迟到问题', hold: true });
    f.emit(f.sid(1), 'speech.ended'); await page.getByText('欢迎语播报结束，您可以继续提问', { exact: true }).waitFor();
    await page.getByRole('alert', { name: '语音识别资源状态' }).waitFor({ timeout: 47000 });
    assert.ok(Date.now() - f.transcripts[0].at >= 44000, 'actual STT deadline elapsed without clock substitution');
    await restored();
    noReplacement(f); f.pendingTranscripts[0].release(); await delay(100); noReplacement(f);
  });
  for (const action of ['锐伽提供哪些服务？', '新一组访客', '停止录音', '断开']) {
    await scenario('late STT isolated after ' + action, async f => {
      f.text = '预设的有效回答。';
      const pending = await transcribe(f, { text: '迟到问题不得提交', hold: true });
      await page.getByRole('button', { name: action, exact: true }).click();
      if (action === '锐伽提供哪些服务？') await until(() => f.questions.length === 1, 'preset question submitted');
      if (action === '新一组访客') await until(() => f.serial === 2, 'new visitor session');
      if (action === '停止录音') await restored();
      pending.release(); await delay(150);
      assert.equal(f.questions.length, action === '锐伽提供哪些服务？' ? 1 : 0);
      assert.ok(f.questions.every(q => q.question !== '迟到问题不得提交'));
    });
  }
  await scenario('three full audio turns with real VAD and microphone active', async f => {
    f.text = '这一轮已经回答。';
    for (let turn = 1; turn <= 3; turn++) {
      const uploads = f.uploads.length;
      await transcribe(f, { text: '第' + turn + '个真实音频问题' });
      await until(() => f.questions.length === turn && f.uploads.length > uploads, 'new turn upload');
      await finishLatest(f);
      await page.getByRole('status', { name: '收音状态' }).filter({ hasText: '正在持续收音。' }).waitFor();
    }
    assert.equal(new Set(f.questions.map(q => q.turn_id)).size, 3);
    assert.equal(f.serial, 1); assert.equal(f.closed.length, 0);
    assert.equal(await page.locator('.conversation-turn').count(), 3);
  }, { idle: true });
  await scenario('user volume changes are not overwritten by duck release', async f => {
    const pending = await transcribe(f, { text: '好的', hold: true });
    await page.locator('video').evaluate(v => { v.volume = .55; v.muted = true; });
    pending.release(); await delay(150);
    assert.deepEqual(await volume(), { volume: .55, muted: true }); noReplacement(f);
  });
  await scenario('stopping capture preserves an already submitted business answer', async f => {
    f.text = '停止录音后继续播报。'; f.holdQuestions = true;
    await transcribe(f, { text: '已提交的问题' });
    await until(() => f.questions.length === 1, 'business request submitted');
    await page.getByRole('button', { name: '停止录音', exact: true }).click();
    f.responses[0].release(); await finishLatest(f);
    assert.equal(f.questions.length, 1); assert.equal(f.closed.length, 0); assert.equal(f.serial, 1);
    assert.equal(await page.getByRole('button', { name: '停止录音', exact: true }).isDisabled(), true);
  }, { idle: true });
  await scenario('valid interruption waits for independent upload ACK', async f => {
    // Finish welcome, then hold a real answer's upload response while audio arrives.
    f.emit(f.sid(1), 'speech.ended'); await page.getByText('欢迎语播报结束，您可以继续提问', { exact: true }).waitFor();
    f.text = '原回答。'; f.holdUploads = true;
    await page.getByRole('button', { name: '锐伽提供哪些服务？', exact: true }).click();
    await until(() => f.uploads.length === 2, 'held answer upload');
    const pending = await transcribe(f, { text: '请换一个问题', hold: true }); pending.release();
    await until(() => f.questions.length === 2, 'new business prepares independently of old ACK');
    assert.equal(f.serial, 1); assert.equal(f.closed.length, 0); assert.equal(f.uploads.length, 2);
    f.holdUploads = false; f.uploads[1].release();
    await delay(100); assert.equal(f.uploads.length, 2, 'ACK alone cannot upload new answer');
    f.emit(f.sid(1), 'speech.ended'); await until(() => f.uploads.length === 3, 'new upload after both old gates');
    assert.equal((await volume()).volume, .2); await finishLatest(f); await restored();
    assert.equal(f.questions[1].question, '请换一个问题'); assert.equal(f.closed.length, 0);
  });
  await scenario('unknown old upload blocks valid interruption replacement', async f => {
    f.emit(f.sid(1), 'speech.ended'); await page.getByText('欢迎语播报结束，您可以继续提问', { exact: true }).waitFor();
    f.text = '原回答。'; f.holdUploads = true; f.failUpload = true;
    await page.getByRole('button', { name: '锐伽提供哪些服务？', exact: true }).click();
    await until(() => f.uploads.length === 2, 'held uncertain upload');
    await transcribe(f, { text: '新的问题' }); await delay(100);
    await until(() => f.questions.length === 2, 'new question before unknown ACK');
    assert.equal(f.serial, 1); assert.equal(f.closed.length, 0);
    f.uploads[1].release(); await page.getByRole('alert', { name: '媒体上传隔离' }).waitFor();
    assert.equal(f.serial, 1); assert.equal(f.questions.length, 2); assert.equal(f.closed.length, 0);
    assert.equal(f.uploads.length, 2, 'no retry or new upload');
  });
}
async function candidateRaces() {
  await scenario('candidate A release preserves candidate B duck ownership', async f => {
    const first = await transcribe(f, { text: '好的', hold: true });
    f.transcriptPlans.push({ text: '嗯', hold: true }); await playSpeech();
    await until(() => page.evaluate(() => window.audioTestInput.secondsPlayed() >= 2), 'B real speech PCM effective region');
    first.release(); await delay(150);
    assert.deepEqual(await volume(), { volume: .2, muted: false }, 'B still owns duck after ignored A returns');
    await until(() => f.transcripts.length === 2, 'B real VAD WAV reaches STT');
    assert.ok(f.transcripts[1].nonzeroSamples > 0);
    f.pendingTranscripts[1].release(); await restored(); noReplacement(f);
  });
  await scenario('candidate B survives A answer switching on the same SID', async f => {
    f.text = '完整的新回答。';
    const first = await transcribe(f, { text: '第一个有效问题', hold: true });
    f.transcriptPlans.push({ text: '第二个有效问题' }); await playSpeech();
    await until(() => page.evaluate(() => window.audioTestInput.secondsPlayed() >= 2), 'B real speech before media replacement');
    first.release();
    await until(() => f.questions.length === 1, 'A prepares answer while B speaks');
    assert.equal(f.serial, 1); assert.equal(f.closed.length, 0);
    assert.equal(f.transcripts.length, 1, 'B utterance is still in progress');
    await until(() => f.transcripts.length === 2, 'B complete WAV on retained media');
    assert.equal(f.transcripts[1].sid, f.sid(1), 'B STT uses retained SID');
    await until(() => f.questions.length === 2, 'B remains a valid subsequent question');
    assert.deepEqual(f.questions.map(q => q.question), ['第一个有效问题', '第二个有效问题']);
    await until(() => f.tts.filter(t => !t.welcome).length === 2, 'latest first WAV ready');
    assert.equal(f.uploads.length, 1); f.emit(f.sid(1), 'speech.ended');
    await until(() => f.uploads.length === 2, 'only B answer upload');
    assert.equal(f.uploads[1].marker, f.tts[2].marker); assert.equal(f.serial, 1); assert.equal(f.closed.length, 0);
    await finishLatest(f); await restored();
  });
}
async function switchAudioSuite() {
  async function kept(f, stream) {
    assert.equal(f.serial, 1); assert.equal(f.closed.length, 0);
    assert.equal(await page.evaluate(() => window.rtcTestStats.closed), 0);
    assert.ok(await page.locator('video').evaluate((v, original) => v.srcObject === original, stream));
    assert.equal(await page.locator('.stage-placeholder').count(), 0);
    assert.equal(f.calls.filter(c => c.path.endsWith('/interrupt')).length, 0);
  }
  await scenario('three preset and real PCM pairs keep one RTC and serial audio', async f => {
    const stream = await page.locator('video').evaluateHandle(v => v.srcObject);
    f.text = '本轮完整回答。';
    for (let round = 0; round < 3; round++) {
      for (const input of ['preset', 'voice']) {
        const count = f.questions.length, uploads = f.uploads.length;
        if (input === 'preset') await page.locator('.preset-question').nth(round).click();
        else await transcribe(f, { text: '第' + round + '轮真实语音问题' });
        await until(() => f.questions.length === count + 1 && f.tts.length === count + 2, 'new question and first WAV');
        assert.equal(f.uploads.length, uploads, 'old current segment must finish before next upload');
        assert.equal((await volume()).volume, .2);
        await kept(f, stream);
        f.emit(f.sid(1), 'speech.ended');
        await until(() => f.uploads.length === uploads + 1, 'strict next upload');
        assert.equal((await volume()).volume, .2, 'ACK does not restore');
        f.emit(f.sid(1), 'speech.media_started'); await restored();
        await page.getByRole('status', { name: '收音状态' }).filter({ hasText: '正在持续收音。' }).waitFor();
      }
    }
    f.emit(f.sid(1), 'speech.ended');
    await page.locator('.conversation-turn').last().getByText('回答播报结束', { exact: true }).waitFor();
    assert.equal(f.questions.length, 6); assert.equal(f.transcripts.length, 3);
    assert.equal(new Set(f.questions.map(q => q.turn_id)).size, 6); await kept(f, stream);
  });
  await scenario('STT-only preset prepares without inventing old media end', async f => {
    f.text = '预设回答。'; const stream = await page.locator('video').evaluateHandle(v => v.srcObject);
    const pending = await transcribe(f, { text: '旧识别不应提交', hold: true });
    await page.locator('.preset-question').first().click();
    await until(() => f.uploads.length === 2, 'preset uploads without old speech');
    pending.release(); await finishLatest(f); await delay(100);
    assert.equal(f.questions.length, 1); await kept(f, stream);
  }, { idle: true });
  await scenario('stopMic preserves submitted switch duck until new media_started', async f => {
    f.text = '继续播报已提交问题。';
    await page.locator('.preset-question').first().click();
    await until(() => f.tts.length === 2, 'new WAV ready');
    await page.getByRole('button', { name: '停止录音', exact: true }).click();
    assert.equal((await volume()).volume, .2);
    f.emit(f.sid(1), 'speech.ended'); await until(() => f.uploads.length === 2, 'new upload');
    assert.equal((await volume()).volume, .2); await finishLatest(f); await restored();
    assert.equal(f.closed.length, 0); assert.equal(f.serial, 1);
  });
  await scenario('new media_started releases switch only while candidate B is active', async f => {
    f.text = '切题回答。'; const first = await transcribe(f, { text: '第一个问题', hold: true });
    f.transcriptPlans.push({ text: '好的', hold: true }); await playSpeech();
    await until(() => page.evaluate(() => window.audioTestInput.secondsPlayed() >= 2), 'candidate B effective PCM');
    first.release(); await until(() => f.tts.length === 2, 'A first WAV ready');
    f.emit(f.sid(1), 'speech.ended'); await until(() => f.uploads.length === 2, 'A upload');
    f.emit(f.sid(1), 'speech.media_started'); await delay(100);
    assert.equal((await volume()).volume, .2, 'B retains duck after switch media starts');
    await until(() => f.transcripts.length === 2, 'B real WAV');
    f.pendingTranscripts[1].release(); await restored();
    assert.equal(f.questions.length, 1); f.emit(f.sid(1), 'speech.ended');
    await page.locator('.conversation-turn').last().getByText('回答播报结束', { exact: true }).waitFor();
  });
}
async function switchExitAndVolume() {
  await scenario('real short stop overrides prepared replacement while old segment drains', async f => {
    f.text = '停止后不得播报的新回答。';
    await page.locator('.preset-question').first().click();
    await until(() => f.tts.length === 2 && f.tts[1].done, 'new WAV prepared behind old segment');
    assert.equal(f.uploads.length, 1);
    await transcribe(f, { text: '停' });
    await until(() => f.closed.includes(f.sid(1)), 'explicit stop retires old media');
    await delay(150);
    assert.equal(f.questions.length, 1, 'stop must not submit a model question');
    assert.equal(f.uploads.filter(u => !u.welcome).length, 0, 'prepared replacement cannot upload after stop');
    assert.equal(f.transcripts.length, 1); assert.ok(f.transcripts[0].nonzeroSamples > 0);
  });
  await scenario('switch release preserves user volume and mute changes', async f => {
    f.text = '保留主动音量设置。';
    await page.locator('.preset-question').first().click();
    await until(() => f.tts.length === 2, 'new first WAV');
    assert.equal((await volume()).volume, .2);
    await page.locator('video').evaluate(v => { v.volume = .55; v.muted = true; });
    f.emit(f.sid(1), 'speech.ended'); await until(() => f.uploads.length === 2, 'new upload');
    assert.deepEqual(await volume(), { volume: .55, muted: true });
    f.emit(f.sid(1), 'speech.media_started'); await delay(100);
    assert.deepEqual(await volume(), { volume: .55, muted: true }, 'switch release cannot overwrite user adjustment');
    f.emit(f.sid(1), 'speech.ended');
    await page.locator('.conversation-turn').last().getByText('回答播报结束', { exact: true }).waitFor();
    assert.equal(f.closed.length, 0); assert.equal(f.serial, 1);
  });
}
(async () => {
  await fs.mkdir(evidence, { recursive: true }); await fs.mkdir(temp, { recursive: true });
  if (!process.env.AUDIO_TEST_WAV) throw Error('Set AUDIO_TEST_WAV to an existing local speech WAV; audio is never committed.');
  audio = await fs.readFile(path.resolve(process.env.AUDIO_TEST_WAV));
  assert.equal(audio.toString('ascii', 0, 4), 'RIFF'); assert.equal(audio.toString('ascii', 8, 12), 'WAVE');
  // Match production public-file serving. Vite dev transforms reject dynamic imports from public/.
  for (const [url, mime] of [
    ['/vad/silero_vad_v5.onnx', 'application/octet-stream'],
    ['/vad/vad.worklet.bundle.min.js', 'application/javascript'],
    ['/ort/ort-wasm-simd-threaded.mjs', 'application/javascript'],
    ['/ort/ort-wasm-simd-threaded.wasm', 'application/wasm'],
  ]) {
    const bytes = await fs.readFile(path.resolve('frontend/public' + url));
    staticAssets.set(url, { mime, bytes, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
  }
  const { createServer } = await import(pathToFileURL(path.resolve('frontend/node_modules/vite/dist/node/index.js')).href);
  const react = (await import(pathToFileURL(path.resolve('frontend/node_modules/@vitejs/plugin-react/dist/index.js')).href)).default;
  vite = await createServer({ configFile: false, root: path.resolve('frontend'), plugins: [react()], cacheDir: path.join(temp, 'vite-cache'), server: { middlewareMode: true, hmr: false, watch: null } });
  browser = await chromium.launchPersistentContext(path.join(temp, 'chrome-profile'), { channel: 'chrome', headless: true, timeout: 20000, args: ['--autoplay-policy=no-user-gesture-required'], env: { ...process.env, TMP: temp, TEMP: temp } });
  browser.setDefaultTimeout(12000);
  // A single script fixes device-fixture ordering; no application module is replaced.
  await browser.addInitScript({ content: '(' + platformFixture.toString() + ')();(' + audioInputFixture.toString() + ')();' });
  if (!racesOnly && !switchExtrasOnly) await suite();
  if (!red && !switchExtrasOnly) await candidateRaces();
  if (!red && !racesOnly && !switchExtrasOnly) await switchAudioSuite();
  if (!red && !racesOnly) await switchExitAndVolume();
  await fs.writeFile(path.join(evidence, 'result.json'), JSON.stringify({ status: 'PASS', results }, null, 2));
})().catch(async error => {
  const expected = red && error.code === 'ERR_ASSERTION' && ['speech onset must not invalidate current answer', 'onset keeps current media session'].some(message => error.message.includes(message));
  await fs.writeFile(path.join(evidence, 'result.json'), JSON.stringify({ status: expected ? 'EXPECTED_RED' : 'FAIL', error: error.stack, results }, null, 2));
  if (page && !page.isClosed()) { await fs.writeFile(path.join(evidence, 'failure.html'), await page.content()); await page.screenshot({ path: path.join(evidence, 'failure.png') }); }
  console.error(expected ? 'EXPECTED_RED: real PCM onset cancelled current answer before transcription' : error.stack);
  process.exitCode = expected ? 42 : 1;
}).finally(async () => {
  if (fixture) await fs.writeFile(path.join(evidence, 'boundary.json'), JSON.stringify({ calls: fixture.calls, requests: fixture.requests, transcripts: fixture.transcripts, errors: fixture.errors, console: consoleMessages,
    audio: audio ? { bytes: audio.length, sha256: crypto.createHash('sha256').update(audio).digest('hex') } : null,
    staticAssets: [...staticAssets].map(([url, asset]) => ({ url, bytes: asset.bytes.length, mime: asset.mime, sha256: asset.sha256 })) }, null, 2));
  fixture?.dispose(); if (browser) await bounded(browser.close(), 'browser', 12000); if (vite) await bounded(vite.close(), 'Vite');
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
