// Actual Vite preview and actual config, with all upstream requests redirected
// in-process to a dedicated ephemeral fixture before any production connection.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const ts = require('../../frontend/node_modules/typescript');

test('runtime-only upstream selection and isolated preview assets', { timeout: 15000 }, async () => {
  const source = await fs.readFile('frontend/vite.config.ts', 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const configFor = (port) => {
    const context = { exports: {}, process: { env: port === undefined ? {} : { GUIDE_BUSINESS_PORT: port } }, require(name) {
      if (name === 'vite') return { defineConfig: (config) => config };
      if (name === '@vitejs/plugin-react') return { default: () => ({ name: 'fixture-react' }) };
      throw Error('Unexpected configuration dependency');
    } };
    vm.runInNewContext(compiled, context);
    return context.exports.default;
  };
  assert.equal(configFor().preview.proxy['/guide'].target, 'http://127.0.0.1:8010');
  assert.equal(configFor('8010').server.proxy['/guide'].target, 'http://127.0.0.1:8010');
  const config = configFor('8011');
  assert.equal(config.preview.proxy['/guide'].target, 'http://127.0.0.1:8011');
  assert.equal(config.server.proxy['/guide'].target, config.preview.proxy['/guide'].target);
  assert.equal(config.preview.proxy['/opentalking'].target, 'http://127.0.0.1:8210');
  for (const invalid of ['', ' 8011', '8011 ', '08011', '8012', 'https://example.invalid', '8011\n']) {
    assert.throws(() => configFor(invalid), /GUIDE_BUSINESS_PORT must be/);
  }
  assert.equal(config.define, undefined);
  assert.equal(config.envPrefix, undefined);
  const task = path.resolve('docs/dev/20261101-展厅AI导览-实时打断问答与锐伽样例知识库');
  await fs.mkdir(path.join(task, 'tmp'), { recursive: true });
  const fixture = await fs.mkdtemp(path.join(task, 'tmp/task22-proxy-'));
  const build = path.join(fixture, 'selected-build');
  await fs.mkdir(build);
  await fs.mkdir(path.join(fixture, 'dist'));
  await fs.writeFile(path.join(fixture, 'dist/index.html'), '<html>WRONG DEFAULT BUILD</html>');
  await fs.writeFile(path.join(build, 'index.html'), '<html>SELECTED BUILD<script src="/selected.js"></script></html>');
  await fs.writeFile(path.join(build, 'selected.js'), 'globalThis.selectedRelease = true;');
  const calls = [], selectedTargets = [];
  const upstream = http.createServer((req, res) => {
    calls.push(req.url);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ avatar_id: 'fixture-avatar', tts_voice: 'fixture-voice' }));
  });
  const originalRequest = http.request;
  let preview;
  try {
    await new Promise((resolve, reject) => { upstream.once('error', reject); upstream.listen(0, '127.0.0.1', resolve); });
    const upstreamPort = upstream.address().port;
    assert.ok(![5280,5290,5294,8010,8011,8210,8211,8220].includes(upstreamPort));
    http.request = function(options, ...args) {
      // Vite's native proxy uses this request API. Refuse any non-fixture target.
      assert.equal(options.hostname, '127.0.0.1');
      assert.equal(Number(options.port), 8011, 'old business port must never be requested');
      selectedTargets.push(Number(options.port));
      return originalRequest.call(this, { ...options, host: '127.0.0.1', hostname: '127.0.0.1', port: upstreamPort }, ...args);
    };
    const vite = await import(pathToFileURL(path.resolve('frontend/node_modules/vite/dist/node/index.js')).href);
    preview = await vite.preview({ configFile: false, root: fixture, logLevel: 'silent',
      build: { outDir: build }, preview: { ...config.preview, port: 0 } });
    const previewPort = preview.httpServer.address().port;
    assert.ok(![5280,5290,5294,8010,8011,8210,8211,8220].includes(previewPort));
    const base = `http://127.0.0.1:${previewPort}`;
    const get = (url) => fetch(base + url, { signal: AbortSignal.timeout(3000) });
    const html = await (await get('/')).text();
    assert.match(html, /SELECTED BUILD/);
    assert.doesNotMatch(html, /WRONG DEFAULT BUILD|GUIDE_BUSINESS_PORT/);
    assert.equal(await (await get('/selected.js')).text(), 'globalThis.selectedRelease = true;');
    assert.deepEqual(await (await get('/guide/ui-config')).json(), { avatar_id: 'fixture-avatar', tts_voice: 'fixture-voice' });
    assert.deepEqual(calls, ['/ui-config']);
    assert.deepEqual(selectedTargets, [8011]);
  } finally {
    http.request = originalRequest;
    if (preview) {
      preview.httpServer.closeAllConnections();
      await new Promise((resolve) => preview.httpServer.close(resolve));
    }
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
  }
});
