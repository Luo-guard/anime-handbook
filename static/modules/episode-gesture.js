// 单集格子手势：识别、六格扇区、绑定表分发。
// details.js 只负责「某个动作到底做什么」，这里不碰业务。
//
// 左键单击固定切换已看，不进绑定表；带修饰键的单击、右键、长按、双击、中键
// 才走绑定表。A 版（按住滑到扇区松手）与 B 版（右键弹出后再点选）共用同一套
// 状态机，区别只在松手时有没有命中扇区、以及 keepMenu 开关。
const EG_ACTION_LABELS = {
  open_menu: "打开扇区", play: "播放", download: "下载", cancel_download: "取消下载",
  delete: "删除", score: "评分", review: "评价", op: "OP", ed: "ED",
  open_detail: "单集详情", reveal_in_folder: "在文件夹中打开", redownload: "换源重下",
};
const EG_SLOTS = ["top", "bottom", "top_right", "bottom_right", "top_left", "bottom_left"];
const EG_SLOT_LABELS = {
  top: "上", bottom: "下", top_right: "右上", bottom_right: "右下",
  top_left: "左上", bottom_left: "左下",
};
const EG_COORDS = {
  top: [0, -94], bottom: [0, 94],
  top_right: [82, -54], bottom_right: [82, 54],
  top_left: [-82, -54], bottom_left: [-82, 54],
};
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
const EG_HIT_RADIUS = 62;
const EG_BASE_GESTURES = ["DoubleClick", "RightClick", "LongClick", "LongRightClick", "MiddleClick"];
const EG_MOD_PREFIXES = ["Ctrl+", "Alt+", "Shift+", "Ctrl+Shift+", "Ctrl+Alt+", "Alt+Shift+", "Ctrl+Alt+Shift+"];

function episodeGestureConfig() {
  const raw = state.settings?.episode_gestures || {};
  return {
    enabled: raw.enabled !== false,
    keepMenu: raw.keep_menu_on_release !== false,
    slots: { ...EG_DEFAULT.slots, ...(raw.slots || {}) },
    bindings: raw.bindings && Object.keys(raw.bindings).length ? { ...raw.bindings } : { ...EG_DEFAULT.bindings },
  };
}

