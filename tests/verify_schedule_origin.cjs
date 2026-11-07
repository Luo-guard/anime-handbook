// 周表地区筛选：韩漫并入「其他」、没有地区归「未标注」、默认全选不改变原有列表。
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const source = fs.readFileSync('static/schedule.js', 'utf8');
const elements = {};
function element(selector) {
  return elements[selector] ??= {
    innerHTML: '', textContent: '', hidden: false, disabled: false,
    classList: {contains: () => false, toggle() {}, add() {}, remove() {}},
    setAttribute(name, value) { this[name] = value; },
    insertAdjacentHTML(_, text) { this.innerHTML += text; },
    addEventListener() {},
  };
}
const categories = [1, 2, 3, 4, 5].map((id) => ({id, name: ['在看', '想看', '搁置', '看过', '抛弃'][id - 1]}));
const state = {settings: {}, animes: [], activeView: 'schedule'};
const ctx = vm.createContext({
  state, CATEGORIES: categories, pageLabel: (id) => ({schedule: '周表'})[id], console,
  URLSearchParams, AbortController, Date, setTimeout, clearTimeout,
  $: element, $$: () => [], escapeHtml: (s) => String(s ?? ''),
});
vm.runInContext(source, ctx);
const run = (code) => vm.runInContext(code, ctx);

// 分组：数据里韩国是独立值，界面上算「其他」；空值算「未标注」。
assert.equal(run("scheduleOriginOf({origin:'jp'})"), 'jp');
assert.equal(run("scheduleOriginOf({origin:'kr'})"), 'other');
assert.equal(run("scheduleOriginOf({origin:'other'})"), 'other');
assert.equal(run("scheduleOriginOf({})"), 'unknown');
assert.equal(run("scheduleOriginOf({origin:''})"), 'unknown');

ctx.fixture = [
  {key: 'a', title: '日番', kind: 'weekly', weekday: 3, time_order: 900, origin: 'jp', collection_type: 1},
  {key: 'b', title: '国番', kind: 'weekly', weekday: 3, time_order: 910, origin: 'cn', collection_type: 1},
  {key: 'c', title: '美番', kind: 'weekly', weekday: 3, time_order: 920, origin: 'us', collection_type: 1},
  {key: 'd', title: '韩番', kind: 'weekly', weekday: 3, time_order: 930, origin: 'kr', collection_type: 1},
  {key: 'e', title: '没标', kind: 'weekly', weekday: 3, time_order: 940, origin: '', collection_type: 1},
];
run("scheduleState.season='202610'; scheduleState.data={season:'202610',items:fixture}; scheduleState.day=3");

// 默认（没存过设置）全选，列表保持 5 条。
assert.equal(run('scheduleFilteredItems().length'), 5);
assert.deepEqual(run('schedulePreferences().origins'), ['jp', 'cn', 'us', 'other', 'unknown']);

state.settings = {schedule_origins: ['cn']};
assert.deepEqual(run('scheduleFilteredItems().map(i=>i.key)'), ['b']);

// 「其他」要同时收下 kr 和 other。
state.settings = {schedule_origins: ['other']};
assert.deepEqual(run('scheduleFilteredItems().map(i=>i.key)'), ['d']);

state.settings = {schedule_origins: ['unknown']};
assert.deepEqual(run('scheduleFilteredItems().map(i=>i.key)'), ['e']);

state.settings = {schedule_origins: ['jp', 'us']};
assert.deepEqual(run('scheduleFilteredItems().map(i=>i.key)'), ['a', 'c']);

// 和收藏状态筛选叠加：两者都满足才显示。
state.settings = {schedule_origins: ['cn'], schedule_statuses: [2], schedule_uncollected: false};
assert.equal(run('scheduleFilteredItems().length'), 0);

// 全不选 = 空列表，不会退化成「全显示」。
state.settings = {schedule_origins: []};
assert.equal(run('scheduleFilteredItems().length'), 0);

// 渲染出来的就是五档，勾选状态跟着设置走。
state.settings = {schedule_origins: ['cn', 'unknown']};
const markup = run("scheduleOriginMarkup(schedulePreferences().origins, 'scheduleFilterOrigin')");
assert.equal((markup.match(/<label>/g) || []).length, 5);
for (const label of ['日漫', '国漫', '美漫', '其他', '未标注']) assert.ok(markup.includes(`>${label}</span>`), label);
assert.equal((markup.match(/checked/g) || []).length, 2);
assert.ok(markup.includes('value="cn" checked'));
assert.ok(markup.includes('value="unknown" checked'));

console.log('Schedule origin filter: five buckets, kr folded into other, unknown fallback, stacking and empty selection passed');
