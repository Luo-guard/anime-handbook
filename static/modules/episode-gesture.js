// 单集格子手势：识别、六格扇区、绑定表分发。
// details.js 只负责「某个动作到底做什么」，这里不碰业务。
//
// 左键单击固定切换已看，不进绑定表；带修饰键的单击、右键、长按、双击、中键
// 才走绑定表。A 版（按住滑到扇区松手）与 B 版（右键弹出后再点选）共用同一套
// 状态机，区别只在松手时有没有命中扇区、以及 keepMenu 开关。
const EG_ACTION_LABELS = {
  open_menu: "打开扇区", play: "本地播放", online_play: "在线播放", download: "下载", cancel_download: "取消下载",
  delete: "删除本地文件", score: "评分", review: "评价", op: "OP", ed: "ED",
  open_detail: "单集详情", reveal_in_folder: "查看本地文件", redownload: "查找其他片源",
};
const EG_SLOTS = ["top", "bottom", "top_right", "bottom_right", "top_left", "bottom_left"];
const EG_SLOT_LABELS = {
  top: "上", bottom: "下", top_right: "右上", bottom_right: "右下",
  top_left: "左上", bottom_left: "左下",
};
const EG_COORDS = {
  top: [0, -94], bottom: [0, 94],
  top_right: [98, -54], bottom_right: [98, 54],
  top_left: [-98, -54], bottom_left: [-98, 54],
  online: [98, 0],
};
const EG_RECORD_SETTINGS = {
  review: "show_episode_review_record", score: "show_episode_rating_record",
  op: "show_oped_record", ed: "show_oped_record",
};
const EG_ENTRY_ACTIONS = Object.keys(EG_ACTION_LABELS)
  .filter(action => action !== "open_menu" && !EG_RECORD_SETTINGS[action]);
const EG_DEFAULT = {
  enabled: true,
  keep_menu_on_release: true,
  slots: {
    top: "play", bottom: "download", top_right: "score",
    bottom_right: "review", top_left: "ed", bottom_left: "op",
  },
  bindings: {
    RightClick: "open_menu", LongClick: "open_menu",
    "Ctrl+Click": "open_detail", "Alt+Click": "reveal_in_folder",
  },
};
const EG_LONG_PRESS_MS = 420;
const EG_DOUBLE_DELAY = 250;

function episodeGestureConfig() {
  const raw = state.settings?.episode_gestures || {};
  return {
    enabled: raw.enabled !== false,
    keepMenu: raw.keep_menu_on_release !== false,
    slots: { ...EG_DEFAULT.slots, ...(raw.slots || {}) },
    bindings: { ...(raw.bindings || EG_DEFAULT.bindings) },
    hiddenActions: new Set(raw.hidden_actions || []),
  };
}

function egRecordEnabled(action) {
  return !EG_RECORD_SETTINGS[action] || state.settings?.[EG_RECORD_SETTINGS[action]] !== false;
}

function egGestureLabel(gesture) {
  const parts = String(gesture).split("+");
  const base = parts.pop();
  const names = {
    Click: "左键单击", DoubleClick: "左键双击", RightClick: "右键单击",
    LongClick: "左键长按", LongRightClick: "右键长按", MiddleClick: "中键单击",
  };
  return [...parts.map((part) => part), names[base] || base].join(" + ");
}

function egModPrefix(event) {
  const parts = [];
  if (event.ctrlKey) parts.push("Ctrl");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  return parts.length ? `${parts.join("+")}+` : "";
}

let egRuntime = null;

function egCloseMenu() {
  const menu = egRuntime?.menu;
  if (!menu) return;
  menu.remove();
  egRuntime.menu = null;
  egRuntime.menuButton = null;
  egRuntime.dragged = false;
}

