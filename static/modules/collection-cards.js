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

// One delegated controller per grid; keyed DOM updates preserve unaffected
// cards, keyboard focus and already-decoded covers when one record changes.
const HandbookCollectionGrid = (() => {
  const bound = new WeakSet(), markup = new WeakMap();
  function bind(grid) {
    if (bound.has(grid)) return;
    bound.add(grid);
    let dragged = null;
    const cardAt = (event) => {
      const card = event.target.closest?.(".anime-card");
      return card && card.parentElement === grid ? card : null;
    };
    grid.addEventListener("click", (event) => {
      const card = cardAt(event);
      if (!card) return;
      const move = event.target.closest?.(".card-move-button");
      if (move) { event.stopPropagation(); openCustomMoveMenu(Number(move.dataset.animeId), move); }
      else openProgress(Number(card.dataset.animeId));
    });
    grid.addEventListener("keydown", (event) => {
      const card = cardAt(event);
      if (card && event.target === card && ["Enter", " "].includes(event.key)) {
        event.preventDefault(); openProgress(Number(card.dataset.animeId));
      }
    });
    grid.addEventListener("dragstart", (event) => {
      const card = cardAt(event);
      if (!card || collectionSortMode() !== "custom") return;
      dragged = card; card.classList.add("dragging"); event.dataTransfer.effectAllowed = "move";
    });
    grid.addEventListener("dragend", () => {
      dragged?.classList.remove("dragging"); dragged = null;
      grid.querySelectorAll(".drag-over").forEach(card => card.classList.remove("drag-over"));
    });
    grid.addEventListener("dragover", (event) => {
      const card = cardAt(event);
      if (!dragged || !card || dragged === card) return;
      event.preventDefault(); card.classList.add("drag-over");
    });
    grid.addEventListener("dragleave", (event) => {
      const card = cardAt(event);
      if (card && !card.contains(event.relatedTarget)) card.classList.remove("drag-over");
    });
    grid.addEventListener("drop", async (event) => {
      const card = cardAt(event);
      if (!card || !dragged || dragged === card || collectionSortMode() !== "custom") return;
      event.preventDefault(); card.classList.remove("drag-over");
      const bounds = card.getBoundingClientRect();
      grid.insertBefore(dragged, event.clientY < bounds.top + bounds.height / 2 ? card : card.nextSibling);
      try {
        const animeIds = [...grid.querySelectorAll(".anime-card")].map(item => Number(item.dataset.animeId));
        const payload = await api("/api/animes/custom-sort", {method:"POST",body:JSON.stringify({anime_ids:animeIds})});
        state.animes = payload.animes || state.animes;
      } catch (error) { toast(error.message,"error"); renderCollection(); }
    });
  }
  function update(grid, items) {
    bind(grid);
    const wanted = new Set(items.map(item => String(item.id)));
    const old = new Map([...grid.children].map(node => [node.dataset.animeId, node]));
    for (const [id, node] of old) if (!wanted.has(id)) node.remove();
    let cursor = grid.firstElementChild;
    const template = document.createElement("template");
    for (const item of items) {
      const html = animeCard(item), id = String(item.id);
      let node = old.get(id);
      if (!node || markup.get(node) !== html) {
        template.innerHTML = html.trim();
        const fresh = template.content.firstElementChild;
        markup.set(fresh, html);
        if (node) { if (cursor === node) cursor = fresh; node.replaceWith(fresh); }
        node = fresh;
      }
      // Reusing a card must not permanently hide a cover that failed while
      // offline. Retry failed images as the old full rebuild did; retain good ones.
      const image = node.querySelector("img");
      if (image?.style.display === "none" && image.complete && navigator.onLine !== false) {
        image.style.display = "";
        image.src = image.getAttribute("src");
      }
      if (node === cursor) cursor = cursor.nextElementSibling;
      else grid.insertBefore(node, cursor);
    }
  }
  return {update};
})();

function renderCollection() {
  ensureVisibleCollection();
  const items = filteredAnimes();
  HandbookCollectionGrid.update($("#animeGrid"), items);
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
  const ratingVisibility = state.settings.category_rating_visibility || {};
  $("#collectionRatingToggle").checked = ratingVisibility[activeVisibilityKey()] !== false;
  $("#progressBarToggle").checked = showProgressBar();
  applyCollectionToolbarVisibility();
  updateSortPicker();
}

