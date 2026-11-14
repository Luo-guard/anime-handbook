function applyCharacterTabVisibility() {
  const enabled = enabledSetting("show_character_tab");
  $("#charactersDetailTab").classList.toggle("hidden", !enabled);
  if (!enabled && !$("#charactersDetailPanel").classList.contains("hidden")) {
    switchDetailTab("overview");
  }
}

const WEEKDAY_NAMES = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function beijingAiringSlot(timestamp) {
  if (!(Number(timestamp) > 0)) return null;
  const date = new Date(Number(timestamp) * 1000 + 8 * 3600 * 1000);
  if (Number.isNaN(date.getTime())) return null;
  return { weekday: WEEKDAY_NAMES[date.getUTCDay()], clock: date.toISOString().slice(11, 16) };
}

// 只认补不补零都行的完整日期；"2027-04" 这种只有年月的占位不能当日期用。
function parseIsoDate(value) {
  const match = String(value || "").trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!match) return null;
  const day = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(day.getTime()) ? null : day;
}

// 「周几更新」全部用本地已有数据算，不发任何请求：
//   1. 后端 airing.next_at 是下集的真实放送时刻（本地季表里有放送钟点时才有），最准；
//   2. 否则取 episodes 里带完整日期的 airdate 的**星期众数** —— 个别集延播
//      （比如第 2 集突然跳到三周后）不能把结果带偏，所以不取最后一条；
//   3. 再没有就用首播日。
// 只有确实还有没播的集时才说「更新」；已完结的番只给星期，不谎称每周还会更新。
function animeUpdateWeekday(anime, today = new Date()) {
  const next = beijingAiringSlot(anime?.airing?.next_at);
  if (next) return { weekday: next.weekday, ongoing: true };
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const counts = new Array(7).fill(0);
  let dated = 0;
  let upcoming = 0;
  (anime?.episodes || []).forEach((episode) => {
    const day = parseIsoDate(episode?.airdate);
    if (!day) return;
    dated += 1;
    counts[day.getDay()] += 1;
    if (day > todayStart) upcoming += 1;
  });
  if (!dated) {
    const premiere = parseIsoDate(anime?.air_date);
    if (!premiere) return null;
    return { weekday: WEEKDAY_NAMES[premiere.getDay()], ongoing: premiere > todayStart };
  }
  let best = 0;
  counts.forEach((count, index) => {
    if (count > counts[best]) best = index;
  });
  return { weekday: WEEKDAY_NAMES[best], ongoing: upcoming > 0 };
}

// 钟点只从已有的放送时刻取：air_time.time 来自当季周表（已换算成北京时间），
// airing.next_at 是下集的真实放送时刻，两者同源。拿不到就不写钟点，绝不编造。
function animeAirClock(anime) {
  const clock = String(anime?.air_time?.time || "").trim();
  const match = clock.match(/^(\d{1,2}):(\d{2})$/);
  if (match && Number(match[1]) < 24 && Number(match[2]) < 60) {
    return `${match[1].padStart(2, "0")}:${match[2]}`;
  }
  return beijingAiringSlot(anime?.airing?.next_at)?.clock || "";
}

// 長門番堂徽标用自己的日期和进度判断状态，独立于集数区的来源设置。
function animeAiringCounts(anime, today = new Date()) {
  const source = anime?.airing;
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  let dated = 0;
  let upcoming = 0;
  let past = 0;
  (anime?.episodes || []).forEach((episode) => {
    if (Number(episode?.type || 0) !== 0) return;
    const day = parseIsoDate(episode?.airdate);
    if (!day) return;
    dated += 1;
    if (day > todayStart) upcoming += 1;
    else past += 1;
  });
  const aired = Math.max(0, Number(source?.aired) || 0) || past;
  const total = Number(source?.total) || Number(anime?.episode_count) || (anime?.episodes || []).length || 0;
  return { aired, total, upcoming, dated };
}

function animeScheduleBadge(anime) {
  const airing = anime?.as_airing;
  if (airing?.show_status === "finished" || (airing?.total > 0 && airing.aired >= airing.total)) {
    return { kind: "finished", text: "已完结", title: "AnimeSchedule 的播出状态" };
  }
  if (airing?.show_status === "upcoming" && !(airing.aired > 0)) {
    return { kind: "upcoming", text: "未开播", title: "AnimeSchedule 标记为未开播" };
  }
  const next = beijingAiringSlot(airing?.next_at);
  if (next && !airing.unavailable) {
    return {
      kind: "ongoing",
      text: `${next.weekday} ${next.clock} 更新`,
      title: `AnimeSchedule${airing.stale ? "（缓存）" : ""}下一集排期 · ${airing.next_label || next.weekday + " " + next.clock}（北京时间）`,
    };
  }
  if (airing?.show_status === "ongoing") {
    return {
      kind: "ongoing", text: "连载中", missingTime: "AS 更新时间缺失",
      title: "AnimeSchedule 标记为连载中，当前没有可用的下一集时间",
    };
  }
  const loading = airing?.status === "loading";
  return {
    kind: "unknown",
    text: loading ? "正在读取 AS 排期" : "AS 排期数据缺失",
    missingSchedule: !loading,
    title: "AnimeSchedule 暂未提供可用的下一集时间",
  };
}

// 四态徽标：连载中 / 已完结 / 未开播 / 日期未知。
// 文案只给「这一行独有的信息」：集数区已经有「已看 N/总」和「已播 N」药丸，
// 首播日期也在同一行，所以徽标不再重复「已播 N/总」「全 N 集」或开播日期。
// 完结态按你定的口径只写「已完结」，不写「已播完」。
function animeBadgeModel(anime, today = new Date()) {
  if (state.settings?.detail_airtime_source === "as") return animeScheduleBadge(anime);
  const info = animeUpdateWeekday(anime, today);
  const counts = animeAiringCounts(anime, today);
  const premiere = parseIsoDate(anime?.air_date);
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const weekday = info ? `每${info.weekday}` : "";

  if (!premiere && !counts.dated && !info) {
    return {
      kind: "unknown", text: "BGM 播出日期缺失", missingSchedule: true,
      title: "Bangumi 条目和逐集资料都缺少播出日期，无法判断播出状态",
    };
  }
  if (premiere && premiere > todayStart && counts.aired === 0) {
    return { kind: "upcoming", text: "未开播", title: "首播日期还没到；具体日期就在旁边" };
  }
  if (info?.ongoing || counts.upcoming > 0) {
    const clock = animeAirClock(anime);
    return {
      kind: "ongoing",
      text: clock ? `${weekday} ${clock} 更新` : (weekday ? `${weekday}更新` : "连载中"),
      missingTime: clock ? "" : "長門番堂更新时间缺失",
      title: clock
        ? "星期按逐集放送日期推算，钟点来自当季周表的北京时间放送时刻"
        : "星期按逐集放送日期推算；这份资料没有放送钟点",
    };
  }
  return { kind: "finished", text: "已完结", title: "已经播完；完结番不谎报更新星期" };
}

function renderProgressBadge(anime) {
  const model = animeBadgeModel(anime);
  const badge = $("#progressBadge");
  badge.className = `update-badge ${model.kind}`;
  const hideMissing = state.settings?.hide_missing_as_schedule !== false;
  badge.classList.toggle("hidden", Boolean(model.missingSchedule && hideMissing));
  badge.title = model.title;
  $("#progressBadgeText").textContent = model.missingTime && !hideMissing
    ? `${model.text} · ${model.missingTime}` : model.text;
}

