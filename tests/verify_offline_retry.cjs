// 归档失败的任务可以在「本地文件」页直接点「重试归档」。
const fs = require('fs');
const assert = require('node:assert/strict');
const { chromium } = require('C:/Users/han/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

const html = fs.readFileSync('static/index.html', 'utf8');
const start = html.indexOf('<dialog class="modal offline-modal" id="offlineModal">');
const end = html.indexOf('</dialog>', start) + '</dialog>'.length;
assert(start > 0 && end > start);
const modal = html.slice(start, end);

const setup = `
const $=(s,r=document)=>r.querySelector(s),$$=(s,r=document)=>[...r.querySelectorAll(s)];
const escapeHtml=v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const state={progressAnime:null,settings:{}};
const toast=()=>{};
window.requests=[];
window.api=async(url,options)=>{
  requests.push({url,body:options&&options.body});
  if(url.includes('/api/offline/state')) return {files:[],jobs:[]};
  return {ok:true};
};
`;

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setContent(`<style>${fs.readFileSync('static/styles.css', 'utf8')}</style>${modal}`);
    await page.addScriptTag({ content: setup + fs.readFileSync('static/modules/offline.js', 'utf8') });
    // 动态注入时 DOMContentLoaded 已经过去，手动补一次让 offline.js 完成事件绑定。
    await page.evaluate(() => document.dispatchEvent(new Event('DOMContentLoaded')));
    await page.evaluate(() => {
      offlineView.animeId = 554779;
      offlineView.local = {
        files: [],
        jobs: [
          { id: 3, status: 'failed', error: '归档失败：下载目录里没有找到视频文件', torrent_name: '测试番 [05].mp4', progress: 100, archive_retries: 2 },
          { id: 4, status: 'failed', error: '归档失败：只入库 1/12 集', torrent_name: '测试番 合集', progress: 100, archive_retries: 5 },
        ],
      };
      renderOfflineLocal();
      // 本地文件标签现在默认是「我的库」总览。这个测试的 mock 数据不能被
      // openAnimeLocalView 的真实请求覆盖，只做纯视图切换。
      offlineView.libraryMode = false;
      showLibraryChrome(false);
      document.querySelector('#offlineLibraryBack').classList.remove('hidden');
      switchOfflineTab("local");
      $("#offlineModal").showModal();
    });

    assert.match(await page.locator('#offlineLocalList').textContent(), /出问题了 · 2/);
    // 提示分两档：还在自动重试 → 说明会自己再试；到上限 → 说明要人处理。
    const hints = await page.locator('#offlineLocalList .offline-row-hint').allTextContents();
    assert.match(hints[0], /还会自动再试（已用 2\/5 次）/, `retrying hint: ${hints[0]}`);
    assert.match(hints[1], /自动重试已用完/, `exhausted hint: ${hints[1]}`);
    assert.ok(hints.every((text) => text.includes('只补缺的')), 'hint explains that ingested episodes are skipped');
    const retry = page.locator('#offlineLocalList [data-retry="3"]');
    assert.equal(await retry.count(), 1, 'failed row has a retry button');
    assert.equal(await retry.textContent(), '重试归档');
    await retry.click();
    await page.waitForTimeout(80);
    const posted = await page.evaluate(() => window.requests.filter((item) => item.url === '/api/offline/retry'));
    assert.equal(posted.length, 1, 'click posts the retry endpoint');
    assert.deepEqual(JSON.parse(posted[0].body), { media_id: 3 });
    assert.equal(await page.locator('#offlineLocalList [data-retry="3"]').textContent(), '整理中…');
    assert.deepEqual(errors, [], 'no page errors');
    console.log('Offline retry: failed row offers a retry button that posts the media id.');
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exit(1); });
