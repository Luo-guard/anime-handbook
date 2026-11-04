// 自定义收藏夹映射：设置里的映射/重命名，以及移入菜单的连续多选。
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

function anime(id, name, category, collections) {
  return {
    id,
    name,
    name_cn: name,
    display_name: name,
    summary: '',
    air_date: '2026-01-01',
    image_url: '',
    collection_type: category,
    active: 1,
    active_episode_count: 12,
    episode_count: 12,
    episodes: [],
    watched_episodes: [],
    watched_count: 0,
    custom_collection_ids: collections,
    in_custom_collection: collections.length > 0,
    episode_summary: '本篇 12',
    bgm_score: 8.2,
    bgm_rank: 100,
    bgm_rating_total: 500,
  };
}

const ANIMES = [anime(501, '测试番剧', 1, [1])];
const COLLECTIONS = [
  { id: 1, name: '通勤', count: 1, created_at: '2026-11-01T10:00:00+08:00', updated_at: '2026-11-01T10:00:00+08:00', kazumi_category: 2 },
  { id: 2, name: '随手', count: 0, created_at: '2026-11-01T10:01:00+08:00', updated_at: '2026-11-01T10:01:00+08:00', kazumi_category: null },
];
const SETTINGS = {
  theme_color: 'forest',
  custom_theme_color: '#2E6D4E',
  custom_background_overlay_opacity: 82,
  active_theme_profile: 'default',
  theme_profiles: [
    { id: 'default', name: '森野', theme_color: 'forest', custom_theme_color: '#2E6D4E', custom_background_enabled: false, custom_background_version: 0, custom_background_overlay_opacity: 82 },
    { id: 'night', name: '夜间', theme_color: 'indigo', custom_theme_color: '#5269B6', custom_background_enabled: false, custom_background_version: 0, custom_background_overlay_opacity: 78 },
  ],
  show_all_collection_tab: true,
  collection_home: 'builtin:1',
  hide_custom_collection_items_from_builtin: false,
  sidebar_order: ['collection', 'schedule', 'timeline', 'statistics', 'ranking', 'settings'],
  sidebar_visibility: {},
};
const patched = [];

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const pathname = url.pathname;
  const send = (code, body, type = 'application/json') => {
    res.writeHead(code, { 'Content-Type': type });
    // Buffer 必须原样写出，否则会被 JSON.stringify 成 {"type":"Buffer"}。
    res.end(Buffer.isBuffer(body) || typeof body === 'string' ? body : JSON.stringify(body));
  };
  if (pathname === '/api/bootstrap') {
    return send(200, {
      settings: SETTINGS,
      animes: ANIMES,
      custom_collections: COLLECTIONS,
      ranking_boards: [],
      ranking_templates: [],
      stats: { custom_collection_counts: { '1': 1, '2': 0 }, anime_total: 1, category_counts: {}, today_episode_total: 0, watched_episode_total: 0 },
      sync: { running: false },
      revision: 1,
    });
  }
  if (pathname === '/api/status') {
    return send(200, { sync: { running: false }, stats: {}, revision: 1 });
  }
  if (pathname === '/api/settings' && req.method === 'PATCH') {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      patched.push({ type: 'settings', body });
      Object.assign(SETTINGS, body);
      send(200, { ok: true, settings: SETTINGS, stats: {}, sync: { running: false }, revision: 1 });
    });
    return;
  }
  if (pathname.startsWith('/api/custom-collections') && req.method === 'PATCH') {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      const id = Number(pathname.split('/').pop());
      patched.push({ type: 'patch', id, body });
      const target = COLLECTIONS.find((item) => item.id === id);
      if (target) {
        if ('name' in body) target.name = body.name;
        if ('kazumi_category' in body) target.kazumi_category = body.kazumi_category;
      }
      send(200, { ok: true, collection: target, custom_collections: COLLECTIONS });
    });
    return;
  }
  if (pathname.match(/^\/api\/custom-collections\/\d+\/items$/) && req.method === 'POST') {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      const id = Number(pathname.split('/')[3]);
      patched.push({ type: 'add', id, anime_id: body.anime_id });
      const target = COLLECTIONS.find((item) => item.id === id);
      const row = ANIMES[0];
      if (!row.custom_collection_ids.includes(id)) row.custom_collection_ids.push(id);
      row.in_custom_collection = true;
      if (target?.kazumi_category) {
        row.collection_type = target.kazumi_category;
        row.mapped_category = target.kazumi_category;
      }
      send(200, { ok: true, anime: { ...row }, custom_collections: COLLECTIONS, stats: {} });
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
    await page.waitForTimeout(1800);

    // 1) 设置里每个收藏夹都有映射下拉，值等于已保存的映射。
    await page.click('#settingsButton');
    await page.waitForSelector('#settingsModal[open]');
    await page.click('[data-settings-tab="collection"]');
    await page.waitForTimeout(300);
    const rows = page.locator('#settingsCustomCollections .custom-setting-item');
    assert.equal(await rows.count(), 2, 'each custom collection has a row');
    assert.equal(await page.locator('.custom-map-select[data-id="1"]').inputValue(), '2', 'mapped collection shows its target');
    assert.equal(await page.locator('.custom-map-select[data-id="2"]').inputValue(), '', 'unmapped collection shows 不映射');
    const options = await page.locator('.custom-map-select[data-id="1"] option').allTextContents();
    assert.deepEqual(options, ['不映射', '在看', '想看', '搁置', '看过', '抛弃']);

    // 2) 改映射会立刻 PATCH，并且只带这一个字段。
    await page.selectOption('.custom-map-select[data-id="2"]', '4');
    await page.waitForTimeout(500);
    const mapPatch = patched.at(-1);
    assert.equal(mapPatch.type, 'patch');
    assert.equal(mapPatch.id, 2);
    assert.deepEqual(mapPatch.body, { kazumi_category: 4 }, 'only the mapping field travels');
    assert.match(await page.locator('#toastRegion').innerText(), /映射/);

    // 3) 取消映射传 null。
    await page.selectOption('.custom-map-select[data-id="2"]', '');
    await page.waitForTimeout(500);
    assert.deepEqual(patched.at(-1).body, { kazumi_category: null });

    // 4) 重命名走同一个接口，只带 name。
    page.once('dialog', (dialog) => dialog.accept('地铁'));
    await page.click('.rename-custom-collection[data-id="2"]');
    await page.waitForTimeout(500);
    assert.deepEqual(patched.at(-1).body, { name: '地铁' });
    assert.equal(
      await page.locator('.custom-setting-item[data-collection-id="2"] .custom-setting-name').textContent().then((text) => text.includes('地铁')),
      true,
    );

    // 5) 点卡片切主题立即生效；随后改映射不会把主题状态带回去。
    await page.click('[data-settings-tab="main"]');
    await page.waitForTimeout(200);
    await page.locator('[data-theme-pick="night"]').click();
    await page.waitForTimeout(500);
    await page.click('[data-settings-tab="collection"]');
    await page.waitForTimeout(200);
    await page.selectOption('.custom-map-select[data-id="1"]', '3');
    await page.waitForTimeout(500);
    assert.equal(await page.evaluate(() => state.settings.theme_color), 'indigo', 'theme switch survives collection edits');
    await page.evaluate(() => { document.querySelector('#settingsModal').close(); });
    await page.waitForTimeout(300);

    // 6) 移入菜单：勾选一个后菜单不关闭，可以继续勾第二个。
    await page.evaluate(() => {
      const anchor = document.querySelector('#collectionSearchButton');
      openCustomMoveMenu(501, anchor);
    });
    await page.waitForSelector('#customMoveMenu');
    // 上一步把 1 号收藏夹改成了「搁置」，菜单应立刻反映最新映射。
    const menuMap = await page.locator('#customMoveMenu .move-menu-map').allTextContents();
    assert.deepEqual(menuMap, ['→ 搁置'], 'menu shows the latest mapping');
    const first = page.locator('.move-menu-check[data-collection-id="1"]');
    const second = page.locator('.move-menu-check[data-collection-id="2"]');
    assert.equal(await first.isChecked(), true, 'existing membership is checked');
    assert.equal(await second.isChecked(), false);
    await second.click();
    await page.waitForTimeout(500);
    assert.ok(await page.locator('#customMoveMenu').count(), 'menu stays open after a pick');
    assert.equal(await first.isChecked(), true, 'previous membership kept');
    assert.equal(await second.isChecked(), true, 'new membership checked in place');
    const adds = patched.filter((item) => item.type === 'add');
    assert.deepEqual(adds.map((item) => item.id), [2], 'only the clicked collection is added');
    assert.match(await page.locator('#toastRegion').innerText(), /Kazumi/);

    // 7) 取消勾选后菜单仍然开着。
    await first.click();
    await page.waitForTimeout(500);
    assert.ok(await page.locator('#customMoveMenu').count(), 'menu stays open after removal');

    assert.deepEqual(errors, [], 'no page errors');
    console.log('Collection mapping: settings dropdown, rename, immediate persist, unsaved settings preserved, multi-select move menu passed.');
  } finally {
    await browser.close();
    server.close();
  }
})().catch((error) => { console.error(error); process.exit(1); });