function egRenderMenu(button, config, onAction) {
  egCloseMenu();
  const slots = Object.fromEntries(EG_SLOTS.map(slot => [slot, config.slots[slot]]));
  const localSlot = EG_SLOTS.find(slot => slots[slot] === "play");
  for (const [slot, action] of Object.entries(slots)) {
    if (!egRecordEnabled(action) || config.hiddenActions.has(action)
      || (["play", "delete"].includes(action) && !button.classList.contains("downloaded"))) delete slots[slot];
  }
  if (!config.hiddenActions.has("online_play") && !window.handbookOnline
    && window.onlinePlayback && button.dataset.episodeType === "0") {
    slots[localSlot && !slots[localSlot] ? localSlot : "online"] = "online_play";
  }
  const entries = Object.entries(slots).filter(([, action]) => action);
  if (!entries.length) return;
  const rect = button.getBoundingClientRect();
  const scale = Math.min(1, (window.innerWidth - 110) / 196, (window.innerHeight - 56) / 188);
  const fit = (axis, center, size, pad) => {
    const offsets = entries.map(([slot]) => EG_COORDS[slot][axis] * scale);
    return Math.max(pad - Math.min(...offsets), Math.min(center, size - pad - Math.max(...offsets)));
  };
  const originX = fit(0, rect.left + rect.width / 2, window.innerWidth, 55);
  const originY = fit(1, rect.top + rect.height / 2, window.innerHeight, 28);
  const menu = document.createElement("div");
  menu.id = "episodeQuickMenu";
  menu.className = "episode-quick-menu";
  menu.setAttribute("role", "group");
  menu.setAttribute("aria-label", "单集快捷操作");
  menu.style.setProperty("--quick-x", `${originX}px`);
  menu.style.setProperty("--quick-y", `${originY}px`);
  menu.innerHTML = entries.map(([slot, action]) => {
    const [x, y] = EG_COORDS[slot];
    return `<button type="button" class="episode-quick-action" style="left:${x * scale}px;top:${y * scale}px" data-episode-action="${action}" data-slot="${slot}">${escapeHtml(EG_ACTION_LABELS[action])}</button>`;
  }).join("");
  menu.addEventListener("click", (event) => {
    const item = event.target.closest("[data-episode-action]");
    if (!item || !egRuntime) return;
    event.preventDefault();
    event.stopPropagation();
    egCloseMenu();
    button.focus({ preventScroll: true });
    if (button.isConnected) onAction(item.dataset.episodeAction, button.dataset.episodeKey, button);
  });
  $("#progressModal").append(menu);
  egRuntime.menu = menu;
  egRuntime.menuButton = button;
  return menu;
}

function egUpdateTarget(event) {
  const menu = egRuntime?.menu;
  if (!menu) return;
  menu.querySelectorAll("[data-episode-action]").forEach((item) => {
    const rect = item.getBoundingClientRect();
    item.classList.toggle("active", event.clientX >= rect.left && event.clientX <= rect.right
      && event.clientY >= rect.top && event.clientY <= rect.bottom);
  });
}

