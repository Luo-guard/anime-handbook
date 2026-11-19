const assert=require("node:assert/strict"),fs=require("node:fs");
const {chromium}=require("C:/Users/han/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright");
const stylesheet = fs.readFileSync("static/styles.css","utf8");
const script = fs.readFileSync("static/modules/statistics.js","utf8");

async function checkStatisticsViews(browser) {
 const page = await browser.newPage({viewport:{width:1280,height:800}});
 const errors = [];
 page.on('pageerror', error => errors.push(error.message));
 const html = fs.readFileSync('static/index.html', 'utf8');
 const section = html.match(/<section class="view" id="statisticsView">[\s\S]*?<\/section>/)[0].replace('class="view"', 'class="view active"');
 await page.setContent('<style>'+stylesheet+' body{background:#18202b} #statisticsView{padding:20px}</style>'+section+'<input id="timelineSearchInput" hidden>');
 await page.addScriptTag({content:`
   const state={statisticsType:"watch",statisticsPeriod:"day",settings:{}};
   const $=(s,r=document)=>r.querySelector(s), $$=(s,r=document)=>[...r.querySelectorAll(s)];
   const escapeHtml=String, enabledSetting=()=>true, allRecordThemes=()=>[{id:'watch',name:'观看记录'},{id:'other',name:'其他记录'}];
   const calls=[], drills=[];
   const applyTimelineDefaults=()=>{};
   let range, finishWeek;
   const setTimelineDateRange=(...dates)=>range=dates;
   const switchView=()=>drills.push({range,themes:[...state.timelineThemes]});
   const series=Array.from({length:40},(_,i)=>({
     label:new Date(Date.UTC(2026,9,i+20)).toISOString().slice(0,10),
     episodes:i%7,records:i%3
   }));
   const api=async url=>{
     calls.push(url);
     if(url.includes('period=week')) return new Promise(resolve=>{finishWeek=resolve});
     return {series,balance:{enabled:true,value:12}};
   };
   ${script}
 `});
 await page.evaluate(()=>renderStatistics());
 const mode = name => page.getByRole('button',{name,exact:true});
 const chart = page.locator('#statisticsChart');
 const callCount = () => page.evaluate(()=>calls.length);
 const mainTotal = () => page.locator('#statisticsSummary strong').first().textContent();
 assert.equal(await chart.locator('.statistics-bar-item').count(),16);
 assert.equal(await mainTotal(),'115');
 assert.equal(await callCount(),1);
 assert.equal(await page.getByText('还欠 12 集').count(),1);
 await mode('‹ 更早').click();
 assert.match(await page.locator('#statisticsWindowNote').textContent(),/2026 年 10 月 28 日/);
 await mode('回到最近').click();
 await page.locator('#statisticsMetricSelect').selectOption('records');
 assert.equal(await mainTotal(),'39');
 await mode('趋势').click();
 assert.equal(await chart.locator('.statistics-line-point').count(),16);
 assert(await chart.locator('canvas').evaluate(canvas=>canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data.some((value,index)=>index%4===3&&value>0)));
 await mode('累计').click();
 assert.equal(await chart.locator('.statistics-line-point').last().textContent(),'39');
 assert(Number(await chart.locator('.statistics-line-point').first().textContent())>16,'cumulative carries the previous pages');
 if(process.env.STATISTICS_SCREENSHOT_DIR) await page.screenshot({path:process.env.STATISTICS_SCREENSHOT_DIR+'/handbook-statistics-cumulative.png'});
 await mode('明细').click();
 assert.equal(await chart.locator('tbody tr').count(),16);
 assert.match(await chart.locator('tbody tr').first().textContent(),/11 月 28 日/);
 await chart.locator('tbody button').first().press('Enter');
 assert.deepEqual(await page.evaluate(()=>drills.at(-1)),{range:['2026-11-28','2026-11-28'],themes:['watch']});
 await mode('活跃日历').click();
 assert.equal(await page.locator('#statisticsPeriods').isVisible(),false);
 assert.equal(await chart.locator('.statistics-calendar-day').count(),30);
 assert(await chart.locator('[data-level="4"]').count());
 await chart.locator('button[data-period-index]').first().click();
 assert.deepEqual(await page.evaluate(()=>drills.at(-1).range),['2026-11-01','2026-11-01']);
 await mode('‹ 更早').click();
 assert.match(await page.locator('#statisticsWindowNote').textContent(),/10 月/);
 assert.equal(await chart.locator('.statistics-calendar-day').count(),31);
 assert.equal(await callCount(),1,'daily chart and metric switches use the same payload');
 if(process.env.STATISTICS_SCREENSHOT_DIR) await page.screenshot({path:process.env.STATISTICS_SCREENSHOT_DIR+'/handbook-statistics-calendar.png'});
 await page.setViewportSize({width:360,height:800});
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'the page fits on narrow screens');
 if(process.env.STATISTICS_SCREENSHOT_DIR) await page.screenshot({path:process.env.STATISTICS_SCREENSHOT_DIR+'/handbook-statistics-mobile.png',fullPage:true});
 await mode('柱状').click();
 await mode('每周').click();
 await mode('活跃日历').click();
 await chart.locator('.statistics-calendar').waitFor();
 await page.evaluate(()=>finishWeek({series:[{label:'2026-W47',records:99,episodes:99}]}));
 await page.waitForFunction(()=>document.querySelector('.statistics-calendar')!==null);
 assert.equal(await mainTotal(),'39','stale weekly result cannot replace a daily calendar');
 assert.deepEqual(errors,[]);
 await page.close();
}

