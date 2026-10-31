// Kazumi-style collection control: one status button per anime plus a five-option menu.
// Every entry point (collection search, schedule detail, anime detail) renders the same
// control and writes through the single account-scoped endpoint.
const COLLECT_CARET = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
const COLLECT_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7"/></svg>';
const COLLECT_SEARCH_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/></svg>';
const COLLECT_STATUS_GLYPHS = {
  0: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20.4 4.93 13.3a4.85 4.85 0 0 1 6.86-6.86L12 6.6l.21-.16a4.85 4.85 0 0 1 6.86 6.86Z"/></svg>',
  1: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 20.4 4.93 13.3a4.85 4.85 0 0 1 6.86-6.86L12 6.6l.21-.16a4.85 4.85 0 0 1 6.86 6.86Z"/></svg>',
  2: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="m12 3.3 2.72 5.5 6.07.89-4.4 4.28 1.04 6.05L12 17.16l-5.43 2.86 1.04-6.05-4.4-4.28 6.07-.89Z"/></svg>',
  3: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.2"/><path d="M12 7.5V12l3.1 1.9"/></svg>',
  4: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4.8 12.6 4.7 4.7 9.7-10.2"/></svg>',
  5: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20.4 4.93 13.3a4.85 4.85 0 0 1 6.86-6.86l.21.16.21-.16a4.85 4.85 0 0 1 6.5 7.1"/><path d="m4.4 4 15.6 15.6"/></svg>',
};
let collectionSearchVersion = 0;

