// 单集格子手势：六格扇区、点选/滑选、右键、修饰键、双击延迟、可去掉槽位。
const fs = require('fs');
const assert = require('node:assert/strict');
const { chromium } = require('C:/Users/han/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

const setup = `
const $=(s,r=document)=>r.querySelector(s),$$=(s,r=document)=>[...r.querySelectorAll(s)];
const escapeHtml=v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const state={settings:{},pendingEpisodes:new Set(),episodeRecordAnnotations:{}};
window.calls=[];
`;

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setContent(`<style>${fs.readFileSync('static/styles.css', 'utf8')}</style>
      <main style="padding:220px 40px 40px"><div id="progressModal"><div id="episodeGrid" class="episode-grid">
        <section class="episode-group"><div class="episode-group-head"><strong>本篇</strong></div>
          <div class="episode-group-grid">
            ${[1, 2, 3].map((n) => `<button type="button" class="episode-cell" data-episode-key="0:${n}">${String(n).padStart(2, '0')}</button>`).join('')}
          </div>
        </section>
      </div></div></main>`);
    await page.addScriptTag({ content: setup + fs.readFileSync('static/modules/episode-gesture.js', 'utf8') + `
      installEpisodeGestures($("#episodeGrid"), {
        onToggleWatched: (button) => window.calls.push(["toggle", button.dataset.episodeKey]),
        onAction: (action, key) => window.calls.push(["action", action, key]),
      });
    ` });
    const cell = page.locator('[data-episode-key="0:1"]');
    const calls = () => page.evaluate(() => window.calls.splice(0));
    const setConfig = (value) => page.evaluate((v) => { state.settings.episode_gestures = v; }, value);

    // 1) 左键单击固定切换已看
    await cell.click();
    assert.deepEqual(await calls(), [['toggle', '0:1']], 'bare left click toggles watched');

    // 2) 右键单击打开六格扇区，方位与默认动作一致
    await cell.click({ button: 'right' });
    await page.waitForTimeout(60);
    const slots = await page.locator('#episodeQuickMenu [data-slot]').evaluateAll((nodes) =>
      nodes.map((node) => [node.dataset.slot, node.dataset.episodeAction]));
    assert.equal(slots.length, 6, 'six slots by default');
    assert.deepEqual(Object.fromEntries(slots), {
      top: 'play', bottom: 'download', top_right: 'score',
      bottom_right: 'review', top_left: 'ed', bottom_left: 'op',
    }, 'default slot layout');
    assert.deepEqual(await calls(), [], 'opening the menu does not run an action');

    // 3) B 版：弹出后再点某一格
    await page.locator('#episodeQuickMenu [data-slot="top"]').click();
    assert.deepEqual(await calls(), [['action', 'play', '0:1']], 'clicking a slot runs its action');
    await page.waitForTimeout(200); // closing 动画 150ms 后才从 DOM 移除
    assert.equal(await page.locator('#episodeQuickMenu').count(), 0, 'menu closes after choosing');

    // 4) A 版：长按后滑到扇区松手即执行
    const box = await cell.boundingBox();
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.waitForTimeout(480);
    assert.equal(await page.locator('#episodeQuickMenu').count(), 1, 'long press opens the menu');
    await page.mouse.move(cx, cy - 94);
    await page.mouse.up();
    assert.deepEqual(await calls(), [['action', 'play', '0:1']], 'drag to slot and release runs the action');

    // 5) 原地松手时菜单是否保留，由开关决定
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.waitForTimeout(480);
    await page.mouse.up();
    assert.equal(await page.locator('#episodeQuickMenu').count(), 1, 'menu stays by default');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(180);
    assert.equal(await page.locator('#episodeQuickMenu').count(), 0, 'Escape closes the menu');
    await setConfig({ keep_menu_on_release: false });
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.waitForTimeout(480);
    await page.mouse.up();
    await page.waitForTimeout(180);
    assert.equal(await page.locator('#episodeQuickMenu').count(), 0, 'menu closes when keep switch is off');
    await setConfig({});

    // 6) 绑定表：Ctrl+左键 / Alt+左键；带修饰键的单击不能再切换已看
    await page.keyboard.down('Control');
    await cell.click();
    await page.keyboard.up('Control');
    assert.deepEqual(await calls(), [['action', 'open_detail', '0:1']], 'Ctrl+Click runs its bound action');
    await page.keyboard.down('Alt');
    await cell.click();
    await page.keyboard.up('Alt');
    assert.deepEqual(await calls(), [['action', 'reveal_in_folder', '0:1']], 'Alt+Click runs its bound action');

    // 7) 扇区可以去掉某一格
    await setConfig({ slots: { ...JSON.parse(JSON.stringify(await page.evaluate(() => episodeGestureConfig().slots))), top: '' } });
    await cell.click({ button: 'right' });
    await page.waitForTimeout(60);
    assert.equal(await page.locator('#episodeQuickMenu [data-slot]').count(), 5, 'one slot removed');
    assert.equal(await page.locator('#episodeQuickMenu [data-slot="top"]').count(), 0);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(180);
    await setConfig({});

    // 8) 绑定双击后，单击延迟 250ms；双击只执行绑定动作，不切换已看
    await setConfig({ bindings: { DoubleClick: 'play' } });
    await cell.click();
    assert.deepEqual(await calls(), [], 'single click waits for the double-click window');
    await page.waitForTimeout(300);
    assert.deepEqual(await calls(), [['toggle', '0:1']], 'a lone click still toggles watched after the delay');
    await page.locator('[data-episode-key="0:2"]').dblclick();
    assert.deepEqual(await calls(), [['action', 'play', '0:2']], 'double click runs its bound action');
    await setConfig({});

    assert.deepEqual(errors, [], 'no page errors');
    console.log('Episode gestures: six slots, click/drag selection, keep switch, modifier bindings, removable slots and double-click delay passed.');
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exit(1); });
