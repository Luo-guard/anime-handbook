const fs = require('fs'), vm = require('vm'), assert = require('node:assert/strict');
const source = require('./frontend_source.cjs');
const elements = {};
function element(id) { return elements[id] ||= {innerHTML:'',textContent:'',disabled:false,open:true,classList:{add(){},remove(){},toggle(){}}}; }
const requests=[], errors=[];
const state = {progressAnime:{id:1}};
const ctx = vm.createContext({state, $:element, $$:()=>[], escapeHtml:String, toast:message=>errors.push(message), api:(url,options)=>new Promise((resolve,reject)=>requests.push({url,method:options?.method||'GET',resolve,reject}))});
vm.runInContext(source.slice(source.indexOf('function renderCharacters('), source.indexOf('\nasync function refreshEpisodeRecordAnnotations')),ctx);
const run = code=>vm.runInContext(code,ctx);
const cast = name=>[{character_id:1,name,name_cn:name}];
const tick = async()=>{for(let i=0;i<5;i++)await Promise.resolve();};
const open = id=>{state.progressAnime={id};run('resetCharacterPanel()');};
const grid = ()=>element('#characterGrid').innerHTML;
(async()=>{
 // Three uncached subjects: only the currently open subject may paint or unlock the button.
 const pending=[], posts=[];
 for(const id of [1,2,3]) {open(id);pending.push(run('loadCharacters()'));requests.shift().resolve({characters:[]});await tick();const post=requests.shift();assert.equal(post.method,'POST');posts.push(post);}
 posts[2].resolve({characters:cast('third')});await pending[2];assert.ok(grid().includes('third'));
 posts[0].resolve({characters:cast('first')});await pending[0];posts[1].reject(new Error('old failure'));await pending[1];assert.ok(grid().includes('third'));assert.deepEqual(errors,[]);assert.equal(element('#refreshCharacters').textContent,'刷新人物');
 // Cached navigation clears the old subject immediately, and late GETs cannot replace the new subject.
 open(1);assert.equal(grid(),'');const a=run('loadCharacters()');const old=requests.shift();open(2);const b=run('loadCharacters()');requests.shift().resolve({characters:cast('cached second')});await b;old.resolve({characters:cast('cached first')});await a;assert.ok(grid().includes('cached second'));
 // Reopening an in-flight subject shares its refresh, but takes ownership of the displayed result.
 open(1);const first=run('loadCharacters()');requests.shift().resolve({characters:[]});await tick();const refresh=requests.shift();open(2);open(1);const reopened=run('loadCharacters()');requests.shift().resolve({characters:[]});await tick();assert.equal(requests.length,0);refresh.resolve({characters:cast('reopened first')});await Promise.all([first,reopened]);assert.ok(grid().includes('reopened first'));
 // An old-order cache is visible while its optional refresh is pending.
 open(4);const cached=run('loadCharacters()');requests.shift().resolve({characters:cast('local cache'),needs_order_refresh:true});await tick();assert.ok(grid().includes('local cache'));assert.equal(element('#charactersStatus').textContent,'已显示本地资料，正在更新…');requests.shift().reject(new Error('network unavailable'));await cached;assert.ok(grid().includes('local cache'));assert.equal(element('#refreshCharacters').disabled,false);assert.equal(element('#charactersStatus').textContent,'更新失败，继续显示本地资料。');
 // No cache: fetching, failure and a successful retry have distinct persistent messages.
 open(6);const missing=run('loadCharacters()');requests.shift().resolve({characters:[]});await tick();assert.equal(element('#charactersStatus').textContent,'正在获取人物资料…');requests.shift().reject(new Error('offline'));await missing;assert.equal(element('#charactersStatus').textContent,'暂时无法获取人物资料，请点击刷新重试。');
 const retry=run('loadCharacters(true)');requests.shift().resolve({characters:[]});await tick();requests.shift().resolve({characters:cast('retry')});await retry;assert.equal(element('#charactersStatus').textContent,'人物资料已更新，并保存到本地。');
 open(7);const local=run('loadCharacters()');requests.shift().resolve({characters:cast('cached')});await local;assert.equal(element('#charactersStatus').textContent,'已显示本地人物资料。');
 // Closing the dialog discards late results and errors.
 open(5);const closed=run('loadCharacters()');element('#progressModal').open=false;requests.shift().resolve({characters:cast('closed')});await closed;assert.equal(grid(),'');
 console.log('Character requests: out-of-order GET/POST, stale errors, cached switches, reopening/deduplication, cache-first refresh and closed dialog passed');
})().catch(error=>{console.error(error);process.exitCode=1;});
