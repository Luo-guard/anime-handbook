const fs=require('fs'),assert=require('node:assert/strict');
const {chromium}=require('C:/Users/han/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
(async()=>{const browser=await chromium.launch({headless:true});try{
const page=await browser.newPage({viewport:{width:1100,height:820}});await page.setContent(fs.readFileSync('static/index.html','utf8').replace(/<script[\s\S]*?<\/script>/g,'').replace(/<link[^>]*>/g,''));
await page.addScriptTag({content:`const $=s=>document.querySelector(s);const $$=s=>[...document.querySelectorAll(s)];const state={animes:[]};const CATEGORIES=[{id:1,name:'在看'},{id:2,name:'想看'}];const escapeHtml=s=>String(s);function renderCollection(){}function renderTabs(){}function renderStats(){}function toast(){};window.requests=[];async function api(path,options){if(options){const body=JSON.parse(options.body);requests.push(body);return {animes:[{id:123,collection_type:body.status}],anime:{id:123,collection_type:body.status}};}return {items:[{id:123,name:'Original',name_cn:'测试番剧',date:'2023-09-29',eps:28,rating:{score:8.4,total:12345},images:{common:'https://api.bgm.tv/x.jpg'}}]};}`+fs.readFileSync('static/modules/collection-edit.js','utf8')});
await page.locator('#collectionSearchButton').click({force:true});
await page.locator('#collectionSearchQuery').fill('测试');
await page.locator('#collectionSearchSubmit').click();
const result=page.locator('.collect-result[data-result-id="123"]');
await result.getByText('测试番剧',{exact:true}).waitFor();
assert.equal(await result.locator('.collect-result-score').textContent(),'8.4');
assert.match(await result.locator('.collect-result-sub').textContent(),/Original · 2023-09-29/);
const trigger=result.locator('[data-collect-trigger]');
assert.equal(await trigger.locator('.collect-name').textContent(),'想看');
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
assert.equal(await menu.locator('.is-current .collect-check').isVisible(),true);
await page.keyboard.press('Escape');
assert.equal(await menu.isVisible(),false);
assert.equal(await page.locator('#collectionSearchModal').evaluate(node=>node.open),true,'escape must close only the menu');
await trigger.click();
await menu.locator('[data-collect-value="1"]').click();
await page.waitForFunction(()=>document.querySelector('[data-collect-id="123"] .collect-name')?.textContent==='在看');
assert.deepEqual(await page.evaluate(()=>requests),[{anime_id:123,status:1}]);
assert.equal(await result.locator('.collect-result-state').textContent(),'已收藏');
console.log('Collection search dialog: cover/rating rows, Kazumi-style status popover, escape guard and status save passed.');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exit(1)});
