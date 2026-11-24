// 播放器里的下载入口：点「下载」进选集对话框 → 勾多集 → 批量入队。
const fs = require('fs');
const assert = require('node:assert/strict');
const { chromium } = require('C:/Users/han/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

const html = fs.readFileSync('static/index.html', 'utf8');
const source = fs.readFileSync('static/modules/online-playback.js', 'utf8');

// 1) 按钮在线路工具条里，和「切换规则 / 打开原网页」同一行。
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

// 3) 交互接线：点下载先选集；单集走原接口，多集走批量接口。
assert(source.includes('$("#onlinePlayerDownload").addEventListener("click", openDownloadSheet)'), '下载按钮没有打开选集');
assert(source.includes('"/api/offline/web-download-batch"'), '没有走批量下载接口');
assert(source.includes('"/api/offline/web-download"'), '单集接口丢了');
assert(source.includes('items: picked.map(row => ({ episode_key: `0:${row.number}`, episode_id: row.id }))'), '批量请求缺少集号与片源集 ID');
assert(source.includes('episodes.length === 1'), '只有一集时应该直接下载，不弹空对话框');

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setContent('<div id="host"></div>');
    await page.addScriptTag({ content: 'window.state={animes:[],progressAnime:null};window.escapeHtml=v=>String(v??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll(String.fromCharCode(34),"%22");' + source });

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

    assert.deepEqual(errors, []);
    console.log('ok: 下载入口、选集对话框与批量请求都符合预期');
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
