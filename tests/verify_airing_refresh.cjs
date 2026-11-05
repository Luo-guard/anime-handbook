const fs = require('fs'), vm = require('vm'), assert = require('node:assert/strict');
const state = {settings:{},animes:[{id:1,airing:{aired:1,total:12}}],activeView:'schedule'};
state.progressAnime = {...state.animes[0]};
let requests=0, scheduleRenders=0, detailRenders=0, timer, interval;
let respond = async () => ({animes:[{id:1,airing:{aired:2,total:12}}]});
const handlers={};
const ctx=vm.createContext({state,console,Map,JSON,URLSearchParams,
 document:{hidden:false,addEventListener:(name,fn)=>handlers[name]=fn},
 window:{addEventListener:(name,fn)=>handlers[name]=fn},
 $:()=>({open:true}),api:async()=>{requests++;return respond();},
 renderSchedule:()=>scheduleRenders++,refreshEpisodeAiringStatus:()=>detailRenders++,
 clearInterval:()=>{},setInterval:(fn,ms)=>{timer=fn;interval=ms;return 1;}
});
vm.runInContext(fs.readFileSync('static/modules/lifecycle.js','utf8'),ctx);
const run=source=>vm.runInContext(source,ctx);
(async()=>{
 run('startAiringWatcher()');assert.equal(interval,60000);
 await timer();assert.equal(state.animes[0].airing.aired,2);assert.equal(state.progressAnime.airing.aired,2);
 assert.equal(scheduleRenders,1);assert.equal(detailRenders,1);
 await timer();assert.equal(scheduleRenders,1,'unchanged progress must not rebuild views');
 ctx.document.hidden=true;await timer();assert.equal(requests,2);ctx.document.hidden=false;
 let resolve;respond=()=>new Promise(r=>resolve=r);
 const first=timer();await Promise.resolve();await timer();assert.equal(requests,3,'no overlapping minute requests');
 state.animes=[{id:1,airing:{aired:9,total:12}}];
 resolve({animes:[{id:1,airing:{aired:3,total:12}}]});await first;
 assert.equal(state.animes[0].airing.aired,9,'old account/request must not overwrite new collection');
 respond=async()=>{throw Error('offline')};await timer();assert.equal(state.animes[0].airing.aired,9);
 respond=async()=>({animes:[{id:1,airing:{aired:10,total:12}}]});await handlers.focus();
 assert.equal(state.animes[0].airing.aired,10,'focus retries even after failure');
 state.settings.schedule_airing_source='as';
 ctx.scheduleState={week:'2026-W45',data:{items:[{key:'unmapped',as_airing:{aired:6,total:12}}]}};
 ctx.scheduleSource=()=> 'as';
 respond=async()=>({animes:[{id:1,airing:{aired:10,total:12}}],schedule_airing:{},calendar_airing:{unmapped:{aired:7,total:12}}});
 await timer();assert.equal(ctx.scheduleState.data.items[0].as_airing.aired,7,'AS route progress refreshes without a Bangumi ID');
 respond=async()=>({animes:[],schedule_airing:{}});
 await timer();assert.equal(ctx.scheduleState.data.items[0].as_airing.aired,7,'missing ID response does not erase direct AS progress');
 console.log('Airing refresh: minute timer, unchanged-data guard, hidden page, concurrent requests, profile changes, offline retention and focus retry passed.');
})().catch(error=>{console.error(error);process.exit(1)});
