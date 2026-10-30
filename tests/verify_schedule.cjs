const fs=require('fs'),vm=require('vm'),assert=require('assert');
const source=fs.readFileSync('static/schedule.js','utf8');
const elements={};function element(selector){return elements[selector]??={innerHTML:'',textContent:'',hidden:false,disabled:false,insertAdjacentHTML(_,text){this.innerHTML+=text},addEventListener(){}}}
const categories=[1,2,3,4,5].map((id)=>({id,name:['在看','想看','搁置','看过','抛弃'][id-1]}));
const state={settings:{},animes:[],activeView:'schedule'};
const ctx=vm.createContext({state,CATEGORIES:categories,pageLabel:id=>({schedule:"周表"})[id],console,URLSearchParams,AbortController,Date,setTimeout,clearTimeout,$:element,$$:()=>[],escapeHtml:s=>String(s??'').replaceAll('<','&lt;').replaceAll('"','&quot;')});
vm.runInContext(source,ctx);const run=s=>vm.runInContext(s,ctx);
assert.equal(run("scheduleToday(new Date('2026-10-14T19:59:00Z')).day"),3);
assert.equal(run("scheduleToday(new Date('2026-10-14T20:00:00Z')).day"),4);
assert.equal(run("scheduleToday(new Date('2026-12-31T19:59:00Z')).year"),2026);
assert.equal(run("scheduleToday(new Date('2026-12-31T20:00:00Z')).year"),2027);
ctx.fixture=[{key:'a',title:'甲',kind:'weekly',weekday:3,calendar_weekday:3,time:'20:00',time_order:960,score:8,votes:10,collection_type:1}, {key:'b',title:'乙',kind:'weekly',weekday:3,calendar_weekday:4,time:'01:00',time_order:1260,score:9,votes:2,collection_type:2}, {key:'c',title:'丙',kind:'network',weekday:0,release:'10/20网络放送',score:0,votes:0,collection_type:0}];
run("scheduleState.season='202610'; scheduleState.data={season:'202610',items:fixture};scheduleState.day=3");
assert.equal(run('scheduleFilteredItems().length'),3);
state.settings={schedule_statuses:[1],schedule_uncollected:false};assert.equal(run('scheduleFilteredItems().length'),1);
state.settings={schedule_statuses:[],schedule_uncollected:false};assert.equal(run('scheduleFilteredItems().length'),0);
state.settings={schedule_statuses:[1,2],schedule_uncollected:false};assert.equal(run('scheduleFilteredItems().length'),2);
for(const [sort,key] of [['time','a'],['score','b'],['popularity','a']]){state.settings={schedule_sort:sort};assert.equal(run('[...fixture.slice(0,2)].sort(scheduleComparator)[0].key'),key)}
assert.equal(run('scheduleTimeLabel(fixture[1])'),'次日 01:00');
assert.equal(run("scheduleTimeLabel({kind:'weekly'})"),'时间待公布');
run('renderSchedule()');assert(element('#scheduleGrid').innerHTML.includes('data-schedule-key="a"'));assert(!element('#scheduleGrid').innerHTML.includes('data-schedule-key="c"'));assert.equal(element('#scheduleWeek').innerHTML.split('data-schedule-day=').length-1,8);
run('scheduleState.day=0;renderSchedule()');assert(element('#scheduleGrid').innerHTML.includes('data-schedule-key="c"'));assert(element('#scheduleNotice').textContent.includes('不推算集数'));
run("scheduleState.search='不存在';renderSchedule()");assert(element('#scheduleGrid').innerHTML.includes('schedule-empty'));
ctx.malicious={key:'evil',title:'<img src=x>',kind:'weekly',time:'',weekday:1};const html=run('scheduleCard(malicious)');assert(!html.includes('<img src=x>'));
// Preserve old sidebar settings while inserting the new page beside collection.
const app=require('./frontend_source.cjs');const part=app.slice(app.indexOf('const SIDEBAR_ITEMS'),app.indexOf('\nfunction applySidebarLayout'));
vm.runInContext(part,ctx);state.settings={sidebar_order:['collection','timeline','statistics','ranking','settings']};
assert.equal(run("sidebarOrder().join(',')"),'collection,schedule,timeline,statistics,ranking,settings');
console.log('Schedule frontend: 04:00/quarter boundaries, filters, sorts, weekday/network views, escaping and sidebar migration passed');