// 评分行整行跳 Bangumi：和上面的 Bangumi 外链共用同一个链接模板与
// bgm_site_base，target/rel 也一致，中键与右键都交给浏览器原生处理。
function bgmRatingHref(anime) {
  const site = String(state.settings?.bgm_site_base || "https://bgm.tv").replace(/\/+$/, "");
  const title = String(anime?.name_cn || anime?.name || anime?.display_name || "").trim();
  const values = { id: anime?.id ?? "", title, site };
  const preset = typeof detailLinks === "function"
    ? detailLinks().find((link) => link && link.enabled && link.kind === "bgm")
    : null;
  const template = preset?.url || "{site}/subject/{id}";
  return typeof detailLinkHref === "function"
    ? detailLinkHref(template, values)
    : `${site}/subject/${values.id}`;
}

function applyBgmRatingLink(rating, anime, hasRating) {
  const on = state.settings?.bgm_rating_link !== false;
  if (on && hasRating) {
    rating.setAttribute("href", bgmRatingHref(anime));
    rating.setAttribute("target", "_blank");
    rating.setAttribute("rel", "noreferrer");
    rating.title = "在 Bangumi 打开这个条目";
  } else {
    ["href", "target", "rel", "title"].forEach((attr) => rating.removeAttribute(attr));
  }
}

// 详情弹窗右上角的按钮组要贴住卡片真实的右上角。弹窗为滚动条
// 预留了两侧槽（scrollbar-gutter: stable both-edges），绝对定位只能落在
// padding box 里，右边会空出半个槽宽；用负 right 补偿又会把按钮顶进滚动区域、
// 给弹窗添一条横向滚动条（且槽宽随浏览器/缩放变化，写死 15px 会顶出卡边）。
// 所以直接按弹窗的视口矩形把它固定住：既严丝合缝，弹窗内部滚动时也一直贴角。
function syncDetailCornerActions() {
  const dialog = document.querySelector("#progressModal");
  const actions = dialog?.querySelector(".detail-corner-actions");
  if (!dialog?.open || !actions) return;
  const rect = dialog.getBoundingClientRect();
  actions.style.top = `${rect.top}px`;
  actions.style.left = `${rect.right - actions.offsetWidth}px`;
}

window.addEventListener("resize", syncDetailCornerActions);
window.addEventListener("scroll", syncDetailCornerActions, { passive: true });
// 详情内容异步补齐（封面、集数标记、评论）会让弹窗高度变化、垂直居中位置
// 跟着动，用 ResizeObserver 更新按钮组的位置。
if (typeof ResizeObserver !== "undefined") {
  const detailDialog = document.querySelector("#progressModal");
  if (detailDialog) new ResizeObserver(syncDetailCornerActions).observe(detailDialog);
}

const detailLayoutHomes = new Map();

function applyDetailLayout() {
  const dialog = $("#progressModal");
  if (!dialog) return;
  const modern = state.settings.detail_layout === "modern";
  dialog.classList.toggle("detail-modern", modern);
  dialog.classList.toggle("detail-compact-credits", modern && state.settings.detail_modern_compact_credits !== false);
  $("#modernDetailMenu").open = false;
  $("#modernDetailMenu").classList.toggle("hidden", !modern);
  const activeTab = $("[data-detail-tab].active", dialog)?.dataset.detailTab;
  switchDetailTab(activeTab || "overview");

  const menu = $(".modern-detail-menu-body", dialog);
  const facts = $("#modernDetailFacts");
  facts.classList.toggle("hidden", !modern);
  for (const [selector, destination] of [
    [".progress-links", menu], ["#openAgeRelated", menu], ["#detailSavedSections", menu],
    ["#animeRating", facts], ["#personalRating", facts],
  ]) {
    const node = $(selector, dialog);
    if (!detailLayoutHomes.has(node)) {
      const home = document.createComment("classic detail position");
      node.before(home);
      detailLayoutHomes.set(node, home);
    }
    if (modern) destination.append(node);
    else detailLayoutHomes.get(node).after(node);
  }

  refreshModernDetailHeader();
  updateDetailRecordActions();
  syncDetailCornerActions();
}

function updateDetailRecordActions() {
  const dialog = $("#progressModal");
  const button = $("#saveProgress");
  if (!dialog || !button) return;
  const modern = dialog.classList.contains("detail-modern");
  const anime = state.progressAnime;
  const stored = new Set((anime?.watched_episode_keys || anime?.watched_episodes || [])
    .map(key => episodeStorageKey(key, anime)));
  const draft = new Set([...(state.pendingEpisodes || [])].map(key => episodeStorageKey(key, anime)));
  const changed = stored.size !== draft.size || [...draft].some(key => !stored.has(key));
  const onChange = modern ? state.settings.detail_modern_record_on_change !== false
    : state.settings.detail_classic_record_on_change === true;
  dialog.classList.toggle("detail-record-on-change", onChange);
  dialog.classList.toggle("detail-record-pending", changed);
  button.disabled = button.dataset.saving === "true" || (onChange && !changed);
  $("#cancelProgress").disabled = modern && button.dataset.saving === "true";
  $("#cancelProgress").textContent = modern ? "取消修改" : "取消";
}

function cancelDetailProgress() {
  const dialog = $("#progressModal");
  if (!dialog.classList.contains("detail-modern")) return dialog.close();
  const anime = state.progressAnime;
  state.pendingEpisodes = new Set((anime.watched_episode_keys || anime.watched_episodes || []).map(String));
  renderEpisodeGrid();
  if (typeof refreshSavedVideoTargets === "function") refreshSavedVideoTargets();
}

function modernDetailAiring(anime, count) {
  const useAS = state.settings.collection_airing_source === "as";
  const airing = useAS ? anime.as_airing : anime.airing;
  const kind = animeBadgeModel(anime).kind;
  const total = Number(airing?.total) || Number(anime.episode_count) || count;
  const aired = Number(airing?.aired ?? NaN);
  const finished = kind === "finished" || airing?.show_status === "finished"
    || (!airing?.unavailable && Number(airing?.total) > 0 && aired >= total);
  return {
    kind, finished, useAS,
    count: finished && total > 0 ? total
      : !airing?.unavailable && (useAS || Number(airing?.total) > 0) && Number.isInteger(aired) && aired >= 0 ? aired : null,
  };
}

