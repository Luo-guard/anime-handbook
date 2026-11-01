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
function shortcutKeysFor(item, fallback) {
  if (item) {
    if (Array.isArray(item.keys)) return item.keys.filter((key) => typeof key === "string" && key);
    if (typeof item.key === "string") return item.key ? [item.key] : [];
  }
  return fallback ? [fallback] : [];
}
function keyboardPreferences(value=state.settings.keyboard_shortcuts) {
  return {enabled:value?.enabled!==false,bindings:Object.fromEntries(SHORTCUT_ACTIONS.map(action=>[action.id,{enabled:typeof value?.bindings?.[action.id]?.enabled==="boolean"?value.bindings[action.id].enabled:action.enabled,keys:shortcutKeysFor(value?.bindings?.[action.id],action.key)}]))};
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
  for(const action of SHORTCUT_ACTIONS){
    const item=value.bindings[action.id];
    if(!item||!item.enabled||(action.desktop&&window.handbookOnline))continue;
    for(const key of item.keys){
      if(!key)continue;
      if(used.has(key))throw Error(`快捷键「${shortcutLabel(key)}」重复：${used.get(key)}、${action.name}`);
      used.set(key,action.name);
    }
  }
  return value;
}
const SHORTCUT_GROUPS = [
  { title: "切换界面", actions: ["collection", "schedule", "timeline", "statistics", "ranking", "settings", "previous", "next"] },
  { title: "界面操作", actions: ["sidebar", "search", "filter"] },
  { title: "记录与周表", actions: ["new_record", "new_ranking", "refresh_schedule"] },
  { title: "系统", actions: ["shutdown"] },
];
function shortcutActionName(action) {
  return action.page ? `打开${pageLabel(action.page)}` : action.name;
}
function shortcutRowKeys(row) {
  return [...row.querySelectorAll("[data-key-chip]")].map((node) => node.dataset.key);
}
function readKeyboardSettings() {
  return validateKeyboardPreferences({
    enabled: $("#keyboardEnabledInput").checked,
    bindings: Object.fromEntries(SHORTCUT_ACTIONS.map((action) => {
      const row = $(`[data-shortcut-action="${action.id}"]`);
      return [action.id, {
        enabled: row.querySelector("[data-shortcut-enabled]").checked,
        keys: shortcutRowKeys(row),
      }];
    })),
  });
}
function refreshKeyboardStatus() {
  try {
    readKeyboardSettings();
    $("#keyboardStatus").textContent = "";
    return true;
  } catch (error) {
    $("#keyboardStatus").textContent = error.message;
    return false;
  }
}
function captureShortcutKey(row, action, key) {
  const current = shortcutRowKeys(row);
  if (!key || current.includes(key)) {
    paintShortcutKeys(row, action, current);
    refreshKeyboardStatus();
    return;
  }
  paintShortcutKeys(row, action, [...current, key]);
  if (!refreshKeyboardStatus()) paintShortcutKeys(row, action, current);
}
function paintShortcutKeys(row, action, keys, options = {}) {
  const box = row.querySelector("[data-shortcut-keys]");
  box.replaceChildren();
  keys.forEach((key) => {
    const chip = document.createElement("span");
    chip.className = "shortcut-chip";
    chip.dataset.keyChip = "";
    chip.dataset.key = key;
    const label = document.createElement("span");
    label.className = "shortcut-chip-label";
    label.textContent = shortcutLabel(key);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "shortcut-chip-remove";
    remove.dataset.shortcutRemove = "";
    remove.setAttribute("aria-label", `移除快捷键 ${shortcutLabel(key)}`);
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      paintShortcutKeys(row, action, shortcutRowKeys(row).filter((item) => item !== key));
      refreshKeyboardStatus();
    });
    chip.append(label, remove);
    box.append(chip);
  });
  if (options.capture) {
    const input = document.createElement("input");
    input.type = "text";
    input.readOnly = true;
    input.className = "shortcut-capture";
    input.dataset.shortcutKey = "";
    input.dataset.key = "";
    input.placeholder = "按下按键…";
    input.setAttribute("aria-label", `为${shortcutActionName(action)}录入快捷键`);
    input.addEventListener("keydown", (event) => {
      if (event.isComposing || event.keyCode === 229 || event.key === "Tab") return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") { input.blur(); return; }
      const key = shortcutKey(event);
      if (!key) return;
      captureShortcutKey(row, action, key);
    });
    input.addEventListener("blur", () => {
      if (input.isConnected) paintShortcutKeys(row, action, shortcutRowKeys(row));
    });
    box.append(input);
    input.focus();
    return;
  }
  const add = document.createElement("button");
  add.type = "button";
  add.className = "shortcut-add";
  add.dataset.shortcutAdd = "";
  add.textContent = keys.length ? "＋" : "＋ 添加按键";
  add.setAttribute("aria-label", `为${shortcutActionName(action)}添加快捷键`);
  add.addEventListener("click", () => paintShortcutKeys(row, action, shortcutRowKeys(row), { capture: true }));
  box.append(add);
}
function buildShortcutRow(action, item) {
  const row = document.createElement("div");
  row.className = "keyboard-binding";
  row.dataset.shortcutAction = action.id;
  const name = document.createElement("span");
  name.className = "keyboard-binding-name";
  name.textContent = shortcutActionName(action);
  const keys = document.createElement("div");
  keys.className = "keyboard-keys";
  keys.dataset.shortcutKeys = "";
  const toggle = document.createElement("label");
  toggle.className = "switch-row compact";
  const check = document.createElement("input");
  check.type = "checkbox";
  check.dataset.shortcutEnabled = "";
  check.checked = item.enabled;
  check.setAttribute("aria-label", `启用${shortcutActionName(action)}快捷键`);
  check.addEventListener("change", refreshKeyboardStatus);
  const visual = document.createElement("span");
  visual.className = "switch";
  toggle.append(check, visual);
  row.append(name, keys, toggle);
  paintShortcutKeys(row, action, item.keys);
  return row;
}
function renderKeyboardSettings(value = keyboardPreferences()) {
  $("#keyboardEnabledInput").checked = value.enabled;
  $("#keyboardStatus").textContent = "";
  const list = $("#keyboardBindings");
  list.replaceChildren();
  SHORTCUT_GROUPS.forEach((group) => {
    const actions = group.actions
      .map((id) => SHORTCUT_ACTIONS.find((action) => action.id === id))
      .filter((action) => action && !(action.desktop && window.handbookOnline));
    if (!actions.length) return;
    const section = document.createElement("section");
    section.className = "keyboard-group";
    const title = document.createElement("p");
    title.className = "keyboard-group-title";
    title.textContent = group.title;
    section.append(title);
    actions.forEach((action) => section.append(buildShortcutRow(action, value.bindings[action.id])));
    list.append(section);
  });
  $("#resetKeyboardBindings").onclick = () => renderKeyboardSettings(keyboardPreferences({}));
}
function isKeyboardEditingTarget(target) {
  return target instanceof Element && (target.isContentEditable || Boolean(target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"], [role="searchbox"], [role="slider"], video, audio')));
}
function settingsDialogOpen() {
  const dialog = document.querySelector("#settingsModal");
  return Boolean(dialog?.open);
}
function currentShortcutView() {
  return settingsDialogOpen() ? "settings" : state.activeView;
}
function navigateByShortcut(view) {
  if (view === "settings" && settingsDialogOpen()) return true;
  if (view !== "settings") {
    const dialog = document.querySelector("#settingsModal");
    if (dialog?.open) dialog.close();
  }
  const button=document.querySelector(`.nav-item[data-nav-id="${view}"]`);
  if(!button||button.disabled||button.hidden||button.classList.contains("hidden"))return false;
  button.click();return true;
}
function runShortcut(action) {
  if(action.page)return navigateByShortcut(action.page);
  if(action.id==="previous"||action.id==="next"){
    const order=sidebarOrder().filter(id=>sidebarVisibility()[id]!==false);
    const index=order.indexOf(currentShortcutView());if(!order.length||index<0)return false;
    // Stop at the first/last page instead of wrapping around.
    const target=index+(action.id==="next"?1:-1);
    if(target<0||target>=order.length)return false;
    return navigateByShortcut(order[target]);
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
  if(event.defaultPrevented||event.repeat||event.isComposing||event.keyCode===229)return;
  if(isKeyboardEditingTarget(document.activeElement)||event.composedPath().some(isKeyboardEditingTarget))return;
  const preferences=keyboardPreferences();if(!preferences.enabled)return;
  const key=shortcutKey(event);if(!key)return;
  const matches=SHORTCUT_ACTIONS.filter(action=>preferences.bindings[action.id].enabled&&preferences.bindings[action.id].keys.includes(key));
  if(matches.length!==1)return;
  // The settings page is a dialog, but it is also a sidebar entry, so navigation
  // shortcuts stay available there. Every other open dialog still wins.
  const navigates=Boolean(matches[0].page)||matches[0].id==="previous"||matches[0].id==="next";
  if(document.querySelector("dialog[open]")&&!(navigates&&settingsDialogOpen()))return;
  // A bound key belongs to the app even when its action cannot run (first/last page).
  event.preventDefault();
  runShortcut(matches[0]);
});

// A bound side button belongs to the app: it is claimed even when the action
// cannot run (first/last page, open dialog, focused editor), so the browser
// never falls back to its own back/forward history navigation.
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
  if(input?.matches(".shortcut-capture")) {
    // 录入状态下按鼠标侧键：和键盘一样追加一个按键。
    event.preventDefault();event.stopPropagation();claimedShortcutMouseButtons.add(event.button);
    const row=input.closest("[data-shortcut-action]");
    const action=row&&SHORTCUT_ACTIONS.find(item=>item.id===row.dataset.shortcutAction);
    const key=shortcutKey(event);
    if(action&&key)captureShortcutKey(row,action,key);
    return;
  }
  const prefs=keyboardPreferences();if(!prefs.enabled)return;
  const key=shortcutKey(event);
  const matches=SHORTCUT_ACTIONS.filter(action=>prefs.bindings[action.id].enabled&&prefs.bindings[action.id].keys.includes(key));
  if(matches.length!==1)return;
  claimedShortcutMouseButtons.add(event.button);
  if(!event.defaultPrevented){event.preventDefault();event.stopPropagation();}
  if(isKeyboardEditingTarget(input)||event.composedPath().some(isKeyboardEditingTarget))return;
  const navigates=Boolean(matches[0].page)||matches[0].id==="previous"||matches[0].id==="next";
  if(document.querySelector('dialog[open]')&&!(navigates&&settingsDialogOpen()))return;
  runShortcut(matches[0]);
}
['mousedown','mouseup','auxclick'].forEach(type=>document.addEventListener(type,handleShortcutMouse,{capture:true,passive:false}));
window.addEventListener('blur',()=>claimedShortcutMouseButtons.clear());