function installEpisodeGestures(root, options) {
  if (!root || root.dataset.egInstalled === "1") return;
  root.dataset.egInstalled = "1";
  egRuntime = {
    button: null, pointerId: null, startX: 0, startY: 0, index: 0,
    pressTimer: 0, longFired: false, menu: null, dragged: false,
    clickTimer: 0, pendingClick: null,
  };
  const configOf = () => episodeGestureConfig();
  const cellOf = (target) => target instanceof Element ? target.closest(".episode-cell") : null;

  const run = (gesture, button) => {
    if (!button || !gesture) return;
    const config = configOf();
    if (!config.enabled) return;
    const action = config.bindings[gesture];
    if (!action || !egRecordEnabled(action)) return;
    if (action === "open_menu") {
      egRenderMenu(button, config, options.onAction);
      return;
    }
    options.onAction(action, button.dataset.episodeKey, button);
  };

  root.addEventListener("pointerdown", (event) => {
    const button = cellOf(event.target);
    if (!button || !configOf().enabled || event.button > 2 || egRuntime.button) return;
    if (egRuntime.menu && !event.target.closest("#episodeQuickMenu")) egCloseMenu();
    egRuntime.button = button;
    egRuntime.pointerId = event.pointerId;
    egRuntime.startX = event.clientX;
    egRuntime.startY = event.clientY;
    egRuntime.index = event.button;
    egRuntime.longFired = false;
    egRuntime.dragged = false;
    egRuntime.modPrefix = egModPrefix(event);
    // 合成事件或触屏上 pointerId 可能已失效，捕获失败不能中断后面的长按计时。
    try { button.setPointerCapture?.(event.pointerId); } catch (_error) { /* 忽略 */ }
    window.clearTimeout(egRuntime.pressTimer);
    const base = event.button === 2 ? "LongRightClick" : "LongClick";
    const longGesture = egRuntime.modPrefix + base;
    const longAction = configOf().bindings[longGesture];
    if (event.button === 1 || !longAction || !egRecordEnabled(longAction)) return;
    egRuntime.pressTimer = window.setTimeout(() => {
      egRuntime.longFired = true;
      run(longGesture, button);
    }, EG_LONG_PRESS_MS);
  });

  // 监听挂在 document 上，不能挂集数区：六个圆钮离格子中心最远 98px，
  // 而一行格子只有 45px 高，指针滑向任意扇区都会先离开 .episode-grid。
  // 挂在 root 上时指针一出界就不再更新，高亮停在上一步、甚至被清空，
  // 于是正上方「播放」、正下方「下载」看起来"点了没反应"。
  document.addEventListener("pointermove", (event) => {
    if (!egRuntime.button) {
      egUpdateTarget(event);
      return;
    }
    if (event.pointerId !== egRuntime.pointerId) return;
    const distance = Math.hypot(event.clientX - egRuntime.startX, event.clientY - egRuntime.startY);
    if (distance > 10) {
      egRuntime.dragged = true;
      window.clearTimeout(egRuntime.pressTimer);
    }
    egUpdateTarget(event);
  });

  function flushClick() {
    window.clearTimeout(egRuntime.clickTimer);
    const pending = egRuntime.pendingClick;
    egRuntime.pendingClick = null;
    if (pending?.button.isConnected) pending.single();
  }

  document.addEventListener("pointerup", (event) => {
    const button = egRuntime.button;
    if (!button || event.pointerId !== egRuntime.pointerId) return;
    window.clearTimeout(egRuntime.pressTimer);
    const config = configOf();
    if (egRuntime.menu) {
      egUpdateTarget(event);
      const active = egRuntime.menu.querySelector("[data-episode-action].active");
      if (active && egRuntime.dragged) {
        const action = active.dataset.episodeAction;
        egCloseMenu();
        options.onAction(action, button.dataset.episodeKey, button);
      } else if (!config.keepMenu) {
        egCloseMenu();
      }
      // keepMenu=true 且没命中：菜单留着，等用户再点某一格。
      egRuntime.button = null;
      return;
    }
    if (egRuntime.longFired || egRuntime.dragged || !button.isConnected) {
      egRuntime.button = null;
      return;
    }
    const base = egRuntime.index === 2 ? "RightClick" : egRuntime.index === 1 ? "MiddleClick" : "Click";
    const gesture = egRuntime.modPrefix + base;
    egRuntime.button = null;
    const single = () => gesture === "Click" ? options.onToggleWatched(button) : run(gesture, button);
    const double = egRuntime.modPrefix + "DoubleClick";
    const doubleAction = base === "Click" && config.bindings[double];
    if (doubleAction && egRecordEnabled(doubleAction)) {
      if (egRuntime.pendingClick?.button === button && egRuntime.pendingClick.double === double) {
        window.clearTimeout(egRuntime.clickTimer);
        egRuntime.pendingClick = null;
        run(double, button);
      } else {
        flushClick();
        egRuntime.pendingClick = { button, double, single };
        egRuntime.clickTimer = window.setTimeout(flushClick, EG_DOUBLE_DELAY);
      }
      return;
    }
    flushClick();
    single();
  });

  root.addEventListener("pointercancel", (event) => {
    if (event.pointerId !== egRuntime.pointerId) return;
    window.clearTimeout(egRuntime.pressTimer);
    egCloseMenu();
    egRuntime.button = null;
  });

  root.addEventListener("click", (event) => {
    const button = cellOf(event.target);
    // 键盘 Enter/Space 触发的 click 没有 pointer 事件，这里补一次已看切换。
    if (button && (!configOf().enabled || event.detail === 0)) options.onToggleWatched(button);
  });

  root.addEventListener("contextmenu", (event) => {
    const button = cellOf(event.target);
    if (!button || !configOf().enabled) return;
    event.preventDefault();
    if (event.button === 0 && !egRuntime.button) {
      egRenderMenu(button, configOf(), options.onAction);
      egRuntime.menu?.querySelector("button")?.focus();
    }
  });

  document.addEventListener("pointerdown", (event) => {
    if (!egRuntime.menu || event.target.closest("#episodeQuickMenu") || cellOf(event.target)) return;
    egCloseMenu();
  }, true);

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && egRuntime.menu) {
      event.preventDefault();
      const button = egRuntime.menuButton;
      egCloseMenu();
      button?.focus({ preventScroll: true });
    }
  });
  $("#progressModal").addEventListener("close", () => {
    egCloseMenu();
    window.clearTimeout(egRuntime.pressTimer);
    window.clearTimeout(egRuntime.clickTimer);
    egRuntime.pendingClick = null;
    egRuntime.button = null;
  });
  $("#progressModal").addEventListener("scroll", () => egCloseMenu(), { capture: true, passive: true });
  window.addEventListener("resize", () => egCloseMenu());
}