function refreshModernDetailHeader() {
  const dialog = $("#progressModal");
  const anime = state.progressAnime;
  const modern = dialog?.classList.contains("detail-modern") && anime;
  if (!$("#modernTitleTools")) return;
  const play = $("#detailOnlinePlay");
  let nextEpisode = 0;
  const mainCells = $$('#episodeGrid [data-episode-type="0"]', dialog);
  const airing = modern ? modernDetailAiring(anime, mainCells.length) : null;
  const aired = airing?.finished ? null : airing?.kind === "upcoming" ? 0 : airing?.count ?? null;
  if (play) {
    play.textContent = "播放";
    play.removeAttribute("aria-disabled");
    delete play.dataset.detailEpisodeKey;
    if (modern && typeof mainPlaybackEpisode === "function") {
      try {
        const target = mainPlaybackEpisode(anime);
        nextEpisode = target.number;
        const title = `第 ${String(nextEpisode).padStart(2, "0")} 集`;
        const future = aired !== null && nextEpisode - target.first >= aired;
        const localAvailable = episodeDownloadKeys.has(`0:${nextEpisode}`)
          && episodeGestureConfig().playbackSource !== "online";
        if (!localAvailable && (airing.kind === "upcoming" || future)) {
          play.textContent = airing.kind === "upcoming" ? "开播后可播放" : `${title}未播出`;
          play.setAttribute("aria-disabled", "true");
        } else {
          play.textContent = `${(anime.watched_episode_keys || anime.watched_episodes || []).length ? "继续播放" : "播放"} · ${title}`;
        }
      } catch {
        const firstKey = mainCells[0]?.dataset.episodeKey;
        if (firstKey && airing.kind !== "upcoming") {
          play.dataset.detailEpisodeKey = firstKey;
          play.textContent = `重看 · 第 ${mainCells[0].dataset.detailEpisodeLabel} 集`;
        }
      }
    }
  }
  if (!modern) {
    $("#modernTitleTools").classList.add("hidden");
    return;
  }
  const count = Number(anime.episode_count) || mainCells.length;
  $("#modernDetailEpisodeTotal").textContent = count > 0 ? `全 ${count} 集` : "";
  mainCells.forEach((cell, index) => {
    const key = episodeStorageKey(cell.dataset.episodeKey, anime);
    const unreleased = aired !== null && index >= aired;
    cell.classList.toggle("unreleased", unreleased);
    cell.classList.toggle("next-to-play", airing.kind !== "upcoming" && key === `0:${nextEpisode}` && nextEpisode > 0);
  });
  const original = anime.name && anime.name !== anime.display_name ? anime.name : "";
  const row = $("#modernTitleTools");
  const subtitle = $("#modernOriginalTitle");
  subtitle.classList.remove("hidden");
  subtitle.textContent = state.settings.detail_modern_original_title !== false ? original : "";
  row.classList.remove("hidden");
  const title = $("#progressTitle");
  const clippedTitle = title.scrollHeight - title.clientHeight > 8;
  const clippedOriginal = subtitle.scrollWidth > subtitle.clientWidth;
  $("#modernFullTitle").classList.toggle("hidden", !(clippedTitle || clippedOriginal));
  subtitle.classList.toggle("hidden", !subtitle.textContent);
  row.classList.toggle("hidden", !subtitle.textContent && !clippedTitle);
  $("#detailFullTitleName").textContent = anime.display_name || "";
  $("#detailFullTitleOriginal").textContent = original;
}

function detailEpisodeReleaseStatus(anime, group) {
  if (Number(group.type) !== 0 || !$("#progressModal").classList.contains("detail-modern")) {
    return episodeReleaseStatus(anime, group);
  }
  const { useAS, finished, count } = modernDetailAiring(anime, Number(group.count));
  if (count === null) return episodeReleaseStatus(anime, group);
  const note = finished ? "按完结状态和正片总集数显示"
    : useAS ? "来自 AnimeSchedule 放送计划" : "按 Bangumi 逐集播出资料计算";
  return `<details class="detail-release-info"><summary>已播 ${count} 集</summary><p>${note}</p></details>`;
}

document.addEventListener("DOMContentLoaded", () => {
  const dialog = $("#progressModal");
  $("#modernFullTitle")?.addEventListener("click", () => $("#detailFullTitleDialog").showModal());
  dialog?.addEventListener("keydown", event => {
    const menu = $("#modernDetailMenu");
    if (event.defaultPrevented || event.key !== "Escape" || !menu?.open) return;
    event.preventDefault();
    menu.open = false;
    menu.querySelector("summary").focus();
  });
  $("#modernFindResources")?.addEventListener("click", () => {
    $("#modernDetailMenu").open = false;
    $("#openOffline").click();
  });
  $("#modernRateAnime")?.addEventListener("click", () => {
    $("#modernDetailMenu").open = false;
    $("#openAnimeRating").click();
  });
  $("#openAgeRelated")?.addEventListener("click", () => {
    if (!dialog.classList.contains("detail-modern")) return;
    $("#modernDetailMenu").open = false;
    switchDetailTab("overview");
  });
  document.addEventListener("click", event => {
    const menu = $("#modernDetailMenu");
    if (menu?.open && dialog.open && !menu.contains(event.target)) menu.open = false;
  });
  $(".detail-tabs", dialog)?.addEventListener("keydown", event => {
    if (!dialog.classList.contains("detail-modern")) return;
    const tabs = $$("[data-detail-tab]:not(.hidden)", event.currentTarget);
    const index = tabs.indexOf(event.target);
    if (index < 0) return;
    const destinations = { ArrowLeft: (index - 1 + tabs.length) % tabs.length,
      ArrowRight: (index + 1) % tabs.length, Home: 0, End: tabs.length - 1 };
    const next = tabs[destinations[event.key]];
    if (!next) return;
    event.preventDefault();
    next.focus();
    next.click();
  });
  if (typeof ResizeObserver !== "undefined" && dialog && $("#modernTitleTools")) {
    const observer = new ResizeObserver(() => { if (dialog.open) refreshModernDetailHeader(); });
    observer.observe($("#progressTitle"));
    observer.observe($("#progressCover"));
    observer.observe($("#modernTitleTools").parentElement);
  }
});

