// 本轮批量改动回归：设置搜索 / 自动追番开关 / 原视频名 / 徽标空格 / 找资源预填 / 收藏自动弹离线
const assert = require('node:assert/strict');
const { chromium } = require('C:/Users/han/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

(async () => {
  const browser = await chromium.launch({ headless: true, ignoreDefaultArgs: ['--hide-scrollbars'] });
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  await page.goto('http://127.0.0.1:43127/', { waitUntil: 'domcontentloaded', timeout: 20000 });
  // bootstrap 拉全量数据，机器忙时要好几秒；固定 sleep 会在数据到位前就断言。
  await page.waitForFunction(() => (state?.animes || []).length > 0, null, { timeout: 40000 });
  await page.waitForTimeout(400);

  // T6 完结番徽标：文字「已完结」、没有圆点占位（display:none）
  const badge = await page.evaluate(() => {
    openProgress(535669);
    const badgeNode = document.querySelector('#progressBadge');
    const dot = badgeNode?.querySelector('.update-badge-dot');
    return {
      text: document.querySelector('#progressBadgeText')?.textContent,
      kind: badgeNode?.className,
      dotDisplay: dot ? getComputedStyle(dot).display : null,
    };
  });
  assert.equal(badge.text, '已完结');
  assert.ok(badge.kind.includes('finished'));
  assert.equal(badge.dotDisplay, 'none', '完结徽标的圆点要隐藏，空占位就是用户看到的「空格」');
  await page.evaluate(() => document.querySelector('#progressModal').close());

  // T7 找资源：同番清空搜索框后再点，也要重新填上番名
  const prefilled = await page.evaluate(async () => {
    openProgress(554779);
    await new Promise((r) => setTimeout(r, 200));
    openOffline();
    const first = document.querySelector('#offlineQuery').value;
    document.querySelector('#offlineQuery').value = ''; // 用户清空
    document.querySelector('#offlineModal').close();
    openOffline(); // 同番再开
    const second = document.querySelector('#offlineQuery').value;
    const target = document.querySelector('#offlineTarget').textContent;
    document.querySelector('#offlineModal').close();
    return { first, second, target };
  });
  assert.equal(prefilled.first, '学生会也有洞！');
  assert.equal(prefilled.second, '学生会也有洞！', '同番且搜索框为空时必须重新补填');
  assert.equal(prefilled.target, '学生会也有洞！');

  // T5 播放器标题下显示原视频名（旧任务靠种子标题里的集数对回）
  const source = await page.evaluate(async () => {
    const data = await fetch('/api/offline/state?anime_id=554779').then((r) => r.json());
    offlineView.local = { files: data.files || [], jobs: data.jobs || [] };
    offlineView.animeId = 554779;
    offlineView.animeName = '学生会也有洞！';
    const file = (data.files || []).find((item) => item.exists);
    playLocalFile(file.id);
    await new Promise((r) => setTimeout(r, 400));
    const node = document.querySelector('#offlinePlayerSource');
    const result = { text: node?.textContent || '', hidden: node?.classList.contains('hidden'),
      title: node?.title || '' };
    closeOfflinePlayer();
    return result;
  });
  assert.ok(source.text.includes('Seitokai ni mo Ana wa Aru!'), `要显示原视频名，实际：${source.text}`);
  assert.equal(source.hidden, false);
  assert.equal(source.title, source.text, '悬停要能看到完整原名');

  // T1 设置搜索（VS Code 式）：搜「评分」页内平铺命中行、计数、高亮；清空后行回到原分组
  await page.evaluate(() => document.querySelector('#settingsButton').click());
  await page.waitForTimeout(500);
  const search = await page.evaluate(() => {
    const baselineRows = [...document.querySelectorAll('.settings-group')].map((g) => g.querySelectorAll('.setting-row').length);
    const input = document.querySelector('#settingsSearch');
    input.value = '评分';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const panel = document.querySelector('#settingsSearchResults');
    const modal = document.querySelector('#settingsModal');
    const during = {
      searching: modal.classList.contains('settings-searching'),
      panelShown: !panel.hidden,
      sections: [...panel.querySelectorAll('.settings-search-section-title')].map((n) => n.textContent),
      rowTotal: [...panel.querySelectorAll('.setting-row')].length,
      markCount: [...panel.querySelectorAll('.settings-hit-mark')].length,
      markBold: (() => { const m = panel.querySelector('.settings-hit-mark'); return m ? getComputedStyle(m).fontWeight : ''; })(),
      countText: document.querySelector('#settingsSearchCount').textContent,
      clearButtonVisible: !document.querySelector('#settingsSearchClear').classList.contains('hidden'),
    };
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const restored = [...document.querySelectorAll('.settings-group')].map((g) => g.querySelectorAll('.setting-row').length);
    return {
      ...during,
      restoredMatchesBaseline: JSON.stringify(restored) === JSON.stringify(baselineRows),
      panelHiddenAfterClear: panel.hidden,
      stillSearchingAfterClear: modal.classList.contains('settings-searching'),
      clearButtonHiddenAfterClear: document.querySelector('#settingsSearchClear').classList.contains('hidden'),
    };
  });
  assert.equal(search.searching, true, '搜索时要进入搜索态');
  assert.equal(search.panelShown, true, '结果面板要显示');

  assert.ok(search.rowTotal > 0, `搜「评分」要有结果，计数：${search.countText}`);
  assert.ok(search.markCount > 0, '命中文字要有 mark 高亮');
  assert.equal(search.markBold, '700', '命中文字要加粗');
  assert.ok(search.sections.length >= 1 && search.sections.every((t) => t.includes('·')), `分组标题：${search.sections.join(' / ')}`);
  assert.equal(search.restoredMatchesBaseline, true, '清空后所有行要回到原分组原位置');
  assert.equal(search.panelHiddenAfterClear, true, '清空后结果面板要收起');
  assert.equal(search.stillSearchingAfterClear, false, '清空后要退出搜索态');
  assert.equal(search.clearButtonVisible, true, '有输入时清除按钮要出现');
  assert.equal(search.clearButtonHiddenAfterClear, true, '清空后清除按钮要隐藏');

  // T2 自动追新番开关在主设置里可开可关，且与离线面板同步
  const autoFollow = await page.evaluate(async () => {
    const input = document.querySelector('#autoFollowSetting');
    const initial = input.checked;
    input.checked = true;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 500));
    const afterOn = (await fetch('/api/offline/settings').then((r) => r.json())).config.auto_follow;
    input.checked = false;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 500));
    const afterOff = (await fetch('/api/offline/settings').then((r) => r.json())).config.auto_follow;
    return { initial, afterOn, afterOff };
  });
  assert.equal(autoFollow.afterOn, true, '勾上要立即写进离线配置');
  assert.equal(autoFollow.afterOff, false, '取消要写回关闭');

  // T9 加入收藏自动打开找资源：只验证触发逻辑，不改库
  // 取数放在测试进程侧：页内 fetch 在跑批时偶发 Failed to fetch（与后端无关），
  // 触发逻辑本身是纯前端，不该被网络抖动连坐。
  // 跑批时偶发 Failed to fetch（后端 ThreadingHTTPServer 高负载下拒连）；退避重试。
  let bootstrap = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try { bootstrap = await (await fetch('http://127.0.0.1:43127/api/bootstrap')).json(); break; }
    catch (error) { if (attempt === 3) throw error; await new Promise((r) => setTimeout(r, 700)); }
  }
  const animeId = (bootstrap.animes || []).find((item) => item.collection_type !== 2)?.id;
  assert.ok(animeId, '要能找到一部不在「想看」的番');
  const autoOpen = await page.evaluate(({ animeId }) => {
    state.settings.auto_open_offline_enabled = true;
    state.settings.auto_open_offline_collections = ['2']; // 只允许「想看」
    maybeAutoOpenOffline(animeId, 1); // 在看：不在允许列表，不应打开
    const blocked = !document.querySelector('#offlineModal').open;
    maybeAutoOpenOffline(animeId, 2); // 想看：应打开并填好番名
    const opened = document.querySelector('#offlineModal').open;
    const query = document.querySelector('#offlineQuery').value;
    const target = document.querySelector('#offlineTarget').textContent;
    document.querySelector('#offlineModal').close();
    state.settings.auto_open_offline_enabled = false;
    return { blocked, opened, query, target };
  }, { animeId });
  assert.equal(autoOpen.blocked, true, '不在允许列表的收藏夹不能触发');
  assert.equal(autoOpen.opened, true, '允许的收藏夹要自动打开离线面板');
  assert.ok(autoOpen.query.length > 0, `要预填番名，实际：${autoOpen.query}`);
  assert.equal(autoOpen.target, autoOpen.query);

  await page.evaluate(() => document.querySelector('#settingsModal').close());
  console.log('verify_settings_batch: OK', JSON.stringify({ searchHits: search.hitCount }));
  await browser.close();
})().catch((error) => { console.error(error); process.exit(1); });
