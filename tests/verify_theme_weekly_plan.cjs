// 主题周计划：周一到周日各选一套、开关即时保存、今天立即生效、删除方案时清理引用。
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
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

const SETTINGS = {
  theme_profiles: [
    { id: 'default', name: '森野', theme_color: 'forest', custom_theme_color: '#2E6D4E', custom_background_enabled: false, custom_background_version: 0, custom_background_overlay_opacity: 82 },
    { id: 'ocean', name: '海蓝', theme_color: 'ocean', custom_theme_color: '#2784AA', custom_background_enabled: false, custom_background_version: 0, custom_background_overlay_opacity: 64 },
    { id: 'indigo', name: '靛蓝', theme_color: 'indigo', custom_theme_color: '#5269B6', custom_background_enabled: false, custom_background_version: 0, custom_background_overlay_opacity: 78 },
  ],
  active_theme_profile: 'default',
  theme_color: 'forest',
  custom_theme_color: '#2E6D4E',
  custom_background_enabled: false,
  custom_background_version: 0,
  custom_background_overlay_opacity: 82,
  theme_random_on_open: true,
  theme_weekly_plan_enabled: false,
  theme_weekly_plan: {},
  sidebar_order: ['collection', 'schedule', 'timeline', 'statistics', 'ranking', 'settings'],
  sidebar_visibility: {},
};
const BOOT = {
  settings: SETTINGS,
  active_profile: { id: 'local', name: '本机' },
  animes: [],
  custom_collections: [],
  ranking_boards: [],
  ranking_templates: [],
  stats: {},
  sync: { running: false },
  revision: 1,
};
const patches = [];

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://x').pathname;
  const send = (code, body, type = 'application/json') => {
    res.writeHead(code, { 'Content-Type': type });
    res.end(Buffer.isBuffer(body) || typeof body === 'string' ? body : JSON.stringify(body));
  };
  if (pathname === '/api/bootstrap') return send(200, BOOT);
  if (pathname === '/api/status') return send(200, { sync: { running: false }, stats: {}, revision: 1 });
  if (pathname === '/api/background' && req.method === 'GET') return send(200, PNG, 'image/png');
  if (pathname === '/api/settings' && req.method === 'PATCH') {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const patch = JSON.parse(raw || '{}');
      patches.push(patch);
      Object.assign(SETTINGS, patch);
      send(200, { ok: true, settings: SETTINGS });
    });
    return;
  }
  if (pathname.startsWith('/api/')) return send(200, { ok: true, items: [] });
  const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).slice(1);
  const full = path.join(ROOT, relative);
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return send(404, 'not found', 'text/plain');
  return send(200, fs.readFileSync(full), MIME[path.extname(full)] || 'application/octet-stream');
});

