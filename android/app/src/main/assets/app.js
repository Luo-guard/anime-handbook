const native = window.AndroidHandbook; const app=document.querySelector('#app'); let page='home', category=1, selected=null;
let persistedState=native.state(),state=JSON.parse(persistedState); const tables=()=>state.tables||(state.tables={anime:[],events:[],settings:[],custom_collections:[],custom_collection_items:[],ranking_boards:[],ranking_templates:[],ranking_tiers:[],ranking_items:[]});
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); const name=a=>a.name_cn||a.name||(a.id?`Bangumi #${a.id}`:'未关联番剧');
function recordIdentity(){const bytes=crypto.getRandomValues(new Uint8Array(16));return {record_uid:Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join(''),updated_at:nowIso()}}
function nowIso(){const d=new Date(),p=n=>String(n).padStart(2,'0'),minutes=-d.getTimezoneOffset(),sign=minutes>=0?'+':'-',offset=Math.abs(minutes);return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${sign}${p(Math.floor(offset/60))}:${p(offset%60)}`}
function formatTime(value){const d=new Date(value);return Number.isNaN(d.getTime())?String(value||''):new Intl.DateTimeFormat('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).format(d).replace(/\//g,'-')}
function save(){
 state.exported_at=nowIso();
 const snapshot=JSON.stringify(state);
 if(native.saveState(snapshot,persistedState)===true){persistedState=snapshot;return true}
 persistedState=native.state();state=JSON.parse(persistedState);
 alert('修改尚未保存：本地数据可能刚被同步更新，或手机存储不可写。请检查后重试，记录草稿仍会保留。');
 return false;
}
function cover(a){return a.image_url?`style="background-image:url('${esc('https://covers.animehandbook.local/?url='+encodeURIComponent(a.image_url))}')"`:''} function animes(){return tables().anime||[]}
function settingMap(){const result={};for(const item of tables().settings||[]){try{result[item.key]=JSON.parse(item.value)}catch(_){result[item.key]=item.value}}return result}
function collectionComparator(){
 const settings=settingMap(), key=String(category), mode=(settings.collection_sort_modes||{})[key]||'name', direction=(settings.collection_sort_directions||{})[key]||'asc';
 const byName=(a,b)=>name(a).localeCompare(name(b),'zh-CN'); let compare=byName;
 if(mode==='rank')compare=(a,b)=>(Number(a.bgm_rank)||999999999)-(Number(b.bgm_rank)||999999999)||byName(a,b);
 if(mode==='popularity')compare=(a,b)=>(Number(b.bgm_rating_total)||0)-(Number(a.bgm_rating_total)||0)||byName(a,b);
 if(mode==='airdate')compare=(a,b)=>String(a.air_date||'9999-99-99').localeCompare(String(b.air_date||'9999-99-99'))||byName(a,b);
 if(mode==='kazumi')compare=(a,b)=>{const at=x=>String(x.collection_added_at||x.kazumi_updated_at||''),l=at(a),r=at(b);return l===r?(Number(b.kazumi_position||0)-Number(a.kazumi_position||0)||byName(a,b)):(r>l?1:-1)};
 if(mode==='custom')compare=(a,b)=>Number(a.custom_sort_order||0)-Number(b.custom_sort_order||0)||byName(a,b);
 return direction==='desc'?(a,b)=>compare(b,a):compare;
}
function collectionItems(){
 const settings=settingMap(), customized=new Set((tables().custom_collection_items||[]).map(item=>Number(item.anime_id)));
 return animes().filter(a=>Number(a.collection_type)===category&&a.active!==0&&!(settings.hide_custom_collection_items_from_builtin!==false&&customized.has(Number(a.id)))).sort(collectionComparator());
}
function dayKey(value,dayStart){const d=new Date(value);d.setHours(d.getHours()-dayStart);return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`}
function balance(){const s=settingMap(), anchor=String(s.episode_balance_anchor||'');if(!/^\d{4}-\d{2}-\d{2}$/.test(anchor)||s.show_episode_balance===false)return null;const start=new Date(`${anchor}T00:00:00`), today=new Date(`${dayKey(new Date(),Number(s.day_start_hour??4))}T00:00:00`), days=Math.max(0,Math.round((today-start)/86400000)), watched=(tables().events||[]).filter(e=>e.event_type==='watch'&&dayKey(e.created_at,Number(s.day_start_hour??4))>=anchor).reduce((n,e)=>{try{return n+JSON.parse(e.episodes||'[]').length}catch(_){return n}},0);return Number(s.episode_balance_initial??237)+days*Number(s.episode_balance_daily_target??8)-watched}
function balanceText(){const value=balance();if(value===null)return '';return value>0?`还欠 ${value} 集`:value<0?`超前 ${Math.abs(value)} 集`:'刚好追平'}
function home(){ const cats=[[1,'在看'],[2,'想看'],[3,'搁置'],[4,'看过'],[5,'抛弃']]; const list=collectionItems(); app.innerHTML=`<div class="section-title"><h2>${cats.find(x=>x[0]===category)?.[1]||'收藏'}</h2><span>${list.length} 部</span></div>${balanceText()?`<div class="balance">${balanceText()}</div>`:''}<div class="chips">${cats.map(x=>`<button class="chip ${x[0]===category?'active':''}" onclick="setCat(${x[0]})">${x[1]}</button>`).join('')}</div>${list.length?`<div class="grid">${list.map(a=>`<button class="anime" onclick="openAnime(${a.id})"><div class="cover" ${cover(a)}>${a.image_url?'':esc(name(a).slice(0,10))}</div><div class="info"><b>${esc(name(a))}</b><small>已看 ${(JSON.parse(a.watched_episodes||'[]')).length} 集</small></div></button>`).join('')}</div>`:'<div class="empty">这里还没有番剧。先在电脑端同步收藏，再到手机点同步下载。</div>'}`; }
function arrayValue(value){try{const result=typeof value==='string'?JSON.parse(value):value;return Array.isArray(result)?result:[]}catch(_){return []}}
function episodeList(anime){
 const list=arrayValue(anime.episodes);if(list.length)return list;
 const count=Number(anime.episode_count);if(!Number.isInteger(count)||count<=0)return [];
 return Array.from({length:count},(_,i)=>({key:String(i+1).padStart(2,'0'),display_label:String(i+1),type:0}));
}
function episodeType(e){const n=Number(e.type??String(e.key).match(/^(\d+):/)?.[1]??0);return Number.isFinite(n)?n:0}
function typeLabel(type){return ({0:'本篇',1:'特别篇',2:'OP',3:'ED',4:'预告',5:'MAD',6:'其他'})[type]||'其他'}
function detail(){
 const a=animes().find(x=>Number(x.id)===Number(selected));if(!a){selected=null;home();return}
 const groups=new Map();for(const e of episodeList(a)){const type=episodeType(e);if(!groups.has(type))groups.set(type,[]);groups.get(type).push(e)}
 const done=new Set(arrayValue(a.watched_episodes).map(String));
 app.innerHTML=`<button class="back" onclick="backHome()">← 返回收藏</button><div class="detail-cover" ${cover(a)}><h2>${esc(name(a))}</h2></div>${groups.size?[...groups].map(([type,eps])=>`<div class="panel"><div class="episode-heading"><b>${typeLabel(type)}</b><small data-group-count="${type}"></small></div><div class="episode">${eps.map(e=>`<button data-episode-key="${esc(e.key)}" data-episode-type="${type}" class="${done.has(String(e.key))?'done':''}" aria-pressed="${done.has(String(e.key))}">${esc(e.display_label||e.key)}</button>`).join('')}</div></div>`).join(''):'<div class="empty">剧集资料暂缺，暂无可标记的集数。</div>'}`;
 app.querySelectorAll('[data-episode-key]').forEach(button=>button.onclick=()=>toggleEpisode(a.id,button.dataset.episodeKey));
 updateEpisodeButtons();
}
function updateEpisodeButtons(){
 const a=animes().find(x=>Number(x.id)===Number(selected));if(!a)return;
 const done=new Set(arrayValue(a.watched_episodes).map(String));
 app.querySelectorAll('[data-episode-key]').forEach(button=>{const watched=done.has(button.dataset.episodeKey);button.classList.toggle('done',watched);button.setAttribute('aria-pressed',String(watched))});
 app.querySelectorAll('[data-group-count]').forEach(label=>{const buttons=[...app.querySelectorAll('[data-episode-key]')].filter(b=>b.dataset.episodeType===label.dataset.groupCount);label.textContent=`已看 ${buttons.filter(b=>done.has(b.dataset.episodeKey)).length} / ${buttons.length}`});
}
function eventEpisodeText(e){
 const keys=arrayValue(e.episodes);if(!keys.length)return '';
 const anime=animes().find(a=>Number(a.id)===Number(e.anime_id)),episodes=anime?episodeList(anime):[],groups=new Map();
 for(const key of keys){const ep=episodes.find(item=>String(item.key)===String(key)),label=ep?typeLabel(episodeType(ep)):'集数';if(!groups.has(label))groups.set(label,[]);groups.get(label).push(ep?.display_label||String(key))}
 return [...groups].map(([label,items])=>`${label} ${items.join('、')}`).join(' · ');
}
function records(){const list=[...tables().events].sort((a,b)=>new Date(b.created_at).getTime()-new Date(a.created_at).getTime());app.innerHTML=`<div class="section-title"><h2>看番记录</h2><button onclick="noteForm()">写记录</button></div>${balanceText()?`<div class="balance">${balanceText()}</div>`:''}${list.length?list.map(e=>{const episode=eventEpisodeText(e), title=e.event_type==='watch'?'观看记录':e.event_type==='anime_comment'?'番剧评论':'其他记录';return `<article class="card record"><small>${esc(formatTime(e.created_at))}</small><h3>${esc(title)}${episode?` · ${esc(episode)}`:''}</h3><b>${esc(name(animes().find(a=>a.id===e.anime_id)||{} )||'未关联番剧')}</b>${e.content?`<p>${esc(e.content)}</p>`:''}</article>`}).join(''):'<div class="empty">还没有记录。</div>'}`;}
function noteForm(){
 const opening=!composerOpen;if(opening)persistUi();composerOpen=true;
 app.innerHTML=`<button class="back" onclick="showPage('records')">← 返回记录</button><div class="panel form"><h2>写记录</h2><label>内容</label><textarea id="content" placeholder="今天看了什么？"></textarea><button class="primary" onclick="addNote()">保存到手机</button></div>`;
 document.querySelector('#content').value=ui.noteDraft||'';if(opening){restorePosition();persistUi()}
}
function settings(){const c=JSON.parse(native.config());app.innerHTML=`<div class="panel form"><h2>坚果云同步</h2><p class="notice">密码只留在手机应用的私有存储中；留空不会覆盖已保存密码。</p><label>WebDAV 地址</label><input id="url" value="${esc(c.url||'https://dav.jianguoyun.com/dav/')}"><label>坚果云账号</label><input id="username" value="${esc(c.username)}"><label>坚果云应用密码</label><input id="password" type="password" placeholder="${c.passwordSet?'已保存，留空即可':'请输入应用密码'}"><label>云端账号标识</label><input id="account" value="${esc(c.account)}"><label class="compact-check"><input id="autoSync" type="checkbox" ${c.autoSync!==false?'checked':''}> 每 30 分钟自动同步</label><button class="primary" onclick="saveConfig()">保存配置</button><button class="secondary" onclick="requestSync()">立即同步</button></div>`;configInitial=JSON.stringify(readConfigForm(false));if(ui.configDraft){for(const key of ['url','username','account'])document.querySelector('#'+key).value=ui.configDraft[key]??'';document.querySelector('#autoSync').checked=ui.configDraft.auto_sync!==false}}
// Device-only UI state never enters the WebDAV account snapshot.
let ui={positions:{},noteDraft:'',configDraft:null},composerOpen=false,configInitial='',rendering=false;
try{if(native.uiState)ui={...ui,...JSON.parse(native.uiState())}}catch(_){}
if(!ui.positions||typeof ui.positions!=='object')ui.positions={};
function viewKey(){return composerOpen?'composer':selected!==null?`detail:${selected}`:page==='home'?`home:${category}`:page}
function captureDraft(){
 const input=document.querySelector('#content');if(input)ui.noteDraft=input.value;
 if(document.querySelector('#url'))ui.configDraft=readConfigForm(false);
}
function persistUi(){
 if(rendering)return;
 captureDraft();ui.page=page;ui.category=category;ui.selected=selected;ui.composer=composerOpen;ui.positions[viewKey()]=window.scrollY;
 if(native.saveUiState)native.saveUiState(JSON.stringify(ui));
}
function readConfigForm(includePassword=true){const get=id=>document.querySelector('#'+id);return {url:get('url').value,username:get('username').value,account:get('account').value,auto_sync:get('autoSync').checked,...(includePassword?{password:get('password').value}:{})}}
function mayLeave(){
 const note=document.querySelector('#content');
 if(note&&note.value.trim())return confirm('记录尚未保存，草稿会保留在手机。是否离开？');
 if(document.querySelector('#url')&&(JSON.stringify(readConfigForm(false))!==configInitial||document.querySelector('#password').value))return confirm('配置尚未保存，是否离开？');
 return true;
}
function restorePosition(){window.scrollTo(0,Number(ui.positions[viewKey()])||0)}
function syncNav(){document.querySelectorAll('nav button').forEach(b=>b.classList.toggle('active',b.dataset.page===page))}

