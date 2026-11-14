// 截图入库 + 媒体库图片视图：保存路径/命名模板/列表/大图/删除。
const assert = require('node:assert/strict');
const { chromium } = require('C:/Users/han/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const API = process.env.HANDBOOK_TEST_URL || 'http://127.0.0.1:43127';

function tinyPng() {
  // 2x2 红点 PNG（固定字节，不依赖第三方库）
  const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFElEQVR4nGP8z8DAwMDAxMDAwMAAAAwBAQDJ/pLvAAAAAElFTkSuQmCC';
  return b64;
}

const post = (path, body) => fetch(`${API}${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: API }, body: JSON.stringify(body),
});

(async () => {
  const before = await (await fetch(`${API}/api/offline/settings`)).json();
  const originalFormat = before.config?.screenshot_name_format || '';
  const created = [];
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1360, height: 860 } });
  try {
    // 1) 保存一张：默认模板 + 按番名建文件夹
    let res = await post('/api/offline/screenshot', { anime: '回归测试番', episode: '第07集', seconds: 754.2, data: `data:image/png;base64,${tinyPng()}` });
    assert.equal(res.status, 200, `保存截图应成功，实际 ${res.status}`);
    const saved = await res.json();
    created.push(saved.relative);
    assert.equal(saved.folder, '回归测试番', `应按番名建文件夹，实际 ${saved.folder}`);
    assert.match(saved.name, /^第07集_12-34\.png$/, `默认命名应为 {episode}_{time}，实际 ${saved.name}`);
    res = await post('/api/offline/screenshot', { anime: '回归测试番', episode: '第07集', seconds: 754.2, data: tinyPng() });
    assert.equal(res.status, 200);
    const duplicate = await res.json();
    created.push(duplicate.relative);
    assert.equal(duplicate.name, '第07集_12-34-2.png');

    // 2) 自定义模板
    await post('/api/offline/settings', { ...before.config, screenshot_name_format: '{anime}·{episode}·{date}' });
    res = await post('/api/offline/screenshot', { anime: '回归测试番', episode: '第08集', seconds: 12, data: `data:image/png;base64,${tinyPng()}` });
    const custom = await res.json();
    created.push(custom.relative);
    assert.match(custom.name, /^回归测试番·第08集·\d{8}\.png$/, `自定义模板未生效：${custom.name}`);
    await post('/api/offline/settings', { ...before.config, screenshot_name_format: originalFormat });

    // 3) 列表 + 图片回传
    const list = await (await fetch(`${API}/api/offline/screenshots`)).json();
    const group = list.groups.find((item) => item.folder === '回归测试番');
    assert.ok(group && group.count >= 2, `列表要有这组截图，实际 ${JSON.stringify(list.groups.map((g) => g.folder))}`);
    const file = await fetch(`${API}/api/offline/screenshot-file?path=${encodeURIComponent(created[0])}`);
    assert.equal(file.status, 200, '图片应能回传');
    const magic = Buffer.from(await file.arrayBuffer()).subarray(0, 8).toString('hex');
    assert.equal(magic, '89504e470d0a1a0a', '回传的应是 PNG');
    // 越界读取要被挡住
    const escape = await fetch(`${API}/api/offline/screenshot-file?path=${encodeURIComponent('../../offline.json')}`);
    assert.ok([400, 404].includes(escape.status), `越界路径必须被拒绝，实际 ${escape.status}`);

    // 4) 界面：媒体库 → 图片 → 缩略图 → 大图
    await page.goto(API, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => scheduleState.initialized === true, null, { timeout: 40000 });
    await page.click('#libraryNavButton');
    await page.waitForTimeout(900);
    assert.equal(await page.evaluate(() => document.querySelector('#libraryView h1').textContent.trim()), '媒体库', '页面标题应为「媒体库」');
    await page.click('[data-library-kind="image"]');
    await page.waitForFunction(() => document.querySelectorAll('#libImageGroups .lib-image-thumb').length > 0, null, { timeout: 15000 });
    const ui = await page.evaluate(() => ({
      thumbs: document.querySelectorAll('#libImageGroups .lib-image-thumb').length,
      groups: [...document.querySelectorAll('#libImageGroups .lib-image-group h3')].map((n) => n.textContent),
      videoHidden: document.querySelector('#libraryVideoPane').classList.contains('hidden'),
    }));
    assert.equal(ui.videoHidden, true, '切到图片后视频面板要隐藏');
    assert.ok(ui.groups.includes('回归测试番'), `分组里应有测试番：${ui.groups}`);
    const thumb = page.getByRole('button', { name: duplicate.name, exact: false });
    assert.equal(await thumb.locator('span').textContent(), '12:34', '重名序号不属于播放时间');
    await thumb.click();
    await page.waitForTimeout(500);
    const viewer = await page.evaluate(() => ({
      open: document.querySelector('#libImageViewer').open,
      src: document.querySelector('#libImageView').getAttribute('src'),
      caption: document.querySelector('#libImageCaption').textContent,
    }));
    assert.equal(viewer.open, true, '点缩略图应打开大图');
    assert.ok(viewer.src.includes('screenshot-file'), `大图要走图片接口：${viewer.src}`);
    assert.ok((await page.evaluate(() => document.querySelector('#libImageView').naturalWidth)) > 0, '大图要真的加载出来');
    const readFit = () => page.locator('#libImageView').evaluate((img) => {
      const rect = img.getBoundingClientRect();
      return getComputedStyle(img).objectFit === 'contain'
        && rect.left >= 0 && rect.right <= innerWidth
        && rect.top >= 0 && rect.bottom <= innerHeight;
    });
    assert.ok(await readFit(), '预览应在视口内完整显示图片');
    await page.click('#libImageFullscreen');
    await page.waitForFunction(() => document.fullscreenElement === document.querySelector('#libImageViewer .modal-frame'));
    assert.ok(await readFit(), '全屏应在视口内完整显示图片');
    assert.ok(await page.locator('#libImageView').evaluate(img => {
      const { x, y, width, height } = img.getBoundingClientRect();
      return x === 0 && y === 0 && Math.abs(width - innerWidth) < 1 && Math.abs(height - innerHeight) < 1;
    }), '全屏图片容器应覆盖整个视口');
    assert.equal(await page.locator('#libImageDelete').isVisible(), false);
    const caption = page.locator('#libImageCaption');
    await page.mouse.move(300, 300);
    await page.waitForFunction(() => Number(getComputedStyle(document.querySelector('#libImageCaption')).opacity) === 0);
    await page.mouse.move(320, 300);
    await page.waitForFunction(() => Number(getComputedStyle(document.querySelector('#libImageCaption')).opacity) === 1);
    const initialCaption = await caption.textContent();
    await page.keyboard.press('ArrowRight');
    assert.notEqual(await caption.textContent(), initialCaption, '全屏时可以用方向键翻页');
    await page.keyboard.press('ArrowLeft');
    assert.equal(await caption.textContent(), initialCaption);
    await page.click('#libImageFullscreen');
    await page.waitForFunction(() => !document.fullscreenElement);
    await page.setViewportSize({ width: 390, height: 650 });
    assert.ok(await readFit(), '窄屏也应完整显示图片');
    await page.click('#libImageFullscreen');
    await page.waitForFunction(() => Boolean(document.fullscreenElement));
    assert.ok(await readFit(), '窄屏全屏也应完整显示图片');
    await page.click('#libImageFullscreen');
    await page.waitForFunction(() => !document.fullscreenElement);
    await page.setViewportSize({ width: 1360, height: 860 });
    await page.click('#libImageFullscreen');
    await page.waitForFunction(() => Boolean(document.fullscreenElement));
    await page.click('#libImageClose');
    await page.waitForFunction(() => !document.fullscreenElement && !document.querySelector('#libImageViewer').open);
    await thumb.click();

    // 5) 删除：大图里删一张，列表数量要少一张
    // 删除现在有二次确认，headless 里必须显式接受，否则 confirm 返回 false 会当成取消。
    page.once('dialog', (dialog) => dialog.accept());
    const beforeDelete = (await (await fetch(`${API}/api/offline/screenshots`)).json()).groups
      .find((item) => item.folder === '回归测试番')?.count || 0;
    await page.click('#libImageDelete');
    await page.waitForTimeout(1400);
    const afterDelete = (await (await fetch(`${API}/api/offline/screenshots`)).json()).groups
      .find((item) => item.folder === '回归测试番')?.count || 0;
    assert.equal(afterDelete, beforeDelete - 1, `删除后数量应减一：${beforeDelete} → ${afterDelete}`);
    console.log('Screenshot library: saves into per-anime folder with default/custom name template, lists + serves safely, UI switches video/image, viewer and delete work.');
  } finally {
    for (const relative of created) {
      await post('/api/offline/screenshot/delete', { relative }).catch(() => {});
    }
    await fetch(`${API}/api/offline/settings`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: API },
      body: JSON.stringify({ ...before.config, screenshot_name_format: originalFormat }),
    }).catch(() => {});
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exit(1); });
