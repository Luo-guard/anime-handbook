// 播放器快捷键：设置界面能显示/配置，后端能保存，默认键位对齐 Kazumi。
const assert = require('node:assert/strict');
const { chromium } = require('C:/Users/han/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const API = 'http://127.0.0.1:43127';

(async () => {
  const original = await (await fetch(`${API}/api/bootstrap`)).json().then((d) => d.settings.keyboard_shortcuts);
  const patch = (bindings) => fetch(`${API}/api/settings`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Origin: API },
    body: JSON.stringify({ keyboard_shortcuts: { enabled: true, bindings } }),
  });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await page.goto(API, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => scheduleState.initialized === true, null, { timeout: 40000 });
    await page.click('#settingsButton');
    await page.waitForTimeout(500);
    await page.evaluate(() => switchSettingsTab('keyboard'));
    await page.waitForTimeout(400);

    // 1) 播放器三组 + 17 个动作都在界面上
    const ui = await page.evaluate(() => {
      const groups = [...document.querySelectorAll('#keyboardBindings .keyboard-group')]
        .map((g) => ({ title: g.querySelector('.keyboard-group-title')?.firstChild?.textContent?.trim(), rows: [...g.querySelectorAll('.keyboard-binding')].map((r) => r.dataset.shortcutAction) }))
        .filter((g) => g.rows.some((id) => id.startsWith('player_')));
      return {
        groups,
        total: document.querySelectorAll('#keyboardBindings .keyboard-binding').length,
        chips: Object.fromEntries([...document.querySelectorAll('#keyboardBindings .keyboard-binding')]
          .filter((r) => r.dataset.shortcutAction.startsWith('player_'))
          .map((r) => [r.dataset.shortcutAction, [...r.querySelectorAll('[data-key-chip]')].map((c) => c.dataset.key)])),
      };
    });
    assert.equal(ui.groups.length, 3, `播放器应有 3 个分组，实际 ${ui.groups.length}`);
    assert.equal(Object.keys(ui.chips).length, 17, '播放器动作应有 17 个');
    // 2) 默认键位对齐 Kazumi 的 defaultShortcuts
    const expected = {
      player_play_pause: ['Space'], player_forward: ['ArrowRight'], player_rewind: ['ArrowLeft'],
      player_prev: ['p'], player_next: ['n'], player_volume_up: ['ArrowUp'], player_volume_down: ['ArrowDown'],
      player_mute: ['m'], player_fullscreen: ['f'], player_danmaku: ['d'], player_screenshot: ['s'],
      player_skip: ['k'], player_speed_1: ['1'], player_speed_2: ['2'], player_speed_3: ['3'],
      player_speed_up: ['x'], player_speed_down: ['z'],
    };
    for (const [id, keys] of Object.entries(expected)) {
      assert.deepEqual(ui.chips[id], keys, `${id} 默认键位应为 ${keys}，实际 ${ui.chips[id]}`);
    }

    // 3) 改一个键位：后端能存、界面重渲染后还在
    const res = await patch({ player_skip: { enabled: true, keys: ['Alt+k'] } });
    assert.equal(res.status, 200, `保存播放器快捷键应成功，实际 ${res.status}`);
    const saved = await (await fetch(`${API}/api/bootstrap`)).json().then((d) => d.settings.keyboard_shortcuts.bindings.player_skip);
    assert.deepEqual(saved, { enabled: true, keys: ['Alt+k'] }, `后端保存结果：${JSON.stringify(saved)}`);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => scheduleState.initialized === true, null, { timeout: 40000 });
    await page.click('#settingsButton');
    await page.waitForTimeout(500);
    await page.evaluate(() => switchSettingsTab('keyboard'));
    await page.waitForTimeout(400);
    const chip = await page.evaluate(() => [...document.querySelectorAll('[data-shortcut-action="player_skip"] [data-key-chip]')].map((c) => c.dataset.key));
    assert.deepEqual(chip, ['Alt+k'], `重载后应显示新键位，实际 ${chip}`);

    // 4) 播放器和全局可以同键（1/2/3 既是导航也是倍速），不能算重复
    const status = await page.evaluate(() => document.querySelector('#keyboardStatus')?.textContent || '');
    assert.equal(status, '', `同键跨作用域不该报重复：${status}`);

    console.log('Player shortcuts: 3 groups / 17 actions, Kazumi default keys, custom binding persists, cross-scope duplicates allowed.');
  } finally {
    await fetch(`${API}/api/settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Origin: API },
      body: JSON.stringify({ keyboard_shortcuts: original }),
    });
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exit(1); });
