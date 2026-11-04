// 主题方案：卡片即时切换、独立编辑面板、取消回滚、背景延迟上传、删除与同名保护。
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
    { id: 'default', name: 'v家', theme_color: 'slate', custom_theme_color: '#F5C1CA', custom_background_enabled: false, custom_background_version: 0, custom_background_overlay_opacity: 0 },
    { id: 'night', name: '夜间深色', theme_color: 'indigo', custom_theme_color: '#5269B6', custom_background_enabled: false, custom_background_version: 0, custom_background_overlay_opacity: 78 },
  ],
  active_theme_profile: 'default',
  theme_color: 'slate',
  custom_theme_color: '#F5C1CA',
  custom_background_enabled: false,
  custom_background_version: 0,
  custom_background_overlay_opacity: 0,
  theme_random_on_open: false,
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
const uploads = [];

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://x').pathname;
  const send = (code, body, type = 'application/json') => {
    res.writeHead(code, { 'Content-Type': type });
    res.end(Buffer.isBuffer(body) || typeof body === 'string' ? body : JSON.stringify(body));
  };
  if (pathname === '/api/bootstrap') return send(200, BOOT);
  if (pathname === '/api/status') return send(200, { sync: { running: false }, stats: {}, revision: 1 });
  if (pathname === '/api/background' && req.method === 'GET') return send(200, PNG, 'image/png');
  if (pathname === '/api/background' && req.method === 'POST') {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      uploads.push({ profile_id: body.profile_id, bytes: String(body.data || '').length });
      SETTINGS.custom_background_enabled = true;
      SETTINGS.custom_background_version = 12345;
      send(200, { ok: true, settings: SETTINGS });
    });
    return;
  }
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

    // 1) 主题页只留卡片；保存按钮在这一页隐藏。
    assert.equal(await page.locator('#saveSettings').isVisible(), false, 'theme tab hides the footer save button');
    assert.equal(await page.locator('.theme-card-main').count(), 2, 'one card per saved profile');
    assert.equal(await page.locator('#newThemeCard').count(), 1, 'dashed new-theme card follows the list');
    assert.equal(await page.locator('.theme-card.is-active').getAttribute('data-theme-card'), 'default');
    await page.click('[data-settings-tab="interface"]');
    await page.waitForTimeout(150);
    assert.equal(await page.locator('#saveSettings').isVisible(), true, 'interface tab keeps the footer save button');
    await page.click('[data-settings-tab="theme"]');
    await page.waitForTimeout(150);

    // 2) 只剩一套时，所有删除按钮都禁用并说明原因。
    const single = await page.evaluate(() => {
      const saved = state.settings.theme_profiles;
      state.settings.theme_profiles = [saved[0]];
      renderThemeControls();
      const buttons = [...document.querySelectorAll('[data-theme-delete]')];
      const result = { disabled: buttons.map((button) => button.disabled), title: buttons[0]?.title || "" };
      state.settings.theme_profiles = saved;
      renderThemeControls();
      return result;
    });
    assert.deepEqual(single.disabled, [true], 'single profile disables delete');
    assert.match(single.title, /至少要保留/, 'disabled delete explains why');

    // 3) 点卡片立即切换并写库。
    const beforeSwitch = patches.length;
    await page.locator('[data-theme-pick="night"]').click();
    await page.waitForTimeout(700);
    assert.equal(patches.length, beforeSwitch + 1, 'card click persists once');
    assert.equal(patches.at(-1).active_theme_profile, 'night');
    assert.equal(patches.at(-1).theme_color, 'indigo');
    assert.equal(await page.locator('.theme-card.is-active').getAttribute('data-theme-card'), 'night');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'indigo');

    // 4) 编辑器回填；改色只预览不写库，取消要回滚。
    await page.locator('[data-theme-edit="default"]').click();
    await page.waitForTimeout(300);
    assert.equal(await page.locator('#themeEditorModal').evaluate((node) => node.open), true);
    assert.equal(await page.locator('#themeEditorName').inputValue(), 'v家');
    assert.equal(await page.locator('.theme-option.active').getAttribute('data-theme-value'), 'slate');
    assert.equal(await page.locator('#themeEditorBackgroundPreview').getAttribute('data-label'), '纯色背景');
    const beforePreview = patches.length;
    await page.locator('.theme-option[data-theme-value="rose"]').click();
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'rose', 'editor previews live');
    assert.equal(await page.locator('#themeEditorName').inputValue(), 'v家', 'color clicks must not clear the typed name');
    assert.equal(patches.length, beforePreview, 'preview does not persist');
    await page.locator('#themeEditorCancel').click();
    await page.waitForTimeout(300);
    assert.equal(await page.locator('#themeEditorModal').evaluate((node) => node.open), false);
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'indigo', 'cancel restores the previous look');
    assert.equal(patches.length, beforePreview, 'cancel writes nothing');

    // 5) 新建主题：配色与背景都在保存时一次写入，背景图延迟上传。
    await page.locator('#newThemeCard').click();
    await page.waitForTimeout(300);
    assert.equal(await page.locator('#themeEditorTitle').textContent(), '新建主题');
    assert.equal(await page.locator('#themeEditorName').inputValue(), '');
    await page.fill('#themeEditorName', '通勤');
    await page.locator('.theme-option[data-theme-value="teal"]').click();
    await page.setInputFiles('#customBackgroundInput', { name: 'bg.png', mimeType: 'image/png', buffer: PNG });
    await page.waitForTimeout(400);
    assert.equal(uploads.length, 0, 'selecting an image does not upload yet');
    assert.match(await page.locator('#customBackgroundName').textContent(), /待上传/);
    assert.equal(await page.locator('#themeEditorBackgroundPreview').getAttribute('data-label'), '背景预览');
    const beforeSave = patches.length;
    await page.locator('#themeEditorSave').click();
    await page.waitForTimeout(1200);
    assert.equal(await page.locator('#themeEditorModal').evaluate((node) => node.open), false, 'save closes the editor');
    assert.equal(uploads.length, 1, 'background uploads on save');
    const createdId = patches.at(-1).active_theme_profile;
    assert.match(uploads[0].profile_id, /^theme_/, 'upload targets the new profile id');
    assert.equal(patches.length, beforeSave + 1, 'one settings patch after upload');
    const created = patches.at(-1).theme_profiles.find((profile) => profile.name === '通勤');
    assert.ok(created, 'new profile is appended');
    assert.equal(created.theme_color, 'teal');
    assert.equal(created.custom_background_enabled, true);
    assert.equal(created.custom_background_version, 12345);
    assert.equal(created.id, createdId);
    assert.equal(await page.locator('.theme-card-main').count(), 3);
    assert.equal(await page.locator(`.theme-card.is-active[data-theme-card="${createdId}"]`).count(), 1);
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'teal');
    assert.equal(await page.locator('.theme-card img').count(), 1, 'card shows the uploaded background');

    // 6) 同名保护：不新增方案，也不写库。
    const beforeDuplicate = patches.length;
    await page.locator('#newThemeCard').click();
    await page.fill('#themeEditorName', '通勤');
    await page.locator('#themeEditorSave').click();
    await page.waitForTimeout(500);
    assert.match(await page.locator('#toastRegion').innerText(), /已有同名主题/);
    assert.equal(patches.length, beforeDuplicate, 'duplicate name does not persist');
    assert.equal(await page.locator('#themeEditorModal').evaluate((node) => node.open), true);
    await page.locator('#themeEditorCancel').click();

    // 7) 编辑并保存：覆盖原名与配色，不新增方案；重命名就在名称字段里。
    await page.locator(`[data-theme-edit="${createdId}"]`).click();
    await page.waitForTimeout(200);
    await page.fill('#themeEditorName', '通勤改');
    await page.locator('.theme-option[data-theme-value="rose"]').click();
    await page.locator('#themeEditorSave').click();
    await page.waitForTimeout(1000);
    assert.equal(patches.at(-1).theme_profiles.length, 3, 'editing does not append another profile');
    const edited = patches.at(-1).theme_profiles.find((profile) => profile.id === createdId);
    assert.equal(edited.name, '通勤改');
    assert.equal(edited.theme_color, 'rose');
    assert.equal(patches.at(-1).active_theme_profile, createdId);
    assert.equal(await page.locator(`.theme-card[data-theme-card="${createdId}"] .theme-card-meta strong`).innerText(), '通勤改');

    // 8) 非法色值只提示，不写库。
    await page.locator(`[data-theme-edit="${createdId}"]`).click();
    await page.waitForTimeout(200);
    await page.fill('#customThemeColorInput', '#12');
    const beforeInvalid = patches.length;
    await page.locator('#useCustomThemeButton').click();
    await page.waitForTimeout(300);
    assert.match(await page.locator('#toastRegion').innerText(), /HEX/);
    assert.equal(patches.length, beforeInvalid);
    await page.locator('#themeEditorCancel').click();

    // 9) 选图后取消：不上传、不新增方案。
    const beforeCancelUpload = uploads.length;
    await page.locator('#newThemeCard').click();
    await page.fill('#themeEditorName', '取消测试');
    await page.setInputFiles('#customBackgroundInput', { name: 'bg.png', mimeType: 'image/png', buffer: PNG });
    await page.waitForTimeout(300);
    await page.locator('#themeEditorCancel').click();
    await page.waitForTimeout(300);
    assert.equal(uploads.length, beforeCancelUpload, 'cancel leaves no uploaded file');
    assert.equal(await page.locator('.theme-card-main').count(), 3);

    // 10) 删除确认写明会切到哪一套。
    let confirmText = '';
    page.once('dialog', (dialog) => { confirmText = dialog.message(); dialog.accept(); });
    await page.locator(`[data-theme-delete="${createdId}"]`).click();
    await page.waitForTimeout(700);
    assert.match(confirmText, /删除后会切换到/, 'confirm names the fallback profile');
    assert.match(confirmText, /无法撤销/, 'confirm warns about irreversibility');
    assert.equal(await page.locator('.theme-card-main').count(), 2);
    assert.equal(patches.at(-1).theme_profiles.length, 2);
    assert.notEqual(patches.at(-1).active_theme_profile, createdId);

    // 11) 刷新后仍是卡片上的那套方案。
    await page.reload({ waitUntil: 'load' });
    await page.waitForTimeout(1600);
    await page.click('#settingsButton');
    await page.waitForSelector('#settingsModal[open]');
    await page.waitForTimeout(300);
    assert.equal(await page.locator('.theme-card.is-active').count(), 1);
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'slate');

    assert.deepEqual(errors, [], 'no page errors');
    console.log('Theme profiles: cards switch instantly, footer hidden, editor preview/cancel rollback, delayed background upload, duplicate guard, delete confirm, reload persistence passed.');
  } finally {
    await browser.close();
    server.close();
  }
})().catch((error) => { console.error(error); process.exit(1); });
