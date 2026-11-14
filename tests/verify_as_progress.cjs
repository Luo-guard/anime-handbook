const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
const ctx = vm.createContext({
  state: {settings: {}, animes: []},
  escapeHtml: value => String(value ?? ''),
  window: {}, document: {documentElement: {dataset: {}}}, $: () => null, $$: () => [],
});
vm.runInContext(fs.readFileSync('static/modules/presentation.js', 'utf8'), ctx);
vm.runInContext(fs.readFileSync('static/schedule.js', 'utf8'), ctx);
const run = code => vm.runInContext(code, ctx);
run(`state.animes=[{id:1,episode_count:12,airing:{aired:5,total:12},as_airing:{aired:6,total:12,next_label:'11/09 21:00'}}]`);
assert(run('episodeReleaseStatus(state.animes[0],{type:0})').includes('已播 5'));
run(`state.settings.collection_airing_source='as'`);
assert(run('episodeReleaseStatus(state.animes[0],{type:0})').includes('已播 6'));
assert.equal(run(`scheduleProgress({kind:'weekly',local_id:1}).text`), '已播 5 / 12');
run(`state.settings.schedule_airing_source='as'`);
assert.equal(run(`scheduleProgress({kind:'weekly',local_id:1}).text`), '已播 6 / 12');
assert.equal(run(`scheduleProgress({kind:'weekly',as_airing:{aired:6,total:0}}).text`), '已播 6 集');
assert.equal(run(`scheduleProgress({kind:'weekly',local_id:1,as_airing:{unavailable:true}}).text`), '暂无 AS 进度');
run(`state.animes[0].as_airing=undefined`);
assert.equal(run('episodeReleaseStatus(state.animes[0],{type:0})'), '');
run(`state.animes[0].as_airing={unavailable:true,status:'loading'}`);
assert(run('episodeReleaseStatus(state.animes[0],{type:0})').includes('AS 进度加载中'));
run(`state.animes[0].as_airing={unavailable:true}; state.settings.hide_missing_as_schedule=false`);
assert(run('episodeReleaseStatus(state.animes[0],{type:0})').includes('AS 已播集数缺失'));
assert(!run('episodeReleaseStatus(state.animes[0],{type:0})').includes('已播 5'));
assert.equal(run('episodeReleaseStatus(state.animes[0],{type:2})'), '');
run(`state.settings.collection_airing_source='bgm'; state.animes[0].airing=undefined`);
assert(run('episodeReleaseStatus(state.animes[0],{type:0})').includes('BGM 已播集数缺失'));
run(`state.settings.hide_missing_as_schedule=true`);
assert.equal(run('episodeReleaseStatus(state.animes[0],{type:0})'), '');
const html=fs.readFileSync('static/index.html','utf8');
for (const id of ['collectionAiringSourceInput','scheduleAiringSourceInput']) assert(html.includes(`id="${id}"`));
console.log('AS progress: independent sources, cached values, missing metadata, no silent BGM fallback.');
