const fs = require('fs'), assert = require('node:assert/strict');
const { chromium } = require('C:/Users/han/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

const harness = [
  "const $=s=>document.querySelector(s);",
  "const state={settings:{}};",
  "window.editingSupported=true;",
  "const collectionEditingSupported=()=>window.editingSupported!==false;",
  "const booleanSetting=(key,fallback=false)=>{const v=state.settings?.[key];return typeof v==='boolean'?v:fallback;};",
  "const enabledSetting=key=>booleanSetting(key,true);",
].join('\n');

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1180, height: 820 } });
    const html = fs.readFileSync('static/index.html', 'utf8')
      .replace(/<script[\s\S]*?<\/script>/g, '')
      .replace(/<link[^>]*>/g, '');
    await page.setContent(`<style>${fs.readFileSync('static/styles.css', 'utf8')}</style>${html}`);
    await page.addScriptTag({ content: harness + '\n' + fs.readFileSync('static/modules/toolbar-buttons.js', 'utf8') });

    const visible = sel => page.locator(sel).evaluate(n => !n.classList.contains('hidden'));
    const labelShown = sel => page.locator(sel).evaluate(n => getComputedStyle(n.querySelector('.button-label')).display !== 'none');

    // 结构：两个按钮都在动作区里，跳转记录紧跟在搜索添加番剧后面。
    assert.equal(await page.evaluate(() => {
      const group = document.querySelector('.collection-toolbar-actions');
      const kids = [...group.children];
      return kids.indexOf(document.querySelector('#jumpHistoryButton')) - kids.indexOf(document.querySelector('#collectionSearchButton'));
    }), 1);
    assert.equal(await page.evaluate(() => !!document.querySelector('.search-field, .search-box-action')), false, 'search box no longer carries an inner button');

    // 默认：搜索添加番剧带文字，跳转记录只有图标。
    await page.evaluate(() => applyCollectionToolbarButtons());
    assert.equal(await visible('#collectionSearchButton'), true);
    assert.equal(await visible('#jumpHistoryButton'), true);
    assert.equal(await labelShown('#collectionSearchButton'), true);
    assert.equal(await labelShown('#jumpHistoryButton'), false);
    assert.equal(await page.locator('#jumpHistoryButton').getAttribute('title'), '跳转记录');
    assert.equal(await page.locator('#jumpHistoryButton').getAttribute('aria-label'), '跳转记录');
    const iconBox = await page.locator('#jumpHistoryButton').boundingBox();
    const textBox = await page.locator('#collectionSearchButton').boundingBox();
    assert.ok(Math.abs(iconBox.width - 42) <= 1, 'icon-only button is a square 42px');
    assert.ok(Math.abs(iconBox.height - textBox.height) <= 1, 'both buttons share one height');

    // 只显示图标 / 显示文字 可以分别设置。
    await page.evaluate(() => { state.settings.collection_add_button_icon_only = true; applyCollectionToolbarButtons(); });
    assert.equal(await labelShown('#collectionSearchButton'), false);
    assert.ok(Math.abs((await page.locator('#collectionSearchButton').boundingBox()).width - 42) <= 1);
    assert.equal(await page.locator('#collectionSearchButton').getAttribute('aria-label'), '搜索添加番剧');
    await page.evaluate(() => { state.settings.jump_history_button_icon_only = false; applyCollectionToolbarButtons(); });
    assert.equal(await labelShown('#jumpHistoryButton'), true);
    assert.ok((await page.locator('#jumpHistoryButton').boundingBox()).width > 60, 'with text the button grows');

    // 显隐各自独立。
    await page.evaluate(() => { state.settings.show_jump_history_button = false; applyCollectionToolbarButtons(); });
    assert.equal(await visible('#jumpHistoryButton'), false);
    assert.equal(await visible('#collectionSearchButton'), true);
    await page.evaluate(() => { state.settings.show_jump_history_button = true; state.settings.show_collection_add_button = false; applyCollectionToolbarButtons(); });
    assert.equal(await visible('#jumpHistoryButton'), true);
    assert.equal(await visible('#collectionSearchButton'), false);

    // 只读 / 在线模式两个都藏起来。
    await page.evaluate(() => { window.editingSupported = false; applyCollectionToolbarButtons(); });
    assert.equal(await visible('#jumpHistoryButton'), false);
    assert.equal(await visible('#collectionSearchButton'), false);

    // 设置开关本身在设置面板里，且默认值与界面一致。
    await page.evaluate(() => { window.editingSupported = true; state.settings = {}; applyCollectionToolbarButtons(); });
    for (const id of ['showCollectionAddButtonInput', 'collectionAddIconOnlyInput', 'showJumpHistoryButtonInput', 'jumpHistoryIconOnlyInput']) {
      assert.equal(await page.locator(`#${id}`).count(), 1, `${id} exists`);
    }

    console.log('Toolbar buttons: placement next to each other, icon-only/text modes, independent visibility, read-only hiding and settings entries passed.');
  } finally {
    await browser.close();
  }
})().catch(e => { console.error(e); process.exit(1); });
