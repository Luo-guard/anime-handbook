const fs=require('fs'),assert=require('node:assert/strict');
const {chromium}=require('C:/Users/han/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const harness=[
  "const $=s=>document.querySelector(s);",
  "const $$=s=>[...document.querySelectorAll(s)];",
  "const state={settings:{},progressAnime:{id:1,name_cn:'测试番剧',display_name:'测试番剧'}};",
  "const enabledSetting=key=>state.settings[key]!==false;",
  "const escapeHtml=s=>String(s);",
  "window.testItems=[];",
  "const api=async()=>({features:{},scope:'scope',items:window.testItems});",
].join("\n");
(async()=>{const browser=await chromium.launch({headless:true});try{
const page=await browser.newPage({viewport:{width:1180,height:860}});
const html=fs.readFileSync('static/index.html','utf8').replace(/<script[\s\S]*?<\/script>/g,'').replace(/<link[^>]*>/g,'');
await page.setContent(`<style>${fs.readFileSync('static/styles.css','utf8')}</style>${html}`);
await page.addScriptTag({content:harness+"\n"+fs.readFileSync('static/modules/settings.js','utf8')+"\n"+fs.readFileSync('static/modules/video-links.js','utf8')});
const openSettings=()=>page.evaluate(()=>{
  document.querySelector('#settingsModal').showModal();
  let node=document.querySelector('#detailLinkList');
  while(node){node.classList.remove('hidden');node=node.parentElement;}
  renderDetailLinkSettings();
});
// Presets ship as ordinary, editable rows.
await openSettings();
assert.equal(await page.locator('#detailLinkList .detail-link-row').count(),4);
assert.deepEqual(await page.evaluate(()=>readDetailLinks().map(link=>link.kind)),['bgm','bilibili','saved_video','rules_menu']);
assert.deepEqual(await page.evaluate(()=>readDetailLinks().map(link=>link.name)),['Bangumi #{id}','B站搜索','已存视频','更多站点 ▾']);
// New rows can be added and edited.
await page.locator('#addDetailLink').click();
assert.equal(await page.locator('#detailLinkList .detail-link-row').count(),5);
await page.locator('#detailLinkList .detail-link-row').nth(4).locator('[data-detail-link-name]').fill('次元城');
await page.locator('#detailLinkList .detail-link-row').nth(4).locator('[data-detail-link-url]').fill('https://www.cycani.org/category?q={title}');
assert.equal((await page.evaluate(()=>readDetailLinks()))[4].name,'次元城');
// Order buttons move a row and keep the edited values.
// 新增的行在末尾（已存视频之后），上移一格只是换到它前面。
await page.locator('#detailLinkList .detail-link-row').nth(4).locator('.detail-link-order-button').first().click();
assert.deepEqual(await page.evaluate(()=>readDetailLinks().map(link=>link.name)),['Bangumi #{id}','B站搜索','已存视频','次元城','更多站点 ▾']);
await page.locator('#detailLinkList .detail-link-row').nth(1).locator('.detail-link-order-button').last().click();
assert.deepEqual(await page.evaluate(()=>readDetailLinks().map(link=>link.name)),['Bangumi #{id}','已存视频','B站搜索','次元城','更多站点 ▾']);
// 两个内置入口也能参与排序：更多站点可以挪到普通链接前面。
await page.locator('#detailLinkList .detail-link-row').nth(4).locator('.detail-link-order-button').first().click();
assert.deepEqual(await page.evaluate(()=>readDetailLinks().map(link=>link.name)),['Bangumi #{id}','已存视频','B站搜索','更多站点 ▾','次元城']);
assert.equal(await page.locator('#detailLinkList .detail-link-row').first().locator('.detail-link-order-button').first().isDisabled(),true);
// Presets can be deleted, and restoring brings them back.
await page.locator('#detailLinkList .detail-link-row').first().getByText('删除').click();
assert.deepEqual(await page.evaluate(()=>readDetailLinks().map(link=>link.name)),['已存视频','B站搜索','更多站点 ▾','次元城']);
// 两个内置入口都不能删除，按钮固定禁用。
assert.equal(await page.locator('#detailLinkList .detail-link-row').nth(0).getByText('固定').isDisabled(),true);
assert.equal(await page.locator('#detailLinkList .detail-link-row').nth(2).getByText('固定').isDisabled(),true);
await page.locator('#resetDetailLinks').click();
assert.deepEqual(await page.evaluate(()=>readDetailLinks().map(link=>link.kind)),['bgm','bilibili','saved_video','rules_menu']);
// Detail row follows the configured order and placeholders.
await page.evaluate(()=>{
  document.querySelector('#settingsModal').close();
  state.settings.detail_links=[
    {kind:'bgm',name:'Bangumi #{id}',url:'{site}/subject/{id}',enabled:true},
    {kind:'custom',name:'次元城',url:'https://www.cycani.org/category?q={title}',enabled:true},
    {kind:'bilibili',name:'B站搜索',url:'https://search.bilibili.com/all?keyword={title}',enabled:true},
    {kind:'custom',name:'关闭的',url:'https://example.com/?q=',enabled:false},
  ];
  return renderVideoLinks(1);
});
const links=page.locator('#detailLinks .detail-link');
assert.deepEqual(await links.allTextContents(),['Bangumi #1 ↗','次元城 ↗','B站搜索 ↗']);
assert.equal(await links.nth(0).getAttribute('href'),'https://bgm.tv/subject/1');
assert.equal(await links.nth(1).getAttribute('href'),'https://www.cycani.org/category?q='+encodeURIComponent('测试番剧'));
await page.evaluate(()=>{state.settings.bgm_site_base='https://bgm.example/';return renderVideoLinks(1)});
assert.equal(await page.locator('#detailLinks .detail-link').first().getAttribute('href'),'https://bgm.example/subject/1');
// Merging the B站 entry with a saved video still hides that one entry only.
await page.evaluate(()=>{
  state.settings.bgm_site_base='';
  state.settings.merge_bilibili_links=true;
  window.testItems=[{id:1,is_default:1,title:'video',url:'https://www.bilibili.com/video/BV1AgHK6jE64/'}];
  return renderVideoLinks(1);
});
assert.deepEqual(await page.locator('#detailLinks .detail-link').allTextContents(),['Bangumi #1 ↗','次元城 ↗']);
// Legacy settings migrate: old custom links join the list, old B站 toggle turns the entry off.
await page.evaluate(()=>{
  state.settings={custom_search_links:[{name:'旧链接',url:'https://old.example/?q=',enabled:true}],show_bilibili_search_button:false};
  return renderVideoLinks(1);
});
const migrated=await page.locator('#detailLinks .detail-link').allTextContents();
assert.deepEqual(migrated,['Bangumi #1 ↗','旧链接 ↗']);
// 周表卡片详情有自己的一份列表，默认同样是两个预设。
assert.deepEqual(await page.evaluate(()=>scheduleDetailLinks().map(link=>link.name)),['Bangumi #{id}','B站搜索']);
await page.evaluate(()=>{const modal=document.querySelector('#settingsModal');if(!modal.open)modal.showModal();});
await page.evaluate(()=>{
  state.settings.schedule_detail_links=undefined;
  let node=document.querySelector('#scheduleDetailLinkList');
  while(node){node.classList.remove('hidden');node=node.parentElement;}
  renderScheduleDetailLinkSettings();
});
assert.equal(await page.locator('#scheduleDetailLinkList .detail-link-row').count(),2);
await page.locator('#addScheduleDetailLink').click();
assert.equal(await page.locator('#scheduleDetailLinkList .detail-link-row').count(),3);
assert.deepEqual(await page.evaluate(()=>readScheduleDetailLinks().map(link=>link.name)),['Bangumi #{id}','B站搜索']);
await page.locator('#resetScheduleDetailLinks').click();
assert.equal(await page.locator('#scheduleDetailLinkList .detail-link-row').count(),2);
// 新增链接会同步到另一边（默认关闭），开关和删除不同步。
const sync=await page.evaluate(()=>{
  const detail=[{id:'d1',kind:'custom',name:'次元城',url:'https://a.b/?q={title}',enabled:true}];
  const schedule=[{id:'s1',kind:'custom',name:'樱花',url:'https://c.d/?q={title}',enabled:false}];
  return syncLinkAdditions(detail,schedule,[]);
});
assert.deepEqual(sync.schedule.map(link=>[link.name,link.enabled]),[['樱花',false],['次元城',false]]);
assert.deepEqual(sync.detail.map(link=>[link.name,link.enabled]),[['次元城',true],['樱花',false]]);
assert.deepEqual(sync.synced.sort(),['d1','s1']);
// 已经同步过的 id 不会因为对侧删除而反复补回。
const again=await page.evaluate(()=>{
  const detail=[{id:'d1',kind:'custom',name:'次元城',url:'https://a.b/?q={title}',enabled:true}];
  const schedule=[{id:'s1',kind:'custom',name:'樱花',url:'https://c.d/?q={title}',enabled:true}];
  return syncLinkAdditions(detail,schedule,['d1','s1']);
});
assert.equal(again.schedule.length,1);
assert.equal(again.detail.length,1);
console.log('Detail links: presets as rows, add/edit/reorder/delete/reset, detail order, {site}/{title}/{id}, merged B站 entry and legacy migration, schedule list and add-only sync passed.');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exit(1)});
