const fs=require('fs'),assert=require('node:assert/strict');
const {chromium}=require('C:/Users/han/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const harness=[
  "const $=s=>document.querySelector(s);",
  "const $$=s=>[...document.querySelectorAll(s)];",
  "const state={animes:[],settings:{}};",
  "const CATEGORIES=[{id:1,name:'在看'},{id:2,name:'想看'},{id:3,name:'搁置'}];",
  "const escapeHtml=s=>String(s);",
  "function renderCollection(){}",
  "function renderTabs(){}",
  "function renderStats(){}",
  "function toast(){}",
  "window.requests=[];",
  "window.queries=[];",
  "async function api(path,options){",
  "  if(options){const body=JSON.parse(options.body);requests.push(body);return {animes:[],anime:{id:body.anime_id,collection_type:body.status}};}",
  "  const q=decodeURIComponent((/[?&]q=([^&]*)/.exec(path)||[])[1]||'');queries.push(q);",
  "  return {items:[{id:q==='葬送的芙莉莲'?100:200,name:'原名',name_cn:q,type:2,date:'2023-10-01',eps:12,rating:{score:8.1,total:900},images:{}}]};",
  "}"
].join("\n");
(async()=>{const browser=await chromium.launch({headless:true});try{
const page=await browser.newPage({viewport:{width:1100,height:820}});
await page.setContent(fs.readFileSync('static/index.html','utf8').replace(/<script[\s\S]*?<\/script>/g,'').replace(/<link[^>]*>/g,''));
await page.addScriptTag({content:harness+"\n"+fs.readFileSync('static/modules/collection-edit.js','utf8')+"\n"+fs.readFileSync('static/modules/collection-import.js','utf8')});
// Parsers: plain lines, CSV with header, Excel-style tab paste, JSON objects.
assert.deepEqual(await page.evaluate(()=>parseImportText('葬送的芙莉莲\n药屋少女的呢喃\n\n葬送的芙莉莲')),['葬送的芙莉莲','药屋少女的呢喃']);
assert.deepEqual(await page.evaluate(()=>parseImportText('番剧,状态\n葬送的芙莉莲,看过\n药屋少女的呢喃,在看')),['葬送的芙莉莲','药屋少女的呢喃']);
assert.deepEqual(await page.evaluate(()=>parseImportText('葬送的芙莉莲\t1\n药屋少女的呢喃\t2')),['葬送的芙莉莲','药屋少女的呢喃']);
assert.deepEqual(await page.evaluate(()=>parseImportText('[{"name":"葬送的芙莉莲"},{"title":"药屋少女的呢喃"},"进击的巨人"]')),['葬送的芙莉莲','药屋少女的呢喃','进击的巨人']);
// Large lists are capped at 2000 entries instead of the old 300.
const capped=await page.evaluate(()=>{const lines=Array.from({length:2500},(_,i)=>'番剧'+i).join('\n');return parseImportText(lines).length;});
assert.equal(capped,2000);
// Flow
await page.locator('#collectionImportButton').click({force:true});
// A picked file lands in the textarea, so the user can still edit it before importing.
await page.locator('#importFile').setInputFiles({name:'list.csv',mimeType:'text/csv',buffer:Buffer.from('番剧,状态\n葬送的芙莉莲,看过','utf8')});
await page.waitForFunction(()=>document.querySelector('#importPaste').value.includes('葬送的芙莉莲'));
assert.match(await page.locator('#importStatus').textContent(),/list\.csv/);
await page.locator('#importPaste').fill('葬送的芙莉莲\n药屋少女的呢喃');
await page.locator('#importParse').click();
const work=page.locator('#importWork');
assert.equal(await work.evaluate(node=>node.classList.contains('hidden')),false);
assert.equal(await page.locator('#importCount').textContent(),'1 / 2');
assert.equal(await page.locator('#importName').inputValue(),'葬送的芙莉莲');
await page.waitForSelector('#importResults .collect-result-title');
assert.equal(await page.locator('#importResults .collect-result-title').textContent(),'葬送的芙莉莲');
// 下一条 / 上一条 switch the entry and re-search
await page.locator('#importNext').click();
await page.waitForFunction(()=>document.querySelector('#importName').value==='药屋少女的呢喃');
assert.equal(await page.locator('#importCount').textContent(),'2 / 2');
assert.equal(await page.locator('#importNext').isDisabled(),true);
await page.locator('#importPrev').click();
await page.waitForFunction(()=>document.querySelector('#importName').value==='葬送的芙莉莲');
assert.equal(await page.locator('#importPrev').isDisabled(),true);
// Adding through the card advances to the next entry automatically
await page.locator('#importResults [data-collect-trigger]').first().click();
await page.locator('.collect-menu [data-collect-value="1"]').click();
await page.waitForFunction(()=>document.querySelector('#importName').value==='药屋少女的呢喃');
assert.deepEqual(await page.evaluate(()=>requests),[{anime_id:100,status:1}]);
assert.match(await page.locator('#importProgress').textContent(),/已添加 1 条/);
// Skip marks the entry
await page.locator('#importSkip').click();
assert.match(await page.locator('#importProgress').textContent(),/已跳过 1 条/);
assert.match(await page.locator('#importProgress').textContent(),/全部处理完成/);
// Cached results are not re-fetched when going back
const before=await page.evaluate(()=>queries.length);
await page.locator('#importPrev').click();
await page.waitForTimeout(200);
assert.equal(await page.evaluate(()=>queries.length),before,'cached entry must not search again');
console.log('Batch import: list parsing (txt/csv/tsv/json) and the 2000-entry cap, entry switching, auto-advance after adding, skip and cache passed.');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exit(1)});
