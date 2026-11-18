const fs = require('node:fs');
const assert = require('node:assert/strict');
const {chromium} = require('C:/Users/han/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const html = fs.readFileSync('static/index.html', 'utf8').replace(/<script[\s\S]*?<\/script>/g, '').replace(/<link[^>]*>/g, '');
const harness = `
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const state = {animes: [], active_profile: {id: 'alpha'}};
const CATEGORIES = [];
function applyCollectionToolbarButtons() {}
function escapeHtml(s) {return String(s).replace(/[&<>"']/g, '');}
window.searchRequests = [];
async function api(path) {searchRequests.push(path); return {items: []};}
function toast() {}
`;
(async () => {
  const browser = await chromium.launch({headless: true});
  try {
    const context = await browser.newContext({viewport: {width: 1100, height: 850}});
    await context.route('http://history.test/**', route => route.fulfill({contentType: 'text/html', body: html}));
    async function setup(page, before = '') {
      await page.goto('http://history.test/');
      await page.addStyleTag({content: fs.readFileSync('static/styles.css', 'utf8')});
      await page.addScriptTag({content: harness + before});
      for (const name of ['collection-edit', 'collection-search-history']) {
        await page.addScriptTag({content: fs.readFileSync(`static/modules/${name}.js`, 'utf8')});
      }
      await page.evaluate(() => {$('#collectionSearchButton').click();});
    }
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await setup(page);
    const history = () => page.locator('.collect-history-query').allTextContents();
    async function search(value) {
      await page.locator('#collectionSearchQuery').fill(value);
      await page.locator('#collectionSearchSubmit').click();
    }
    assert.deepEqual(await history(), []);
    await search('  葬送的芙莉莲  ');
    await search('冰之城墙');
    await search('葬送的芙莉莲');
    assert.deepEqual(await history(), ['葬送的芙莉莲', '冰之城墙']);
    await page.locator('.collect-history-query').nth(1).click();
    assert.equal(await page.locator('#collectionSearchQuery').inputValue(), '冰之城墙');
    assert.equal(await page.evaluate(() => new URL(searchRequests.at(-1), location.origin).searchParams.get('q')), '冰之城墙');
    assert.deepEqual(await history(), ['冰之城墙', '葬送的芙莉莲']);
    await page.selectOption('#collectionSearchSort', 'score');
    assert.equal((await history()).length, 2);
    const count = await page.evaluate(() => searchRequests.length);
    await search('   ');
    assert.equal(await page.evaluate(() => searchRequests.length), count, 'whitespace does not call API');
    await page.locator('#collectionHistoryPause').click();
    await search('不记录的番剧');
    assert.equal((await history()).length, 2);
    const second = await context.newPage();
    await setup(second);
    assert.equal(await second.locator('#collectionHistoryPause').textContent(), '恢复记录', 'pause persists across reloads');
    assert.deepEqual(await second.locator('.collect-history-query').allTextContents(), await history());
    await second.close();
    await page.locator('#collectionHistoryPause').click();
    for (let i = 0; i < 23; i++) await search(`测试番剧 ${i}`);
    assert.equal((await history()).length, 6);
    await page.locator('#collectionHistoryExpand').click();
    assert.equal((await history()).length, 20);
    assert.equal((await history()).at(-1), '测试番剧 3');
    await search('<img src=x onerror="alert(1)">');
    assert.equal(await page.locator('#collectionHistoryList img').count(), 0, 'titles are text, never HTML');
    await page.locator('#collectionHistoryManage').click();
    const removed = (await history())[0];
    await page.locator('.collect-history-remove').first().click();
    assert.ok(!(await history()).includes(removed));
    assert.equal((await history()).length, 19);
    await page.evaluate(() => {state.active_profile = {id: 'beta'}; $('#collectionSearchModal').close(); $('#collectionSearchButton').click();});
    assert.deepEqual(await history(), [], 'profiles do not share history');
    await search('另一个档案');
    await page.evaluate(() => {state.active_profile.id = 'alpha'; $('#collectionSearchModal').close(); $('#collectionSearchButton').click();});
    assert.equal((await history()).length, 6);
    page.once('dialog', dialog => dialog.dismiss());
    await page.locator('#collectionHistoryClear').click();
    assert.equal((await history()).length, 6, 'cancel keeps history');
    // Review desktop and narrow layouts, including long titles and edit controls.
    await page.locator('#collectionHistoryManage').click();
    const output = process.env.TEMP || '.';
    await page.screenshot({path: `${output}/handbook-search-history-desktop.png`});
    await page.setViewportSize({width: 360, height: 740});
    await page.screenshot({path: `${output}/handbook-search-history-mobile.png`});
    assert.ok(await page.locator('#collectionSearchModal').evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'no horizontal overflow');
    page.once('dialog', dialog => dialog.accept());
    await page.locator('#collectionHistoryClear').click();
    assert.deepEqual(await history(), []);
    await page.reload();
    await setup(page, `localStorage.setItem('handbook:collection-search-history:alpha', '{broken');`);
    await search('仍可搜索');
    assert.deepEqual(await history(), ['仍可搜索'], 'corrupt storage recovers');
    const peer = await context.newPage();
    await setup(peer);
    await peer.locator('#collectionSearchQuery').fill('其他窗口的搜索');
    await peer.locator('#collectionSearchSubmit').click();
    await page.waitForFunction(() => document.querySelector('.collect-history-query')?.textContent === '其他窗口的搜索');
    await peer.close();
    const denied = await context.newPage();
    await setup(denied, `Storage.prototype.getItem = Storage.prototype.setItem = () => {throw new Error('blocked');};`);
    await denied.locator('#collectionSearchQuery').fill('无存储权限');
    await denied.locator('#collectionSearchSubmit').click();
    assert.deepEqual(await denied.locator('.collect-history-query').allTextContents(), ['无存储权限']);
    assert.deepEqual(errors, []);
    console.log('Search history passed: deduplication, replay, sorting, whitespace guard, 20-item limit, expansion, delete, clear/cancel, pause persistence, profile isolation, reload, cross-window sync, corrupt/blocked storage, safe text and narrow layout.');
  } finally {await browser.close();}
})().catch(error => {console.error(error); process.exitCode = 1;});
