// 单集格子手势：可变布局、点选/滑选、右键、修饰键与双击延迟。
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
            ${[1, 2, 3].map((n) => `<button type="button" class="episode-cell${n === 1 ? ' downloaded' : ''}" data-episode-type="0" data-episode-key="0:${n}">${String(n).padStart(2, '0')}</button>`).join('')}
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

    // 2) 右键单击，默认动作从顶部顺时针排列。
    await cell.click({ button: 'right' });
    await page.waitForTimeout(60);
    const actions = () => page.locator('#episodeQuickMenu [data-episode-action]').evaluateAll(nodes => nodes.map(node => node.dataset.episodeAction));
    assert.deepEqual(await actions(), ['play', 'score', 'review', 'download', 'op', 'ed']);
    assert.deepEqual(await calls(), [], 'opening the menu does not run an action');
    await page.getByRole('button', { name: '关闭单集扇区' }).click();
    await page.locator('#episodeQuickMenu').waitFor({ state: 'detached' });
    assert.deepEqual(await calls(), [], 'closing the menu does not change watch progress');
    assert.ok(await cell.evaluate(node => document.activeElement === node), 'focus returns to the episode');
    await cell.click({ button: 'right' });

    // 3) B 版：弹出后再点某一格
    await page.locator('#episodeQuickMenu [data-episode-action="play"]').click();
    assert.deepEqual(await calls(), [['action', 'play', '0:1']], 'clicking a slot runs its action');
    await page.waitForTimeout(260); // 收起动画 180ms、DOM 在 200ms 后移除，留余量
    assert.equal(await page.locator('#episodeQuickMenu').count(), 0, 'menu closes after choosing');

    // 3b) 指针离开集数区后，按当前圆钮位置更新高亮。
    await cell.click({ button: 'right' });
    await page.waitForTimeout(60);
    const probe = await page.locator('.episode-cell[data-episode-key="0:1"]').boundingBox();
    const px = probe.x + probe.width / 2, py = probe.y + probe.height / 2;
    for (const action of await actions()) {
      const knob = await page.locator(`#episodeQuickMenu [data-episode-action="${action}"]`).boundingBox();
      await page.mouse.move(px, py);
      await page.mouse.move(knob.x + knob.width / 2, knob.y + knob.height / 2, { steps: 4 });
      await page.waitForTimeout(60);
      const active = await page.evaluate(() =>
        document.querySelector('#episodeQuickMenu [data-episode-action].active')?.dataset.episodeAction || null);
      assert.equal(active, action, `hovering ${action} highlights that action`);
    }
    await page.keyboard.press('Escape');
    await page.waitForTimeout(240);
    assert.equal(await page.locator('#episodeQuickMenu').count(), 0, 'escape closes the hovered menu');

    // 4) A 版：长按后滑到扇区松手即执行
    const box = await cell.boundingBox();
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.waitForTimeout(480);
    assert.equal(await page.locator('#episodeQuickMenu').count(), 1, 'long press opens the menu');
    const topKnob = await page.locator('#episodeQuickMenu [data-episode-action="play"]').boundingBox();
    await page.mouse.move(topKnob.x + topKnob.width / 2, topKnob.y + topKnob.height / 2, { steps: 4 });
    await page.mouse.up();
    assert.deepEqual(await calls(), [['action', 'play', '0:1']], 'drag to slot and release runs the action');

    // 5) 原地松手时菜单是否保留，由开关决定
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.waitForTimeout(480);
    await page.mouse.up();
    assert.equal(await page.locator('#episodeQuickMenu').count(), 1, 'menu stays by default');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(240); // 收起动画 180ms + 200ms 后移除 DOM，留出余量
    assert.equal(await page.locator('#episodeQuickMenu').count(), 0, 'Escape closes the menu');
    await setConfig({ keep_menu_on_release: false });
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.waitForTimeout(480);
    await page.mouse.up();
    await page.waitForTimeout(240); // 收起动画 180ms + 200ms 后移除 DOM，留出余量
    assert.equal(await page.locator('#episodeQuickMenu').count(), 0, 'menu closes when keep switch is off');
    await setConfig({});

    // 6) 单集详情已移除，旧绑定不会触发动作；Alt+左键仍可定位文件。
    await page.keyboard.down('Control');
    await cell.click();
    await page.keyboard.up('Control');
    assert.deepEqual(await calls(), [], 'Ctrl+Click no longer opens the removed episode detail');
    await page.keyboard.down('Alt');
    await cell.click();
    await page.keyboard.up('Alt');
    assert.deepEqual(await calls(), [['action', 'reveal_in_folder', '0:1']], 'Alt+Click runs its bound action');

    // 7) 旧版留空与隐藏配置按顺时针迁移。
    await setConfig({ slots: { top: '' }, hidden_actions: ['download'] });
    await cell.click({ button: 'right' });
    await page.waitForTimeout(60);
    assert.deepEqual(await actions(), ['score', 'review', 'op', 'ed']);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(240); // 收起动画 180ms + 200ms 后移除 DOM，留出余量
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

    await page.evaluate(() => { window.onlinePlayback = {}; });
    await cell.click({ button: 'right' });
    assert.equal(await page.locator('#episodeQuickMenu [data-episode-action="play"]').textContent(), '播放');
    assert.equal(await page.locator('#episodeQuickMenu [data-episode-action$="play"]').count(), 1);
    await page.keyboard.press('Escape');
    await page.locator('#episodeQuickMenu').waitFor({ state: 'detached' });
    await page.locator('[data-episode-key="0:2"]').click({ button: 'right' });
    assert.equal(await page.locator('#episodeQuickMenu [data-episode-action="play"]').count(), 1);

    await page.evaluate(() => Object.assign(state.settings, {
      show_episode_review_record: false, show_episode_rating_record: false, show_oped_record: false,
    }));
    await setConfig({ hidden_actions: ['download'] });
    await page.setViewportSize({ width: 390, height: 640 });
    await cell.click({ button: 'right' });
    assert.deepEqual(await page.locator('#episodeQuickMenu [data-episode-action]').evaluateAll(nodes =>
      nodes.map(node => node.dataset.episodeAction)), ['play']);
    const bounds = await page.locator('#episodeQuickMenu [data-episode-action]').boundingBox();
    assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 390);
    await page.keyboard.press('Escape');
    await setConfig({ bindings: { DoubleClick: 'play', 'Ctrl+DoubleClick': 'reveal_in_folder' } });
    await cell.click();
    await page.locator('[data-episode-key="0:2"]').click();
    await page.waitForTimeout(280);
    assert.deepEqual(await calls(), [['toggle', '0:1'], ['toggle', '0:2']]);
    await cell.dblclick({ modifiers: ['Control'] });
    assert.deepEqual(await calls(), [['action', 'reveal_in_folder', '0:1']]);

    await setConfig({});
    await page.evaluate(() => {
      state.settings.detail_wheel_style = "modern";
      $('[data-episode-key="0:2"]').classList.add("unreleased");
      delete state.settings.show_episode_review_record;
      delete state.settings.show_episode_rating_record;
      delete state.settings.show_oped_record;
    });
    const wheel = page.locator("#episodeQuickMenu");
    const other = page.locator('[data-episode-key="0:2"]');
    await other.click({ button: "right" });
    await wheel.locator(".episode-wheel-wedge").first().waitFor({ state: "attached" });
    assert.equal(await wheel.locator(".episode-wheel-wedge").count(), 6);
    assert.equal(await wheel.locator(".episode-wheel-icon").count(), 6);
    assert.equal(await wheel.locator("[data-episode-menu-close] small").textContent(), "第 02 集");
    assert.equal(await wheel.locator('[data-episode-action="play"]').isDisabled(), true);
    assert.equal(await wheel.locator('[data-episode-action="reveal_in_folder"]').count(), 0);
    await page.keyboard.press("Escape");
    await cell.click({ button: "right" });
    await page.waitForTimeout(210);
    assert.equal(await wheel.locator(".episode-wheel-wedge").count(), 7);
    const modernBox = await wheel.boundingBox();
    assert(modernBox.x >= 0 && modernBox.x + modernBox.width <= 390 && Math.abs(modernBox.width - modernBox.height) < 1);
    const play = wheel.locator('[data-episode-action="play"]');
    const beforeHover = await play.evaluate(node => ({
      transform: getComputedStyle(node).transform,
      wedge: getComputedStyle(node.nextElementSibling).backgroundImage,
    }));
    await page.mouse.move(modernBox.x + modernBox.width / 2, modernBox.y + 14);
    const highlighted = await play.evaluate(node => ({
      active: node.classList.contains("active"),
      background: getComputedStyle(node).backgroundColor,
      transform: getComputedStyle(node).transform,
      wedge: getComputedStyle(node.nextElementSibling).backgroundImage,
    }));
    assert.equal(highlighted.active, true);
    assert.equal(highlighted.transform, beforeHover.transform, "hover does not scale the label");
    assert.equal(highlighted.background, "rgba(0, 0, 0, 0)", "highlight is painted on the wedge only");
    assert.notEqual(highlighted.wedge, beforeHover.wedge);
    await page.mouse.click(modernBox.x + modernBox.width / 2, modernBox.y + 14);
    assert.deepEqual(await calls(), [["action", "play", "0:1"]]);
    const modernCellBox = await cell.boundingBox();
    await page.mouse.move(modernCellBox.x + modernCellBox.width / 2, modernCellBox.y + modernCellBox.height / 2);
    await page.mouse.down();
    await wheel.waitFor();
    await page.waitForTimeout(200);
    const holdBox = await wheel.boundingBox();
    await page.mouse.move(holdBox.x + holdBox.width / 2, holdBox.y + 14);
    await page.mouse.up();
    assert.deepEqual(await calls(), [["action", "play", "0:1"]]);

    await page.evaluate(() => { state.settings.detail_wheel_style = "classic"; });
    await other.click({ button: "right" });
    assert.equal(await wheel.locator(".episode-wheel-wedge").count(), 0);
    assert(await wheel.locator('[data-episode-action="play"]').isDisabled());
    await page.keyboard.press("Escape");
    await page.evaluate(() => {
      $("#progressModal").dataset.detailBackground = "artwork";
      state.settings.detail_wheel_style = "modern";
    });
    await other.click({ button: "right" });
    assert.equal(await wheel.locator(".episode-wheel-wedge").count(), 6);
    assert.deepEqual(await calls(), []);
    await page.keyboard.press("Escape");

    const allActions = ["play", "score", "review", "op", "ed", "download", "cancel_download", "delete", "reveal_in_folder", "redownload"];
    for (const style of ["classic", "modern"]) {
      await page.evaluate(value => { state.settings.detail_wheel_style = value; }, style);
      for (const viewport of [{ width: 1000, height: 800 }, { width: 340, height: 650 }, { width: 650, height: 230 }]) {
        await page.setViewportSize(viewport);
        for (let count = 0; count <= allActions.length; count += 1) {
          const selected = allActions.slice(0, count);
          await setConfig({ actions: selected });
          await cell.click({ button: "right" });
          assert.deepEqual(await actions(), selected, `${style} ${viewport.width}×${viewport.height} / ${count}`);
          if (count) {
            await page.locator("#episodeQuickMenu.visible").waitFor({ state: "attached" });
            const layout = await wheel.evaluate(menu => {
              const buttons = [...menu.querySelectorAll("button")].map(node => node.getBoundingClientRect());
              const compact = menu.classList.contains("detail-wheel-compact");
              const box = menu.getBoundingClientRect();
              return {
                fits: (!compact || (box.top >= 0 && box.bottom <= innerHeight))
                  && buttons.every((a, index) => a.left >= 0 && a.right <= innerWidth
                    && (compact || (a.top >= 0 && a.bottom <= innerHeight))
                    && buttons.slice(index + 1).every(b => a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top)),
                boxes: buttons.map(button => button.toJSON()),
              };
            });
            assert(layout.fits, `${style} ${viewport.width}×${viewport.height} / ${count} buttons fit without overlap: ${JSON.stringify(layout.boxes)}`);
            if (viewport.height === 230 && count === allActions.length) {
              await wheel.locator("[data-episode-action]").last().click();
              assert.deepEqual(await calls(), [["action", "redownload", "0:1"]]);
            } else {
              await page.keyboard.press("Escape");
            }
          }
        }
      }
    }

    const touchPage = await browser.newPage({viewport: {width: 340, height: 650}, hasTouch: true, isMobile: true});
    await touchPage.setContent(`<meta name="viewport" content="width=device-width,initial-scale=1">
      <style>${fs.readFileSync('static/styles.css', 'utf8')}</style>
      <div id="progressModal" style="margin-top:200px"><div id="episodeGrid">
        <button class="episode-cell downloaded" data-episode-key="0:1" style="width:55px;height:55px">01</button>
      </div></div><div style="height:850px"></div>`);
    await touchPage.addScriptTag({content: setup + fs.readFileSync('static/modules/episode-gesture.js', 'utf8') + `
      state.settings.detail_wheel_style = "modern";
      state.settings.episode_gestures = { actions: ${JSON.stringify(allActions)} };
      installEpisodeGestures($("#episodeGrid"), {
        onToggleWatched: () => calls.push("toggle"),
        onAction: action => calls.push(action),
      });
    `});
    const client = await touchPage.context().newCDPSession(touchPage);
    const touch = (type, x, y) => client.send("Input.dispatchTouchEvent", {
      type, touchPoints: type === "touchEnd" ? [] : [{x, y}],
    });
    const finger = await touchPage.locator(".episode-cell").boundingBox();
    const x = finger.x + finger.width / 2;
    const y = finger.y + finger.height / 2;
    await touch("touchStart", x, y);
    await touch("touchMove", x, y - 65);
    await touch("touchMove", x, y - 130);
    await touch("touchEnd");
    await touchPage.waitForFunction(() => scrollY > 0);
    assert.deepEqual(await touchPage.evaluate(() => calls), []);
    await touchPage.evaluate(() => scrollTo(0, 0));
    await touch("touchStart", x, y);
    await touchPage.locator("#episodeQuickMenu.visible.detail-wheel-compact").waitFor({state: "attached"});
    await touchPage.waitForTimeout(200);
    const score = await touchPage.locator('[data-episode-action="score"]').boundingBox();
    await touch("touchMove", score.x + score.width / 2, score.y + score.height / 2);
    await touch("touchEnd");
    assert.deepEqual(await touchPage.evaluate(() => calls), ["score"]);
    await touchPage.close();

    assert.deepEqual(errors, [], 'no page errors');
    console.log('Episode gestures: legacy migration, click/drag, modifier bindings and 0–10 actions in both styles and compact viewports passed.');
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exit(1); });