ctx.visibilityFixture={key:'visible',id:123,title:'测试卡片',kind:'weekly',collection_type:1,score:8.1,votes:100,time:'20:30',weekday:1,calendar_weekday:1,release:'10/1~',tags:['奇幻']};
const markers={tags:'class="schedule-card-meta"',votes:'100 人评分',release:'class="schedule-card-release"',score:'class="poster-score"',collection:'class="schedule-collection-badge"',airtime:'class="schedule-airtime'};
state.settings={};
for(const marker of Object.values(markers))assert(run('scheduleCard(visibilityFixture)').includes(marker));
for(const [field,marker] of Object.entries(markers)){
 state.settings={schedule_card_fields:{[field]:false}};
 const html=run('scheduleCard(visibilityFixture)');assert(!html.includes(marker),field);
 for(const [other,otherMarker] of Object.entries(markers))if(other!==field)assert(html.includes(otherMarker),`${field} unexpectedly hides ${other}`);
}
state.settings={schedule_card_fields:Object.fromEntries(Object.keys(markers).map(key=>[key,false]))};
assert(!run('scheduleCard(visibilityFixture)').includes('class="schedule-card-footer"'));
assert(run('scheduleCard(visibilityFixture)').includes('测试卡片'));
console.log('Card information switches: default visibility, independent controls and empty-footer removal passed');
// Group priority is independent from each group's sort and from visibility filters.
ctx.groupFixture=[
 {key:'watch-low',title:'在看低分',kind:'weekly',collection_type:1,score:5,time_order:20},
 {key:'watch-high',title:'在看高分',kind:'weekly',collection_type:1,score:9,time_order:50},
 {key:'want',title:'想看',kind:'weekly',collection_type:2,score:7,time_order:10},
 {key:'outside-late',title:'未收藏晚',kind:'weekly',collection_type:0,score:10,time_order:100},
 {key:'outside-early',title:'未收藏早',kind:'weekly',collection_type:0,score:1,time_order:1}
];
state.settings={schedule_sort:'time',schedule_grouping:{mode:'collection',collection_order:['collected','uncollected'],sorts:{collected:'score',uncollected:'time'}}};
assert.equal(run('groupFixture.slice().sort(scheduleComparator).map(x=>x.key).join(",")'),'watch-high,want,watch-low,outside-early,outside-late');
state.settings.schedule_grouping.collection_order=['uncollected','collected'];
assert.equal(run('groupFixture.slice().sort(scheduleComparator)[0].key'),'outside-early');
state.settings.schedule_grouping={mode:'status',status_order:['2','1','uncollected'],sorts:{'1':'score',uncollected:'time'}};
assert.equal(run('groupFixture.slice().sort(scheduleComparator).map(x=>x.key).join(",")'),'want,watch-high,watch-low,outside-early,outside-late');
state.settings.schedule_grouping.mode='none';
assert.equal(run('groupFixture.slice().sort(scheduleComparator)[0].key'),'outside-early');
console.log('Grouped sorting: collection priority, six-status priority, per-group sorting and ungrouped fallback passed');
for(const sort of ['time','score','popularity']) {
 state.settings={schedule_sort:sort,schedule_grouping:{mode:'none',direction:'asc'}};
 const ascending=run('groupFixture.slice().sort(scheduleComparator).map(x=>x.key).join(",")');
 state.settings.schedule_grouping.direction='desc';
 const descending=run('groupFixture.slice().sort(scheduleComparator).map(x=>x.key).join(",")');
 // Popularity ties fall back to scores; primary values in this fixture remain distinct.
 assert.notEqual(ascending,descending);
}
state.settings={schedule_sort:'time',schedule_grouping:{mode:'collection',collection_order:['collected','uncollected'],sorts:{collected:'score'},directions:{collected:'asc',uncollected:'desc'}}};
assert.equal(run('groupFixture.slice().sort(scheduleComparator).map(x=>x.key).join(",")'),'watch-low,want,watch-high,outside-late,outside-early');
ctx.unknownTime={title:'未公布',kind:'weekly',time_order:null,collection_type:0};
assert(run('scheduleComparator(unknownTime,groupFixture[3])')>0);
console.log('Sort directions: all three sorts reverse, independent group directions retain priority, unknown times stay last.');
const sortingRequest={schedule_sort:'time',schedule_grouping:{mode:'collection',collection_order:['uncollected','collected'],status_order:['1','2','3','4','5','uncollected'],sorts:{collected:'score'},directions:{collected:'desc'}}};
ctx.sortingRequest=sortingRequest;
assert.throws(()=>run('verifyScheduleSortingSaved({schedule_sort:"time",schedule_grouping:{mode:"none"}},sortingRequest)'),/未保存完整/);
run('verifyScheduleSortingSaved({schedule_sort:"time",schedule_grouping:sortingRequest.schedule_grouping},sortingRequest)');
(async()=>{
 ctx.api=async()=>({ok:true});
 await assert.rejects(run('requireScheduleSortingSupport()'),/旧版本/);
 ctx.api=async()=>({ok:true,features:{schedule_sorting:2}});
 await run('requireScheduleSortingSupport()');
 console.log('Save checks: old backend blocked before writes; ignored settings rejected; supported backend accepted.');
})().catch(e=>{console.error(e);process.exitCode=1});
