const fs=require('fs'),path=require('path'),os=require('os'),assert=require('node:assert/strict');
const {chromium}=require('C:/Users/han/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
(async()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'handbook-extension-'));let context;let writes=[];
try{
 const extension=path.resolve('browser-extension');context=await chromium.launchPersistentContext(dir,{channel:'chromium',headless:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
 const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
 let html=fs.readFileSync('static/index.html','utf8').replace(/<script[\s\S]*?<\/script>/g,'').replace(/<link[^>]*>/g,'');
 html+=`<script>const $=s=>document.querySelector(s);const state={progressAnime:null};window.messages=[];function toast(m){messages.push(m)};function openProgress(id){window.openedAnime=id};const api=async(path,options={})=>{const r=await fetch(path,{...options,headers:{'Content-Type':'application/json'}});const d=await r.json();if(!r.ok)throw Error(d.message);return d};</script><script>${fs.readFileSync('static/modules/video-links.js','utf8')}</script><script>openVideoCaptureFromLocation();</script>`;
 await context.route('http://127.0.0.1:43127/**',route=>{
  if(new URL(route.request().url()).pathname==='/api/video-links'){
   if(route.request().method()==='POST'){const body=route.request().postDataJSON();writes.push(body);return route.fulfill({json:{ok:true,items:[]}});}
   return route.fulfill({json:{features:{optional_video_default:1},scope:'test-scope',animes:[{id:123,name:'测试番剧'},{id:456,name:'另一部番剧'}],items:[]}});
  }
  return route.fulfill({contentType:'text/html',body:html});
 });
 await context.route('https://www.bilibili.com/**',route=>route.fulfill({contentType:'text/html',body:'<h1>测试视频</h1>'}));
 const video=await context.newPage();await video.goto('https://www.bilibili.com/video/BV1NJHG6eE9z/?p=2');
 const [tab]=await worker.evaluate(()=>chrome.tabs.query({active:true,currentWindow:true}));
 await worker.evaluate(async id=>{
  await chrome.storage.session.set({[String(id)]:{animeId:123}});
  // Only video extraction substitutes the toolbar activeTab grant; transport is actual navigation.
  chrome.scripting.executeScript=async()=>[{result:{url:'https://www.bilibili.com/video/BV1NJHG6eE9z/?p=2&spm_id=tracking',title:'<img src=x onerror=alert(1)>',uploader:'测试UP'}}];
 },tab.id);
 const next=context.waitForEvent('page');await worker.evaluate(tab=>saveVideoFromTab(tab),{id:tab.id,url:video.url()});const capture=await next;await capture.waitForLoadState();
 await capture.locator('#videoCaptureModal').waitFor({state:'visible'});await capture.waitForFunction(()=>!document.querySelector('#videoCaptureSave').disabled);
 assert.equal(await capture.locator('#videoCaptureAnime').inputValue(),'123');assert.equal(await capture.locator('#videoCaptureTitle img').count(),0);assert.equal(writes.length,0,'navigation must not save');assert.equal(new URL(capture.url()).hash,'');
 await capture.locator('#videoCaptureCancel').click();await capture.locator('#videoCaptureModal').waitFor({state:'hidden'});
 await capture.evaluate(()=>{window.reuseMarker='existing-state';state.progressAnime={id:456};document.querySelector('#progressModal').showModal();document.querySelector('#videoCaptureNote').value='old note';});
 const pageCount=context.pages().length;
 await worker.evaluate(tab=>saveVideoFromTab(tab),{id:tab.id,url:video.url()});
 await capture.locator('#videoCaptureModal').waitFor({state:'visible'});await capture.waitForFunction(()=>!document.querySelector('#videoCaptureSave').disabled);
 assert.equal(context.pages().length,pageCount,'reuse must not create another tab');
 assert.equal(await capture.evaluate(()=>window.reuseMarker),'existing-state','reuse must not reload the existing page');
 assert.equal(await capture.locator('#videoCaptureNote').inputValue(),'','new request must reset the previous note');
 assert.equal(writes.length,0,'cancel and reuse must not write automatically');
 assert.equal(await capture.locator('#videoCaptureAnime').inputValue(),'456','open detail must take priority over source association');
 assert.equal(await capture.locator('#videoCaptureSearch').inputValue(),'另一部番剧');
 await capture.locator('#videoCaptureSearch').click();assert.equal(await capture.getByRole('listbox').isVisible(),true);
 await capture.locator('#videoCaptureSearch').fill('没有这个名字');assert.equal(await capture.getByRole('option').count(),0);assert.equal(await capture.locator('#videoCaptureAnime').inputValue(),'');
 await capture.locator('#videoCaptureSearch').fill('');await capture.locator('#videoCaptureSearch').press('ArrowUp');await capture.locator('#videoCaptureSearch').press('Enter');assert.equal(await capture.locator('#videoCaptureAnime').inputValue(),'456');
 await capture.locator('#videoCaptureSearch').click();await capture.locator('#videoCaptureTitle').click();assert.equal(await capture.getByRole('listbox').isVisible(),false);
 await capture.locator('#videoCaptureSearch').fill('另一');await capture.getByRole('option',{name:'另一部番剧',exact:true}).click();await capture.locator('#videoCaptureNote').fill('繁体');await capture.locator('#videoCaptureSave').click();await capture.locator('#videoCaptureModal').waitFor({state:'hidden'});
 assert.equal(writes.length,1);assert.equal(writes[0].anime_id,456);assert.equal(writes[0].note,'繁体');assert(writes[0].url.includes('p=2'));assert.equal(writes[0].scope,'test-scope');assert.equal(writes[0].make_default,false,'save confirmation defaults to collection only');
 console.log('Extension capture -> same-origin handbook confirmation: first launch and existing-tab reuse without reload, catalog, association, reset, filter, explicit save and Part 2 passed.');
}finally{if(context)await context.close();if(!path.resolve(dir).startsWith(path.join(os.tmpdir(),'handbook-extension-')))throw Error('Unexpected directory');fs.rmSync(dir,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exit(1)});
