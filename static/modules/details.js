function applyCharacterTabVisibility() {
  const enabled = enabledSetting("show_character_tab");
  $("#charactersDetailTab").classList.toggle("hidden", !enabled);
  if (!enabled && !$("#charactersDetailPanel").classList.contains("hidden")) {
    switchDetailTab("overview");
  }
}

const WEEKDAY_NAMES = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

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
  const nextAt = Number(anime?.airing?.next_at || 0);
  if (nextAt > 0) {
    // 时间戳按北京时间判星期：番剧凌晨档（JST 25:30）在 UTC 会落回前一天。
    const beijing = new Date(nextAt * 1000 + 8 * 3600 * 1000);
    return { weekday: WEEKDAY_NAMES[beijing.getUTCDay()], ongoing: true };
  }
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
  const nextAt = Number(anime?.airing?.next_at || 0);
  if (nextAt > 0) {
    // 按北京时间取钟点：番剧凌晨档（JST 25:30）在 UTC 会落回前一天。
    const beijing = new Date(nextAt * 1000 + 8 * 3600 * 1000);
    return `${String(beijing.getUTCHours()).padStart(2, "0")}:${String(beijing.getUTCMinutes()).padStart(2, "0")}`;
  }
  return "";
}

// 已播集数优先用后端算好的 airing（与集数区的药丸同源），没有就按逐集日期数。
function animeAiringCounts(anime, today = new Date()) {
  const useAS = state.settings?.collection_airing_source === "as";
  const source = useAS ? anime?.as_airing : anime?.airing;
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

// 四态徽标：连载中（绿）/ 已完结（灰）/ 未开播（暖黄）/ 日期未知（灰）。
// 完结态按你定的口径只写「已完结」，不写「已播完」；集数区的「已播 N」
// 药丸仍按 B8 的口径隐藏，两处不重复。
function animeBadgeModel(anime, today = new Date()) {
  const info = animeUpdateWeekday(anime, today);
  const counts = animeAiringCounts(anime, today);
  const premiere = parseIsoDate(anime?.air_date);
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const weekday = info ? `每${info.weekday}` : "";

  if (!premiere && !counts.dated && !info) {
    return { kind: "unknown", text: "日期未知", title: "条目和逐集资料里都没有播出日期" };
  }
  if (premiere && premiere > todayStart && counts.aired === 0) {
    const days = Math.round((premiere - todayStart) / 86400000);
    const when = days <= 7 ? "下周开播" : `${premiere.getMonth() + 1}月${premiere.getDate()}日开播`;
    return {
      kind: "upcoming",
      text: weekday ? `${when} · ${weekday}` : when,
      title: "按 Bangumi 首播日期推算；还没开播，不显示已播集数",
    };
  }
  if (info?.ongoing || counts.upcoming > 0) {
    const clock = animeAirClock(anime);
    const parts = [`${weekday}${clock ? ` ${clock} ` : ""}更新`];
    if (counts.aired > 0) parts.push(`已播 ${counts.aired}${counts.total ? `/${counts.total}` : ""}`);
    return {
      kind: "ongoing",
      text: parts.join(" · "),
      title: clock
        ? "星期按逐集放送日期推算，钟点来自当季周表的北京时间放送时刻"
        : "星期按逐集放送日期推算；这份资料没有放送钟点",
    };
  }
  return {
    kind: "finished",
    text: counts.total ? `已完结 · 全 ${counts.total} 集` : "已完结",
    title: "已经播完；完结番不谎报更新星期",
  };
}

function renderProgressBadge(anime) {
  const model = animeBadgeModel(anime);
  const badge = $("#progressBadge");
  badge.className = `update-badge ${model.kind}`;
  badge.title = model.title;
  $("#progressBadgeText").textContent = model.text;
}

function openProgress(animeId) {
  const anime = state.animes.find((item) => item.id === animeId);
  if (!anime) return;
  state.progressAnime = anime;
  resetCharacterPanel();
  state.pendingEpisodes = new Set((anime.watched_episode_keys || anime.watched_episodes || []).map(String));
  state.episodeRecordAnnotations = {};
  $("#progressCover").src = anime.cover_url;
  $("#progressCover").alt = anime.display_name;
  $("#progressTitle").textContent = anime.display_name;
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
  ensureEpisodeTitles(anime);
  refreshEpisodeRecordAnnotations(anime.id);
}

function switchDetailTab(tab) {
  const isCharacters = tab === "characters";
  $("#overviewDetailPanel").classList.toggle("hidden", isCharacters);
  $("#charactersDetailPanel").classList.toggle("hidden", !isCharacters);
  $$("[data-detail-tab]").forEach((button) => {
    const active = button.dataset.detailTab === tab;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
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
      state.progressAnime = latest;
      state.pendingEpisodes = new Set(
        (latest.watched_episode_keys || latest.watched_episodes || []).map(String),
      );
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
  $$("[data-episode-airing-type]", $("#episodeGrid")).forEach((element) => {
    element.innerHTML = episodeReleaseStatus(state.progressAnime, {type: Number(element.dataset.episodeAiringType)});
  });
}

function renderEpisodeGrid() {
  const anime = state.progressAnime;
  if (!anime) return;
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
        <section class="episode-group">
          <div class="episode-group-head">
            <strong>${escapeHtml(group.type_label)}</strong>
            <div class="episode-group-meta">
              <span class="episode-group-summary" data-episode-group-summary>${episodeGroupSummary(group, state.pendingEpisodes)}</span>
          ${Number(group.type) === 0 ? `<div class="episode-airing-info" data-episode-airing-type="0">${episodeReleaseStatus(anime, group)}</div>` : ""}
            </div>
          </div>
          <div class="episode-group-grid">
            ${group.episodes.map((episode) => {
              const key = String(episode.key);
              const watched = state.pendingEpisodes.has(key);
              const annotations = state.episodeRecordAnnotations?.[key] || [];
              return `
                <button type="button" class="episode-cell ${watched ? "watched" : ""}"
                  data-episode-key="${escapeHtml(key)}"
                  aria-pressed="${watched}"
                  ${showEpisodeTitlesOnHover() ? `title="${escapeHtml(episodeTitle(episode))}"` : ""}>
                  ${escapeHtml(episode.label)}
                  ${annotations.length ? `<span class="episode-note-mark" aria-label="本集有 ${annotations.length} 条记录">✎</span>` : ""}
                </button>
              `;
            }).join("")}
          </div>
        </section>
      `).join("")
    : `<div class="empty-state"><p>暂未取得章节。</p></div>`;
  // 标注气泡仍按格子绑定；所有点击/长按/右键交给 episode-gesture.js 的委托，
  // 扇区格数与绑定表都由设置驱动，这里不再散着写事件。
  $$(".episode-cell", $("#episodeGrid")).forEach((button) => {
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
  installEpisodeGestures($("#episodeGrid"), {
    onToggleWatched: (button) => {
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
    },
    onAction: (action, key, button) => runEpisodeGestureAction(action, key, button),
  });

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
  if (action === "play") {
    // 必须先按当前番同步离线缓存再找文件：不 await 会读到上一部番的缓存，
    // 播错内容或误报「还没下载」。
    const file =
      typeof localFileForEpisode === "function" ? await localFileForEpisode(key) : null;
    if (file && typeof playLocalFile === "function") return playLocalFile(file.id);
    toast("这一集还没下载，先用「找资源」下下来", "error");
    return;
  }
  if (action === "download" || action === "redownload") {
    if (typeof openOffline === "function") return openOffline();
  }
  // 单集详情、在文件夹中打开、删除等还没做成独立面板，统一带到离线面板，
  // 在那里能看清删的是什么、也能二次确认，不会出现「点了没反应」。
  if (typeof openOffline === "function") openOffline();
  if (typeof switchOfflineTab === "function") switchOfflineTab("local");
  toast(`${EG_ACTION_LABELS[action] || action}：请在离线面板里操作这一集`, "error");
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
  const content = window.prompt(definition.prompt, definition.initial || "");
  if (content === null) return;
  const text = content.trim();
  if (!text) {
    toast(action === "score" ? "单集评分不能为空" : "记录内容不能为空", "error");
    return;
  }
  const theme = recordThemes().find((item) => item.id === definition.id) || { id: definition.id, name: definition.label };
  const episodeLabel = episode.display_label || `${episode.type_label || "本篇"} ${episode.label}`;
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
    await renderTimeline();
    await refreshEpisodeRecordAnnotations(anime.id);
    toast(`${definition.label}已写入时间线`);
  } catch (error) {
    toast(error.message, "error");
  }
}

async function saveProgress() {
  if (!state.progressAnime) return;
  const button = $("#saveProgress");
  button.disabled = true;
  try {
    const total = Number($("#episodeCountInput").value || 0);
    if (!state.progressAnime.has_episode_list && total !== Number(state.progressAnime.episode_count || 0)) {
      const countResult = await api(
        `/api/animes/${state.progressAnime.id}/episode-count`,
        {
          method: "POST",
          body: JSON.stringify({ episode_count: total }),
        },
      );
      state.progressAnime = countResult.anime;
    }
    const result = await api(`/api/animes/${state.progressAnime.id}/progress`, {
      method: "POST",
      body: JSON.stringify({ episode_keys: [...state.pendingEpisodes] }),
    });
    const index = state.animes.findIndex((item) => item.id === result.anime.id);
    if (index >= 0) state.animes[index] = result.anime;
    commitAnimes(state.animes, { render: false });
    $("#progressModal").close();
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
    button.disabled = false;
  }
}

