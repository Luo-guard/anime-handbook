// 媒体库卡片上的「正在下载」：角标、进度条、以及没有成品时不给「继续观看」。
// 这里注入假数据渲染，不依赖本机真实库，结果稳定。
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
    const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setContent(`<style>${fs.readFileSync('static/styles.css', 'utf8')}</style>${modal}`);
    await page.addScriptTag({ content: setup + fs.readFileSync('static/modules/offline.js', 'utf8') });
    await page.evaluate(() => {
      window.loadOfflineSettings = () => {};
      document.dispatchEvent(new Event('DOMContentLoaded'));
    });

    const result = await page.evaluate(() => {
      offlineView.libraryMode = true;
      offlineView.library.items = [
        {
          anime_id: 11, name: '正在下载的番', collection_type: 1, episode_count: 12,
          file_count: 2, watched_count: 0, size_bytes: 512 << 20, active_count: 3, active_progress: 42.4,
          continue_file_id: 7, continue_episode_key: '0:2', continue_resume_ms: 0,
        },
        {
          anime_id: 12, name: '刚开始下的番', collection_type: 1, episode_count: 12,
          file_count: 0, watched_count: 0, size_bytes: 0, active_count: 1, active_progress: 5,
          continue_file_id: 0, continue_episode_key: '', continue_resume_ms: 0,
        },
        {
          anime_id: 13, name: '已下完的番', collection_type: 1, episode_count: 12,
          file_count: 12, watched_count: 3, size_bytes: 4 << 30, active_count: 0, active_progress: 0,
          continue_file_id: 9, continue_episode_key: '0:4', continue_resume_ms: 60000,
        },
      ];
      renderLibrary();
      const cards = [...document.querySelectorAll('.library-card')].map((card) => ({
        anime: card.dataset.anime,
        badge: card.querySelector('.library-size')?.textContent.trim() || '',
        badgeDownloading: Boolean(card.querySelector('.library-size.library-downloading')),
        activeBar: Boolean(card.querySelector('.library-bar-active')),
        activeWidth: card.querySelector('.library-bar-active i')?.style.width || '',
        meta: card.querySelector('.library-meta')?.textContent.trim() || '',
        hasContinue: Boolean(card.querySelector('.library-continue')),
      }));
      return { cards, empty: document.querySelector('.offline-empty')?.textContent || '' };
    });

    const [busy, fresh, done] = result.cards;
    assert.equal(result.cards.length, 3);
    assert.ok(busy.badgeDownloading, '下载中的番角标要变成「下载中 xx%」');
    assert.equal(busy.badge, '下载中 42%');
    assert.ok(busy.activeBar && busy.activeWidth === '42%', '下载中的番要有一条额外的进度条');
    assert.ok(busy.meta.includes('正在下载 3 集'), `元信息要写清在下载几集，实际：${busy.meta}`);
    assert.ok(busy.hasContinue, '已有成品的番仍要能继续观看');

    assert.ok(fresh.badgeDownloading, '一集都没有的番也应该是下载中');
    assert.equal(fresh.hasContinue, false, '没有成品时不该出现「继续观看」');
    assert.ok(fresh.meta.includes('已收 0'), `元信息要如实显示 0 集，实际：${fresh.meta}`);

    assert.equal(done.badgeDownloading, false, '下完的番不该显示下载中');
    assert.equal(done.activeBar, false, '下完的番不该有下载进度条');
    assert.ok(done.meta.startsWith('已收 12'), `下完的番元信息照旧，实际：${done.meta}`);

    assert.deepEqual(errors, []);
    console.log('ok: 媒体库卡片能显示下载中集数与进度，且不影响已下完的卡片');
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
