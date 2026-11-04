// 打开时随机主题：首屏注入的随机方案必须被启动流程沿用，不能跳回数据库里的方案。
const fs = require('fs');
const http = require('http');
const path = require('path');
const assert = require('node:assert/strict');
const { chromium } = require('C:/Users/han/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

const ROOT = path.resolve('static');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

const PROFILES = [
  { id: 'a', name: '森野', theme_color: 'forest', custom_theme_color: '#2E6D4E', custom_background_enabled: false, custom_background_version: 0, custom_background_overlay_opacity: 82 },
  { id: 'b', name: '海蓝', theme_color: 'ocean', custom_theme_color: '#2784AA', custom_background_enabled: false, custom_background_version: 0, custom_background_overlay_opacity: 82 },
];
// 数据库里保存的是 a（forest）；服务端随机抽到了 b（ocean）。
const RANDOM_ID = 'b';
const DB_SETTINGS = {
  theme_color: 'forest',
  custom_theme_color: '#2E6D4E',
  custom_background_enabled: false,
  custom_background_version: 0,
  custom_background_overlay_opacity: 82,
  active_theme_profile: 'a',
  theme_profiles: PROFILES,
  theme_random_on_open: true,
  show_all_collection_tab: true,
  collection_home: 'builtin:1',
  sidebar_order: ['collection', 'schedule', 'timeline', 'statistics', 'ranking', 'settings'],
  sidebar_visibility: {},
};
const patches = [];

function injectedHtml(settings) {
  const raw = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const chosen = PROFILES.find((item) => item.id === RANDOM_ID);
  const appearance = {
    settings: {
      theme_color: chosen.theme_color,
      custom_theme_color: chosen.custom_theme_color,
      custom_background_enabled: chosen.custom_background_enabled,
      custom_background_version: chosen.custom_background_version,
      custom_background_overlay_opacity: chosen.custom_background_overlay_opacity,
      active_theme_profile: chosen.id,
    },
    account_id: 'local',
    random_theme_profile: settings.theme_random_on_open ? RANDOM_ID : null,
  };
  const marker = '<script id="initialAppearance" type="application/json">{}</script>';
  return raw.replace(
    marker,
    `<script id="initialAppearance" type="application/json">${JSON.stringify(appearance)}</script>`,
  );
}

function startServer() {
  return http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://x').pathname;
    const send = (code, body, type = 'application/json') => {
      res.writeHead(code, { 'Content-Type': type });
      res.end(Buffer.isBuffer(body) || typeof body === 'string' ? body : JSON.stringify(body));
    };
    if (pathname === '/') return send(200, injectedHtml(DB_SETTINGS), 'text/html; charset=utf-8');
    if (pathname === '/api/bootstrap') {
      return send(200, {
        settings: DB_SETTINGS,
        animes: [],
        custom_collections: [],
        ranking_boards: [],
        ranking_templates: [],
        stats: {},
        sync: { running: false },
        revision: 1,
      });
    }
    if (pathname === '/api/status') return send(200, { sync: { running: false }, stats: {}, revision: 1 });
    if (pathname === '/api/settings' && req.method === 'PATCH') {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        const body = JSON.parse(raw || '{}');
        patches.push(body);
        Object.assign(DB_SETTINGS, body);
        send(200, { ok: true, settings: DB_SETTINGS, stats: {}, sync: { running: false }, revision: 1 });
      });
      return;
    }
    if (pathname.startsWith('/api/')) return send(200, { ok: true, items: [] });
    const relative = decodeURIComponent(pathname).slice(1);
    const full = path.join(ROOT, relative);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return send(404, 'not found', 'text/plain');
    return send(200, fs.readFileSync(full), MIME[path.extname(full)] || 'application/octet-stream');
  });
}

(async () => {
  const server = startServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await (await browser.newContext({ viewport: { width: 1180, height: 860 } })).newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${base}/`, { waitUntil: 'load' });
    await page.waitForTimeout(1800);

    // 1) 首屏与启动后都是随机抽到的方案，没有跳回数据库里的 a。
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'ocean', 'first paint uses the random profile');
    assert.equal(await page.evaluate(() => state.settings.active_theme_profile), RANDOM_ID, 'boot adopts the injected pick');
    assert.equal(await page.evaluate(() => state.settings.theme_color), 'ocean');

    // 2) 设置里下拉显示的是实际在用的那套。
    await page.click('#settingsButton');
    await page.waitForSelector('#settingsModal[open]');
    await page.click('[data-settings-tab="main"]');
    await page.waitForTimeout(300);
    assert.equal(await page.locator('.theme-card.is-active').getAttribute('data-theme-card'), RANDOM_ID);
    assert.match(await page.locator('.theme-card.is-active .theme-card-meta small').innerText(), /海蓝/);

    // 3) 开关回填为开启，点击后立即写入。
    assert.equal(await page.locator('#themeRandomOnOpenInput').isChecked(), true, 'toggle reflects the saved value');
    // 真正的可点区域是视觉开关，隐藏的 checkbox 不接收指针事件。
    await page.locator('label.setting-row', { has: page.locator('#themeRandomOnOpenInput') }).locator('.switch').click();
    await page.waitForTimeout(500);
    const last = patches.at(-1);
    assert.deepEqual(last, { theme_random_on_open: false }, 'toggle persists on its own');
    assert.match(await page.locator('#toastRegion').innerText(), /关闭随机主题/);

    // 4) 关闭后不再采纳注入的随机方案（模拟旧页面/服务端未随机的情况）。
    await page.evaluate(() => {
      state.settings.theme_random_on_open = false;
      state.settings.active_theme_profile = 'a';
      state.settings.theme_color = 'forest';
      adoptInitialRandomTheme();
    });
    assert.equal(await page.evaluate(() => state.settings.active_theme_profile), 'a', 'disabled toggle ignores the injected pick');

    assert.deepEqual(errors, [], 'no page errors');
    console.log('Random theme on open: first paint matches the injected pick, boot keeps it, settings show it, toggle persists and disables adoption.');
  } finally {
    await browser.close();
    server.close();
  }
})().catch((error) => { console.error(error); process.exit(1); });
