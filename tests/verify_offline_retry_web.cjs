// 网站资源下载失败后：那一集留在「出问题了」里，能原地重试，不必回播放器。
const fs = require('fs');
const assert = require('node:assert/strict');
const { chromium } = require('C:/Users/han/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

const html = fs.readFileSync('static/index.html', 'utf8');
const start = html.indexOf('<dialog class="modal offline-modal" id="offlineModal">');
const end = html.indexOf('</dialog>', start) + '</dialog>'.length;
assert(start > 0 && end > start);
const modal = html.slice(start, end);

const jobs = [
  {
    id: 5, status: 'failed', source_kind: 'web', retryable: true,
    error: '解析这一集失败：未从播放页找到可用视频，请切换线路或规则',
    torrent_name: '网站资源 · 第 08 集', progress: 0,
  },
  {
    id: 6, status: 'failed', source_kind: 'web', retryable: false,
    error: '下载已中断（程序重启或任务被清理）',
    torrent_name: '网站资源 · 第 07 集', progress: 0,
  },
];

const setup = `
const $=(s,r=document)=>r.querySelector(s),$$=(s,r=document)=>[...r.querySelectorAll(s)];
const escapeHtml=v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const state={progressAnime:null,settings:{}};
const toast=(msg)=>{window.toasts=(window.toasts||[]).concat(String(msg));};
window.requests=[];
window.api=async(url,options)=>{
  requests.push({url,body:options&&options.body});
  if(url.includes('/api/offline/state')) return {files:[],jobs:${JSON.stringify(jobs)}};
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
    await page.evaluate(() => { window.loadOfflineSettings = () => {}; });
    await page.evaluate(() => document.dispatchEvent(new Event('DOMContentLoaded')));
    await page.evaluate((list) => {
      offlineView.animeId = 570583;
      offlineView.local = { files: [], jobs: list };
      offlineView.libraryMode = false;
      showLibraryChrome(false);
      document.querySelector('#offlineLibraryBack').classList.remove('hidden');
      switchOfflineTab('local');
      document.querySelector('#offlineModal').showModal();
      renderOfflineLocal();
    }, jobs);

    // 失败的两集都还在列表里，没有被隐藏
    assert.match(await page.locator('#offlineLocalList').textContent(), /出问题了 · 2/);
    assert.equal(await page.locator('#offlineLocalList .offline-row').count(), 2);

    // 有片源信息的：给「重试下载」，点了打新接口
    const retry = page.locator('#offlineLocalList [data-retry="5"]');
    assert.equal(await retry.count(), 1, '失败集要有重试按钮');
    assert.equal(await retry.textContent(), '重试下载');
    assert.equal(await retry.getAttribute('data-retry-kind'), 'web');
    await retry.click();
    await page.waitForTimeout(120);
    const posted = await page.evaluate(() => window.requests.filter((item) => item.url === '/api/offline/web-retry'));
    assert.equal(posted.length, 1, '点击要走原地重试接口');
    assert.deepEqual(JSON.parse(posted[0].body), { media_id: 5 });

    // 没有片源信息的老任务：不给按钮，但要告诉用户怎么补救
    assert.equal(await page.locator('#offlineLocalList [data-retry="6"]').count(), 0, '没有片源信息不该给死按钮');
    const hints = await page.locator('#offlineLocalList .offline-row-hint').allTextContents();
    assert.ok(hints.some((text) => text.includes('回到播放器')), `缺片源信息要给出口，实际：${hints}`);

    // 错误原因原样展示，不吞掉
    assert.match(await page.locator('#offlineLocalList').textContent(), /未从播放页找到可用视频/);

    assert.deepEqual(errors, []);
    console.log('ok: 失败的网站任务留在列表里，可原地重试，缺片源信息的给出明确出口');
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
