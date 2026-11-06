// 详情页「更多站点」总链接：渲染、弹窗、搜索、跳转与固定到详情页。
const fs = require('fs');
const assert = require('node:assert/strict');
const { chromium } = require('C:/Users/han/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

const read = (path) => fs.readFileSync(path, 'utf8');

const harness = `
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const escapeHtml = (value) => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const state = {
  settings: {
    bgm_site_base: 'https://bgm.tv',
    detail_links: [
      { id: 'bgm', kind: 'bgm', name: 'Bangumi #{id}', url: '{site}/subject/{id}', enabled: true },
      { id: 'bili', kind: 'bilibili', name: 'B站搜索', url: 'https://search.bilibili.com/all?keyword={title}', enabled: true },
    ],
  },
};
function enabledSetting(key) { return state.settings[key] !== false; }
window.__toasts = [];
function toast(message) { window.__toasts.push(message); }
window.__opened = [];
window.open = (url) => { window.__opened.push(url); return null; };
window.__jumps = [];
function recordJump(item) { window.__jumps.push(item); }
window.__apiCalls = [];
async function api(path, options) {
  window.__apiCalls.push([path, options?.method || 'GET', options?.body]);
  if (path === '/api/settings') {
    const body = JSON.parse(options.body);
    state.settings = { ...state.settings, ...body };
    return { settings: state.settings };
  }
  throw new Error('unexpected ' + path);
}
window.__rules = [
  { id: 'rule-a', name: 'Alpha', host: 'alpha.test', template: 'https://alpha.test/s?wd={title}' },
  { id: 'rule-b', name: 'Beta', host: 'beta.test', template: 'https://beta.test/s?wd={title}' },
  { id: 'rule-c', name: 'Gamma', host: 'gamma.test', template: 'https://gamma.test/s?wd={title}' },
];
const linkRulesState = { items: window.__rules, selected: new Set(), loading: false, error: '', fetchedAt: 1700000000, limit: 12 };
async function loadLinkRules() { return linkRulesState.items; }
`;

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 820 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setContent(read('static/index.html').replace(/<script[\s\S]*?<\/script>/g, '').replace(/<link[^>]*>/g, ''));
    await page.addScriptTag({
      content: harness + '\n' + read('static/modules/video-links.js') + '\n' + read('static/modules/rules-menu.js'),
    });

    // 1) 默认链接列表里自动补上「更多站点」，渲染成按钮而不是链接。
    const links = await page.evaluate(() => detailLinks().map((link) => link.kind));
    assert.deepEqual(links, ['bgm', 'bilibili', 'saved_video', 'rules_menu'], 'built-in entries are added');
    // 详情链接在详情弹窗里，先打开它才可见。
    await page.evaluate(() => {
      const dialog = document.querySelector('#progressModal');
      if (dialog && !dialog.open) dialog.showModal();
    });
    await page.evaluate(() => renderDetailLinks({ id: 1, name_cn: '测试番剧' }));
    assert.equal(await page.locator('#detailLinks .detail-link-menu').count(), 1);
    assert.match(await page.locator('#detailLinks .detail-link-menu').textContent(), /更多站点/);
    assert.equal(await page.locator('#detailLinks a').count(), 2, '默认只渲染 bangumi + bilibili，已存视频默认关闭');

    // 2) 点开弹窗，列出本地缓存的站点。
    await page.locator('#detailLinks .detail-link-menu').click();
    assert.equal(await page.locator('#rulesMenuModal').evaluate((node) => node.open), true);
    assert.equal(await page.locator('#rulesMenuList .rules-menu-row').count(), 3);
    assert.match(await page.locator('#rulesMenuTitle').textContent(), /测试番剧/);
    assert.match(await page.locator('#rulesMenuStatus').textContent(), /共 3 个站点/);

    // 3) 搜索按名称与域名过滤。
    await page.fill('#rulesMenuSearch', 'beta');
    await page.evaluate(() => renderRulesMenu());
    assert.equal(await page.locator('#rulesMenuList .rules-menu-row').count(), 1);
    await page.fill('#rulesMenuSearch', 'gamma.test');
    await page.evaluate(() => renderRulesMenu());
    assert.equal(await page.locator('#rulesMenuList .rules-menu-row').count(), 1, 'host search works');
    await page.fill('#rulesMenuSearch', '');
    await page.evaluate(() => renderRulesMenu());

    // 4) 点站点跳转：新标签地址带 {title} 编码，并记一次跳转。
    await page.locator('#rulesMenuList .rules-menu-row').first().locator('.rules-menu-open').click();
    const opened = await page.evaluate(() => window.__opened);
    assert.equal(opened.length, 1);
    assert.equal(opened[0], `https://alpha.test/s?wd=${encodeURIComponent('测试番剧')}`);
    assert.equal(await page.locator('#rulesMenuModal').evaluate((node) => node.open), false, 'jump closes the dialog');
    assert.equal((await page.evaluate(() => window.__jumps.length)), 1);

    // 5) 固定：写库、回到详情页立刻多一条，按钮变成已固定。
    await page.locator('#detailLinks .detail-link-menu').click();
    const freeRow = page.locator('#rulesMenuList .rules-menu-row').filter({ has: page.locator('.rules-menu-pin:not(:disabled)') }).first();
    await freeRow.locator('.rules-menu-pin').click();
    await page.waitForTimeout(200);
    const calls = await page.evaluate(() => window.__apiCalls);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], '/api/settings');
    const saved = JSON.parse(calls[0][2]).detail_links;
    assert.deepEqual(saved.map((link) => link.kind), ['bgm', 'bilibili', 'saved_video', 'rules_menu', 'custom']);
    assert.equal(saved.at(-1).name, 'Alpha');
    assert.equal(saved.at(-1).url, 'https://alpha.test/s?wd={title}');
    assert.equal(saved.at(-1).enabled, true);
    assert.equal(await page.locator('#detailLinks a').count(), 3, 'bgm + bilibili + 新固定的 Alpha（已存视频默认关闭）');
    assert.match(await page.locator('#detailLinks').textContent(), /Alpha/);
    assert.equal(await page.locator('#rulesMenuList .rules-menu-pin:disabled').count(), 1);
    assert.equal(await page.locator('#rulesMenuList .rules-menu-row').first().locator('.rules-menu-pin').textContent(), '✓');

    // 6) 满上限时拒绝固定并提示先删。
    await page.evaluate(() => {
      state.settings.detail_links = Array.from({ length: 12 }, (_, index) => ({
        id: 'x' + index, kind: 'custom', name: 'x' + index, url: 'https://x' + index + '.test/?q={title}', enabled: true,
      }));
      window.__toasts = [];
      window.__apiCalls = [];
      openRulesMenu({ id: 1, name_cn: '测试番剧' });
    });
    await page.waitForTimeout(150);
    const freeFull = page.locator('#rulesMenuList .rules-menu-row').filter({ has: page.locator('.rules-menu-pin:not(:disabled)') }).first();
    await freeFull.locator('.rules-menu-pin').click();
    assert.equal((await page.evaluate(() => window.__apiCalls.length)), 0, 'no write when full');
    assert.match(await page.evaluate(() => window.__toasts.at(-1)), /最多 12 条/);

    // 7) 没有规则缓存时给出引导，而不是空白。
    await page.evaluate(() => {
      linkRulesState.items = [];
      renderRulesMenu();
    });
    assert.match(await page.locator('#rulesMenuList').textContent(), /检查规则更新/);

    assert.deepEqual(errors, [], 'no page errors');
    console.log('Rules menu: built-in entry renders as a button, lists cached stations, filters by name/host, opens the site with the encoded title, pins a station into the detail row, and refuses to exceed the link limit.');
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
