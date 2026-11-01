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
assert.equal(await page.locator('#detailLinkList .detail-link-row').count(),2);
assert.deepEqual(await page.evaluate(()=>readDetailLinks().map(link=>link.kind)),['bgm','bilibili']);
assert.deepEqual(await page.evaluate(()=>readDetailLinks().map(link=>link.name)),['Bangumi #{id}','B站搜索']);
// New rows can be added and edited.
await page.locator('#addDetailLink').click();
assert.equal(await page.locator('#detailLinkList .detail-link-row').count(),3);
await page.locator('#detailLinkList .detail-link-row').nth(2).locator('[data-detail-link-name]').fill('次元城');
await page.locator('#detailLinkList .detail-link-row').nth(2).locator('[data-detail-link-url]').fill('https://www.cycani.org/category?q={title}');
assert.equal((await page.evaluate(()=>readDetailLinks()))[2].name,'次元城');
// Order buttons move a row and keep the edited values.
await page.locator('#detailLinkList .detail-link-row').nth(2).locator('.detail-link-order-button').first().click();
assert.deepEqual(await page.evaluate(()=>readDetailLinks().map(link=>link.name)),['Bangumi #{id}','次元城','B站搜索']);
await page.locator('#detailLinkList .detail-link-row').nth(1).locator('.detail-link-order-button').last().click();
assert.deepEqual(await page.evaluate(()=>readDetailLinks().map(link=>link.name)),['Bangumi #{id}','B站搜索','次元城']);
assert.equal(await page.locator('#detailLinkList .detail-link-row').first().locator('.detail-link-order-button').first().isDisabled(),true);
// Presets can be deleted, and restoring brings them back.
await page.locator('#detailLinkList .detail-link-row').first().getByText('删除').click();
assert.deepEqual(await page.evaluate(()=>readDetailLinks().map(link=>link.name)),['B站搜索','次元城']);
await page.locator('#resetDetailLinks').click();
assert.deepEqual(await page.evaluate(()=>readDetailLinks().map(link=>link.kind)),['bgm','bilibili']);
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
console.log('Detail links: presets as rows, add/edit/reorder/delete/reset, detail order, {site}/{title}/{id}, merged B站 entry and legacy migration passed.');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exit(1)});
