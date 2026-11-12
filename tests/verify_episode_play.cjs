// 审计 N1：详情页单集「播放」手势不得使用上一部番的离线缓存。
// runEpisodeGestureAction 的 play 分支必须先按当前番同步 offlineView 身份、
// 等待按 anime_id 拉取完成后，再在「当前番的文件」里找 episode_key。
const fs = require('fs'), assert = require('node:assert/strict');
const { chromium } = require('C:/Users/han/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

const harness = [
  "const $=s=>document.querySelector(s);",
  "const $$=s=>[...document.querySelectorAll(s)];",
  "const state={settings:{},progressAnime:null,animes:[]};",
  "const enabledSetting=key=>state.settings[key]!==false;",
  "const escapeHtml=s=>String(s);",
  // api 记录每次请求；按 anime_id 返回对应的本地文件。
  "window.apiCalls=[];",
  "window.filesByAnime={};",
  "const api=async(url)=>{window.apiCalls.push(url);const m=String(url).match(/anime_id=(\\d+)/);const id=m?m[1]:'0';return {files:window.filesByAnime[id]||[],jobs:[]};};",
  "window.toasts=[];",
  "const toast=(msg)=>window.toasts.push(String(msg));",
  "window.played=[];",
].join("\n");

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1180, height: 860 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const html = fs.readFileSync('static/index.html', 'utf8')
      .replace(/<script[\s\S]*?<\/script>/g, '')
      .replace(/<link[^>]*>/g, '');
    await page.setContent(`<style>${fs.readFileSync('static/styles.css', 'utf8')}</style>${html}`);
    await page.addScriptTag({ content: harness });
    for (const name of ['episode-gesture.js', 'offline.js', 'details.js']) {
      await page.addScriptTag({ content: fs.readFileSync(`static/modules/${name}`, 'utf8') });
    }
    // offline.js 的 playLocalFile 是函数声明（挂在 window 上），加载后用桩覆盖。
    await page.evaluate(() => { window.playLocalFile = (id) => window.played.push(id); });

    // 场景 1（N1 核心）：缓存还挂着上一部番（id 7）的同集号文件，当前详情是 id 1。
    // 旧行为会直接播上一部番的第 5 集；新行为必须按番 1 重新拉取 → 番 1 没有文件 → 提示未下载。
    await page.evaluate(() => {
      window.played.length = 0; window.toasts.length = 0; window.apiCalls.length = 0;
      window.filesByAnime = {
        7: [{ id: 777, episode_key: '0:5', file_path: '/x', subtitle_path: '' }],
        1: [{ id: 111, episode_key: '0:2', file_path: '/x', subtitle_path: '' }],
      };
      offlineView.animeId = 7;
      offlineView.animeName = '上一部番';
      offlineView.local = { files: window.filesByAnime[7], jobs: [] };
      state.progressAnime = { id: 1, name_cn: '当前番剧', display_name: '当前番剧' };
    });
    await page.evaluate(() => runEpisodeGestureAction('play', '0:5', null));
    await page.waitForFunction(() => window.toasts.length > 0 || window.played.length > 0);
    const s1 = await page.evaluate(() => ({
      played: window.played, toasts: window.toasts,
      calls: window.apiCalls,
      animeId: offlineView.animeId,
    }));
    assert.deepEqual(s1.played, [], 'must not play the previous anime file with the same episode key');
    assert.match(s1.toasts[0] || '', /还没下载/, 'anime 1 has no episode 5, user is told so');
    assert.ok(s1.calls.some((u) => u.includes('anime_id=1')), `refresh must target the current anime: ${s1.calls}`);
    assert.equal(s1.animeId, 1, 'cached identity is resynced to the current anime');

    // 场景 2：当前番确实有这一集 → 播放的是当前番的文件 id。
    await page.evaluate(() => { window.played.length = 0; window.toasts.length = 0; window.apiCalls.length = 0; });
    await page.evaluate(() => runEpisodeGestureAction('play', '0:2', null));
    await page.waitForFunction(() => window.played.length > 0);
    const s2 = await page.evaluate(() => ({ played: window.played, calls: window.apiCalls }));
    assert.deepEqual(s2.played, [111], 'plays the current anime file id');
    assert.ok(s2.calls.every((u) => u.includes('anime_id=1')), `still targets anime 1: ${s2.calls}`);

    // 场景 3：本次会话从未打开过离线面板（animeId=0）→ 不再误报，先按当前番拉取。
    await page.evaluate(() => {
      window.played.length = 0; window.toasts.length = 0; window.apiCalls.length = 0;
      offlineView.animeId = 0; offlineView.animeName = ''; offlineView.local = { files: [], jobs: [] };
      window.filesByAnime[3] = [{ id: 333, episode_key: '0:5', file_path: '/x', subtitle_path: '' }];
      state.progressAnime = { id: 3, name_cn: '新番剧', display_name: '新番剧' };
    });
    await page.evaluate(() => runEpisodeGestureAction('play', '0:5', null));
    await page.waitForFunction(() => window.played.length > 0);
    const s3 = await page.evaluate(() => ({ played: window.played, calls: window.apiCalls, animeId: offlineView.animeId }));
    assert.deepEqual(s3.played, [333], 'first gesture in a session still finds the file after resync');
    assert.ok(s3.calls.some((u) => u.includes('anime_id=3')), `fetches with the fresh anime id: ${s3.calls}`);
    assert.equal(s3.animeId, 3);

    // 场景 4：番没有 id（异常数据）→ 安静提示，不抛错。
    await page.evaluate(() => {
      window.played.length = 0; window.toasts.length = 0; window.apiCalls.length = 0;
      state.progressAnime = { name_cn: '无 id' };
    });
    await page.evaluate(() => runEpisodeGestureAction('play', '0:5', null));
    await page.waitForFunction(() => window.toasts.length > 0);
    const s4 = await page.evaluate(() => ({ played: window.played, calls: window.apiCalls }));
    assert.deepEqual(s4.played, []);
    assert.deepEqual(s4.calls, [], 'no request without an anime id');

    const routing = await page.evaluate(async () => {
      const online = [];
      window.onlinePlayback = { openAnime: (anime, key) => online.push([anime.id, key]) };
      state.progressAnime = { id: 3, display_name: '当前番剧' };
      window.played.length = 0;
      window.apiCalls.length = 0;
      await playDetailEpisode('0:5');
      await playDetailEpisode('0:6');
      state.settings.episode_gestures = { playback_source: 'local' };
      await playDetailEpisode('0:6');
      const localChecks = window.apiCalls.length;
      state.settings.episode_gestures.playback_source = 'online';
      await playDetailEpisode('0:5');
      return { online, played: window.played, localChecks, checksAfterOnline: window.apiCalls.length };
    });
    assert.deepEqual(routing, {
      online: [[3, '0:6'], [3, '0:5']], played: [333], localChecks: 3, checksAfterOnline: 3,
    });

    assert.deepEqual(errors, [], 'no page errors');
    await browser.close();
    console.log('Episode play gesture: resyncs offline cache identity, awaits a per-anime refresh, never plays another anime file with the same episode key, and degrades to a toast when there is no file.');
  } catch (error) {
    await browser.close();
    throw error;
  }
})().catch((e) => { console.error(e); process.exit(1); });
