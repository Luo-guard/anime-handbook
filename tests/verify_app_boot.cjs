// G1 整页启动冒烟测试：用真实 index.html + 真实脚本顺序加载整个前端，
// 存根最小后端接口，验证“少写一个 <script>、顶层抛错、模块互相踩脚”这类
// 只有整页启动才能暴露的问题。
const fs = require('fs'), http = require('http'), path = require('path'), assert = require('node:assert/strict');
const { chromium } = require('C:/Users/han/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

const ROOT = path.resolve('static');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const BOOTSTRAP = {
  settings: {},
  animes: [],
  custom_collections: [],
  ranking_boards: [],
  ranking_templates: [],
  stats: {},
  sync: { running: false, message: '', last_error: null },
  revision: 1,
};

function startServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const send = (code, body, type) => {
      res.writeHead(code, { 'Content-Type': type });
      res.end(body);
    };
    if (url.pathname === '/api/bootstrap') {
      send(200, JSON.stringify(BOOTSTRAP), 'application/json');
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      send(404, JSON.stringify({ ok: false, message: 'smoke stub' }), 'application/json');
      return;
    }
    const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).slice(1);
    const full = path.join(ROOT, relative);
    if (!full.startsWith(ROOT) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
      send(404, 'not found', 'text/plain');
      return;
    }
    send(200, fs.readFileSync(full), MIME[path.extname(full)] || 'application/octet-stream');
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function scriptUrls() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  return [...html.matchAll(/(?:src|href)="(\/[^"]+?\.(?:js|css))(?:\?[^"]*)?"/g)].map(m => m[1]);
}

(async () => {
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true });
  const required = new Set(scriptUrls());
  const loaded = new Map();
  const errors = [];
  try {
    const page = await (await browser.newContext({ viewport: { width: 1180, height: 900 } })).newPage();
    page.on('pageerror', error => errors.push(String(error?.message || error)));
    page.on('response', response => {
      const url = new URL(response.url());
      if (required.has(url.pathname)) loaded.set(url.pathname, response.status());
    });
    await page.goto(`${base}/`, { waitUntil: 'load', timeout: 20000 });
    // 顶层 const 不挂在 window 上，用 typeof 探测。
    await page.waitForFunction(() => typeof state !== 'undefined' && state.dataRevision !== undefined, null, { timeout: 10000 });

    // 每个脚本/样式都按 index.html 里的清单加载成功（漏文件、路径错在这里现形）。
    assert.deepEqual(scriptUrls().filter(name => loaded.get(name) !== 200), [], 'every script/stylesheet from index.html must load');
    // 顶层没有抛错（defer 脚本互相踩脚、找不到全局函数都会在这里现形）。
    assert.deepEqual(errors, [], `no page errors during boot: ${errors.join(' | ')}`);
    // 启动流程真的跑完：版本号记账、收藏未重复拉取（A1 的接线）。
    assert.equal(await page.evaluate(() => state.dataRevision), 1);
    assert.equal(await page.evaluate(() => typeof renderCollection === 'function' && typeof applyCollectionToolbarButtons === 'function'), true);

    // 首屏：空收藏的空状态 + 工具栏按钮按默认设置就位。
    assert.equal(await page.locator('#collectionEmpty').isVisible(), true);
    assert.equal(await page.locator('#animeGrid').isVisible(), false);
    for (const id of ['#collectionSearchButton', '#jumpHistoryButton', '#searchInput']) {
      assert.equal(await page.locator(id).isVisible(), true, `${id} must be visible after boot`);
    }
    assert.equal(await page.evaluate(() => document.querySelector('#jumpHistoryButton').classList.contains('icon-only')), true, 'history button defaults to icon-only');

    // 设置面板能在整页环境里打开，问号说明已挂满。
    await page.click('#settingsButton');
    await page.waitForSelector('#settingsModal[open]', { timeout: 5000 });
    assert.ok(await page.locator('#settingsModal .setting-help').count() > 50, 'help buttons are wired in the integrated page');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    assert.equal(await page.locator('#settingsModal').evaluate(node => node.open), false);

    // 未发生写入时不应重复拉取收藏。
    const collectionFetches = await page.evaluate(() => performance.getEntriesByType('resource').filter(entry => entry.name.endsWith('/api/collection-state')).length);
    assert.equal(collectionFetches, 0, 'no collection refetch without data changes');

    console.log('App boot smoke: real script order loads clean, boot completes, toolbar/help/empty state wired, no collection refetch without writes.');
  } finally {
    await browser.close();
    server.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
