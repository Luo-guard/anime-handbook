// 动漫库侧边栏回归：导航显隐 / 媒体库 / 来源分组 / 删除确认 / 订阅管理 / 找资源 / 设置迁移
const assert = require('node:assert/strict');
const { chromium } = require('C:/Users/han/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

(async () => {
  const browser = await chromium.launch({ headless: true, ignoreDefaultArgs: ['--hide-scrollbars'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  await page.goto('http://127.0.0.1:43127/', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(1500);

  // 1) 导航按钮存在且默认显示（library_sidebar 默认 show）
  assert.equal(await page.locator('#libraryNavButton').count(), 1, '导航要有动漫库按钮');
  assert.equal(await page.evaluate(() => document.querySelector('#libraryNavButton').classList.contains('hidden')), false, '默认要显示');

  // 2) 点导航进库视图：媒体库网格 + 磁盘统计
  await page.click('#libraryNavButton');
  await page.waitForTimeout(900);
  const media = await page.evaluate(() => ({
    viewActive: document.querySelector('#libraryView').classList.contains('active'),
    cards: [...document.querySelectorAll('#libGrid .library-card')].map((c) => c.dataset.name),
    disk: document.querySelector('#libDisk').textContent,
    tabs: [...document.querySelectorAll('.library-tab')].map((t) => t.dataset.libraryTab),
  }));
  assert.equal(media.viewActive, true, '动漫库视图要激活');
  assert.ok(media.cards.includes('学生会也有洞！'), `网格要列出真实番：${media.cards}`);
  assert.ok(media.disk.includes('GB'), `磁盘统计：${media.disk}`);
  assert.deepEqual(media.tabs, ['media', 'subs', 'search']);

  // 3) 卡片进详情：单来源不显示来源筛选，行里带字幕组
  await page.locator('#libGrid .library-card').first().click();
  await page.waitForTimeout(900);
  const detail = await page.evaluate(() => ({
    title: document.querySelector('#libDetailTitle').textContent,
    rows: [...document.querySelectorAll('#libEpisodes .lib-episode')].map((r) => ({
      label: r.querySelector('b').textContent,
      text: r.querySelector('small').textContent,
    })),
    chipsHidden: document.querySelector('#libSourceChips').classList.contains('hidden'),
    backVisible: !document.querySelector('#libDetailBack').classList.contains('hidden'),
  }));
  assert.equal(detail.title, '学生会也有洞！');
  assert.ok(detail.rows.length >= 2, `要列出集数行：${detail.rows.length}`);
  assert.ok(detail.rows.every((r) => r.text.includes('云光字幕组')), `行里要带字幕组：${JSON.stringify(detail.rows)}`);
  assert.equal(detail.chipsHidden, true, '单一来源要隐藏来源筛选');
  assert.equal(detail.backVisible, true);

  // 4) 删除有确认提示；取消后文件还在
  let confirmMessage = '';
  page.on('dialog', async (dialog) => {
    confirmMessage = dialog.message();
    await dialog.dismiss();
  });
  await page.locator('#libEpisodes .lib-delete').first().click();
  await page.waitForTimeout(600);
  assert.ok(confirmMessage.includes('删除') || confirmMessage.includes('_trash'), `删除要有确认提示：${confirmMessage}`);
  const stillThere = await page.evaluate(() => document.querySelectorAll('#libEpisodes .lib-episode').length);
  assert.ok(stillThere >= 2, '取消确认后文件不能被删');

  // 5) 播放按钮 → 播放器打开
  await page.locator('#libEpisodes .lib-play').first().click();
  await page.waitForTimeout(900);
  assert.equal(await page.evaluate(() => document.querySelector('#offlinePlayer').open), true, '播放要打开播放器');
  const playerTitle = await page.evaluate(() => document.querySelector('#offlinePlayerTitle').textContent);
  assert.ok(playerTitle.includes('学生会也有洞！'), `播放器标题：${playerTitle}`);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  // 6) 返回媒体库 → 订阅管理
  await page.click('#libDetailBack');
  await page.waitForTimeout(300);
  await page.click('[data-library-tab="subs"]');
  await page.waitForTimeout(700);
  const subs = await page.evaluate(() => ({
    items: [...document.querySelectorAll('#libSubList .lib-sub-item')].map((r) => ({
      name: r.querySelector('b').textContent,
      toggle: Boolean(r.querySelector('.lib-sub-toggle')),
    })),
    autoFollowSynced: document.querySelector('#libAutoFollow') !== null,
  }));
  assert.ok(subs.items.length >= 1, '要列出已有订阅');
  assert.ok(subs.items.every((i) => i.name && !i.name.startsWith('番剧')), `订阅要带番名：${subs.items.map((i) => i.name)}`);
  assert.ok(subs.items.every((i) => i.toggle), '每条订阅要有开关');

  // 7) 找资源：mock 搜索接口；关键词命中收藏番 → 按钮可用，未命中 → 禁用
  await page.route('**/api/offline/search**', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ ok: true, items: [
      { title: '[云光字幕组][学生会也有洞！][01][1080p]', torrent_url: 'magnet:?xt=1', group: '云光字幕组', resolution: '1080P', codec: 'HEVC', publish_date: '2026-10-05' },
    ] }),
  }));
  await page.click('[data-library-tab="search"]');
  await page.waitForTimeout(200);
  await page.fill('#libSearchQuery', '学生会也有洞');
  await page.click('#libSearchGo');
  await page.waitForTimeout(600);
  const hit = await page.evaluate(() => ({
    status: document.querySelector('#libSearchStatus').textContent,
    disabled: Boolean(document.querySelector('#libSearchResults .lib-download:disabled')),
    rows: document.querySelectorAll('#libSearchResults .lib-search-item').length,
  }));
  assert.equal(hit.rows, 1, 'mock 搜索要有结果');
  assert.ok(hit.status.includes('关联'), `状态要提示关联番：${hit.status}`);
  assert.equal(hit.disabled, false, '命中收藏番时下载按钮要可用');
  await page.fill('#libSearchQuery', '完全不存在的番名xyz');
  await page.click('#libSearchGo');
  await page.waitForTimeout(600);
  assert.equal(await page.evaluate(() => Boolean(document.querySelector('#libSearchResults .lib-download:disabled'))), true, '未命中收藏番时下载要禁用');

  // 8) 设置：离线下载页签迁入 + 侧边栏开关即时生效
  await page.click('#settingsButton');
  await page.waitForTimeout(500);
  await page.evaluate(() => switchSettingsTab('offline'));
  // loadOfflineSettings 是异步填表，跑批时偶发慢半拍，等它到位再断言。
  await page.waitForFunction(() => document.getElementById('offlineQbHost')?.value.length > 0, null, { timeout: 8000 }).catch(() => {});
  const settingsTab = await page.evaluate(() => ({
    fields: ['offlineMediaRoot', 'offlineQbHost', 'offlineAutoFollow', 'librarySidebarMode',
      'offlineSaveSettings', 'offlineCheckSubs'].every((id) => Boolean(document.getElementById(id))),
    qbHost: document.getElementById('offlineQbHost').value,
    sidebarMode: document.getElementById('librarySidebarMode').value,
  }));
  assert.equal(settingsTab.fields, true, '离线设置要全部迁进设置弹窗');
  assert.ok(settingsTab.qbHost.length > 0, `qB 地址要预填：${settingsTab.qbHost}`);
  assert.equal(settingsTab.sidebarMode, 'show');
  await page.evaluate(() => {
    const select = document.querySelector('#librarySidebarMode');
    select.value = 'hide';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(600);
  assert.equal(await page.evaluate(() => document.querySelector('#libraryNavButton').classList.contains('hidden')), true, '选隐藏后导航按钮要消失');
  assert.equal(await page.evaluate(() => document.querySelector('#settingsModal').querySelector('#libraryNavButton') === null), true);
  await page.evaluate(() => {
    const select = document.querySelector('#librarySidebarMode');
    select.value = 'show';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(500);
  assert.equal(await page.evaluate(() => document.querySelector('#libraryNavButton').classList.contains('hidden')), false, '改回显示要恢复');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // 9) 离线弹窗：本地文件默认当前番；我的库按钮强制总览
  await page.evaluate(() => {
    openProgress(state.animes.find((a) => a.id)?.id);
  });
  await page.waitForTimeout(300);
  await page.click('#openOffline');
  await page.waitForTimeout(300);
  await page.click('[data-offline-tab="local"]');
  await page.waitForTimeout(900);
  const localDefault = await page.evaluate(() => ({
    animeView: !document.querySelector('#offlineAnimeView').classList.contains('hidden'),
    backVisible: !document.querySelector('#offlineLibraryBack').classList.contains('hidden'),
    rows: document.querySelectorAll('#offlineLocalList .offline-row, #offlineLocalList > *').length,
    target: document.querySelector('#offlineTarget').textContent,
  }));
  assert.equal(localDefault.animeView, true, '本地文件默认要显示当前番');
  assert.ok(localDefault.rows >= 1, `要列出当前番文件：${localDefault.rows}`);
  assert.equal(await page.evaluate(() => document.querySelector('#offlineSettingsPanel') !== null), false, '设置页签要已移除');
  await page.keyboard.press('Escape'); // 关掉离线弹窗，露出详情弹窗再从角标重进
  await page.waitForTimeout(400);
  await page.click('#openOffline'); // 「我的库」按钮已并入右上角下载角标
  await page.waitForTimeout(800);
  await page.click('[data-offline-tab="local"]');
  await page.waitForTimeout(600);
  await page.click('#offlineLibraryBack'); // 进媒体库总览
  await page.waitForTimeout(600);
  assert.equal(await page.evaluate(() => !document.querySelector('#offlineLibraryView').classList.contains('hidden')), true, '返回后要显示媒体库总览');
  await page.keyboard.press('Escape');

  // 10) 设置里选「有本地内容时」→ 有内容仍显示
  await page.evaluate(() => document.querySelector('#progressModal')?.close());
  await page.waitForTimeout(200);
  await page.click('#settingsButton');
  await page.waitForTimeout(400);
  await page.evaluate(() => switchSettingsTab('offline'));
  await page.evaluate(() => {
    const select = document.querySelector('#librarySidebarMode');
    select.value = 'auto';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(800);
  assert.equal(await page.evaluate(() => document.querySelector('#libraryNavButton').classList.contains('hidden')), false, '有本地内容时 auto 要显示');
  // 还原默认值
  await page.evaluate(() => {
    const select = document.querySelector('#librarySidebarMode');
    select.value = 'show';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(400);

  console.log('verify_library_sidebar: OK');
  await browser.close();
})().catch((error) => { console.error(error); process.exit(1); });
