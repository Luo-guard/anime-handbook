const assert=require("node:assert/strict"),fs=require("node:fs");
const {chromium}=require("C:/Users/han/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright");
(async()=>{
 const browser=await chromium.launch({headless:true});
 try{
 const page=await browser.newPage({viewport:{width:1280,height:800}});
 await page.setContent('<style>'+fs.readFileSync("static/styles.css","utf8")+'</style><div id="statisticsChart" class="statistics-chart"></div>');
 await page.addScriptTag({content:'const state={statisticsType:"watch",statisticsPeriod:"day",settings:{}}; const $=(s,r=document)=>r.querySelector(s);const escapeHtml=String;'+fs.readFileSync("static/modules/statistics.js","utf8")});
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
 console.log("PASS actual column dimensions, zero values, day/week/month/year, watch/records, three themes, desktop/narrow, 130 periods");
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
