function applyCharacterTabVisibility() {
  const enabled = enabledSetting("show_character_tab");
  $("#charactersDetailTab").classList.toggle("hidden", !enabled);
  if (!enabled && !$("#charactersDetailPanel").classList.contains("hidden")) {
    switchDetailTab("overview");
  }
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
  $("#progressCategory").textContent = anime.category_name;
  $("#progressAirDate").textContent = anime.air_date || "";
  $("#progressMetaSeparator").classList.toggle("hidden", !anime.air_date);
  const mirrorLink = $("#bgmMirrorLink");
  const siteBase = String(state.settings.bgm_site_base || "https://bgm.tv").replace(/\/+$/, "");
  mirrorLink.href = `${siteBase}/subject/${anime.id}`;
  mirrorLink.textContent = `Bangumi #${anime.id} ↗`;
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
    state.animes = state.animes.map((item) => item.id === latest.id ? latest : item);
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
          await api(`/api/events/${comment.id}`, {
            method: "PATCH",
            body: JSON.stringify({
              content,
              anime_id: anime.id,
              theme: "anime_comment",
              raw_directives: recordTextFormat({ theme: theme.name, anime: anime.display_name, content }),
            }),
          });
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
      if (state.progressAnime?.id === result.anime.id) state.progressAnime = result.anime;
      if (state.moveAnime?.id === result.anime.id) state.moveAnime = result.anime;
    }
    renderTabs();
    renderCollection();
    closeCustomMoveMenu();
    toast(checked ? "已加入自定义收藏夹" : "已移出自定义收藏夹");
  } catch (error) {
    toast(error.message, "error");
    closeCustomMoveMenu();
  }
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
    ? state.custom_collections.map((collection) => `
        <label class="move-menu-item">
          <input
            type="checkbox"
            class="move-menu-check"
            data-collection-id="${collection.id}"
            ${membership.has(Number(collection.id)) ? "checked" : ""}
          />
          <span>${escapeHtml(collection.name)}</span>
        </label>
      `).join("")
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
              ${episodeReleaseStatus(anime, group)}
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
  $$(".episode-cell", $("#episodeGrid")).forEach((button) => {
    const episode = episodes.find((item) => String(item.key) === String(button.dataset.episodeKey));
    const annotations = state.episodeRecordAnnotations?.[String(button.dataset.episodeKey)] || [];
    let pressTimer = null;
    let quickMenuOpen = false;
    let suppressClick = false;
    const stopPressTimer = () => {
      if (pressTimer) window.clearTimeout(pressTimer);
      pressTimer = null;
    };
    const closeQuickMenu = () => {
      const menu = document.querySelector("#episodeQuickMenu");
      if (!menu) return;
      menu.classList.remove("visible");
      menu.classList.add("closing");
      window.setTimeout(() => menu.remove(), 150);
      quickMenuOpen = false;
    };
    const closeEpisodeAnnotation = () => {
      $("#episodeAnnotationPopover")?.remove();
    };
    const openEpisodeAnnotation = () => {
      if (!annotations.length) return;
      closeEpisodeAnnotation();
      const rect = button.getBoundingClientRect();
      const popover = document.createElement("aside");
      popover.id = "episodeAnnotationPopover";
      popover.className = "episode-annotation-popover";
      popover.innerHTML = episodeAnnotationMarkup(annotations);
      $("#progressModal").append(popover);
      const width = Math.min(260, window.innerWidth - 24);
      const left = Math.max(12, Math.min(window.innerWidth - width - 12, rect.right - width));
      const placeBelow = rect.top < 180;
      popover.style.width = `${width}px`;
      popover.style.left = `${left}px`;
      const height = popover.getBoundingClientRect().height;
      popover.style.top = `${placeBelow ? rect.bottom + 10 : Math.max(12, rect.top - height - 10)}px`;
    };
    const updateQuickTarget = (event) => {
      const menu = document.querySelector("#episodeQuickMenu");
      if (!menu) return;
      const originX = Number(menu.dataset.originX);
      const originY = Number(menu.dataset.originY);
      const deltaX = event.clientX - originX;
      const deltaY = event.clientY - originY;
      const dragDistance = Math.min(112, Math.hypot(deltaX, deltaY));
      menu.style.setProperty("--drag-x", `${Math.max(-110, Math.min(110, deltaX))}px`);
      menu.style.setProperty("--drag-y", `${Math.max(-110, Math.min(110, deltaY))}px`);
      menu.style.setProperty("--drag-distance", `${dragDistance}px`);
      menu.style.setProperty("--drag-angle", `${Math.atan2(deltaY, deltaX)}rad`);
      menu.classList.toggle("dragging", dragDistance > 10);
      const choices = {
        score: [0, -94], op: [82, -54], ed: [82, 54], review: [0, 98],
      };
      let target = "";
      let distance = Infinity;
      for (const [name, [x, y]] of Object.entries(choices)) {
        if (!quickRecordActionEnabled(name)) continue;
        const next = Math.hypot(event.clientX - (originX + x), event.clientY - (originY + y));
        if (next < distance) { distance = next; target = name; }
      }
      menu.querySelectorAll("[data-episode-action]").forEach((item) => item.classList.toggle("active", item.dataset.episodeAction === target && distance < 62));
    };
    const openQuickMenu = (event) => {
      const rect = button.getBoundingClientRect();
      const originX = rect.left + rect.width / 2;
      const originY = rect.top + rect.height / 2;
      const menu = document.createElement("div");
      menu.id = "episodeQuickMenu";
      menu.className = "episode-quick-menu";
      menu.dataset.originX = String(originX);
      menu.dataset.originY = String(originY);
      menu.style.setProperty("--quick-x", `${originX}px`);
      menu.style.setProperty("--quick-y", `${originY}px`);
      menu.innerHTML = `
        <span class="episode-quick-halo"></span>
        <span class="episode-quick-trail"></span>
        <span class="episode-quick-cursor"></span>
        ${showEpisodeRatingRecord() ? '<span class="episode-quick-action score" data-episode-action="score">评分</span>' : ""}
        ${showOpedRecord() ? '<span class="episode-quick-action op" data-episode-action="op">OP</span><span class="episode-quick-action ed" data-episode-action="ed">ED</span>' : ""}
        ${showEpisodeReviewRecord() ? '<span class="episode-quick-action review" data-episode-action="review">评价</span>' : ""}
      `;
      $("#progressModal").append(menu);
      requestAnimationFrame(() => menu.classList.add("visible"));
      quickMenuOpen = true;
      updateQuickTarget(event);
    };
    button.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || !episode || !hasEnabledQuickRecordActions()) return;
      suppressClick = false;
      button.setPointerCapture?.(event.pointerId);
      pressTimer = window.setTimeout(() => openQuickMenu(event), 420);
    });
    if (annotations.length) {
      button.addEventListener("pointerenter", openEpisodeAnnotation);
      button.addEventListener("pointerleave", closeEpisodeAnnotation);
      button.addEventListener("focusin", openEpisodeAnnotation);
      button.addEventListener("focusout", closeEpisodeAnnotation);
    }
    button.addEventListener("pointermove", (event) => {
      if (quickMenuOpen) updateQuickTarget(event);
    });
    const finishQuickAction = async (event) => {
      stopPressTimer();
      if (!quickMenuOpen || !episode) return;
      suppressClick = true;
      updateQuickTarget(event);
      const target = document.querySelector("#episodeQuickMenu .episode-quick-action.active")?.dataset.episodeAction;
      closeQuickMenu();
      if (target) await createEpisodeQuickRecord(episode, target);
    };
    button.addEventListener("pointerup", finishQuickAction);
    button.addEventListener("pointercancel", () => { stopPressTimer(); closeQuickMenu(); });
    button.addEventListener("click", () => {
      if (suppressClick) { suppressClick = false; return; }
      const episode = String(button.dataset.episodeKey);
      if (state.pendingEpisodes.has(episode)) state.pendingEpisodes.delete(episode);
      else state.pendingEpisodes.add(episode);
      button.classList.toggle("watched");
      button.setAttribute("aria-pressed", String(state.pendingEpisodes.has(episode)));
      $$(".episode-group").forEach((section) => {
        const keys = $$(".episode-cell", section).map((item) => item.dataset.episodeKey);
        const watched = keys.filter((key) => state.pendingEpisodes.has(String(key))).length;
        $("[data-episode-group-summary]", section).textContent = `已看 ${watched} / ${keys.length}`;
      });
    });
  });
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

