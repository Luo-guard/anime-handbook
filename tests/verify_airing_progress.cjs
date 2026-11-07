// 收藏详情里的播出进度：只认 airing（逐集日程 + 北京时间），完成后隐藏。
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

const source = fs.readFileSync('static/modules/presentation.js', 'utf8');
const ctx = vm.createContext({
  state: { animes: [], settings: {} },
  escapeHtml: (value) => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'),
  $: () => null,
  $$: () => [],
  window: {},
  document: { documentElement: { dataset: {} } },
});
vm.runInContext(source, ctx);
const run = (code) => vm.runInContext(code, ctx);

const fixture = "{airing:{aired:4,total:12,next_label:'11/04 20:00'}}";
const ongoing = run(`episodeReleaseStatus(${fixture},{type:0})`);
assert.ok(ongoing.includes('class="episode-release-status"')&&!ongoing.includes('<details'), 'badge is a plain pill, no disclosure overlay');
assert.ok(ongoing.includes('<i></i>'), 'pill keeps the green dot from the early version');
assert.ok(ongoing.includes('已播 4')&&!ongoing.includes('已播 4 / 12'), 'only the aired count, no / total');
assert.ok(ongoing.includes('共 12 集'), 'total still available in the hover title');
assert.ok(!/next_label|下集/.test(source), 'detail page no longer renders a next-episode footnote');
assert.ok(run("episodeReleaseStatus({airing:{aired:0,total:12}},{type:0})").includes("已播 0"));
assert.equal(run("episodeReleaseStatus({airing:{aired:12,total:12}},{type:0})"), '', 'finished shows hide the chip');
assert.equal(run("episodeReleaseStatus({airing:{aired:1,total:12}},{type:2})"), '', 'OP/ED groups have no airing chip');
assert.equal(run("episodeReleaseStatus({},{type:0})"), '', 'no airing data, no chip');
console.log('Airing progress: early-style pill shows only the aired count, no next-episode footnote, hides when finished and skips OP/ED.');
