function builtinVisibility() {
  return state.settings.builtin_category_visibility || {};
}

function visibleBuiltinCategories() {
  const builtinCategoryVisibility = builtinVisibility();
  const order = state.settings.builtin_collection_order || CATEGORIES.map((item) => item.id);
  const byId = new Map(CATEGORIES.map((item) => [item.id, item]));
  return [...order.map(Number), ...CATEGORIES.map((item) => item.id)]
    .filter((id, index, list) => list.indexOf(id) === index)
    .map((id) => byId.get(id))
    .filter((category) => category && builtinCategoryVisibility[String(category.id)] !== false);
}

function hideCustomizedFromBuiltin() {
  return state.settings.hide_custom_collection_items_from_builtin !== false;
}

function activeVisibilityKey() {
  return state.collectionKind === "all"
    ? "all"
    : state.collectionKind === "custom"
    ? `custom:${state.customCollectionId}`
    : String(state.category);
}

function activeCustomCollection() {
  return state.custom_collections.find(
    (collection) => Number(collection.id) === Number(state.customCollectionId),
  );
}

function ensureVisibleCollection() {
  if (state.collectionKind === "all" && state.settings.show_all_collection_tab === false) {
    state.collectionKind = "builtin";
  }
  if (
    state.collectionKind === "builtin" &&
    !visibleBuiltinCategories().some((category) => category.id === state.category)
  ) {
    const firstBuiltin = visibleBuiltinCategories()[0];
    if (firstBuiltin) {
      state.category = firstBuiltin.id;
      return;
    }
    const firstCustom = state.custom_collections[0];
    if (firstCustom) {
      state.collectionKind = "custom";
      state.customCollectionId = Number(firstCustom.id);
    }
  }
  if (
    state.collectionKind === "custom" &&
    !state.custom_collections.some(
      (collection) => Number(collection.id) === Number(state.customCollectionId),
    )
  ) {
    const firstBuiltin = visibleBuiltinCategories()[0];
    if (firstBuiltin) {
      state.collectionKind = "builtin";
      state.category = firstBuiltin.id;
      state.customCollectionId = null;
    } else if (state.custom_collections[0]) {
      state.customCollectionId = Number(state.custom_collections[0].id);
    }
  }
}

function applyCollectionHome() {
  const home = String(state.settings.collection_home || "builtin:1");
  if (home === "all" && state.settings.show_all_collection_tab !== false) {
    state.collectionKind = "all";
    state.customCollectionId = null;
    return;
  }
  const [kind, rawId] = home.split(":");
  const id = Number(rawId);
  if (kind === "custom" && state.custom_collections.some((item) => Number(item.id) === id)) {
    state.collectionKind = "custom";
    state.customCollectionId = id;
    return;
  }
  if (kind === "builtin" && CATEGORIES.some((item) => item.id === id)) {
    state.collectionKind = "builtin";
    state.category = id;
    state.customCollectionId = null;
  }
  ensureVisibleCollection();
}

function builtinCollectionOrder() {
  const saved = Array.isArray(state.settings.builtin_collection_order)
    ? state.settings.builtin_collection_order.map(Number)
    : [];
  return [...saved, ...CATEGORIES.map((item) => item.id)]
    .filter((id, index, list) => CATEGORIES.some((item) => item.id === id) && list.indexOf(id) === index);
}

function filteredAnimes() {
  const keyword = state.search.trim().toLocaleLowerCase();
  return state.animes.filter((anime) => {
    const inCollection = state.collectionKind === "all"
      ? true
      : state.collectionKind === "custom"
      ? (anime.custom_collection_ids || []).map(Number).includes(Number(state.customCollectionId))
      : anime.collection_type === state.category &&
        !(hideCustomizedFromBuiltin() && anime.in_custom_collection);
    const seasonMatches = !state.seasonFilters.size || state.seasonFilters.has(animeSeasonKey(anime));
    if (!keyword) return inCollection && seasonMatches;
    return (
      inCollection &&
      seasonMatches &&
      `${anime.name} ${anime.name_cn}`.toLocaleLowerCase().includes(keyword)
    );
  }).sort(collectionComparator());
}

const SEASONS = [
  { month: 1, name: "冬季", label: "1月" },
  { month: 4, name: "春季", label: "4月" },
  { month: 7, name: "夏季", label: "7月" },
  { month: 10, name: "秋季", label: "10月" },
];