function collectionReadOnly() {
  return state.settings?.kazumi_read_only === true;
}
function collectionEditingSupported() {
  return !window.handbookOnline && !collectionReadOnly();
}
function applyCollectionEditingAvailability() {
  $("#collectionSearchButton")?.classList.toggle("hidden", !collectionEditingSupported());
  if (collectionEditingSupported()) return;
  closeCollectMenus();
  $$(".collect-slot").forEach((slot) => slot.replaceChildren());
}
function collectionStatusName(status) {
  const found = CATEGORIES.find((category) => category.id === Number(status));
  return found ? found.name : "未收藏";
}
function collectionStatusGlyph(status) {
  return COLLECT_STATUS_GLYPHS[Number(status)] || COLLECT_STATUS_GLYPHS[0];
}
function collectionControlMarkup(id, status = 0) {
  const current = Number(status) || 0;
  return `<div class="collect-control" data-collect-id="${Number(id)}" data-status="${current}"><button type="button" class="collect-trigger${current ? "" : " is-empty"}" data-collect-trigger aria-haspopup="menu" aria-expanded="false" aria-label="收藏状态：${collectionStatusName(current)}"><span class="collect-glyph" data-glyph="${current}">${collectionStatusGlyph(current)}</span><span class="collect-name">${collectionStatusName(current)}</span><span class="collect-caret" aria-hidden="true">${COLLECT_CARET}</span></button></div>`;
}
function collectionMenuMarkup(current) {
  return CATEGORIES.map((category) => {
    const active = category.id === current;
    return `<button type="button" role="menuitemradio" aria-checked="${active}" data-collect-value="${category.id}" class="collect-option${active ? " is-current" : ""}"><span class="collect-glyph" data-glyph="${category.id}">${collectionStatusGlyph(category.id)}</span><span class="collect-option-name">${escapeHtml(category.name)}</span><span class="collect-check">${COLLECT_CHECK}</span></button>`;
  }).join("");
}
function collectionAction(id, status = 0) {
  const slot = document.createElement("div");
  slot.className = "collect-slot";
  if (collectionEditingSupported()) slot.innerHTML = collectionControlMarkup(id, status);
  return slot;
}
// The menu is a fixed popover kept out of the scrolling list, so result lists and
// detail modals can never clip it. Inside an open <dialog> it must stay in that
// dialog's subtree, otherwise the modal's inert background blocks its clicks.
let collectMenuElement = null;
let collectMenuControl = null;
function collectMenuHost() {
  return document.querySelector("dialog[open]") || document.body;
}
function closeCollectMenus() {
  if (!collectMenuControl) return;
  collectMenuControl.classList.remove("is-open");
  collectMenuControl.querySelector("[data-collect-trigger]")?.setAttribute("aria-expanded", "false");
  collectMenuControl = null;
  if (collectMenuElement) collectMenuElement.hidden = true;
}
function positionCollectMenu() {
  if (!collectMenuControl || !collectMenuElement) return;
  const trigger = collectMenuControl.querySelector("[data-collect-trigger]");
  if (!trigger) {
    closeCollectMenus();
    return;
  }
  const rect = trigger.getBoundingClientRect();
  // Close once the trigger itself scrolls out of view.
  if (rect.bottom < 0 || rect.top > window.innerHeight) {
    closeCollectMenus();
    return;
  }
  const menu = collectMenuElement;
  const left = Math.max(12, Math.min(rect.left, window.innerWidth - menu.offsetWidth - 12));
  const dropUp = rect.bottom + 8 + menu.offsetHeight > window.innerHeight - 12 && rect.top - 8 - menu.offsetHeight > 12;
  menu.style.left = `${left}px`;
  menu.style.top = `${dropUp ? rect.top - menu.offsetHeight - 8 : rect.bottom + 8}px`;
}
function openCollectMenu(control, focusFirst = false) {
  closeCollectMenus();
  if (!collectMenuElement) {
    collectMenuElement = document.createElement("div");
    collectMenuElement.className = "collect-menu";
    collectMenuElement.setAttribute("role", "menu");
    collectMenuElement.hidden = true;
  }
  const host = collectMenuHost();
  if (collectMenuElement.parentElement !== host) host.append(collectMenuElement);
  const menu = collectMenuElement;
  const trigger = control.querySelector("[data-collect-trigger]");
  menu.innerHTML = collectionMenuMarkup(Number(control.dataset.status) || 0);
  menu.hidden = false;
  collectMenuControl = control;
  control.classList.add("is-open");
  trigger.setAttribute("aria-expanded", "true");
  positionCollectMenu();
  if (focusFirst) (menu.querySelector(".is-current") || menu.querySelector(".collect-option"))?.focus({ preventScroll: true });
}
function syncCollectControls(id, status) {
  const value = Number(status) || 0;
  document.querySelectorAll(`.collect-control[data-collect-id="${Number(id)}"]`).forEach((control) => {
    control.dataset.status = value;
    const trigger = control.querySelector("[data-collect-trigger]");
    trigger.setAttribute("aria-label", `收藏状态：${collectionStatusName(value)}`);
    trigger.classList.toggle("is-empty", !value);
    const glyph = trigger.querySelector(".collect-glyph");
    glyph.dataset.glyph = value;
    glyph.innerHTML = collectionStatusGlyph(value);
    trigger.querySelector(".collect-name").textContent = collectionStatusName(value);
  });
}
function updateCollectionSearchBadges() {
  $$(".collect-result[data-result-id]").forEach((card) => {
    const anime = state.animes.find((item) => item.id === Number(card.dataset.resultId));
    const cover = card.querySelector(".collect-result-cover");
    const badge = card.querySelector(".collect-result-state");
    if (!anime) {
      badge?.remove();
      return;
    }
    if (badge) {
      badge.textContent = "已收藏";
      return;
    }
    const node = document.createElement("span");
    node.className = "collect-result-state";
    node.textContent = "已收藏";
    cover?.append(node);
  });
}
async function changeCollectionStatus(id, status) {
  const result = await api("/api/collection-status", { method: "POST", body: JSON.stringify({ anime_id: Number(id), status: Number(status) }) });
  state.animes = result.animes;
  if (result.stats) {
    state.stats = result.stats;
    renderStats();
  }
  renderCollection();
  renderTabs();
  if (state.progressAnime?.id === Number(id)) {
    state.progressAnime = state.animes.find((anime) => anime.id === Number(id)) || state.progressAnime;
  }
  syncCollectControls(id, result.anime?.collection_type ?? status);
  updateCollectionSearchBadges();
  closeCollectMenus();
  toast(window.handbookOnline ? "收藏已更新" : "收藏已更新，已加入 Kazumi 待写回队列");
  return result.anime;
}
async function applyCollectStatus(control, status) {
  const id = Number(control.dataset.collectId);
  const target = Number(status);
  closeCollectMenus();
  if (Number(control.dataset.status) === target) return;
  control.setAttribute("aria-busy", "true");
  try {
    await changeCollectionStatus(id, target);
  } catch (error) {
    toast(error.message, "error");
  } finally {
    control.removeAttribute("aria-busy");
    control.querySelector("[data-collect-trigger]")?.focus({ preventScroll: true });
  }
}

