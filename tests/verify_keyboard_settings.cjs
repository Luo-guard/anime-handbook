const fs=require('fs'),assert=require('node:assert/strict');const {chromium}=require('C:/Users/han/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
(async()=>{const b=await chromium.launch({headless:true});try{const p=await b.newPage();const html=fs.readFileSync('static/index.html','utf8').replace(/<script[\s\S]*?<\/script>/g,'').replace(/<link[^>]*>/g,'');await p.setContent(`<style>${fs.readFileSync('static/styles.css','utf8')}</style>${html}`);await p.addScriptTag({content:`const $=s=>document.querySelector(s);const state={settings:{},activeView:'collection'};const pageLabel=id=>id;const sidebarOrder=()=>['ranking','timeline','collection','settings','schedule','statistics'];const sidebarVisibility=()=>({schedule:false});const pageVisible=id=>sidebarVisibility()[id]!==false;let shutdowns=0;function shutdownHandbookBackend(){shutdowns++};function setSidebarCollapsed(v){$('.app-shell').classList.toggle('sidebar-collapsed',v)};window.hits=[];document.querySelectorAll('.nav-item').forEach(b=>b.onclick=()=>{hits.push(b.dataset.navId);if(b.dataset.navId!=='settings')state.activeView=b.dataset.navId;});`+fs.readFileSync('static/modules/keyboard.js','utf8')});await p.evaluate(()=>renderKeyboardSettings());await p.locator('[data-settings-section="keyboard"]').evaluate(el=>{let current=el;while(current){current.classList.remove('hidden');current=current.parentElement;}document.querySelector('#settingsModal').showModal()});
const row=p.locator('[data-shortcut-action="collection"]');
const capture=async key=>{await row.locator('[data-shortcut-add]').click();await row.locator('[data-shortcut-key]').press(key);};
// One action can hold several shortcuts; recording appends chips.
await capture('Control+Alt+k');
assert.equal(await row.locator('[data-key-chip]').nth(1).getAttribute('data-key'),'Ctrl+Alt+k');
assert.equal(await row.locator('[data-key-chip]').count(),2);
assert.equal(await p.evaluate(()=>readKeyboardSettings().bindings.collection.keys.join('|')),'1|Ctrl+Alt+k');
// Duplicate against another enabled action is rejected.
await capture('2');
assert((await p.locator('#keyboardStatus').textContent()).includes('重复'));
assert.equal(await row.locator('[data-key-chip]').count(),2,'duplicate must be rejected');
// A second binding on the same action is fine.
await capture('Control+Alt+j');
assert.equal(await row.locator('[data-key-chip]').count(),3);
assert.equal(await p.evaluate(()=>readKeyboardSettings().bindings.collection.keys.length),3);
// Chips are removable.
await row.locator('[data-key-chip]').first().locator('[data-shortcut-remove]').click();
assert.equal(await row.locator('[data-key-chip]').count(),2);
assert.equal(await row.locator('[data-key-chip]').first().getAttribute('data-key'),'Ctrl+Alt+k');
await p.locator('[data-shortcut-action="schedule"] .switch').click();
assert.equal(await p.locator('#keyboardStatus').textContent(),'');
await p.locator('#resetKeyboardBindings').click();
assert.equal(await row.locator('[data-key-chip]').first().getAttribute('data-key'),'1');
await p.evaluate(()=>{document.querySelector('#settingsModal').close();document.activeElement.blur();});await p.locator('[data-nav-id="collection"]').focus();await p.keyboard.press('ArrowDown');assert.equal((await p.evaluate(()=>hits)).at(-1),'settings');await p.keyboard.press('ArrowUp');assert.equal((await p.evaluate(()=>hits)).at(-1),'timeline');
await p.keyboard.press('b');assert.equal(await p.locator('.app-shell').evaluate(e=>e.classList.contains('sidebar-collapsed')),true);
await p.evaluate(()=>{state.settings.keyboard_shortcuts={enabled:false}});const n=(await p.evaluate(()=>hits)).length;await p.keyboard.press('1');assert.equal((await p.evaluate(()=>hits)).length,n);
await p.evaluate(()=>{state.settings.keyboard_shortcuts={bindings:{collection:{enabled:false,key:'1'},shutdown:{enabled:true,key:'Ctrl+Shift+q'},ranking:{enabled:true,key:'Alt+k'}}}});await p.keyboard.press('1');assert.equal((await p.evaluate(()=>hits)).length,n);await p.keyboard.press('Alt+k');assert.equal((await p.evaluate(()=>hits)).at(-1),'ranking');await p.keyboard.press('Control+Shift+q');assert.equal(await p.evaluate(()=>shutdowns),1);await p.evaluate(()=>window.handbookOnline={});await p.keyboard.press('Control+Shift+q');assert.equal(await p.evaluate(()=>shutdowns),1);console.log('Shortcut settings: multi-key chips, recording, conflicts, per-action/master toggle, reset, custom order, sidebar and desktop-only shutdown passed.');}finally{await b.close()}})().catch(e=>{console.error(e);process.exit(1)});
