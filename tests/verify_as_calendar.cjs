const fs=require('fs'),http=require('http'),path=require('path'),vm=require('vm'),assert=require('node:assert/strict');
const {chromium}=require('C:/Users/han/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const source=fs.readFileSync('static/schedule.js','utf8');
const context=vm.createContext({state:{settings:{}},Date});vm.runInContext(source,context);
const run=code=>vm.runInContext(code,context);
assert.equal(run(`scheduleISOWeek(new Date('2027-01-03T19:59:00Z'))`),'2026-W53');
assert.equal(run(`scheduleISOWeek(new Date('2027-01-03T20:00:00Z'))`),'2027-W01');
assert.equal(run(`scheduleWeekMonday('2026-W45').toISOString().slice(0,10)`),'2026-11-02');
const settings={schedule_source:'yuc',schedule_airing_source:'as',kazumi_read_only:true};
const boot={settings,active_profile:{id:'fixture',name:'Fixture'},profiles:[],animes:[],custom_collections:[],ranking_boards:[],ranking_templates:[],stats:{},sync:{running:false},revision:1};
const requests=[];
const server=http.createServer((req,res)=>{
 const url=new URL(req.url,'http://localhost'),route=url.pathname;
 const send=data=>{res.setHeader('Content-Type','application/json; charset=utf-8');res.end(JSON.stringify(data))};
 if(route==='/api/bootstrap')return send(boot);
 if(route==='/api/health')return send({features:{schedule_sorting:2,keyboard_shortcuts:1}});
 if(route==='/api/settings'&&req.method==='PATCH'){
  let body='';req.on('data',x=>body+=x);req.on('end',()=>{Object.assign(settings,JSON.parse(body));send({settings})});return;
 }
 if(route==='/api/schedule'){
  requests.push(Object.fromEntries(url.searchParams));
  const as=url.searchParams.get('source')==='as',week=url.searchParams.get('week');
  const key=week||'2026-W45';
  return send({season:url.searchParams.get('season'),source:as?'as':settings.schedule_source,week,items:[{
   key:'fixture',id:null,title:(as?'AS 专属 ':'BGM 专属 ')+key,aliases:[],kind:'weekly',weekday:4,bj_weekday:4,bj_time:as?'21:00':'',
   image_url:'',score:0,votes:0,tags:['第 6 集'],as_url:'https://animeschedule.net/anime/fixture',as_airing:{aired:6,total:12},
  }],warnings:[]});
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
  await page.click('[data-view="schedule"]');
  await page.selectOption('#scheduleSourceSwitch','as');
  await page.waitForFunction(()=>scheduleState.dataSource==='as'&&scheduleState.data?.items.length);
  await page.click('[data-schedule-day="4"]');
  assert(await page.locator('#scheduleASWeek').isVisible());
  assert(!await page.locator('#scheduleSeasonButton').isVisible());
  assert.equal(await page.locator('[data-schedule-day]').count(),7);
  assert((await page.locator('#scheduleGrid').innerText()).includes('AS 专属'));
  assert((await page.locator('#scheduleGrid').innerText()).includes('已播 6 / 12'));
  const first=await page.evaluate(()=>scheduleState.week);
  await page.click('#schedulePreviousWeek');
  await page.waitForFunction(old=>scheduleState.week!==old&&scheduleState.data?.week===scheduleState.week,first);
  const previous=await page.evaluate(()=>scheduleState.week);assert.notEqual(previous,first);
  await page.click('#scheduleNextWeek');await page.waitForFunction(key=>scheduleState.data?.week===key,first);
  await page.locator('.schedule-card').click();assert(await page.locator('#scheduleDetail a[href="https://animeschedule.net/anime/fixture"]').isVisible());
  await page.click('#scheduleCloseDetail');
  for(const width of [390,320]){
   await page.setViewportSize({width,height:844});
   for(const selector of ['#scheduleSourceSwitch','#scheduleASWeek']){
    const bounds=await page.locator(selector).boundingBox();assert(bounds.x>=0&&bounds.x+bounds.width<=width,JSON.stringify({selector,bounds,width}));
   }
  }
  await page.selectOption('#scheduleSourceSwitch','kazumi');
  await page.waitForFunction(()=>scheduleState.dataSource==='kazumi');
  assert(!await page.locator('#scheduleASWeek').isVisible());assert(await page.locator('#scheduleSeasonButton').isVisible());
  assert.equal(await page.locator('[data-schedule-day]').count(),8);
  assert(!(await page.locator('#scheduleGrid').innerText()).includes('AS 专属'));
  assert(requests.some(x=>x.source==='as'&&x.week===previous));assert.deepEqual(errors,[]);
  console.log('AS calendar: third source, real ISO weeks, navigation, independent lists, detail credit, mobile layout and source persistence.');
 }finally{await browser.close();server.close()}
})().catch(error=>{console.error(error);server.close();process.exitCode=1});
