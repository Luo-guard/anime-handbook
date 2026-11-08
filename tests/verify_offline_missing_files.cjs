// 文件被删掉后不再显示「可以播放」（审计 N11）；订阅 toast 不再承诺自动追番
// 开启前不会发生的事（审计 N13）。
const fs = require('fs');
const assert = require('node:assert/strict');
const { chromium } = require('C:/Users/han/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

const html = fs.readFileSync('static/index.html', 'utf8');
const start = html.indexOf('<dialog class="modal offline-modal" id="offlineModal">');
const end = html.indexOf('</dialog>', start) + '</dialog>'.length;
assert(start > 0 && end > start, 'offline modal exists');
const modal = html.slice(start, end);
const settingsStart = html.indexOf('<div class="offline-settings">');
const settingsEnd = html.indexOf('<div class="settings-section-title" data-settings-section="sharing"');
assert(settingsStart > 0 && settingsEnd > settingsStart, 'offline settings block exists');
const settingsBlock = html.slice(settingsStart, settingsEnd);


const setup = `
const $=(s,r=document)=>r.querySelector(s),$$=(s,r=document)=>[...r.querySelectorAll(s)];
const escapeHtml=v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const state={progressAnime:null,settings:{}};
window.toasts=[];
const toast=(text,kind)=>toasts.push({text,kind});
window.api=async(url)=>({ok:true,files:[],jobs:[]});
`;

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setContent(`<style>${fs.readFileSync('static/styles.css', 'utf8')}</style>${modal}<div>${settingsBlock}</div>`);
    await page.addScriptTag({ content: setup + fs.readFileSync('static/modules/offline.js', 'utf8') });
    await page.evaluate(() => document.dispatchEvent(new Event('DOMContentLoaded')));

    // 1) 盘上还在的和已经不在的分成两组，缺失的不给播放按钮，也不计入角标。
    await page.evaluate(() => {
      offlineView.animeId = 554779;
      offlineView.local = {
        files: [
          { id: 1, episode_key: '0:1', file_size: 1048576, resume_ms: 0, exists: true, has_subtitle: true },
          { id: 2, episode_key: '0:2', file_size: 1048576, resume_ms: 0, exists: false, has_subtitle: false },
        ],
        jobs: [],
      };
      // 本地文件标签默认进「当前番」视图；这里测的是番内列表渲染，显式声明。
      offlineView.libraryMode = false;
      renderOfflineLocal();
      switchOfflineTab('local');
      $('#offlineModal').showModal();
    });
    const titles = await page.locator('#offlineLocalList .offline-section-title').allTextContents();
    assert.deepEqual(titles, ['可以播放 · 1 集', '文件不在了 · 1 集'], `sections: ${JSON.stringify(titles)}`);
    assert.equal(await page.locator('#offlineLocalCount').textContent(), '1', '角标只数能播的');
    const missingRows = page.locator('#offlineLocalList .offline-row-missing');
    assert.equal(await missingRows.count(), 1, 'missing row rendered');
    assert.equal(await missingRows.locator('.offline-play').count(), 0, '缺失的一集不给播放按钮');
    assert.match(await missingRows.textContent(), /磁盘上找不到这个文件/);
    assert.match(await missingRows.textContent(), /删除记录/);
    assert.match(await missingRows.textContent(), /插回去/, '要告诉用户外接盘插回来就能恢复');

    // 2) 直接点播放（比如列表是旧的）：提示找不到，不打开播放器。
    await page.evaluate(() => { window.toasts = []; });
    await page.evaluate(() => playLocalFile(2));
    const guard = await page.evaluate(() => toasts.map((item) => item.text).join(' | '));
    assert.match(guard, /磁盘上找不到了/, guard);
    assert.equal(await page.evaluate(() => Boolean(offlineView.playing)), false, '不能把播放态设成缺失的文件');

    // 2b) 删掉一条「文件不在了」的记录：不能再承诺「文件会移到 _trash」。
    await page.evaluate(() => {
      window.toasts = [];
      window.confirmText = '';
      window.confirm = (text) => { window.confirmText = text; return true; };
      window.api = async () => ({ ok: true, files: [], jobs: [] });
      offlineView.local = {
        files: [{ id: 2, episode_key: '0:2', file_size: 1048576, resume_ms: 0, exists: false }],
        jobs: [],
      };
    });
    await page.evaluate(() => removeLocalFile(2));
    const confirmText = await page.evaluate(() => window.confirmText);
    assert.match(confirmText, /只清记录/, `缺文件的删除文案：${confirmText}`);
    assert.ok(!/_trash/.test(confirmText), `不能说会移到回收站：${confirmText}`);
    const removedToast = await page.evaluate(() => toasts.at(-1).text);
    assert.equal(removedToast, '已删掉记录', removedToast);

    // 3) 详情页的单集手势：缺失的一集当作没下载，不会拿到 404。
    const found = await page.evaluate(async () => {
      window.api = async () => ({
        ok: true,
        files: [
          { id: 5, episode_key: '0:5', exists: false },
          { id: 6, episode_key: '0:6', exists: true },
        ],
        jobs: [],
      });
      state.progressAnime = { id: 42, name_cn: '测试番' };
      const gone = await localFileForEpisode('0:5');
      const ok = await localFileForEpisode('0:6');
      return { gone: gone && gone.id, ok: ok && ok.id };
    });
    assert.deepEqual(found, { gone: null, ok: 6 }, `localFileForEpisode: ${JSON.stringify(found)}`);

    // 4) 订阅 toast：自动追番关着时必须说清楚还要去设置里打开。
    await page.evaluate(() => {
      window.toasts = [];
      window.api = async (url) => (url.startsWith('/api/offline/subscribe')
        ? { ok: true, auto_follow: false }
        : { ok: true, items: [], auto_follow: false });
      offlineView.animeId = 554779;
      offlineView.items = [{ title: '[A组] 测试番 - 01', group: 'A组', torrent_url: 'https://x/1.torrent' }];
      offlineView.group = '';
      $('#offlineQuery').value = '测试番';
    });
    await page.evaluate(() => subscribeFromResult(0));
    const offToast = await page.evaluate(() => toasts.at(-1).text);
    assert.match(offToast, /已订阅/, offToast);
    assert.match(offToast, /自动追新番/, `必须提到总开关：${offToast}`);

    // 5) 总开关打开后就是普通的「已订阅」。
    await page.evaluate(() => {
      window.toasts = [];
      window.api = async (url) => (url.startsWith('/api/offline/subscribe')
        ? { ok: true, auto_follow: true }
        : { ok: true, items: [], auto_follow: true });
    });
    await page.evaluate(() => subscribeFromResult(0));
    const onToast = await page.evaluate(() => toasts.at(-1).text);
    assert.equal(onToast, '已订阅「A组」的新集', onToast);

    // 6) 旧「设置页订阅列表」已迁到动漫库的订阅管理（文案由 verify_library_sidebar 覆盖）；
    //    refreshSubscriptions 在宿主元素消失时直接返回，不报错。
    await page.evaluate(async () => { await refreshSubscriptions(); });

    assert.deepEqual(errors, [], 'no page errors');
    console.log('Offline missing files + subscribe wording: 缺文件不再假装能播，订阅文案不再空头承诺。');
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exit(1); });