function animeSeasonKey(anime) {
  const match = String(anime.air_date || "").match(/^(\d{4})-(\d{1,2})/);
  if (!match) return "";
  const year = Number(match[1]);
  const month = Number(match[2]);
  const season = [...SEASONS].reverse().find((item) => month >= item.month) || SEASONS[0];
  return `${year}-${season.month}`;
}

function availableSeasonYears() {
  return [...new Set(state.animes.map((anime) => animeSeasonKey(anime).split("-")[0]).filter(Boolean))]
    .map(Number)
    .sort((a, b) => b - a);
}

// 季度筛选：一年一行 × 四季列的紧凑矩阵。
// 老版（全部年份平铺）胜在跨年份能连着点、一眼看全；两级年份卡好看，
// 但批量选要点「年份 → 季度 → 年份 → 季度」。这里把两者合并：矩阵平铺 +
// 行首点年份选全年 + 列头批量选同一季度 + 按住拖过一片格子批量刷选，
// 视觉沿用圆角/勾选/主题色。年份多时仍默认只露 12 行，更早的折叠。
let seasonYearsExpanded = false;
let seasonPanelBound = false;
let seasonPaint = null;
let seasonVisibleYearCache = [];
const SEASON_YEAR_LIMIT = 12;

function updateSeasonNote() {
  const count = state.seasonFilters.size;
  const note = $("#ccSeasonNote");
  if (note) {
    note.textContent = count ? `已选 ${count} 个季度` : "可多选，跨年份也能一起选";
    note.classList.toggle("is-active", count > 0);
  }
}

function setSeasonKey(key, on) {
  if (on) state.seasonFilters.add(key);
  else state.seasonFilters.delete(key);
}

// 拖拽过程中不重建 DOM（重建会打断 pointer 序列）；只改这一格的样式、
// 行首年份状态、列头状态和顶部计数，松手后再整体重渲染一次。
function paintSeasonCell(cell, on) {
  const key = cell.dataset.seasonKey;
  if (!key || (seasonPaint && seasonPaint.touched.has(key))) return;
  setSeasonKey(key, on);
  cell.classList.toggle("active", on);
  cell.setAttribute("aria-pressed", String(on));
  if (seasonPaint) seasonPaint.touched.add(key);
  const row = cell.closest(".season-matrix-row");
  if (row) {
    const cells = [...row.querySelectorAll("[data-season-key]")];
    const picked = cells.filter((item) => state.seasonFilters.has(item.dataset.seasonKey)).length;
    const yearButton = row.querySelector("[data-season-year]");
    if (yearButton) {
      yearButton.classList.toggle("active", picked === SEASONS.length);
      yearButton.classList.toggle("partial", picked > 0 && picked < SEASONS.length);
      yearButton.setAttribute("aria-pressed", String(picked === SEASONS.length));
    }
  }
  syncSeasonColumnStates();
  updateSeasonNote();
}

function syncSeasonColumnStates() {
  const matrix = $("#seasonFilterPanel .season-matrix");
  if (!matrix) return;
  const rows = [...matrix.querySelectorAll(".season-matrix-row")];
  matrix.querySelectorAll("[data-season-column]").forEach((head) => {
    const month = head.dataset.seasonColumn;
    const keys = rows.map((row) => `${row.dataset.year}-${month}`);
    const picked = keys.filter((key) => state.seasonFilters.has(key)).length;
    head.classList.toggle("active", picked > 0 && picked === keys.length);
    head.classList.toggle("partial", picked > 0 && picked < keys.length);
  });
}

function toggleSeasonColumn(month) {
  const keys = seasonVisibleYearCache.map((year) => `${year}-${month}`);
  const all = keys.length > 0 && keys.every((key) => state.seasonFilters.has(key));
  keys.forEach((key) => setSeasonKey(key, !all));
  renderSeasonFilter();
  renderCollection();
}

function toggleSeasonYear(year) {
  const keys = SEASONS.map((season) => `${year}-${season.month}`);
  const all = keys.every((key) => state.seasonFilters.has(key));
  keys.forEach((key) => setSeasonKey(key, !all));
  renderSeasonFilter();
  renderCollection();
}

function finishSeasonPaint(panel) {
  if (!seasonPaint) return;
  seasonPaint = null;
  panel.classList.remove("painting");
  renderSeasonFilter();
  renderCollection();
}

