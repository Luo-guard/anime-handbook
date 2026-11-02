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

function setupSettingHelp() {
  if (!settingHelpAvailable()) return;
  $$("#settingsModal .setting-row").forEach((row) => {
    if (row.querySelector(".setting-help")) return;
    const firstSmall = row.querySelector("small");
    const title = firstSmall?.parentElement?.querySelector("strong");
    if (!firstSmall || !title) return;
    const label = title.textContent.trim();
    // 同一行标题下可能有多段说明，全部收起并由问号统一展示；
    // 带 id 的是运行时状态（如“已连接坚果云”），必须继续可见。
    const sources = [...title.parentElement.querySelectorAll(":scope > small")].filter((node) => !node.id);
    sources.forEach((source) => source.classList.add("setting-help-source"));
    // 用 span 而不是 <button>：整行是 <label>，可聚焦的 <button> 会抢走
    // label 与开关的关联，导致点开关没反应。span 不会参与 label 关联。
    const button = document.createElement("span");
    button.className = "setting-help";
    button.textContent = "?";
    button.dataset.helpTitle = label;
    button.setAttribute("role", "button");
    button.setAttribute("tabindex", "0");
    button.setAttribute("aria-label", `查看“${label}”的说明`);
    button.setAttribute("aria-expanded", "false");
    settingHelpSources.set(button, sources);
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
    title.append(button);
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
