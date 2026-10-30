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

function episodeGroupSummary(group, watchedSet) {
  const watched = group.episodes.filter((episode) => watchedSet.has(String(episode.key))).length;
  return `已看 ${watched} / ${group.count}`;
}

function episodeReleaseStatus(anime, group) {
  if (Number(group.type) !== 0) return "";
  const aired = Math.max(0, Number(anime.aired_episode_count || 0));
  if (!aired || aired >= group.count) return "";
  return `<span class="episode-release-status"><i></i>更新至 ${aired} 集</span>`;
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

function showBilibiliSearchButton() {
  return enabledSetting("show_bilibili_search_button");
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
  window.handbookAppearance.apply(state.settings, state.active_profile?.id || "local");
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
    node.textContent = node.dataset.pageText.replace(/\{(collection|schedule|timeline|statistics|ranking)\}/g, (_, id) => pageLabel(id));
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
  return ordered;
}

function sidebarVisibility() {
  return { collection: true, schedule: true, timeline: true, statistics: true, ranking: true, settings: true, ...(state.settings.sidebar_visibility || {}), settings: true };
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
    item.classList.toggle("hidden", visibility[id] === false && id !== "settings");
    nav.append(item);
  });
  if (!["collection", "schedule", "timeline", "statistics", "ranking"].includes(state.activeView)) {
    state.activeView = "collection";
  }
  if (visibility[state.activeView] === false) {
    state.activeView = sidebarOrder().find((id) => id !== "settings" && visibility[id] !== false) || "collection";
  }
  setSidebarCollapsed(document.documentElement.dataset.sidebarCollapsed === "true" && showSidebarToggle());
}

