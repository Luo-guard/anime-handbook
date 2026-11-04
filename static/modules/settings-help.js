// 设置项说明：默认收起，标题右侧一个小问号，悬停或点击查看原来的说明文字。
// 说明正文仍留在 HTML 的 <small> 里（含 data-page-text 的本地化），这里只负责显隐与弹层。
const settingHelpSources = new WeakMap();
let settingHelpPinned = false;
let settingHelpButton = null;
let settingHelpTimer = null;

function settingHelpPopover() {
  let node = $("#settingHelpPopover");
  if (node) return node;
  node = document.createElement("div");
  node.id = "settingHelpPopover";
  node.className = "setting-help-popover hidden";
  node.setAttribute("role", "tooltip");
  ($("#settingsModal") || document.body).append(node);
  return node;
}

function settingHelpPlace(button, popover) {
  const rect = button.getBoundingClientRect();
  const gap = 8;
  const margin = 10;
  popover.classList.remove("hidden");
  const box = popover.getBoundingClientRect();
  const left = Math.min(
    window.innerWidth - margin - box.width,
    Math.max(margin, rect.left + rect.width / 2 - box.width / 2),
  );
  let top = rect.bottom + gap;
  // 下方放不下就翻到按钮上方，两边都放不下时贴住可视区底部。
  if (top + box.height > window.innerHeight - margin) {
    top = Math.max(margin, rect.top - box.height - gap);
  }
  popover.style.left = `${Math.round(left)}px`;
  popover.style.top = `${Math.round(top)}px`;
}

function settingHelpBody(sources) {
  // 有 data-page-text 的行会被 applyPageLabels 重写成纯文本，这里做兼容。
  return sources
    .map((source) => source.innerHTML.trim() || escapeHtml(source.textContent || ""))
    .filter(Boolean)
    .join("<br>");
}

function openSettingHelp(button, pinned) {
  const sources = settingHelpSources.get(button);
  if (!sources) return;
  clearTimeout(settingHelpTimer);
  settingHelpButton = button;
  const popover = settingHelpPopover();
  const title = button.dataset.helpTitle || "";
  popover.innerHTML = `${title ? `<p class="setting-help-title">${escapeHtml(title)}</p>` : ""}<div class="setting-help-body">${settingHelpBody(sources)}</div>`;
  popover.classList.toggle("is-pinned", Boolean(pinned));
  button.setAttribute("aria-expanded", "true");
  settingHelpPlace(button, popover);
  if (pinned) settingHelpPinned = true;
}

// 悬停离开时留一点点缓冲，方便把鼠标移到说明上继续看。
function scheduleSettingHelpClose(delay = 180) {
  clearTimeout(settingHelpTimer);
  settingHelpTimer = setTimeout(() => {
    if (!settingHelpPinned) closeSettingHelp();
  }, delay);
}

function closeSettingHelp(force = false) {
  if (settingHelpPinned && !force) return;
  clearTimeout(settingHelpTimer);
  settingHelpButton?.setAttribute("aria-expanded", "false");
  $("#settingHelpPopover")?.classList.add("hidden");
  settingHelpPinned = false;
  settingHelpButton = null;
}

// 纯静态分析/测试环境里没有完整 DOM，这里保持安静地跳过。
function settingHelpAvailable() {
  return typeof document !== "undefined"
    && typeof window !== "undefined"
    && typeof document.addEventListener === "function"
    && typeof document.querySelectorAll === "function";
}

