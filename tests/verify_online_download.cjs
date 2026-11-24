// 下载入口：播放器里的「下载」+ 详情页「⋯ → 从网站下载」，两条路都进同一个选集对话框。
const fs = require('fs');
const assert = require('node:assert/strict');
const { chromium } = require('C:/Users/han/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

const html = fs.readFileSync('static/index.html', 'utf8');
const source = fs.readFileSync('static/modules/online-playback.js', 'utf8');

// 1) 播放器按钮在线路工具条里，和「切换规则 / 打开原网页」同一行。
const optionsAt = html.indexOf('id="onlinePlayerOptions"');
assert(optionsAt > 0, '找不到在线播放工具条');
const buttonAt = html.indexOf('id="onlinePlayerDownload"', optionsAt);
const optionsEnd = html.indexOf('</div>', optionsAt);
assert(buttonAt > optionsAt && buttonAt < optionsEnd, '下载按钮必须放在 #onlinePlayerOptions 内');

// 2) 选集对话框的结构：列表、全选、确认按钮缺一不可。
const sheetAt = html.indexOf('id="episodeDownloadSheet"');
assert(sheetAt > 0, '缺少选集下载对话框');
for (const id of ['episodeDownloadList', 'episodeDownloadSelectAll', 'episodeDownloadConfirm', 'episodeDownloadHint']) {
  assert(html.includes(`id="${id}"`), `选集对话框缺少 ${id}`);
}

// 3) 详情页更多菜单：下载单独成组，磁力与网站两个入口并排，和「番剧」组分开。
const menuAt = html.indexOf('id="modernDetailMenu"');
assert(menuAt > 0, '找不到详情页更多菜单');
const siteAt = html.indexOf('id="openSiteDownload"', menuAt);
assert(siteAt > menuAt, '更多菜单缺少「从网站下载」');
assert(html.includes('找资源（磁力）'), '磁力入口要标明「磁力」，避免和网站下载混淆');
const downloadLabel = html.indexOf('>下载<', menuAt);
assert(downloadLabel > 0 && downloadLabel < siteAt, '下载分组标题要在两个下载入口之前');
assert(html.indexOf('>番剧<', menuAt) > siteAt, '「番剧」分组要独立于下载分组');

// 4) 交互接线：点下载先选集；单集走原接口，多集走批量接口。
assert(source.includes('$("#onlinePlayerDownload").addEventListener("click", openDownloadSheet)'), '下载按钮没有打开选集');
assert(source.includes('"/api/offline/web-download-batch"'), '没有走批量下载接口');
assert(source.includes('"/api/offline/web-download"'), '单集接口丢了');
assert(source.includes('episode_key: `0:${row.number}`') && source.includes('episode_id: row.id'), '批量请求缺少集号与片源集 ID');
assert(source.includes('title: batchEpisodeTitle(session, row)'), '批量请求要按集提交各自的标题');
assert(source.includes('episodes.length === 1 && !preset'), '只有一集时应该直接下载，不弹空对话框');

// 5) 详情页入口复用同一套解析：先选站点/线路，再读选集，最后交给下载对话框。
assert(source.includes('$("#openSiteDownload")?.addEventListener("click"'), '详情页下载入口没有绑定');
assert(source.includes('mode: "download"'), '入口没有进入下载模式');
assert(source.includes('openDownloadSheet({') && source.includes('animeId: Number(anime.id) || 0'), '下载模式没有把选集交给下载对话框');
assert(source.includes('context.mode === "download"') && source.includes('downloadResult(item)'), '结果点击没有按模式分流');
assert(source.includes('play(catalogue, source, episode, anime.id'), '原来的播放路径不能丢');

const stubs = `
window.$ = (s, r = document) => r.querySelector(s);
window.$$ = (s, r = document) => [...r.querySelectorAll(s)];
window.state = { animes: [], progressAnime: null, settings: {} };
window.toast = (m) => { window.toasts = (window.toasts || []).concat(String(m)); };
window.api = async (url) => {
  if (String(url).includes('/api/playback/rules')) return { items: [], default_rule: '' };
  return {};
};
window.escapeHtml = (v) => String(v ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
window.episodeStorageKey = (k) => (typeof k === 'string' ? k : (k && k.key) || '');
window.storedEpisodeName = () => '';
`;

const pickerDom = `
<dialog id="onlinePlaybackPicker">
  <h2 id="onlinePlaybackPickerTitle">播放来源</h2>
  <p id="onlineSourceAnime"></p>
  <p id="onlineRuleStatus"></p>
  <div id="onlinePlaybackResults"></div>
</dialog>`;

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setContent(pickerDom);
    await page.addScriptTag({ content: stubs + source });

    const token = await page.evaluate(() => playbackToken('/api/playback/stream/AbC-123_x/main'));
    assert.equal(token, 'AbC-123_x');
    assert.equal(await page.evaluate(() => playbackToken('https://example.com/a.mp4')), '');

    // 选集行：勾选态正确，集名里的尖括号被转义（集标题来自站点，不能当 HTML）。
    const row = await page.evaluate(() => episodePickRow({ label: '第 03 集 · <script>x</script>' }, 2, true));
    assert.ok(row.includes('data-pick="2"') && row.includes('checked'), '勾选态没有写进行里');
    assert.ok(row.includes('&lt;script&gt;'), '集名没有转义');
    assert.ok(!row.includes('<script>'), '集名被当成 HTML 插入');
    const plain = await page.evaluate(() => episodePickRow({ label: '第 01 集' }, 0, false));
    assert.ok(!plain.includes('checked'), '未勾选的行不该带 checked');

    // 下载模式：标题改成「从网站下载」，不再假装是播放来源。
    const downloadMode = await page.evaluate(async () => {
      const anime = {
        id: 9, display_name: '测试番',
        episodes: [{ key: '0:1', type: 0, sort: 1 }, { key: '0:8', type: 0, sort: 8 }],
        episode_count: 10, watched_episode_keys: ['0:8'],
      };
      await window.onlinePlayback.openAnime(anime, '', null, { choose: true, mode: 'download' });
      return {
        title: document.querySelector('#onlinePlaybackPickerTitle').textContent,
        open: document.querySelector('#onlinePlaybackPicker').open,
        animeLine: document.querySelector('#onlineSourceAnime').textContent,
      };
    });
    assert.equal(downloadMode.title, '从网站下载');
    assert.equal(downloadMode.open, true, '点入口要打开来源面板');
    assert.ok(downloadMode.animeLine.includes('测试番'), `面板要写明是哪一部，实际：${downloadMode.animeLine}`);

    // 播放模式仍是「播放来源」：别把原来的入口改了名。
    const playMode = await page.evaluate(async () => {
      document.querySelector('#onlinePlaybackPicker').close();
      const anime = {
        id: 9, display_name: '测试番',
        episodes: [{ key: '0:1', type: 0, sort: 1 }], episode_count: 10, watched_episode_keys: [],
      };
      await window.onlinePlayback.openAnime(anime, '', null, {});
      return document.querySelector('#onlinePlaybackPickerTitle').textContent;
    });
    assert.equal(playMode, '播放来源');

    assert.deepEqual(errors, []);
    console.log('ok: 详情页与播放器两个下载入口、选集对话框与批量请求都符合预期');
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
