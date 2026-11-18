const assert = require('node:assert/strict');
const fs = require('node:fs');
const {chromium} = require('C:/Users/han/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

(async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({viewport:{width:390,height:740}});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent(fs.readFileSync('static/index.html','utf8').replace(/<script[\s\S]*?<\/script>|<link[^>]*>/g,''));
    await page.addStyleTag({content:fs.readFileSync('static/styles.css','utf8')});
    await page.addScriptTag({content:`
      const $ = (s, root = document) => root.querySelector(s);
      const $$ = (s, root = document) => [...root.querySelectorAll(s)];
      const escapeHtml = value => String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
      const state = {settings:{},active_profile:{id:'first'},animes:[
        {id:11,display_name:'例子',air_date:'2025-01-01'},
        {id:12,display_name:'例子 第二季',air_date:'2026-10-02'},
        {id:13,display_name:'单独的作品',air_date:'2026-04-02'},
      ]};
      const toast = () => {};
      const saveSubscriptionAutoDownload = () => {};
      const calls = [];
      let releaseOld;
      const rows = title => ({items:[{title,torrent_url:'magnet:?xt=test',group:'测试组'}]});
      async function api(path, options) {
        calls.push({path,body:options?.body && JSON.parse(options.body)});
        if (path.startsWith('/api/offline/search?')) {
          const query = new URL(path,'https://example.com').searchParams.get('q');
          if (query === '慢请求') return new Promise(resolve => { releaseOld = () => resolve(rows('已过期结果')); });
          return rows(query);
        }
        return {ok:true};
      }
      ${fs.readFileSync('static/modules/library-view.js','utf8')}
    `});
    assert.deepEqual(errors, []);
    await page.evaluate(() => {
      document.querySelector('#libraryView').classList.add('active');
      switchLibraryTab('search');
    });
    const query = page.locator('#libSearchQuery');
    const target = page.getByLabel('关联番剧', {exact:true});
    const download = page.locator('#libSearchResults .lib-download');
    const subscribe = page.locator('#libSearchResults .lib-subscribe');
    async function search(value) {
      await query.fill(value);
      await query.press('Enter');
      await page.locator('#libSearchResults').getByText(value, {exact:true}).waitFor();
    }
    await search('例子');
    assert.equal(await target.inputValue(), '');
    assert.match(await target.locator('option[value="12"]').textContent(), /第二季.*2026-10 首播/);
    assert.equal(await download.isDisabled(), true);
    assert.equal(await subscribe.isDisabled(), true);
    await target.selectOption('12');
    await download.click();
    assert.equal(await download.textContent(), '已提交');
    await target.selectOption('11');
    await subscribe.click();
    assert.deepEqual(await page.evaluate(() => calls.map(({path,body}) => [path.split('?')[0],body?.anime_id])), [
      ['/api/offline/search',undefined], ['/api/offline/download',12], ['/api/offline/subscribe',11],
    ]);
    await search('完全不匹配');
    assert.equal(await download.isDisabled(), true);
    await target.selectOption('13');
    assert.equal(await download.isEnabled(), true);
    await search('单独的作品');
    assert.equal(await target.inputValue(), '13');
    await query.fill('慢请求');
    await query.press('Enter');
    await search('例子 第二季');
    await page.evaluate(() => releaseOld());
    assert.equal(await page.locator('#libSearchResults b').textContent(), '例子 第二季');
    assert.equal(await target.inputValue(), '12');
    await query.fill('换个关键词');
    assert.equal(await target.isVisible(), false);
    assert.equal(await download.count(), 0);
    console.log('Resource search: ambiguous and manual targets, confirmed download/subscription IDs, one-hit default and stale results passed.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
