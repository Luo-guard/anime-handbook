const fs=require('fs'),vm=require('vm'),assert=require('node:assert/strict');
const state={settings:{},statisticsType:'watch',statisticsPeriod:'day'};
const chart={innerHTML:''},summary={innerHTML:''};
const series=[{label:'2026-10-01',episodes:2,records:1},{label:'2026-10-02',episodes:0,records:0},{label:'2026-10-03',episodes:0,records:1},{label:'2026-10-04',episodes:3,records:1}];
const ctx=vm.createContext({state,enabledSetting:k=>state.settings[k]!==false,allRecordThemes:()=>[],escapeHtml:s=>s,$:s=>s==='#statisticsChart'?chart:s==='#statisticsSummary'?summary:null,api:async()=>({series}),requestAnimationFrame:()=>{}});
vm.runInContext(fs.readFileSync('static/modules/statistics.js','utf8')+';renderStatisticsTypeControls=()=>{};',ctx);
(async()=>{
 for(const period of ['day','week','month','year']){
  state.statisticsPeriod=period;state.statisticsType='watch';state.settings.statistics_show_zero_periods=true;
  await ctx.renderStatistics();assert(summary.innerHTML.includes('4 个统计周期'));assert.equal((chart.innerHTML.match(/class="statistics-bar-item"/g)||[]).length,4);
  state.settings.statistics_show_zero_periods=false;await ctx.renderStatistics();assert(summary.innerHTML.includes('2 个统计周期'));assert(summary.innerHTML.includes('<strong>5</strong>'));assert.equal((chart.innerHTML.match(/class="statistics-bar-item"/g)||[]).length,2);
  state.statisticsType='all';await ctx.renderStatistics();assert(summary.innerHTML.includes('3 个统计周期'));assert(summary.innerHTML.includes('<strong>3</strong>'));
 }
 assert.equal(series.length,4);state.statisticsType='watch';assert.equal(ctx.visibleStatisticsSeries([{episodes:0,records:1}]).length,0);
 delete state.settings.statistics_show_zero_periods;assert.equal(ctx.visibleStatisticsSeries(series).length,4);
 console.log('Statistics: zero-period preference, metric-specific filtering, totals, default behavior and all four periods passed.');
})().catch(e=>{console.error(e);process.exit(1)});
