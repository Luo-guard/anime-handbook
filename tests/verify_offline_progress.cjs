// 下载进度展示：整体概览、进度徽标、以及「速度 · 分片/体积 · 剩余」这行明细。
// 数据形状对齐后端 /api/offline/state 里的 live 字段。
const fs = require('fs');
const assert = require('node:assert/strict');
const { chromium } = require('C:/Users/han/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

const html = fs.readFileSync('static/index.html', 'utf8');
const start = html.indexOf('<dialog class="modal offline-modal" id="offlineModal">');
const end = html.indexOf('</dialog>', start) + '</dialog>'.length;
const modal = html.slice(start, end);

const setup = `
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const state = { progressAnime: null, settings: {}, animes: [] };
const CATEGORIES = [{ id: 1, name: '在看' }];
const toast = () => {};
const escapeHtml = (v) => String(v ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
window.api = async () => ({ items: [], disk: null });
`;

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setContent(`<style>${fs.readFileSync('static/styles.css', 'utf8')}</style>${modal}`);
    await page.addScriptTag({ content: setup + fs.readFileSync('static/modules/offline.js', 'utf8') });
    await page.evaluate(() => {
      window.loadOfflineSettings = () => {};
      document.dispatchEvent(new Event('DOMContentLoaded'));
    });

    const view = await page.evaluate(() => {
      offlineView.animeId = 42;
      offlineView.local = {
        files: [],
        jobs: [
          {
            id: 1, status: 'downloading', progress: 41.7, torrent_name: '网站资源 · 第 03 集',
            live: { dlspeed: 1258291, eta: 95, paused: false, state: 'running', size: 52428800, downloaded: 22020096, segments: 12, done_segments: 5 },
          },
          {
            id: 2, status: 'downloading', progress: 12.5, torrent_name: '[LoliHouse] 测试番 [05][1080p].mkv',
            live: { dlspeed: 0, eta: 0, paused: true, state: 'stoppedDL', size: 2147483648, downloaded: 268435456, segments: 0, done_segments: 0, seeds: 3 },
          },
          {
            id: 3, status: 'queued', progress: 0, torrent_name: '网站资源 · 第 04 集',
            live: { dlspeed: 0, eta: 0, paused: false, state: 'queued', size: 0, downloaded: 0, segments: 0, done_segments: 0 },
          },
          {
            id: 4, status: 'failed', source_kind: 'web', error: '解析这一集失败：这条线路没有这一集',
            torrent_name: '网站资源 · 第 05 集', progress: 0, live: {},
          },
        ],
      };
      renderOfflineLocal();
      const rows = [...document.querySelectorAll('#offlineLocalList .offline-row-task')].map((row) => ({
        tag: row.querySelector('.offline-tag')?.textContent || '',
        meta: row.querySelector('.offline-row-meta')?.textContent || '',
        ring: Boolean(row.querySelector('.offline-task-ring')),
        ringValue: row.querySelector('.offline-task-ring')?.style.getPropertyValue('--p') || '',
        badgeState: row.querySelector('.offline-task-badge')?.dataset.state || 'ring',
        barWidth: row.querySelector('.offline-bar > span')?.style.width || '',
        action: row.querySelector('[data-task]')?.dataset.action || '',
        hasPauseButton: Boolean(row.querySelector('[data-task]')),
      }));
      const summary = document.querySelector('.offline-task-summary');
      return {
        rows,
        summary: summary?.textContent.replace(/\s+/g, ' ').trim() || '',
        summaryBar: summary?.querySelector('.offline-bar > span')?.style.width || '',
      };
    });

    const [web, paused, queued] = view.rows;
    assert.equal(view.rows.length, 3);

    // 下载中：进度环 + 百分比 + 分片明细
    assert.ok(web.ring, '下载中应该有进度环');
    assert.equal(web.ringValue, '42');
    assert.equal(web.tag, '41.7%');
    assert.ok(web.meta.includes('5/12 分片'), `网站资源要显示分片进度，实际：${web.meta}`);
    assert.ok(web.meta.includes('/s'), `要有速度，实际：${web.meta}`);
    assert.ok(web.meta.includes('剩余'), `要有剩余时间，实际：${web.meta}`);
    assert.equal(web.barWidth, '41.7%');

    // 暂停：暂停徽标，百分比保留，按钮变成「继续」
    assert.equal(paused.badgeState, 'paused');
    assert.equal(paused.tag, '已暂停');
    assert.equal(paused.action, 'resume');
    assert.ok(paused.meta.includes('256 MB / 2.0 GB'), `BT 任务要显示已下/总量，实际：${paused.meta}`);
    assert.ok(paused.meta.includes('3 个做种'), `BT 任务要显示做种，实际：${paused.meta}`);

    // 排队：排队徽标，没有进度环
    assert.equal(queued.badgeState, 'queued');
    assert.equal(queued.tag, '排队中');
    assert.equal(queued.ring, false);

    // 排队中没有可暂停的东西，不该给「暂停」按钮
    assert.equal(queued.hasPauseButton, false, '排队中不该有暂停按钮');

    // 暂停态要能看到「暂停在多少」：标签是「已暂停」，明细里带百分比
    assert.ok(paused.meta.includes('12.5%'), `暂停也要显示进度，实际：${paused.meta}`);

    // 解析失败的任务没有可续的线程：不给「重试」，只留说明
    const failedRow = await page.evaluate(() => {
      const row = document.querySelector('#offlineLocalList .offline-row:has(.offline-error)');
      return {
        retry: Boolean(row?.querySelector('[data-retry]')),
        hint: row?.querySelector('.offline-row-hint')?.textContent || '',
      };
    });
    assert.equal(failedRow.retry, false, '解析失败的网站任务不该给重试按钮');
    assert.ok(failedRow.hint.includes('回到播放器'), `要告诉用户怎么补救，实际：${failedRow.hint}`);

    // 概览：2 集在跑（下载中+暂停）· 1 集排队 · 总速度
    assert.ok(view.summary.includes('2 集在下载'), `概览要写清几集在跑，实际：${view.summary}`);
    assert.ok(view.summary.includes('1 集排队'), `概览要写清几集排队，实际：${view.summary}`);
    assert.ok(view.summary.includes('/s'), `概览要有总速度，实际：${view.summary}`);
    assert.ok(view.summary.includes('%'), `概览要有平均进度，实际：${view.summary}`);
    // 平均 (41.7 + 12.5 + 0) / 3 ≈ 18%
    assert.equal(view.summaryBar, '18%');

    assert.deepEqual(errors, []);
    console.log('ok: 下载概览、进度环、分片/体积明细与暂停/排队状态都符合预期');
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
