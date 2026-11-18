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
    await page.addStyleTag({content:fs.readFileSync('static/styles.css','utf8')});
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
    await page.evaluate(() => {
      const old = new Date();
      old.setDate(old.getDate() - 1);
      const key = 'handbook:playback-history:a';
      const entries = JSON.parse(localStorage.getItem(key));
      entries.push({kind:'local', animeId:1, animeTitle:'缓存番', fileId:6, episode:'第 1 集', playedAt:old.getTime()});
      entries.push({kind:'online', animeId:1, animeTitle:'缓存番', providerId:7, episodeId:23, episode:'第 3 集', playedAt:Date.now()+1000});
      localStorage.setItem(key, JSON.stringify(entries));
    });
    await page.locator('[data-history-kind="all"]').click();
    assert.equal(await page.locator('.jump-day').count(), 2);
    assert.equal(await page.locator('.jump-row').count(), 4);
    await page.locator('[data-history-layout="grid"]').click();
    assert.equal(await page.locator('.jump-day').count(), 0);
    assert.deepEqual(await page.locator('.jump-title').allTextContents(), ['缓存番', '在线番']);
    await page.locator('.jump-row').first().click();
    assert.deepEqual(await page.evaluate(() => window.opened), ['online', 23]);
    await page.locator('[data-history-kind="local"]').click();
    assert.equal(await page.locator('.jump-row').count(), 1);
    assert.match(await page.locator('.jump-meta').textContent(), /第 2 集/);
    await page.setViewportSize({width:360,height:460});
    assert.ok(await page.locator('#jumpHistoryList').evaluate(node => node.scrollWidth <= node.clientWidth + 1));
    await page.locator('#jumpHistoryClose').click();
    await page.locator('#jumpHistoryButton').click();
    assert.equal(await page.locator('#jumpHistoryList').getAttribute('data-layout'), 'grid');
    assert.equal(await page.evaluate(() => localStorage.getItem('handbook:playback-history:a:layout')), 'grid');
    await page.evaluate(() => { state.active_profile.id = 'b'; });
    await page.locator('[data-history-kind="all"]').click();
    assert.equal(await page.locator('.jump-row').count(), 0);
    assert.equal(await page.locator('#jumpHistoryList').getAttribute('data-layout'), 'list');
    await page.evaluate(() => { state.active_profile.id = 'a'; });
    await page.locator('[data-history-kind="all"]').click();
    await page.locator('[data-history-layout="list"]').click();
    assert.equal(await page.locator('.jump-row').count(), 4);
    await page.locator('#clearJumpHistory').click();
    assert.equal(await page.locator('.jump-row').count(), 0);
    console.log('Playback history: date groups, cover grid, saved layout, filters, resume, narrow viewport, profile isolation and clear passed.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
