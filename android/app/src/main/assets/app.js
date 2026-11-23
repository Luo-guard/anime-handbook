const native = window.AndroidHandbook; const app=document.querySelector('#app'); let page='home', category=1, selected=null;
let persistedState=native.state(),state=JSON.parse(persistedState); const tables=()=>state.tables||(state.tables={anime:[],events:[],settings:[],custom_collections:[],custom_collection_items:[],ranking_boards:[],ranking_templates:[],ranking_tiers:[],ranking_items:[]});
const ICON={
 play:'<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.2v13.6c0 .8.9 1.3 1.6.9l10.4-6.8c.6-.4.6-1.4 0-1.8L9.6 4.3C8.9 3.9 8 4.4 8 5.2z"/></svg>',
 rule:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M14.9 9.1l-1.7 4.1-4.1 1.7 1.7-4.1 4.1-1.7z"/></svg>',
 back:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.5 6l-6 6 6 6"/></svg>',
 dm:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6.5h16M4 12h11M4 17.5h7"/></svg>',
 theme:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/></svg>',
 cloud:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 18h10a4 4 0 0 0 .6-8 6 6 0 0 0-11.4 1.6A3.2 3.2 0 0 0 7 18z"/></svg>',
 info:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8h.01"/></svg>',
 film:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="5" width="17" height="14" rx="2.5"/><path d="M8 5v14M16 5v14M3.5 12h17"/></svg>',
};
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
function animeCard(a){
 const total=episodeList(a).length, seen=arrayValue(a.watched_episodes).length;
 const percent=total?Math.min(100,Math.round(seen/total*100)):0;
 return `<button class="anime" onclick="openAnime(${a.id})">
  <div class="cover" ${cover(a)}>${total?`<span class="cover-badge">${seen}/${total}</span>`:''}</div>
  <div class="info"><b>${esc(name(a))}</b><small>${total?`已看 ${seen} / ${total} 集`:`已看 ${seen} 集`}</small>${percent?`<span class="progress"><i style="width:${percent}%"></i></span>`:''}</div>
 </button>`;
}
function home(){
 const cats=[[1,'在看'],[2,'想看'],[3,'搁置'],[4,'看过'],[5,'抛弃']];
 const list=collectionItems(), label=cats.find(x=>x[0]===category)?.[1]||'收藏';
 const counts={};
 for(const item of animes()){const type=Number(item.collection_type);if(item.active!==0&&type)counts[type]=(counts[type]||0)+1}
 app.innerHTML=`
 <div class="quick-row">
  <button class="quick" onclick="playLocal()"><span class="quick-icon">${ICON.play}</span><span class="quick-text">本机视频<small>播放本地文件</small></span></button>
  <button class="quick" onclick="openRulesPage()"><span class="quick-icon">${ICON.rule}</span><span class="quick-text">规则找片源<small>按番名搜站点</small></span></button>
 </div>
 <div class="section-title"><h2>${label}</h2><span>${list.length} 部</span></div>
 ${balanceText()?`<div class="balance">${balanceText()}</div>`:''}
 <div class="chips">${cats.map(x=>`<button class="chip ${x[0]===category?'active':''}" onclick="setCat(${x[0]})">${x[1]}<small>${counts[x[0]]||0}</small></button>`).join('')}</div>
 ${list.length?`<div class="grid">${list.map(animeCard).join('')}</div>`:'<div class="empty">这里还没有番剧。<br>先在电脑端同步收藏，再到手机点右上角同步。</div>'}`;
}
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
 const list=episodeList(a), groups=new Map();
 for(const e of list){const type=episodeType(e);if(!groups.has(type))groups.set(type,[]);groups.get(type).push(e)}
 const done=new Set(arrayValue(a.watched_episodes).map(String));
 const meta=[`${done.size} / ${list.length||'?'} 集`];
 if(a.air_date)meta.push(String(a.air_date).slice(0,10));
 if(a.bgm_rating)meta.push(`★ ${a.bgm_rating}`);
 app.innerHTML=`
 <div class="detail-top"><button class="back" onclick="backHome()">${ICON.back}<span>收藏</span></button></div>
 <div class="detail-cover" ${cover(a)}><div class="hero-text"><h2>${esc(name(a))}</h2><div class="hero-meta">${meta.map(text=>`<span>${esc(text)}</span>`).join('')}</div></div></div>
 ${groups.size?[...groups].map(([type,eps])=>`<div class="panel"><div class="episode-heading"><b>${typeLabel(type)}</b><small data-group-count="${type}"></small></div><div class="episode">${eps.map(e=>`<button data-episode-key="${esc(e.key)}" data-episode-type="${type}" class="${done.has(String(e.key))?'done':''}" aria-pressed="${done.has(String(e.key))}">${esc(e.display_label||e.key)}</button>`).join('')}</div></div>`).join(''):'<div class="empty">剧集资料暂缺，暂无可标记的集数。</div>'}`;
 app.querySelectorAll('[data-episode-key]').forEach(button=>button.onclick=()=>toggleEpisode(a.id,button.dataset.episodeKey));
 // Kazumi 式播放入口：固定在视口右下角的悬浮键，滚动时不随内容移动
 const fab=document.createElement('button');
 fab.className='play-fab';
 fab.setAttribute('aria-label',`播放 ${name(a)}`);
 fab.innerHTML=`${ICON.play}<span>播放</span>`;
 fab.onclick=()=>playAnime(a.id);
 app.append(fab);
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
function records(){
 const list=[...tables().events].sort((a,b)=>new Date(b.created_at).getTime()-new Date(a.created_at).getTime());
 app.innerHTML=`<div class="section-title"><h2>看番记录</h2><button onclick="noteForm()">写记录</button></div>${balanceText()?`<div class="balance">${balanceText()}</div>`:''}${list.length?list.map(e=>{
  const episode=eventEpisodeText(e);
  const title=e.event_type==='watch'?'观看记录':e.event_type==='anime_comment'?'番剧评论':e.event_type==='note'?'随手记录':'其他记录';
  return `<article class="card record">
   <div class="record-head"><span class="record-type">${title}</span><span class="record-date">${esc(formatTime(e.created_at))}</span></div>
   ${episode?`<h3>${esc(episode)}</h3>`:''}
   <b>${esc(name(animes().find(a=>a.id===e.anime_id)||{})||'未关联番剧')}</b>
   ${e.content?`<p>${esc(e.content)}</p>`:''}
  </article>`;
 }).join(''):'<div class="empty">还没有记录。<br>点右上角「写记录」记下今天看的番。</div>'}`;
}
function noteForm(){
 const opening=!composerOpen;if(opening)persistUi();composerOpen=true;
 app.innerHTML=`<div class="detail-top"><button class="back" onclick="showPage('records')">${ICON.back}<span>记录</span></button></div><div class="form"><h2>写记录</h2><label>内容</label><textarea id="content" placeholder="今天看了什么？"></textarea><button class="primary" onclick="addNote()">保存到手机</button></div>`;
 document.querySelector('#content').value=ui.noteDraft||'';if(opening){restorePosition();persistUi()}
}
function readLocal(key,fallback){try{const raw=localStorage.getItem(key);return raw===null?fallback:JSON.parse(raw)}catch(_){return fallback}}
function writeLocal(key,value){try{localStorage.setItem(key,JSON.stringify(value))}catch(_){/* 存储不可写时不影响其它功能 */}}
const PREF_KEY='mobile-player:prefs',DM_KEY='handbook.danmaku.settings',THEME_KEY='mobile-app:theme';
const APP_VERSION=(()=>{try{return String(native.version?native.version():'')||'1.0.23'}catch(_){return '1.0.23'}})();
function playerPrefs(){const value=readLocal(PREF_KEY,{});return value&&typeof value==='object'?value:{}}
function savePref(patch){writeLocal(PREF_KEY,{...playerPrefs(),...patch});try{window.HandbookPlayer?.applyPrefs?.()}catch(_){}}
function dmPrefs(){const value=readLocal(DM_KEY,{});return value&&typeof value==='object'?value:{}}
function saveDm(patch){writeLocal(DM_KEY,{...dmPrefs(),...patch});if(typeof dmLoadPrefs==='function'){try{dmLoadPrefs();dmSyncControls();}catch(_){}}
 if(window.HandbookPlayer?.commitDanmakuPrefs)window.HandbookPlayer.commitDanmakuPrefs();}
