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

const ongoing = run("episodeReleaseStatus({airing:{aired:4,total:12,next_label:'11/04 20:00'}},{type:0})");
assert.ok(ongoing.includes('已播 4 / 12'), ongoing);
assert.ok(ongoing.includes('下集 11/04 20:00'), ongoing);
assert.ok(ongoing.includes('北京时间'), 'title names the timezone');
assert.equal(run("episodeReleaseStatus({airing:{aired:12,total:12}},{type:0})"), '', 'finished shows hide the chip');
assert.equal(run("episodeReleaseStatus({airing:{aired:1,total:12}},{type:2})"), '', 'OP/ED groups have no airing chip');
assert.equal(run("episodeReleaseStatus({},{type:0})"), '', 'no airing data, no chip');
console.log('Airing progress: detail chip uses airing, shows next time in Beijing, hides when finished and skips OP/ED.');
