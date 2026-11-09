// 媒体库这一侧边栏的「设置侧」回归：能否隐藏、上移下移能否保存、页面名能否改、
// 快捷键与默认主页能否用上它。以前这四件事都因为后端白名单漏了 library 而静默失效。
const assert = require('node:assert/strict');
const { chromium } = require('C:/Users/han/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const API = 'http://127.0.0.1:43127';

const patch = (body) => fetch(`${API}/api/settings`, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json', Origin: API },
  body: JSON.stringify(body),
});
const settings = async () => (await (await fetch(`${API}/api/bootstrap`)).json()).settings;

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const openSettings = async () => {
    await page.click('#settingsButton');
    await page.waitForFunction(() => document.querySelector('#settingsModal')?.open === true, null, { timeout: 8000 });
    await page.waitForTimeout(300);
  };
  try {
    await patch({ sidebar_order: ['collection', 'library', 'schedule', 'timeline', 'statistics', 'ranking', 'settings'], library_sidebar: 'show', default_view: 'collection', sidebar_labels: {} });
    await page.goto(API, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => (state?.animes || []).length > 0, null, { timeout: 40000 });
    await openSettings();

    // 1) 勾选框可点（以前是 disabled），取消勾选 = 隐藏
    const box = '.sidebar-visibility-check[data-sidebar-id="library"]';
    assert.equal(await page.locator(box).isDisabled(), false, '媒体库的显示勾选框要能点');
    await page.evaluate((sel) => {
      const input = document.querySelector(sel);
      input.checked = false;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, box);
    await page.waitForFunction(() => document.querySelector('#libraryNavButton').classList.contains('hidden'), null, { timeout: 10000 });
    assert.equal((await settings()).library_sidebar, 'hide', '取消勾选要写进 library_sidebar');

    // 2) 刷新后仍然隐藏；且设置里的「媒体库」分类还在（否则没法改回来）
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => (state?.animes || []).length > 0, null, { timeout: 40000 });
    await page.waitForFunction(() => document.querySelector('#libraryNavButton').classList.contains('hidden'), null, { timeout: 15000 });
    await openSettings();
    assert.equal(await page.locator('[data-settings-tab="offline"]').isVisible(), true, '隐藏后设置分类仍要可见');

    // 3) 勾回来 = 显示
    await page.evaluate((sel) => {
      const input = document.querySelector(sel);
      input.checked = true;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, box);
    await page.waitForFunction(() => !document.querySelector('#libraryNavButton').classList.contains('hidden'), null, { timeout: 10000 });
    assert.equal((await settings()).library_sidebar, 'show');

    // 4) 上移/下移：暂存 → 保存 → 刷新后仍是新顺序
    await page.evaluate(() => document.querySelector('.sidebar-order-button[data-sidebar-id="library"][data-direction="down"]').click());
    await page.waitForTimeout(200);
    await page.evaluate(() => document.querySelector('#saveSettings').click());
    await page.waitForFunction(async () => {
      const data = await (await fetch('/api/bootstrap')).json();
      const order = data.settings.sidebar_order || [];
      return order.indexOf('library') === 2;
    }, null, { timeout: 15000 });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => (state?.animes || []).length > 0, null, { timeout: 40000 });
    await page.waitForTimeout(600);
    const navOrder = await page.evaluate(() => [...document.querySelectorAll('.main-nav .nav-item')].filter((n) => !n.classList.contains('hidden')).map((n) => n.dataset.navId));
    assert.deepEqual(navOrder, ['collection', 'schedule', 'library', 'timeline', 'statistics', 'ranking', 'settings'], `导航顺序要跟着保存：${navOrder}`);

    // 5) 页面名可改，且导航/标题/设置分类一起变
    await openSettings();
    await page.evaluate(() => { document.querySelector('[data-page-name="library"]').value = '我的库'; });
    await page.evaluate(() => document.querySelector('#saveSettings').click());
    await page.waitForFunction(async () => (await (await fetch('/api/bootstrap')).json()).settings.sidebar_labels?.library === '我的库', null, { timeout: 15000 });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => (state?.animes || []).length > 0, null, { timeout: 40000 });
    await page.waitForTimeout(600);
    const labels = await page.evaluate(() => ({
      nav: document.querySelector('#libraryNavButton span').textContent,
      title: document.querySelector('#libraryView h1').textContent,
      tab: document.querySelector('[data-settings-tab="offline"]').textContent,
    }));
    assert.deepEqual(labels, { nav: '我的库', title: '我的库', tab: '我的库' }, `改名要一致：${JSON.stringify(labels)}`);
    await patch({ sidebar_labels: {} });

    // 6) 快捷键 7 打开媒体库；隐藏后按 7 不跳过去
    await patch({ library_sidebar: 'show' });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => (state?.animes || []).length > 0, null, { timeout: 40000 });
    // 等快捷键模块与导航都就绪，别在绑定生效前按键
    await page.waitForFunction(() => typeof keyboardPreferences === 'function'
      && keyboardPreferences().bindings.library?.enabled === true
      && !document.querySelector('#libraryNavButton').classList.contains('hidden'), null, { timeout: 15000 });
    const viaKey = await page.evaluate(async () => {
      switchView('collection');
      await new Promise((r) => setTimeout(r, 200));
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '7', bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 400));
      return state.activeView;
    });
    assert.equal(viaKey, 'library', '快捷键 7 要能打开媒体库');
    await patch({ library_sidebar: 'hide' });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => (state?.animes || []).length > 0, null, { timeout: 40000 });
    await page.waitForTimeout(1500);
    const hiddenKey = await page.evaluate(async () => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '7', bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 300));
      return state.activeView;
    });
    assert.equal(hiddenKey, 'collection', '隐藏时快捷键不该跳进媒体库');

    // 7) 默认主页可以是媒体库；被隐藏时退回收藏夹
    await patch({ library_sidebar: 'show', default_view: 'library' });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => (state?.animes || []).length > 0, null, { timeout: 40000 });
    await page.waitForTimeout(800);
    assert.equal(await page.evaluate(() => state.activeView), 'library', '默认主页设成媒体库时要落在媒体库');
    await patch({ library_sidebar: 'hide' });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => (state?.animes || []).length > 0, null, { timeout: 40000 });
    await page.waitForTimeout(1800);
    assert.equal(await page.evaluate(() => state.activeView), 'collection', '媒体库被隐藏时默认主页要退回收藏夹');

    assert.deepEqual(errors, [], `页面不能报错：${errors.join(' | ')}`);
    console.log('Media library in settings: hide/show via checkbox, order persists, rename applies everywhere, shortcut 7 and default view respect hidden state.');
  } finally {
    // 固定恢复到「可见 + 收藏夹 + 默认顺序」：这个测试会把显隐改来改去，
    // 若跟着「运行前的值」还原，一旦上次中断留下 hide，后面的用例就全被带崩。
    await patch({
      sidebar_order: ['collection', 'library', 'schedule', 'timeline', 'statistics', 'ranking', 'settings'],
      library_sidebar: 'show',
      default_view: 'collection',
      sidebar_labels: {},
    });
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exit(1); });
