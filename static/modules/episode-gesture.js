// 单集格子手势：识别、六格扇区、绑定表分发。
// details.js 只负责「某个动作到底做什么」，这里不碰业务。
//
// 左键单击固定切换已看，不进绑定表；带修饰键的单击、右键、长按、双击、中键
// 才走绑定表。A 版（按住滑到扇区松手）与 B 版（右键弹出后再点选）共用同一套
// 状态机，区别只在松手时有没有命中扇区、以及 keepMenu 开关。
const EG_ACTION_LABELS = {
  open_menu: "打开扇区", play: "播放", download: "下载", cancel_download: "取消下载",
  delete: "删除本地文件", score: "评分", review: "评价", op: "OP", ed: "ED",
  reveal_in_folder: "查看本地文件", redownload: "查找其他片源",
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
const EG_WHEEL_SLOTS = ["top", "top_right", "bottom_right", "bottom", "bottom_left", "top_left"];
const EG_WHEEL_ACTIONS = {
  play: ["▶", "播放本集"], score: ["☆", "单集评分"], review: ["✎", "单集评价"],
  download: ["↓", "查找资源"], op: ["♫", "OP 记录"], ed: ["♪", "ED 记录"],
  reveal_in_folder: ["▣", "查看本地文件"], redownload: ["↻", "查找其他片源"],
  cancel_download: ["×", "取消下载"], delete: ["−", "删除本地文件"],
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
  playbackSource: "auto",
  slots: {
    top: "play", bottom: "download", top_right: "score",
    bottom_right: "review", top_left: "ed", bottom_left: "op",
  },
  bindings: {
    RightClick: "open_menu", LongClick: "open_menu",
    "Alt+Click": "reveal_in_folder",
  },
};
const EG_LONG_PRESS_MS = 420;
const EG_DOUBLE_DELAY = 250;

function episodeGestureConfig() {
  const raw = state.settings?.episode_gestures || {};
  const hiddenActions = new Set(raw.hidden_actions || []);
  // 已保存的旧动作按留空处理，保留用户选择的其他布局和手势。
  hiddenActions.delete("open_detail");
  const removeRetiredAction = entries => Object.fromEntries(
    Object.entries(entries).map(([key, action]) => [key, action === "open_detail" ? "" : action]),
  );
  const onlineHidden = hiddenActions.delete("online_play");
  const localHidden = hiddenActions.has("play");
  if (!raw.playback_source && localHidden && !onlineHidden) hiddenActions.delete("play");
  return {
    enabled: raw.enabled !== false,
    keepMenu: raw.keep_menu_on_release !== false,
    slots: removeRetiredAction({ ...EG_DEFAULT.slots, ...raw.slots }),
    bindings: removeRetiredAction(raw.bindings || EG_DEFAULT.bindings),
    playbackSource: raw.playback_source || (localHidden === onlineHidden ? "auto" : localHidden ? "online" : "local"),
    hiddenActions,
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
  menu.removeAttribute("id");
  menu.inert = true;
  menu.classList.remove("visible");
  menu.classList.add("closing");
  setTimeout(() => menu.remove(), 200);
  egRuntime.menu = null;
  egRuntime.menuButton = null;
  egRuntime.dragged = false;
}

function egRenderMenu(button, config, onAction) {
  egCloseMenu();
  const modern = $("#progressModal").classList.contains("detail-modern");
  const downloaded = button.classList.contains("downloaded");
  const slots = Object.fromEntries((modern ? EG_WHEEL_SLOTS : EG_SLOTS).map(slot => [slot, config.slots[slot]]));
  for (const [slot, action] of Object.entries(slots)) {
    if (!egRecordEnabled(action) || config.hiddenActions.has(action)
      || (!downloaded && (action === "delete" || (modern && action === "reveal_in_folder")))) delete slots[slot];
  }
  const entries = Object.entries(slots).filter(([, action]) => action);
  if (modern && downloaded && !config.hiddenActions.has("reveal_in_folder") && !entries.some(([, action]) => action === "reveal_in_folder")) {
    entries.push(["local", "reveal_in_folder"]);
  }
  if (!entries.length) return;
  const rect = button.getBoundingClientRect();
  const diameter = Math.min(314, innerWidth - 16, innerHeight - 16);
  const compact = modern && diameter < 275;
  const scale = Math.min(1, (window.innerWidth - 56) / 164, (window.innerHeight - 56) / 188);
  const fit = (axis, center, size, pad) => {
    const offsets = [0, ...entries.map(([slot]) => EG_COORDS[slot][axis] * scale)];
    return Math.max(pad - Math.min(...offsets), Math.min(center, size - pad - Math.max(...offsets)));
  };
  const modernCenter = (center, size, radius) => Math.max(radius, Math.min(center, size - radius));
  const originX = modern
    ? modernCenter(rect.left + rect.width / 2, innerWidth, compact ? Math.min(143, innerWidth / 2) : diameter / 2 + 8)
    : fit(0, rect.left + rect.width / 2, innerWidth, 28);
  const originY = modern
    ? modernCenter(rect.top + rect.height / 2, innerHeight, compact ? innerHeight / 2 : diameter / 2 + 8)
    : fit(1, rect.top + rect.height / 2, innerHeight, 28);
  const menu = document.createElement("div");
  menu.id = "episodeQuickMenu";
  menu.className = "episode-quick-menu";
  menu.classList.toggle("detail-modern-wheel", modern);
  menu.classList.toggle("detail-wheel-compact", compact);
  menu.setAttribute("role", "group");
  menu.setAttribute("aria-label", "单集快捷操作");
  menu.style.setProperty("--quick-x", `${originX}px`);
  menu.style.setProperty("--quick-y", `${originY}px`);
  if (modern) {
    const type = Number(button.dataset.episodeType) || 0;
    const label = button.dataset.detailEpisodeLabel || button.textContent.trim();
    const group = button.closest(".episode-group")?.querySelector(".episode-group-head strong")?.textContent;
    const title = type ? `${group || ""} ${label}`.trim() : `第 ${label} 集`;
    menu.setAttribute("aria-label", `${title}的单集操作`);
    menu.style.setProperty("--wheel-diameter", `${diameter}px`);
    const arc = 360 / entries.length;
    menu.innerHTML = `<button type="button" class="episode-quick-action episode-quick-close" data-episode-menu-close aria-label="关闭单集扇区"><span aria-hidden="true">×</span><small>${escapeHtml(title)}</small></button>`
      + entries.map(([slot, action], index) => {
        const [icon, text] = EG_WHEEL_ACTIONS[action] || ["", EG_ACTION_LABELS[action]];
        const angle = index * arc * Math.PI / 180;
        const unavailable = action === "play" && button.classList.contains("unreleased")
          && (!downloaded || config.playbackSource === "online");
        return `<button type="button" class="episode-quick-action" style="left:${50 + 32 * Math.sin(angle)}%;top:${50 - 32 * Math.cos(angle)}%" data-episode-action="${action}" data-slot="${slot}"${unavailable ? ' disabled title="本集尚未播出"' : ""}><span class="episode-wheel-icon" aria-hidden="true">${icon}</span>${escapeHtml(text)}</button><span class="episode-wheel-wedge" aria-hidden="true" style="--start:${index * arc - arc / 2}deg;--arc:${arc}deg"></span>`;
      }).join("");
  } else {
    menu.innerHTML = '<span class="episode-quick-halo" aria-hidden="true"></span>'
      + '<span class="episode-quick-trail" aria-hidden="true"></span>'
      + '<span class="episode-quick-cursor" aria-hidden="true"></span>'
      + entries.map(([slot, action]) => {
        const [x, y] = EG_COORDS[slot];
        return `<button type="button" class="episode-quick-action" style="left:${x * scale}px;top:${y * scale}px" data-episode-action="${action}" data-slot="${slot}">${escapeHtml(EG_ACTION_LABELS[action])}</button>`;
      }).join("")
      + '<button type="button" class="episode-quick-action episode-quick-close" data-episode-menu-close aria-label="关闭单集扇区">×</button>';
  }
  menu.addEventListener("click", (event) => {
    const item = event.target.closest("[data-episode-action], [data-episode-menu-close]")
      || (event.detail && egWheelTarget(menu, event));
    if (!item || item.disabled || egRuntime?.menu !== menu) return;
    event.preventDefault();
    event.stopPropagation();
    egCloseMenu();
    button.focus({ preventScroll: true });
    if (button.isConnected && item.dataset.episodeAction) {
      onAction(item.dataset.episodeAction, button.dataset.episodeKey, button);
    }
  });
  $("#progressModal").append(menu);
  egRuntime.menu = menu;
  egRuntime.menuButton = button;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (egRuntime.menu === menu) menu.classList.add("visible");
  }));
  return menu;
}

