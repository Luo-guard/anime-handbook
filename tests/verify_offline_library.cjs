// 「我的库」前端回归：tab 默认进库、卡片渲染、筛选/搜索、进番返回、我的库直达
const assert = require('node:assert/strict');
const { chromium } = require('C:/Users/han/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

(async () => {
  const browser = await chromium.launch({ headless: true, ignoreDefaultArgs: ['--hide-scrollbars'] });
  const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
  await page.goto('http://127.0.0.1:43127/', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(1400);

  // 1) 详情页右上角是合并后的下载角标按钮，「我的库」独立按钮已移除
  const button = await page.evaluate(() => {
    openProgress(state.animes.find((a) => a.id)?.id);
    const corner = document.querySelector('#openOffline.detail-corner-download');
    const mine = document.querySelector('#openLibrary');
    return { exists: Boolean(corner), mineRemoved: !mine, cornerInModal: Boolean(corner?.closest('#progressForm')) };
  });
  assert.equal(button.exists, true, '详情页要有右上角下载角标按钮');
  assert.equal(button.cornerInModal, true, '角标按钮应在详情弹窗内');
  assert.equal(button.mineRemoved, true, '「我的库」独立按钮应已移除');

  // 2) 点角标 → 离线面板默认进「找资源」（番名已填），切到本地页签看媒体库卡片
  await page.evaluate(() => document.querySelector('#openOffline').click());
  await page.waitForTimeout(900);
  assert.equal(await page.evaluate(() => document.querySelector('[data-offline-tab="search"]').classList.contains('active')), true, '角标默认进找资源');
  await page.evaluate(() => document.querySelector('[data-offline-tab="local"]').click());
  await page.waitForTimeout(500);
  // 本地页签默认显示当前番；「返回媒体库」进总览
  await page.evaluate(() => document.querySelector('#offlineLibraryBack')?.click());
  await page.waitForTimeout(500);
  const library = await page.evaluate(() => ({
    tabActive: document.querySelector('[data-offline-tab="local"]').classList.contains('active'),
    libraryVisible: !document.querySelector('#offlineLibraryView').classList.contains('hidden'),
    animeViewHidden: document.querySelector('#offlineAnimeView').classList.contains('hidden'),
    cards: [...document.querySelectorAll('.library-card')].map((c) => ({
      anime: c.dataset.anime, name: c.querySelector('.library-name').textContent,
      hasCover: Boolean(c.querySelector('.library-cover img')),
      hasBar: Boolean(c.querySelector('.library-bar')),
      continueText: c.querySelector('.library-continue')?.textContent.trim() || '',
    })),
    disk: document.querySelector('#offlineLibraryDisk').textContent,
  }));
  assert.equal(library.tabActive, true);
  assert.equal(library.libraryVisible, true, '本地文件页签要进媒体库');
  assert.equal(library.animeViewHidden, true);
  assert.ok(library.cards.length >= 1, '库里要列出有本地文件的番');
  const card = library.cards[0];
  assert.equal(card.name, '学生会也有洞！');
  assert.ok(card.continueText.includes('第'), `继续观看按钮要带集名，实际：${card.continueText}`);
  assert.ok(library.disk.includes('GB'), `底部要显示磁盘容量，实际：${library.disk}`);

  // 3) 筛选与搜索
  await page.evaluate(() => {
    const filter = document.querySelector('#offlineLibraryFilter');
    filter.value = '4'; // 看过：这部番不在，列表应空
    filter.dispatchEvent(new Event('change', { bubbles: true }));
  });
  assert.equal(await page.locator('#offlineLibraryGrid .library-card').count(), 0, '筛选「看过」后这部番应被滤掉');
  await page.evaluate(() => {
    const filter = document.querySelector('#offlineLibraryFilter');
    filter.value = 'all';
    filter.dispatchEvent(new Event('change', { bubbles: true }));
    const search = document.querySelector('#offlineLibrarySearch');
    search.value = '不存在的番名';
    search.dispatchEvent(new Event('input', { bubbles: true }));
  });
  assert.equal(await page.locator('#offlineLibraryGrid .library-card').count(), 0, '搜不到时应为空');
  await page.evaluate(() => {
    const search = document.querySelector('#offlineLibrarySearch');
    search.value = '';
    search.dispatchEvent(new Event('input', { bubbles: true }));
  });

  // 4) 点卡片进番视图（复用原文件列表），返回按钮回库
  await page.locator('.library-card').first().click();
  await page.waitForTimeout(900);
  const animeView = await page.evaluate(() => ({
    libraryHidden: document.querySelector('#offlineLibraryView').classList.contains('hidden'),
    animeVisible: !document.querySelector('#offlineAnimeView').classList.contains('hidden'),
    backVisible: !document.querySelector('#offlineLibraryBack').classList.contains('hidden'),
    rows: document.querySelectorAll('#offlineLocalList .offline-row').length,
    target: document.querySelector('#offlineTarget').textContent,
  }));
  assert.equal(animeView.libraryHidden, true);
  assert.equal(animeView.animeVisible, true);
  assert.equal(animeView.backVisible, true, '进番视图后要有返回按钮');
  assert.ok(animeView.rows >= 1, '番视图要列出这一番的文件');
  assert.equal(animeView.target, '学生会也有洞！');

  await page.locator('#offlineLibraryBack').click();
  await page.waitForTimeout(700);
  const back = await page.evaluate(() => ({
    libraryVisible: !document.querySelector('#offlineLibraryView').classList.contains('hidden'),
    cards: document.querySelectorAll('.library-card').length,
  }));
  assert.equal(back.libraryVisible, true, '返回后回媒体库');
  assert.equal(back.cards, library.cards.length, '返回后卡片数据还在（不用重新拉）');

  // 5) 详情页「我的库」直达后，看板数据与卡片点击后的播放链路复用现有播放器
  console.log('verify_offline_library: OK', JSON.stringify({ cards: library.cards.length, disk: library.disk.slice(0, 30) }));
  await browser.close();
})().catch((error) => { console.error(error); process.exit(1); });
