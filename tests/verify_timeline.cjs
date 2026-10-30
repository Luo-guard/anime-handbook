const fs=require('fs'),vm=require('vm'),assert=require('assert');
const source=require('./frontend_source.cjs');
const start=source.indexOf('let timelineRequest ='),end=source.indexOf('\nfunction switchView',start);
const elements={};const pending=[];const errors=[];
function element(key){return elements[key]??={innerHTML:'',classList:{add(){},toggle(){}},insertAdjacentHTML(_,html){this.innerHTML+=html;if(html.includes('id="timelineMore"'))element('#timelineMore')},remove(){delete elements[key]}}}
const state={activeView:'timeline',timelineSearch:'',timelineThemes:new Set()};
let calls=0;
const context=vm.createContext({state,URLSearchParams,AbortController,window:{},$:s=>s==='#timelineMore'?(elements[s]||null):element(s),$$:()=>[],api:(url,options)=>{calls++;return new Promise(resolve=>pending.push({url,options,resolve}))},formatDate:s=>({main:s,sub:''}),timelineEvent:e=>`<article>${e.id}</article>`,toast:e=>errors.push(e)});
vm.runInContext(source.slice(start,end),context);
const run=expr=>vm.runInContext(expr,context);
const page=(id,hasMore,next)=>({days:[{date:'2026-10-'+id,events:[{id}]}],has_more:hasMore,next_offset:next});
(async()=>{
 const first=run('renderTimeline()');assert(pending[0].url.includes('limit=30'));pending.shift().resolve(page(14,true,30));await first;
 const append=run('renderTimeline(true)');await run('renderTimeline(true)');assert.equal(calls,2);assert(pending[0].url.includes('offset=30'));pending.shift().resolve(page(13,false,60));await append;
 assert(element('#timeline').innerHTML.includes('<article>14'));assert(element('#timeline').innerHTML.includes('<article>13'));
 const stale=run('renderTimeline()');const old=pending.shift();state.timelineSearch='new query';state.timelineThemes=new Set(['episode_review']);const fresh=run('renderTimeline()');assert(old.options.signal.aborted);assert(pending[0].url.includes('theme=episode_review'));pending.shift().resolve(page(12,false,1));await fresh;old.resolve(page(11,false,30));await stale;
 assert(element('#timeline').innerHTML.includes('<article>12'));assert(!element('#timeline').innerHTML.includes('<article>11'));
 const empty=run('renderTimeline()');pending.shift().resolve({days:[],has_more:false,next_offset:0});await empty;assert.equal(element('#timeline').innerHTML,'');
 assert.equal(errors.length,0);console.log('Timeline paging: append, duplicate-load guard, filter reset, abort, stale response and empty state passed');
})().catch(e=>{console.error(e);process.exitCode=1});
