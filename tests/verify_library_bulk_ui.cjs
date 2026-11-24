// 媒体库批量删除的界面：进批量态、勾选、全选、取消。
// 这个脚本连本机正在跑的手账，只做选择、不真的删除（删除路径由后端用例覆盖）。
const assert = require('node:assert/strict');
const { chromium } = require('C:/Users/han/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1240, height: 860 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto('http://127.0.0.1:43127/', { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(2200);
    await page.click('#libraryNavButton');
    await page.waitForTimeout(1000);

    // 打开一部有本地文件的番
    const opened = await page.evaluate(() => {
      const card = document.querySelector('#libGrid .library-card');
      if (!card) return null;
      card.click();
      return card.querySelector('.library-name')?.textContent.trim() || '';
    });
    assert.ok(opened, '媒体库里至少要有一部有本地文件的番才能测');
    await page.waitForTimeout(1200);

    assert.equal(await page.locator('#libBulkBar').isHidden(), true, '默认不显示批量条');
    assert.equal(await page.locator('#libSelectToggle').textContent(), '批量');

    // 进批量态：每行出现勾选框，单集的播放/删除按钮让位
    await page.click('#libSelectToggle');
    await page.waitForTimeout(200);
    const rows = await page.locator('#libEpisodes .lib-episode').count();
    assert.ok(rows > 0);
    assert.equal(await page.locator('#libEpisodes input[data-pick]').count(), rows, '每行都要有勾选框');
    assert.equal(await page.locator('#libEpisodes .lib-play').count(), 0, '批量态下不显示单集播放按钮');
    assert.equal(await page.locator('#libBulkBar').isVisible(), true);
    assert.equal(await page.locator('#libBulkCount').textContent(), '已选 0 集');
    assert.equal(await page.locator('#libBulkDelete').isDisabled(), true, '没选东西不能删');

    // 点行也能勾上
    await page.locator('#libEpisodes .lib-episode').first().click();
    await page.waitForTimeout(120);
    assert.equal(await page.locator('#libBulkCount').textContent(), '已选 1 集');
    assert.equal(await page.locator('#libBulkDelete').isDisabled(), false);
    assert.match(await page.locator('#libBulkDelete').textContent(), /删除选中（1 集）/);

    // 全选再取消全选
    await page.click('#libBulkAll');
    await page.waitForTimeout(120);
    assert.equal(await page.locator('#libBulkCount').textContent(), `已选 ${rows} 集`);
    assert.equal(await page.locator('#libBulkAll').textContent(), '取消全选');
    await page.click('#libBulkAll');
    await page.waitForTimeout(120);
    assert.equal(await page.locator('#libBulkCount').textContent(), '已选 0 集');

    // 取消退出批量态：勾选框和操作条都收起来，单集按钮回来
    await page.click('#libBulkCancel');
    await page.waitForTimeout(200);
    assert.equal(await page.locator('#libBulkBar').isHidden(), true);
    assert.equal(await page.locator('#libEpisodes input[data-pick]').count(), 0);
    assert.equal(await page.locator('#libEpisodes .lib-play').count(), rows);

    assert.deepEqual(errors, []);
    console.log('ok: 批量选择、全选/取消、退出批量都正常，未触发真实删除');
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
