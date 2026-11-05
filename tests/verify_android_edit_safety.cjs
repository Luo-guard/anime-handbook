const fs=require('node:fs'),assert=require('node:assert/strict');
const {chromium}=require('C:/Users/han/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
(async()=>{const browser=await chromium.launch({headless:true});try{
 const page=await browser.newPage();
 await page.setContent('<button id="sync"></button><main id="app"></main><nav></nav>');
 await page.evaluate(()=>{
  window.messages=[];window.alert=text=>messages.push(text);
  window.saved={tables:{anime:[{id:1,name_cn:'测试番',collection_type:1,active:1,watched_episodes:'["01","02","03"]',episode_count:3}],events:[{id:1,event_type:'watch',anime_id:1,episodes:'["01","02","03"]',content:'原记录',created_at:'2026-11-04T12:00:00+08:00'}],settings:[]}};
  window.failSave=false;
  window.AndroidHandbook={state:()=>JSON.stringify(saved),saveState:raw=>{if(failSave)return false;saved=JSON.parse(raw);return true},config:()=>JSON.stringify({}),saveConfig:()=>{}};
 });
 await page.addScriptTag({content:fs.readFileSync('android/app/src/main/assets/app.js','utf8')});
 const edited=await page.evaluate(()=>{openAnime(1);toggleEpisode(1,'02');return saved.tables});
 assert.equal(edited.anime[0].watched_episodes,'["01","03"]');
 assert.equal(edited.events[0].episodes,'["01","03"]');assert.equal(edited.events[0].content,'原记录');
 await page.evaluate(()=>{showPage('records');noteForm();document.querySelector('#content').value='未保存草稿';HandbookMobile.completeSync(JSON.stringify({action:'unchanged'}),true)});
 assert.equal(await page.locator('#content').inputValue(),'未保存草稿');
 await page.evaluate(()=>{saved.tables.anime[0].name_cn='同步后的标题';HandbookMobile.completeSync(JSON.stringify({state:saved}),true)});
 assert.equal(await page.locator('#content').inputValue(),'未保存草稿');
 await page.evaluate(()=>{failSave=true;addNote()});
 assert.equal(await page.locator('#content').inputValue(),'未保存草稿');
 assert.equal(await page.evaluate(()=>saved.tables.events.length),1);
 assert((await page.evaluate(()=>messages.at(-1))).includes('尚未保存'));
 await page.evaluate(()=>{failSave=false;addNote();settings();document.querySelector('#username').value='未保存配置';HandbookMobile.completeSync(JSON.stringify({state:saved}),true)});
 assert.equal(await page.locator('#username').inputValue(),'未保存配置');
 // An older completion payload must never replace a newer successfully saved edit.
 await page.evaluate(()=>{showPage('home');const stale=JSON.parse(JSON.stringify(saved));saved.tables.anime[0].name_cn='同步期间的新修改';HandbookMobile.completeSync(JSON.stringify({state:stale}),true)});
 assert((await page.locator('.anime').textContent()).includes('同步期间的新修改'));
 await page.evaluate(()=>{openAnime(1);failSave=true;toggleEpisode(1,'03')});
 assert.equal(await page.evaluate(()=>tables().anime[0].watched_episodes),'["01","03"]');
 console.log('Android edit safety passed: partial unwatch, unchanged/download sync preserves drafts and settings, failed saves retain draft/rollback progress, stale completion cannot replace newer state');
}finally{await browser.close()}})().catch(e=>{console.error(e);process.exitCode=1});
