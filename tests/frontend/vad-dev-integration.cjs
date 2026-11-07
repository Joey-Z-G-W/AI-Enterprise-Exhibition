// Real Vite + capture adapter + MicVAD + ONNX + AudioWorklet in Chrome.
// Only the physical microphone is replaced by Chrome's fake device.
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '../..');
const frontend = path.join(root, 'frontend');
const requireFrontend = createRequire(path.join(frontend, 'package.json'));
const { chromium } = requireFrontend('playwright-core');

(async () => {
  const { createServer } = await import(pathToFileURL(path.join(frontend, 'node_modules/vite/dist/node/index.js')));
  const responses = [], errors = [];
  const server = await createServer({ root: frontend, configFile: path.join(frontend, 'vite.config.ts'),
    cacheDir: path.join(frontend, 'node_modules/.vite-vad-integration'),
    server: { host: '127.0.0.1', port: 0, open: false },
    plugins: [{ name: 'capture-consumer', configureServer(server) {
      // Worklet fetches are not included in Playwright's page response events.
      server.middlewares.use((req, res, next) => {
        if (/^\/(ort|vad)\//.test(req.url)) {
          const url = req.url;
          res.once('finish', () => responses.push({ url, status: res.statusCode }));
        }
        next();
      });
      server.middlewares.use('/__capture_test', (_req, res) => {
        res.setHeader('Content-Type', 'text/html');
        res.end(`<button id="start">Start</button><button id="stop">Stop</button><p id="state"></p>
          <script type="module">
          import { createContinuousCapture } from '/src/lib/continuousCapture.ts';
          let capture;
          document.querySelector('#start').onclick = () => {
            capture = createContinuousCapture((state, text) => {
              document.querySelector('#state').textContent = state;
              document.querySelector('#state').title = text;
            });
            capture.listen();
          };
          document.querySelector('#stop').onclick = async () => {
            document.body.dataset.released = String(await capture.stop() && capture.released);
          };
          </script>`);
      });
    } }],
  });
  let browser;
  try {
    await server.listen();
    browser = await chromium.launch({ channel: 'chrome', headless: true, args: [
      '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
    ] });
    const page = await browser.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__capture_test`);
    for (let attempt = 0; attempt < 2; attempt++) {
      await page.locator('#start').click();
      await page.waitForFunction(() => ['listening', 'error'].includes(document.querySelector('#state').textContent), null, { timeout: 40000 });
      assert.equal(await page.locator('#state').textContent(), 'listening', await page.locator('#state').getAttribute('title'));
      assert.equal(await page.locator('vite-error-overlay').count(), 0);
      await page.locator('#stop').click();
      await page.waitForFunction(() => document.body.dataset.released === 'true');
      assert.equal(await page.locator('#state').textContent(), 'closed');
      await page.evaluate(() => delete document.body.dataset.released);
    }
    for (const filename of ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm', 'silero_vad_v5.onnx', 'vad.worklet.bundle.min.js']) {
      assert.ok(responses.some(r => new URL(r.url, 'http://localhost').pathname.endsWith('/' + filename) && r.status === 200), filename);
    }
    assert.ok(responses.every(r => r.status === 200 || r.status === 304), JSON.stringify(responses));
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ status: 'PASS', microphone_start_stop_cycles: 2, responses, errors }));
  } finally {
    if (browser) await browser.close();
    await server.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