(async()=>{
 const browser=await chromium.launch({headless:true});
 try{
 const page=await browser.newPage({viewport:{width:1280,height:800}});
 await page.setContent('<style>'+stylesheet+'</style><div id="statisticsChart" class="statistics-chart"></div>');
 await page.addScriptTag({content:'const state={statisticsType:"watch",statisticsPeriod:"day",settings:{}}; const $=(s,r=document)=>r.querySelector(s);const escapeHtml=String;'+script});
 const widths=[1280,360];
 for(const width of widths){
 await page.setViewportSize({width,height:800});
 for(const theme of ["forest","slate","violet"]){
 await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;document.documentElement.classList.toggle("has-custom-background",theme==="slate");},theme);
 for(const period of ["day","week","month","year"]){
 for(const metric of ["watch","all"]){
 await page.evaluate(({period,metric})=>{
 state.statisticsPeriod=period;state.statisticsType=metric;
 renderStatisticsChart([{label:"2026-11-01",episodes:0,records:0},{label:"2026-11-02",episodes:1,records:2},{label:"2026-11-03",episodes:17,records:40}]);
 },{period,metric});
 const sizes=await page.locator(".statistics-bar-fill").evaluateAll(nodes=>nodes.map(el=>({width:el.getBoundingClientRect().width,height:el.getBoundingClientRect().height,track:el.parentElement.getBoundingClientRect().height})));
 assert.equal(sizes.length,2,"zero periods have no column");
 assert(sizes.every(bar=>bar.width>0&&bar.height>0&&bar.height<=bar.track));
 assert(sizes[1].height>sizes[0].height,"column height follows value");
 }
 }
 }
 }
 await page.evaluate(()=>{state.statisticsPeriod="day";state.statisticsType="watch";renderStatisticsChart(Array.from({length:130},(_,i)=>({label:"2026-11-"+String(i%28+1).padStart(2,"0"),episodes:i%18})))});
 assert.equal(await page.locator(".statistics-bar-item").count(),130);
 assert(await page.locator(".statistics-bars").evaluate(el=>el.scrollWidth>el.clientWidth));
 await page.setViewportSize({width:1280,height:800});
 await checkStatisticsViews(browser);
 console.log("PASS chart dimensions, five views, metric, paging, calendar, drilldown, request races and narrow layout");
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
