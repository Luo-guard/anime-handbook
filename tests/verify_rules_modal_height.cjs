// 矮窗口下两个规则弹窗（设置里的「链接规则」、详情页的「更多站点」）不能把内容
// 顶到白框外面（审计 N9）。以前列表写死 min-height:200px，窗高一压就溢出底框。
const fs = require('fs');
const assert = require('node:assert/strict');
const { chromium } = require('C:/Users/han/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

const html = fs.readFileSync('static/index.html', 'utf8');
const slice = (marker) => {
  const start = html.indexOf(marker);
  const end = html.indexOf('</dialog>', start) + '</dialog>'.length;
  assert(start > 0 && end > start, `${marker} exists`);
  return html.slice(start, end);
};
const rulesDialog = slice('<dialog class="modal rules-dialog" id="linkRulesModal">');
const menuDialog = slice('<dialog class="modal rules-menu-dialog" id="rulesMenuModal">');

const rows = (count, cls) => Array.from({ length: count }, (_, i) => cls.replace('{i}', i + 1)).join('');
const fill = `
document.querySelector('#linkRulesList').innerHTML = ${JSON.stringify(
  rows(40, '<label class="rules-row"><input type="checkbox" /><span class="rules-name">站点 {i}</span><span class="rules-host">site{i}.example</span></label>'),
)};
document.querySelector('#rulesMenuList').innerHTML = ${JSON.stringify(
  rows(40, '<div class="rules-menu-row"><a class="rules-menu-open" href="#"><span class="rules-menu-name">站点 {i}</span><span class="rules-menu-host">site{i}.example</span></a><button class="rules-menu-pin" type="button">📌</button></div>'),
)};
document.querySelector('#linkRulesStatus').textContent = '共 74 个站点可用 · 链接总数上限 12 条，还能加 6 条';
document.querySelector('#rulesMenuStatus').textContent = '共 74 个站点；固定到详情页的会单独占一条链接（上限 12 条）。';
`;

const measure = (selector) => {
  const dialog = document.querySelector(selector);
  const frame = dialog.querySelector('.modal-frame');
  const title = frame.querySelector('h2');
  const box = frame.getBoundingClientRect();
  const children = [...frame.children].filter((el) => el.offsetParent !== null || el.className.includes('modal-actions'));
  const worst = Math.max(...children.map((el) => el.getBoundingClientRect().bottom));
  return {
    overflow: frame.scrollHeight - frame.clientHeight,
    titleClipped: title.scrollHeight > title.clientHeight + 1,
    // 白框自己不能超出 dialog（超出就说明内容顶到框外了）。
    frameSpill: Math.round(box.bottom - dialog.getBoundingClientRect().bottom),
    childSpill: Math.round(worst - box.bottom),
    listHeight: frame.querySelector('.rules-list').clientHeight,
  };
};

(async () => {
  const browser = await chromium.launch({ headless: true, ignoreDefaultArgs: ['--hide-scrollbars'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setContent(`<style>${fs.readFileSync('static/styles.css', 'utf8')}</style>${rulesDialog}${menuDialog}`);
    await page.addScriptTag({ content: fill });
    await page.evaluate(() => {
      document.querySelector('#linkRulesModal').showModal();
      document.querySelector('#rulesMenuModal').showModal();
    });

    for (const height of [900, 640, 520, 480, 420, 380]) {
      await page.setViewportSize({ width: 1280, height });
      for (const [name, selector] of [['链接规则', '#linkRulesModal'], ['更多站点', '#rulesMenuModal']]) {
        const m = await page.evaluate(measure, selector);
        assert.equal(m.frameSpill, 0, `${name} @${height}: 白框不能超出弹窗（${JSON.stringify(m)}）`);
        assert.equal(m.titleClipped, false, `${name} @${height}: 标题被压扁了（${JSON.stringify(m)}）`);
        assert.ok(m.listHeight >= 40, `${name} @${height}: 列表至少留一行（${JSON.stringify(m)}）`);
        // 520 / 480 是审计实测的两档，这两档必须完全不用滚。
        if (height >= 480) {
          assert.equal(m.overflow, 0, `${name} @${height}: 内容还在往外顶（${JSON.stringify(m)}）`);
        }
      }
    }

    // 高窗口下列表照旧有 200px 下沿，不会被压成一条缝。
    await page.setViewportSize({ width: 1280, height: 900 });
    const tall = await page.evaluate(measure, '#rulesMenuModal');
    assert.ok(tall.listHeight > 200, `高窗口列表要够高：${JSON.stringify(tall)}`);

    assert.deepEqual(errors, [], 'no page errors');
    console.log('Rules modal height: 矮窗口下两个弹窗内容不再溢出白框，标题不被压扁，列表保住一行。');
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exit(1); });
