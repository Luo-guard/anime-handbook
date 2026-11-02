const fs = require('fs'), vm = require('vm'), assert = require('node:assert/strict');
const state = { settings: {}, statisticsType: 'watch', statisticsPeriod: 'week' };
const chart = { innerHTML: '' }, summary = { innerHTML: '' };
const ctx = vm.createContext({
  state,
  enabledSetting: k => state.settings[k] !== false,
  allRecordThemes: () => [],
  escapeHtml: s => s,
  $: s => (s === '#statisticsChart' ? chart : s === '#statisticsSummary' ? summary : null),
  api: async () => ({ series: [] }),
  requestAnimationFrame: () => {},
});
vm.runInContext(fs.readFileSync('static/modules/statistics.js', 'utf8'), ctx);

const label = ctx.statisticsDateLabel, title = ctx.statisticsPeriodTitle;
const withPeriod = (period, fn) => { state.statisticsPeriod = period; return fn(); };

// 周：横轴显示日期区间，同月省略重复的月份。
state.statisticsPeriod = 'week';
assert.equal(label('2026-W28'), '7/6–12');
assert.equal(label('2026-W32'), '8/3–9');
assert.equal(label('2026-W40'), '9/28–10/4', 'crossing a month keeps both months');
assert.equal(label('2026-W53'), '12/28–1/3', 'crossing a year stays readable');
// 悬停说明给出年份、周号和完整日期。
assert.equal(title('2026-W28'), '2026 年第 28 周 · 7 月 6 日 – 7 月 12 日');
assert.equal(title('2026-W40'), '2026 年第 40 周 · 9 月 28 日 – 10 月 4 日');

// 日 / 月 / 年保持原有精度，只做更易读的格式。
state.statisticsPeriod = 'day';
assert.equal(label('2026-10-29'), '10/29');
assert.equal(title('2026-10-29'), '2026 年 10 月 29 日');
state.statisticsPeriod = 'month';
assert.equal(label('2026-07'), '2026/07');
assert.equal(title('2026-07'), '2026 年 7 月');
state.statisticsPeriod = 'year';
assert.equal(label('2026'), '2026');
assert.equal(title('2026'), '2026');

// 取不到预期格式时原样返回，不抛错。
state.statisticsPeriod = 'week';
assert.equal(label('garbage'), 'garbage');
assert.equal(label(''), '');
assert.equal(title('2026-W99'), '2026-W99');

// 图表把日期写进标签和悬停提示里。
state.statisticsPeriod = 'week';
ctx.renderStatisticsChart([
  { label: '2026-W40', episodes: 12, records: 3 },
  { label: '2026-W41', episodes: 0, records: 0 },
]);
assert(chart.innerHTML.includes('>9/28–10/4</span>'));
assert(chart.innerHTML.includes('title="2026 年第 40 周 · 9 月 28 日 – 10 月 4 日：12 观看集数"'));
assert(!chart.innerHTML.includes('2026 W40'));

console.log('Statistics labels: week ranges (same month, month-crossing, year-crossing), hover titles, day/month/year formats and fallbacks passed.');
