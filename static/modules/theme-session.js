// One settings-session draft. Files stay in memory until the outer Save button.
const ThemeSettingsSession = (() => {
  const keys=['theme_profiles','active_theme_profile','theme_color','custom_theme_color','custom_background_enabled','custom_background_version','custom_background_overlay_opacity','theme_random_on_open','theme_weekly_plan','theme_weekly_plan_enabled'];
  let snapshot=null,account='',suspended=false,busy=false,selectedId='';
  const files=new Map(),previews=new Map(),sources=new Map();
  const clone=value=>JSON.parse(JSON.stringify(value));
  const fields=()=>Object.fromEntries(keys.filter(key=>key in state.settings).map(key=>[key,clone(state.settings[key])]));
  function begin(){if(snapshot)return;snapshot=fields();account=themeAccountId();selectedId=activeThemeId();files.clear();previews.clear();sources.clear();update();}
  function update(){const dirty=snapshot&&(files.size>0||sources.size>0||JSON.stringify(fields())!==JSON.stringify(snapshot));$('#themePreviewStatus').hidden=!dirty;$('#themePagePreview').hidden=!dirty;}
  function apply(){const id=activeThemeId();window.handbookThemePreview=previews.has(id)?{backgroundUrl:previews.get(id)}:null;applyTheme();update();}
  function stage(id,file,url,source,enabled){
    if(!enabled){files.delete(id);previews.delete(id);sources.delete(id);return;}
    if(file){files.set(id,file);previews.set(id,url);sources.delete(id);}
    else if(source&&source!==id){sources.set(id,source);const profile=themeProfiles().find(p=>p.id===source)||snapshot?.theme_profiles?.find(p=>p.id===source);const preview=previews.get(source)||themeBackgroundUrl(profile);if(preview)previews.set(id,preview);if(files.has(source)){files.set(id,files.get(source));sources.delete(id);}}
  }
  function finish(accepted=false){
    if(!snapshot)return;
    if(themeEditorState.open)closeThemeEditor(true);
    if(!accepted&&account===themeAccountId()){for(const key of keys){if(key in snapshot)state.settings[key]=clone(snapshot[key]);else delete state.settings[key];}}
    snapshot=null;suspended=false;files.clear();previews.clear();sources.clear();window.handbookThemePreview=null;$('#themePagePreviewBar').hidePopover();applyTheme();update();
  }
  function lock(value){busy=value;$('.settings-list').inert=value;$('#settingsModal .modal-close').disabled=value;}
  async function payload(){
    if(!snapshot||(!files.size&&!sources.size&&JSON.stringify(fields())===JSON.stringify(snapshot)))return {};
    if((files.size||sources.size)&&!(await api('/api/health')).features?.deferred_theme_background)throw Error('保存背景预览需要重启手账后台并刷新页面');
    if(account!==themeAccountId())throw Error('账号已经切换，请重新打开设置');
    const result=fields(),remap=new Map();
    for(const profile of result.theme_profiles||[]){
      if(!profile.custom_background_enabled)continue;
      let file=files.get(profile.id);
      if(!file&&sources.has(profile.id)){
        const source=themeProfiles().find(p=>p.id===sources.get(profile.id))||snapshot.theme_profiles.find(p=>p.id===sources.get(profile.id));
        const response=await fetch(themeBackgroundUrl(source),{cache:'no-store'});if(!response.ok)throw Error('无法复制背景，设置尚未保存');const blob=await response.blob();file=new File([blob],'background.jpg',{type:blob.type});
      }
      if(!file)continue;
      // Copy-on-write: never replace a saved theme's image before settings commit.
      const id=`theme_${crypto.randomUUID().replaceAll('-','')}`;
      const uploaded=await uploadThemeBackground(file,id,true);
      remap.set(profile.id,id);profile.id=id;profile.custom_background_version=Number(uploaded.version)||Date.now();
    }
    result.active_theme_profile=remap.get(result.active_theme_profile)||result.active_theme_profile;
    result.theme_weekly_plan=Object.fromEntries(Object.entries(result.theme_weekly_plan||{}).map(([day,id])=>[day,remap.get(id)||id]));
    const active=(result.theme_profiles||[]).find(p=>p.id===result.active_theme_profile);if(active)Object.assign(result,profileAppearance(active));
    return result;
  }
  function select(id){selectedId=id;apply();}
  function restoreSelection(){const profile=themeProfiles().find(p=>p.id===selectedId);if(profile){Object.assign(state.settings,profileAppearance(profile),{active_theme_profile:selectedId});apply();}}
  function inspect(){suspended=true;$('#settingsModal').close();$('#themePagePreviewBar').showPopover();}
  function resume(){suspended=false;$('#themePagePreviewBar').hidePopover();$('#settingsModal').showModal();}
  $('#settingsModal').addEventListener('close',()=>{if(!suspended)finish(false)});
  $('#settingsModal').addEventListener('cancel',event=>{if(busy)event.preventDefault()});
  $('#themePagePreview').onclick=inspect;$('#themePreviewReturn').onclick=resume;$('#themePreviewCancel').onclick=()=>finish(false);
  document.addEventListener('keydown',event=>{if(suspended&&event.key==='Escape'){event.preventDefault();finish(false)}});
  return {begin,update,apply,stage,payload,lock,finish,resume,select,restoreSelection,incoming:value=>(snapshot&&account===themeAccountId()?{...value,...fields()}:value),background:profile=>previews.get(profile.id)||themeBackgroundUrl(profile),get active(){return !!snapshot},get suspended(){return suspended},get busy(){return busy}};
})();
