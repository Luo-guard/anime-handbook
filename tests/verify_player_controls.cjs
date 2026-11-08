// Kazumi 式自绘播放器控制栏回归：真实页面 + 真实视频文件
const assert = require('node:assert/strict');
const { chromium } = require('C:/Users/han/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

(async () => {
  const bootstrap = await (await fetch('http://127.0.0.1:43127/api/offline/state?anime_id=554779')).json();
  const files = (bootstrap.files || []).filter((f) => f.exists !== false);
  assert.ok(files.length >= 1, '测试要有至少一集本地文件');
  const first = files[0];

  const browser = await chromium.launch({ headless: true, ignoreDefaultArgs: ['--hide-scrollbars'] });
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  const downloads = [];
  page.on('download', (item) => downloads.push(item));
  await page.goto('http://127.0.0.1:43127/', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(1400);

  // 打开播放器（真实流）
  await page.evaluate(({ animeId, fileId, stateFiles }) => {
    offlineView.animeId = animeId;
    offlineView.animeName = '学生会也有洞！';
    offlineView.local = { files: stateFiles, jobs: bootstrap.jobs || [] };
    playLocalFile(fileId);
  }, { animeId: 554779, fileId: first.id, stateFiles: bootstrap.files || [] });
  await page.waitForFunction(() => {
    const v = document.querySelector('#offlineVideo');
    return v && Number.isFinite(v.duration) && v.duration > 0;
  }, { timeout: 15000 });

  // 1) 原生 controls 已移除，自绘栏齐全
  const base = await page.evaluate(() => ({
    nativeControls: document.querySelector('#offlineVideo').controls,
    buttons: ['pcPlay', 'pcPrev', 'pcNext', 'pcTime', 'pcMute', 'pcVolume', 'pcSpeed',
      'pcPip', 'pcPlaylist', 'pcFullscreen', 'pcScreenshot', 'dmSendInput', 'dmSendButton',
      'offlineDanmakuToggle', 'offlineDanmakuSettings', 'offlineSubtitleToggle'].every(
      (id) => Boolean(document.getElementById(id))),
    stageTitle: document.querySelector('#pcStageTitle').textContent,
    shortcutsHint: Boolean(document.querySelector('.pc-shortcuts')),
  }));
  assert.equal(base.nativeControls, false, '原生 controls 要移除');
  assert.equal(base.buttons, true, '控制栏控件要齐全');
  assert.ok(base.stageTitle.includes('学生会也有洞！'), `舞台标题：${base.stageTitle}`);
  assert.equal(base.shortcutsHint, true, '快捷键说明要有');

  // 2) 播放按钮 / 空格
  await page.evaluate(() => { document.querySelector('#offlineVideo').muted = true; });
  const wasPlaying = await page.evaluate(() => !document.querySelector('#offlineVideo').paused);
  await page.click('#pcPlay'); // 若已在播则暂停
  await page.waitForTimeout(400);
  const afterClick = await page.evaluate(() => !document.querySelector('#offlineVideo').paused);
  assert.equal(afterClick, !wasPlaying, '点播放按钮要切换播放/暂停');
  if (!afterClick) {
    await page.click('#pcPlay');
    await page.waitForTimeout(400);
  }
  const playing = await page.evaluate(() => !document.querySelector('#offlineVideo').paused);
  assert.equal(playing, true, '再点一次要恢复播放');
  await page.keyboard.press('Space');
  await page.waitForTimeout(200);
  assert.equal(await page.evaluate(() => document.querySelector('#offlineVideo').paused), true, '空格要暂停');
  const playIconState = await page.evaluate(() => document.querySelector('#pcPlay').dataset.state);
  assert.equal(playIconState, 'paused', '按钮状态要跟手');

  // 3) 方向键快进快退
  const before = await page.evaluate(() => document.querySelector('#offlineVideo').currentTime);
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(150);
  const after = await page.evaluate(() => document.querySelector('#offlineVideo').currentTime);
  assert.ok(after - before > 3.5 && after - before < 7, `→ 要快进 5 秒，实际 ${after - before}`);
  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(150);
  const back = await page.evaluate(() => document.querySelector('#offlineVideo').currentTime);
  assert.ok(Math.abs(back - before) < 2, `← 要快退回来，实际偏 ${back - before}`);

  // 4) 时间显示与进度条同步
  await page.evaluate(() => {
    const v = document.querySelector('#offlineVideo');
    v.currentTime = Math.min(v.duration * 0.4, v.duration - 1);
  });
  await page.waitForTimeout(300);
  const timeText = await page.evaluate(() => ({
    text: document.querySelector('#pcTime').textContent,
    playedWidth: document.querySelector('#pcPlayed').style.width,
  }));
  assert.ok(/^\d{2}:\d{2} \/ \d{2}:\d{2}$/.test(timeText.text), `时间格式：${timeText.text}`);
  assert.ok(parseFloat(timeText.playedWidth) > 5, `进度条要动：${timeText.playedWidth}`);

  // 5) 倍速菜单 + 记忆
  await page.click('#pcSpeed');
  assert.equal(await page.evaluate(() => !document.querySelector('#pcSpeedMenu').classList.contains('hidden')), true, '倍速菜单要弹出');
  await page.click('#pcSpeedMenu [data-rate="1.5"]');
  await page.waitForTimeout(150);
  const speed = await page.evaluate(() => ({
    rate: document.querySelector('#offlineVideo').playbackRate,
    label: document.querySelector('#pcSpeed').textContent,
    saved: JSON.parse(localStorage.getItem('handbook.player.prefs') || '{}').speed,
    menuClosed: document.querySelector('#pcSpeedMenu').classList.contains('hidden'),
  }));
  assert.equal(speed.rate, 1.5);
  assert.equal(speed.label, '1.5x');
  assert.equal(speed.saved, 1.5, '倍速要记进 localStorage');
  assert.equal(speed.menuClosed, true);

  // 6) 音量：↓ 减、M 静音
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(150);
  const vol = await page.evaluate(() => ({
    v: document.querySelector('#offlineVideo').volume,
    saved: JSON.parse(localStorage.getItem('handbook.player.prefs') || '{}').volume,
  }));
  assert.ok(vol.v <= 0.91, `音量要减，实际 ${vol.v}`);
  assert.ok(vol.saved <= 0.91, '音量要记忆');
  await page.keyboard.press('KeyM');
  await page.waitForTimeout(120);
  assert.equal(await page.evaluate(() => document.querySelector('#offlineVideo').muted), true, 'M 要静音');
  assert.equal(await page.evaluate(() => document.querySelector('#pcMute').dataset.state), 'muted');

  // 7) 发送弹幕：进画面 + 持久化 + 重载合并
  await page.fill('#dmSendInput', '测试弹幕你好');
  await page.click('#dmSendButton');
  await page.waitForTimeout(200);
  const sent = await page.evaluate(({ fileId }) => ({
    last: danmakuView.items[danmakuView.items.length - 1],
    stored: (JSON.parse(localStorage.getItem('handbook.danmaku.mine') || '{}')[String(fileId)] || []).slice(-1)[0],
    inputCleared: document.querySelector('#dmSendInput').value === '',
  }), { fileId: first.id });
  assert.equal(sent.last.text, '测试弹幕你好', `弹幕要进画面，实际：${sent.last && sent.last.text}`);
  assert.equal(sent.stored && sent.stored.text, '测试弹幕你好', '发送要持久化');
  assert.equal(sent.inputCleared, true);
  await page.evaluate(() => dmSetItems([], 'reload-test', '重载'));
  const merged = await page.evaluate(() => danmakuView.items.some((item) => item.text === '测试弹幕你好'));
  assert.equal(merged, true, '重载弹幕列表后自己发的要还在');

  // 8) 上一集/下一集 + 播放列表
  const eps = await page.evaluate(() => {
    const sorted = pcSortedFiles();
    return {
      sortedKeys: sorted.map((f) => f.episode_key),
      playingKey: offlineView.playing.episode_key,
      prevDisabled: document.querySelector('#pcPrev').disabled,
      nextDisabled: document.querySelector('#pcNext').disabled,
    };
  });
  assert.equal(eps.prevDisabled, eps.playingKey === eps.sortedKeys[0], '上一集禁用当且仅当在播最早一集');
  assert.equal(eps.nextDisabled, eps.playingKey === eps.sortedKeys[eps.sortedKeys.length - 1], '下一集禁用当且仅当在播最晚一集');
  if (files.length >= 2) {
    await page.click('#pcNext');
    await page.waitForTimeout(700);
    const switched = await page.evaluate(() => document.querySelector('#offlinePlayerTitle').textContent);
    assert.ok(switched !== '', '下一集要切过去');
    assert.equal(await page.evaluate(() => document.querySelector('#pcPrev').disabled), false, '切到后面一集后上一集要可用');
    await page.click('#pcPlaylist');
    const list = await page.evaluate(() => ({
      count: document.querySelectorAll('#pcPlaylistMenu [data-id]').length,
      active: Boolean(document.querySelector('#pcPlaylistMenu button.active')),
    }));
    assert.equal(list.count, files.length, '播放列表要列出全部集');
    assert.equal(list.active, true, '当前集要有标记');
  }

  // 9) 截图
  await page.waitForFunction(() => {
    const v = document.querySelector('#offlineVideo');
    return v && Number.isFinite(v.duration) && v.duration > 0 && v.readyState >= 2;
  }, { timeout: 20000 });
  await page.evaluate(() => {
    const v = document.querySelector('#offlineVideo');
    v.muted = true;
    v.currentTime = Math.min(3, Math.max(0.5, v.duration * 0.1));
  });
  await page.waitForTimeout(900);
  await page.click('#pcScreenshot');
  await page.waitForTimeout(1200);
  assert.ok(downloads.length >= 1, '截图要产生下载');
  assert.ok(downloads[0].suggestedFilename().endsWith('.png'), `文件名：${downloads[0].suggestedFilename()}`);
  assert.ok(downloads[0].suggestedFilename().includes('学生会'), `文件名要带番名：${downloads[0].suggestedFilename()}`);

  // 10) 全屏（F）
  await page.keyboard.press('KeyF');
  await page.waitForTimeout(500);
  assert.equal(await page.evaluate(() => document.querySelector('#offlinePlayerVideoWrap').matches(':fullscreen')), true, 'F 要进全屏');
  await page.keyboard.press('KeyF');
  await page.waitForTimeout(500);
  assert.equal(await page.evaluate(() => Boolean(document.fullscreenElement)), false, '再按 F 要退出全屏');

  // 11) 自动隐藏：播放中鼠标不动 → idle；动一下恢复
  await page.evaluate(() => document.querySelector('#offlineVideo').play().catch(() => {}));
  await page.mouse.move(550, 400);
  await page.waitForTimeout(3000);
  assert.equal(await page.evaluate(() => document.querySelector('#offlinePlayerVideoWrap').classList.contains('player-idle')), true, '播放中不动要藏控制栏');
  await page.mouse.move(560, 410);
  assert.equal(await page.evaluate(() => document.querySelector('#offlinePlayerVideoWrap').classList.contains('player-idle')), false, '动鼠标要恢复');

  // 12) Esc 关播放器（原有行为不回归）
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  assert.equal(await page.evaluate(() => document.querySelector('#offlinePlayer').open), false, 'Esc 要关播放器');

  console.log('verify_player_controls: OK');
  await browser.close();
})().catch((error) => { console.error(error); process.exit(1); });