function bindSeasonPanel(panel) {
  if (seasonPanelBound) return;
  seasonPanelBound = true;
  // 单元格用 pointer 事件：pointerdown 定下这次要「全选」还是「全取消」，
  // 拖过的格子统一刷成同一状态，比逐格 click 快得多。preventDefault 会
  // 抑制后续 click，避免同一次操作被切换两回。
  panel.addEventListener("pointerdown", (event) => {
    const cell = event.target.closest?.("[data-season-key]");
    if (!cell || event.button !== 0) return;
    seasonPaint = { on: !state.seasonFilters.has(cell.dataset.seasonKey), touched: new Set() };
    panel.classList.add("painting");
    paintSeasonCell(cell, seasonPaint.on);
    event.preventDefault();
  });
  panel.addEventListener("pointermove", (event) => {
    if (!seasonPaint) return;
    const node = document.elementFromPoint(event.clientX, event.clientY);
    const cell = node?.closest?.("[data-season-key]");
    if (cell && panel.contains(cell)) paintSeasonCell(cell, seasonPaint.on);
  });
  // 键盘操作没有 pointer 序列，单独兜底（Enter / 空格）。
  panel.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const cell = event.target.closest?.("[data-season-key]");
    if (!cell) return;
    event.preventDefault();
    setSeasonKey(cell.dataset.seasonKey, !state.seasonFilters.has(cell.dataset.seasonKey));
    renderSeasonFilter();
    renderCollection();
  });
  panel.addEventListener("click", (event) => {
    const target = event.target;
    if (target.closest?.("[data-season-key]")) return;
    const more = target.closest?.("[data-season-years-more]");
    if (more) {
      seasonYearsExpanded = more.dataset.seasonYearsMore === "expand";
      renderSeasonFilter();
      return;
    }
    const column = target.closest?.("[data-season-column]");
    if (column) { toggleSeasonColumn(column.dataset.seasonColumn); return; }
    const year = target.closest?.("[data-season-year]");
    if (year) { toggleSeasonYear(Number(year.dataset.seasonYear)); return; }
    const action = target.closest?.("[data-season-action]");
    if (action) {
      const mode = action.dataset.seasonAction;
      if (mode === "clear") state.seasonFilters.clear();
      else if (mode === "all") {
        seasonVisibleYearCache.forEach((item) => SEASONS.forEach((season) => state.seasonFilters.add(`${item}-${season.month}`)));
      }
      renderSeasonFilter();
      renderCollection();
    }
  });
  document.addEventListener("pointerup", () => finishSeasonPaint(panel));
  document.addEventListener("pointercancel", () => finishSeasonPaint(panel));
}

function renderSeasonFilter() {
  const panel = $("#seasonFilterPanel");
  const years = availableSeasonYears();
  if (!years.length) {
    seasonVisibleYearCache = [];
    panel.innerHTML = `<p class="season-empty">同步到带有播出日期的番剧后，就能按季度筛选了。</p>`;
    panel.classList.remove("hidden");
    updateSeasonNote();
    return;
  }
  // 筛到折叠区间里的年份时自动展开，否则用户看不到自己已经选中的那些格子。
  const hiddenPicked = [...state.seasonFilters].some(
    (key) => years.indexOf(Number(String(key).split("-")[0])) >= SEASON_YEAR_LIMIT,
  );
  const hasEarlier = years.length > SEASON_YEAR_LIMIT;
  const expanded = seasonYearsExpanded || hiddenPicked;
  const shownYears = expanded ? years : years.slice(0, SEASON_YEAR_LIMIT);
  seasonVisibleYearCache = shownYears;
  const count = state.seasonFilters.size;
  panel.innerHTML = `<div class="season-toolbar">
      <span class="season-toolbar-hint">点格子切换 · 按住拖选 · 点列头批量选同一季度</span>
      <div class="season-toolbar-actions">
        <button type="button" class="season-text-button" data-season-action="all">全选</button>
        ${count ? `<button type="button" class="season-text-button" data-season-action="clear">清空</button>` : ""}
      </div>
    </div>
    <div class="season-matrix" role="group" aria-label="按年份与季度筛选">
      <div class="season-matrix-head">
        <span class="season-matrix-corner">年份</span>
        ${SEASONS.map((season) => `<button type="button" class="season-column" data-season-column="${season.month}" title="批量选/取消所有可见年份的${season.name}">${season.name}</button>`).join("")}
      </div>
      <div class="season-matrix-rows">${shownYears.map((year) => {
        const keys = SEASONS.map((season) => `${year}-${season.month}`);
        const picked = keys.filter((key) => state.seasonFilters.has(key)).length;
        return `<div class="season-matrix-row" data-year="${year}">
          <button type="button" class="season-row-year${picked === SEASONS.length ? " active" : picked ? " partial" : ""}" data-season-year="${year}" aria-pressed="${picked === SEASONS.length}" title="${picked === SEASONS.length ? "取消全年" : "选全年"}">${year}</button>
          ${SEASONS.map((season) => {
            const key = `${year}-${season.month}`;
            const on = state.seasonFilters.has(key);
            return `<button type="button" class="season-cell${on ? " active" : ""}" data-season-key="${key}" aria-pressed="${on}" title="${year} 年${season.name}"><span>${season.name.replace("季", "")}</span><i class="season-check" aria-hidden="true">✓</i></button>`;
          }).join("")}
        </div>`;
      }).join("")}</div>
      ${hasEarlier ? `<button type="button" class="season-years-more" data-season-years-more="${expanded ? "collapse" : "expand"}">${expanded ? "只看最近 12 年" : `更早的 ${years.length - SEASON_YEAR_LIMIT} 个年份`}</button>` : ""}
    </div>`;
  panel.classList.remove("hidden");
  syncSeasonColumnStates();
  updateSeasonNote();
  bindSeasonPanel(panel);
}

