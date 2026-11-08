// 本轮批量改动回归：设置搜索 / 自动追番开关 / 原视频名 / 徽标空格 / 找资源预填 / 收藏自动弹离线
const assert = require('node:assert/strict');
const { chromium } = require('C:/Users/han/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

(async () => {
  const browser = await chromium.launch({ headless: true, ignoreDefaultArgs: ['--hide-scrollbars'] });
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  await page.goto('http://127.0.0.1:43127/', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(1400);

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

  // T1 设置搜索：搜「弹幕」有结果、点击跳分组、清空收起
  await page.evaluate(() => document.querySelector('#settingsButton').click());
  await page.waitForTimeout(500);
  const search = await page.evaluate(() => {
    const input = document.querySelector('#settingsSearch');
    input.value = '评分';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const panel = document.querySelector('#settingsSearchResults');
    const hits = [...panel.querySelectorAll('[data-search-key]')];
    const visible = !panel.classList.contains('hidden');
    const before = document.querySelector('.settings-group:not(.hidden)')?.dataset.settingsGroup;
    hits[0]?.click();
    const after = document.querySelector('.settings-group:not(.hidden)')?.dataset.settingsGroup;
    const hitRow = document.querySelector('.setting-row.settings-search-hit');
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return {
      count: document.querySelector('#settingsSearchCount').textContent,
      visible,
      hitCount: hits.length,
      tabSwitched: before !== after,
      hitRowShown: Boolean(hitRow),
      panelHiddenAfterClear: panel.classList.contains('hidden'),
    };
  });
  assert.ok(search.hitCount > 0, `搜「评分」要有结果，计数：${search.count}`);
  assert.equal(search.visible, true);
  assert.equal(search.tabSwitched, true, '点击结果要切到对应分组');
  assert.equal(search.hitRowShown, true, '目标行要闪高亮');
  assert.equal(search.panelHiddenAfterClear, true, '清空后结果面板要收起');

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
  const autoOpen = await page.evaluate(async () => {
    const data = await fetch('/api/bootstrap').then((r) => r.json());
    state.settings = data.settings || {};
    state.settings.auto_open_offline_enabled = true;
    state.settings.auto_open_offline_collections = ['2']; // 只允许「想看」
    const anime = state.animes.find((item) => item.collection_type !== 2);
    maybeAutoOpenOffline(anime.id, 1); // 在看：不在允许列表，不应打开
    const blocked = !document.querySelector('#offlineModal').open;
    maybeAutoOpenOffline(anime.id, 2); // 想看：应打开并填好番名
    const opened = document.querySelector('#offlineModal').open;
    const query = document.querySelector('#offlineQuery').value;
    const target = document.querySelector('#offlineTarget').textContent;
    document.querySelector('#offlineModal').close();
    state.settings.auto_open_offline_enabled = false;
    return { blocked, opened, query, target };
  });
  assert.equal(autoOpen.blocked, true, '不在允许列表的收藏夹不能触发');
  assert.equal(autoOpen.opened, true, '允许的收藏夹要自动打开离线面板');
  assert.ok(autoOpen.query.length > 0, `要预填番名，实际：${autoOpen.query}`);
  assert.equal(autoOpen.target, autoOpen.query);

  await page.evaluate(() => document.querySelector('#settingsModal').close());
  console.log('verify_settings_batch: OK', JSON.stringify({ searchHits: search.hitCount }));
  await browser.close();
})().catch((error) => { console.error(error); process.exit(1); });