function egWheelTarget(menu, event) {
  if (!menu.classList.contains("detail-modern-wheel") || menu.classList.contains("detail-wheel-compact")) return null;
  const rect = menu.getBoundingClientRect();
  const dx = event.clientX - (rect.left + rect.width / 2);
  const dy = event.clientY - (rect.top + rect.height / 2);
  const radius = Math.hypot(dx, dy);
  if (radius < rect.width * .15 || radius > rect.width / 2) return null;
  const actions = menu.querySelectorAll("[data-episode-action]");
  const angle = Math.atan2(dx, -dy) / (2 * Math.PI);
  return actions[(Math.round(angle * actions.length) + actions.length) % actions.length];
}

function egUpdateTarget(event) {
  const menu = egRuntime?.menu;
  if (!menu) return;
  const dx = event.clientX - parseFloat(menu.style.getPropertyValue("--quick-x"));
  const dy = event.clientY - parseFloat(menu.style.getPropertyValue("--quick-y"));
  const length = Math.hypot(dx, dy);
  const distance = Math.min(length, 112);
  menu.style.setProperty("--drag-distance", `${distance}px`);
  menu.style.setProperty("--drag-angle", `${Math.atan2(dy, dx)}rad`);
  menu.style.setProperty("--drag-x", `${length ? dx * distance / length : 0}px`);
  menu.style.setProperty("--drag-y", `${length ? dy * distance / length : 0}px`);
  menu.classList.toggle("dragging", Boolean(egRuntime.button && egRuntime.dragged));
  const wedge = egWheelTarget(menu, event);
  const direct = menu.classList.contains("detail-modern-wheel")
    ? document.elementFromPoint(event.clientX, event.clientY)?.closest("[data-episode-action], [data-episode-menu-close]")
    : null;
  menu.querySelectorAll("[data-episode-action]").forEach((item) => {
    const rect = item.getBoundingClientRect();
    item.classList.toggle("active", !item.disabled && (direct ? item === direct : wedge ? item === wedge
      : event.clientX >= rect.left && event.clientX <= rect.right
        && event.clientY >= rect.top && event.clientY <= rect.bottom));
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
      egRuntime.menu?.classList.remove("dragging");
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
      egRuntime.menu?.querySelector("button")?.focus({ preventScroll: true });
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
  $("#progressModal").addEventListener("scroll", event => {
    if (event.target !== egRuntime.menu) egCloseMenu();
  }, { capture: true, passive: true });
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
    .filter(([id]) => allowMenu || id !== "open_menu")
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
    playback_source: $("#episodePlaybackSourceInput").value,
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
