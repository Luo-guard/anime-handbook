// 设置搜索导航实测：真浏览器打开设置弹窗，输入关键词后验证
// 1) 命中文字有 <mark> 加粗高亮  2) 「n / m」计数  3) ↑/↓ 与 Enter 遍历
const path = require('node:path');
const { chromium } = require('C:/Users/han/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert = require('node:assert/strict');

(async () => {
  const browser = await chromium.launch({ ignoreDefaultArgs: ['--hide-scrollbars'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto('http://127.0.0.1:43127/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);

  // 走应用自己的打开流程：#settingsButton 点击时才会 bind 搜索事件
  await page.locator('#settingsButton').click();
  await page.waitForTimeout(300);
  await page.locator('#settingsModal[open]').waitFor({ state: 'visible', timeout: 5000 });
  const input = page.locator('#settingsSearch');
  await input.fill('收藏');
  await page.waitForTimeout(400);

  // mark 高亮存在且有样式
  const markInfo = await page.evaluate(() => {
    const marks = [...document.querySelectorAll('#settingsSearchResults .settings-hit-mark')];
    if (!marks.length) return { count: 0 };
    const style = getComputedStyle(marks[0]);
    return {
      count: marks.length,
      fontWeight: style.fontWeight,
      bg: style.backgroundColor,
      text: marks[0].textContent,
    };
  });
  console.log('mark 高亮:', JSON.stringify(markInfo));
  assert.ok(markInfo.count > 0, '应有 mark 高亮');
  assert.equal(markInfo.fontWeight, '700', '命中文字应加粗');
  assert.ok(!['rgba(0, 0, 0, 0)', 'transparent'].includes(markInfo.bg), '高亮应有背景色');

  // 计数与箭头
  const counter1 = await page.locator('#settingsSearchCount').textContent();
  const total = Number(counter1.split('/')[1]?.trim());
  console.log('计数初始:', counter1.trim());
  assert.match(counter1.trim(), /^1 \/ \d+$/, '计数应为 1 / m');
  assert.ok(!await page.locator('#settingsSearchPrev').isHidden(), '↑ 按钮应可见');
  assert.ok(!await page.locator('#settingsSearchNext').isHidden(), '↓ 按钮应可见');

  const currentRow = () => page.evaluate(() => {
    const row = document.querySelector('#settingsSearchResults .setting-row.settings-search-current');
    return row ? (row.textContent.slice(0, 30)) : null;
  });
  console.log('当前匹配1:', await currentRow());

  // 点 ↓ 两次 → 3 / m
  await page.locator('#settingsSearchNext').click();
  await page.locator('#settingsSearchNext').click();
  const counter3 = (await page.locator('#settingsSearchCount').textContent()).trim();
  console.log('点两次↓后:', counter3, '| 当前行:', await currentRow());
  assert.match(counter3, /^3 \//, '点两次 ↓ 计数应为 3 / m');

  // Enter 下一个、Shift+Enter 上一个
  await input.focus();
  await input.press('Enter');
  assert.match((await page.locator('#settingsSearchCount').textContent()).trim(), /^4 \//, 'Enter 应到 4');
  await input.press('Shift+Enter');
  await input.press('Shift+Enter');
  const counter2 = (await page.locator('#settingsSearchCount').textContent()).trim();
  console.log('两次 Shift+Enter 后:', counter2);
  assert.match(counter2, /^2 \//, '两次 Shift+Enter 应回到 2');

  // 循环：从 1 往上回退应绕到最后一个
  await input.press('Shift+Enter');
  await input.press('Shift+Enter');
  const wrap = (await page.locator('#settingsSearchCount').textContent()).trim();
  console.log('绕回测试:', wrap);
  assert.equal(wrap, `${total} / ${total}`, '从头部回退应绕到最后一个');

  // 截图存档
  await page.screenshot({ path: path.join(__dirname, '截图_settings_search_nav.png') });

  // 清空后还原：mark 全部拆掉、计数与箭头隐藏
  await input.fill('');
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => ({
    marks: document.querySelectorAll('.settings-hit-mark').length,
    counterHidden: document.querySelector('#settingsSearchCount').classList.contains('hidden'),
    prevHidden: document.querySelector('#settingsSearchPrev').classList.contains('hidden'),
    searching: document.querySelector('#settingsModal').classList.contains('settings-searching'),
  }));
  console.log('清空后:', JSON.stringify(after));
  assert.equal(after.marks, 0, '清空后不应残留 mark');
  assert.ok(after.counterHidden && after.prevHidden, '清空后计数与箭头应隐藏');

  await browser.close();
  console.log('PASS 设置搜索导航：高亮/计数/遍历/循环/清空还原全部通过');
})().catch((error) => { console.error(error); process.exit(1); });
