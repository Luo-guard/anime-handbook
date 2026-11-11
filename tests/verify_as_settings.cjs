const fs=require('fs'),http=require('http'),path=require('path'),assert=require('node:assert/strict');
const {chromium}=require('C:/Users/han/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const settings={collection_airing_source:'bgm',schedule_airing_source:'bgm',detail_airtime_source:'yuc'};
const boot={settings,active_profile:{id:'fixture',name:'Fixture'},profiles:[],animes:[],custom_collections:[],ranking_boards:[],ranking_templates:[],stats:{},sync:{running:false},revision:1};
let saves=0;
const server=http.createServer((req,res)=>{
 const route=new URL(req.url,'http://localhost').pathname;
 const send=data=>{res.setHeader('Content-Type','application/json; charset=utf-8');res.end(JSON.stringify(data))};
 if(route==='/api/bootstrap')return send(boot);
 if(route==='/api/health')return send({features:{schedule_sorting:2,keyboard_shortcuts:1}});
 if(route==='/api/settings'&&req.method==='PATCH'){
  let body='';req.on('data',x=>body+=x);req.on('end',()=>{Object.assign(settings,JSON.parse(body));saves++;send({settings})});return;
 }
 if(route.startsWith('/api/'))return send({animes:[],items:[],sync:{running:false},stats:{},revision:1});
 const file=path.join(path.resolve('static'),route==='/'?'index.html':route);
 if(!fs.existsSync(file)){res.statusCode=404;return res.end()}
 res.setHeader('Content-Type',({'.js':'text/javascript','.html':'text/html','.css':'text/css'})[path.extname(file)]||'application/octet-stream');res.end(fs.readFileSync(file));
});
(async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.click('#settingsButton');await page.click('[data-settings-tab="collection"]');
  await page.selectOption('#collectionAiringSourceInput','as');
  assert.equal(settings.collection_airing_source,'bgm','unsaved control must not persist');
  await page.click('#saveSettings');await page.waitForFunction(()=>!document.querySelector('#settingsModal').open);
  assert.equal(settings.collection_airing_source,'as');assert.equal(settings.schedule_airing_source,'bgm');
  assert.equal(settings.detail_airtime_source,'yuc');
  await page.click('#settingsButton');await page.click('[data-settings-tab="schedule"]');
  await page.selectOption('#scheduleAiringSourceInput','as');await page.click('#saveSettings');
  await page.waitForFunction(()=>!document.querySelector('#settingsModal').open);
  await page.click('#settingsButton');await page.click('[data-settings-tab="detail"]');
  await page.selectOption('#detailAirtimeSourceInput','as');
  assert.equal(settings.detail_airtime_source,'yuc','detail source waits for save');
  await page.click('#saveSettings');await page.waitForFunction(()=>!document.querySelector('#settingsModal').open);
  await page.reload();await page.click('#settingsButton');await page.click('[data-settings-tab="collection"]');
  assert.equal(await page.locator('#collectionAiringSourceInput').inputValue(),'as');
  await page.click('[data-settings-tab="schedule"]');
  assert.equal(await page.locator('#scheduleAiringSourceInput').inputValue(),'as');
  await page.click('[data-settings-tab="detail"]');
  assert.equal(await page.locator('#detailAirtimeSourceInput').inputValue(),'as');
  await page.click('[data-settings-tab="schedule"]');
  await page.setViewportSize({width:390,height:844});await page.locator('#scheduleAiringSourceInput').scrollIntoViewIfNeeded();
  const box=await page.locator('#scheduleAiringSourceInput').boundingBox();assert(box.x>=0&&box.x+box.width<=390);
  assert.equal(saves,3);assert.deepEqual(errors,[]);
  console.log('AS settings: separate sections, explicit save, persistence after reload, mobile bounds, no browser errors.');
 }finally{await browser.close();server.close()}
})().catch(error=>{console.error(error);server.close();process.exitCode=1});
