const SHORTCUT_ACTIONS = [
  {id:"collection",name:"打开收藏夹",page:"collection",key:"1",enabled:true},
  {id:"schedule",name:"打开周表",page:"schedule",key:"2",enabled:true},
  {id:"timeline",name:"打开看番记录",page:"timeline",key:"3",enabled:true},
  {id:"statistics",name:"打开记录统计",page:"statistics",key:"4",enabled:true},
  {id:"ranking",name:"打开排名",page:"ranking",key:"5",enabled:true},
  {id:"settings",name:"打开设置",page:"settings",key:"6",enabled:true},
  {id:"previous",name:"上一个界面",key:"ArrowUp",enabled:true},
  {id:"next",name:"下一个界面",key:"ArrowDown",enabled:true},
  {id:"sidebar",name:"收起 / 展开侧边栏",key:"b",enabled:true},
  {id:"shutdown",name:"关闭本机后台（需要确认）",key:"Ctrl+Shift+q",enabled:false,desktop:true},
  {id:"search",name:"聚焦当前页面搜索",key:"/",enabled:false},
  {id:"new_record",name:"新建感想",key:"n",enabled:false},
  {id:"new_ranking",name:"新增排名表单",key:"Alt+n",enabled:false},
  {id:"refresh_schedule",name:"刷新周表",key:"Alt+r",enabled:false},
  {id:"filter",name:"打开当前页排序与筛选",key:"f",enabled:false},
];
function keyboardPreferences(value=state.settings.keyboard_shortcuts) {
  return {enabled:value?.enabled!==false,bindings:Object.fromEntries(SHORTCUT_ACTIONS.map(action=>[action.id,{enabled:typeof value?.bindings?.[action.id]?.enabled==="boolean"?value.bindings[action.id].enabled:action.enabled,key:value?.bindings?.[action.id]?.key??action.key}]))};
}
function shortcutKey(event) {
  if(event.button===3 || event.button===4) return [event.ctrlKey?"Ctrl":"",event.altKey?"Alt":"",event.shiftKey?"Shift":"",event.metaKey?"Meta":"",event.button===3?"MouseBack":"MouseForward"].filter(Boolean).join("+");
  if(typeof event.key!=="string")return "";
  if(["Control","Alt","Shift","Meta","Dead","Unidentified","Process","Tab"].includes(event.key))return "";
  const key=event.key===" "?"Space":event.key.length===1?event.key.toLowerCase():event.key;
  if(key==="+" || !((key.length===1&&/^[\x21-\x7e]$/.test(key))||["ArrowUp","ArrowDown","ArrowLeft","ArrowRight","Home","End","PageUp","PageDown","Escape","Space","Backspace","Delete"].includes(key)||/^F(?:[1-9]|1[0-2])$/.test(key)))return "";
  return [event.ctrlKey?"Ctrl":"",event.altKey?"Alt":"",event.shiftKey?"Shift":"",event.metaKey?"Meta":"",key].filter(Boolean).join("+");
}
function shortcutLabel(key) {
  const labels={MouseBack:"鼠标后退侧键",MouseForward:"鼠标前进侧键",ArrowUp:"↑",ArrowDown:"↓",ArrowLeft:"←",ArrowRight:"→",Space:"空格",Escape:"Esc"};
  return key.split("+").map(part=>labels[part]||part).join(" + ");
}
function validateKeyboardPreferences(value) {
  const used=new Map();
  for(const action of SHORTCUT_ACTIONS){const item=value.bindings[action.id];if(!item.enabled||!item.key||(action.desktop&&window.handbookOnline))continue;
    if(used.has(item.key))throw Error(`快捷键「${shortcutLabel(item.key)}」重复：${used.get(item.key)}、${action.name}`);
    used.set(item.key,action.name);
  }
  return value;
}
function readKeyboardSettings() {
  return validateKeyboardPreferences({enabled:$("#keyboardEnabledInput").checked,bindings:Object.fromEntries(SHORTCUT_ACTIONS.map(action=>{const row=$(`[data-shortcut-action="${action.id}"]`);return [action.id,{enabled:row.querySelector("[data-shortcut-enabled]").checked,key:row.querySelector("[data-shortcut-key]").dataset.key||""}]}))});
}
function renderKeyboardSettings(value=keyboardPreferences()) {
  $("#keyboardEnabledInput").checked=value.enabled;
  $("#keyboardStatus").textContent="";
  const list=$("#keyboardBindings");list.replaceChildren();
  SHORTCUT_ACTIONS.forEach(action=>{
    const row=document.createElement("div");row.className="keyboard-binding";row.dataset.shortcutAction=action.id;
    if(action.desktop&&window.handbookOnline)row.classList.add("hidden");
    const name=document.createElement("span");name.textContent=action.page?`打开${pageLabel(action.page)}`:action.name;
    const input=document.createElement("input");input.type="text";input.readOnly=true;input.dataset.shortcutKey="";input.dataset.key=value.bindings[action.id].key;input.value=shortcutLabel(input.dataset.key);input.placeholder="点击录入按键";input.setAttribute("aria-label",`${name.textContent}的快捷键`);
    input.addEventListener("keydown",event=>{
      if(event.isComposing||event.keyCode===229)return;
      if(event.key==="Tab")return;
      event.preventDefault();event.stopPropagation();
      if(event.key==="Escape"){input.blur();return;}
      const key=["Backspace","Delete"].includes(event.key)?"":shortcutKey(event);
      if(!key&&!["Backspace","Delete"].includes(event.key))return;
      input.dataset.key=key;input.value=shortcutLabel(key);
      try{readKeyboardSettings();$("#keyboardStatus").textContent="";}catch(error){$("#keyboardStatus").textContent=error.message;}
    });
    const toggle=document.createElement("label");toggle.className="switch-row compact";
    const check=document.createElement("input");check.type="checkbox";check.dataset.shortcutEnabled="";check.checked=value.bindings[action.id].enabled;check.setAttribute("aria-label",`启用${name.textContent}快捷键`);
    check.addEventListener("change",()=>{try{readKeyboardSettings();$("#keyboardStatus").textContent="";}catch(error){$("#keyboardStatus").textContent=error.message;}});
    const visual=document.createElement("span");visual.className="switch";toggle.append(check,visual);row.append(name,input,toggle);list.append(row);
  });
  $("#resetKeyboardBindings").onclick=()=>renderKeyboardSettings(keyboardPreferences({}));
}
function isKeyboardEditingTarget(target) {
  return target instanceof Element && (target.isContentEditable || Boolean(target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"], [role="searchbox"], [role="slider"], video, audio')));
}
function navigateByShortcut(view) {
  const button=document.querySelector(`.nav-item[data-nav-id="${view}"]`);
  if(!button||button.disabled||button.hidden||button.classList.contains("hidden"))return false;
  button.click();return true;
}
function runShortcut(action) {
  if(action.page)return navigateByShortcut(action.page);
  if(action.id==="previous"||action.id==="next"){
    const order=sidebarOrder().filter(id=>sidebarVisibility()[id]!==false);
    const index=order.indexOf(state.activeView);if(!order.length)return false;
    return navigateByShortcut(order[(Math.max(0,index)+(action.id==="next"?1:-1)+order.length)%order.length]);
  }
  if(action.id==="sidebar"){setSidebarCollapsed(!$(".app-shell").classList.contains("sidebar-collapsed"));return true;}
  if(action.id==="shutdown"){if(window.handbookOnline)return false;shutdownHandbookBackend();return true;}
  if(action.id==="search"){
    const selector={collection:"#searchInput",schedule:"#scheduleSearch",timeline:"#timelineSearchInput"}[state.activeView];const input=selector&&$(selector);if(!input)return false;input.focus();input.select();return true;
  }
  if(action.id==="new_record"){if(!navigateByShortcut("timeline"))return false;$("#writeNoteButton").click();return true;}
  if(action.id==="new_ranking"){if(!navigateByShortcut("ranking"))return false;$("#createRankingButton").click();return true;}
  if(action.id==="refresh_schedule"){if(!navigateByShortcut("schedule"))return false;$("#scheduleRefresh").click();return true;}
  if(action.id==="filter"){
    const button=$({collection:"#collectionFloatingButton",schedule:"#scheduleFilterButton"}[state.activeView]||"#no-shortcut-target");if(!button)return false;button.click();return true;
  }
  return false;
}
document.addEventListener("keydown",event=>{
  if(event.defaultPrevented||event.repeat||event.isComposing||event.keyCode===229||document.querySelector("dialog[open]"))return;
  if(isKeyboardEditingTarget(document.activeElement)||event.composedPath().some(isKeyboardEditingTarget))return;
  const preferences=keyboardPreferences();if(!preferences.enabled)return;
  const key=shortcutKey(event);if(!key)return;
  const matches=SHORTCUT_ACTIONS.filter(action=>preferences.bindings[action.id].enabled&&preferences.bindings[action.id].key===key);
  if(matches.length!==1)return;
  if(runShortcut(matches[0]))event.preventDefault();
});

// Claim only enabled bindings (or explicit recording), and suppress the matching
// release/auxclick so the browser does not also navigate its history.
const claimedShortcutMouseButtons=new Set();
function handleShortcutMouse(event) {
  if(event.button!==3&&event.button!==4)return;
  if(event.type!=="mousedown") {
    if(claimedShortcutMouseButtons.has(event.button)) {
      event.preventDefault();event.stopPropagation();
      if(event.type==="auxclick")claimedShortcutMouseButtons.delete(event.button);
    }
    return;
  }
  claimedShortcutMouseButtons.delete(event.button);
  const input=document.activeElement;
  if(input?.matches('[data-shortcut-key]')&&input.closest('dialog[open]')) {
    event.preventDefault();event.stopPropagation();claimedShortcutMouseButtons.add(event.button);
    const key=shortcutKey(event);input.dataset.key=key;input.value=shortcutLabel(key);
    try{readKeyboardSettings();$("#keyboardStatus").textContent="";}catch(error){$("#keyboardStatus").textContent=error.message;}
    return;
  }
  if(event.defaultPrevented||document.querySelector('dialog[open]')||isKeyboardEditingTarget(input)||event.composedPath().some(isKeyboardEditingTarget))return;
  const prefs=keyboardPreferences();if(!prefs.enabled)return;
  const key=shortcutKey(event);
  const matches=SHORTCUT_ACTIONS.filter(action=>prefs.bindings[action.id].enabled&&prefs.bindings[action.id].key===key);
  if(matches.length!==1)return;
  if(runShortcut(matches[0])){claimedShortcutMouseButtons.add(event.button);event.preventDefault();event.stopPropagation();}
}
['mousedown','mouseup','auxclick'].forEach(type=>document.addEventListener(type,handleShortcutMouse,{capture:true,passive:false}));
window.addEventListener('blur',()=>claimedShortcutMouseButtons.clear());
