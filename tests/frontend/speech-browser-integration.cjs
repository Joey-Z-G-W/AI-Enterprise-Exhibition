// Browser integration: real React/main/App/api and internal modules; only external HTTP/SSE/RTC/device boundaries are simulated.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
process.chdir(path.resolve(__dirname, '../..'));
const http = require('node:http');
const { pathToFileURL } = require('node:url');
const { createRequire } = require('node:module');
const requireFrontend = createRequire(path.resolve('frontend/package.json'));
const { chromium } = requireFrontend('playwright-core');
const task = path.resolve(process.env.SPEECH_TEST_TASK_DIR || 'docs/problem/20261104-1b5ff5a-导览播报-文字出现后出声延迟且回答冗长');
const red = process.argv.includes('--red');
const runId = (red ? 'red-' : 'green-') + Date.now();
const evidence = path.join(task, 'evidence', 'browser-' + runId);
const temp = path.join(task, 'tmp', 'browser-' + runId);
const Q = '锐伽提供哪些服务？';
const first = '这是第一句完整结论。';
const second = '后续说明保持原文。'.repeat(12);
const answer = first + second;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 6000) {
  const deadline = Date.now() + timeout;
  while (!await check()) { if (Date.now() >= deadline) throw Error('Deadline: ' + label); await sleep(20); }
}
function wav() {
  const b = Buffer.alloc(44 + 320);
  b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(320, 40); return b;
}
class Fixture {
  constructor() { this.calls = []; this.sessions = new Map(); this.sse = new Map(); this.tts = []; this.uploads = []; this.questions = []; this.closed = []; this.errors = []; this.serial = 0; this.text = answer; this.status = 'answer'; this.holdTTS = new Set(); this.holdUploads = false; this.responses = []; }
  emit(sid, event) { const stream = this.sse.get(sid); assert.ok(stream, 'SSE connected'); stream.write('event: ' + event + '\ndata: ' + JSON.stringify({ session_id: sid }) + '\n\n'); }
  sid(index) { return 'fixture-' + this.scenario + '-session-' + index; }
  dispose() { for (const s of this.sse.values()) s.end(); for (const r of [...this.tts, ...this.uploads, ...this.responses]) if (!r.done) r.res.destroy(); }
  async handle(req, res) {
    const url = new URL(req.url, 'http://fixture'), pathname = url.pathname;
    if (!pathname.startsWith('/guide/') && !pathname.startsWith('/opentalking/')) return false;
    const chunks = []; for await (const chunk of req) chunks.push(chunk); const body = Buffer.concat(chunks);
    const call = { scenario: this.scenario, method: req.method, path: pathname, sid: pathname.match(/\/sessions\/([^/]+)/)?.[1] || null, at: Date.now() }; this.calls.push(call);
    const json = (data, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (pathname === '/guide/ui-config') { json({ avatar_id: 'fixture-avatar', tts_voice: 'fixture-voice' }); return true; }
    if (pathname.includes('/visitors/') && pathname.endsWith('/invalidate')) { const b = JSON.parse(body); json({ visitor_id: decodeURIComponent(pathname.split('/')[3]), cancelled_through: b.through_turn_seq, retired: !!b.retire }); return true; }
    if (pathname === '/guide/questions') {
      const b = JSON.parse(body); this.questions.push(b);
      const payload = { visitor_id: b.visitor_id, turn_id: this.badIdentity ? 'wrong-turn' : b.turn_id, turn_seq: b.turn_seq, status: this.status, text: this.text, sources: this.sources || [] };
      const entry = { res, done: false, release: () => { if (entry.done || res.destroyed) return; entry.done = true; json(payload, payload.status === 'error' ? 503 : 200); } };
      this.responses.push(entry); if (!this.holdQuestions) entry.release(); return true;
    }
    if (pathname === '/opentalking/tts/preview') {
      const b = JSON.parse(body), welcome = b.text.includes('欢迎来到锐伽展厅'), demo = b.text.includes('这是一段固定文本演示');
      const entry = { text: b.text, voice: b.voice, welcome, demo, res, done: false, release: () => { if (entry.done || res.destroyed) return; entry.done = true; res.writeHead(this.failTTS && !welcome ? 503 : 200, { 'content-type': 'audio/wav' }); res.end(wav()); } };
      this.tts.push(entry);
      const index = this.tts.filter(x => !x.welcome && !x.demo).length - 1;
      if (welcome ? !this.holdWelcomeTTS : demo || !this.holdTTS.has(index)) entry.release(); return true;
    }
    if (pathname === '/opentalking/sessions/webrtc/ice-config') { json({ iceServers: [] }); return true; }
    if (pathname === '/opentalking/sessions' && req.method === 'POST') {
      const sid = this.sid(++this.serial); this.sessions.set(sid, 'ready'); json({ session_id: sid }); return true;
    }
    const m = pathname.match(/^\/opentalking\/sessions\/([^/]+)(.*)$/);
    if (m) {
      const [, sid, suffix] = m;
      if (suffix === '/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.write('event: ping\ndata: {}\n\n'); this.sse.set(sid, res); return true;
      }
      if (suffix === '/webrtc/offer') { json({ type: 'answer', sdp: 'fixture-sdp' }); return true; }
      if (suffix === '/start' || suffix === '/interrupt') { json({ status: 'ok' }); return true; }
      if (suffix === '/speak_flashtalk_audio') {
        const welcome = body.includes(Buffer.from('welcome.wav')), demo = body.includes(Buffer.from('fixed-demo.wav'));
        const entry = { sid, welcome, demo, res, done: false, release: () => { if (entry.done || res.destroyed) return; entry.done = true; json({ session_id: sid, status: 'queued' }, this.failUpload && !welcome ? 502 : 200); } };
        this.uploads.push(entry); if (welcome ? !this.holdWelcomeUpload : demo || !this.holdUploads) entry.release(); return true;
      }
      if (!suffix && req.method === 'DELETE') { this.closed.push(sid); this.sessions.set(sid, 'closed'); json({ status: 'closed' }); return true; }
      if (!suffix && req.method === 'GET') { json({ session_id: sid, state: this.sessions.get(sid) || 'closed' }); return true; }
    }
    this.errors.push(call); json({ error: 'unhandled external fixture request' }, 501); return true;
  }
}
function platformFixture() {
  // Browser infrastructure is outside the assembled application. No internal application module is replaced.
  Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: () => Promise.reject(new DOMException('Integration microphone denied', 'NotAllowedError')) });
  window.RTCPeerConnection = class {
    iceGatheringState = 'complete'; connectionState = 'new'; iceConnectionState = 'new';
    addTransceiver() {}
    async createOffer() { return { type: 'offer', sdp: 'fixture-offer' }; }
    async setLocalDescription(offer) { this.localDescription = offer; }
    async setRemoteDescription() {
      const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 32;
      const painter = canvas.getContext('2d'); let n = 0;
      this.timer = setInterval(() => { painter.fillStyle = n++ % 2 ? '#254' : '#365'; painter.fillRect(0, 0, 32, 32); }, 40);
      this.audio = new AudioContext(); const dest = this.audio.createMediaStreamDestination();
      this.tracks = [...canvas.captureStream(25).getTracks(), ...dest.stream.getTracks()];
      this.connectionState = 'connected'; this.iceConnectionState = 'connected';
      for (const track of this.tracks) this.ontrack?.({ track });
      this.onconnectionstatechange?.();
    }
    close() { clearInterval(this.timer); this.tracks?.forEach(t => t.stop()); void this.audio?.close(); this.connectionState = 'closed'; }
  };
}
let context, vite, server, fixture, page, origin, scenarioNumber = 0;
const results = [], diagnostics = [];
const workUploads = f => f.uploads.filter(x => !x.welcome && !x.demo);
const workTTS = f => f.tts.filter(x => !x.welcome && !x.demo);
async function scenario(name, fn, options = {}) {
  const owner = new Fixture(); owner.scenario = ++scenarioNumber;
  fixture = owner; Object.assign(owner, options.fixture);
  // Every request, including a late cleanup, is owned by this immutable fixture.
  const listener = http.createServer((req, res) => { void (async () => { if (!await owner.handle(req, res)) vite.middlewares(req, res); })().catch(e => { owner.errors.push({ error: e.message }); res.destroy(); }); });
  server = listener;
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve)); origin = 'http://127.0.0.1:' + listener.address().port;
  try {
  page = await context.newPage(); const timing = [];
  page.on('console', m => { if (m.text().startsWith('guide_timing ')) timing.push(JSON.parse(m.text().slice(13))); });
  page.on('pageerror', e => diagnostics.push({ scenario: name, error: e.message }));
  await page.goto(origin); await page.getByRole('button', { name: '连接数字人', exact: true }).click();
  await until(() => owner.serial === 1 && owner.tts.some(x => x.welcome), 'welcome TTS');
  const sid = owner.sid(1);
  await until(() => owner.sse.has(sid), 'SSE subscription');
  if (!options.keepWelcome) await finishWelcome(owner, sid);
  await fn(owner, sid, timing);
  assert.equal(owner.errors.length, 0, 'no unhandled external request');
  assert.equal(diagnostics.length, 0, 'no browser errors');
  results.push({ name, status: 'passed' }); console.log(JSON.stringify(results.at(-1)));
  } catch (error) {
    if (page && !page.isClosed()) {
      await fs.writeFile(path.join(evidence, 'scenario-' + owner.scenario + '-failure.html'), await page.content());
      await page.screenshot({ path: path.join(evidence, 'scenario-' + owner.scenario + '-failure.png') });
    }
    throw error;
  } finally {
    let timer;
    try { if (page) await Promise.race([page.close(), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Page cleanup exceeded 6000ms')), 6000); })]); }
    finally {
      clearTimeout(timer); owner.dispose(); listener.closeAllConnections();
      try { await Promise.race([new Promise(resolve => listener.close(resolve)), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Listener cleanup exceeded 6000ms')), 6000); })]); }
      finally { clearTimeout(timer); }
      await fs.writeFile(path.join(evidence, 'scenario-' + owner.scenario + '-boundary.json'), JSON.stringify({ name, scenario: owner.scenario, calls: owner.calls, closed: owner.closed, errors: owner.errors }, null, 2));
      server = undefined;
    }
  }
}
async function finishWelcome(f, sid) {
  await until(() => f.uploads.some(x => x.welcome && x.sid === sid), 'welcome upload');
  f.emit(sid, 'speech.media_started'); f.emit(sid, 'speech.ended');
  await page.getByText('欢迎语播报结束，您可以继续提问', { exact: true }).waitFor();
}
async function finishAnswer(f, sid, start = 0) {
  let index = start;
  while (index < start + 8) {
    await until(() => workUploads(f).length > index, 'answer segment upload');
    workUploads(f)[index].release(); f.emit(sid, 'speech.media_started'); f.emit(sid, 'speech.ended');
    const latest = page.locator('.conversation-turn').last();
    await until(async () => workUploads(f).length > index + 1 || !!await latest.getByText('回答播报结束', { exact: true }).count(), 'next segment or completion');
    if (await latest.getByText('回答播报结束', { exact: true }).count()) return index + 1 - start;
    index++;
  }
  throw Error('More than eight uploads for one answer');
}
async function suite() {
  await scenario('first sentence, one future and ACK/ended ordering', async (f, sid, timing) => {
    f.sources = [{ excerpt: '公开样例资料：服务说明。', source: { status: 'known', filename: '公开服务介绍.md' } }];
    f.holdTTS.add(1); f.holdUploads = true;
    await page.getByRole('button', { name: Q, exact: true }).click();
    await until(() => workTTS(f).length > 0, 'first TTS request');
    assert.equal(workTTS(f)[0].text, first, 'first natural sentence must be synthesized separately');
    await until(() => workUploads(f).length === 1 && workTTS(f).length === 2, 'first upload and one future');
    assert.equal(workTTS(f).length, 2); assert.equal(workUploads(f).length, 1);
    assert.ok((await page.locator('.conversation-answer').innerText()).includes(answer));
    f.emit(sid, 'speech.ended'); await sleep(100); assert.equal(workUploads(f).length, 1, 'ended alone cannot advance');
    workUploads(f)[0].release(); await sleep(100); assert.equal(workUploads(f).length, 1, 'next WAV still pending');
    workTTS(f)[1].release(); await until(() => workUploads(f).length === 2, 'second upload');
    workUploads(f)[1].release(); await sleep(100); assert.equal(workUploads(f).length, 2, 'ACK alone cannot advance');
    f.emit(sid, 'speech.media_started'); f.emit(sid, 'speech.ended');
    await until(() => workUploads(f).length === 3, 'third upload');
    workUploads(f)[2].release(); f.emit(sid, 'speech.media_started'); f.emit(sid, 'speech.ended');
    await page.getByText('回答播报结束', { exact: true }).waitFor();
    assert.equal(workTTS(f).map(x => x.text).join(''), answer);
    assert.equal(f.questions.length, 1); assert.equal(f.serial, 1); assert.equal(await page.locator('.conversation-turn').count(), 1);
    assert.equal(f.closed.length, 0); assert.equal(f.tts.filter(x => x.welcome).length, 1);
    await page.getByText('资料来源（1）', { exact: true }).click();
    await page.getByText('公开服务介绍.md', { exact: true }).waitFor();
    await page.getByText('公开样例资料：服务说明。', { exact: true }).waitFor();
    assert.ok(timing.some(x => x.stage === 'answer_render_committed'));
    assert.ok(timing.some(x => x.stage === 'question_started'));
    assert.ok(timing.some(x => x.stage === 'question_ready'));
    for (const segment of [0, 1, 2]) {
      for (const stage of ['tts_started', 'tts_ready', 'upload_started', 'upload_ack', 'ended_signal', 'segment_complete'])
        assert.ok(timing.some(x => x.segment === segment && x.stage === stage && x.turnSeq === 1), stage + '/' + segment);
    }
    for (const entry of timing) {
      assert.ok(Number.isFinite(entry.at_ms)); assert.ok(Number.isFinite(entry.elapsed_ms));
      assert.deepEqual(Object.keys(entry).sort(), ['at_ms', 'elapsed_ms', 'kind', 'segment', 'stage', 'trace', 'turnSeq'].sort());
      assert.ok(!JSON.stringify(entry).includes(first)); assert.ok(!JSON.stringify(entry).includes(f.questions[0].visitor_id));
    }
  });
  for (const [name, text, expected] of [
    ['no sentence boundary stays intact', '完整且没有句末标点的回答', 1],
    ['tail merged at eight segments', '首句。' + ('完整条件不能丢失'.repeat(10) + '。').repeat(11), 8],
  ]) await scenario(name, async (f, sid) => {
    f.text = text;
    await page.getByRole('button', { name: Q, exact: true }).click();
    assert.equal(await finishAnswer(f, sid), expected);
    assert.equal(workTTS(f).map(x => x.text).join(''), text);
    assert.equal(await page.locator('.conversation-turn').count(), 1);
  });
  await scenario('three repeated preset turns keep SID, identity and viewport', async (f, sid) => {
    f.text = '简短回答。';
    const button = page.getByRole('button', { name: Q, exact: true });
    await button.scrollIntoViewIfNeeded();
    const before = await page.evaluate(() => ({ y: scrollY, url: location.href }));
    for (let round = 0; round < 3; round++) {
      const start = workUploads(f).length;
      await button.click(); await finishAnswer(f, sid, start);
    }
    const after = await page.evaluate(() => ({ y: scrollY, url: location.href }));
    assert.deepEqual(after, before, 'idle preset preserves viewport and URL');
    assert.deepEqual(f.questions.map(x => x.turn_seq), [1, 2, 3]);
    assert.equal(new Set(f.questions.map(x => x.turn_id)).size, 3);
    assert.equal(new Set(f.questions.map(x => x.visitor_id)).size, 1);
    assert.equal(f.serial, 1); assert.equal(f.closed.length, 0);
    assert.equal(await page.locator('.conversation-turn').count(), 3);
    assert.equal(f.tts.filter(x => x.welcome).length, 1);
    assert.equal(await page.getByRole('button', { name: '停止录音', exact: true }).isDisabled(), true, 'denied capture stays closed');
  });
  for (const status of ['clarify', 'handoff']) await scenario(status + ' replies speak and retain connection', async (f, sid) => {
    f.status = status; f.text = '现有资料暂不能确认。您可以咨询现场销售。';
    await page.getByRole('button', { name: Q, exact: true }).click(); await finishAnswer(f, sid);
    assert.equal(workTTS(f).map(x => x.text).join(''), f.text);
    assert.equal(f.closed.length, 0); assert.equal(await page.locator('.handoff-panel').count(), 0);
    await page.getByRole('button', { name: '销售接管', exact: true }).click();
    await page.locator('.handoff-panel').waitFor();
  });
  await scenario('welcome and demo remain whole; resume and new visitor greet once', async (f, sid) => {
    assert.equal(f.tts.length, 1); assert.equal(f.uploads.length, 1); assert.equal(f.questions.length, 0);
    assert.equal(f.tts[0].voice, 'fixture-voice');
    await page.getByRole('button', { name: '播放固定演示', exact: true }).click();
    await until(() => f.uploads.some(x => x.demo), 'demo upload');
    f.emit(sid, 'speech.media_started'); f.emit(sid, 'speech.ended');
    await page.getByText('固定文本播报结束', { exact: true }).waitFor();
    assert.equal(f.tts.filter(x => x.demo).length, 1);
    await page.getByRole('button', { name: '销售接管', exact: true }).click();
    await page.getByRole('button', { name: '恢复问答', exact: true }).click();
    await until(() => f.serial === 2, 'resume session'); await finishWelcome(f, f.sid(2));
    await page.getByRole('button', { name: '新一组访客', exact: true }).click();
    await until(() => f.serial === 3, 'new visitor session'); await finishWelcome(f, f.sid(3));
    assert.equal(f.tts.filter(x => x.welcome).length, 3); assert.equal(f.questions.length, 0);
  });
  for (const stage of ['tts', 'upload']) await scenario('welcome can be replaced at ' + stage, async (f, sid) => {
    if (stage === 'upload') await until(() => f.uploads.length === 1, 'held welcome upload');
    const oldTTS = f.tts[0];
    f.text = '替换后的回答。'; f.holdWelcomeTTS = false; f.holdWelcomeUpload = false;
    await page.getByRole('button', { name: Q, exact: true }).click();
    if (stage === 'upload') { await sleep(80); assert.equal(f.serial, 1); assert.equal(f.closed.length, 0); f.uploads[0].release(); }
    await until(() => f.serial === 2, 'replacement session'); oldTTS.release();
    await finishAnswer(f, f.sid(2));
    assert.equal(f.tts.filter(x => x.welcome).length, 1, 'internal rebuild never greets');
    assert.equal(f.uploads.filter(x => x.sid === sid).length, stage === 'upload' ? 1 : 0);
  }, { keepWelcome: true, fixture: stage === 'tts' ? { holdWelcomeTTS: true } : { holdWelcomeUpload: true } });
  for (const stage of ['current-tts', 'prefetch', 'upload']) for (const action of ['断开', '销售接管', '新一组访客', Q]) {
    await scenario('cancel ' + stage + ' via ' + action, async (f, sid, timing) => {
      f.holdTTS.add(stage === 'current-tts' ? 0 : 1); f.holdUploads = stage === 'upload';
      await page.getByRole('button', { name: Q, exact: true }).click();
      await until(() => workTTS(f).length === (stage === 'current-tts' ? 1 : 2), 'held synthesis');
      if (stage !== 'current-tts') await until(() => workUploads(f).length === 1, 'current upload');
      const oldAudio = [...workTTS(f)], oldUpload = workUploads(f)[0];
      const oldCount = workUploads(f).length;
      f.holdTTS.clear(); f.holdUploads = false; f.text = '新的有效回答。';
      await page.getByRole('button', { name: action, exact: true }).click();
      if (stage === 'upload') {
        await sleep(80); assert.equal(f.serial, 1, 'independent ACK blocks new session'); assert.equal(f.closed.length, 0);
        oldUpload.release();
      }
      await until(() => f.closed.includes(sid), 'retired session closed');
      oldAudio.forEach(x => x.release());
      if (action === Q) { await until(() => f.serial === 2, 'replacement session'); await finishAnswer(f, f.sid(2), oldCount); }
      if (action === '新一组访客') { await until(() => f.serial === 2, 'new visitor session'); await finishWelcome(f, f.sid(2)); }
      await sleep(80);
      assert.equal(workUploads(f).filter(x => x.sid === sid).length, oldCount, 'late WAV never uploads');
      assert.ok(timing.some(x => x.kind === 'answer' && x.stage === 'cancelled'));
      if (action === Q) assert.equal(f.tts.filter(x => x.welcome).length, 1);
    });
  }
  await scenario('late business response cannot repaint replaced turn', async (f, sid) => {
    f.holdQuestions = true; f.text = '禁止迟到回填。';
    await page.getByRole('button', { name: Q, exact: true }).click(); await until(() => f.responses.length === 1, 'held question');
    f.holdQuestions = false; f.text = '有效的新回答。';
    await page.getByRole('button', { name: Q, exact: true }).click();
    await until(() => f.serial === 2, 'new session'); f.responses[0].release(); await finishAnswer(f, f.sid(2));
    assert.equal(workTTS(f).map(x => x.text).join(''), f.text);
    assert.equal(await page.getByText('禁止迟到回填。', { exact: true }).count(), 0);
  });
  await scenario('unknown upload isolates future and blocks replacement SID', async (f, sid) => {
    f.holdTTS.add(1); f.failUpload = true; f.holdUploads = true;
    await page.getByRole('button', { name: Q, exact: true }).click();
    await until(() => workTTS(f).length === 2 && workUploads(f).length === 1, 'current upload with future');
    workUploads(f)[0].release();
    await page.getByRole('alert', { name: '媒体上传隔离' }).waitFor();
    const future = workTTS(f)[1]; assert.ok(future, 'one future was started'); future.release();
    await page.getByRole('button', { name: '销售接管', exact: true }).click();
    await page.getByRole('button', { name: '恢复问答', exact: true }).click();
    await sleep(100);
    assert.equal(workUploads(f).length, 1); assert.equal(f.serial, 1); assert.equal(f.closed.length, 0);
  });
  await scenario('mobile idle preset preserves scroll and bottom history', async (f, sid) => {
    await page.setViewportSize({ width: 390, height: 844 }); f.text = '简短回答。';
    const button = page.getByRole('button', { name: Q, exact: true }); await button.scrollIntoViewIfNeeded();
    const before = await page.evaluate(() => ({ y: scrollY, url: location.href }));
    await button.click(); await finishAnswer(f, sid);
    assert.deepEqual(await page.evaluate(() => ({ y: scrollY, url: location.href })), before);
    assert.equal(await page.locator('.workspace .conversation-answer').count(), 0);
    assert.equal(await page.locator('#conversation-history .conversation-answer').count(), 1);
  });
  for (const failure of ['business', 'identity', 'tts', 'upload']) await scenario('failure boundary ' + failure, async (f) => {
    f.text = '保留的完整文字。';
    if (failure === 'business') f.status = 'error';
    if (failure === 'identity') f.badIdentity = true;
    if (failure === 'tts') f.failTTS = true;
    if (failure === 'upload') f.failUpload = true;
    await page.getByRole('button', { name: Q, exact: true }).click();
    if (failure === 'business' || failure === 'identity') {
      await page.locator('.conversation-turn .turn-status.error').waitFor(); assert.equal(workTTS(f).length, 0);
    } else {
      if (failure === 'upload') await page.getByText('画面和声音已关闭，但旧会话释放未确认；不会开启新会话，请重试或联系工作人员。', { exact: true }).waitFor();
      else await page.getByText(/播报未完成，文字已保留/).waitFor();
      assert.equal(await page.locator('.answer-text').innerText(), f.text);
    }
    if (failure === 'upload') {
      await page.getByRole('alert', { name: '媒体上传隔离' }).waitFor();
      assert.equal(workUploads(f).length, 1); assert.equal(f.closed.length, 0);
    }
    await page.getByRole('button', { name: '销售接管', exact: true }).click(); await page.locator('.handoff-panel').waitFor();
    assert.equal(f.serial, 1, 'failure does not create or retry session');
  });
  for (const text of ['', '长'.repeat(1001)]) await scenario('unspoken answer retains complete DOM: ' + text.length, async (f) => {
    f.text = text; await page.getByRole('button', { name: Q, exact: true }).click();
    await page.getByText(text ? '回答超过 1000 字，无法自动播报；完整文字已保留。' : '回答没有可播报文字，仅保留文字显示。', { exact: true }).waitFor();
    assert.equal(await page.locator('.answer-text').innerText(), text);
    assert.equal(workTTS(f).length, 0); assert.equal(workUploads(f).length, 0);
  });
}
module.exports = { Fixture, platformFixture };
if (require.main === module) (async () => {
  await fs.mkdir(evidence, { recursive: true }); await fs.mkdir(temp, { recursive: true });
  const { createServer } = await import(pathToFileURL(path.resolve('frontend/node_modules/vite/dist/node/index.js')).href);
  const react = (await import(pathToFileURL(path.resolve('frontend/node_modules/@vitejs/plugin-react/dist/index.js')).href)).default;
  vite = await createServer({ configFile: false, root: path.resolve('frontend'), plugins: [react()], cacheDir: path.join(temp, 'vite-cache'), server: { middlewareMode: true, hmr: false, watch: null } });
  context = await chromium.launchPersistentContext(path.join(temp, 'chrome-profile'), { channel: 'chrome', headless: true, timeout: 20000, viewport: { width: 1280, height: 900 }, args: ['--autoplay-policy=no-user-gesture-required'], env: { ...process.env, TMP: temp, TEMP: temp } });
  context.setDefaultTimeout(6000); await context.addInitScript(platformFixture);
  await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
  await suite();
  if (red) throw Error('Expected regression was not reproduced');
  await fs.writeFile(path.join(evidence, 'result.json'), JSON.stringify({ status: 'PASS', results, diagnostics }, null, 2));
})().catch(async error => {
  const expected = red && error.code === 'ERR_ASSERTION' && error.message.includes('first natural sentence must be synthesized separately');
  await fs.writeFile(path.join(evidence, 'result.json'), JSON.stringify({ status: expected ? 'EXPECTED_RED' : 'FAIL', error: error.stack, results, diagnostics }, null, 2));
  if (page) await page.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => {});
  console.error(expected ? 'EXPECTED_RED: full-answer TTS blocks first sentence' : error.stack);
  process.exitCode = expected ? 42 : 1;
}).finally(async () => {
  fixture?.dispose(); await context?.close(); await vite?.close();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