(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await (await browser.newContext({ viewport: { width: 1180, height: 900 } })).newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${base}/`, { waitUntil: 'load' });
    await page.waitForTimeout(1600);
    await page.click('#settingsButton');
    await page.waitForSelector('#settingsModal[open]');
    await page.waitForTimeout(300);

    const today = String(new Date().getDay() || 7);
    const otherDay = today === '1' ? '2' : '1';

    // 1) 默认关闭：7 个选择框都在，但不可用；随机主题仍可用。
    assert.equal(await page.locator('[data-theme-plan-day]').count(), 7, 'one select per weekday');
    assert.equal(await page.locator('[data-theme-plan-day]:disabled').count(), 7, 'plan selects disabled while off');
    assert.equal(await page.locator('#themeWeeklyPlanEnabledInput').isChecked(), false);
    assert.equal(await page.locator('#themeRandomOnOpenInput').isDisabled(), false);
    assert.equal(await page.locator('.theme-plan-day.is-today').count(), 1, 'today is highlighted');

    // 2) 开启：写入开关和 7 天空计划；随机开关暂停。
    await page.locator('#themeWeeklyPlanEnabledInput').evaluate((input) => input.click());
    await page.waitForTimeout(600);
    let last = patches.at(-1);
    assert.equal(last.theme_weekly_plan_enabled, true);
    assert.deepEqual(Object.keys(last.theme_weekly_plan).sort(), ['1', '2', '3', '4', '5', '6', '7']);
    assert.equal(await page.locator('[data-theme-plan-day]:enabled').count(), 7, 'plan selects enabled');
    assert.equal(await page.locator('#themeRandomOnOpenInput').isDisabled(), true, 'random is paused by the plan');

    // 3) 给今天选一套：立即换肤并写库。
    await page.selectOption(`[data-theme-plan-day="${today}"]`, 'ocean');
    await page.waitForTimeout(700);
    last = patches.at(-1);
    assert.equal(last.theme_weekly_plan[today], 'ocean');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'ocean', 'today plan applies immediately');
    assert.equal(await page.locator('.theme-card.is-active').getAttribute('data-theme-card'), 'ocean');

    // 4) 给别的日子选一套，不影响今天。
    await page.selectOption(`[data-theme-plan-day="${otherDay}"]`, 'ocean');
    await page.waitForTimeout(500);
    assert.equal(patches.at(-1).theme_weekly_plan[otherDay], 'ocean');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'ocean', 'other days do not change today');

    // 5) 关闭后选择框禁用、随机恢复；计划内容保留。
    await page.locator('#themeWeeklyPlanEnabledInput').evaluate((input) => input.click());
    await page.waitForTimeout(600);
    assert.equal(patches.at(-1).theme_weekly_plan_enabled, false);
    assert.equal(await page.locator('[data-theme-plan-day]:disabled').count(), 7);
    assert.equal(await page.locator('#themeRandomOnOpenInput').isDisabled(), false);
    assert.equal(await page.locator(`[data-theme-plan-day="${today}"]`).inputValue(), 'ocean', 'plan values survive toggling off');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'forest', 'disabling the plan restores the saved theme');

    // 6) 重新开启，把今天设为 indigo，然后删除 indigo：计划引用必须清空。
    await page.locator('#themeWeeklyPlanEnabledInput').evaluate((input) => input.click());
    await page.waitForTimeout(500);
    await page.selectOption(`[data-theme-plan-day="${today}"]`, 'indigo');
    await page.waitForTimeout(600);
    page.once('dialog', (dialog) => dialog.accept());
    await page.locator('[data-theme-delete="indigo"]').click();
    await page.waitForTimeout(1000);
    const planPatch = patches.filter((patch) => 'theme_weekly_plan' in patch).at(-1);
    assert.equal(planPatch.theme_weekly_plan[today], '', 'deleted profile is removed from the plan');
    assert.equal(await page.locator(`[data-theme-plan-day="${today}"]`).inputValue(), '');
    assert.equal(await page.locator('.theme-card-main').count(), 2);

    // 7) 刷新后开关、计划和今天的选择都还在。
    await page.reload({ waitUntil: 'load' });
    await page.waitForTimeout(1600);
    await page.click('#settingsButton');
    await page.waitForSelector('#settingsModal[open]');
    await page.waitForTimeout(300);
    assert.equal(await page.locator('#themeWeeklyPlanEnabledInput').isChecked(), true);
    assert.equal(await page.locator('[data-theme-plan-day]:enabled').count(), 7);
    assert.equal(await page.locator(`[data-theme-plan-day="${otherDay}"]`).inputValue(), 'ocean');

    // 8) 启动时沿用服务端注入的周计划方案；周计划开启时随机主题不接管。
    const adopted = await page.evaluate(() => {
      state.settings.theme_weekly_plan_enabled = true;
      state.settings.theme_profiles = [
        { id: 'a', name: 'A', theme_color: 'forest' },
        { id: 'b', name: 'B', theme_color: 'ocean' },
      ];
      window.handbookInitialAppearance = {
        weekly_theme_profile: 'b',
        settings: {
          theme_color: 'ocean',
          active_theme_profile: 'b',
          custom_theme_color: '#2784AA',
          custom_background_enabled: false,
          custom_background_version: 0,
          custom_background_overlay_opacity: 64,
        },
      };
      adoptInitialWeeklyTheme();
      const afterWeekly = { active: state.settings.active_theme_profile, color: state.settings.theme_color };
      window.handbookInitialAppearance.random_theme_profile = 'a';
      state.settings.theme_random_on_open = true;
      adoptInitialRandomTheme();
      return { afterWeekly, afterRandom: state.settings.active_theme_profile };
    });
    assert.equal(adopted.afterWeekly.active, 'b', 'weekly profile is adopted after boot');
    assert.equal(adopted.afterWeekly.color, 'ocean');
    assert.equal(adopted.afterRandom, 'b', 'random must not override an enabled plan');

    assert.deepEqual(errors, [], 'no page errors');
    console.log('Theme weekly plan: 7 day selects, toggle persist, today applies immediately, random paused, values survive reload, delete clears references, boot adoption passed.');
  } finally {
    await browser.close();
    server.close();
  }
})().catch((error) => { console.error(error); process.exit(1); });