function egGestureOptions() {
  const list = [...EG_BASE_GESTURES, ...EG_MOD_PREFIXES.map((prefix) => prefix + "Click")];
  return list.sort();
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

function egDoubleClickBound(config) {
  return Object.keys(config.bindings).some((gesture) => gesture.endsWith("DoubleClick"));
}

let egRuntime = null;

function egCloseMenu() {
  const menu = document.querySelector("#episodeQuickMenu");
  if (!menu) return;
  menu.classList.remove("visible");
  menu.classList.add("closing");
  window.setTimeout(() => menu.remove(), 150);
  if (egRuntime) {
    egRuntime.menu = null;
    egRuntime.dragged = false;
  }
}

function egRenderMenu(button, config, onAction) {
  egCloseMenu();
  const rect = button.getBoundingClientRect();
  const originX = rect.left + rect.width / 2;
  const originY = rect.top + rect.height / 2;
  const menu = document.createElement("div");
  menu.id = "episodeQuickMenu";
  menu.className = "episode-quick-menu";
  menu.dataset.originX = String(originX);
  menu.dataset.originY = String(originY);
  menu.dataset.episodeKey = button.dataset.episodeKey;
  menu.style.setProperty("--quick-x", `${originX}px`);
  menu.style.setProperty("--quick-y", `${originY}px`);
  const items = EG_SLOTS.filter((slot) => config.slots[slot]).map((slot) => {
    const action = config.slots[slot];
    return `<span class="episode-quick-action ${slot}" data-episode-action="${action}" data-slot="${slot}">${escapeHtml(EG_ACTION_LABELS[action] || action)}</span>`;
  }).join("");
  menu.innerHTML = `
    <span class="episode-quick-halo"></span>
    <span class="episode-quick-trail"></span>
    <span class="episode-quick-cursor"></span>
    ${items}`;
  menu.addEventListener("click", (event) => {
    const item = event.target.closest("[data-episode-action]");
    if (!item || !egRuntime) return;
    event.preventDefault();
    event.stopPropagation();
    const key = menu.dataset.episodeKey || "";
    const cell = key ? document.querySelector(`.episode-cell[data-episode-key="${CSS.escape(key)}"]`) : null;
    egCloseMenu();
    onAction(item.dataset.episodeAction, key, cell);
  });
  $("#progressModal").append(menu);
  requestAnimationFrame(() => menu.classList.add("visible"));
  egRuntime.menu = menu;
  return menu;
}

function egUpdateTarget(event) {
  const menu = egRuntime?.menu;
  if (!menu) return;
  const originX = Number(menu.dataset.originX);
  const originY = Number(menu.dataset.originY);
  const deltaX = event.clientX - originX;
  const deltaY = event.clientY - originY;
  const distance = Math.min(112, Math.hypot(deltaX, deltaY));
  menu.style.setProperty("--drag-x", `${Math.max(-110, Math.min(110, deltaX))}px`);
  menu.style.setProperty("--drag-y", `${Math.max(-110, Math.min(110, deltaY))}px`);
  menu.style.setProperty("--drag-distance", `${distance}px`);
  menu.style.setProperty("--drag-angle", `${Math.atan2(deltaY, deltaX)}rad`);
  menu.classList.toggle("dragging", distance > 10);
  let target = "";
  let closest = Infinity;
  menu.querySelectorAll("[data-slot]").forEach((item) => {
    const [x, y] = EG_COORDS[item.dataset.slot] || [0, 0];
    const next = Math.hypot(event.clientX - (originX + x), event.clientY - (originY + y));
    if (next < closest) { closest = next; target = item.dataset.slot; }
  });
  menu.querySelectorAll("[data-episode-action]").forEach((item) => {
    item.classList.toggle("active", item.dataset.slot === target && closest < EG_HIT_RADIUS);
  });
}

function installEpisodeGestures(root, options) {
  if (!root || root.dataset.egInstalled === "1") return;
  root.dataset.egInstalled = "1";
  egRuntime = {
    button: null, pointerId: null, startX: 0, startY: 0, index: 0,
    pressTimer: 0, longFired: false, menu: null, dragged: false,
    suppressClick: false, clickTimer: 0, clickButton: null,
  };
  const configOf = () => episodeGestureConfig();
  const cellOf = (target) => target instanceof Element ? target.closest(".episode-cell") : null;

  const run = (gesture, button) => {
    if (!button || !gesture) return;
    const config = configOf();
    if (!config.enabled) return;
    const action = config.bindings[gesture];
    if (!action) return;
    if (action === "open_menu") {
      egRenderMenu(button, config, options.onAction);
      return;
    }
    options.onAction(action, button.dataset.episodeKey, button);
  };

  root.addEventListener("pointerdown", (event) => {
    const button = cellOf(event.target);
    if (!button || !configOf().enabled) return;
    if (egRuntime.menu && !event.target.closest("#episodeQuickMenu")) egCloseMenu();
    egRuntime.suppressClick = false;
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
    egRuntime.pressTimer = window.setTimeout(() => {
      egRuntime.longFired = true;
      const base = egRuntime.index === 2 ? "LongRightClick" : "LongClick";
      run(egRuntime.modPrefix + base, egRuntime.button);
    }, EG_LONG_PRESS_MS);
  });

  root.addEventListener("pointermove", (event) => {
    if (!egRuntime.menu) return;
    const distance = Math.hypot(event.clientX - egRuntime.startX, event.clientY - egRuntime.startY);
    if (distance > 10) egRuntime.dragged = true;
    egUpdateTarget(event);
  });

  root.addEventListener("pointerup", (event) => {
    const button = egRuntime.button;
    if (!button) return;
    window.clearTimeout(egRuntime.pressTimer);
    egRuntime.suppressClick = true;
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
    if (egRuntime.longFired) {
      // 长按手势在定时器里已经分发过了。
      egRuntime.button = null;
      return;
    }
    const base = egRuntime.index === 2 ? "RightClick" : egRuntime.index === 1 ? "MiddleClick" : "Click";
    const gesture = egRuntime.modPrefix + base;
    egRuntime.button = null;
    if (base === "Click" && !egRuntime.modPrefix) {
      // 裸左键单击固定切换已看；只有绑定了双击时才等 250ms 判定。
      if (egDoubleClickBound(config)) {
        if (egRuntime.clickTimer) {
          window.clearTimeout(egRuntime.clickTimer);
          egRuntime.clickTimer = 0;
          const bound = Object.keys(config.bindings).find((item) => item === "DoubleClick" || item === egRuntime.modPrefix + "DoubleClick");
          if (bound) options.onAction(config.bindings[bound], button.dataset.episodeKey, button);
        } else {
          egRuntime.clickButton = button;
          egRuntime.clickTimer = window.setTimeout(() => {
            egRuntime.clickTimer = 0;
            options.onToggleWatched(egRuntime.clickButton);
          }, EG_DOUBLE_DELAY);
        }
      } else {
        options.onToggleWatched(button);
      }
      return;
    }
    run(gesture, button);
  });

  root.addEventListener("pointercancel", () => {
    window.clearTimeout(egRuntime.pressTimer);
    egCloseMenu();
    egRuntime.button = null;
  });

  root.addEventListener("click", (event) => {
    if (egRuntime.suppressClick) { egRuntime.suppressClick = false; return; }
    if (event.target.closest("#episodeQuickMenu")) return;
    const button = cellOf(event.target);
    // 键盘 Enter/Space 触发的 click 没有 pointer 事件，这里补一次已看切换。
    if (button) options.onToggleWatched(button);
  });

  root.addEventListener("contextmenu", (event) => {
    if (cellOf(event.target)) event.preventDefault();
  });

  document.addEventListener("pointerdown", (event) => {
    if (!egRuntime.menu || event.target.closest("#episodeQuickMenu") || cellOf(event.target)) return;
    egCloseMenu();
  }, true);

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && egRuntime.menu) egCloseMenu();
  });
}

