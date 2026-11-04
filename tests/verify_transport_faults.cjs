const fs=require('fs'),vm=require('vm'),assert=require('node:assert/strict');
const network=fs.readFileSync('static/modules/network.js','utf8');
const response=(data={},status=200)=>({ok:status<400,status,headers:{get:()=> '0'},json:async()=>data});
function harness(fetch){const ctx=vm.createContext({window:{},fetch,AbortController,setTimeout,clearTimeout,console});vm.runInContext(network,ctx);return ctx;}
const run=(ctx,code)=>vm.runInContext(code,ctx);
(async()=>{
 let calls=0;
 const ctx=harness(async()=>{calls++;return response({ok:true});});
 assert.equal((await run(ctx,'api("/api/test")')).ok,true);
 ctx.fetch=async()=>response({message:'validation rejected'},400);
 await assert.rejects(run(ctx,'api("/api/test")'),/validation rejected/);
 ctx.fetch=async()=>{throw new TypeError('network down')};
 await assert.rejects(run(ctx,'api("/api/test")'),/无法连接/);
 ctx.fetch=async()=>({...response(),json:async()=>{throw Error('truncated JSON')}});
 await assert.rejects(run(ctx,'api("/api/test")'),/响应不完整/);
 calls=0;ctx.fetch=()=>{calls++;return new Promise(()=>{});};
 await assert.rejects(run(ctx,'api("/api/notes",{method:"POST",body:"{}",timeoutMs:15})'),error=>error.name==='TimeoutError');
 assert.equal(calls,1,'writes must never automatically retry');assert.equal(run(ctx,'pendingDesktopWrites'),0);
 ctx.fetch=async()=>({...response(),json:()=>new Promise(()=>{})});
 await assert.rejects(run(ctx,'api("/api/test",{timeoutMs:15})'),error=>error.name==='TimeoutError');
 ctx.controller=new AbortController();ctx.fetch=()=>new Promise(()=>{});
 const pending=run(ctx,'api("/api/test",{signal:controller.signal,timeoutMs:1000})');ctx.controller.abort();
 await assert.rejects(pending,error=>error.name==='AbortError');
 calls=0;ctx.fetch=async()=>{calls++;return response()};
 await assert.rejects(run(ctx,'api("/api/test",{signal:controller.signal})'),error=>error.name==='AbortError');assert.equal(calls,0);
 // A timed-out queued online write must not execute after authentication recovers.
 let releaseAuth,writes=0;
 const online=harness(async(path,options={})=>{
   if(path==='/api/auth/me')return new Promise(resolve=>releaseAuth=()=>resolve(response({csrf:'fixture',read_only:false})));
   if(options.method)writes++;
   return response({ok:true});
 });
 Object.assign(online,{state:{},location:{replace(){}},document:{querySelector:()=>null,createElement:()=>({}),body:{append(){}}},setInterval(){},clearInterval(){}});
 vm.runInContext(fs.readFileSync('server/static/online.js','utf8'),online);
 await assert.rejects(run(online,'api("/api/notes",{method:"POST",body:"{}",timeoutMs:15})'),error=>error.name==='TimeoutError');
 releaseAuth();await new Promise(resolve=>setTimeout(resolve,5));assert.equal(writes,0);
 assert.equal((await run(online,'api("/api/notes",{method:"POST",body:"{}",timeoutMs:1000})')).ok,true);
 assert.equal(writes,1);
 console.log('Transport faults: offline, slow headers/body, malformed JSON, upstream abort, pending-write release, no mutation retry and canceled online queue passed.');
})().catch(error=>{console.error(error);process.exit(1)});
