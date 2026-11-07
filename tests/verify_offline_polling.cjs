// 审计 N2 + B11 残留 1：面板轮询的真实节奏。
// · 有任务在动 → 3 秒一次；
// · 全都静止 → 放慢到 15 秒（别让开着的面板一直压 qB）；
// · 面板关闭 / 页面切到后台 → 完全停；切回来立刻补一次。
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
window.stateCalls=0;
window.statePayload={files:[],jobs:[],archive_retry_limit:5};
window.api=async(url)=>{
  if(String(url).includes('/api/offline/state')){ window.stateCalls+=1; return window.statePayload; }
  return {ok:true};
};
`;

async function prepare(browser) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setContent(`<style>${fs.readFileSync('static/styles.css', 'utf8')}</style>${modal}`);
  await page.addScriptTag({ content: setup + fs.readFileSync('static/modules/offline.js', 'utf8') });
  await page.evaluate(() => document.dispatchEvent(new Event('DOMContentLoaded')));
  return { page, errors };
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    // 1) 节奏决策 + 真实计时：有任务在下载时 3 秒内至少刷一次。
    const { page, errors } = await prepare(browser);
    const delayActive = await page.evaluate(() => {
      offlineView.local = { files: [], jobs: [{ id: 1, status: 'downloading', progress: 42 }] };
      return offlinePollDelay();
    });
    const delayIdle = await page.evaluate(() => {
      offlineView.local = { files: [{ id: 9, episode_key: '0:1' }], jobs: [] };
      return offlinePollDelay();
    });
    const delayRetryLeft = await page.evaluate(() => {
      offlineView.local = { files: [], jobs: [{ id: 2, status: 'failed', error: '归档失败：x', archive_retries: 2 }] };
      return offlinePollDelay();
    });
    const delayExhausted = await page.evaluate(() => {
      offlineView.local = { files: [], jobs: [{ id: 3, status: 'failed', error: '归档失败：x', archive_retries: 5 }] };
      return offlinePollDelay();
    });
    assert.equal(delayActive, 3000, 'active download polls every 3s');
    assert.equal(delayIdle, 15000, 'nothing running slows down to 15s');
    assert.equal(delayRetryLeft, 3000, 'failed-but-still-retrying keeps the fast cadence');
    assert.equal(delayExhausted, 15000, 'exhausted retries no longer need 3s polling');

    await page.evaluate(() => {
      offlineView.animeId = 554779;
      offlineView.local = { files: [], jobs: [{ id: 1, status: 'downloading', progress: 42 }] };
      window.statePayload = { files: [], jobs: [{ id: 1, status: 'downloading', progress: 66 }], archive_retry_limit: 5 };
      window.stateCalls = 0;
      $('#offlineModal').showModal();
      setOfflinePolling(true);
    });
    await page.waitForTimeout(4200);
    const fast = await page.evaluate(() => ({ calls: window.stateCalls, retryLimit: offlineView.retryLimit }));
    assert.ok(fast.calls >= 1, `panel polls within ~3s while a download is active, got ${fast.calls}`);
    assert.equal(fast.retryLimit, 5, 'retry limit from the backend is remembered for the hint text');

    // 2) 关闭面板后不再请求。
    await page.evaluate(() => { $('#offlineModal').close(); });
    const beforeClose = await page.evaluate(() => window.stateCalls);
    await page.waitForTimeout(4000);
    const afterClose = await page.evaluate(() => window.stateCalls);
    assert.equal(afterClose, beforeClose, 'closing the panel stops polling entirely');

    // 3) 页面在后台时不请求；切回前台立刻补一次。
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      $('#offlineModal').showModal();
      setOfflinePolling(true);
      window.stateCalls = 0;
    });
    await page.waitForTimeout(4000);
    const whileHidden = await page.evaluate(() => window.stateCalls);
    assert.equal(whileHidden, 0, 'no polling while the tab is in the background');
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForTimeout(400);
    const afterVisible = await page.evaluate(() => window.stateCalls);
    assert.ok(afterVisible >= 1, 'coming back to the tab refreshes immediately');

    assert.deepEqual(errors, [], 'no page errors');
    await page.close();

    // 4) 慢响应不能覆盖新番：换番后旧请求返回要直接丢弃。
    const second = await prepare(browser);
    const page2 = second.page;
    await page2.evaluate(() => {
      window.resolvers = {};
      window.api = (url) => new Promise((resolve) => {
        const id = String(url).match(/anime_id=(\d+)/)?.[1] || '0';
        window.resolvers[id] = () => resolve({ files: [{ id: Number(id), episode_key: '0:1' }], jobs: [], archive_retry_limit: 5 });
      });
    });
    await page2.evaluate(() => {
      offlineView.animeId = 1;
      const stale = refreshOfflineLocal();      // 旧番的请求先发出，暂时不返回
      offlineView.animeId = 2;
      offlineView.local = { files: [], jobs: [] };
      const fresh = refreshOfflineLocal();      // 新番的请求
      window.pending = { stale, fresh };
      window.resolvers['2']();                  // 新番先回来
    });
    await page2.waitForTimeout(100);
    await page2.evaluate(() => window.resolvers['1']()); // 旧番的响应姗姗来迟
    await page2.waitForTimeout(100);
    const files = await page2.evaluate(() => offlineView.local.files.map((f) => f.id));
    assert.deepEqual(files, [2], `stale response for the previous anime is dropped, got ${files}`);
    assert.deepEqual(second.errors, [], 'no page errors');
    await page2.close();

    await browser.close();
    console.log('Offline polling: 3s while jobs move, 15s when idle, stops when the panel closes or the tab is hidden, refreshes on return, and drops stale responses after switching anime.');
  } catch (error) {
    await browser.close();
    throw error;
  }
})().catch((e) => { console.error(e); process.exit(1); });
