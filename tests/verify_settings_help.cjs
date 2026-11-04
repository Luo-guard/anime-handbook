const fs = require('fs'), assert = require('node:assert/strict');
const { chromium } = require('C:/Users/han/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

const harness = [
  "const $=s=>document.querySelector(s);",
  "const $$=s=>[...document.querySelectorAll(s)];",
  "const escapeHtml=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('\"','&quot;').replaceAll(\"'\",'&#039;');",
].join('\n');

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1180, height: 900 } });
    const html = fs.readFileSync('static/index.html', 'utf8')
      .replace(/<script[\s\S]*?<\/script>/g, '')
      .replace(/<link[^>]*>/g, '');
    await page.setContent(`<style>${fs.readFileSync('static/styles.css', 'utf8')}</style>${html}`);
    await page.addScriptTag({ content: harness + '\n' + fs.readFileSync('static/modules/settings-help.js', 'utf8') });
    await page.evaluate(() => {
      let node = document.querySelector('#settingsModal');
      while (node) { node.classList.remove('hidden'); node = node.parentElement; }
      document.querySelector('#settingsModal').showModal();
    });

    const helpCount = await page.locator('#settingsModal .setting-help').count();
    assert.ok(helpCount > 50, `every setting row gets a help button (got ${helpCount})`);
    assert.equal(await page.locator('#settingsModal .setting-help').evaluateAll(ns => ns.every(n => n.textContent === '?' && n.getAttribute('aria-expanded') === 'false')), true);

    // 说明文字默认收起；只有带 id 的运行时状态行和子编辑器内的小提示保持可见。
    const sources = await page.locator('#settingsModal .setting-help-source').evaluateAll((nodes) => ({
      total: nodes.length,
      visible: nodes.filter((node) => getComputedStyle(node).display !== 'none').length,
    }));
    assert.ok(sources.total > 50, `descriptions moved behind help buttons (got ${sources.total})`);
    assert.equal(sources.visible, 0, 'static descriptions start hidden');

    const row = page.locator('.setting-row', { hasText: '显示单集评价入口' });
    const button = row.locator('.setting-help');
    const popover = page.locator('#settingHelpPopover');

    // 分区导语也收进标题问号，正文默认不显示。
    assert.equal(await page.locator('.settings-lead').isVisible(), false, 'section lead is collapsed');
    const themeHelp = page.locator('.settings-section-title', { hasText: '主题' }).locator('.setting-help');
    assert.equal(await themeHelp.count(), 1, 'section title gets a help button');
    await themeHelp.click();
    await page.waitForTimeout(200);
    assert.match(await popover.innerText(), /点卡片立即切换/, 'section help carries the lead text');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);

    // 共享/同步的编号步骤说明同样收起。
    const step = page.locator('.sharing-step-heading').first();
    assert.equal(await step.locator('.setting-help').count(), 1, 'sharing step gets a help button');
    assert.equal(await step.locator('small').isVisible(), false, 'step description is collapsed');
    await step.locator('.setting-help').click();
    await page.waitForTimeout(200);
    assert.match(await popover.innerText(), /应用密码/, 'step help carries its description');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);

    // 站点编辑器的字段级说明也收起。
    const siteLabel = page.locator('.bgm-source-editor label', { has: page.locator('#bgmSourceSiteInput') });
    assert.equal(await siteLabel.locator('small').isVisible(), false, 'field hint is collapsed');
    await siteLabel.locator('.setting-help').click();
    await page.waitForTimeout(200);
    assert.match(await popover.innerText(), /用于打开番剧详情页/, 'field help carries its hint');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);

    // 运行时状态不是说明，必须继续可见。
    assert.equal(await page.locator('#launchAtLoginHint').isVisible(), true, 'launch binding status stays visible');
    assert.equal(await page.locator('#kazumiPath').isVisible(), true, 'local Kazumi path stays visible');

    // 悬停出现，移开消失。
    await button.hover();
    await page.waitForTimeout(250);
    assert.equal(await popover.isVisible(), true);
    assert.match(await popover.innerText(), /显示单集评价入口/);
    assert.match(await popover.innerText(), /单集快捷菜单/);
    await page.mouse.move(10, 10);
    await page.waitForTimeout(250);
    assert.equal(await popover.isVisible(), false, 'hover leaves closes the tooltip');

    // 点击固定：移开鼠标仍在，再次点击收起。
    await button.click();
    await page.mouse.move(10, 10);
    await page.waitForTimeout(200);
    assert.equal(await popover.isVisible(), true, 'click pins the tooltip');
    assert.equal(await button.getAttribute('aria-expanded'), 'true');
    await button.click();
    await page.waitForTimeout(150);
    assert.equal(await popover.isVisible(), false);

    // 点问号不会顺带切换同一行的开关。
    const toggle = page.locator('#showEpisodeReviewRecordInput');
    const before = await toggle.isChecked();
    await button.click();
    await page.waitForTimeout(150);
    assert.equal(await toggle.isChecked(), before, 'help click must not toggle the row switch');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    // 点旁边的开关仍然正常。
    await row.locator('.switch').click();
    assert.equal(await toggle.isChecked(), !before);
    await row.locator('.switch').click();

    // Esc 只收起说明，不关掉设置面板。
    await button.click();
    await page.waitForTimeout(150);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    assert.equal(await popover.isVisible(), false);
    assert.equal(await page.locator('#settingsModal').evaluate(n => n.open), true, 'Escape closes only the tooltip');

    // 说明里保留行内代码样式。
    const linkRow = page.locator('.setting-row', { hasText: '详情页搜索入口' }).locator('.setting-help');
    await linkRow.click();
    await page.waitForTimeout(200);
    assert.equal(await page.locator('#settingHelpPopover code').count(), 3);
    assert.match(await popover.innerText(), /保存设置/, 'detailed text mentions saving');

    // 键盘聚焦也能看到说明。
    await page.keyboard.press('Escape');
    await page.locator('.setting-row', { hasText: '显示人物分栏' }).locator('.setting-help').focus();
    await page.waitForTimeout(200);
    assert.equal(await popover.isVisible(), true, 'focus opens the tooltip');

    // 带 id 的状态行保持可见文字（例如坚果云状态），不会被收进问号。
    const statusVisible = await page.locator('#webdavStatus').evaluate(n => getComputedStyle(n).display !== 'none');
    assert.equal(statusVisible, true, 'dynamic status lines stay visible');

    // 重复初始化不会重复添加问号。
    const before2 = await page.locator('#settingsModal .setting-help').count();
    await page.evaluate(() => setupSettingHelp());
    assert.equal(await page.locator('#settingsModal .setting-help').count(), before2);

    console.log('Settings help: one ? per row, descriptions collapsed, hover/click/focus/Escape, switch untouched, inline code, dynamic status kept and idempotent setup passed.');
  } finally {
    await browser.close();
  }
})().catch(e => { console.error(e); process.exit(1); });
