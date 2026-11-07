// 回归：详情页集数 key（Bangumi 的 bgm:xxx）与归档入库 key（0:N / 1:N）的换算。
// 真实故障：库里明明有「第 04 集.mp4」（episode_key = 0:4），但集数格子是
// bgm:1738538，扇区「播放」按字符串直接比 → 永远报「这一集还没下载」。
// 这里锁住归一化与查找，避免以后又有人改成直接 String 比较。
const fs = require('fs');
const assert = require('node:assert/strict');
const { chromium } = require('C:/Users/han/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<html><body></body></html>');
    await page.addScriptTag({ content: fs.readFileSync('static/modules/presentation.js', 'utf8') });

    const result = await page.evaluate(() => {
      const anime = {
        episodes: [
          { key: 'bgm:1738535', sort: 1, type: 0 },
          { key: 'bgm:1738538', sort: 4, type: 0 },
          { key: 'bgm:1738539', sort: 5, type: 0 },
          { key: 'bgm:999', sort: 2, type: 1 },   // 特别篇
          { key: '0:9', sort: 9, type: 0 },        // 本地生成的 key
        ],
      };
      const files = [
        { id: 2, episode_key: '0:4', exists: true },
        { id: 1, episode_key: '0:5', exists: true },
        { id: 3, episode_key: '1:2', exists: false }, // 文件已被移走
      ];
      return {
        numeric: episodeStorageKey('0:4', anime),
        bgm: episodeStorageKey('bgm:1738538', anime),
        special: episodeStorageKey('bgm:999', anime),
        localKey: episodeStorageKey('0:9', anime),
        unknown: episodeStorageKey('bgm:888', anime),
        byBgm: findLocalEpisodeFile(files, 'bgm:1738538', anime)?.id ?? null,
        byNumeric: findLocalEpisodeFile(files, '0:4', anime)?.id ?? null,
        missing: findLocalEpisodeFile(files, 'bgm:1738535', anime),
        gone: findLocalEpisodeFile(files, 'bgm:999', anime), // exists:false 不能算可播
        reverse: findLocalEpisodeFile(
          [{ id: 9, episode_key: 'bgm:1738538', exists: true }], '0:4', anime
        )?.id ?? null,
      };
    });

    assert.equal(result.numeric, '0:4', '数字 key 原样返回');
    assert.equal(result.localKey, '0:9', '本地生成的 key 也原样返回');
    assert.equal(result.bgm, '0:4', 'Bangumi 第 4 集要换算成 0:4');
    assert.equal(result.special, '1:2', 'Bangumi 特别篇要换算成 1:2');
    assert.equal(result.unknown, 'bgm:888', '找不到对应章节时保留原 key');
    assert.equal(result.byBgm, 2, '按 bgm:xxx 必须能命中库里的 0:4（真实故障点）');
    assert.equal(result.byNumeric, 2, '按 0:4 仍然能命中');
    assert.equal(result.reverse, 9, '库里若写成 bgm:xxx，用 0:4 也要能对上');
    assert.equal(result.missing, null, '没下载的集不能凭空命中');
    assert.equal(result.gone, null, '文件不在磁盘上不能算可播');

    console.log('verify_offline_episode_key: ok');
  } finally {
    await browser.close();
  }
})();
