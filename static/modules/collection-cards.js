function animeCard(anime) {
  const total = episodeTotal(anime);
  const watched = Number(anime.watched_count || 0);
  const percent = total ? Math.min(100, (watched / total) * 100) : 0;
  const moveButton = showCustomMoveButton()
    ? `<button type="button" class="card-move-button" data-action="custom-menu" data-anime-id="${anime.id}">移入</button>`
    : "";
  const showPersonal = state.settings.collection_rating_source === "personal";
  const score = showPersonal
    ? String(anime.personal_rating_text || (anime.personal_score ? Number(anime.personal_score).toFixed(1) : "")).trim()
    : (Number.isFinite(Number(anime.bgm_score)) && Number(anime.bgm_score) > 0 ? Number(anime.bgm_score).toFixed(1) : "");
  const rating = showCollectionBgmRating() && score
    ? `<span class="poster-score">${escapeHtml(score)}</span>`
    : "";
  return `
    <article class="anime-card" data-anime-id="${anime.id}" role="button" tabindex="0" draggable="${collectionSortMode() === "custom"}" aria-label="记录《${escapeHtml(anime.display_name)}》的观看进度">
      <div class="poster-wrap">
        <img src="${anime.cover_url}" alt="${escapeHtml(anime.display_name)}" loading="lazy"
          onerror="this.style.display='none'" />
        ${rating}
      </div>
      <div class="card-body">
        <div class="card-title-row">
          <div class="card-title">${escapeHtml(anime.display_name)}</div>
          ${moveButton}
        </div>
        ${showProgressBar() ? `
          <div class="progress-track" aria-label="已看 ${watched} 集">
            <div class="progress-fill" style="width:${percent}%"></div>
          </div>
          <div class="card-progress">
            <span>已看 ${watched}</span>
            <span>${total ? `${watched} / ${total}` : "待补全章节"}</span>
          </div>
        ` : ""}
      </div>
    </article>
  `;
}

function renderCollection() {
  ensureVisibleCollection();
  const items = filteredAnimes();
  $("#animeGrid").innerHTML = items.map(animeCard).join("");
  $("#animeGrid").classList.toggle("custom-sort-mode", collectionSortMode() === "custom");
  $("#animeGrid").classList.toggle("hidden", items.length === 0);
  $("#collectionEmpty").classList.toggle("hidden", items.length !== 0);
  $("#emptyMessage").textContent = state.collectionKind === "custom"
    ? "这个自定义收藏夹还没有番剧。在原收藏夹的番名旁点击“移入”即可添加。"
    : state.animes.length
      ? "当前分类或搜索条件下没有番剧。"
      : state.sync.last_error ||
        "可以搜索添加番剧，也可以从本机 Kazumi 导入收藏。";
  $("#emptySyncButton").classList.toggle("hidden", state.collectionKind === "custom");
  $$(".anime-card").forEach((card) => {
    card.addEventListener("click", () => openProgress(Number(card.dataset.animeId)));
    card.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openProgress(Number(card.dataset.animeId));
      }
    });
  });
  $$(".card-move-button").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      openCustomMoveMenu(Number(button.dataset.animeId), button);
    });
  });
  bindCustomCardSorting();
  const ratingVisibility = state.settings.category_rating_visibility || {};
  $("#collectionRatingToggle").checked = ratingVisibility[activeVisibilityKey()] !== false;
  $("#progressBarToggle").checked = showProgressBar();
  applyCollectionToolbarVisibility();
  updateSortPicker();
}

function bindCustomCardSorting() {
  if (collectionSortMode() !== "custom") return;
  let dragged = null;
  $$("#animeGrid .anime-card").forEach((card) => {
    card.addEventListener("dragstart", (event) => {
      dragged = card;
      card.classList.add("dragging");
      event.dataTransfer.effectAllowed = "move";
    });
    card.addEventListener("dragend", () => {
      card.classList.remove("dragging");
      dragged = null;
      $$("#animeGrid .anime-card").forEach((item) => item.classList.remove("drag-over"));
    });
    card.addEventListener("dragover", (event) => {
      if (!dragged || dragged === card) return;
      event.preventDefault();
      card.classList.add("drag-over");
    });
    card.addEventListener("dragleave", () => card.classList.remove("drag-over"));
    card.addEventListener("drop", async (event) => {
      event.preventDefault();
      card.classList.remove("drag-over");
      if (!dragged || dragged === card) return;
      const bounds = card.getBoundingClientRect();
      card.parentElement.insertBefore(dragged, event.clientY < bounds.top + bounds.height / 2 ? card : card.nextSibling);
      try {
        const animeIds = $$("#animeGrid .anime-card").map((item) => Number(item.dataset.animeId));
        const payload = await api("/api/animes/custom-sort", {
          method: "POST",
          body: JSON.stringify({ anime_ids: animeIds }),
        });
        state.animes = payload.animes || state.animes;
      } catch (error) {
        toast(error.message, "error");
        renderCollection();
      }
    });
  });
}

