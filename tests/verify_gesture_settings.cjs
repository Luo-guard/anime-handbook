// 单集手势设置界面：六格槽位、绑定表、双击提示、冲突检查、恢复默认。
const fs = require('fs');
const assert = require('node:assert/strict');
const { chromium } = require('C:/Users/han/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

const html = fs.readFileSync('static/index.html', 'utf8');
const start = html.indexOf('<h3 class="settings-subsection-title">单集扇区与手势</h3>');
const end = html.indexOf('<h3 class="settings-subsection-title">外部查询链接</h3>', start);
assert(start > 0 && end > start, 'settings block exists');
const block = html.slice(start, end);

const setup = `
const $=(s,r=document)=>r.querySelector(s),$$=(s,r=document)=>[...r.querySelectorAll(s)];
const escapeHtml=v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const state={settings:{},pendingEpisodes:new Set()};
`;

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setContent(`<style>${fs.readFileSync('static/styles.css', 'utf8')}</style><main style="max-width:760px;margin:20px auto;padding:20px">${block}</main>`);
    await page.addScriptTag({ content: setup + fs.readFileSync('static/modules/episode-gesture.js', 'utf8') + '\nrenderEpisodeGestureSettings();' });

    assert.equal(await page.locator('[data-eg-slot]').count(), 6, 'six slot selects');
    assert.equal(await page.locator('[data-eg-gesture]').count(), 11, 'eleven gesture selects');
    assert.equal(await page.locator('[data-eg-slot="top"]').inputValue(), 'play');
    assert.equal(await page.locator('[data-eg-gesture="RightClick"]').inputValue(), 'open_menu');
    assert.equal(await page.locator('[data-eg-gesture="Ctrl+Click"]').inputValue(), 'open_detail');
    assert.equal(await page.locator('#episodeGestureDoubleWarning').isVisible(), false, 'no double-click warning by default');

    const read = () => page.evaluate(() => readEpisodeGestureSettings());

    // 去掉一格、改绑一个手势
    await page.locator('[data-eg-slot="top"]').selectOption('');
    await page.locator('[data-eg-gesture="MiddleClick"]').selectOption('play');
    let value = await read();
    assert.equal(value.slots.top, '', 'slot can be emptied');
    assert.equal(value.bindings.MiddleClick, 'play', 'gesture can be bound');
    assert.equal(value.keep_menu_on_release, true);
    const playbackSource = page.locator('#episodePlaybackSourceInput');
    await playbackSource.selectOption('online');
    assert.equal((await read()).playback_source, 'online');

    // 清空某个手势要显式传 ""：后端把「没提到的键」当默认值保留（审计 N18），
    // 前端以前跳过空值，等于用户解绑后默认绑定会在保存时悄悄长回来。
    await page.locator('[data-eg-gesture="RightClick"]').selectOption('');
    value = await read();
    assert.ok('RightClick' in value.bindings, 'unbound gesture must be sent explicitly');
    assert.equal(value.bindings.RightClick, '', 'empty string means unbind');
    await page.locator('[data-eg-gesture="RightClick"]').selectOption('open_menu');

    // 绑定双击会给出延迟代价提示
    await page.locator('[data-eg-gesture="DoubleClick"]').selectOption('download');
    assert.equal(await page.locator('#episodeGestureDoubleWarning').isVisible(), true, 'double click shows the warning');
    await page.locator('[data-eg-gesture="DoubleClick"]').selectOption('');
    assert.equal(await page.locator('#episodeGestureDoubleWarning').isVisible(), false, 'warning goes away when unbound');

    // 同一个动作超过 4 个手势要拦下来
    for (const gesture of ['RightClick', 'LongClick', 'MiddleClick', 'Ctrl+Click', 'Alt+Click']) {
      await page.locator(`[data-eg-gesture="${gesture}"]`).selectOption('play');
    }
    const status = await page.locator('#episodeGestureStatus').textContent();
    assert.match(status, /最多绑定 4 个手势/, 'conflict is reported in the UI');
    await assert.rejects(read, /最多绑定 4 个手势/);

    // 恢复默认
    await page.locator('#resetEpisodeGestures').click();
    assert.equal(await playbackSource.inputValue(), 'auto');
    assert.equal(await page.locator('[data-eg-slot="top"]').inputValue(), 'play');
    assert.equal(await page.locator('[data-eg-gesture="RightClick"]').inputValue(), 'open_menu');
    assert.equal(await page.locator('#episodeGestureStatus').textContent(), '');
    assert.deepEqual(errors, [], 'no page errors');
    console.log('Gesture settings: six slots, bindings, double-click warning, conflict guard and reset passed.');
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exit(1); });
