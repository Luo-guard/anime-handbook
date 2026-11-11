// Isolated real WASM/font smoke test; never contacts the running handbook or user data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assets = path.resolve(process.argv[2] || 'static/vendor/jassub');
const ass = `[Script Info]
ScriptType: v4.00+
PlayResX: 640
PlayResY: 360
[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Noto Sans SC,36,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,0,2,10,10,10,1
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:05.00,Default,,0,0,0,,动漫手账中文字幕
`;
const server = http.createServer((req, res) => {
  if (req.url === '/') {
    res.setHeader('Content-Type', 'text/html');
    return res.end('<canvas id="sub" width="640" height="360"></canvas><script src="/jassub.bundle.js"></script>');
  }
  const file = path.resolve(assets, '.' + new URL(req.url, 'http://localhost').pathname);
  if (!file.startsWith(assets + path.sep) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.wasm') ? 'application/wasm' : 'font/woff2');
  fs.createReadStream(file).pipe(res);
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    for (const memory of [1, 8]) {
      const page = await browser.newPage();
      const requested = [], errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('request', request => requested.push(request.url()));
      await page.addInitScript(value => Object.defineProperty(navigator, 'deviceMemory', { value }), memory);
      await page.goto(`http://127.0.0.1:${server.address().port}/`);
      await page.evaluate(async subContent => {
        window.instance = new JASSUB({ canvas: document.querySelector('canvas'), subContent,
          workerUrl: '/jassub-worker.bundle.js', wasmWorkerUrl: '/wasm/jassub-worker.js',
          wasmUrl: '/wasm/jassub-worker.wasm', modernWasmWorkerUrl: '/wasm/jassub-worker-modern.js',
          modernWasmUrl: '/wasm/jassub-worker-modern.wasm',
          availableFonts: { 'noto sans sc': '/noto-sans-sc-400.woff2' }, defaultFont: 'noto sans sc', queryFonts: false });
        await instance.ready;
        await instance.renderer._draw(1, true);
      }, ass);
      await page.waitForFunction(() => {
        return instance.renderer._drawCapture(1).then(frame =>
          frame.data.some((value, i) => i % 4 === 3 && value > 0));
      }, null, { timeout: 15000 });
      assert(requested.some(url => url.endsWith('/noto-sans-sc-400.woff2')), 'Chinese fallback font fetched');
      assert(requested.some(url => url.endsWith(memory === 1 ? '/jassub-worker.wasm' : '/jassub-worker-modern.wasm')));
      assert.deepEqual(errors, []);
      await page.evaluate(() => instance.destroy());
      await page.close();
    }
    console.log('PASS: clean assets render Chinese ASS with legacy and modern WASM.');
  } finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
