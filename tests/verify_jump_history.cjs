const fs = require('node:fs');
const assert = require('node:assert/strict');
const { chromium } = require('C:/Users/han/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const html = fs.readFileSync('static/index.html', 'utf8')
      .replace(/<script[\s\S]*?<\/script>/g, '').replace(/<link[^>]*>/g, '');
    await page.route('http://history.test/', route => route.fulfill({ contentType: 'text/html', body: html }));
    await page.goto('http://history.test/');
    await page.addScriptTag({ content: `
      const $ = selector => document.querySelector(selector);
      const $$ = selector => [...document.querySelectorAll(selector)];
      const state = { active_profile: { id: 'a' } };
      const offlineView = {};
      const api = async () => ({ files: [{ id: 8, episode_key: '0:2', resume_ms: 7000 }] });
      const playLocalFile = id => { window.opened = ['local', id, offlineView.local.files[0].resume_ms]; };
      window.onlinePlayback = { resume: item => { window.opened = ['online', item.episodeId]; } };
      window.confirm = () => true;
      $("#jumpHistoryButton").classList.remove("hidden");
    ` + fs.readFileSync('static/modules/jump-history.js', 'utf8') });
    await page.evaluate(() => {
      document.dispatchEvent(new Event('DOMContentLoaded'));
      playbackHistory.record({ kind: 'online', animeTitle: '在线番', episode: '第 1 集', episodeId: 13 });
      playbackHistory.record({ kind: 'local', animeTitle: '缓存番', animeId: 1, fileId: 8, episodeKey: '0:2', episode: '第 2 集' });
      playbackHistory.record({ kind: 'online', animeTitle: '在线番', episode: '第 1 集', episodeId: 13 });
    });
    await page.locator('#jumpHistoryButton').click();
    assert.deepEqual(await page.locator('.jump-title').allTextContents(), ['在线番', '缓存番']);
    await page.locator('[data-history-kind="online"]').click();
    await page.locator('.jump-row').click();
    assert.deepEqual(await page.evaluate(() => window.opened), ['online', 13]);
    await page.locator('[data-history-kind="local"]').click();
    await page.locator('.jump-row').click();
    assert.deepEqual(await page.evaluate(() => window.opened), ['local', 8, 7000]);
    await page.evaluate(() => { state.active_profile.id = 'b'; });
    await page.locator('[data-history-kind="all"]').click();
    assert.equal(await page.locator('.jump-row').count(), 0);
    await page.evaluate(() => { state.active_profile.id = 'a'; });
    await page.locator('[data-history-kind="all"]').click();
    await page.locator('#clearJumpHistory').click();
    assert.equal(await page.locator('.jump-row').count(), 0);
    console.log('Playback history: filters, resume, profile isolation, deduplication and clear passed.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
