function episodeTotal(anime) {
  return Array.isArray(anime.episodes)
    ? anime.episodes.length
    : Number(anime.episode_count || 0);
}

function episodeSummaryText(anime) {
  return anime.episode_summary || (episodeTotal(anime) ? `${episodeTotal(anime)} 条` : "章节待同步");
}

function episodeTitle(episode) {
  const name = episode.name_cn || episode.name || "";
  return name ? `${episode.display_label} · ${name}` : episode.display_label;
}

// 集数标识有两套坐标系：Bangumi 同步来的 `bgm:123`，以及归档入库用的
// `类型:集数`（本篇 0:N、特别篇 1:N）。详情页格子用前者，local_files 里存
// 的是后者，直接字符串比较永远不相等 —— 有逐集资料的番会一直显示
// 「这一集还没下载」，扇区的「播放」也点不动。所有跨这两套 key 的比较
// 都先归一化到「类型:集数」，新老数据（库里可能是任一种）都能对上。
function episodeStorageKey(key, anime) {
  const text = String(key ?? "").trim();
  if (/^\d+:\d+$/.test(text)) return text;
  const episodes = Array.isArray(anime?.episodes) ? anime.episodes : [];
  const episode = episodes.find((item) => String(item?.key) === text);
  if (!episode) return text;
  const type = Number(episode.type ?? 0);
  const number = Number(episode.sort ?? episode.ep ?? episode.label);
  if (!Number.isInteger(type) || type < 0 || !Number.isInteger(number) || number <= 0) return text;
  return `${type}:${number}`;
}

function findLocalEpisodeFile(files, key, anime) {
  const wanted = episodeStorageKey(key, anime);
  return (Array.isArray(files) ? files : []).find(
    (item) => item && episodeStorageKey(item.episode_key, anime) === wanted && item.exists !== false
  ) || null;
}

function episodeGroupSummary(group, watchedSet) {
  const watched = group.episodes.filter((episode) => watchedSet.has(String(episode.key))).length;
  return `已看 ${watched} / ${group.count}`;
}

function episodeReleaseStatus(anime, group) {
  if (Number(group.type) !== 0) return "";
  const useAS = state.settings.collection_airing_source === "as";
  const airing = useAS ? anime.as_airing : anime.airing;
  if (useAS && (!airing || airing.unavailable)) {
    return `<span class="episode-release-status" title="未匹配或暂无可用 AS 资料，不使用其他来源代替"><i></i>${airing?.status === "loading" ? "AS 进度加载中" : "暂无 AS 进度"}</span>`;
  }
  if (!airing) return "";
  const aired = Math.max(0, Number(airing.aired) || 0);
  const knownTotal = Number(airing.total) || (useAS ? Number(anime.episode_count) : 0);
  const total = useAS && aired > knownTotal ? 0 : knownTotal;
  if (!useAS && !total) return "";
  // 口径（2026-11-07 定）：完结番不显示进度药丸，也不标「已播完」。
  // 集数格子本来就是齐的，多一个「已播完」只是噪音；别把这行当成 bug 改回去。
  if (total && aired >= total) return "";
  const detail = useAS ? `${airing.stale ? "AS 缓存暂未更新；" : ""}已播集数来自 AnimeSchedule 原声／字幕放送计划；总集数缺失时沿用条目资料` : "按 Bangumi 逐集播出日期与放送时刻（北京时间）计算";
  // 恢复早期版本的药丸格子：绿点 + 只显示已播集数，不再带「/ 总集数」。
  // 总集数和来源放进 title，鼠标悬停仍能看到，但不占标题行的版面。
  const hint = `${detail}${total ? ` · 共 ${total} 集` : ""}`;
  return `<span class="episode-release-status" title="${escapeHtml(hint)}"><i></i>已播 ${aired}</span>`;
}

function showCustomMoveButton() {
  return (
    state.custom_collections.length > 0 ||
    state.settings.show_custom_move_button_without_collections !== false
  );
}

function showProgressBar() {
  const visibility = state.settings.category_progress_visibility || {};
  return visibility[activeVisibilityKey()] !== false;
}

function booleanSetting(key, fallback = false) {
  const value = state.settings?.[key];
  return typeof value === "boolean" ? value : fallback;
}

function enabledSetting(key) {
  return booleanSetting(key, true);
}

function showSidebarToggle() {
  return enabledSetting("show_sidebar_toggle");
}

function showBgmRating() {
  return enabledSetting("show_bgm_rating");
}

function showCollectionBgmRating() {
  const visibility = state.settings.category_rating_visibility || {};
  return visibility[activeVisibilityKey()] !== false;
}

function applyCollectionToolbarVisibility() {
  [
    ["#collectionRatingControl", "show_collection_rating_control"],
    ["#collectionProgressControl", "show_collection_progress_control"],
    ["#createCollectionButton", "show_create_collection_control"],
  ].forEach(([selector, key]) => {
    $(selector).classList.toggle("hidden", !enabledSetting(key));
  });
}

function showAgeRelatedButton() {
  return enabledSetting("show_age_related_button");
}

function showEpisodeTitlesOnHover() {
  return booleanSetting("show_episode_titles_on_hover");
}

function showRankingHoverTitles() {
  return enabledSetting("show_ranking_hover_titles");
}

function rankingHoverDelay() {
  return Math.min(10, Math.max(0, Number(state.settings.ranking_hover_delay_seconds ?? 2)));
}

function newRecordDefaultsToOther() {
  return booleanSetting("new_record_defaults_to_other");
}

