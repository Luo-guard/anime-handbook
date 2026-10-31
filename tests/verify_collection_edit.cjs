const fs=require('fs'),assert=require('node:assert/strict');
const {chromium}=require('C:/Users/han/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
(async()=>{const browser=await chromium.launch({headless:true});try{
const page=await browser.newPage();await page.setContent(fs.readFileSync('static/index.html','utf8').replace(/<script[\s\S]*?<\/script>/g,'').replace(/<link[^>]*>/g,''));
await page.addScriptTag({content:`const $=s=>document.querySelector(s);const state={animes:[]};const CATEGORIES=[{id:1,name:'在看'},{id:2,name:'想看'}];const escapeHtml=s=>String(s);function renderCollection(){}function renderTabs(){}function toast(){};window.requests=[];async function api(path,options){if(options){requests.push(JSON.parse(options.body));return {animes:[]};}return {items:[{id:123,name:'Original',name_cn:'测试番剧'}]};}`+fs.readFileSync('static/modules/collection-edit.js','utf8')});
await page.locator('#collectionSearchButton').click({force:true});await page.locator('#collectionSearchQuery').fill('测试');await page.locator('#collectionSearchForm button').click();await page.getByText('测试番剧',{exact:true}).waitFor();await page.locator('.collection-edit-actions select').selectOption('1');await page.getByRole('button',{name:'保存收藏状态'}).click();assert.deepEqual(await page.evaluate(()=>requests),[{anime_id:123,status:1}]);
console.log('Collection search, result selection and status save browser flow passed.');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exit(1)});
