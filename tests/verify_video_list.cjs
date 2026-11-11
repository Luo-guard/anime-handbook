const fs=require('fs'),assert=require('node:assert/strict');const {chromium}=require('C:/Users/han/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
(async()=>{const b=await chromium.launch({headless:true});try{const p=await b.newPage({viewport:{width:1000,height:800}});const html=fs.readFileSync('static/index.html','utf8').replace(/<script[\s\S]*?<\/script>/g,'').replace(/<link[^>]*>/g,'');await p.setContent(`<style>${fs.readFileSync('static/styles.css','utf8')}</style>${html}`);await p.addScriptTag({content:`const $=s=>document.querySelector(s);const state={settings:{detail_links:[{id:'saved-video',kind:'saved_video',name:'已存视频',url:'',enabled:true},{id:'bgm',kind:'bgm',name:'Bangumi #{id}',url:'{site}/subject/{id}',enabled:true},{id:'bilibili',kind:'bilibili',name:'B站搜索',url:'https://search.bilibili.com/all?keyword={title}',enabled:true}]},progressAnime:{id:1,display_name:'测试番剧'}};const enabledSetting=k=>state.settings[k]!==false;const escapeHtml=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');let rows=[{id:1,title:'4K简中 · 穹庐下的魔女 全12话',uploader:'小宇Rrain',note:'简体',is_default:1,url:'https://www.bilibili.com/video/BV1AgHK6jE64/'}];let actions=[];let notifications=[];let features={optional_video_default:1};const api=async(path,options)=>{if(options){actions.push(JSON.parse(options.body));return {ok:true}}return {features,scope:'scope',items:rows}};const toast=m=>notifications.push(m);const jumps=[];function recordJump(payload){jumps.push(payload);window.__jumps=jumps;}`+fs.readFileSync('static/modules/video-links.js','utf8')});await p.evaluate(()=>{document.querySelector('#progressModal').showModal();return renderVideoLinks(1)});assert(await p.locator('#savedVideoSection').isVisible());assert.equal(await p.locator('#savedVideoSection').evaluate(e=>e.open),false);assert.equal(await p.locator('.saved-video-open').isVisible(),false);
await p.locator('#savedVideoSection summary').click();assert.equal(await p.locator('.saved-video-open').isVisible(),true);
await p.evaluate(()=>renderVideoLinks(1));assert.equal(await p.locator('#savedVideoSection').evaluate(e=>e.open),true,'refresh must preserve expansion');
const outer=await p.locator('#savedVideoSection').evaluate(e=>({background:getComputedStyle(e).backgroundColor,border:getComputedStyle(e).borderTopWidth,padding:getComputedStyle(e).padding}));assert.equal(outer.background,'rgba(0, 0, 0, 0)');assert.equal(outer.border,'0px');assert.equal(outer.padding,'0px');
await p.locator('#savedVideoSection summary').click();assert.equal(await p.locator('.saved-video-open').isVisible(),false);await p.locator('#savedVideoSection summary').focus();await p.keyboard.press('Enter');assert.equal(await p.locator('.saved-video-open').isVisible(),true);assert(await p.locator('#savedVideoDefaultLink').isVisible());const style=await p.locator('.saved-video-open').evaluate(el=>({decoration:getComputedStyle(el).textDecorationLine,color:getComputedStyle(el).color}));assert.equal(style.decoration,'none');assert.equal(await p.locator('.saved-video-badge').textContent(),'默认');await p.screenshot({path:'.online-test-data/saved-video-card.png'});
await p.evaluate(()=>{features={};return renderVideoLinks(1)});await p.locator('[data-video-action="unset_default"]').click();assert.equal(await p.evaluate(()=>actions.length),0);assert((await p.evaluate(()=>notifications.at(-1))).includes('旧后台'));
await p.evaluate(()=>{features={optional_video_default:1};return renderVideoLinks(1)});
await p.locator('[data-video-action="unset_default"]').click();assert.equal(await p.evaluate(()=>actions[0].action),'unset_default');
await p.evaluate(()=>{rows=rows.map(row=>({...row,is_default:0}));return renderVideoLinks(1)});assert.equal(await p.locator('#savedVideoDefaultLink').isVisible(),false);assert.equal(await p.locator('#savedVideoSection').isVisible(),true);assert.equal(await p.locator('[data-video-action="default"]').count(),1);
await p.evaluate(()=>{state.settings.merge_bilibili_links=true;return renderVideoLinks(1)});assert.equal(await p.locator('#detailLinks [data-detail-link-kind="bilibili"]').isVisible(),true);assert.equal(await p.locator('#savedVideoDefaultLink').isVisible(),false);
await p.evaluate(()=>{state.settings.merge_bilibili_links=false;rows=rows.map(row=>({...row,is_default:1}));return renderVideoLinks(1)});
await p.evaluate(()=>{state.settings.show_saved_video_list=false;return renderVideoLinks(1)});assert.equal(await p.locator('#savedVideoSection').isVisible(),false);assert.equal(await p.locator('#savedVideoDefaultLink').isVisible(),true);
await p.evaluate(()=>{state.settings.merge_bilibili_links=true;return renderVideoLinks(1)});assert.equal(await p.locator('#detailLinks [data-detail-link-kind="bilibili"]').isVisible(),false);assert.equal(await p.locator('#savedVideoDefaultLink').textContent(),'已存视频');assert.equal(await p.locator('#savedVideoDefaultLink').getAttribute('href'),'https://www.bilibili.com/video/BV1AgHK6jE64/');assert.equal(await p.locator('#savedVideoSection').isVisible(),false);
await p.evaluate(()=>{rows=[];return renderVideoLinks(1)});assert.equal(await p.locator('#detailLinks [data-detail-link-kind="bilibili"]').isVisible(),true);assert((await p.locator('#detailLinks [data-detail-link-kind="bilibili"]').getAttribute('href')).startsWith('https://search.bilibili.com/'));assert.equal(await p.locator('#savedVideoDefaultLink').isVisible(),false);
await p.evaluate(()=>{state.settings.merge_bilibili_links=false;rows=[{id:1,is_default:1,title:'video',url:'https://www.bilibili.com/video/BV1AgHK6jE64/'}];return renderVideoLinks(1)});assert.equal(await p.locator('#detailLinks [data-detail-link-kind="bilibili"]').isVisible(),true);assert.equal(await p.locator('#savedVideoDefaultLink').textContent(),'已存视频');
await p.evaluate(()=>{state.settings.show_saved_video_list=true;rows=[];return renderVideoLinks(1)});assert.equal(await p.locator('#savedVideoSection').isVisible(),false);assert.equal(await p.locator('#savedVideoDefaultLink').isVisible(),false);// 普通链接单独一块显示，不算“已存视频”，也没有默认概念。
await p.evaluate(()=>{state.settings.show_saved_video_list=true;state.settings.merge_bilibili_links=false;rows=[{id:9,kind:'link',title:'资料页',url:'https://example.com/wiki?q=1',note:'设定集',is_default:0}];return renderVideoLinks(1)});
assert.equal(await p.locator('#savedVideoSection').isVisible(),false);
assert.equal(await p.locator('#savedLinkSection').isVisible(),true);
assert.equal(await p.locator('#savedLinks .saved-video-title').textContent(),'资料页');
assert.equal(await p.locator('#savedLinks .saved-link-icon').count(),1);
assert.equal(await p.locator('#savedLinks .saved-video-play').count(),0);
assert.equal(await p.locator('#savedLinks [data-video-action="default"]').count(),0);
assert.equal(await p.locator('#savedVideoDefaultLink').isVisible(),false);
// 两类都有时各归各的区块。
await p.evaluate(()=>{rows=[{id:1,kind:'video',is_default:1,title:'视频A',url:'https://www.bilibili.com/video/BV1AgHK6jE64/'},{id:9,kind:'link',title:'资料页',url:'https://example.com/wiki?q=1'}];return renderVideoLinks(1)});
assert.equal(await p.locator('#savedVideoSection').isVisible(),true);
assert.equal(await p.locator('#savedLinkSection').isVisible(),true);
assert.equal(await p.locator('#savedVideoLinks .saved-video-title').textContent(),'视频A');
assert.equal(await p.locator('#savedLinks .saved-video-title').textContent(),'资料页');
assert.equal(await p.locator('#savedVideoDefaultLink').isVisible(),true);
// 打开外部链接不计入播放器历史。
await p.evaluate(()=>{window.__jumps=[];rows=[{id:1,kind:'video',is_default:1,title:'视频A',url:'https://www.bilibili.com/video/BV1AgHK6jE64/'},{id:9,kind:'link',title:'资料页',url:'https://example.com/wiki?q=1'}];state.progressAnime={id:1,display_name:'测试番剧'};return renderVideoLinks(1)});
await p.evaluate(()=>{document.querySelectorAll('.saved-video-open').forEach(a=>a.addEventListener('click',event=>event.preventDefault()));document.querySelectorAll('.saved-video-open')[0].click();document.querySelectorAll('.saved-video-open')[1].click();});
assert.deepEqual(await p.evaluate(()=>window.__jumps),[]);
// Resume uses main episode identities, never total watched count or stored P.
await p.evaluate(()=>{
  state.progressAnime={id:1,display_name:'测试番剧',episodes:[
    ...Array.from({length:24},(_,i)=>({key:`bgm:${100+i}`,type:0,sort:i+1,label:String(i+1)})),
    {key:'op:1',type:2,sort:1},{key:'ed:1',type:3,sort:1}
  ],watched_episodes:[...Array.from({length:16},(_,i)=>`bgm:${100+i}`),'op:1','ed:1']};
  state.pendingEpisodes=new Set(state.progressAnime.watched_episodes);
  rows=[{id:1,kind:'video',is_default:1,title:'合集',url:'https://www.bilibili.com/video/BV1AgHK6jE64/?p=8&t=20'},
    {id:9,kind:'link',title:'普通链接',url:'https://www.bilibili.com/video/BV1AgHK6jE64/?p=8'}];
  return renderVideoLinks(1);
});
const defaultUrl=()=>p.locator('#savedVideoDefaultLink').getAttribute('href');
assert.equal(new URL(await defaultUrl()).searchParams.get('p'),'17');
assert.equal(new URL(await defaultUrl()).searchParams.has('t'),false);
assert.equal(new URL(await p.locator('#savedVideoLinks .saved-video-open').getAttribute('href')).searchParams.get('p'),'17');
assert.equal(new URL(await p.locator('#savedLinks .saved-video-open').getAttribute('href')).searchParams.get('p'),'8');
await p.evaluate(()=>{const a=document.querySelector('#savedVideoDefaultLink');a.addEventListener('click',e=>e.preventDefault());a.click()});
assert.deepEqual(await p.evaluate(()=>window.__jumps),[]);
await p.evaluate(()=>{state.pendingEpisodes.add('bgm:116');refreshSavedVideoTargets()});
assert.equal(new URL(await defaultUrl()).searchParams.get('p'),'18');
await p.evaluate(()=>{state.pendingEpisodes.delete('bgm:109');refreshSavedVideoTargets()});
assert.equal(new URL(await defaultUrl()).searchParams.get('p'),'10','a gap resumes the first unwatched main episode');
await p.evaluate(()=>{state.pendingEpisodes=new Set(state.progressAnime.episodes.map(e=>e.key));refreshSavedVideoTargets()});
assert.equal(new URL(await defaultUrl()).searchParams.get('p'),'24','completed series must not point beyond its last main episode');
await p.evaluate(()=>{state.pendingEpisodes.clear();refreshSavedVideoTargets()});
assert.equal(new URL(await defaultUrl()).searchParams.get('p'),'1');
assert.equal(await p.evaluate(()=>rows[0].url),'https://www.bilibili.com/video/BV1AgHK6jE64/?p=8&t=20','saved source URL is never overwritten');
await p.evaluate(()=>{state.progressAnime.episodes=[];refreshSavedVideoTargets()});
assert.equal(await defaultUrl(),'https://www.bilibili.com/video/BV1AgHK6jE64/?p=8&t=20','unknown chapters retain the source URL');
assert.equal(await p.evaluate(()=>bilibiliResumeUrl({url:'https://example.com/watch?p=8',kind:'video'},state.progressAnime)),'https://example.com/watch?p=8');
// Official seasons resolve cached ep identities rather than computing IDs.
await p.evaluate(()=>{
 state.progressAnime.episodes=Array.from({length:24},(_,i)=>({key:`bgm:${100+i}`,type:0,sort:i+1}));
 state.pendingEpisodes=new Set(Array.from({length:16},(_,i)=>`bgm:${100+i}`));
 rows=[{id:5,kind:'video',is_default:1,title:'Official',url:'https://www.bilibili.com/bangumi/play/ss1293',episode_urls:{'17':'https://www.bilibili.com/bangumi/play/ep90001','18':'https://www.bilibili.com/bangumi/play/ep70003'}}];
 return renderVideoLinks(1);
});
assert.equal(await defaultUrl(),'https://www.bilibili.com/bangumi/play/ep90001');
assert.equal(await p.locator('#savedVideoLinks .saved-video-open').getAttribute('href'),'https://www.bilibili.com/bangumi/play/ep90001');
await p.evaluate(()=>{state.pendingEpisodes.add('bgm:116');refreshSavedVideoTargets()});
assert.equal(await defaultUrl(),'https://www.bilibili.com/bangumi/play/ep70003');
await p.evaluate(()=>{state.pendingEpisodes.add('bgm:117');refreshSavedVideoTargets()});
assert.equal(await defaultUrl(),'https://www.bilibili.com/bangumi/play/ss1293');
assert.equal(await p.evaluate(()=>parseVideoCapture('#save-video='+encodeURIComponent(JSON.stringify({url:'https://www.bilibili.com/bangumi/play/ep35595',title:'official',kind:'video'}))).kind),'video');
console.log('Bilibili resume: 16 -> P17, OP/ED exclusion, pending progress, gaps, completion, source URL and ordinary links preserved.');
console.log('Saved video cards: theme styling, no underline, default badge, hidden list retains shortcut, merged/separate modes, no-video fallback, empty state the separate saved-links block and playback-history isolation passed.');}finally{await b.close()}})().catch(e=>{console.error(e);process.exit(1)});
