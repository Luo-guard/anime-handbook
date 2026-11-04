const fs=require('fs'),assert=require('node:assert/strict'),os=require('os'),path=require('path');
const {chromium}=require('C:/Users/han/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
(async()=>{const browser=await chromium.launch({headless:true});try{
 const page=await browser.newPage();
 await page.setContent('<style>'+fs.readFileSync('static/styles.css','utf8')+'</style><main style="max-width:820px;margin:24px auto;background:var(--surface);padding:20px"><h2>佐佐木与文鸟小哔 第二季</h2><input id="episodeCountInput" value="12" hidden><div id="episodeGrid" class="episode-grid"></div></main>');
 await page.addScriptTag({content:`
 const $=(s,root=document)=>root.querySelector(s),$$=(s,root=document)=>[...root.querySelectorAll(s)];
 const escapeHtml=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
 const state={settings:{},pendingEpisodes:new Set(['0:1']),episodeRecordAnnotations:{},progressAnime:{airing:{aired:4,total:14,next_label:'11/04 20:00'},episodes:[...Array.from({length:12},(_,i)=>({key:'0:'+(i+1),type:0,type_label:'本篇',label:String(i+1).padStart(2,'0')})),{key:'2:1',type:2,type_label:'OP',label:'01'},{key:'3:1',type:3,type_label:'ED',label:'01'}]}};
 `+fs.readFileSync('static/modules/presentation.js','utf8')+'\n'+fs.readFileSync('static/modules/details.js','utf8')+'\nrenderEpisodeGrid();'});
 for(const width of [920,390,320]){
  await page.setViewportSize({width,height:800});
  const result=await page.locator('.episode-group').first().evaluate(section=>{
   const head=section.querySelector('.episode-group-head'),info=section.querySelector('.episode-airing-info'),grid=section.querySelector('.episode-group-grid');
   return {head:head.textContent,info:info.textContent,separate:info.getBoundingClientRect().top>=head.getBoundingClientRect().bottom,clear:grid.getBoundingClientRect().top>=info.getBoundingClientRect().bottom,overflow:section.scrollWidth>section.clientWidth};
  });
  assert(!result.head.includes('已播')&&!result.head.includes('下集'));assert(result.head.includes('已看 1 / 12'));
  assert(result.info.includes('已播至第 4 集')&&result.info.includes('下集 11/04 20:00'));
  assert(result.separate&&result.clear&&!result.overflow,JSON.stringify(result));
 }
 assert.equal(await page.locator('[data-episode-airing-type]').count(),1);
 await page.locator('[data-episode-key="0:2"]').click();assert((await page.locator('[data-episode-group-summary]').first().textContent()).includes('已看 2 / 12'));
 await page.evaluate(()=>{window.savedCell=document.querySelector('.episode-cell');state.progressAnime.airing.aired=5;refreshEpisodeAiringStatus()});
 assert(await page.evaluate(()=>savedCell===document.querySelector('.episode-cell')));
 assert((await page.locator('.episode-airing-info').textContent()).includes('已播至第 5 集'));
 await page.setViewportSize({width:920,height:620});await page.screenshot({path:path.join(os.tmpdir(),'handbook-detail-airing-layout.png')});
 await page.evaluate(()=>{state.progressAnime.airing=undefined;refreshEpisodeAiringStatus()});
 assert.equal(await page.locator('.episode-airing-info').isVisible(),false);
 console.log('Detail airing layout: separate muted row at 920/390/320px, no overflow, watch selection preserved, live text refresh and empty-row collapse passed.');
}finally{await browser.close()}})().catch(error=>{console.error(error);process.exit(1)});
