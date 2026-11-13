// 播放器弹幕层回归：DOM、解析、canvas 渲染、设置面板、开关与后端接口。
const assert = require('node:assert/strict');
const { chromium } = require('C:/Users/han/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

const BILI_XML = `<i>
<d p="1.0,1,25,16777215,0,0,a,1">开头的弹幕</d>
<d p="1.5,1,25,16711680,0,0,a,2">红色的弹幕</d>
<d p="2.0,5,25,65280,0,0,a,3">顶部固定弹幕</d>
<d p="2.2,4,25,255,0,0,a,4">底部固定弹幕</d>
<d p="3.0,1,25,16777215,0,0,a,5">这条含屏蔽词 剧透</d>
</i>`;

(async () => {
  const browser = await chromium.launch({ headless: true, ignoreDefaultArgs: ['--hide-scrollbars'] });
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  await page.goto('http://127.0.0.1:43127/', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(1400);

  // 1) 播放器里该有的东西一件不少
  const dom = await page.evaluate(() => ({
    canvas: Boolean(document.querySelector('#danmakuCanvas')),
    toggle: Boolean(document.querySelector('#offlineDanmakuToggle')),
    settings: Boolean(document.querySelector('#offlineDanmakuSettings')),
    panel: Boolean(document.querySelector('#danmakuPanel')),
    controls: ['dmEnabled', 'dmFontSize', 'dmDuration', 'dmOpacity', 'dmArea', 'dmDensity',
      'dmBold', 'dmTopBottom', 'dmShield', 'dmImport', 'dmOnlineSearch', 'dmBase', 'dmAppId',
      'dmSourceMode', 'dmAppSecret'].every(
      (id) => Boolean(document.getElementById(id))),
    canvasPointer: getComputedStyle(document.querySelector('#danmakuCanvas')).pointerEvents,
    videoTag: document.querySelector('#offlineVideo').tagName,
  }));
  assert.ok(dom.canvas && dom.toggle && dom.settings && dom.panel && dom.controls, '弹幕 DOM 齐全');
  assert.equal(dom.canvasPointer, 'none', 'canvas 不能挡住原生播放控件');
  assert.equal(dom.videoTag, 'VIDEO', '仍然是原生 video，超分扩展不受影响');

  // 2) 解析：B 站 XML 与弹弹play JSON 都要归一
  const parsed = await page.evaluate((xml) => ({
    xml: dmParseText(xml),
    json: dmParseText(JSON.stringify({ comments: [{ p: '4.2,1,16777215,uid', m: '在线弹幕' }] })),
    bad: dmParseText('不是弹幕'),
  }), BILI_XML);
  assert.equal(parsed.xml.length, 5);
  assert.equal(parsed.xml[1].color, '#ff0000');
  assert.equal(parsed.xml[2].mode, 5);
  assert.equal(parsed.json.length, 1);
  assert.equal(parsed.json[0].time, 4.2);
  assert.equal(parsed.bad.length, 0);

  // 3) 打开播放器 + 弹幕设置面板
  await page.evaluate(() => {
    const dialog = document.querySelector('#offlinePlayer');
    document.querySelector('#offlinePlayerTitle').textContent = '学生会也有洞！ · 第 05 集';
    if (!dialog.open) dialog.showModal();
    document.querySelector('#offlineDanmakuSettings').click();
  });
  await page.waitForTimeout(250);
  assert.equal(await page.locator('#danmakuPanel').evaluate((el) => el.classList.contains('hidden')), false,
    '点「弹幕设置」要展开面板');

  // 4) 真渲染：用假时钟把 currentTime 固定在 2.3 秒，检查 canvas 上真的画出了像素。
  //    弹幕位置完全由 currentTime 现算，所以这也是对「暂停/拖动天然同步」的验证。
  const render = await page.evaluate((xml) => {
    const real = danmakuView.video;
    danmakuView.video = { clientWidth: 800, clientHeight: 450, currentTime: 2.3 };
    dmResize(true);
    dmSetItems(dmParseText(xml), 'import', '测试弹幕');
    dmFrame();
    const canvas = danmakuView.canvas;
    const data = danmakuView.ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let painted = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) painted += 1;
    const lanes = danmakuView.items.map((item) => item.lane);
    // 关掉开关后画布必须为空
    const before = danmakuView.settings.enabled;
    danmakuView.settings.enabled = false;
    dmFrame();
    const off = danmakuView.ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let paintedOff = 0;
    for (let i = 3; i < off.length; i += 4) if (off[i] > 0) paintedOff += 1;
    danmakuView.settings.enabled = before;
    dmStop();
    danmakuView.video = real;
    return { painted, paintedOff, lanes, items: danmakuView.items.length };
  }, BILI_XML);
  assert.ok(render.painted > 500, `弹幕应该真的画在 canvas 上，实际非透明像素 ${render.painted}`);
  assert.equal(render.paintedOff, 0, '关掉弹幕后画布必须清空');
  assert.equal(render.items, 5);

  // 5) 屏蔽词与开关持久化
  //    开关是纯图标按钮（Kazumi 式），没有文字节点，状态要看 aria-pressed / is-off / 对勾角标。
  const shield = await page.evaluate((xml) => {
    document.getElementById('dmShield').value = '剧透';
    document.getElementById('dmShield').dispatchEvent(new Event('change'));
    dmSetItems(dmParseText(xml), 'import', '屏蔽词测试');
    const toggle = document.getElementById('offlineDanmakuToggle');
    const badge = toggle.querySelector('.pc-dm-badge');
    const snapshot = () => ({
      pressed: toggle.getAttribute('aria-pressed'),
      offClass: toggle.classList.contains('is-off'),
      badgeShown: badge ? getComputedStyle(badge).display !== 'none' : null,
      sendDisabled: document.getElementById('dmSendButton')?.disabled === true,
      placeholder: document.getElementById('dmSendInput')?.placeholder || '',
    });
    const beforeOff = snapshot();
    toggle.click();                       // 关
    const offState = snapshot();
    toggle.click();                       // 再开回来
    const onState = snapshot();
    toggle.click();                       // 复位成「关」，保持后面用例的前提
    const saved = JSON.parse(localStorage.getItem('handbook.danmaku.settings') || '{}');
    return { count: danmakuView.items.length, enabled: danmakuView.settings.enabled,
      savedEnabled: saved.enabled, beforeOff, offState, onState };
  }, BILI_XML);
  assert.equal(shield.count, 4, '含「剧透」的那条要被屏蔽');
  assert.equal(shield.enabled, false);
  assert.equal(shield.savedEnabled, false, '设置要写进 localStorage');
  assert.equal(shield.beforeOff.pressed, 'true', '默认应为开启');
  assert.equal(shield.beforeOff.badgeShown, true, '开启时角标（对勾）要显示');
  assert.equal(shield.offState.pressed, 'false', '关掉后 aria-pressed 要变 false');
  assert.equal(shield.offState.offClass, true, '关掉后按钮要带 is-off');
  assert.equal(shield.offState.badgeShown, false, '关掉后角标要隐藏');
  assert.equal(shield.offState.sendDisabled, true, '关掉弹幕后发送框和按钮要禁用');
  assert.equal(shield.offState.placeholder, '已关闭弹幕');
  assert.equal(shield.onState.pressed, 'true', '再点一次要能开回来');
  assert.equal(shield.onState.badgeShown, true);

  // 6) 后端接口：本地弹幕查询可用、代理拒绝公网地址（不能变成任意 URL 代理）
  const api = await page.evaluate(async () => {
    const local = await fetch('/api/danmaku/local?file_id=2').then((r) => r.json());
    const proxy = await fetch('/api/danmaku/proxy', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base: 'https://example.com', path: '/api/v2/comment/1' }),
    }).then((r) => r.json());
    return { local: local.ok, proxyOk: proxy.ok, message: proxy.message || proxy.error || '' };
  });
  assert.equal(api.local, true);
  assert.equal(api.proxyOk, false);
  assert.match(api.message, /官方域名|本机|局域网/);

  // 通过面板搜索、确认分集并加载，匹配结果在重开该集时复用。
  let commentRequests = 0;
  await page.route('**/api/danmaku/proxy', async (route) => {
    const { path } = route.request().postDataJSON();
    const search = path.startsWith('/api/v2/search/episodes?');
    if (search) assert.equal(new URL(path, 'http://fixture').searchParams.get('anime'), '测试别名');
    else {
      assert.match(path, /\/comment\/108\?/);
      commentRequests++;
    }
    await route.fulfill({ json: { ok: true, text: JSON.stringify(search
      ? { animes: [{ animeTitle: '番剧 8', episodes: [
          { episodeId: 107, episodeTitle: '第 7 集' },
          { episodeId: 108, episodeTitle: '第 8 话' },
        ] }] }
      : { comments: [{ p: '4.2,1,16777215,uid', m: '测试在线弹幕' }] }) } });
  });
  const loadEpisode = () => page.evaluate(() =>
    dmLoadFor({ id: 0, episode_key: '0:8' }, '测试番剧', 9876, 'fixture:8'));
  await loadEpisode();
  assert.equal(await page.locator('#dmQuery').inputValue(), '测试番剧');
  await page.locator('#dmQuery').fill('测试别名');
  await page.locator('#dmQuery').press('Enter');
  await page.locator('#dmMatchRow').waitFor();
  assert.equal(await page.locator('#dmMatch').inputValue(), '108');
  await page.locator('#dmUseMatch').click();
  await page.getByText('在线弹幕已加载', { exact: true }).waitFor();
  assert.equal(await page.locator('#dmCount').textContent(), '1 条');
  await loadEpisode();
  assert.equal(commentRequests, 2);
  await page.unroute('**/api/danmaku/proxy');
  await page.getByText('显示与过滤', { exact: true }).click();
  assert.equal(await page.locator('#dmAreaValue').textContent(), '50%');
  await page.getByText('显示与过滤', { exact: true }).click();
  await page.locator('#dmConfigure').click();
  await page.locator('#settingsModal[open] [data-settings-tab="playback"].active').waitFor();
  assert.equal(await page.evaluate(() => document.activeElement.id), 'dmSourceMode');
  await page.keyboard.press('Escape');
  await page.locator('#settingsModal').waitFor({ state: 'hidden' });

  // 7) 恢复默认设置并留一张效果图
  await page.evaluate(() => {
    const video = document.querySelector('#offlineVideo');
    video.style.height = '450px';
    video.style.maxHeight = '450px';
    const width = Math.round(video.clientWidth) || 800;
    const height = Math.round(video.clientHeight) || 450;
    danmakuView.settings.enabled = true;
    danmakuView.settings.shield = '';
    dmSavePrefs();
    dmRenderPanelStatus();
    dmSyncControls();
    // 假时钟只在这一步用：截图前必须取消 rAF 循环，否则下一帧会用真实
    // currentTime=0 把画布清空（画面上就看不到弹幕了）。
    if (danmakuView.raf) cancelAnimationFrame(danmakuView.raf);
    danmakuView.raf = 0;
    danmakuView.video = { clientWidth: width, clientHeight: height, currentTime: 4.5 };
    dmResize(true);
    dmSetItems([
      { time: 0.5, mode: 1, color: '#ffffff', size: 25, text: '这集终于能看弹幕了' },
      { time: 1.2, mode: 1, color: '#ffd166', size: 28, text: '前方高能' },
      { time: 2.0, mode: 1, color: '#8ecae6', size: 25, text: '哈哈哈这也太好笑了' },
      { time: 2.8, mode: 5, color: '#ffffff', size: 25, text: '顶部固定弹幕' },
      { time: 3.5, mode: 1, color: '#ffffff', size: 25, text: '字幕组辛苦了' },
      { time: 4.0, mode: 1, color: '#ffa8a8', size: 25, text: '每周追更打卡' },
    ], 'import', '本地弹幕 · 6 条');
    dmFrame();
    cancelAnimationFrame(danmakuView.raf);
    danmakuView.raf = 0;
  });
  await page.waitForTimeout(150);
  const aligned = await page.evaluate(() => {
    const box = (el) => { const r = el.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; };
    return { video: box(document.querySelector('#offlineVideo')), canvas: box(document.querySelector('#danmakuCanvas')) };
  });
  assert.deepEqual(aligned.canvas, aligned.video, '弹幕 canvas 必须和视频画面严格对齐');
  // 主图：收起设置面板，只留底部按钮和铺开的弹幕
  await page.evaluate(() => document.querySelector('#danmakuPanel').classList.add('hidden'));
  // 另一张：面板展开，展示 Kazumi 式的弹幕设置
  await page.evaluate(() => document.querySelector('#danmakuPanel').classList.remove('hidden'));
  await page.waitForTimeout(120);
  const bounds = await page.locator('#danmakuPanel').boundingBox();
  const videoBounds = await page.locator('#offlinePlayerVideoWrap').boundingBox();
  assert.ok(bounds.y >= videoBounds.y && bounds.y + bounds.height <= videoBounds.y + videoBounds.height);

  // 8) 全屏路径回归：容器能进全屏（:fullscreen CSS 生效、video 占满视口）、能退出。
  //    headless 触发不了原生 video 全屏，所以「video 全屏 → 容器转接」这一步
  //    只能靠真实浏览器实测；这里锁定的是转接的目标（容器全屏）本身可用。
  const fullscreen = await page.evaluate(() => document.querySelector('#offlinePlayerVideoWrap').requestFullscreen()
    .then(() => new Promise((resolve) => setTimeout(resolve, 250)))
    .then(() => ({
      container: document.querySelector('#offlinePlayerVideoWrap').matches(':fullscreen'),
      videoW: Math.round(document.querySelector('#offlineVideo').getBoundingClientRect().width),
      viewportW: window.innerWidth,
    }))
    .catch((error) => ({ error: String(error) })));
  if (fullscreen.error) {
    console.log('skip fullscreen assertion:', fullscreen.error);
  } else {
    assert.equal(fullscreen.container, true, '容器要能进全屏');
    assert.ok(fullscreen.videoW > fullscreen.viewportW - 30,
      `全屏时视频要占满视口宽，实际 \${fullscreen.videoW}/\${fullscreen.viewportW}`);
    await page.evaluate(() => document.exitFullscreen());
    await page.waitForTimeout(250);
    assert.equal(await page.evaluate(() => Boolean(document.fullscreenElement)), false, '要能退出全屏');
  }

  // 8) 播放设置里的弹幕源：公共源隐藏地址和凭据，官方源显示。
  const sourceMode = await page.evaluate(() => {
    renderPlaybackSettings();
    const mode = document.querySelector('#dmSourceMode');
    const official = document.querySelector('#dmAppSecret').closest('.setting-row');
    const base = document.querySelector('#dmBase').closest('.setting-row');
    const results = {
      defaultMode: mode.value,
      publicHidesBase: base.classList.contains('hidden'),
      publicHidesOfficial: official.classList.contains('hidden'),
    };
    mode.value = 'dandanplay';
    updateDanmakuSourceFields();
    results.officialShowsBase = !base.classList.contains('hidden');
    results.officialShowsFields = !official.classList.contains('hidden');
    mode.value = 'public';
    updateDanmakuSourceFields();
    return results;
  });
  assert.equal(sourceMode.defaultMode, 'public', '默认要选公共源（免配置）');
  assert.equal(sourceMode.publicHidesBase, true, '公共模式不出现地址输入框');
  assert.equal(sourceMode.publicHidesOfficial, true, '公共模式不出现凭证字段');
  assert.equal(sourceMode.officialShowsFields, true, '官方模式要出现 AppId/AppSecret');

  console.log('verify_danmaku: OK', JSON.stringify({ painted: render.painted, shield: shield.count }));
  await browser.close();
})().catch((error) => { console.error(error); process.exit(1); });