function applyTheme(mode){const value=['light','dark'].includes(mode)?mode:'auto';writeLocal(THEME_KEY,value);
 const dark=value==='dark'||(value==='auto'&&Boolean(window.matchMedia?.('(prefers-color-scheme: dark)')?.matches));
 document.documentElement.dataset.theme=dark?'dark':'light';document.documentElement.dataset.themeMode=value;}
function toast(text){let node=document.querySelector('#appToast');if(!node){node=document.createElement('p');node.id='appToast';node.setAttribute('role','status');document.body.append(node)}
 node.textContent=text;node.classList.add('is-visible');clearTimeout(toast.timer);toast.timer=setTimeout(()=>node.classList.remove('is-visible'),2000)}
function playLocal(){if(window.HandbookPlayer?.showLocal)window.HandbookPlayer.showLocal();else window.HandbookPlayer?.show()}
function openRulesPage(){if(window.HandbookRules?.isOpen())return;window.HandbookRules?.open('app');syncNav('rules')}
function playAnime(id){
 // Kazumi「开始观看」：详情页悬浮键只负责规则播放（聚合搜索所有规则）；
 // 本地视频统一走主界面的「本机视频」。
 const a=animes().find(x=>Number(x.id)===Number(id));if(!a)return;
 window.HandbookRules?.searchNow(name(a));
}
function options(list,current){return list.map(([value,label])=>`<option value="${esc(value)}"${String(value)===String(current)?' selected':''}>${esc(label)}</option>`).join('')}
function settings(){
 const c=JSON.parse(native.config()||'{}');
 const pref=playerPrefs(),dm={...dmPrefs()},theme=readLocal(THEME_KEY,'auto');
 const rules=window.HandbookRules?.count?.()||0;
 app.innerHTML=`<div class="page-title-bar"><h2>设置</h2><p>播放、弹幕、规则和同步都在这里</p></div>

<section class="group"><h3>${ICON.play}播放</h3><div class="group-body">
 <label class="setting-row"><span>默认倍速</span><select id="setSpeed">${options([[0.75,'0.75x'],[1,'1.0x'],[1.25,'1.25x'],[1.5,'1.5x'],[2,'2.0x']],pref.speed??1)}</select></label>
 <label class="setting-row"><span>快进步长</span><select id="setSkip">${options([[15,'15 秒'],[30,'30 秒'],[60,'60 秒'],[80,'80 秒'],[120,'120 秒']],pref.skip??80)}</select></label>
 <label class="setting-row"><span>默认超分</span><select id="setQuality">${options([['off','关闭'],['fast','效率档 2×'],['quality','质量档 2×']],pref.quality||'off')}</select></label>
 <label class="setting-row stacked"><span>自动连播下一集<small>播完停 5 秒，再进下一集</small></span><input type="checkbox" class="switch-input" id="setAutoNext" ${pref.autoNext!==false?'checked':''}></label>
 <label class="setting-row stacked"><span>记住播放进度<small>关闭后每次从片头开始</small></span><input type="checkbox" class="switch-input" id="setRemember" ${pref.remember!==false?'checked':''}></label>
</div></section>

<section class="group"><h3>${ICON.dm}弹幕</h3><div class="group-body">
 <label class="setting-row stacked"><span>默认显示弹幕</span><input type="checkbox" class="switch-input" id="setDmEnabled" ${dm.enabled!==false?'checked':''}></label>
 <label class="setting-row"><span>字号 <b id="setDmFontValue">${dm.fontSize??24}</b></span><input type="range" id="setDmFont" min="16" max="40" step="1" value="${dm.fontSize??24}"></label>
 <label class="setting-row"><span>不透明度 <b id="setDmOpacityValue">${dm.opacity??0.92}</b></span><input type="range" id="setDmOpacity" min="0.3" max="1" step="0.02" value="${dm.opacity??0.92}"></label>
 <label class="setting-row"><span>显示区域 <b id="setDmAreaValue">${dm.area??0.5}</b></span><input type="range" id="setDmArea" min="0.25" max="1" step="0.25" value="${dm.area??0.5}"></label>
 <label class="setting-row"><span>滚动时长 <b id="setDmDurationValue">${dm.duration??8}</b> 秒</span><input type="range" id="setDmDuration" min="4" max="16" step="1" value="${dm.duration??8}"></label>
 <label class="setting-row stacked"><span>屏蔽词<small>逗号分隔，例如：剧透, 广告</small></span><input id="setDmShield" type="text" value="${esc(dm.shield||'')}" placeholder="剧透, 广告"></label>
 <p class="hint">弹幕源、搜索和发送在播放器的「弹幕设置」里。</p>
</div></section>

<section class="group"><h3>${ICON.theme}外观</h3><div class="group-body">
 <label class="setting-row"><span>深色模式</span><select id="setTheme">${options([['auto','跟随系统'],['light','浅色'],['dark','深色']],theme)}</select></label>
</div></section>

<section class="group"><h3>${ICON.rule}规则</h3><div class="group-body">
 <button class="setting-row link" type="button" onclick="openRulesPage()"><span>规则与片源<small>装规则、按番名搜片源</small></span><i>${rules?`已启用 ${rules} 条`:'未安装'} ›</i></button>
</div></section>

<section class="group"><h3>${ICON.cloud}坚果云同步</h3><div class="group-body">
 <p class="hint">密码只留在手机应用的私有存储中；留空不会覆盖已保存密码。</p>
 <label class="field">WebDAV 地址<input id="url" value="${esc(c.url||'https://dav.jianguoyun.com/dav/')}"></label>
 <label class="field">坚果云账号<input id="username" value="${esc(c.username||'')}"></label>
 <label class="field">应用密码<input id="password" type="password" placeholder="${c.passwordSet?'已保存，留空即可':'请输入应用密码'}"></label>
 <label class="field">云端账号标识<input id="account" value="${esc(c.account||'')}" placeholder="多设备同步时区分账号"></label>
 <label class="setting-row stacked"><span>每 30 分钟自动同步</span><input type="checkbox" class="switch-input" id="autoSync" ${c.autoSync!==false?'checked':''}></label>
 <button class="primary" onclick="saveConfig()">保存配置</button>
 <button class="secondary" onclick="requestSync()">立即同步</button>
</div></section>

<section class="group"><h3>${ICON.info}关于</h3><div class="group-body">
 <div class="setting-row"><span>版本</span><i>v${esc(APP_VERSION)}</i></div>
 <p class="hint">收藏和记录来自电脑端的坚果云同步；播放器可播本机视频、HTTPS 直链和 KazumiRules 规则。</p>
 <button class="text-button danger-text" id="clearResume" type="button">清除本机播放进度</button>
 <button class="text-button danger-text" id="clearSources" type="button">清除已添加的视频线路</button>
</div></section>`;
 bindSettings();
 configInitial=JSON.stringify(readConfigForm(false));
 if(ui.configDraft){for(const key of ['url','username','account']){const input=document.querySelector('#'+key);if(input)input.value=ui.configDraft[key]??''}const auto=document.querySelector('#autoSync');if(auto)auto.checked=ui.configDraft.auto_sync!==false}
}
function bindSettings(){
 const change=(id,fn)=>document.querySelector('#'+id)?.addEventListener('change',fn);
 change('setSpeed',()=>{savePref({speed:Number(document.querySelector('#setSpeed').value)});toast('默认倍速已保存')});
 change('setSkip',()=>{savePref({skip:Number(document.querySelector('#setSkip').value)});toast('快进步长已保存')});
 change('setQuality',()=>{savePref({quality:document.querySelector('#setQuality').value});toast('默认超分已保存')});
 change('setAutoNext',()=>{savePref({autoNext:document.querySelector('#setAutoNext').checked})});
 change('setRemember',()=>{savePref({remember:document.querySelector('#setRemember').checked})});
 change('setDmEnabled',()=>{saveDm({enabled:document.querySelector('#setDmEnabled').checked})});
 const range=(id,key,label,format)=>{const input=document.querySelector('#'+id);input?.addEventListener('input',()=>{const value=Number(input.value);document.querySelector('#'+label).textContent=format?format(value):value});input?.addEventListener('change',()=>saveDm({[key]:Number(input.value)}))};
 range('setDmFont','fontSize','setDmFontValue');
 range('setDmOpacity','opacity','setDmOpacityValue',value=>value.toFixed(2));
 range('setDmArea','area','setDmAreaValue');
 range('setDmDuration','duration','setDmDurationValue');
 document.querySelector('#setDmShield')?.addEventListener('change',event=>saveDm({shield:event.target.value.trim()}));
 change('setTheme',()=>{applyTheme(document.querySelector('#setTheme').value);toast('外观已更新')});
 document.querySelector('#clearResume')?.addEventListener('click',()=>{if(!confirm('清除所有已记住的播放进度？'))return;
  if(window.HandbookPlayer?.clearResume)window.HandbookPlayer.clearResume();else writeLocal('mobile-player:resume',{});toast('播放进度已清除')});
 document.querySelector('#clearSources')?.addEventListener('click',()=>{if(!confirm('清除手动添加的视频线路和分集规则？已下载的本机视频不受影响。'))return;
  if(window.HandbookPlayer?.clearSources)window.HandbookPlayer.clearSources();else writeLocal('mobile-player:sources',{});toast('线路已清除')});
}
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
let navOverride='';
function syncNav(override){navOverride=override||'';document.querySelectorAll('nav button').forEach(b=>{const on=(navOverride||page)===b.dataset.page;b.classList.toggle('active',on);if(on)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current')})}

function showPage(p){if(!mayLeave())return;if(p==='rules'){window.HandbookRules?.open('app');syncNav('rules');return}if(window.HandbookRules?.isOpen())window.HandbookRules.close();persistUi();page=p;selected=null;composerOpen=false;render();syncNav();restorePosition();persistUi()}
function render(){rendering=true;try{if(selected!==null)return detail();if(composerOpen)return noteForm();if(page==='records')return records();if(page==='settings')return settings();home()}finally{rendering=false}}
function setCat(c){persistUi();category=c;render();restorePosition();persistUi()}
function openAnime(id){persistUi();selected=id;composerOpen=false;render();restorePosition();persistUi()}
function backHome(){persistUi();selected=null;page='home';render();syncNav();restorePosition();persistUi()}
function handleBack(){
 const conflict = document.querySelector('#syncConflict');
 if (conflict?.open) { conflict.close(); return true; }
 if(window.HandbookRules?.back())return true;
 if(window.HandbookPlayer?.back())return true;
 if(selected!==null){backHome();return true}if(composerOpen){showPage('records');return true}if(page!=='home'){showPage('home');return true}return false;
}
function toggleEpisode(id,key){const a=animes().find(x=>x.id===id);let w=JSON.parse(a.watched_episodes||'[]'), watched=!w.includes(key);w=watched?[...w,key]:w.filter(x=>x!==key);a.watched_episodes=JSON.stringify(w);a.updated_at=nowIso();const events=tables().events;if(watched){events.push({...recordIdentity(),id:Date.now(),event_type:'watch',anime_id:id,episodes:JSON.stringify([key]),content:'',theme:'watch',themes:'["watch"]',rating:null,raw_directives:'',created_at:nowIso()})}else{const index=[...events].reverse().findIndex(e=>e.event_type==='watch'&&Number(e.anime_id)===Number(id)&&(()=>{try{return JSON.parse(e.episodes||'[]').includes(key)}catch(_){return false}})());if(index>=0){const actual=events.length-1-index,event=events[actual],remaining=JSON.parse(event.episodes||'[]').filter(item=>item!==key);if(remaining.length)event.episodes=JSON.stringify(remaining);else events.splice(actual,1)}}save();updateEpisodeButtons();persistUi()}
function addNote(){const content=document.querySelector('#content').value.trim();if(!content)return;const events=tables().events;events.push({...recordIdentity(),id:Date.now(),event_type:'note',anime_id:null,episodes:'[]',content,theme:'other',themes:'["other"]',rating:null,raw_directives:'',created_at:nowIso()});if(save()){ui.noteDraft='';document.querySelector('#content').value='';showPage('records')}}
function saveConfig(){if(native.saveConfig(JSON.stringify(readConfigForm()))===false){alert('配置保存失败，请重试');return}ui.configDraft=null;document.querySelector('#password').value='';configInitial=JSON.stringify(readConfigForm(false));persistUi();alert('坚果云配置已保存')}
function requestSync(resolution=''){native.sync(resolution)}
let syncConflictToken='';
window.HandbookMobile={completeSync(raw,silent=false){const r=JSON.parse(raw);if(r.error){if(!silent)alert(r.error);return}if(r.conflict){
 const dialog = document.querySelector('#syncConflict');
 if (!silent && !dialog.open) {
  syncConflictToken = r.conflict_token || '';
  dialog.showModal();
 }
 return;
}if(r.state){
 // Read the latest persisted snapshot, including edits made after the network finished.
 persistedState=native.state();state=JSON.parse(persistedState);
 const editing=!!document.querySelector('#content')||!!document.querySelector('#url');
 if(!editing){const y=window.scrollY;if(selected!==null)updateEpisodeButtons();else render();window.scrollTo(0,y)}
 }if(!silent)alert(r.pendingLocal?'同步已完成；期间的新修改已保留在手机，等待下次同步。':r.message||'同步完成')}};
document.querySelectorAll('nav button[data-page]').forEach(b=>b.onclick=()=>showPage(b.dataset.page));document.querySelector('#sync').onclick=()=>requestSync();
document.querySelector('#syncConflict form')?.addEventListener('submit', event => {
 event.preventDefault();
 const resolution = event.submitter?.value;
 event.currentTarget.closest('dialog').close();
 if (syncConflictToken && (resolution === 'local' || resolution === 'remote')) requestSync(`${resolution}:${syncConflictToken}`);
});
app.addEventListener('input',persistUi);app.addEventListener('change',persistUi);
let scrollTimer;window.addEventListener('scroll',()=>{clearTimeout(scrollTimer);scrollTimer=setTimeout(persistUi,100)},{passive:true});
window.addEventListener('pagehide',persistUi);
window.HandbookMobile.handleBack=handleBack;window.HandbookMobile.persistUi=persistUi;window.HandbookMobile.syncNav=syncNav;
applyTheme(readLocal(THEME_KEY,'auto'));
const themeMedia=window.matchMedia?.('(prefers-color-scheme: dark)');themeMedia?.addEventListener?.('change',()=>{if(readLocal(THEME_KEY,'auto')==='auto')applyTheme('auto')});
if(['home','records','settings'].includes(ui.page))page=ui.page;
if([1,2,3,4,5].includes(ui.category))category=ui.category;
selected=ui.selected??null;composerOpen=ui.composer===true&&selected===null;
render();syncNav();restorePosition();