// ---- 设置界面：扇区六格 + 手势绑定表 ------------------------------------
const EG_UI_GESTURES = [
  "RightClick", "LongClick", "LongRightClick", "MiddleClick", "DoubleClick",
  "Ctrl+Click", "Alt+Click", "Shift+Click", "Ctrl+Shift+Click",
  "Ctrl+RightClick", "Ctrl+Shift+RightClick",
];

function egActionOptions(selected, allowMenu = true) {
  return Object.entries(EG_ACTION_LABELS)
    .filter(([id]) => allowMenu || id !== "open_menu")
    .map(([id, label]) => `<option value="${id}"${id === selected ? " selected" : ""}>${escapeHtml(label)}</option>`)
    .join("");
}

function readEpisodeGestureSettings() {
  const slots = {};
  $$("[data-eg-slot]").forEach((select) => { slots[select.dataset.egSlot] = select.value; });
  const bindings = {};
  $$("[data-eg-gesture]").forEach((select) => {
    if (select.value) bindings[select.dataset.egGesture] = select.value;
  });
  const counts = {};
  for (const [gesture, action] of Object.entries(bindings)) {
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
  };
}

function renderEpisodeGestureSettings() {
  const enabled = $("#episodeGestureEnabledInput");
  if (!enabled) return;
  const config = episodeGestureConfig();
  enabled.checked = config.enabled;
  $("#episodeGestureKeepMenuInput").checked = config.keepMenu;
  $("#episodeGestureSlots").innerHTML = EG_SLOTS.map((slot) => `
    <label class="eg-row"><span>${escapeHtml(EG_SLOT_LABELS[slot])}</span>
      <select data-eg-slot="${slot}" aria-label="${escapeHtml(EG_SLOT_LABELS[slot])}的动作">
        <option value="">（空）</option>
        ${egActionOptions(config.slots[slot], false)}
      </select>
    </label>`).join("");
  $("#episodeGestureBindings").innerHTML = EG_UI_GESTURES.map((gesture) => `
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
    state.settings.episode_gestures = JSON.parse(JSON.stringify(EG_DEFAULT));
    renderEpisodeGestureSettings();
  };
  refresh();
}
