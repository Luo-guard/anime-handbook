// 特别篇显示成「特别篇 02」而不是「第 02 集」；迁移失败时提示「什么都没改」。
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

    // 1) 集数标识的第一段是类型，标签要跟着变。
    const labels = await page.evaluate(() =>
      ['0:7', '1:2', '2:1', '0:0', '', 'bgm:123'].map(episodeLabelOf));
    assert.deepEqual(
      labels,
      ['第 07 集', '特别篇 02', 'OP 01', '0:0', '', 'bgm:123'],
      `episode labels: ${JSON.stringify(labels)}`,
    );

    // 2) 本地文件列表里特别篇不再冒充本篇的一集。
    await page.evaluate(() => {
      offlineView.animeId = 554779;
      offlineView.local = {
        files: [
          { id: 1, episode_key: '0:2', file_size: 1048576, resume_ms: 0 },
          { id: 2, episode_key: '1:2', file_size: 1048576, resume_ms: 0 },
        ],
        jobs: [],
      };
      // 本地文件标签默认进「当前番」视图；这里测的是番内列表渲染，显式声明。
      offlineView.libraryMode = false;
      renderOfflineLocal();
      switchOfflineTab('local');
      $('#offlineModal').showModal();
    });
    const titles = await page.locator('#offlineLocalList .offline-row-title').allTextContents();
    assert.deepEqual(titles, ['第 02 集', '特别篇 02'], `local list titles: ${JSON.stringify(titles)}`);

    // 3) 迁移失败：后端什么都没改，提示必须这么说（旧文案说「已复制 N 集」是假的）。
    await page.evaluate(() => {
      window.confirm = () => true;
      window.api = async () => ({
        ok: true,
        copied: 0,
        attempted: 2,
        failed: [{ file: 'D:/media/测试番/第 02 集.ass', reason: '字幕没复制过去' }],
        warnings: [],
        target: 'D:/new-media',
        switched: false,
        rolled_back: true,
        fonts: 0,
      });
      $('#offlineMediaRoot').value = 'D:/new-media';
    });
    await page.evaluate(() => migrateMediaRoot());
    const failedText = await page.locator('#offlineSettingsStatus').textContent();
    assert.match(failedText, /迁移没有执行/, failedText);
    assert.match(failedText, /字幕没复制过去/, failedText);
    assert.match(failedText, /媒体库仍是原目录/, failedText);
    assert.ok(!/已复制/.test(failedText), `must not claim anything was copied: ${failedText}`);

    // 4) 迁移成功：报出集数与字体数量。
    await page.evaluate(() => {
      window.api = async () => ({
        ok: true,
        copied: 3,
        attempted: 3,
        failed: [],
        warnings: [],
        target: 'D:/new-media',
        switched: true,
        rolled_back: false,
        fonts: 4,
      });
    });
    await page.evaluate(() => migrateMediaRoot());
    const okText = await page.locator('#offlineSettingsStatus').textContent();
    assert.match(okText, /已迁移 3 集/, okText);
    assert.match(okText, /字体 4 个/, okText);
    assert.match(okText, /目录已切换/, okText);

    assert.deepEqual(errors, [], 'no page errors');
    console.log('Offline episode labels: specials get their own label, migration reports what actually happened.');
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exit(1); });