function collectionSortMode() {
  return (state.settings.collection_sort_modes || {})[activeVisibilityKey()] || "name";
}

function collectionSortDirection() {
  return (state.settings.collection_sort_directions || {})[activeVisibilityKey()] || "asc";
}

function updateSortPicker() {
  const modeNames = { name: "名称", rank: "评分", popularity: "热度", airdate: "首播", latest: "最新一集", kazumi: "加入时间", custom: "自定义" };
  const mode = collectionSortMode();
  const direction = collectionSortDirection();
  const sortLabel = $("#collectionSortPickerLabel");
  if (sortLabel) sortLabel.textContent = modeNames[mode] || "名称";
  $$("[data-sort-mode]").forEach((row) => {
    const active = row.dataset.sortMode === mode;
    row.classList.toggle("active", active);
    $$("[data-sort-direction]", row).forEach((button) => button.classList.toggle("active", active && button.dataset.sortDirection === direction));
  });
}

// 每个收藏夹各有一套「加入时间」，不能共用 Kazumi 的入库时间：
//   内置分类 → anime.collection_added_at（分类一变后端就重置）
//   自定义收藏夹 → custom_collection_added_at[夹 id]（custom_collection_items.created_at）
//   「全部收藏夹」没有所属夹，退回 Kazumi 入库时间
// 老数据或旧快照可能缺字段，逐级回退，最后才落到空串（同值再按位置/名称兜底）。
function collectionAddedAt(anime) {
  const text = (value) => String(value || "").trim();
  const kazumi = text(anime.kazumi_updated_at);
  const added = text(anime.collection_added_at);
  if (state.collectionKind === "custom") {
    const own = text((anime.custom_collection_added_at || {})[String(state.customCollectionId)]);
    return own || added || kazumi;
  }
  if (state.collectionKind === "builtin") return added || kazumi;
  return kazumi || added;
}

// 「最新一集」= 已经播出的剧集里 airdate 最大的那一天（不是首播日期，也不是
// 下一集时间）。数据全在 bootstrap 下发的 anime.episodes 里，每条都带 airdate，
// 所以排序完全在本地算，不多发任何请求，也不写库。
// Bangumi 会把未播出的排期集也列出来（甚至出现 '2099' 这种占位），必须按
// 「今天」过滤，否则排期很远的番会顶到最前面。
function localDayIso() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

// '2026-07-04' / '2026-07' / '2026' 三种写法都归一到可比的大小；其它形状当没有。
function normalizeAirdate(value) {
  const text = String(value || "").trim();
  if (!/^\d{4}(?:-\d{2}){0,2}$/.test(text)) return "";
  if (text.length === 4) return `${text}-01-01`;
  if (text.length === 7) return `${text}-01`;
  return text;
}