function showPage(p){if(!mayLeave())return;persistUi();page=p;selected=null;composerOpen=false;render();syncNav();restorePosition();persistUi()}
function render(){rendering=true;try{if(selected!==null)return detail();if(composerOpen)return noteForm();if(page==='records')return records();if(page==='settings')return settings();home()}finally{rendering=false}}
function setCat(c){persistUi();category=c;render();restorePosition();persistUi()}
function openAnime(id){persistUi();selected=id;composerOpen=false;render();restorePosition();persistUi()}
function backHome(){persistUi();selected=null;page='home';render();syncNav();restorePosition();persistUi()}
function handleBack(){if(selected!==null){backHome();return true}if(composerOpen){showPage('records');return true}if(page!=='home'){showPage('home');return true}return false}
function toggleEpisode(id,key){const a=animes().find(x=>x.id===id);let w=JSON.parse(a.watched_episodes||'[]'), watched=!w.includes(key);w=watched?[...w,key]:w.filter(x=>x!==key);a.watched_episodes=JSON.stringify(w);a.updated_at=nowIso();const events=tables().events;if(watched){events.push({...recordIdentity(),id:Date.now(),event_type:'watch',anime_id:id,episodes:JSON.stringify([key]),content:'',theme:'watch',themes:'["watch"]',rating:null,raw_directives:'',created_at:nowIso()})}else{const index=[...events].reverse().findIndex(e=>e.event_type==='watch'&&Number(e.anime_id)===Number(id)&&(()=>{try{return JSON.parse(e.episodes||'[]').includes(key)}catch(_){return false}})());if(index>=0){const actual=events.length-1-index,event=events[actual],remaining=JSON.parse(event.episodes||'[]').filter(item=>item!==key);if(remaining.length)event.episodes=JSON.stringify(remaining);else events.splice(actual,1)}}save();updateEpisodeButtons();persistUi()}
function addNote(){const content=document.querySelector('#content').value.trim();if(!content)return;const events=tables().events;events.push({...recordIdentity(),id:Date.now(),event_type:'note',anime_id:null,episodes:'[]',content,theme:'other',themes:'["other"]',rating:null,raw_directives:'',created_at:nowIso()});if(save()){ui.noteDraft='';document.querySelector('#content').value='';showPage('records')}}
function saveConfig(){if(native.saveConfig(JSON.stringify(readConfigForm()))===false){alert('配置保存失败，请重试');return}ui.configDraft=null;document.querySelector('#password').value='';configInitial=JSON.stringify(readConfigForm(false));persistUi();alert('坚果云配置已保存')}
function requestSync(resolution=''){native.sync(resolution)} window.HandbookMobile={completeSync(raw,silent=false){const r=JSON.parse(raw);if(r.error){if(!silent)alert(r.error);return}if(r.conflict){if(silent)return;if(confirm('手机和云端都修改过。确定：以手机为准；取消：以云端为准。'))requestSync('local');else requestSync('remote');return}if(r.state){
 // Read the latest persisted snapshot, including edits made after the network finished.
 persistedState=native.state();state=JSON.parse(persistedState);
 const editing=!!document.querySelector('#content')||!!document.querySelector('#url');
 if(!editing){const y=window.scrollY;if(selected!==null)updateEpisodeButtons();else render();window.scrollTo(0,y)}
 }if(!silent)alert(r.pendingLocal?'同步已完成；期间的新修改已保留在手机，等待下次同步。':r.message||'同步完成')}};
document.querySelectorAll('nav button').forEach(b=>b.onclick=()=>showPage(b.dataset.page));document.querySelector('#sync').onclick=()=>requestSync();
app.addEventListener('input',persistUi);app.addEventListener('change',persistUi);
let scrollTimer;window.addEventListener('scroll',()=>{clearTimeout(scrollTimer);scrollTimer=setTimeout(persistUi,100)},{passive:true});
window.addEventListener('pagehide',persistUi);
window.HandbookMobile.handleBack=handleBack;window.HandbookMobile.persistUi=persistUi;
if(['home','records','settings'].includes(ui.page))page=ui.page;
if([1,2,3,4,5].includes(ui.category))category=ui.category;
selected=ui.selected??null;composerOpen=ui.composer===true&&selected===null;
render();syncNav();restorePosition();