// 说明可能挂在设置行、共享步骤标题、站点编辑器的字段标签或分区标题上。
// 统一收进标题右侧的问号；带 id 的是运行时状态，必须继续可见。
function appendSettingHelp(anchor, title, sources) {
  if (!anchor || !title || !sources?.length) return;
  if (anchor.querySelector(".setting-help")) return;
  const visibleSources = sources.filter((node) => node && !node.id);
  if (!visibleSources.length) return;
  const label = title.textContent.trim();
  visibleSources.forEach((source) => source.classList.add("setting-help-source"));
  // 用 span 而不是 <button>：整行/整个标签是 <label>，可聚焦的 <button>
  // 会抢走 label 与控件的关联，导致点开关没反应。span 不参与 label 关联。
  const button = document.createElement("span");
  button.className = "setting-help";
  button.textContent = "?";
  button.dataset.helpTitle = label;
  button.setAttribute("role", "button");
  button.setAttribute("tabindex", "0");
  button.setAttribute("aria-label", `查看“${label}”的说明`);
  button.setAttribute("aria-expanded", "false");
  settingHelpSources.set(button, visibleSources);
  // 点问号不应该顺带切换同一行的开关。
  button.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (settingHelpPinned && settingHelpButton === button) {
      closeSettingHelp(true);
      return;
    }
    settingHelpPinned = false;
    openSettingHelp(button, true);
  });
  button.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    event.stopPropagation();
    if (settingHelpPinned && settingHelpButton === button) closeSettingHelp(true);
    else {
      settingHelpPinned = false;
      openSettingHelp(button, true);
    }
  });
  button.addEventListener("pointerenter", () => {
    if (!settingHelpPinned) openSettingHelp(button, false);
  });
  button.addEventListener("pointerleave", () => {
    if (!settingHelpPinned) scheduleSettingHelpClose();
  });
  button.addEventListener("focus", () => {
    if (!settingHelpPinned) openSettingHelp(button, false);
  });
  button.addEventListener("blur", () => {
    if (!settingHelpPinned) closeSettingHelp();
  });
  anchor.append(button);
}

function setupSettingHelp() {
  if (!settingHelpAvailable()) return;
  // 普通设置行：标题下直接跟一个或多个 <small>。
  $$("#settingsModal .setting-row").forEach((row) => {
    const firstSmall = row.querySelector("small");
    const title = firstSmall?.parentElement?.querySelector("strong");
    if (!firstSmall || !title) return;
    // 只取标题同级的说明，避免把子编辑器里的说明也吞掉。
    appendSettingHelp(title, title, [...title.parentElement.querySelectorAll(":scope > small")]);
  });
  // 共享/同步的编号步骤：说明在 <span> 里的 <small>。
  $$("#settingsModal .sharing-step-heading").forEach((heading) => {
    const title = heading.querySelector(":scope > span > strong") || heading.querySelector("strong");
    if (!title) return;
    appendSettingHelp(title, title, [...heading.querySelectorAll(":scope > span > small")]);
  });
  // Bangumi 站点编辑器：站点地址/API 地址各自的小字。
  $$("#settingsModal .bgm-source-editor > label").forEach((label) => {
    const title = label.querySelector(":scope > span");
    if (!title) return;
    appendSettingHelp(title, title, [...label.querySelectorAll(":scope > small")]);
  });
  // 分区标题下的整段导语（如“主题”页顶部那段），收进标题右侧的问号。
  $$("#settingsModal .settings-section-title").forEach((title) => {
    const lead = title.nextElementSibling;
    if (!lead?.classList?.contains("settings-lead")) return;
    appendSettingHelp(title, title, [lead]);
  });
}

function bindSettingHelpGlobals() {
  document.addEventListener("pointerdown", (event) => {
    if (!settingHelpPinned) return;
    if (event.target.closest?.(".setting-help, #settingHelpPopover")) return;
    closeSettingHelp(true);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !settingHelpPinned) return;
    // 只收起说明，别让 <dialog> 顺手把整个设置面板关掉。
    event.preventDefault();
    event.stopPropagation();
    closeSettingHelp(true);
  }, true);
}
// 弹层是固定定位：面板滚动时跟随按钮，按钮滚出可视区才收起。
function followSettingHelp() {
  if (!settingHelpButton) return;
  const rect = settingHelpButton.getBoundingClientRect();
  if (rect.bottom < 0 || rect.top > window.innerHeight) {
    closeSettingHelp(true);
    return;
  }
  settingHelpPlace(settingHelpButton, settingHelpPopover());
}
// 鼠标移进说明本身时不收起，方便看完再走。
function bindSettingHelpOnce() {
  if (!settingHelpAvailable()) return;
  bindSettingHelpGlobals();
  const modal = $("#settingsModal");
  modal?.addEventListener?.("scroll", followSettingHelp, { passive: true });
  window.addEventListener("resize", followSettingHelp);
  modal?.addEventListener?.("pointerenter", (event) => {
    if (event.target.closest?.("#settingHelpPopover")) clearTimeout(settingHelpTimer);
  }, true);
  modal?.addEventListener?.("pointerleave", (event) => {
    if (event.target.closest?.("#settingHelpPopover") && !settingHelpPinned) scheduleSettingHelpClose(220);
  }, true);
  setupSettingHelp();
}

bindSettingHelpOnce();