function launchAtLogin() {
  return booleanSetting("launch_at_login");
}

function showEpisodeReviewRecord() {
  return enabledSetting("show_episode_review_record");
}

function showOpedRecord() {
  return enabledSetting("show_oped_record");
}

function showEpisodeRatingRecord() {
  return enabledSetting("show_episode_rating_record");
}

function quickRecordActionEnabled(action) {
  if (action === "review") return showEpisodeReviewRecord();
  if (action === "op" || action === "ed") return showOpedRecord();
  if (action === "score") return showEpisodeRatingRecord();
  return false;
}

function hasEnabledQuickRecordActions() {
  return ["review", "op", "ed", "score"].some(quickRecordActionEnabled);
}

function applyTheme() {
  // 主题编辑器里未保存的背景图只存在于内存，用 data URL 覆盖真实文件地址。
  const preview = window.handbookThemePreview;
  window.handbookAppearance.apply(state.settings, state.active_profile?.id || "local",
    preview?.backgroundUrl ? { backgroundUrl: preview.backgroundUrl } : undefined);
}

function applyNoteComposerMode() {
  const select = $("#noteAnime");
  const defaultsToOther = newRecordDefaultsToOther();
  select.closest(".composer-footer").classList.toggle("other-record-mode", defaultsToOther);
  select.disabled = defaultsToOther;
  if (defaultsToOther) select.value = "";
}

function setSidebarCollapsed(collapsed) {
  window.handbookSidebar?.set(collapsed);
  $(".app-shell").classList.toggle("sidebar-collapsed", collapsed);
  $("#sidebarToggle").classList.toggle("hidden", !showSidebarToggle());
  $("#sidebarReopenButton").classList.toggle(
    "hidden",
    !collapsed || !showSidebarToggle(),
  );
}

const SIDEBAR_ITEMS = {
  collection: "收藏夹",
  library: "媒体库",
  schedule: "周表",
  timeline: "看番记录",
  statistics: "记录统计",
  ranking: "排名",
  settings: "设置",
};

// Stable page IDs drive navigation and data; names are presentation only.
function pageLabel(id, fallback = SIDEBAR_ITEMS[id]) {
  const name = state.settings.sidebar_labels?.[id];
  return typeof name === "string" && name.trim() ? name.trim() : fallback;
}

// Only page references use custom names; action labels and domain terms stay literal.
function applyPageLabels() {
  $$("[data-page-text]").forEach((node) => {
    node.textContent = node.dataset.pageText.replace(/\{(collection|library|schedule|timeline|statistics|ranking)\}/g, (_, id) => pageLabel(id));
  });
  $$("[data-page-label]").forEach((node) => {
    if (!node.dataset.pageDefault) node.dataset.pageDefault = node.textContent;
    node.textContent = pageLabel(node.dataset.pageLabel, node.dataset.pageDefault);
  });
}

function sidebarOrder() {
  const saved = Array.isArray(state.settings.sidebar_order)
    ? state.settings.sidebar_order
    : [];
  const ordered = [...saved.filter((item) => SIDEBAR_ITEMS[item]), ...Object.keys(SIDEBAR_ITEMS).filter((item) => !saved.includes(item))];
  if (!saved.includes("schedule")) {
    ordered.splice(ordered.indexOf("schedule"), 1);
    ordered.splice(Math.max(0, ordered.indexOf("collection") + 1), 0, "schedule");
  }
  // 动漫库默认排在收藏夹后面；老用户的存量 sidebar_order 里没有它，这里兜底。
  if (!saved.includes("library")) {
    ordered.splice(ordered.indexOf("library"), 1);
    ordered.splice(Math.max(0, ordered.indexOf("collection") + 1), 0, "library");
  }
  return ordered;
}

function sidebarVisibility() {
  return { collection: true, schedule: true, timeline: true, statistics: true, ranking: true, settings: true, ...(state.settings.sidebar_visibility || {}), settings: true };
}

// 某个页面此刻是否真的可见。媒体库不归 sidebar_visibility 管（它有自己的三态开关，
// auto 还要看库里有没有东西），所以直接读导航按钮的最终状态最准。
function pageVisible(id) {
  if (id === "library") {
    const button = document.querySelector('#libraryNavButton');
    return button ? !button.classList.contains("hidden") : true;
  }
  if (id === "settings") return true;
  return sidebarVisibility()[id] !== false;
}

function applySidebarLayout() {
  $$(".sidebar-power-area, #shutdownBackendCompact").forEach(element => {
    element.classList.toggle("hidden", !enabledSetting("show_shutdown_button"));
  });
  applyPageLabels();
  syncSettingsNavigation();
  const nav = $(".main-nav");
  const visibility = sidebarVisibility();
  sidebarOrder().forEach((id) => {
    const item = $(`.nav-item[data-nav-id="${id}"]`);
    if (!item) return;
    // 媒体库的显隐由「设置 → 媒体库」里的三态开关控制，这里不碰它。
    item.classList.toggle("hidden", visibility[id] === false && id !== "settings" && id !== "library");
    nav.append(item);
  });
  if (!["collection", "library", "schedule", "timeline", "statistics", "ranking"].includes(state.activeView)) {
    state.activeView = "collection";
  }
  if (visibility[state.activeView] === false) {
    state.activeView = sidebarOrder().find((id) => id !== "settings" && visibility[id] !== false) || "collection";
  }
  setSidebarCollapsed(document.documentElement.dataset.sidebarCollapsed === "true");
}