document.addEventListener("click", (event) => {
  const trigger = event.target.closest("[data-collect-trigger]");
  if (trigger) {
    const control = trigger.closest(".collect-control");
    // event.detail === 0 means the button was activated from the keyboard.
    if (control === collectMenuControl) closeCollectMenus();
    else if (control) openCollectMenu(control, event.detail === 0);
    return;
  }
  const option = event.target.closest("[data-collect-value]");
  if (option && collectMenuControl) {
    applyCollectStatus(collectMenuControl, option.dataset.collectValue);
    return;
  }
  if (!event.target.closest(".collect-menu")) closeCollectMenus();
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || !collectMenuControl) return;
  const control = collectMenuControl;
  event.preventDefault();
  event.stopPropagation();
  closeCollectMenus();
  control.querySelector("[data-collect-trigger]")?.focus({ preventScroll: true });
}, true);
window.addEventListener("resize", () => positionCollectMenu());
window.addEventListener("scroll", () => positionCollectMenu(), true);
document.addEventListener("close", () => closeCollectMenus(), true);

function collectionSearchSkeleton() {
  return `<div class="collect-card-grid">${Array.from({ length: 3 }, () => '<div class="collect-result collect-result-skeleton" aria-hidden="true"><div class="collect-result-cover"></div><span class="collect-skeleton-line"></span><span class="collect-skeleton-line short"></span><span class="collect-skeleton-line"></span></div>').join("")}</div>`;
}
function collectionSearchCard(row) {
  const anime = state.animes.find((item) => item.id === Number(row.id));
  const title = row.name_cn || row.name || "未命名条目";
  const original = row.name && row.name !== title ? row.name : "";
  const score = Number(row.rating?.score);
  const votes = Number(row.rating?.total);
  const cover = row.images?.large || row.images?.common || row.images?.medium || "";
  const facts = [
    row.date ? String(row.date).slice(0, 4) : "",
    Number(row.eps) > 0 ? `共 ${Number(row.eps)} 话` : "",
    votes > 0 ? `${votes >= 10000 ? `${(votes / 10000).toFixed(1)} 万` : votes} 人评分` : "",
  ].filter(Boolean).join(" · ");
  return `<article class="collect-result" data-result-id="${Number(row.id)}" role="listitem">
  <div class="collect-result-cover${cover ? "" : " is-empty"}">${cover ? `<img src="${escapeHtml(cover)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.parentElement.classList.add('is-empty');this.remove()" />` : ""}${score > 0 ? `<span class="collect-result-score">${score.toFixed(1)}</span>` : ""}${anime ? '<span class="collect-result-state">已收藏</span>' : ""}</div>
  <h3 class="collect-result-title">${escapeHtml(title)}</h3>
  ${original ? `<p class="collect-result-sub">${escapeHtml(original)}</p>` : ""}
  <p class="collect-result-facts">${escapeHtml(facts)}</p>
  <div class="collect-result-action">${collectionControlMarkup(row.id, anime?.collection_type || 0)}</div>
</article>`;
}
// Bangumi tokenises an unquoted keyword, so "少女前线" also returns 少女革命 and the
// like. Keep the exact title matches on top and tuck the token-only matches away.
function collectionSearchPhrase(keyword) {
  return String(keyword || "").toLowerCase().replace(/\s+/g, "");
}
function collectionSearchTitleHit(row, phrase) {
  if (!phrase) return true;
  return [row.name_cn, row.name]
    .filter(Boolean)
    .some((title) => String(title).toLowerCase().replace(/\s+/g, "").includes(phrase));
}
// Bangumi 的搜索接口只有 match/heat/rank/score 四种排序，没有按放送时间；
// 这里对返回的这一页结果再做一次本地排序，五种排序都能立刻生效。
function collectionSearchSortRows(items, sort) {
  const rows = [...items];
  const rank = (row) => Number(row.rating?.rank) || 0;
  const score = (row) => Number(row.rating?.score) || 0;
  const heat = (row) => Object.values(row.collection || {}).reduce((sum, value) => sum + (Number(value) || 0), 0);
  // 按放送时间从早到晚；没有日期的排在最后。
  if (sort === "time") {
    return rows.sort((a, b) => {
      const left = String(a.date || "");
      const right = String(b.date || "");
      if (!left || !right) return (left ? 0 : 1) - (right ? 0 : 1);
      return left.localeCompare(right);
    });
  }
  if (sort === "score") return rows.sort((a, b) => score(b) - score(a));
  if (sort === "rank") return rows.sort((a, b) => (rank(a) || 1e9) - (rank(b) || 1e9));
  if (sort === "heat") return rows.sort((a, b) => heat(b) - heat(a));
  return rows;
}
function renderCollectionSearchResults(result, keyword, sort) {
  const results = $("#collectionSearchResults");
  const items = collectionSearchSortRows(
    (result.items || []).filter((row) => Number(row.id) > 0),
    sort || result.sort || "match",
  );
  if (!items.length) {
    results.innerHTML = `<div class="collect-search-empty">${COLLECT_SEARCH_ICON}<strong>没有找到匹配的动画条目</strong><p>换一个名称，或用简体、日文原名再试一次。</p></div>`;
    return;
  }
  const phrase = collectionSearchPhrase(keyword);
  const exact = items.filter((row) => collectionSearchTitleHit(row, phrase));
  const related = exact.length && exact.length < items.length ? items.filter((row) => !collectionSearchTitleHit(row, phrase)) : [];
  const cardGrid = (rows) => `<div class="collect-card-grid">${rows.map(collectionSearchCard).join("")}</div>`;
  results.innerHTML = cardGrid(exact.length ? exact : items) +
    (related.length ? `<div class="collect-more"><button type="button" class="collect-more-toggle" aria-expanded="false">显示其他 ${related.length} 条相关结果<small>Bangumi 会把关键词拆开匹配，可能只命中其中一个词</small></button><div class="collect-more-list" role="list" hidden>${cardGrid(related)}</div></div>` : "");
  const toggle = results.querySelector(".collect-more-toggle");
  if (toggle) {
    toggle.onclick = () => {
      const list = results.querySelector(".collect-more-list");
      const open = list.hidden;
      list.hidden = !open;
      toggle.setAttribute("aria-expanded", String(open));
      toggle.firstChild.textContent = open ? `收起其他 ${related.length} 条相关结果` : `显示其他 ${related.length} 条相关结果`;
    };
  }
}
if ($("#collectionSearchButton")) {
  applyCollectionEditingAvailability();
  $("#collectionSearchButton").onclick = () => {
    $("#collectionSearchModal").showModal();
    $("#collectionSearchQuery").focus();
  };
  $("#collectionSearchClose").onclick = () => {
    $("#collectionSearchModal").close();
    collectionSearchVersion++;
  };
  $("#collectionSearchForm").onsubmit = async (event) => {
    event.preventDefault();
    const version = ++collectionSearchVersion;
    const results = $("#collectionSearchResults");
    const button = $("#collectionSearchSubmit");
    const query = $("#collectionSearchQuery").value;
    const sort = $("#collectionSearchSort")?.value || "match";
    button.disabled = true;
    results.innerHTML = collectionSearchSkeleton();
    results.setAttribute("aria-busy", "true");
    try {
      const result = await api(`/api/collection-search?q=${encodeURIComponent(query)}&sort=${encodeURIComponent(sort)}`);
      if (version !== collectionSearchVersion || !$("#collectionSearchModal").open) return;
      renderCollectionSearchResults(result, query, sort);
    } catch (error) {
      if (version === collectionSearchVersion) results.innerHTML = `<div class="collect-search-empty">${COLLECT_SEARCH_ICON}<strong>搜索没有完成</strong><p>${escapeHtml(error.message)}</p></div>`;
    } finally {
      results.removeAttribute("aria-busy");
      button.disabled = false;
    }
  };
  $("#collectionSearchSort")?.addEventListener("change", () => {
    if (!$("#collectionSearchModal").open || !$("#collectionSearchQuery").value.trim()) return;
    $("#collectionSearchForm").requestSubmit();
  });
}
$("#collectionOutboxButton").onclick = async () => {
  try {
    const result = await api("/api/collection-outbox");
    $("#collectionOutboxStatus").textContent = result.items.length ? result.items.map((item) => `#${item.anime_id}：${item.error || "等待 Kazumi 关闭后写回"}`).join("；") : "没有待同步任务";
  } catch (error) {
    toast(error.message, "error");
  }
};
