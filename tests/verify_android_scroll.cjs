const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('C:/Users/han/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
(async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage({viewport:{width:390,height:844}});
  const assets=path.resolve(__dirname,'../android/app/src/main/assets');
  await page.setContent(fs.readFileSync(path.join(assets,'index.html'),'utf8').replace(/<script[^>]*src="app.js"[^>]*><\/script>/,''));
  await page.addStyleTag({content:fs.readFileSync(path.join(assets,'style.css'),'utf8')});
  await page.evaluate(()=>{
   window.AndroidHandbook={state:()=>JSON.stringify({tables:{anime:Array.from({length:100},(_,i)=>({id:i+1,name_cn:'测试番剧 '+i,collection_type:1,active:1,episode_count:12,watched_episodes:'[]'})),settings:[],events:[],custom_collection_items:[]}}),saveState:()=>true};
  });
  await page.addScriptTag({content:fs.readFileSync(path.join(assets,'app.js'),'utf8')});
  for(const y of [950,2400,5100]){
   await page.evaluate(y=>window.scrollTo(0,y),y);
   const before=await page.evaluate(()=>window.scrollY);
   await page.evaluate(()=>openAnime(25));
   assert.equal(await page.evaluate(()=>window.scrollY),0,'detail starts at top');
   await page.evaluate(()=>toggleEpisode(25,'01'));
   await page.locator('.back').click();
   assert.equal(await page.evaluate(()=>window.scrollY),before,'return restores original collection position');
   assert.equal(await page.locator('.anime').count(),100);
  }
  console.log('Android collection return scroll passed: three positions, repeated navigation and episode edits');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