function latestAiredAt(anime, todayIso) {
  const episodes = Array.isArray(anime?.episodes) ? anime.episodes : [];
  let latest = "";
  for (const episode of episodes) {
    const date = normalizeAirdate(episode && episode.airdate);
    if (!date || date > todayIso) continue;
    if (date > latest) latest = date;
  }
  if (latest) return latest;
  // 没有逐集日期（老数据 / episode_count 生成的占位集）时退回首播日期：
  // 至少让它在时间轴上有个位置，而不是全部沉到最底部。
  const premiere = normalizeAirdate(anime?.air_date);
  return premiere && premiere <= todayIso ? premiere : "";
}

function collectionComparator() {
  const mode = collectionSortMode();
  // 刚新建的条目可能暂时没有 display_name；不能让一次排序抛错把整次渲染中断，
  // 否则新卡片会停留在它被追加的位置，看起来就是「刷新前在底部」。
  const name = (a, b) => String(a.display_name || a.name_cn || a.name || "")
    .localeCompare(String(b.display_name || b.name_cn || b.name || ""), "zh-CN");
  let comparator = name;
  if (mode === "rank") comparator = (a, b) => (Number(a.bgm_rank) || 999999999) - (Number(b.bgm_rank) || 999999999) || name(a, b);
  if (mode === "popularity") comparator = (a, b) => (Number(b.bgm_rating_total) || 0) - (Number(a.bgm_rating_total) || 0) || name(a, b);
  if (mode === "airdate") comparator = (a, b) => String(a.air_date || "9999-99-99").localeCompare(String(b.air_date || "9999-99-99")) || name(a, b);
  // 最新一集：和「加入时间」同一口径（asc = 最新在前），因为两者都是
  // 「最近有什么动静」类的时间键；方向箭头仍然可以翻过来。
  // 算出来的日期按每部番缓存一次，避免比较器被调用 O(n log n) 次就重扫一遍剧集。
  if (mode === "latest") {
    const todayIso = localDayIso();
    const newestFirst = collectionSortDirection() !== "desc";
    const cache = new Map();
    const value = (anime) => {
      const key = String(anime?.id ?? "");
      if (!cache.has(key)) cache.set(key, latestAiredAt(anime, todayIso));
      return cache.get(key);
    };
    // 方向在这里就地处理（而不是走末尾那层翻转）：空值（一集都没播过的）
    // 无论怎么翻都要留在最后，否则未开播的番会把整屏有更新的番挤下去。
    return (a, b) => {
      const left = value(a);
      const right = value(b);
      if (!left || !right) {
        if (left === right) return name(a, b);
        return left ? -1 : 1;
      }
      if (left !== right) {
        const earliest = left < right ? -1 : 1;
        return newestFirst ? -earliest : earliest;
      }
      return name(a, b);
    };
  }
  // 加入时间：按条目进入「当前这个」收藏夹的先后，最新的在最前。
  // 排序键随当前收藏夹切换，所以同一个番在 A 夹和 B 夹的位置可以不同；
  // asc/desc 沿用历史语义（asc = 最新在前）。
  if (mode === "kazumi") comparator = (a, b) => {
    const left = collectionAddedAt(a), right = collectionAddedAt(b);
    if (left !== right) return right > left ? 1 : -1;
    return Number(b.kazumi_position || 0) - Number(a.kazumi_position || 0) || name(a, b);
  };
  if (mode === "custom") comparator = (a, b) => Number(a.custom_sort_order || 0) - Number(b.custom_sort_order || 0) || name(a, b);
  return collectionSortDirection() === "desc" ? (a, b) => comparator(b, a) : comparator;
}

function renderStats() {
  $("#animeTotal").textContent = state.stats.anime_total || 0;
  $("#episodeTotal").textContent = state.stats.watched_episode_total || 0;
  $("#todayTotal").textContent = state.stats.today_episode_total || 0;
}

function topSyncAction() {
  return state.settings.top_sync_action === "kazumi" ? "kazumi" : "webdav";
}

function renderSyncButton() {
  const cloud = topSyncAction() === "webdav";
  const running = cloud ? state.webdavSyncRunning : Boolean(state.sync.running);
  const button = $("#syncButton");
  button.disabled = running;
  button.querySelector("span").textContent = running
    ? (cloud ? "坚果云同步中…" : "收藏同步中…")
    : (cloud ? "同步坚果云" : "同步收藏");
  button.title = cloud ? "同步当前账号的电脑和手机手账记录" : "只读导入本机 Kazumi 收藏";
}

