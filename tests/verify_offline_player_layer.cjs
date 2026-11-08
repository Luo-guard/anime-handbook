// 播放器不能进 top layer：浏览器扩展（NijiLucid 等）注入的超分按钮挂在 body 上，
// 模态 dialog 会连 backdrop 一起把它挡死。这里模拟那个按钮验证层级与恢复流程。
const assert = require('node:assert/strict');
const { chromium } = require('C:/Users/han/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

(async () => {
  const browser = await chromium.launch({ headless: true, ignoreDefaultArgs: ['--hide-scrollbars'] });
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  await page.goto('http://127.0.0.1:43127/', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(1400);

  // 1) 先打开详情页（真实链路：从扇区菜单点播放时它就是上层模态弹窗），
  //    再注入一个模拟扩展按钮，位置刻意落在播放器弹窗矩形内部。
  const before = await page.evaluate(() => {
    const detail = document.querySelector('#progressModal');
    if (!detail.open) detail.showModal();
    const btn = document.createElement('button');
    btn.id = 'fakeSuperresBtn';
    btn.textContent = '超分 开';
    Object.assign(btn.style, {
      position: 'fixed', top: '140px', right: '140px', zIndex: '2147483647',
      width: '96px', height: '34px', background: '#e33', color: '#fff',
    });
    document.body.append(btn);
    const r = btn.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { detailOpen: detail.open, hit: hit && (hit.id || hit.tagName) };
  });
  assert.equal(before.detailOpen, true);
  assert.notEqual(before.hit, 'fakeSuperresBtn',
    '基线：详情页的模态弹窗本来就会挡住扩展按钮（这正是要修的 top layer 问题）');

  // 2) 走真实的 openOfflinePlayerDialog()：上层弹窗收起、播放器非模态、背板出现
  const opened = await page.evaluate(() => {
    openOfflinePlayerDialog();
    const player = document.querySelector('#offlinePlayer');
    const btn = document.querySelector('#fakeSuperresBtn');
    // 把按钮挪进播放器矩形内部：只有真的浮在播放器之上才算修好，
    // 落在弹窗外的话即使没修也可能命中按钮（假阳性）。
    const pbox = player.getBoundingClientRect();
    btn.style.top = `${Math.round(pbox.top + 24)}px`;
    btn.style.left = `${Math.round(pbox.left + 24)}px`;
    btn.style.right = 'auto';
    const r = btn.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    const box = player.getBoundingClientRect();
    return {
      playerOpen: player.open,
      detailOpen: document.querySelector('#progressModal').open,
      backdropVisible: !document.querySelector('#offlinePlayerBackdrop').hidden,
      hit: hit && (hit.id || hit.tagName),
      box: [Math.round(box.left), Math.round(box.top), Math.round(box.right), Math.round(box.bottom)],
      returnIds: [...offlineView.returnDialogs],
    };
  });
  assert.equal(opened.playerOpen, true, '播放器要打开');
  assert.equal(opened.detailOpen, false, '上层模态弹窗要收起，否则它仍占 top layer');
  assert.equal(opened.backdropVisible, true, '自建背板要替代 ::backdrop');
  assert.equal(opened.hit, 'fakeSuperresBtn', '扩展注入的超分按钮必须能显示且可点击');
  assert.ok(opened.box[0] >= 0 && opened.box[2] <= 1100 && opened.box[1] >= 0 && opened.box[3] <= 900,
    `播放器要在视口内，实际 ${opened.box}`);
  assert.ok(opened.returnIds.includes('progressModal'), '要记住待恢复的弹窗');

  // 3) 关掉播放器：背板收起、详情页原样恢复
  const closed = await page.evaluate(() => {
    closeOfflinePlayer();
    return {
      playerOpen: document.querySelector('#offlinePlayer').open,
      backdropHidden: document.querySelector('#offlinePlayerBackdrop').hidden,
      detailOpen: document.querySelector('#progressModal').open,
      returnIds: [...offlineView.returnDialogs],
    };
  });
  assert.equal(closed.playerOpen, false);
  assert.equal(closed.backdropHidden, true);
  assert.equal(closed.detailOpen, true, '关掉播放器要回到原来的详情页');
  assert.equal(closed.returnIds.length, 0);

  // 4) Esc 也要能关（非模态 dialog 不会自动处理），并且同样恢复上层弹窗
  const escaped = await page.evaluate(() => {
    openOfflinePlayerDialog();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    return {
      playerOpen: document.querySelector('#offlinePlayer').open,
      detailOpen: document.querySelector('#progressModal').open,
      backdropHidden: document.querySelector('#offlinePlayerBackdrop').hidden,
    };
  });
  assert.equal(escaped.playerOpen, false, 'Esc 要能关闭非模态播放器');
  assert.equal(escaped.detailOpen, true, 'Esc 关闭后也要恢复上层弹窗');
  assert.equal(escaped.backdropHidden, true);

  // 5) 点背板关闭
  const backdropClick = await page.evaluate(() => {
    openOfflinePlayerDialog();
    document.querySelector('#offlinePlayerBackdrop').click();
    return {
      playerOpen: document.querySelector('#offlinePlayer').open,
      detailOpen: document.querySelector('#progressModal').open,
    };
  });
  assert.equal(backdropClick.playerOpen, false);
  assert.equal(backdropClick.detailOpen, true);

  await page.evaluate(() => {
    document.querySelector('#fakeSuperresBtn')?.remove();
    document.querySelector('#progressModal').close();
  });
  console.log('verify_offline_player_layer: OK', JSON.stringify(opened.box));
  await browser.close();
})().catch((error) => { console.error(error); process.exit(1); });
