// 播放器里的「下载本集」：入口位置、请求参数与令牌解析。
const fs = require('fs');
const assert = require('node:assert/strict');
const { chromium } = require('C:/Users/han/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

const html = fs.readFileSync('static/index.html', 'utf8');
const source = fs.readFileSync('static/modules/online-playback.js', 'utf8');

// 1) 按钮必须在线路工具条里：和「切换规则 / 打开原网页」同一行，用户才找得到。
const optionsAt = html.indexOf('id="onlinePlayerOptions"');
assert(optionsAt > 0, '找不到在线播放工具条');
const buttonAt = html.indexOf('id="onlinePlayerDownload"', optionsAt);
const optionsEnd = html.indexOf('</div>', optionsAt);
assert(buttonAt > optionsAt && buttonAt < optionsEnd, '下载按钮必须放在 #onlinePlayerOptions 内');

// 2) 请求打到网站资源下载接口，并带上播放令牌与集数。
assert(source.includes('$("#onlinePlayerDownload").addEventListener("click", startWebDownload)'), '按钮没有绑定下载处理');
assert(source.includes('"/api/offline/web-download"'), '下载没有走 /api/offline/web-download');
assert(source.includes('episode_key: `0:${number}`'), '下载必须带上本篇集数，否则归档认不出是哪一集');
assert(source.includes('session.playback = { url: result.url, format: result.format }'), '播放结果没有留存，下载拿不到地址');

// 3) 归档前不能凭空猜番剧：没有番剧上下文时明确拒绝。
assert(source.includes('从详情页打开这一集后再下载'), '缺少无番剧上下文时的提示');

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setContent('<div id="host"></div>');
    await page.addScriptTag({ content: 'window.state={animes:[],progressAnime:null};' + source });
    const token = await page.evaluate(() => playbackToken('/api/playback/stream/AbC-123_x/main'));
    assert.equal(token, 'AbC-123_x');
    const missing = await page.evaluate(() => playbackToken('https://example.com/a.mp4'));
    assert.equal(missing, '');
    assert.deepEqual(errors, []);
    console.log('ok: 下载入口、请求参数与令牌解析都符合预期');
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
