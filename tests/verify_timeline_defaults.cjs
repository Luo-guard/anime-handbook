// 看番记录默认筛选：时间线首次应用、设置页勾选回填与标签。
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

// ---------- 时间线首次应用 ----------
const records = fs.readFileSync('static/modules/records.js', 'utf8');
const start = records.indexOf('let timelineDefaultsApplied = false;');
const end = records.indexOf('\nfunction switchView', start);
assert(start > 0 && end > start, 'records slice must exist');

function makeTimelineHarness(settings) {
  const elements = {};
  const element = (key) => (elements[key] ??= {
    innerHTML: '',
    classList: { add() {}, toggle() {}, remove() {} },
    insertAdjacentHTML(_, html) { this.innerHTML += html; },
    remove() {},
  });
  const requests = [];
  const context = vm.createContext({
    state: { activeView: 'timeline', settings, timelineSearch: '', timelineThemes: new Set() },
    URLSearchParams,
    AbortController,
    window: {},
    $: (selector) => element(selector),
    $$: () => [],
    api: (url) => {
      requests.push(url);
      return new Promise(() => {});
    },
    recordThemes: () => [
      { id: 'watch', name: '观看记录', color: '#5f8fba' },
      { id: 'note', name: '其他记录', color: '#7c8790' },
      { id: 'oped', name: 'OP/ED记录', color: '#4c9390' },
    ],
    formatDate: (value) => ({ main: value, sub: '' }),
    timelineEvent: () => '<article></article>',
    escapeHtml: (value) => String(value ?? ''),
    toast: () => {},
    renderTimelineThemeFilter: () => {},
    timelineAvailableThemes: null,
  });
  vm.runInContext(records.slice(start, end), context);
  return { context, requests, state: context.state };
}

function themeQuery(url) {
  return [...new URLSearchParams(url.split('?')[1]).getAll('theme')];
}

(function testTimelineDefaults() {
  const themed = makeTimelineHarness({ timeline_default_themes: ['note', 'oped'] });
  vm.runInContext('renderTimeline()', themed.context);
  assert.deepEqual(themeQuery(themed.requests[0]).sort(), ['note', 'oped'], '默认类型进入首个请求');
  assert.deepEqual([...themed.state.timelineThemes].sort(), ['note', 'oped']);

  // 同一会话内手动改筛选后再次渲染，不应被默认值覆盖。
  themed.state.timelineThemes = new Set(['watch']);
  vm.runInContext('renderTimeline()', themed.context);
  assert.deepEqual(themeQuery(themed.requests[1]), ['watch'], '本次会话内手动筛选保留');

  const everything = makeTimelineHarness({ timeline_default_themes: [] });
  vm.runInContext('renderTimeline()', everything.context);
  assert.deepEqual(themeQuery(everything.requests[0]), [], '空数组表示显示全部');

  const stale = makeTimelineHarness({ timeline_default_themes: ['deleted-theme', 'note'] });
  vm.runInContext('renderTimeline()', stale.context);
  assert.deepEqual(themeQuery(stale.requests[0]), ['note'], '已删除的类型被过滤');

  const legacy = makeTimelineHarness({});
  vm.runInContext('renderTimeline()', legacy.context);
  assert.deepEqual(themeQuery(legacy.requests[0]), [], '缺少设置时显示全部');
})();

// ---------- 设置页渲染 ----------
const settings = fs.readFileSync('static/modules/settings.js', 'utf8');
const settingsStart = settings.indexOf('// 看番记录默认筛选');
assert(settingsStart > 0, 'settings slice must exist');

function makeSettingsHarness(saved) {
  const grid = { innerHTML: '' };
  const themes = [
    { id: 'watch', name: '观看记录', color: '#5f8fba' },
    { id: 'note', name: '其他记录', color: '#7c8790' },
    { id: 'oped', name: 'OP/ED记录', color: '#4c9390' },
  ];
  const context = vm.createContext({
    state: { settings: { timeline_default_themes: saved } },
    $: (selector) => (selector === '#timelineDefaultThemesMenu' ? grid : null),
    recordThemes: () => themes,
    escapeHtml: (value) => String(value ?? ''),
  });
  vm.runInContext(settings.slice(settingsStart), context);
  return { context, grid };
}

(function testSettingsRendering() {
  const two = makeSettingsHarness(['note', 'oped']);
  vm.runInContext('renderTimelineDefaultThemes()', two.context);
  assert(/value="note" checked/.test(two.grid.innerHTML), '已保存的类型默认勾选');
  assert(/value="oped" checked/.test(two.grid.innerHTML));
  assert(!/value="watch" checked/.test(two.grid.innerHTML), '未保存的类型不勾选');
  assert(two.grid.innerHTML.includes('timelineDefaultThemesAll'), '提供全选（显示全部）入口');
  assert.equal((two.grid.innerHTML.match(/<label>/g) || []).length, 3, '每个类型一个可勾选项');

  const all = makeSettingsHarness([]);
  vm.runInContext('renderTimelineDefaultThemes()', all.context);
  assert(!/ checked/.test(all.grid.innerHTML), '空设置时全部不勾选');

  const unknown = makeSettingsHarness(['removed-theme']);
  vm.runInContext('renderTimelineDefaultThemes()', unknown.context);
  assert(!/ checked/.test(unknown.grid.innerHTML), '已删除的类型不会渲染成勾选');
})();

console.log('Timeline defaults: first load applies saved types, manual filter survives the session, empty means all, unknown types dropped, settings grid pre-checks saved types.');
