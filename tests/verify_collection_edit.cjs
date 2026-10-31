const fs=require('fs'),assert=require('node:assert/strict');
const {chromium}=require('C:/Users/han/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const harness=[
  "const $=s=>document.querySelector(s);",
  "const $$=s=>[...document.querySelectorAll(s)];",
  "const state={animes:[]};",
  "const CATEGORIES=[{id:1,name:'在看'},{id:2,name:'想看'}];",
  "const escapeHtml=s=>String(s);",
  "function renderCollection(){}",
  "function renderTabs(){}",
  "function renderStats(){}",
  "function toast(){}",
  "window.requests=[];",
  "async function api(path,options){",
  "  if(options){const body=JSON.parse(options.body);requests.push(body);return {animes:[{id:123,collection_type:body.status}],anime:{id:123,collection_type:body.status}};}",
  "  const sortMatch=/[?&]sort=([^&]*)/.exec(path);",
  "  const sort=sortMatch?decodeURIComponent(sortMatch[1]):'match';",
  "  return {sort,items:[",
  "    {id:123,name:'Original',name_cn:'测试番剧',date:'2023-09-29',eps:28,rating:{score:8.4,total:12345},images:{common:'https://api.bgm.tv/x.jpg'}},",
  "    {id:456,name:'テスト2',name_cn:'测试番剧 第二季',date:'2024-01-05',eps:12,rating:{score:7.9,total:3210}},",
  "    {id:789,name:'少女革命ウテナ',name_cn:'少女革命',date:'1997-04-02',eps:39,rating:{score:8.8,total:6000}}",
  "  ]};",
  "}"
].join("\n");
(async()=>{const browser=await chromium.launch({headless:true});try{
const page=await browser.newPage({viewport:{width:1100,height:820}});
await page.setContent(fs.readFileSync('static/index.html','utf8').replace(/<script[\s\S]*?<\/script>/g,'').replace(/<link[^>]*>/g,''));
await page.addScriptTag({content:harness+"\n"+fs.readFileSync('static/modules/collection-edit.js','utf8')});
await page.locator('#collectionSearchButton').click({force:true});
await page.locator('#collectionSearchQuery').fill('测试');
await page.locator('#collectionSearchSubmit').click();
const result=page.locator('.collect-result[data-result-id="123"]');
await result.getByText('测试番剧',{exact:true}).waitFor();
// Sorting: default is match, and the other modes re-order the returned page locally.
const titles=()=>page.locator('.collect-result[data-result-id]:visible .collect-result-title').allTextContents();
assert.equal(await page.locator('#collectionSearchSort').inputValue(),'match');
assert.deepEqual(await titles(),['测试番剧','测试番剧 第二季']);
await page.selectOption('#collectionSearchSort','time');
await page.waitForTimeout(250);
assert.deepEqual(await titles(),['测试番剧 第二季','测试番剧'],'放送时间按日期倒序');
await page.selectOption('#collectionSearchSort','score');
await page.waitForTimeout(250);
assert.deepEqual(await titles(),['测试番剧','测试番剧 第二季'],'评分按分数倒序');
await page.selectOption('#collectionSearchSort','match');
await page.waitForTimeout(250);
assert.deepEqual(await titles(),['测试番剧','测试番剧 第二季']);
assert.equal(await result.locator('.collect-result-score').textContent(),'8.4');
assert.match(await result.locator('.collect-result-sub').textContent(),/Original · 2023-09-29/);
// Token-only matches stay collapsed: only the title hits are listed first.
assert.equal(await page.locator('.collect-result[data-result-id]:visible').count(),2);
const more=page.locator('.collect-more-toggle');
assert.match(await more.textContent(),/显示其他 1 条相关结果/);
const moreList=page.locator('.collect-more-list');
assert.equal(await moreList.evaluate(node=>node.hidden),true);
await more.click();
assert.equal(await page.locator('.collect-result[data-result-id]:visible').count(),3);
assert.equal(await moreList.evaluate(node=>node.hidden),false);
assert.equal(await more.getAttribute('aria-expanded'),'true');
assert.match(await more.textContent(),/收起其他 1 条相关结果/);
await more.click();
assert.equal(await page.locator('.collect-result[data-result-id]:visible').count(),2);
const trigger=result.locator('[data-collect-trigger]');
assert.equal(await trigger.locator('.collect-name').textContent(),'未收藏');
assert.equal(await trigger.evaluate(node=>node.classList.contains('is-empty')),true);
assert.equal(await page.locator('.collect-control[data-collect-id="123"]').getAttribute('data-status'),'0');
assert.equal(await result.locator('[data-collect-value].is-current').count(),0,'an uncollected entry must not look like an existing status');
await trigger.click();
const menu=page.locator('.collect-menu');
assert.equal(await menu.isVisible(),true);
assert.equal(await trigger.getAttribute('aria-expanded'),'true');
// The popover is kept out of the scrolling result list so it cannot be clipped,
// while staying inside the open dialog so modal inertness cannot block clicks.
assert.equal(await menu.evaluate(node=>node.closest('dialog[open]')!==null),true);
assert.equal(await menu.evaluate(node=>node.closest('#collectionSearchResults')===null),true);
assert.equal(await menu.getAttribute('role'),'menu');
assert.equal(await menu.locator('.collect-option').count(),2);
assert.equal(await menu.locator('.is-current').count(),0);
await page.keyboard.press('Escape');
assert.equal(await menu.isVisible(),false);
assert.equal(await page.locator('#collectionSearchModal').evaluate(node=>node.open),true,'escape must close only the menu');
await trigger.click();
await menu.locator('[data-collect-value="1"]').click();
await page.waitForFunction(()=>document.querySelector('[data-collect-id="123"] .collect-name')?.textContent==='在看');
assert.deepEqual(await page.evaluate(()=>requests),[{anime_id:123,status:1}]);
assert.equal(await result.locator('.collect-result-state').textContent(),'已收藏');
assert.equal(await trigger.evaluate(node=>node.classList.contains('is-empty')),false,'collecting clears the empty state');
await page.evaluate(()=>{state.settings={kazumi_read_only:true};applyCollectionEditingAvailability();});
assert.equal(await page.locator('#collectionSearchButton').evaluate(node=>node.classList.contains('hidden')),true,'read-only hides the search entry');
assert.equal(await page.evaluate(()=>collectionAction(1,2).children.length),0,'read-only renders no status control');
assert.equal(await page.evaluate(()=>collectionEditingSupported()),false);
await page.evaluate(()=>{state.settings={kazumi_read_only:false};applyCollectionEditingAvailability();});
assert.equal(await page.locator('#collectionSearchButton').evaluate(node=>node.classList.contains('hidden')),false,'turning read-only off restores the entry');
console.log('Collection search dialog: cover/rating rows, exact-title grouping, Kazumi-style status popover, escape guard, status save, uncollected state, sorting and read-only gating passed.');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exit(1)});
