const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),os=require('node:os'),path=require('node:path');
const {chromium}=require('C:/Users/han/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
(async()=>{
 const ctx=vm.createContext({state:{settings:{},animes:[{id:1,airing:{aired:5,total:13}}]},CATEGORIES:[{id:1,name:'在看'}],URLSearchParams,Date,AbortController,setTimeout,clearTimeout,$:()=>({addEventListener(){}}),$$:()=>[],escapeHtml:s=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;')});
 vm.runInContext(fs.readFileSync('static/schedule.js','utf8'),ctx);
 ctx.fixture={key:'test',id:1,local_id:1,title:'侦探已死第二期',kind:'weekly',collection_type:1,score:5.3,votes:2217,release:'10/7~',tags:['2026年10月','轻小说改'],time:'20:30',weekday:3};
 const html=vm.runInContext('scheduleCard(fixture)',ctx);
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();
  await page.setContent(`<style>${fs.readFileSync('static/styles.css','utf8')}body{padding:20px}.poster-wrap{background:linear-gradient(135deg,#a9bfd7,#e1c4c9 50%,#43577a)}</style><main class="schedule-grid">${html.repeat(6)}</main>`);
  for(const width of [1920,650,390,320]){
   await page.setViewportSize({width,height:1000});
   const geometry=await page.locator('.schedule-card').first().evaluate(card=>{
    const box=card.getBoundingClientRect(),status=card.querySelector('.schedule-collection-badge').getBoundingClientRect(),score=card.querySelector('.poster-score').getBoundingClientRect(),time=card.querySelector('.schedule-airtime'),progress=card.querySelector('.schedule-progress'),footer=card.querySelector('.schedule-card-footer');
    return {overflow:card.scrollWidth>card.clientWidth,statusTop:status.top,scoreTop:score.top,overlap:status.right>score.left,timeBackground:getComputedStyle(time).backgroundImage,progressBackground:getComputedStyle(progress).backgroundColor,footer:footer.getBoundingClientRect().bottom<=box.bottom,cornerBackgrounds:['.poster-score','.schedule-collection-badge'].map(selector=>getComputedStyle(card.querySelector(selector)).backgroundColor)};
   });
   assert(!geometry.overflow&&!geometry.overlap&&geometry.footer,JSON.stringify({width,...geometry}));
   assert.equal(geometry.statusTop,geometry.scoreTop);
   assert(geometry.timeBackground.includes('linear-gradient'));
   assert.equal(geometry.progressBackground,'rgba(0, 0, 0, 0)');
   assert(geometry.cornerBackgrounds.every(color=>color==='rgba(0, 0, 0, 0)'));
  }
  await page.setViewportSize({width:1100,height:950});
  await page.screenshot({path:path.join(os.tmpdir(),'handbook-schedule-card-unified.png')});
  vm.runInContext('state.settings.schedule_card_fields={score:false,collection:false}',ctx);
  assert(!vm.runInContext('scheduleCard(fixture)',ctx).includes('schedule-poster-shaded'),'no top shade when both corner fields are hidden');
  console.log('Schedule card layout passed at 1920/650/390/320px: aligned badges, no overlap/overflow, gradient time and plain progress');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
