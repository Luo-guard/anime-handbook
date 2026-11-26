// 片源失败提示：后端给原因码，前端换成「能照着做」的一句话 + 对应按钮。
const fs = require('fs');
const assert = require('node:assert/strict');
const { chromium } = require('C:/Users/han/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

const source = fs.readFileSync('static/modules/online-playback.js', 'utf8');
const network = fs.readFileSync('static/modules/network.js', 'utf8');

// 1) 原因码要从 API 层一路带到调用方，否则前端只能看中文猜。
assert.ok(network.includes('if (payload.code) error.code = String(payload.code);'),
  'api() 没有把后端的原因码带进错误对象');
assert.ok(network.includes('error.status = response.status;'), '错误对象应该带 HTTP 状态');

// 2) 四句话必须真的存在，而且各自对应一个码。
for (const [code, sentence] of [
  ['site_unreachable', '站点连不上'],
  ['site_changed', '站点改版了，这条规则需要更新。'],
  ['episode_missing', '这条线路没有这一集'],
  ['no_media', '这条线路拿不到播放地址'],
]) {
  assert.ok(source.includes(`${code}: {`), `缺少原因码 ${code}`);
  assert.ok(source.includes(sentence), `原因码 ${code} 缺少对应文案：${sentence}`);
}
// 「更新规则」只跟着规则过期那一类出现。
assert.ok(/site_changed: \{[^}]*update: true/.test(source), '规则过期没有给「更新规则」动作');

const stubs = `
window.$ = (s, r = document) => r.querySelector(s);
window.$$ = (s, r = document) => [...r.querySelectorAll(s)];
window.state = { animes: [], progressAnime: null, settings: {} };
window.toast = (m) => { window.toasts = (window.toasts || []).concat(String(m)); };
window.__calls = [];
window.__rules = [{ id: 'demo', name: '示例站点', host: 'example.com', installed: true, version: '1',
  base: 'https://example.com/', search: 'https://example.com/search?q=@keyword' }];
window.api = async (url, options = {}) => {
  window.__calls.push([String(url), options.method || 'GET', options.body || '']);
  if (String(url).includes('/api/playback/rules')) return { items: window.__rules, default_rule: '' };
  if (String(url).includes('/api/playback/search')) {
    if (window.__searchMode === 'mixed') {
      return {
        items: [
          { id: 'https://example.com/a', title: '示例番 第 1 集', playable: true },
          { id: '', title: '示例番 第 2 集', playable: false, reason: '链接是脚本或下载协议，不是网页地址' },
        ],
        skipped: [{ title: '示例番 第 2 集', reason: '链接是脚本或下载协议，不是网页地址' }],
      };
    }
    const error = new Error('页面打开了，但这个站点没有解析出任何选集');
    error.code = 'site_changed';
    throw error;
  }
  return {};
};
window.escapeHtml = (v) => String(v ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
window.episodeStorageKey = (k) => (typeof k === 'string' ? k : (k && k.key) || '');
window.storedEpisodeName = () => '';
`;

const pickerDom = `
<dialog id="onlinePlaybackPicker">
  <h2 id="onlinePlaybackPickerTitle">播放来源</h2>
  <p id="onlineSourceAnime"></p>
  <p id="onlineRuleStatus"></p>
  <div id="onlinePlaybackResults"></div>
</dialog>
<!-- 「更新规则」会复用规则管理器的那套 DOM，这里按真实页面的结构摆上。 -->
<select id="onlineRuleFilter"></select>
<select id="onlineDefaultRule"></select>
<div id="onlineRuleCatalogue"></div>
<button type="button" id="onlineRuleCheckUpdates"></button>`;

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setContent(pickerDom);
    await page.addScriptTag({ content: stubs + source });

    // 3) 四句话本身：同一句「没有可用的选集」不再混用。
    const texts = await page.evaluate(() => ({
      unreachable: playbackErrorText({ code: 'site_unreachable', message: '片源站点连接失败' }, '兜底'),
      changed: playbackErrorText({ code: 'site_changed', message: '页面打开了，但这个站点没有解析出任何选集' }, '兜底'),
      missing: playbackErrorText({ code: 'episode_missing', message: '这条线路没有这一集' }, '兜底'),
      noMedia: playbackErrorText({ code: 'no_media', message: '站点没有提供这一集的播放地址' }, '兜底'),
      fallback: playbackErrorText({ name: 'TimeoutError', message: '' }, '读取选集超时'),
      detail: playbackErrorDetail({ code: 'site_changed', message: '页面打开了，但这个站点没有解析出任何选集' }),
    }));
    assert.match(texts.unreachable, /站点连不上.*检查网络/);
    assert.equal(texts.changed, '站点改版了，这条规则需要更新。');
    assert.match(texts.missing, /没有这一集.*换一条线路/);
    assert.match(texts.noMedia, /拿不到播放地址.*换一条线路/);
    assert.equal(texts.fallback, '读取选集超时', '没有原因码的错误要保留原来的提示');
    assert.ok(texts.detail.includes('没有解析出任何选集'), '具体原因要以小字保留');

    // 4) 检索失败时：说清是规则过期，并给一个「更新规则」。
    await page.evaluate(async () => {
      const anime = {
        id: 9, display_name: '测试番',
        episodes: [{ key: '0:1', type: 0, sort: 1 }], episode_count: 3, watched_episode_keys: [],
      };
      await window.onlinePlayback.openAnime(anime, '', null, { choose: true });
      const group = document.querySelector('.online-source');
      group.open = true;   // 展开即触发检索
    });
    await page.waitForTimeout(400);
    const view = await page.evaluate(() => ({
      state: document.querySelector('.online-source-status')?.textContent || '',
      feedback: document.querySelector('.online-source-feedback')?.textContent || '',
      buttons: [...document.querySelectorAll('.online-source-feedback button')].map(button => button.textContent),
    }));
    assert.equal(view.state, '规则需更新', `来源行要写明原因，实际：${view.state}`);
    assert.ok(view.feedback.includes('站点改版了'), `提示要是那句能照做的话，实际：${view.feedback}`);
    assert.ok(view.feedback.includes('没有解析出任何选集'), '具体原因也要留着');
    assert.deepEqual(view.buttons, ['更新规则'], '规则过期要给「更新规则」按钮');

    // 4.1) 站点名本身就是「打开原网页」：带箭头的链接，指向站点对这一部的搜索结果。
    const site = await page.evaluate(() => {
      const link = document.querySelector('.online-source-site');
      return link ? {
        tag: link.tagName, text: link.textContent, href: link.getAttribute('href'),
        target: link.target, rel: link.rel, title: link.title,
      } : null;
    });
    assert.ok(site, '站点名应该是「打开原网页」的链接');
    assert.equal(site.tag, 'A');
    assert.ok(site.text.endsWith('↗'), `站点名后面要有一个箭头，实际：${site.text}`);
    assert.equal(site.href, 'https://example.com/search?q=%E6%B5%8B%E8%AF%95%E7%95%AA',
      '应该带上番名打开站点的搜索结果');
    assert.equal(site.target, '_blank', '要新开标签，别把播放面板顶掉');
    assert.match(site.rel, /noopener/);

    // 没有站点地址时退回普通文字，不做成死链。
    assert.equal(await page.evaluate(() => ruleOpenUrl({ base: 'notaurl', search: 'https://x/?q=@keyword' }, ['a'])), '');
    assert.equal(await page.evaluate(() => ruleOpenUrl({ base: 'https://example.com/' }, ['a'])), 'https://example.com/');

    // 点站点名不应该顺带展开/收起这一条来源。
    await page.evaluate(() => {
      document.querySelector('.online-source-site')?.addEventListener('click', event => event.preventDefault(), { once: true });
    });
    const beforeOpen = await page.evaluate(() => document.querySelector('.online-source').open);
    await page.click('.online-source-site');
    const afterOpen = await page.evaluate(() => document.querySelector('.online-source').open);
    assert.equal(afterOpen, beforeOpen, '点站点名不该改变展开状态');

    // 5) 点「更新规则」→ 真的调了更新接口，而不是只弹个提示。
    await page.evaluate(() => document.querySelector('.online-source-feedback button').click());
    await page.waitForTimeout(400);
    const updateCall = await page.evaluate(() => window.__calls.find(call => call[0].includes('/api/playback/rules') && call[1] === 'POST'));
    assert.ok(updateCall, '没有调用规则接口');
    assert.equal(JSON.parse(updateCall[2]).action, 'update', '按钮应该走「更新」而不是重新安装');
    assert.equal(JSON.parse(updateCall[2]).id, 'demo');

    // 6) 匹配到「打不开」的那一集：说清是链接不可用，而不是站点没有。
    const broken = await page.evaluate(() => {
      const catalogue = {
        sources: [{
          id: 1, name: '主线',
          episodes: [
            { id: 'e4', number: 4, playable: true },
            { id: 'e5', number: 5, playable: false, reason: '链接是脚本或下载协议，不是网页地址' },
          ],
        }],
      };
      try {
        matchOnlineEpisode(catalogue, { number: 5, first: 1 });
      } catch (error) {
        return { message: error.message, code: error.code };
      }
      return {};
    });
    assert.equal(broken.code, 'episode_unplayable', '打不开的集要有自己的原因码');
    assert.ok(broken.message.includes('第 5 集'), `要说清是哪一集，实际：${broken.message}`);
    assert.ok(broken.message.includes('脚本'), '要带上具体原因');

    // 7) 打不开的搜索结果：列出来、点不了、可以展开看原因。
    await page.evaluate(async () => {
      window.__searchMode = 'mixed';
      const anime = {
        id: 9, display_name: '测试番',
        episodes: [{ key: '0:1', type: 0, sort: 1 }], episode_count: 3, watched_episode_keys: [],
      };
      await window.onlinePlayback.openAnime(anime, '', null, { choose: true });
      document.querySelector('.online-source').open = true;
    });
    await page.waitForTimeout(400);
    const mixed = await page.evaluate(() => {
      const buttons = [...document.querySelectorAll('.online-source-results button')];
      const details = document.querySelector('.online-source-skipped');
      return {
        hint: document.querySelector('.online-source-status')?.textContent || '',
        buttons: buttons.map(button => ({
          text: button.textContent, disabled: button.disabled, state: button.dataset.state || '', title: button.title,
        })),
        summary: details?.querySelector('summary')?.textContent || '',
        reasons: [...(details?.querySelectorAll('li') || [])].map(item => item.textContent),
      };
    });
    assert.equal(mixed.hint, '1 个结果 · 1 条打不开', `提示要带上打不开的条数，实际：${mixed.hint}`);
    assert.equal(mixed.buttons.length, 2, '打不开的结果也要列出来');
    assert.equal(mixed.buttons[0].disabled, false);
    assert.equal(mixed.buttons[1].disabled, true, '打不开的结果不能点');
    assert.equal(mixed.buttons[1].state, 'unplayable');
    assert.match(mixed.buttons[1].text, /（打不开）$/);
    assert.ok(mixed.buttons[1].title.includes('脚本'), '悬停要能看原因');
    assert.equal(mixed.summary, '1 条链接无法识别', '要能展开看是哪几条');
    assert.ok(mixed.reasons[0].includes('第 2 集') && mixed.reasons[0].includes('脚本'));

    // 8) 选集对话框里的打不开条目：列出来但不能勾。
    const blockedRow = await page.evaluate(() => episodePickRow(
      { label: '第 02 集', playable: false, reason: '链接是脚本或下载协议，不是网页地址' }, 1, true,
    ));
    assert.ok(blockedRow.includes('is-blocked'), '打不开的集要有标记');
    assert.ok(blockedRow.includes('disabled') && !blockedRow.includes('checked'), '默认不勾选、也不允许勾');
    assert.ok(blockedRow.includes('打不开'), '要写明打不开');
    assert.ok(blockedRow.includes('脚本'), '悬停里要有原因');

    assert.deepEqual(errors, []);
    console.log('ok: 片源失败按原因码给出四句可照做的提示，规则过期能就地更新');
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