// ---- 设置界面：扇区六格 + 手势绑定表 ------------------------------------
const EG_UI_GESTURES = [
  "RightClick", "LongClick", "LongRightClick", "MiddleClick", "DoubleClick",
  "Ctrl+Click", "Alt+Click", "Shift+Click", "Ctrl+Shift+Click",
  "Ctrl+RightClick", "Ctrl+Shift+RightClick",
];

function egActionOptions(selected, allowMenu = true) {
  return Object.entries(EG_ACTION_LABELS)
    .filter(([id]) => id !== "online_play" && (allowMenu || id !== "open_menu"))
    .map(([id, label]) => `<option value="${id}"${id === selected ? " selected" : ""}>${escapeHtml(label)}</option>`)
    .join("");
}

function readEpisodeGestureSettings() {
  const slots = {};
  $$("[data-eg-slot]").forEach((select) => { slots[select.dataset.egSlot] = select.value; });
  const bindings = {};
  $$("[data-eg-gesture]").forEach((select) => {
    // 空值也要发出去：后端把「没提到的手势」当默认值保留，只有显式 "" 才是解绑。
    // 以前这里跳过空值，用户清空某个下拉框后默认绑定会在保存时悄悄长回来。
    bindings[select.dataset.egGesture] = select.value;
  });
  const counts = {};
  for (const [gesture, action] of Object.entries(bindings)) {
    if (!action) continue;
    counts[action] = (counts[action] || 0) + 1;
    if (counts[action] > 4) {
      throw new Error(`「${EG_ACTION_LABELS[action] || action}」最多绑定 4 个手势，请精简「${egGestureLabel(gesture)}」等绑定`);
    }
  }
  return {
    enabled: $("#episodeGestureEnabledInput").checked,
    keep_menu_on_release: $("#episodeGestureKeepMenuInput").checked,
    slots,
    bindings,
    hidden_actions: $$("[data-eg-entry]").filter(input => !input.checked).map(input => input.dataset.egEntry),
  };
}

function renderEpisodeGestureSettings(config = episodeGestureConfig()) {
  const enabled = $("#episodeGestureEnabledInput");
  if (!enabled) return;
  enabled.checked = config.enabled;
  $("#episodeGestureKeepMenuInput").checked = config.keepMenu;
  $("#episodeGestureSlots").innerHTML = EG_SLOTS.map((slot) => `
    <label class="eg-slot eg-slot-${slot}"><span>${escapeHtml(EG_SLOT_LABELS[slot])}</span>
      <select data-eg-slot="${slot}" aria-label="${escapeHtml(EG_SLOT_LABELS[slot])}的动作">
        <option value="">留空</option>
        ${egActionOptions(config.slots[slot], false)}
      </select>
    </label>`).join("");
  $("#episodeGestureEntries").innerHTML = EG_ENTRY_ACTIONS.map(action => `
    <label class="switch-row compact">
      <input type="checkbox" data-eg-entry="${action}"${config.hiddenActions.has(action) ? "" : " checked"} />
      <span class="switch"></span><span>显示${escapeHtml(EG_ACTION_LABELS[action])}</span>
    </label>`).join("");
  const gestures = [...new Set([...EG_UI_GESTURES, ...Object.keys(config.bindings)])];
  $("#episodeGestureBindings").innerHTML = gestures.map((gesture) => `
    <label class="eg-row"><span>${escapeHtml(egGestureLabel(gesture))}</span>
      <select data-eg-gesture="${gesture}" aria-label="${escapeHtml(egGestureLabel(gesture))}的动作">
        <option value="">未绑定</option>
        ${egActionOptions(config.bindings[gesture] || "")}
      </select>
    </label>`).join("");

  const refresh = () => {
    const warning = $("#episodeGestureDoubleWarning");
    const boundDouble = $$("[data-eg-gesture]").some(
      (select) => select.dataset.egGesture.endsWith("DoubleClick") && select.value,
    );
    warning.hidden = !boundDouble;
    try {
      readEpisodeGestureSettings();
      $("#episodeGestureStatus").textContent = "";
    } catch (error) {
      $("#episodeGestureStatus").textContent = error.message;
    }
  };
  $$("[data-eg-slot],[data-eg-gesture]").forEach((select) => select.addEventListener("change", refresh));
  $("#resetEpisodeGestures").onclick = () => {
    renderEpisodeGestureSettings({ ...EG_DEFAULT, keepMenu: EG_DEFAULT.keep_menu_on_release, hiddenActions: new Set() });
  };
  refresh();
}