async function syncPrimaryAction() {
  if (topSyncAction() === "kazumi") await startSync();
  else await syncWebdav();
}

function renderSync() {
  if (window.handbookOnline) {
    $("#syncText").textContent = "数据已保存在服务器";
    $("#collectionSubtitle").textContent = "记录每一段追番时光";
    return;
  }
  const indicator = $("#syncIndicator");
  indicator.classList.remove("running", "success", "error");
  if (state.sync.running) indicator.classList.add("running");
  else if (state.sync.last_error) indicator.classList.add("error");
  else if (state.sync.last_success_at) indicator.classList.add("success");
  $("#syncText").textContent = state.sync.message || "尚未同步";
  renderSyncButton();
  $("#collectionSubtitle").textContent = state.sync.running
    ? state.sync.message
    : "在手账管理收藏，Kazumi 关闭后自动写回；进度与想法留在手账里";
  $("#kazumiPath").textContent =
    state.sync.kazumi_path || "未找到 Kazumi 收藏数据库";
}

function renderTabs() {
  ensureVisibleCollection();
  const counts = state.stats.category_counts || {};
  const customCounts = state.stats.custom_collection_counts || {};
  const builtinTabs = visibleBuiltinCategories().map(
    (category) => `
      <button
        class="category-tab ${state.collectionKind === "builtin" && state.category === category.id ? "active" : ""}"
        data-kind="builtin"
        data-category="${category.id}"
        role="tab"
        aria-selected="${state.collectionKind === "builtin" && state.category === category.id}"
      >
        ${category.name}
        <span class="tab-count">${counts[String(category.id)] || 0}</span>
      </button>
    `,
  );
  const customTabs = state.custom_collections.map(
    (collection) => `
      <button
        class="category-tab custom-tab ${state.collectionKind === "custom" && Number(state.customCollectionId) === Number(collection.id) ? "active" : ""}"
        data-kind="custom"
        data-custom-id="${collection.id}"
        role="tab"
        aria-selected="${state.collectionKind === "custom" && Number(state.customCollectionId) === Number(collection.id)}"
      >
        ${escapeHtml(collection.name)}
        <span class="tab-count">${customCounts[String(collection.id)] ?? collection.count ?? 0}</span>
      </button>
    `,
  );
  const allTab = state.settings.show_all_collection_tab !== false
    ? [`<button class="category-tab all-tab ${state.collectionKind === "all" ? "active" : ""}" data-kind="all" role="tab" aria-selected="${state.collectionKind === "all"}">全部收藏夹 <span class="tab-count">${state.stats.anime_total || 0}</span></button>`]
    : [];
  $("#categoryTabs").innerHTML = [...builtinTabs, ...customTabs, ...allTab].join("");
  $$(".category-tab").forEach((button) => {
    button.addEventListener("click", () => {
      state.collectionKind = button.dataset.kind || "builtin";
      if (state.collectionKind === "custom") {
        state.customCollectionId = Number(button.dataset.customId);
      } else if (state.collectionKind === "builtin") {
        state.category = Number(button.dataset.category);
        state.customCollectionId = null;
      }
      renderTabs();
      renderCollection();
    });
  });
  const ratingVisibility = state.settings.category_rating_visibility || {};
  $("#collectionRatingToggle").checked = ratingVisibility[activeVisibilityKey()] !== false;
  $("#progressBarToggle").checked = showProgressBar();
  updateSortPicker();
}



// 收藏数据的唯一写入口。以前各入口只是把新对象塞进 state.animes（通常是追加到
// 末尾），而界面顺序由 filteredAnimes() 在渲染时另算，两套顺序会在「刚加入」和
// 「刷新后」之间不一致。这里在写入那一刻就按当前排序规则把整个数组规范化，
// 因此新增、改状态、移入/移出收纳夹、拖拽排序与刷新（bootstrap 也走这里）
// 得到的顺序完全一致；comparator 稳定且幂等，已有条目的相对顺序不会被打乱，
// 分类过滤仍由 filteredAnimes() 负责。
function commitAnimes(animes, options = {}) {
  if (!Array.isArray(animes)) return state.animes;
  // 复制后再排序，不改变调用方持有的数组；重复提交结果相同。
  state.animes = [...animes].sort(collectionComparator());
  if (options.render !== false && typeof renderCollection === "function") {
    renderCollection();
  }
  return state.animes;
}
