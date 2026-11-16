// 单集格子手势识别、扇区布局和动作分发。
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
const EG_LEGACY_ORDER = ["top", "top_right", "bottom_right", "bottom", "bottom_left", "top_left"];
const EG_LEGACY_SLOTS = {
  top: "play", bottom: "download", top_right: "score",
  bottom_right: "review", top_left: "ed", bottom_left: "op",
};
const EG_MENU_LABELS = {
  play: ["▶", "播放"], score: ["☆", "评分"], review: ["✎", "评价"],
  download: ["↓", "下载"], op: ["♫", "OP"], ed: ["♪", "ED"],
  reveal_in_folder: ["▣", "本地文件"], redownload: ["↻", "其他片源"],
  cancel_download: ["×", "取消下载"], delete: ["−", "删除文件"],
};

const EG_RECORD_SETTINGS = {
  review: "show_episode_review_record", score: "show_episode_rating_record",
  op: "show_oped_record", ed: "show_oped_record",
};
const EG_AVAILABLE_ACTIONS = Object.keys(EG_MENU_LABELS);
const EG_DEFAULT = {
  enabled: true,
  keepMenu: true,
  actions: EG_LEGACY_ORDER.map(slot => EG_LEGACY_SLOTS[slot]),
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
  const slots = { ...EG_LEGACY_SLOTS, ...raw.slots };
  const actions = Array.isArray(raw.actions) ? raw.actions : EG_LEGACY_ORDER
    .map(slot => slots[slot])
    .filter(action => !hiddenActions.has(action));
  if (!Array.isArray(raw.actions) && state.settings?.detail_wheel_style === "modern" && !hiddenActions.has("reveal_in_folder")) {
    actions.push("reveal_in_folder");
  }
  return {
    enabled: raw.enabled !== false,
    keepMenu: raw.keep_menu_on_release !== false,
    actions: [...new Set(actions.filter(action => EG_AVAILABLE_ACTIONS.includes(action)))],
    bindings: removeRetiredAction(raw.bindings || EG_DEFAULT.bindings),
    playbackSource: raw.playback_source || (localHidden === onlineHidden ? "auto" : localHidden ? "online" : "local"),
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

function egActionPositions(actions) {
  return actions.map((action, index) => {
    const degrees = 360 * index / actions.length;
    const angle = degrees * Math.PI / 180;
    return { action, degrees, x: Math.sin(angle), y: -Math.cos(angle) };
  });
}

function egRenderMenu(button, config, onAction) {
  egCloseMenu();
  const modern = state.settings?.detail_wheel_style === "modern";
  const downloaded = button.classList.contains("downloaded");
  const playbackUnavailable = button.classList.contains("unreleased")
    && (!downloaded || config.playbackSource === "online");
  const actions = config.actions.filter(action => egRecordEnabled(action)
    && (downloaded || (action !== "delete" && action !== "reveal_in_folder")));
  if (!actions.length) return;

  const entries = egActionPositions(actions);
  const availableSpace = Math.min(innerWidth, innerHeight) - 16;
  const radius = actions.length > 7 ? 105 : 94;
  const diameter = modern ? Math.min(actions.length > 7 ? 350 : 314, availableSpace) : (radius + 34) * 2;
  const compact = availableSpace < (modern ? (actions.length > 7 ? 340 : 275) : diameter);
  const panel = modern || compact;
  const rect = button.getBoundingClientRect();
  const fit = (center, size, extent) => Math.max(extent, Math.min(center, size - extent));
  const originX = compact ? innerWidth / 2 : fit(rect.left + rect.width / 2, innerWidth, diameter / 2 + 8);
  const originY = compact ? innerHeight / 2 : fit(rect.top + rect.height / 2, innerHeight, diameter / 2 + 8);
  const menu = document.createElement("div");
  menu.id = "episodeQuickMenu";
  menu.className = "episode-quick-menu";
  menu.classList.toggle("detail-modern-wheel", panel);
  menu.classList.toggle("detail-wheel-compact", compact);
  menu.setAttribute("role", "group");
  const type = Number(button.dataset.episodeType) || 0;
  const label = button.dataset.detailEpisodeLabel || button.textContent.trim();
  const group = button.closest(".episode-group")?.querySelector(".episode-group-head strong")?.textContent;
  const title = type ? `${group || ""} ${label}`.trim() : `第 ${label} 集`;
  menu.setAttribute("aria-label", `${title}的单集操作`);
  menu.style.setProperty("--quick-x", `${originX}px`);
  menu.style.setProperty("--quick-y", `${originY}px`);
  menu.style.setProperty("--wheel-diameter", `${diameter}px`);
  const decorations = panel ? "" : '<span class="episode-quick-halo" aria-hidden="true"></span>'
    + '<span class="episode-quick-trail" aria-hidden="true"></span>'
    + '<span class="episode-quick-cursor" aria-hidden="true"></span>';
  const arc = 360 / entries.length;
  menu.innerHTML = decorations
    + `<button type="button" class="episode-quick-action episode-quick-close" data-episode-menu-close aria-label="关闭单集扇区"><span aria-hidden="true">×</span>${panel ? `<small>${escapeHtml(title)}</small>` : ""}</button>`
    + entries.map(({action, degrees, x, y}) => {
      const [icon, shortLabel] = EG_MENU_LABELS[action];
      const position = panel ? `left:${50 + 34 * x}%;top:${50 + 34 * y}%` : `left:${radius * x}px;top:${radius * y}px`;
      const disabled = action === "play" && playbackUnavailable;
      const label = compact ? EG_ACTION_LABELS[action] : shortLabel;
      return `<button type="button" class="episode-quick-action" style="${position}" data-episode-action="${action}" aria-label="${escapeHtml(EG_ACTION_LABELS[action])}" title="${disabled ? "本集尚未播出" : escapeHtml(EG_ACTION_LABELS[action])}"${disabled ? " disabled" : ""}>${panel ? `<span class="episode-wheel-icon" aria-hidden="true">${icon}</span>` : ""}<span>${escapeHtml(label)}</span></button>`
        + (modern && !compact ? `<span class="episode-wheel-wedge" aria-hidden="true" style="--start:${degrees - arc / 2}deg;--arc:${arc}deg"></span>` : "");
    }).join("");

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

  // 扇区通常延伸到集数区外，滑选需要在 document 上持续跟踪指针。
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

  root.addEventListener("touchmove", event => {
    if (event.cancelable && egRuntime.button && egRuntime.longFired && egRuntime.menu) {
      event.preventDefault();
    }
  }, { passive: false });

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

// ---- 设置界面：扇区动作和手势绑定 ------------------------------------
const EG_UI_GESTURES = [
  "RightClick", "LongClick", "LongRightClick", "MiddleClick", "DoubleClick",
  "Ctrl+Click", "Alt+Click", "Shift+Click", "Ctrl+Shift+Click",
  "Ctrl+RightClick", "Ctrl+Shift+RightClick",
];

function egActionOptions(selected) {
  return Object.entries(EG_ACTION_LABELS)
    .map(([id, label]) => `<option value="${id}"${id === selected ? " selected" : ""}>${escapeHtml(label)}</option>`)
    .join("");
}

function readEpisodeGestureSettings() {
  const actions = $$("#episodeGestureActions [data-eg-action]").map(row => row.dataset.egAction);

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
    actions,
    bindings,
  };
}

function renderEpisodeActionEditor(actions) {
  const list = $("#episodeGestureActions");
  const select = $("#episodeGestureActionSelect");
  const add = $("#addEpisodeGestureAction");
  const preview = $("#episodeGesturePreview");
  const status = $("#episodeGestureLayoutStatus");
  const render = (focusAction, command) => {
    list.innerHTML = actions.map((action, index) => {
      const label = escapeHtml(EG_ACTION_LABELS[action]);
      return `<li data-eg-action="${action}">
        <span class="eg-action-icon" aria-hidden="true">${EG_MENU_LABELS[action][0]}</span><span>${label}</span>
        <span class="eg-action-buttons">
          <button type="button" data-eg-command="up" aria-label="上移${label}" ${index === 0 ? "disabled" : ""}>↑</button>
          <button type="button" data-eg-command="down" aria-label="下移${label}" ${index === actions.length - 1 ? "disabled" : ""}>↓</button>
          <button type="button" data-eg-command="remove" aria-label="移除${label}">×</button>
        </span>
      </li>`;
    }).join("");
    const options = EG_AVAILABLE_ACTIONS.filter(action => !actions.includes(action));
    select.innerHTML = '<option value="">选择动作</option>'
      + options.map(action => `<option value="${action}">${escapeHtml(EG_ACTION_LABELS[action])}</option>`).join("");
    select.disabled = !options.length;
    add.disabled = true;
    preview.innerHTML = '<span class="eg-preview-center">预览</span>'
      + egActionPositions(actions).map(({action, x, y}) =>
        `<span class="eg-preview-item" style="left:${50 + 36 * x}%;top:${50 + 36 * y}%">${EG_MENU_LABELS[action][0]}</span>`).join("");
    status.textContent = actions.length ? `已添加 ${actions.length} 个动作` : "暂无动作。可从下方添加。";
    if (focusAction) {
      const row = list.querySelector(`[data-eg-action="${focusAction}"]`);
      (row?.querySelector(`[data-eg-command="${command}"]:not(:disabled)`)
        || row?.querySelector("button:not(:disabled)") || select).focus();
    }
  };
  select.onchange = () => { add.disabled = !select.value; };
  add.onclick = () => {
    if (!EG_AVAILABLE_ACTIONS.includes(select.value) || actions.includes(select.value)) return;
    actions.push(select.value);
    render(actions.at(-1), "up");
  };
  list.onclick = event => {
    const button = event.target.closest("[data-eg-command]");
    if (!button || button.disabled) return;
    const action = button.closest("[data-eg-action]").dataset.egAction;
    const index = actions.indexOf(action);
    const command = button.dataset.egCommand;
    actions.splice(index, 1);
    if (command !== "remove") actions.splice(index + (command === "up" ? -1 : 1), 0, action);
    render(command === "remove" ? actions[Math.min(index, actions.length - 1)] : action, command);
    if (!actions.length) select.focus();
  };
  render();
}

function renderEpisodeGestureSettings(config = episodeGestureConfig()) {
  const enabled = $("#episodeGestureEnabledInput");
  if (!enabled) return;
  enabled.checked = config.enabled;
  $("#episodeGestureKeepMenuInput").checked = config.keepMenu;
  renderEpisodeActionEditor([...config.actions]);

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
  $$("[data-eg-gesture]").forEach((select) => select.addEventListener("change", refresh));
  $("#resetEpisodeGestures").onclick = () => {
    renderEpisodeGestureSettings(EG_DEFAULT);
  };
  refresh();
}
