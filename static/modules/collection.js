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

function renderSeasonFilter() {
  const panel = $("#seasonFilterPanel");
  const years = availableSeasonYears();
  panel.innerHTML = years.length
    ? `<div class="season-filter-heading"><strong>按播出季度筛选</strong><button type="button" class="text-button" data-season-action="clear">清除</button></div>
      <p class="season-filter-tip">可多选；“全年”会同时选择该年的四个季度。</p>
      <div class="season-filter-years">${years.map((year) => {
        const keys = SEASONS.map((season) => `${year}-${season.month}`);
        const selectedCount = keys.filter((key) => state.seasonFilters.has(key)).length;
        return `<div class="season-filter-year">
          <button type="button" class="season-year-button ${selectedCount === 4 ? "active" : ""}" data-season-year="${year}">${year} 全年</button>
          <div class="season-options">${SEASONS.map((season) => {
            const key = `${year}-${season.month}`;
            return `<button type="button" class="season-option ${state.seasonFilters.has(key) ? "active" : ""}" data-season-key="${key}">${season.name}<small>${season.label}</small></button>`;
          }).join("")}</div>
        </div>`;
      }).join("")}</div>`
    : `<p class="season-filter-tip">同步到带有播出日期的番剧后即可按季度筛选。</p>`;
  panel.classList.remove("hidden");
  const count = state.seasonFilters.size;
  const countLabel = $("#seasonFilterCount");
  if (countLabel) {
    countLabel.textContent = count;
    countLabel.classList.toggle("hidden", count === 0);
  }
  $$("[data-season-key]", panel).forEach((button) => {
    button.addEventListener("click", () => {
      const key = button.dataset.seasonKey;
      if (state.seasonFilters.has(key)) state.seasonFilters.delete(key);
      else state.seasonFilters.add(key);
      renderSeasonFilter();
      renderCollection();
    });
  });
  $$("[data-season-year]", panel).forEach((button) => {
    button.addEventListener("click", () => {
      const keys = SEASONS.map((season) => `${button.dataset.seasonYear}-${season.month}`);
      const allSelected = keys.every((key) => state.seasonFilters.has(key));
      keys.forEach((key) => allSelected ? state.seasonFilters.delete(key) : state.seasonFilters.add(key));
      renderSeasonFilter();
      renderCollection();
    });
  });
  $("[data-season-action='clear']", panel)?.addEventListener("click", () => {
    state.seasonFilters.clear();
    renderSeasonFilter();
    renderCollection();
  });
}

function collectionSortMode() {
  return (state.settings.collection_sort_modes || {})[activeVisibilityKey()] || "name";
}

function collectionSortDirection() {
  return (state.settings.collection_sort_directions || {})[activeVisibilityKey()] || "asc";
}

function updateSortPicker() {
  const modeNames = { name: "名称", rank: "评分", popularity: "热度", airdate: "时间", kazumi: "入库时间", custom: "自定义" };
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

function collectionComparator() {
  const mode = collectionSortMode();
  const name = (a, b) => a.display_name.localeCompare(b.display_name, "zh-CN");
  let comparator = name;
  if (mode === "rank") comparator = (a, b) => (Number(a.bgm_rank) || 999999999) - (Number(b.bgm_rank) || 999999999) || name(a, b);
  if (mode === "popularity") comparator = (a, b) => (Number(b.bgm_rating_total) || 0) - (Number(a.bgm_rating_total) || 0) || name(a, b);
  if (mode === "airdate") comparator = (a, b) => String(a.air_date || "9999-99-99").localeCompare(String(b.air_date || "9999-99-99")) || name(a, b);
  // Kazumi displays each collection by its collectible timestamp (newest first).
  // This value comes directly from the entry.time field in collectibles.hive.
  if (mode === "kazumi") comparator = (a, b) => String(b.kazumi_updated_at || "").localeCompare(String(a.kazumi_updated_at || "")) || Number(b.kazumi_position || 0) - Number(a.kazumi_position || 0) || name(a, b);
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
    : "从 Kazumi 只读同步，进度与想法留在自己的手账里";
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

