function populateAnimeSelect() {
  const select = $("#noteAnime");
  const current = select.value;
  const options = [...state.animes]
    .sort((a, b) => a.display_name.localeCompare(b.display_name, "zh-CN"))
    .map(
      (anime) =>
        `<option value="${anime.id}">${escapeHtml(anime.display_name)}</option>`,
    )
    .join("");
  select.innerHTML = `<option value="">不关联动漫</option>${options}`;
  if ([...select.options].some((option) => option.value === current)) {
    select.value = current;
  }
  updateAssociatedAnimeLabel();
  renderNoteThemePicker();
  renderTimelineThemeFilter();
}

// Shared dismissal rules for custom multi-select menus.
function setupDismissibleMenu(buttonSelector, menuSelector) {
  const button = $(buttonSelector), menu = $(menuSelector);
  const isInside = target => target instanceof Node && (button.contains(target) || menu.contains(target));
  const setOpen = open => {
    menu.classList.toggle("hidden", !open);
    button.setAttribute("aria-expanded", String(open));
  };
  button.setAttribute("aria-controls", menu.id);
  setOpen(false);
  button.addEventListener("click", () => setOpen(menu.classList.contains("hidden")));
  const dismissOutside = event => { if (!isInside(event.target)) setOpen(false); };
  document.addEventListener("pointerdown", dismissOutside, true);
  document.addEventListener("click", dismissOutside, true);
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && !menu.classList.contains("hidden")) {
      setOpen(false);
      button.focus();
    }
  });
  return {close: () => setOpen(false)};
}

function updateAssociatedAnimeLabel() {
  const select = $("#noteAnime");
  $("#noteAnimeButton").textContent = `${select.selectedOptions[0]?.textContent || "不关联动漫"} ▾`;
}

function setupAssociatedAnimeMenu() {
  const select = $("#noteAnime"), menu = $("#noteAnimeMenu"), button = $("#noteAnimeButton");
  button.addEventListener("click", () => {
    menu.innerHTML = [...select.options].map(option => `<button type="button" role="option" aria-selected="${option.value === select.value}" data-anime-option="${escapeHtml(option.value)}">${escapeHtml(option.textContent)}</button>`).join("");
  });
  const dropdown = setupDismissibleMenu("#noteAnimeButton", "#noteAnimeMenu");
  menu.addEventListener("click", event => {
    const option = event.target.closest("[data-anime-option]");
    if (!option) return;
    select.value = option.dataset.animeOption;
    select.dispatchEvent(new Event("change", {bubbles: true}));
    dropdown.close();
    button.focus();
  });
  menu.addEventListener("keydown", event => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const options = [...menu.querySelectorAll("[data-anime-option]")];
    if (!options.length) return;
    event.preventDefault();
    const index = options.indexOf(document.activeElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
    options[next].focus();
  });
  button.addEventListener("keydown", event => {
    if (event.key === "ArrowDown") { event.preventDefault(); if (menu.classList.contains("hidden")) button.click(); menu.querySelector("[data-anime-option]")?.focus(); }
  });
  select.addEventListener("change", updateAssociatedAnimeLabel);
}

function renderNoteThemePicker() {
  const menu = $("#noteThemeMenu");
  const visibleIds = new Set(recordThemes().map((theme) => theme.id));
  state.noteThemes = new Set([...state.noteThemes].filter((id) => visibleIds.has(id)));
  if (!state.noteThemes.size) state.noteThemes.add("other");
  menu.innerHTML = `${recordThemes().map((theme) => `<div><button type="button" data-note-theme="${escapeHtml(theme.id)}" aria-pressed="${state.noteThemes.has(theme.id)}"><i style="--theme-dot:${escapeHtml(theme.color)}"></i><span>${state.noteThemes.has(theme.id) ? "✓ " : ""}${escapeHtml(theme.name)}</span></button>${theme.builtin ? "" : `<button type="button" class="remove-theme" data-remove-theme="${escapeHtml(theme.id)}" title="删除主题">×</button>`}</div>`).join("")}<button type="button" class="text-button" id="createRecordTheme">新建主题</button>`;
  menu.querySelectorAll("[data-note-theme]").forEach((button) => button.addEventListener("click", () => {
    const id = button.dataset.noteTheme;
    if (state.noteThemes.has(id) && state.noteThemes.size > 1) state.noteThemes.delete(id);
    else state.noteThemes.add(id);
    renderNoteThemePicker();
    updateNoteThemeLabel();
  }));
  menu.querySelectorAll("[data-remove-theme]").forEach((button) => button.addEventListener("click", async () => {
    const id = button.dataset.removeTheme;
    if (!confirm("删除这个自定义主题？已有记录不会被删除。")) return;
    try { const payload = await api("/api/settings", { method: "PATCH", body: JSON.stringify({ record_themes: allRecordThemes().filter((theme) => theme.id !== id) }) }); state.settings = payload.settings; state.noteThemes.delete(id); if (!state.noteThemes.size) state.noteThemes.add("other"); populateAnimeSelect(); } catch (error) { toast(error.message, "error"); }
  }));
  $("#createRecordTheme", menu).addEventListener("click", createRecordTheme);
  updateNoteThemeLabel();
}

function updateNoteThemeLabel() {
  const names = recordThemes().filter((item) => state.noteThemes.has(item.id)).map((item) => item.name);
  $("#noteThemeButton").textContent = `${names.join("、") || "选择主题"} ▾`;
}

let timelineAvailableThemes = null;
function renderTimelineThemeFilter() {
  const menu = $("#timelineThemeFilterMenu");
  const themes = recordThemes().filter(theme => timelineAvailableThemes?.has(theme.id));
  const visibleIds = new Set(themes.map((theme) => theme.id));
  if (timelineAvailableThemes !== null) state.timelineThemes = new Set([...state.timelineThemes].filter((id) => visibleIds.has(id)));
  const selected = state.timelineThemes;
  menu.innerHTML = themes.map((theme) => `<label><input type="checkbox" value="${escapeHtml(theme.id)}" ${selected.has(theme.id) ? "checked" : ""} /><span class="theme-dot" style="--theme-dot:${escapeHtml(theme.color)}"></span>${escapeHtml(theme.name)}</label>`).join("") || `<p class="muted-line">${timelineAvailableThemes === null ? "正在读取记录主题…" : "暂无可筛选的记录主题"}</p>`;
  menu.querySelectorAll("input").forEach((input) => input.addEventListener("change", () => {
    if (input.checked) selected.add(input.value); else selected.delete(input.value);
    updateTimelineThemeFilterLabel();
    renderTimeline();
  }));
  updateTimelineThemeFilterLabel();
}

function updateTimelineThemeFilterLabel() {
  const button = $("#timelineThemeFilterButton");
  const names = recordThemes().filter((theme) => state.timelineThemes.has(theme.id)).map((theme) => theme.name);
  button.innerHTML = `${escapeHtml(names.length ? names.join("、") : "主题筛选")} <span>▾</span>`;
}

