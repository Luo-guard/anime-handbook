const fs=require('fs'),vm=require('vm'),assert=require('node:assert/strict');
const source=require('./frontend_source.cjs'),html=fs.readFileSync('static/index.html','utf8');
const labels=[...html.matchAll(/<\w+\b[^>]*data-page-label="([^"]+)"[^>]*>([^<]*)/g)].map(m=>({dataset:{pageLabel:m[1]},textContent:m[2]}));
const references=[...html.matchAll(/data-page-text="([^"]+)"/g)].map(m=>({dataset:{pageText:m[1]},textContent:''}));
const custom={collection:'我的书架',schedule:'每周追番',timeline:'日记',statistics:'数据中心',ranking:'排行榜页面'};
const nodes={};const $=id=>nodes[id]||=( {innerHTML:'',classList:{toggle(){}},style:{setProperty(){}},insertAdjacentHTML(){},addEventListener(){}} );
const state={settings:{sidebar_labels:custom},ranking_boards:[],rankingBoard:null,rankingDirtyBoards:new Set()};
const ctx=vm.createContext({state,$,$$:selector=>selector==='[data-page-label]'?labels:selector==='[data-page-text]'?references:[],escapeHtml:String,createRankingBoard(){},CATEGORIES:[],rankingPeriodOptions:()=>'',bindRankingInteractions(){},showRankingHoverTitles:()=>false,rankingHoverDelay:()=>2});
vm.runInContext(source.slice(source.indexOf('const SIDEBAR_ITEMS ='),source.indexOf('\nfunction sidebarOrder()')),ctx);
vm.runInContext('applyPageLabels()',ctx);
for(const label of labels)assert.equal(label.textContent,custom[label.dataset.pageLabel]);
const creationHint=references.find(n=>n.dataset.pageText.includes('新建收藏夹'));
assert.equal(creationHint.textContent,'控制我的书架页面工具栏中是否出现“新建收藏夹”按钮。');
assert.ok(references.some(n=>n.textContent==='打开我的书架页面时默认显示的收藏夹。'));
for(const id of ['createRankingButton','scheduleRefresh']){
 const tag=html.match(new RegExp(`<[^>]+id="${id}"[^>]*>`))[0];assert.ok(!tag.includes('data-page-'),id+' is a functional action');
}
vm.runInContext(source.slice(source.indexOf('function renderRanking()'),source.indexOf('\nasync function loadRankingBoard')),ctx);
vm.runInContext('renderRanking()',ctx);
assert.ok($('#rankingWorkspace').innerHTML.includes('暂无排名表单'));
assert.ok($('#rankingWorkspace').innerHTML.includes('新增排名表单'));
assert.ok(!$('#rankingWorkspace').innerHTML.includes(custom.ranking));
state.rankingBoard={name:'用户命名的排名表单',items:[],tiers:[]};
vm.runInContext('renderRanking()',ctx);
assert.ok($('#rankingWorkspace').innerHTML.includes('导入收藏夹动漫'));
assert.ok($('#rankingWorkspace').innerHTML.includes('用户命名的排名表单'));
state.settings.sidebar_labels={};vm.runInContext('applyPageLabels()',ctx);
for(const label of labels)assert.equal(label.textContent,label.dataset.pageDefault);
console.log('Page names: navigation, titles, settings and page references follow custom names; actions, domain terms and user titles stay unchanged; defaults restore.');