function openProgress(animeId) {
  const anime = state.animes.find((item) => item.id === animeId);
  if (!anime) return;
  state.progressAnime = anime;
  resetCharacterPanel();
  state.pendingEpisodes = new Set((anime.watched_episode_keys || anime.watched_episodes || []).map(String));
  state.episodeRecordAnnotations = {};
  episodeDownloadKeys = new Set();
  $("#progressCover").src = anime.cover_url;
  $("#progressCover").alt = anime.display_name;
  $("#progressTitle").textContent = anime.display_name;
  applyDetailLayout();
  $("#collectionDetailStatus").replaceChildren(collectionAction(anime.id,anime.collection_type));
  $("#collectionDetailStatus").classList.toggle("hidden", !collectionEditingSupported());
  $("#progressAirDate").textContent = anime.air_date || "";
  renderProgressBadge(anime);
  $("#savedVideoSection").open = false;
  renderVideoLinks(anime.id);
  $("#openAgeRelated").classList.toggle("hidden", !showAgeRelatedButton());
  applyCharacterTabVisibility();
  switchDetailTab("overview");
  $("#ageRelatedSection").classList.add("hidden");
  $("#ageRelatedGrid").innerHTML = "";
  $("#ageRelatedMeta").textContent = "";
  const rating = $("#animeRating");
  const score = Number(anime.bgm_score);
  const rank = Number(anime.bgm_rank);
  const votes = Number(anime.bgm_rating_total);
  const hasRating = Number.isFinite(score) && score > 0;
  rating.classList.toggle("hidden", !showBgmRating() || !hasRating);
  applyBgmRatingLink(rating, anime, hasRating);
  if (showBgmRating() && hasRating) {
    rating.innerHTML = `
      <span class="rating-score">${score.toFixed(1)}</span>
      ${rank > 0 ? `<span class="rating-divider"></span><span>排名 #${rank}</span>` : ""}
      ${votes > 0 ? `<span class="rating-divider"></span><span>${votes.toLocaleString("zh-CN")} 人评分</span>` : ""}
    `;
  } else {
    rating.textContent = "";
  }
  const personalRating = $("#personalRating");
  const personalText = String(anime.personal_rating_text || (anime.personal_score ? Number(anime.personal_score).toFixed(1) : "")).trim();
  personalRating.classList.toggle("hidden", !personalText);
  personalRating.textContent = personalText ? `我的评分 ${personalText}` : "";
  $("#animeCommentForm").classList.add("hidden");
  $("#animeCommentContent").value = "";
  renderAnimeComments(anime.id);
  $("#episodeCountInput").value = episodeTotal(anime);
  $("#episodeCountInput").readOnly = Boolean(anime.has_episode_list);
  $("#episodeCountInput").title = anime.has_episode_list
    ? "已按 Bangumi 章节列表同步，不能在这里改总数"
    : "未取得章节列表时可手动填写章节数";
  renderEpisodeGrid();
  $("#progressModal").showModal();
  refreshModernDetailHeader();
  syncDetailCornerActions();
  if (state.settings?.detail_airtime_source === "as") {
    api(`/api/animes/${anime.id}`, { timeoutMs: 30000 }).then(({ anime: fresh }) => {
      if (!fresh || state.progressAnime?.id !== anime.id || !$("#progressModal").open) return;
      state.progressAnime.as_airing = fresh.as_airing;
      const entry = state.animes.find(item => item.id === anime.id);
      if (entry) entry.as_airing = fresh.as_airing;
      refreshEpisodeAiringStatus();
    }).catch(() => { /* Cached airing data remains visible. */ });
  }
  ensureEpisodeTitles(anime);
  refreshEpisodeRecordAnnotations(anime.id);
  // 打开详情就刷一次「已下载」角标：以前从没做过这个标记，下载完的集在
  // 格子上和没下载的完全一样，只能靠点扇区「播放」试出来。
  if (typeof syncEpisodeDownloadMarks === "function") syncEpisodeDownloadMarks();
}

function switchDetailTab(tab) {
  const isCharacters = tab === "characters";
  const modern = $("#progressModal").classList.contains("detail-modern");
  $("#progressModal").classList.toggle("detail-non-episodes", modern && isCharacters);
  $("#overviewDetailPanel").classList.toggle("hidden", isCharacters);
  const overview = $('[data-detail-tab="overview"]');
  if (overview) overview.textContent = "概览";
  $("#charactersDetailPanel").classList.toggle("hidden", !isCharacters);
  $$("[data-detail-tab]").forEach((button) => {
    const active = button.dataset.detailTab === tab;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
    if (modern) button.tabIndex = active ? 0 : -1;
    else button.removeAttribute("tabindex");
  });
}

function renderCharacters(characters, animeId) {
  characterPanelHasData = characters.length > 0;
  const grid = $("#characterGrid");
  const empty = $("#charactersEmpty");
  empty.classList.toggle("hidden", characters.length > 0);
  grid.innerHTML = characters.map((character) => `
    <article class="character-card">
      ${character.image_url ? `<img src="${escapeHtml(character.cover_url || character.image_url)}" alt="${escapeHtml(character.name_cn || character.name)}" loading="lazy" />` : `<div class="character-image-placeholder">人</div>`}
      <div class="character-info"><strong>${escapeHtml(character.name_cn || character.name)}</strong>${character.name && character.name !== character.name_cn ? `<span>${escapeHtml(character.name)}</span>` : ""}${character.cv_names?.length ? `<small>CV：${escapeHtml(character.cv_names.join(" / "))}</small>` : ""}</div>
      <button type="button" class="character-record-button" data-character-id="${character.character_id}">记录</button>
    </article>`).join("");
  $$(".character-record-button", grid).forEach((button) => button.addEventListener("click", async () => {
    const character = characters.find((item) => String(item.character_id) === button.dataset.characterId);
    const anime = state.progressAnime;
    if (!character || anime?.id !== animeId) return;
    const imageUrl = character.cover_url || character.image_url;
    const text = `${character.name_cn || character.name}${imageUrl ? `\n![${character.name_cn || character.name}](${imageUrl})` : ""}`;
    try {
      await api("/api/notes", { method: "POST", body: JSON.stringify({
        anime_id: anime.id, theme: "character_record", themes: ["character_record"], content: text,
        raw_directives: recordTextFormat({ themes: ["人物记录"], anime: anime.display_name, content: text }),
      }) });
      toast("人物记录已写入时间线");
    } catch (error) { toast(error.message, "error"); }
  }));
}

let characterViewVersion = 0;
let characterPanelHasData = false;
const characterRefreshes = new Map();

function resetCharacterPanel() {
  characterViewVersion += 1;
  characterPanelHasData = false;
  $("#charactersStatus").textContent = "首次打开时从 Bangumi 获取，并保存到本地。";
  $("#characterGrid").innerHTML = "";
  $("#charactersEmpty").classList.remove("hidden");
  $("#charactersEmpty p").textContent = "点击人物分栏后加载角色资料。";
  $("#refreshCharacters").disabled = false;
  $("#refreshCharacters").textContent = "刷新人物";
}

function refreshCharactersForAnime(animeId) {
  // Reuse an in-flight refresh when the same subject is opened again.
  if (!characterRefreshes.has(animeId)) {
    const request = api(`/api/animes/${animeId}/characters`, {
      method: "POST", body: JSON.stringify({}),
    }).finally(() => characterRefreshes.delete(animeId));
    characterRefreshes.set(animeId, request);
  }
  return characterRefreshes.get(animeId);
}

async function loadCharacters(force = false) {
  if (!state.progressAnime) return;
  const animeId = state.progressAnime.id;
  const version = ++characterViewVersion;
  const isCurrent = () => version === characterViewVersion &&
    state.progressAnime?.id === animeId && $("#progressModal").open;
  const button = $("#refreshCharacters");
  button.disabled = true;
  button.textContent = force ? "正在刷新…" : "正在加载…";
  $("#charactersStatus").textContent = characterPanelHasData ? "已显示本地资料，正在检查更新…" : "正在读取本地人物资料…";
  $("#charactersEmpty p").textContent = "正在读取本地人物资料…";
  let hasCharacters = characterPanelHasData;
  try {
    let result = await api(`/api/animes/${animeId}/characters`);
    if (!isCurrent()) return;
    hasCharacters = Boolean(result.characters?.length);
    renderCharacters(result.characters || [], animeId);
    $("#charactersStatus").textContent = hasCharacters ? "已显示本地人物资料。" : "正在获取人物资料…";
    // Show the local cache before any network refresh, including old-order caches.
    if (force || !hasCharacters || result.needs_order_refresh) {
      $("#charactersStatus").textContent = hasCharacters ? "已显示本地资料，正在更新…" : "正在获取人物资料…";
      $("#charactersEmpty p").textContent = "正在获取人物资料…";
      button.textContent = hasCharacters ? "正在更新…" : "正在获取…";
      result = await refreshCharactersForAnime(animeId);
      if (!isCurrent()) return;
      renderCharacters(result.characters || [], animeId);
      $("#charactersStatus").textContent = characterPanelHasData ? "人物资料已更新，并保存到本地。" : "暂未找到人物资料。";
    }
    $("#charactersEmpty p").textContent = "暂无人物资料。";
  } catch (error) {
    if (!isCurrent()) return;
    const message = hasCharacters ? "更新失败，继续显示本地资料。" : "暂时无法获取人物资料，请点击刷新重试。";
    $("#charactersStatus").textContent = message;
    if (!hasCharacters) $("#charactersEmpty p").textContent = message;
    toast(`人物资料暂时无法获取：${error.message}`, "error");
  } finally {
    if (isCurrent()) {
      button.disabled = false;
      button.textContent = "刷新人物";
    }
  }
}

async function refreshEpisodeRecordAnnotations(animeId) {
  try {
    const result = await api(`/api/animes/${animeId}/episode-records`);
    if (state.progressAnime?.id !== animeId) return;
    state.episodeRecordAnnotations = result.annotations || {};
    renderEpisodeGrid();
  } catch (error) {
    console.warn("读取单集记录标记失败", error);
  }
}

async function ensureEpisodeTitles(anime) {
  if (!showEpisodeTitlesOnHover() || anime.episode_titles_synced) return;
  try {
    const result = await api(`/api/animes/${anime.id}/episode-titles`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    const latest = result.anime;
    if (!latest) return;
    commitAnimes(state.animes.map((item) => item.id === latest.id ? latest : item), { render: false });
    if (state.progressAnime?.id === latest.id) {
      const current = state.progressAnime;
      const canonicalKeys = new Map((latest.episodes || []).map(episode => [episodeStorageKey(episode.key, latest), String(episode.key)]));
      state.pendingEpisodes = new Set([...state.pendingEpisodes].map(key =>
        canonicalKeys.get(episodeStorageKey(key, current)) || key));
      state.progressAnime = latest;
      $("#episodeCountInput").value = episodeTotal(latest);
      renderEpisodeGrid();
    }
  } catch (error) {
    toast(`单集名称暂未补全：${error.message}`, "error");
  }
}

function renderAnimeComments(comments) {
  const list = $("#animeCommentList");
  if (!Array.isArray(comments)) {
    return api(`/api/animes/${comments}/comments`)
      .then((result) => renderAnimeComments(result.comments || []))
      .catch((error) => toast(error.message, "error"));
    return;
  }
  list.innerHTML = comments.length
    ? comments.map((comment) => `
        <article class="anime-comment-item" data-comment-id="${comment.id}">
          <div class="anime-comment-head">
            <time>${formatTime(comment.created_at)}</time>
            <div class="anime-comment-actions">
              <button type="button" class="anime-comment-action edit-anime-comment" data-comment-id="${comment.id}">编辑</button>
              <button type="button" class="anime-comment-action delete-anime-comment" data-comment-id="${comment.id}">删除</button>
            </div>
          </div>
          <p>${escapeHtml(comment.content)}</p>
        </article>
      `).join("")
    : `<p class="muted-line">还没有番剧评论。</p>`;

  list.querySelectorAll(".edit-anime-comment").forEach((button) => {
    button.addEventListener("click", () => {
      const comment = comments.find((item) => String(item.id) === button.dataset.commentId);
      const article = button.closest(".anime-comment-item");
      if (!comment || !article || article.querySelector(".anime-comment-editor")) return;
      const editor = document.createElement("form");
      editor.className = "anime-comment-editor";
      editor.innerHTML = `
        <textarea aria-label="编辑番剧评论">${escapeHtml(comment.content)}</textarea>
        <div class="anime-comment-editor-actions">
          <button type="button" class="text-button cancel-anime-comment-edit">取消</button>
          <button type="submit" class="primary-button compact-button">保存</button>
        </div>
      `;
      article.querySelector("p")?.classList.add("hidden");
      article.append(editor);
      const textarea = editor.querySelector("textarea");
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      editor.querySelector(".cancel-anime-comment-edit").addEventListener("click", () => {
        editor.remove();
        article.querySelector("p")?.classList.remove("hidden");
      });
      editor.addEventListener("submit", async (event) => {
        event.preventDefault();
        const content = textarea.value.trim();
        if (!content) {
          toast("番剧评论不能为空", "error");
          textarea.focus();
          return;
        }
        const anime = state.progressAnime;
        if (!anime) return;
        const theme = eventTheme({ theme: "anime_comment" });
        try {
          if (!await saveEditedRecord(editor, comment.id, {
              content,
              anime_id: anime.id,
              theme: "anime_comment",
              raw_directives: recordTextFormat({ theme: theme.name, anime: anime.display_name, content }),
          })) return;
          await Promise.all([renderAnimeComments(anime.id), renderTimeline()]);
          toast("番剧评论已更新");
        } catch (error) {
          toast(error.message, "error");
        }
      });
    });
  });

  list.querySelectorAll(".delete-anime-comment").forEach((button) => {
    button.addEventListener("click", async () => {
      const comment = comments.find((item) => String(item.id) === button.dataset.commentId);
      const anime = state.progressAnime;
      if (!comment || !anime || !window.confirm("确定删除这条番剧评论吗？时间线中的同一条记录也会删除。")) return;
      try {
        await api(`/api/events/${comment.id}`, { method: "DELETE" });
        await Promise.all([renderAnimeComments(anime.id), renderTimeline()]);
        toast("番剧评论已删除");
      } catch (error) {
        toast(error.message, "error");
      }
    });
  });
  return undefined;
}

function renderAgeRelated(related) {
  const section = $("#ageRelatedSection");
  const items = related.items || [];
  section.classList.remove("hidden");
  $("#ageRelatedMeta").textContent = `AGE 搜索「${related.search_term || ""}」· ${items.length} 部`;
  $("#ageRelatedGrid").innerHTML = items.length
    ? items.map((item) => `
        <a class="age-related-card" href="${escapeHtml(item.age_url)}" target="_blank" rel="noreferrer">
          <img src="${escapeHtml(item.cover_url)}" alt="${escapeHtml(item.title)}" loading="lazy" onerror="this.style.visibility='hidden'" />
          <div>
            <strong>${escapeHtml(item.title)}</strong>
            <span>${escapeHtml(item.air_date || "日期未知")}</span>
            <small>${escapeHtml(item.episode_text || (item.episode_count ? `${item.episode_count} 集` : "集数未知"))}</small>
          </div>
        </a>
      `).join("")
    : `<p class="muted-line">AGE 未返回相关番剧。</p>`;
}

async function updateCustomMembership(collectionId, checked) {
  const anime = state.progressAnime || state.moveAnime;
  if (!anime) return;
  try {
    const result = await api(
      checked
        ? `/api/custom-collections/${collectionId}/items`
        : `/api/custom-collections/${collectionId}/items/${anime.id}`,
      {
        method: checked ? "POST" : "DELETE",
        body: checked
          ? JSON.stringify({ anime_id: anime.id })
          : undefined,
      },
    );
    state.custom_collections = result.custom_collections || state.custom_collections;
    state.stats = result.stats || state.stats;
    if (result.anime) {
      const index = state.animes.findIndex((item) => item.id === result.anime.id);
      if (index >= 0) state.animes[index] = result.anime;
      commitAnimes(state.animes, { render: false });
      if (state.progressAnime?.id === result.anime.id) state.progressAnime = result.anime;
      if (state.moveAnime?.id === result.anime.id) state.moveAnime = result.anime;
    }
    renderTabs();
    renderCollection();
    // 菜单保持打开：一部番经常要同时放进好几个收藏夹，关掉就得重新点开。
    syncCustomMoveMenuState();
    const mapped = Number(result.anime?.mapped_category) || 0;
    if (checked && mapped) {
      toast(
        `已加入自定义收藏夹，并同步到 Kazumi「${typeof customCollectionCategoryName === "function" ? customCollectionCategoryName(mapped) : "收藏夹"}」`,
      );
    } else if (checked) {
      toast("已加入自定义收藏夹");
    } else {
      toast("已移出自定义收藏夹");
    }
  } catch (error) {
    toast(error.message, "error");
  }
}

// 加入/移出后只更新菜单里的勾选状态，不销毁菜单。
function syncCustomMoveMenuState() {
  const menu = $("#customMoveMenu");
  if (!menu) return;
  const anime = state.moveAnime;
  const membership = new Set((anime?.custom_collection_ids || []).map(Number));
  $$(".move-menu-check", menu).forEach((input) => {
    input.checked = membership.has(Number(input.dataset.collectionId));
  });
}

function closeCustomMoveMenu() {
  const menu = $("#customMoveMenu");
  if (menu) menu.remove();
  state.moveAnime = null;
  document.removeEventListener("click", closeCustomMoveMenuOnce);
}

function openCustomMoveMenu(animeId, anchor) {
  closeCustomMoveMenu();
  const anime = state.animes.find((item) => item.id === animeId);
  if (!anime) return;
  state.moveAnime = anime;
  const menu = document.createElement("div");
  menu.className = "custom-move-menu";
  menu.id = "customMoveMenu";
  const membership = new Set((anime.custom_collection_ids || []).map(Number));
  const list = state.custom_collections.length
    ? state.custom_collections.map((collection) => {
        const mapped = Number(collection.kazumi_category) || 0;
        const mapLabel = mapped
          ? `<em class="move-menu-map">→ ${escapeHtml(typeof customCollectionCategoryName === "function" ? customCollectionCategoryName(mapped) : "Kazumi")}</em>`
          : "";
        return `
        <label class="move-menu-item">
          <input
            type="checkbox"
            class="move-menu-check"
            data-collection-id="${collection.id}"
            ${membership.has(Number(collection.id)) ? "checked" : ""}
          />
          <span class="move-menu-name">${escapeHtml(collection.name)}${mapLabel}</span>
        </label>
      `;
      }).join("")
    : `<div class="move-menu-empty">还没有自定义收藏夹</div>`;
  menu.innerHTML = `
    <div class="move-menu-title">移入自定义收藏夹</div>
    ${list}
    <button type="button" class="move-menu-create" id="moveMenuCreate">新建收藏夹</button>
  `;
  document.body.append(menu);
  const rect = anchor.getBoundingClientRect();
  const menuWidth = 220;
  menu.style.left = `${Math.min(window.innerWidth - menuWidth - 12, Math.max(12, rect.right - menuWidth))}px`;
  menu.style.top = `${Math.min(window.innerHeight - 12, rect.bottom + 8)}px`;
  $$(".move-menu-check", menu).forEach((input) => {
    input.addEventListener("change", async (event) => {
      await updateCustomMembership(
        Number(event.target.dataset.collectionId),
        event.target.checked,
      );
    });
  });
  $("#moveMenuCreate", menu).addEventListener("click", async () => {
    const created = await createCustomCollection({ selectAfterCreate: false });
    if (created?.collection?.id) {
      state.moveAnime = state.animes.find((item) => item.id === animeId) || anime;
      await updateCustomMembership(Number(created.collection.id), true);
    }
  });
  setTimeout(() => {
    document.addEventListener("click", closeCustomMoveMenuOnce);
  }, 0);
}

function closeCustomMoveMenuOnce(event) {
  if ($("#customMoveMenu")?.contains(event.target)) return;
  if (event.target.closest?.(".card-move-button")) return;
  closeCustomMoveMenu();
}

function episodeAnnotationMarkup(annotations) {
  return annotations.map((annotation) => {
    const names = annotation.themes
      .map((id) => eventTheme({ theme: id }).name)
      .join("、");
    return `<div><strong>${escapeHtml(names)}</strong><span>${escapeHtml(annotation.content || "（无正文）")}</span></div>`;
  }).join("");
}

function refreshEpisodeAiringStatus() {
  if (!state.progressAnime) return;
  renderProgressBadge(state.progressAnime);
  refreshModernDetailHeader();
  $$("[data-episode-airing-type]", $("#episodeGrid")).forEach((element) => {
    const markup = detailEpisodeReleaseStatus(state.progressAnime, {
      type: Number(element.dataset.episodeAiringType), count: Number(element.dataset.episodeCount),
    });
    const current = element.querySelector(".detail-release-info");
    if (current && markup.startsWith('<details class="detail-release-info">')) {
      const template = document.createElement("template");
      template.innerHTML = markup;
      for (const tag of ["summary", "p"]) {
        const node = current.querySelector(tag);
        const value = template.content.querySelector(tag).textContent;
        if (node.textContent !== value) node.textContent = value;
      }
    } else {
      element.innerHTML = markup;
    }
  });
}

// 已下载的集数在格子上留一个角标。key 先归一化到「类型:集数」再比较，
// 兼容 Bangumi 的 bgm:xxx 与归档写入的 0:N 两套标识。
let episodeDownloadKeys = new Set();
let episodeMarkToken = 0;

async function syncEpisodeDownloadMarks(files = null) {
  const anime = state.progressAnime;
  const animeId = Number(anime?.id || 0);
  if (!animeId || typeof episodeStorageKey !== "function") return;
  const token = ++episodeMarkToken;
  let list = Array.isArray(files) ? files : null;
  if (!list) {
    try {
      const data = await api(`/api/offline/state?anime_id=${animeId}`);
      // 慢响应或已经切到别的番：别把旧数据涂到当前格子上。
      if (token !== episodeMarkToken) return;
      list = data.files || [];
    } catch (_) {
      return; // 离线服务没开就保持无标记
    }
  }
  if (Number(state.progressAnime?.id || 0) !== animeId) return;
  episodeDownloadKeys = new Set(
    list.filter((item) => item && item.exists !== false)
      .map((item) => episodeStorageKey(item.episode_key, anime))
  );
  $$(".episode-cell").forEach((cell) => {
    const on = episodeDownloadKeys.has(episodeStorageKey(cell.dataset.episodeKey, anime));
    cell.classList.toggle("downloaded", on);
    // 首次打开详情时格子已经渲染完、角标是异步补的，title 也要一起补；
    // 重渲染时 title 里已经带过这句话，先去掉再加，避免越积越长。
    const base = String(cell.title || "").replace(/(?:^| · )已下载 · 扇区可播放$/, "");
    cell.title = on ? [base, "已下载 · 扇区可播放"].filter(Boolean).join(" · ") : base;
  });
  if ($("#progressModal").classList.contains("detail-modern")) refreshModernDetailHeader();
}

function renderEpisodeGrid() {
  const anime = state.progressAnime;
  if (!anime) return;
  if (typeof egCloseMenu === "function") egCloseMenu();
  $("#episodeAnnotationPopover")?.remove();
  const total = Number($("#episodeCountInput").value || 0);
  const officialEpisodes = Array.isArray(anime.episodes) ? anime.episodes : [];
  const episodes = officialEpisodes.length
    ? officialEpisodes
    : Array.from({ length: total }, (_, index) => {
        const number = index + 1;
        return {
          key: `0:${number}`,
          type: 0,
          type_label: "本篇",
          label: String(number).padStart(2, "0"),
          display_label: `本篇 ${String(number).padStart(2, "0")}`,
          name: `第 ${number} 集`,
          name_cn: "",
        };
      });
  const validKeys = new Set(episodes.map((episode) => String(episode.key)));
  const valid = [...state.pendingEpisodes].filter((episode) => validKeys.has(String(episode)));
  state.pendingEpisodes = new Set(valid);
  if (typeof refreshSavedVideoTargets === "function") refreshSavedVideoTargets();
  const groups = episodes.reduce((result, episode) => {
    const type = Number(episode.type || 0);
    let group = result.find((item) => item.type === type);
    if (!group) {
      group = {
        type,
        type_label: episode.type_label || "本篇",
        count: 0,
        episodes: [],
      };
      result.push(group);
    }
    group.episodes.push(episode);
    group.count += 1;
    return result;
  }, []);
  $("#episodeGrid").innerHTML = episodes.length
    ? groups.map((group) => `
        <section class="episode-group" data-detail-episode-group="${group.type}">
          <div class="episode-group-head">
            <strong>${escapeHtml(group.type_label)}</strong>
            <div class="episode-group-meta">
              <span class="episode-group-summary" data-episode-group-summary>${episodeGroupSummary(group, state.pendingEpisodes)}</span>
          ${Number(group.type) === 0 ? `<div class="episode-airing-info" data-episode-airing-type="0" data-episode-count="${group.count}">${detailEpisodeReleaseStatus(anime, group)}</div>` : ""}
            </div>
          </div>
          <div class="episode-group-grid">
            ${group.episodes.map((episode) => {
              const key = String(episode.key);
              const watched = state.pendingEpisodes.has(key);
              const downloaded = typeof episodeStorageKey === "function"
                && episodeDownloadKeys.has(episodeStorageKey(key, anime));
              const annotations = state.episodeRecordAnnotations?.[key] || [];
              return `
                <button type="button" class="episode-cell ${watched ? "watched" : ""}${downloaded ? " downloaded" : ""}"
                  data-episode-key="${escapeHtml(key)}" data-episode-type="${group.type}" data-detail-episode-label="${escapeHtml(episode.label)}"
                  aria-pressed="${watched}"
                  title="${escapeHtml([showEpisodeTitlesOnHover() ? episodeTitle(episode) : "", downloaded ? "已下载 · 扇区可播放" : ""].filter(Boolean).join(" · "))}">
                  ${group.type === 2 || group.type === 3 ? `<span class="detail-credit-check" aria-hidden="true"></span><span class="detail-credit-prefix">${escapeHtml(group.type_label)} </span>` : ""}${escapeHtml(episode.label)}
                  ${annotations.length ? `<span class="episode-note-mark" aria-label="本集有 ${annotations.length} 条记录">✎</span>` : ""}
                </button>
              `;
            }).join("")}
          </div>
        </section>
      `).join("")
    : `<div class="empty-state"><p>暂未取得章节。</p></div>`;
  const creditActions = $("#detailCreditActions");
  if (creditActions) {
    const compact = $("#progressModal").classList.contains("detail-compact-credits");
    const credits = compact ? $$('#episodeGrid :is([data-detail-episode-group="2"], [data-detail-episode-group="3"])') : [];
    creditActions.replaceChildren(...credits);
    creditActions.classList.toggle("hidden", credits.length === 0);
  }
  updateDetailRecordActions();
  if ($("#progressModal").classList.contains("detail-modern")) refreshModernDetailHeader();
  // 标注气泡仍按格子绑定；所有点击/长按/右键交给 episode-gesture.js 的委托，
  // 扇区格数与绑定表都由设置驱动，这里不再散着写事件。
  $$(".episode-cell", $("#progressModal")).forEach((button) => {
    const annotations = state.episodeRecordAnnotations?.[String(button.dataset.episodeKey)] || [];
    if (!annotations.length) return;
    const close = () => $("#episodeAnnotationPopover")?.remove();
    const open = () => {
      close();
      const rect = button.getBoundingClientRect();
      const popover = document.createElement("aside");
      popover.id = "episodeAnnotationPopover";
      popover.className = "episode-annotation-popover";
      popover.innerHTML = episodeAnnotationMarkup(annotations);
      $("#progressModal").append(popover);
      const width = Math.min(260, window.innerWidth - 24);
      popover.style.width = `${width}px`;
      popover.style.left = `${Math.max(12, Math.min(window.innerWidth - width - 12, rect.right - width))}px`;
      const height = popover.getBoundingClientRect().height;
      popover.style.top = `${rect.top < 180 ? rect.bottom + 10 : Math.max(12, rect.top - height - 10)}px`;
    };
    button.addEventListener("pointerenter", open);
    button.addEventListener("pointerleave", close);
    button.addEventListener("focusin", open);
    button.addEventListener("focusout", close);
  });

  if (typeof installEpisodeGestures !== "function") return;
  installEpisodeGestures($("#progressForm") || $("#episodeGrid"), {
    onToggleWatched: (button) => {
      if ($("#saveProgress")?.dataset.saving === "true") return;
      const key = String(button.dataset.episodeKey);
      if (state.pendingEpisodes.has(key)) state.pendingEpisodes.delete(key);
      else state.pendingEpisodes.add(key);
      button.classList.toggle("watched");
      button.setAttribute("aria-pressed", String(state.pendingEpisodes.has(key)));
      if (typeof refreshSavedVideoTargets === "function") refreshSavedVideoTargets();
      $$(".episode-group").forEach((section) => {
        const keys = $$(".episode-cell", section).map((item) => item.dataset.episodeKey);
        const watched = keys.filter((item) => state.pendingEpisodes.has(String(item))).length;
        $("[data-episode-group-summary]", section).textContent = `已看 ${watched} / ${keys.length}`;
      });
      updateDetailRecordActions();
    },
    onAction: (action, key, button) => runEpisodeGestureAction(action, key, button),
  });

}

async function playDetailEpisode(key = "", button = null) {
  const anime = state.progressAnime;
  if (!anime || button?.disabled || button?.getAttribute("aria-disabled") === "true") return;
  const source = episodeGestureConfig().playbackSource;
  if (button) button.disabled = true;
  try {
    const episodeKey = key || button?.dataset.detailEpisodeKey || `0:${mainPlaybackEpisode(anime).number}`;
    if (source !== "online") {
      const file = await localFileForEpisode(episodeKey);
      if (anime !== state.progressAnime || (button && !$("#progressModal").open)) return;
      if (file) return playLocalFile(file.id);
    }
    if (source !== "local" && !window.handbookOnline && window.onlinePlayback) {
      return await window.onlinePlayback.openAnime(anime, episodeKey);
    }
    toast(source === "online" ? "当前版本不支持在线播放。" : "这一集还没下载。", "error");
  } catch (error) {
    toast(error.message, "error");
  } finally {
    if (button) button.disabled = false;
  }
}

async function runEpisodeGestureAction(action, key, button) {
  const episodes = Array.isArray(state.progressAnime?.episodes) ? state.progressAnime.episodes : [];
  const episode = episodes.find((item) => String(item.key) === String(key)) || {
    key,
    label: String(button?.textContent || "").trim(),
  };
  if (["score", "review", "op", "ed"].includes(action)) {
    return createEpisodeQuickRecord(episode, action);
  }
  if (action === "open_menu") return;
  if (action === "play") return playDetailEpisode(key);
  if (action === "cancel_download" && state.progressAnime) {
    const anime = state.progressAnime;
    const episodeKey = episodeStorageKey(key, anime);
    try {
      const { jobs = [] } = await api(`/api/offline/state?anime_id=${anime.id}`);
      if (anime !== state.progressAnime) return;
      const job = jobs.find(item => item.episode_key
        && episodeStorageKey(item.episode_key, anime) === episodeKey
        && ["queued", "downloading", "paused"].includes(item.status));
      if (job) return removeJob(job.id);
      toast("这集没有可取消的下载任务。", "error");
    } catch (error) {
      toast(error.message, "error");
    }
    return;
  }
  if (action === "delete") {
    const anime = state.progressAnime;
    // 必须先按当前番同步离线缓存再找文件：不 await 会读到上一部番的缓存，
    // 播错内容或误报「还没下载」。
    const file =
      typeof localFileForEpisode === "function" ? await localFileForEpisode(key) : null;
    if (anime !== state.progressAnime) return;
    if (file) return removeLocalFile(file.id);
    toast("这一集还没下载，先用「找资源」下下来", "error");
    return;
  }
  if (action === "download" || action === "redownload") {
    if (typeof openOffline === "function") return openOffline();
  }
  if (action === "reveal_in_folder" && typeof openOffline === "function") {
    openOffline();
    switchOfflineTab("local");
  }
}

async function createEpisodeQuickRecord(episode, action) {
  const anime = state.progressAnime;
  if (!anime || !quickRecordActionEnabled(action)) return;
  const definitions = {
    review: { id: "episode_review", label: "单集评价", prompt: "写下这集的评价" },
    score: { id: "episode_rating", label: "单集评分", prompt: "给这一集打分（可输入任意文字）" },
    op: { id: "oped", label: "OP/ED记录", prompt: "记录这段 OP（可改成自己的感受）", initial: "OP" },
    ed: { id: "oped", label: "OP/ED记录", prompt: "记录这段 ED（可改成自己的感受）", initial: "ED" },
  };
  const definition = definitions[action];
  if (!definition) return;
  const theme = recordThemes().find((item) => item.id === definition.id) || { id: definition.id, name: definition.label };
  const episodeLabel = episode.display_label || `${episode.type_label || "本篇"} ${episode.label}`;
  const dialog = document.createElement("dialog");
  dialog.className = "episode-record-dialog";
  dialog.setAttribute("aria-labelledby", "episodeRecordTitle");
  dialog.innerHTML = `
    <form method="dialog">
      <header class="episode-record-header">
        <h2 id="episodeRecordTitle">${escapeHtml(definition.label)}</h2>
        <p>${escapeHtml(episodeLabel)}</p>
        <button type="button" class="episode-record-close" aria-label="关闭">×</button>
      </header>
      <div class="episode-record-body">
        <label for="episodeRecordContent">${escapeHtml(definition.prompt)}</label>
        ${action === "score"
          ? '<input id="episodeRecordContent" type="text" required autofocus />'
          : '<textarea id="episodeRecordContent" rows="4" required autofocus></textarea>'}
        <p class="episode-record-error" role="alert" hidden></p>
      </div>
      <footer class="episode-record-footer">
        <button type="button" class="secondary-button" data-cancel-record>取消</button>
        <button type="submit" class="primary-button">保存</button>
      </footer>
    </form>`;
  const field = dialog.querySelector("#episodeRecordContent");
  const error = dialog.querySelector(".episode-record-error");
  const form = dialog.querySelector("form");
  const submit = form.querySelector('button[type="submit"]');
  const closeButtons = dialog.querySelectorAll('button[type="button"]');
  field.value = definition.initial || "";
  for (const button of closeButtons) button.addEventListener("click", () => dialog.close());
  dialog.addEventListener("cancel", (event) => {
    if (submit.disabled) event.preventDefault();
  });
  dialog.addEventListener("close", () => dialog.remove(), { once: true });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (submit.disabled) return;
    const text = field.value.trim();
    if (!text) {
      error.textContent = action === "score" ? "单集评分不能为空" : "记录内容不能为空";
      error.hidden = false;
      field.focus();
      return;
    }
    error.hidden = true;
    submit.disabled = true;
    field.readOnly = true;
    for (const button of closeButtons) button.disabled = true;
    try {
      await api("/api/notes", {
        method: "POST",
        body: JSON.stringify({
          content: text,
          anime_id: anime.id,
          theme: definition.id,
          themes: [definition.id],
          episode_keys: [episode.key],
          raw_directives: recordTextFormat({ themes: [theme.name], anime: anime.display_name, episodes: episodeLabel, content: text }),
        }),
      });
    } catch (requestError) {
      error.textContent = requestError.message;
      error.hidden = false;
      submit.disabled = false;
      field.readOnly = false;
      for (const button of closeButtons) button.disabled = false;
      field.focus();
      return;
    }
    dialog.close();
    try {
      await renderTimeline();
      await refreshEpisodeRecordAnnotations(anime.id);
      toast(`${definition.label}已写入时间线`);
    } catch (refreshError) {
      toast(`记录已保存，刷新显示失败：${refreshError.message}`, "error");
    }
  });
  document.body.append(dialog);
  dialog.showModal();
  field.select();
}

async function saveProgress() {
  const anime = state.progressAnime;
  const button = $("#saveProgress");
  if (!anime || button.disabled) return;
  button.dataset.saving = "true";
  updateDetailRecordActions();
  const episodeKeys = [...state.pendingEpisodes];
  const dialog = $("#progressModal");
  try {
    const total = Number($("#episodeCountInput").value || 0);
    if (!anime.has_episode_list && total !== Number(anime.episode_count || 0)) {
      await api(
        `/api/animes/${anime.id}/episode-count`,
        {
          method: "POST",
          body: JSON.stringify({ episode_count: total }),
        },
      );
    }
    const result = await api(`/api/animes/${anime.id}/progress`, {
      method: "POST",
      body: JSON.stringify({ episode_keys: episodeKeys }),
    });
    const index = state.animes.findIndex((item) => item.id === result.anime.id);
    if (index >= 0) state.animes[index] = result.anime;
    commitAnimes(state.animes, { render: false });
    if (dialog.open && state.progressAnime?.id === anime.id) {
      if (dialog.classList.contains("detail-modern")) {
        Object.assign(state.progressAnime, result.anime);
        updateDetailRecordActions();
        refreshModernDetailHeader();
        refreshEpisodeRecordAnnotations(anime.id);
      } else {
        dialog.close();
      }
    }
    renderCollection();
    await refreshStatus();
    if (result.recorded_episodes.length) {
      toast(`已记录 ${result.recorded_episodes.length} 集到时间线`);
    } else {
      toast("观看进度已更新");
    }
  } catch (error) {
    toast(error.message, "error");
  } finally {
    delete button.dataset.saving;
    updateDetailRecordActions();
  }
}

