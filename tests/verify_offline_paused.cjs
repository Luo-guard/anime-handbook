// 暂停态不再靠 error 字段传（审计 N17）：界面认 live.paused，
// 顺带认 qB 5 改名后的 stoppedDL——旧代码只看 "paused" 前缀，qB 5 上会一直显示「暂停」。
const fs = require('fs');
const assert = require('node:assert/strict');
const { chromium } = require('C:/Users/han/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

const html = fs.readFileSync('static/index.html', 'utf8');
const start = html.indexOf('<dialog class="modal offline-modal" id="offlineModal">');
const end = html.indexOf('</dialog>', start) + '</dialog>'.length;
assert(start > 0 && end > start, 'offline modal exists');
const modal = html.slice(start, end);

const setup = `
const $=(s,r=document)=>r.querySelector(s),$$=(s,r=document)=>[...r.querySelectorAll(s)];
const escapeHtml=v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const state={progressAnime:null,settings:{}};
window.toasts=[];
const toast=(text,kind)=>toasts.push({text,kind});
window.api=async()=>({ok:true,files:[],jobs:[]});
`;

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setContent(`<style>${fs.readFileSync('static/styles.css', 'utf8')}</style>${modal}`);
    await page.addScriptTag({ content: setup + fs.readFileSync('static/modules/offline.js', 'utf8') });
    await page.evaluate(() => document.dispatchEvent(new Event('DOMContentLoaded')));

    const render = (live) => page.evaluate((payload) => {
      offlineView.animeId = 1;
      offlineView.local = {
        files: [],
        jobs: [{ id: 9, status: 'downloading', progress: 42, torrent_name: '某番 S01', live: payload }],
      };
      renderOfflineLocal();
      switchOfflineTab('local');
      if (!$('#offlineModal').open) $('#offlineModal').showModal();
      const row = $('#offlineLocalList .offline-row-task');
      return {
        action: row.querySelector('[data-task]').dataset.action,
        button: row.querySelector('[data-task]').textContent,
        tag: row.querySelector('.offline-tag').textContent,
        meta: row.querySelector('.offline-row-meta').textContent,
      };
    }, live);

    // qB 4 的 pausedDL，且后端明确给了 live.paused。
    let view = await render({ state: 'pausedDL', paused: true });
    assert.equal(view.action, 'resume', `暂停的任务按钮应该是「继续」：${JSON.stringify(view)}`);
    assert.equal(view.button, '继续');
    assert.equal(view.tag, '已暂停');

    // qB 5 把 pausedDL 改名成 stoppedDL：只看状态字符串时旧代码会漏判，现在靠 live.paused。
    view = await render({ state: 'stoppedDL', paused: true });
    assert.equal(view.action, 'resume', `stoppedDL 也要认出暂停：${JSON.stringify(view)}`);
    assert.equal(view.tag, '已暂停');

    // 老数据没有 paused 字段时退回看状态字符串，paused/stopped 前缀都认。
    view = await render({ state: 'stoppedDL' });
    assert.equal(view.action, 'resume', `没有 live.paused 时要靠状态字符串兜底：${JSON.stringify(view)}`);
    view = await render({ state: 'downloading' });
    assert.equal(view.action, 'pause', `正常下载中应该是「暂停」：${JSON.stringify(view)}`);
    assert.equal(view.tag, '42.0%');

    // error 里不再塞「已暂停」这三个字：它在 error 里只会被下一次同步清掉。
    view = await render({ state: 'downloading', paused: false });
    assert.ok(!/已暂停/.test(view.meta), `暂停态不该再借 error 传：${JSON.stringify(view)}`);

    assert.deepEqual(errors, [], 'no page errors');
    console.log('Offline paused state: live.paused 优先、qB 4/5 两种状态名都认、不再借 error 传暂停。');
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exit(1); });
