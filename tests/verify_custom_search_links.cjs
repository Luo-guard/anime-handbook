const fs=require('fs'),assert=require('node:assert/strict');
const {chromium}=require('C:/Users/han/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const harness=[
  "const $=s=>document.querySelector(s);",
  "const $$=s=>[...document.querySelectorAll(s)];",
  "const state={settings:{custom_search_links:[{name:'次元城',url:'https://www.cycani.org/category?q=',enabled:true}]},progressAnime:{id:1,display_name:'测试番剧'}};",
  "const enabledSetting=key=>state.settings[key]!==false;",
  "const escapeHtml=s=>String(s);",
  "const api=async()=>({features:{},scope:'scope',items:[]});",
].join("\n");
(async()=>{const browser=await chromium.launch({headless:true});try{
const page=await browser.newPage({viewport:{width:1100,height:820}});
const html=fs.readFileSync('static/index.html','utf8').replace(/<script[\s\S]*?<\/script>/g,'').replace(/<link[^>]*>/g,'');
await page.setContent(`<style>${fs.readFileSync('static/styles.css','utf8')}</style>${html}`);
await page.addScriptTag({content:harness+"\n"+fs.readFileSync('static/modules/settings.js','utf8')+"\n"+fs.readFileSync('static/modules/video-links.js','utf8')});
// Settings rows are rendered from the saved links and can be edited.
await page.evaluate(()=>{
  document.querySelector('#settingsModal').showModal();
  let node=document.querySelector('#customSearchLinkList');
  while(node){node.classList.remove('hidden');node=node.parentElement;}
  renderCustomSearchLinkSettings();
});
assert.equal(await page.locator('#customSearchLinkList .custom-search-link-row').count(),1);
assert.equal(await page.locator('[data-custom-link-name]').inputValue(),'次元城');
assert.equal(await page.locator('[data-custom-link-url]').inputValue(),'https://www.cycani.org/category?q=');
assert.deepEqual(await page.evaluate(()=>readCustomSearchLinks()),[{name:'次元城',url:'https://www.cycani.org/category?q=',enabled:true}]);
// Editing the row is what gets saved.
await page.locator('[data-custom-link-name]').fill('次元城动漫');
await page.locator('[data-custom-link-url]').fill('https://www.cycani.org/category?q={title}');
assert.deepEqual(await page.evaluate(()=>readCustomSearchLinks()),[{name:'次元城动漫',url:'https://www.cycani.org/category?q={title}',enabled:true}]);
// A row without a name or url is not saved.
await page.locator('[data-custom-link-name]').fill('');
assert.deepEqual(await page.evaluate(()=>readCustomSearchLinks()),[]);
// The detail page shows the link after the B站 search entry.
await page.evaluate(()=>{state.settings.custom_search_links=[{name:'次元城',url:'https://www.cycani.org/category?q=',enabled:true}];return renderVideoLinks(1)});
const link=page.locator('#customSearchLinks .custom-search-link');
assert.equal(await link.count(),1);
assert.equal(await link.textContent(),'次元城 ↗');
assert.equal(await link.getAttribute('href'),'https://www.cycani.org/category?q='+encodeURIComponent('测试番剧'));
assert.equal(await link.getAttribute('target'),'_blank');
// {title} marks where the anime title goes.
await page.evaluate(()=>{state.settings.custom_search_links=[{name:'占位',url:'https://example.com/s/{title}/x',enabled:true}];return renderVideoLinks(1)});
assert.equal(await page.locator('#customSearchLinks .custom-search-link').getAttribute('href'),'https://example.com/s/'+encodeURIComponent('测试番剧')+'/x');
// Each link can be switched off on its own.
await page.evaluate(()=>{state.settings.custom_search_links=[{name:'次元城',url:'https://www.cycani.org/category?q=',enabled:false}];return renderVideoLinks(1)});
assert.equal(await page.locator('#customSearchLinks .custom-search-link').count(),0);
console.log('Custom search links: settings rows, save payload, detail entry with title placeholder and per-link switch passed.');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exit(1)});
