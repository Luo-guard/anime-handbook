// 周表三来源独立排序/筛选 + 隐藏番剧 回归
const assert = require('node:assert/strict');
const { chromium } = require('C:/Users/han/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

(async () => {
  const browser = await chromium.launch({ headless: true, ignoreDefaultArgs: ['--hide-scrollbars'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  const original = await (await fetch('http://127.0.0.1:43127/api/bootstrap')).json().then((d) => ({
    preferences: d.settings?.schedule_preferences || null,
    hidden: d.settings?.schedule_hidden || null,
    source: d.settings?.schedule_source || 'yuc',
  }));
  const restore = async () => {
    const body = {};
    if (original.preferences !== null) body.schedule_preferences = original.preferences;
    if (original.hidden !== null) body.schedule_hidden = original.hidden;
    body.schedule_source = original.source;
    await fetch('http://127.0.0.1:43127/api/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  };
  try {
    // 从干净状态开始：清空嵌套偏好与隐藏列表
    await fetch('http://127.0.0.1:43127/api/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ schedule_preferences: {}, schedule_hidden: [], schedule_source: 'yuc' }) });
    await page.goto('http://127.0.0.1:43127/', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(1500);

    // 1) 周表（yuc）打开筛选弹窗：副标题指明来源；改成「评分优先」并取消「在看」
    await page.evaluate(() => { switchView('schedule'); });
    await page.waitForTimeout(1200);
    await page.click('#scheduleFilterButton');
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => document.querySelector('#scheduleFilterSourceLabel').textContent.includes('長門番堂')), true, '弹窗副标题要标明来源');
    await page.evaluate(() => {
      document.querySelector('#scheduleSortOptions [data-uniform-sort]').value = 'score';
      const status = [...document.querySelectorAll('#scheduleFilterStatuses input')].find((i) => i.value === '1');
      status.checked = false;
    });
    await page.click('#scheduleApplyFilter');
    await page.waitForTimeout(600);
    const saved = await (await fetch('http://127.0.0.1:43127/api/bootstrap')).json().then((d) => d.settings.schedule_preferences);
    assert.equal(saved?.yuc?.schedule_sort, 'score', 'yuc 的排序要存进嵌套结构');
    assert.ok(!saved.yuc.schedule_statuses.includes(1), 'yuc 的「在看」筛选要移除');
    assert.equal(saved.kazumi, undefined, 'kazumi 不能被波及');

    // 2) 切到 Bangumi 来源：它的排序仍是默认「时间顺序」——独立性证明
    await page.evaluate(() => {
      const control = document.querySelector('#scheduleSourceSwitch');
      control.value = 'kazumi';
      control.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForTimeout(1200);
    await page.click('#scheduleFilterButton');
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => document.querySelector('#scheduleFilterSourceLabel').textContent.includes('Bangumi')), true);
    assert.equal(await page.evaluate(() => document.querySelector('#scheduleSortOptions [data-uniform-sort]').value), 'time', 'Bangumi 的排序必须是自己的默认值');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    // 3) 设置 → 周表：选择器切换两套配置互不相同
    await page.evaluate(() => document.querySelector('#progressModal')?.close());
    await page.click('#settingsButton');
    await page.waitForTimeout(500);
    await page.evaluate(() => switchSettingsTab('schedule'));
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => document.getElementById('scheduleSettingsSource').value), 'yuc', '选择器默认 yuc');
    assert.equal(await page.evaluate(() => document.querySelector('#scheduleSortingSettings [data-uniform-sort]').value), 'score', '选择器 yuc → 评分优先');
    await page.evaluate(() => {
      const select = document.querySelector('#scheduleSettingsSource');
      select.value = 'kazumi';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForTimeout(250);
    assert.equal(await page.evaluate(() => document.querySelector('#scheduleSortingSettings [data-uniform-sort]').value), 'time', '选择器 kazumi → 时间顺序');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    // 4) 隐藏番剧：设置里加一部 → 周表消失 + 通知计数；管理弹窗可恢复
    const target = await (await fetch('http://127.0.0.1:43127/api/bootstrap')).json().then((d) => d.animes.find((a) => a.id === 554779) || d.animes[0]);
    const targetName = target.display_name || target.name_cn || target.name;
    await page.evaluate(() => document.querySelector('#settingsButton').click());
    await page.waitForTimeout(500);
    await page.evaluate(() => switchSettingsTab('schedule'));
    await page.waitForTimeout(300);
    await page.fill('#scheduleHiddenInput', targetName);
    await page.click('#scheduleHiddenAdd');
    await page.waitForTimeout(700);
    let hiddenNow = await (await fetch('http://127.0.0.1:43127/api/bootstrap')).json().then((d) => d.settings.schedule_hidden);
    assert.ok(hiddenNow.includes(target.id), `隐藏列表要有 ${target.id}，实际：${hiddenNow}`);
    // 管理弹窗列出并可恢复
    await page.click('#scheduleHiddenManage');
    await page.waitForTimeout(300);
    assert.ok(await page.locator(`#scheduleHiddenList [data-schedule-unhide="${target.id}"]`).count() === 1, '管理列表要列出该番');
    await page.click(`#scheduleHiddenList [data-schedule-unhide="${target.id}"]`);
    await page.waitForTimeout(700);
    hiddenNow = await (await fetch('http://127.0.0.1:43127/api/bootstrap')).json().then((d) => d.settings.schedule_hidden);
    assert.ok(!hiddenNow.includes(target.id), '取消隐藏要移出列表');

    console.log('verify_schedule_sources: OK');
  } finally {
    await restore();
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exit(1); });
