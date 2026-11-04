const fs=require('fs'),assert=require('node:assert/strict');
const {chromium}=require('C:/Users/han/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
(async()=>{const browser=await chromium.launch({headless:true});try{
 const page=await browser.newPage();await page.setContent('<div id="animeGrid"></div>');
 await page.addScriptTag({content:`
 const state={settings:{},sort:'time'};
 const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
 const escapeHtml=s=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
 const episodeTotal=()=>12,showCustomMoveButton=()=>true,showCollectionBgmRating=()=>true,showProgressBar=()=>true;
 const collectionSortMode=()=>state.sort;
 window.opened=[];window.moved=[];window.sortWrites=[];
 function openProgress(id){opened.push(id)}
 function openCustomMoveMenu(id){moved.push(id)}
 async function api(path,options){sortWrites.push(JSON.parse(options.body));return {}}
 function toast(message){throw Error(message)}
 `+fs.readFileSync('static/modules/collection-cards.js','utf8')});
 const timings=await page.evaluate(()=>{
  window.items=Array.from({length:5000},(_,i)=>({id:i+1,display_name:'anime '+i,cover_url:'',watched_count:0,bgm_score:8}));
  const grid=document.querySelector('#animeGrid');let start=performance.now();HandbookCollectionGrid.update(grid,items);const initial=performance.now()-start;
  const first=grid.firstElementChild,second=first.nextElementSibling;first.focus();
  start=performance.now();HandbookCollectionGrid.update(grid,items);const unchanged=performance.now()-start;
  if(grid.firstElementChild!==first||document.activeElement!==first)throw Error('unchanged card/focus replaced');
  items[1]={...items[1],watched_count:5};HandbookCollectionGrid.update(grid,items);
  if(grid.firstElementChild!==first||first.nextElementSibling===second)throw Error('wrong keyed update');
  for(let i=0;i<20;i++)HandbookCollectionGrid.update(grid,items.slice(0,10));
  return {initial,unchanged};
 });
 assert(timings.initial<10000,JSON.stringify(timings));assert(timings.unchanged<2500,JSON.stringify(timings));
 await page.locator('.anime-card').first().click();await page.locator('.anime-card').first().press('Enter');
 assert.deepEqual(await page.evaluate(()=>opened),[1,1]);
 await page.locator('.card-move-button').first().click();assert.deepEqual(await page.evaluate(()=>moved),[1]);assert.equal(await page.evaluate(()=>opened.length),2);
 await page.evaluate(()=>{
   state.sort='custom';HandbookCollectionGrid.update(document.querySelector('#animeGrid'),items.slice(0,4));
   const first=document.querySelector('.anime-card'),second=first.nextElementSibling,dataTransfer=new DataTransfer();
   first.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer}));
   second.dispatchEvent(new DragEvent('dragover',{bubbles:true,dataTransfer}));
   second.dispatchEvent(new DragEvent('drop',{bubbles:true,dataTransfer,clientY:second.getBoundingClientRect().bottom+1}));
 });
 await page.waitForFunction(()=>sortWrites.length===1);assert.deepEqual(await page.evaluate(()=>sortWrites[0].anime_ids),[2,1,3,4]);
 console.log('Collection performance: 5,000 cards, keyed identity/focus, incremental update, repeated render delegation, keyboard/move/drag passed. '+JSON.stringify(timings));
}finally{await browser.close()}})().catch(error=>{console.error(error);process.exit(1)});
