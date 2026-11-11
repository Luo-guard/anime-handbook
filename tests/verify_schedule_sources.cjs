// 周表三来源独立排序/筛选 + 隐藏番剧 回归
const assert = require('node:assert/strict');
const { chromium } = require('C:/Users/han/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const base = process.env.HANDBOOK_TEST_URL || 'http://127.0.0.1:43127';

(async () => {
  const browser = await chromium.launch({ headless: true, ignoreDefaultArgs: ['--hide-scrollbars'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  const original = await (await fetch(base + '/api/bootstrap')).json().then((d) => ({
    preferences: d.settings?.schedule_preferences || null,
    hidden: d.settings?.schedule_hidden || null,
    source: d.settings?.schedule_source || 'yuc',
  }));
  const restore = async () => {
    const body = {};
    if (original.preferences !== null) body.schedule_preferences = original.preferences;
    if (original.hidden !== null) body.schedule_hidden = original.hidden;
    body.schedule_source = original.source;
    await fetch(base + '/api/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  };
  try {
    // 从干净状态开始：清空嵌套偏好与隐藏列表
    await fetch(base + '/api/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ schedule_preferences: {}, schedule_hidden: [], schedule_source: 'yuc' }) });
    await page.goto(base + '/', { waitUntil: 'domcontentloaded', timeout: 20000 });
    // bootstrap 会拉全量数据（2MB+），机器忙时要好几秒；等它真正初始化完再操作，
    // 否则按钮的 onclick 还没绑上，点击静默失效。
    await page.waitForFunction(() => typeof scheduleState !== 'undefined' && scheduleState.initialized === true, null, { timeout: 40000 });

    // 1) 周表（yuc）打开筛选弹窗：副标题指明来源；改成「评分优先」并取消「在看」
    await page.evaluate(() => { switchView('schedule'); });
    await page.waitForFunction(() => (scheduleState.data?.items || []).length > 0, null, { timeout: 40000 });
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
    const saved = await (await fetch(base + '/api/bootstrap')).json().then((d) => d.settings.schedule_preferences);
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

    // 4) 隐藏番剧：入口搬到周表「排序与筛选」，直接点条目隐藏；三套来源各自独立
    await page.evaluate(() => {
      const control = document.querySelector('#scheduleSourceSwitch');
      control.value = 'yuc';
      control.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForFunction(() => scheduleSource() === 'yuc' && (scheduleState.data?.items || []).length > 0, null, { timeout: 40000 });
    await page.waitForTimeout(400);
    await page.evaluate(() => openScheduleFilters());
    await page.click('#scheduleHiddenEnterPick');
    await page.waitForFunction(() => scheduleState.pickHidden);
    const hiddenId = await page.evaluate(() => {
      const item = scheduleFilteredItems().find(row => row.id > 0 && row.kind === 'weekly');
      if (!item) return null;
      scheduleState.day = item.weekday;
      renderSchedule();
      const card = [...document.querySelectorAll('#scheduleGrid [data-schedule-key]')]
        .find(button => button.dataset.scheduleKey === item.key);
      if (!card) return null;
      card.click();
      return Number(item.id);
    });
    assert.ok(hiddenId, '应能在周表隐藏模式点选条目');
    await page.waitForFunction(id => scheduleHiddenIds('yuc').includes(id), hiddenId);
    await page.click('#schedulePickDone');
    assert.ok(!(await page.locator('#scheduleNotice').textContent()).includes('已隐藏'), '常驻提示不再显示隐藏数量');
    let hiddenNow = await (await fetch(base + '/api/bootstrap')).json().then((d) => d.settings.schedule_hidden);
    assert.ok(Array.isArray(hiddenNow?.yuc) && hiddenNow.yuc.includes(hiddenId), `yuc 里要有 ${hiddenId}，实际：${JSON.stringify(hiddenNow)}`);
    assert.deepEqual(hiddenNow.kazumi, [], 'kazumi 不能被 yuc 的隐藏波及');
    assert.deepEqual(hiddenNow.as, [], 'as 不能被 yuc 的隐藏波及');
    // 管理弹窗：按来源列出，能取消隐藏
    await page.click('#scheduleFilterButton');
    await page.click('#scheduleHiddenManageFromFilter');
    await page.waitForTimeout(400);
    assert.ok(await page.locator(`#scheduleHiddenList [data-schedule-unhide="${hiddenId}"]`).count() === 1, '管理列表要列出刚隐藏的条目');
    const chipText = await page.evaluate(() => [...document.querySelectorAll('#scheduleHiddenSources .schedule-hidden-source')].map((b) => b.textContent.trim()).join(' | '));
    assert.ok(chipText.includes('1'), `来源切换按钮要显示各来源的隐藏数量：${chipText}`);
    await page.click(`#scheduleHiddenList [data-schedule-unhide="${hiddenId}"]`);
    await page.waitForTimeout(900);
    hiddenNow = await (await fetch(base + '/api/bootstrap')).json().then((d) => d.settings.schedule_hidden);
    assert.ok(!hiddenNow.yuc.includes(hiddenId), '取消隐藏要移出列表');
    await page.evaluate(() => document.querySelector('#scheduleHiddenModal').close());

    console.log('verify_schedule_sources: OK');
  } finally {
    await restore();
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exit(1); });
