// 主题方案区：改了就存、另存为新方案、删除确认与禁用说明、自定义色反馈。
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

function makeSettings(profiles) {
  const active = profiles[0];
  return {
    theme_profiles: profiles,
    active_theme_profile: active.id,
    theme_color: active.theme_color,
    custom_theme_color: active.custom_theme_color,
    custom_background_enabled: active.custom_background_enabled,
    custom_background_version: active.custom_background_version,
    custom_background_overlay_opacity: active.custom_background_overlay_opacity,
  };
}

const SETTINGS = makeSettings([
  { id: 'default', name: 'v家', theme_color: 'slate', custom_theme_color: '#F5C1CA', custom_background_enabled: false, custom_background_version: 0, custom_background_overlay_opacity: 0 },
  { id: 'night', name: '夜间深色', theme_color: 'indigo', custom_theme_color: '#5269B6', custom_background_enabled: true, custom_background_version: 1, custom_background_overlay_opacity: 78 },
]);
const BOOT = { settings: SETTINGS, animes: [], custom_collections: [], ranking_boards: [], ranking_templates: [], stats: {}, sync: { running: false }, revision: 1 };
const patches = [];

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://x').pathname;
  const send = (code, body, type) => { res.writeHead(code, { 'Content-Type': type }); res.end(body); };
  if (pathname === '/api/bootstrap') return send(200, JSON.stringify(BOOT), 'application/json');
  if (pathname === '/api/settings' && req.method === 'PATCH') {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const patch = JSON.parse(raw || '{}');
      patches.push(patch);
      Object.assign(SETTINGS, patch);
      send(200, JSON.stringify({ ok: true, settings: SETTINGS, stats: {}, sync: { running: false }, revision: 1 }), 'application/json');
    });
    return;
  }
  if (pathname.startsWith('/api/')) return send(404, JSON.stringify({ ok: false }), 'application/json');
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
    await page.waitForTimeout(1800);
    await page.click('#settingsButton');
    await page.waitForSelector('#settingsModal[open]');
    await page.click('[data-settings-tab="theme"]');
    await page.waitForTimeout(300);

    // 1) 只剩一套方案时，删除按钮被禁用并说明原因。
    const single = await page.evaluate(() => {
      const saved = state.settings.theme_profiles;
      state.settings.theme_profiles = [saved[0]];
      renderThemeControls();
      const button = document.querySelector('#deleteThemeProfileButton');
      const result = { disabled: button.disabled, title: button.title, label: button.textContent.trim() };
      state.settings.theme_profiles = saved;
      renderThemeControls();
      return result;
    });
    assert.equal(single.disabled, true, 'single profile disables delete');
    assert.match(single.title, /至少要保留/, 'disabled delete explains why');
    assert.equal(single.label, '删除当前方案', 'delete names its scope');

    // 2) 点击预设色立即写入当前方案（同时带上顶层配色，避免响应把颜色冲掉）。
    const before = patches.length;
    await page.locator('.theme-option[data-theme-value="forest"]').click();
    await page.waitForTimeout(600);
    assert.equal(patches.length, before + 1, 'color click persists once');
    const colorPatch = patches.at(-1);
    assert.equal(colorPatch.theme_color, 'forest', 'top-level color travels with the patch');
    assert.equal(colorPatch.theme_profiles[0].theme_color, 'forest', 'snapshot records the color');
    assert.equal(colorPatch.theme_profiles[0].id, 'default', 'only the active profile is rewritten');

    // 3) 松开遮罩滑块才写库，且保留已选颜色。
    await page.locator('#customBackgroundOpacityInput').evaluate((element) => {
      element.value = 56;
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForTimeout(600);
    assert.equal(patches.at(-1).theme_profiles[0].custom_background_overlay_opacity, 56, 'slider change persists opacity');
    assert.equal(patches.at(-1).theme_profiles[0].theme_color, 'forest', 'opacity save keeps the chosen color');
    assert.equal(await page.locator('#customBackgroundOpacityValue').textContent(), '56%');

    // 4) 自定义色回车也能应用，并出现“使用中”标记。
    await page.fill('#customThemeColorInput', '#7ab8a0');
    await page.press('#customThemeColorInput', 'Enter');
    await page.waitForTimeout(600);
    assert.equal(patches.at(-1).theme_profiles[0].theme_color, 'custom', 'enter applies the custom color');
    assert.equal(patches.at(-1).theme_profiles[0].custom_theme_color, '#7AB8A0', 'hex is normalised');
    assert.equal(await page.locator('#customThemeInUse').isVisible(), true, 'custom color shows an in-use badge');
    assert.equal(await page.locator('.theme-option.active').count(), 0, 'no preset claims to be active when using custom');

    // 5) 非法色值给出提示且不写库。
    const beforeInvalid = patches.length;
    await page.fill('#customThemeColorInput', '#12');
    await page.click('#useCustomThemeButton');
    await page.waitForTimeout(300);
    assert.equal(patches.length, beforeInvalid, 'invalid hex does not persist');
    assert.match(await page.locator('#toastRegion').innerText(), /HEX/);

    // 6) 另存为新方案：以后当前外观建一套并切过去。
    page.once('dialog', (dialog) => dialog.accept('通勤'));
    await page.click('#saveThemeProfileButton');
    await page.waitForTimeout(700);
    const saved = patches.at(-1);
    assert.equal(saved.theme_profiles.length, 3, 'another profile is appended');
    const created = saved.theme_profiles.find((profile) => profile.name === '通勤');
    assert.ok(created, 'new profile carries the typed name');
    assert.equal(created.custom_theme_color, '#7AB8A0', 'new profile starts from the current look');
    assert.equal(saved.active_theme_profile, created.id, 'new profile becomes active');
    assert.equal(await page.locator('#themeProfileInput').inputValue(), created.id, 'dropdown follows');

    // 7) 切换方案立即生效（不需要保存按钮）。
    const beforeSwitch = patches.length;
    await page.selectOption('#themeProfileInput', 'night');
    await page.waitForTimeout(700);
    assert.ok(patches.length > beforeSwitch, 'switching persists immediately');
    assert.equal(await page.locator('.theme-option.active').getAttribute('data-theme-value'), 'indigo', 'switching restores that profile colors');

    // 8) 删除确认写明会切到哪一套。
    let confirmText = '';
    page.once('dialog', (dialog) => { confirmText = dialog.message(); dialog.dismiss(); });
    await page.click('#deleteThemeProfileButton');
    await page.waitForTimeout(300);
    assert.match(confirmText, /删除后会切换到/, 'confirm names the fallback profile');
    assert.match(confirmText, /无法撤销/, 'confirm warns about irreversibility');

    assert.deepEqual(errors, [], 'no page errors');
    console.log('Theme profiles: single-profile guard, instant persist (color/opacity/custom/switch), save-as-new, delete confirm passed.');
  } finally {
    await browser.close();
    server.close();
  }
})().catch((error) => { console.error(error); process.exit(1); });
