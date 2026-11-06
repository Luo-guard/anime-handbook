// 从 Kazumi 规则仓库导入跳转链接：渲染、搜索、上限、去重与草稿写入。
const fs = require('fs');
const assert = require('node:assert/strict');
const { chromium } = require('C:/Users/han/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

const source = fs.readFileSync('static/modules/settings.js', 'utf8');
const start = source.indexOf('// —— 从 Kazumi 规则仓库挑选跳转链接 ——');
assert(start > 0, 'settings.js must keep the link-rules block');

const harness = `
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const state = { settings: {} };
const escapeHtml = (value) => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
window.__toasts = [];
function toast(message) { window.__toasts.push(message); }
let detailLinkIdSeed = 0;
function detailLinkId() { detailLinkIdSeed += 1; return 'new-' + detailLinkIdSeed; }
// 当前编辑中的链接行，等价于设置页里的 detail_links 草稿。
window.__rows = [
  { id: 'saved', kind: 'saved_video', name: '已存视频', url: '', enabled: true },
  { id: 'bgm', kind: 'bgm', name: 'Bangumi', url: 'https://bgm.tv/subject/{id}', enabled: true },
];
window.__committed = [];
function editableLinks() { return window.__rows.map((row) => ({ ...row })); }
function commitLinkList(kind, rows) { window.__committed.push({ kind, rows }); window.__rows = rows; }
window.__apiCalls = [];
window.__cacheItems = [
  { id: 'rule-a', name: 'Alpha', host: 'alpha.test', template: 'https://alpha.test/s?wd={title}' },
  { id: 'rule-b', name: 'Beta', host: 'beta.test', template: 'https://beta.test/s?wd={title}' },
  { id: 'rule-c', name: 'Gamma', host: 'gamma.test', template: 'https://gamma.test/s?wd={title}' },
];
window.__refreshFails = false;
async function api(path, options) {
  window.__apiCalls.push([path, options?.method || 'GET']);
  if (path === '/api/link-rules') return { items: window.__cacheItems, limit: 5, fetched_at: 1700000000 };
  if (path === '/api/link-rules/refresh') {
    if (window.__refreshFails) throw new Error('连不上规则仓库');
    return { items: window.__cacheItems, limit: 5, fetched_at: 1700000001 };
  }
  throw new Error('unexpected ' + path);
}
`;

const expose = `
window.__rules = {
  state: linkRulesState,
  render: renderLinkRules,
  open: openLinkRules,
  load: loadLinkRules,
  add: addSelectedLinkRules,
  remaining: linkRulesRemaining,
};
`;

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 820 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setContent(
      fs.readFileSync('static/index.html', 'utf8').replace(/<script[\s\S]*?<\/script>/g, '').replace(/<link[^>]*>/g, '')
    );
    await page.addScriptTag({ content: harness + '\n' + source.slice(start) + '\n' + expose });

    // 1) 打开面板：先用缓存，不联网刷新。
    await page.evaluate(() => window.__rules.open());
    await page.waitForTimeout(250);
    assert.deepEqual(await page.evaluate(() => window.__apiCalls), [['/api/link-rules', 'GET']], 'opens from cache first');
    assert.equal(await page.locator('#linkRulesList .rules-row').count(), 3);
    assert.match(await page.locator('#linkRulesStatus').textContent(), /共 3 个站点可用/);
    assert.match(await page.locator('#linkRulesStatus').textContent(), /还能加 3 条/, 'limit 5 minus 2 existing rows');

    // 2) 搜索按名称与域名过滤。
    await page.fill('#linkRulesSearch', 'beta');
    await page.evaluate(() => window.__rules.render());
    assert.equal(await page.locator('#linkRulesList .rules-row').count(), 1);
    assert.match(await page.locator('#linkRulesList .rules-name').textContent(), /Beta/);
    await page.fill('#linkRulesSearch', 'gamma.test');
    await page.evaluate(() => window.__rules.render());
    assert.equal(await page.locator('#linkRulesList .rules-row').count(), 1, 'host search works too');
    await page.fill('#linkRulesSearch', '');
    await page.evaluate(() => window.__rules.render());

    // 3) 选中数量驱动按钮文案；勾选本身由 events.js 写进 selected，这里直接改状态。
    await page.evaluate(() => {
      window.__rules.state.selected.add('rule-a');
      window.__rules.state.selected.add('rule-b');
      window.__rules.render();
    });
    assert.match(await page.locator('#linkRulesAdd').textContent(), /添加选中的 2 个/);
    assert.equal(await page.locator('#linkRulesAdd').isDisabled(), false);
    assert.equal(await page.locator('#linkRulesList .rules-row.is-added').count(), 0);
    await page.evaluate(() => {
      window.__rules.state.selected.add('rule-c');
      window.__rules.render();
    });
    assert.match(await page.locator('#linkRulesAdd').textContent(), /添加选中的 3 个/);

    // 4) 添加：写入草稿、默认启用、模板带 {title}。
    await page.evaluate(() => window.__rules.add());
    const committed = await page.evaluate(() => window.__committed.at(-1));
    assert.equal(committed.kind, 'detail');
    assert.equal(committed.rows.length, 5, '2 existing + 3 added');
    const added = committed.rows.slice(2);
    assert.deepEqual(added.map((row) => row.name), ['Alpha', 'Beta', 'Gamma']);
    assert.deepEqual(added.map((row) => row.url), ['https://alpha.test/s?wd={title}', 'https://beta.test/s?wd={title}', 'https://gamma.test/s?wd={title}']);
    assert.deepEqual(added.map((row) => row.enabled), [true, true, true]);
    assert.deepEqual(added.map((row) => row.kind), ['custom', 'custom', 'custom']);

    // 5) 已经加过的站点标记为已添加，不可重复勾选。
    await page.evaluate(() => window.__rules.open());
    await page.waitForTimeout(200);
    assert.equal(await page.locator('#linkRulesList .rules-row.is-added').count(), 3);
    assert.equal(await page.locator('#linkRulesList .rules-row.is-added input:disabled').count(), 3);
    assert.match(await page.locator('#linkRulesList .rules-row.is-added .rules-host').first().textContent(), /已添加/);
    assert.match(await page.locator('#linkRulesStatus').textContent(), /还能加 0 条/, 'limit reached');

    // 6) 已经到上限时不写入，并提示先删。
    await page.locator('#linkRulesClose').click();
    await page.evaluate(() => {
      window.__rows = Array.from({ length: 5 }, (_, index) => ({ id: 'r' + index, kind: 'custom', name: 'x' + index, url: 'https://x' + index + '.test/?q={title}', enabled: true }));
      window.__committed = [];
      window.__toasts = [];
      window.__rules.state.selected = new Set(['rule-a']);
      window.__rules.add();
    });
    assert.equal(await page.evaluate(() => window.__committed.length), 0, 'no room, no write');
    assert.match(await page.evaluate(() => window.__toasts.at(-1)), /最多 5 条/);

    // 7) 刷新失败时保留旧列表并显示错误。
    await page.evaluate(() => {
      window.__refreshFails = true;
      window.__cacheItems = [];
      window.__rules.state.items = [];
      window.__rules.open();
    });
    await page.waitForTimeout(400);
    assert.match(await page.locator('#linkRulesStatus').textContent(), /连不上规则仓库/);
    assert.equal(await page.locator('#linkRulesAdd').isDisabled(), true);

    assert.deepEqual(errors, [], 'no page errors');
    console.log('Link rules: caches first, filters by name and host, caps at the detail-link limit, marks already-added rows, adds custom links with {title}, and reports a failed refresh.');
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
