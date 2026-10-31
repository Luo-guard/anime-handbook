const fs=require('fs'),assert=require('node:assert/strict');
const {chromium}=require('C:/Users/han/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const harness=[
  "const $=s=>document.querySelector(s);",
  // Mirrors the user's saved bindings: forward side key = previous page, back side key = next page.
  "const state={settings:{keyboard_shortcuts:{bindings:{previous:{enabled:true,key:'MouseForward'},next:{enabled:true,key:'MouseBack'}}}},activeView:'collection'};",
  "const pageLabel=id=>id;",
  "const ORDER=['collection','schedule','timeline','statistics','ranking','settings'];",
  "const sidebarOrder=()=>ORDER;",
  "const sidebarVisibility=()=>({});",
  "window.hits=[];",
  "document.querySelectorAll('[data-nav-id]').forEach(button=>button.onclick=()=>{hits.push(button.dataset.navId);state.activeView=button.dataset.navId;if(button.dataset.navId==='settings')document.querySelector('#settingsModal').showModal();});"
].join("\n");
(async()=>{const b=await chromium.launch({headless:true});try{
const p=await b.newPage();
let html=fs.readFileSync('static/index.html','utf8').replace(/<script[\s\S]*?<\/script>/g,'').replace(/<link[^>]*>/g,'');
await p.route('http://shortcut.test/**',r=>r.fulfill({contentType:'text/html',body:html}));
await p.goto('http://shortcut.test/one');await p.goto('http://shortcut.test/two');
await p.addScriptTag({content:harness+"\n"+fs.readFileSync('static/modules/keyboard.js','utf8')});
const cdp=await p.context().newCDPSession(p);
const side=async(button,modifier=0)=>{await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',x:20,y:20,button,buttons:button==='back'?8:16,clickCount:1,modifiers:modifier});await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:20,y:20,button,buttons:0,clickCount:1,modifiers:modifier});};
// First page: previous must stay put and must not reach the browser history.
await side('forward');
assert.deepEqual(await p.evaluate(()=>hits),[],'previous on the first page must not wrap');
assert(p.url().endsWith('/two'),'browser must not navigate back when the side button is bound');
// Next keeps moving forward through the sidebar order.
await side('back');assert.deepEqual(await p.evaluate(()=>hits),['schedule']);
assert(p.url().endsWith('/two'));
// Settings is a dialog but also the last sidebar entry.
await p.evaluate(()=>document.querySelector('[data-nav-id="settings"]').click());
assert.equal(await p.evaluate(()=>document.querySelector('#settingsModal').open),true);
await side('back');
assert.deepEqual(await p.evaluate(()=>hits),['schedule','settings'],'next on the last page must not wrap');
assert.equal(await p.evaluate(()=>document.querySelector('#settingsModal').open),true,'the dialog must stay open');
assert(p.url().endsWith('/two'),'browser must not navigate back while the settings dialog is open');
// Previous from settings leaves the dialog and moves to the page before it.
await side('forward');
assert.deepEqual(await p.evaluate(()=>hits),['schedule','settings','ranking']);
assert.equal(await p.evaluate(()=>document.querySelector('#settingsModal').open),false,'navigating away closes the settings dialog');
assert(p.url().endsWith('/two'));
// Editing targets and the recording row keep working.
await p.evaluate(()=>{state.settings.keyboard_shortcuts.bindings.previous.key='Alt+MouseBack';document.querySelector('#searchInput').focus();});
await side('forward');assert.equal((await p.evaluate(()=>hits)).length,3);
await p.evaluate(()=>{renderKeyboardSettings();const modal=document.querySelector('#settingsModal');modal.showModal();const node=document.querySelector('[data-shortcut-action="previous"] input');node.focus();});
await side('back',1);
assert.equal(await p.locator('[data-shortcut-action="previous"] [data-collect-key], [data-shortcut-action="previous"] [data-shortcut-key]').first().getAttribute('data-key'),'Alt+MouseBack');
assert(p.url().endsWith('/two'));
console.log('Mouse side buttons: boundary pages hold still, bound buttons never trigger browser history, settings dialog navigation and recording passed.');
}finally{await b.close();}})().catch(e=>{console.error(e);process.exit(1)});
