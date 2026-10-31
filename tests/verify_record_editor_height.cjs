const fs=require('fs'),assert=require('node:assert/strict');
const {chromium}=require('C:/Users/han/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
(async()=>{const browser=await chromium.launch({headless:true});try{
 const page=await browser.newPage({viewport:{width:1000,height:1000}});
 await page.setContent(`<style>${fs.readFileSync('static/styles.css','utf8')}</style><form class="inline-event-editor" style="width:600px"><textarea rows="3"></textarea></form>`);
 const source=fs.readFileSync('static/modules/records.js','utf8');
 await page.addScriptTag({content:"const $$=s=>Array.from(document.querySelectorAll(s));"+source.slice(0,source.indexOf("function ",source.indexOf("window.addEventListener")))});
 const measure=async text=>page.evaluate(text=>{const input=document.querySelector('textarea');input.value=text;fitRecordEditor(input);return {height:input.getBoundingClientRect().height,scroll:input.scrollHeight,client:input.clientHeight,overflow:input.style.overflowY};},text);
 const short=await measure('短文字');const medium=await measure(Array(12).fill('一行记录').join('\n'));assert(medium.height>short.height);assert(medium.scroll<=medium.client+1);
 const long=await measure(Array(100).fill('长记录内容').join('\n'));assert(long.height<=801);assert(long.height>=799);assert.equal(long.overflow,'auto');
 const reduced=await measure('删到一行');assert(reduced.height<long.height);assert.equal(reduced.overflow,'hidden');
 await measure(Array(100).fill('记录').join('\n'));await page.setViewportSize({width:600,height:500});await page.waitForTimeout(100);assert(await page.locator('textarea').evaluate(el=>el.getBoundingClientRect().height)<=401);
 console.log('Record editor: short/medium fit, long capped at 80% viewport, shrink and viewport resize passed.');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exit(1)});
