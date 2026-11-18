function rankingTitle(item) {
  return item.name_cn || item.name || "未命名动漫";
}

function rankingPeriodOptions() {
  const years = availableSeasonYears();
  return [`<option value="all">全部时间</option>`, ...years.map((year) => `<option value="year:${year}">${year} 全年</option>`), ...years.flatMap((year) => SEASONS.map((season) => `<option value="season:${year}-${season.month}">${year} ${season.name}</option>`))].join("");
}

function rankingItemsByTier(board) {
  const groups = new Map([...board.tiers.map(tier => [String(tier.id), []]), ["unranked", []]]);
  const remaining = new Map(board.items.map(item => [Number(item.anime_id), item]));
  const draft = state.rankingDirtyBoards.get(board.id);
  // Keep draft order for items that still exist. Newly imported items and new
  // tiers come from the server, and a deleted item must not reappear.
  for (const [tier, items] of groups) {
    for (const id of draft?.[tier] || []) {
      if (remaining.has(id)) items.push(remaining.get(id));
      remaining.delete(id);
    }
  }
  for (const item of remaining.values()) {
    (groups.get(String(item.tier_id)) || groups.get("unranked")).push(item);
  }
  return groups;
}

function renderRanking() {
  const list = $("#rankingBoardList");
  list.innerHTML = state.ranking_boards.length
    ? state.ranking_boards.map((board) => `<button type="button" class="ranking-board-button ${state.rankingBoard?.id === board.id ? "active" : ""}" data-board-id="${board.id}"><strong>${escapeHtml(board.name)}${state.rankingDirtyBoards.has(board.id) ? '<i class="ranking-dirty-dot"></i>' : ''}</strong><small>${board.item_count || 0} 部</small></button>`).join("")
    : `<div class="ranking-empty">暂无数据<br/><small>新建一个排名表单，开始整理你的收藏。</small></div>`;
  $$("[data-board-id]", list).forEach((button) => button.addEventListener("click", () => loadRankingBoard(Number(button.dataset.boardId))));
  const board = state.rankingBoard;
  if (!board) {
    $("#rankingWorkspace").innerHTML = `<div class="empty-state ranking-workspace-empty"><div class="empty-mark">榜</div><h2>暂无排名表单</h2><p>可以建立多个表单，分别排行不同主题的动漫。</p><button class="primary-button" data-create-ranking>新增排名表单</button></div>`;
    $("[data-create-ranking]")?.addEventListener("click", createRankingBoard);
    return;
  }
  const groups = rankingItemsByTier(board);
  const itemsFor = (tierId) => groups.get(String(tierId));
  const cards = (items) => items.map((item) => `<button type="button" draggable="true" class="ranking-anime-card" data-ranking-anime="${item.anime_id}" data-title="${escapeHtml(rankingTitle(item))}" aria-label="${escapeHtml(rankingTitle(item))}"><img src="/api/covers/${item.anime_id}" alt="" /></button>`).join("");
  $("#rankingWorkspace").innerHTML = `
    <div class="ranking-heading"><h2>${escapeHtml(board.name)}</h2><span><button class="secondary-button compact-button" id="renameRankingBoard">重命名</button><button class="secondary-button compact-button" id="saveRankingTemplate">保存为模板</button><button class="secondary-button compact-button" id="addRankingTier">新增等级</button><button class="secondary-button compact-button ${state.rankingDirtyBoards.has(board.id) ? '' : 'hidden'}" id="saveRankingBoard">保存</button><button class="text-button danger" id="deleteRankingBoard">删除</button></span></div>
    <div class="ranking-tiers">${board.tiers.map((tier) => { const tierItems=itemsFor(tier.id); return `<section class="ranking-tier"><input class="ranking-tier-name" data-tier-name="${tier.id}" value="${escapeHtml(tier.name)}" aria-label="等级名称" /><div class="ranking-dropzone" data-tier-id="${tier.id}">${cards(tierItems)}${tierItems.length ? "" : '<span class="ranking-drop-hint">拖放封面到这里</span>'}</div></section>`; }).join("")}</div>
    <section class="ranking-unranked"><div><strong>待排名</strong><span>${itemsFor("unranked").length} 部</span></div><div class="ranking-dropzone" data-tier-id="unranked">${cards(itemsFor("unranked"))}${itemsFor("unranked").length ? "" : '<span class="ranking-drop-hint">从这里拖到上方等级</span>'}</div></section>
    <section class="ranking-import"><h3>导入收藏夹动漫</h3><div class="ranking-import-controls"><select id="rankingImportCategory"><option value="all">全部收藏夹</option>${CATEGORIES.map((item) => `<option value="${item.id}">${item.name}</option>`).join("")}</select><select id="rankingImportPeriod">${rankingPeriodOptions()}</select><input id="rankingScoreMin" type="number" min="0" max="10" step="0.1" placeholder="最低评分" /><input id="rankingScoreMax" type="number" min="0" max="10" step="0.1" placeholder="最高评分" /><button class="primary-button" id="rankingImportButton">导入符合条件的动漫</button></div></section>`;
  $("#rankingWorkspace").insertAdjacentHTML("beforeend", '<div id="rankingTrashDrop" class="ranking-trash-drop hidden" aria-hidden="true"><span>🗑</span><small>拖到这里删除</small></div>');
  bindRankingInteractions();
  $("#rankingWorkspace").classList.toggle("ranking-hover-titles", showRankingHoverTitles());
  $("#rankingWorkspace").style.setProperty("--ranking-hover-delay", `${rankingHoverDelay()}s`);
}

let rankingBoardRequest = 0;
let rankingWritePending = false;

function resetRankingWorkspace() {
  ++rankingBoardRequest;
  state.rankingBoard = null;
  state.rankingDirtyBoards.clear();
}

async function loadRankingBoard(boardId) {
  if (rankingWritePending) { toast("正在保存榜单，请稍候"); return; }
  const request = ++rankingBoardRequest;
  try {
    const result = await api(`/api/rankings/${boardId}`);
    if (request !== rankingBoardRequest) return;
    state.rankingBoard = result.board;
    renderRanking();
  } catch (error) {
    if (request === rankingBoardRequest) toast(error.message, "error");
  }
}

async function createRankingBoard() {
  if (rankingWritePending) return;
  const name = prompt("请输入排名表单名称", "我的动漫排名");
  if (name === null) return;
  const templates = state.ranking_templates || [];
  const choices = templates.map((template, index) => `${index + 1}. ${template.name}（${template.tiers.join(" / ")}）`).join("\n");
  const choice = prompt(`选择模板编号（默认 1）：\n${choices}`, "1");
  if (choice === null) return;
  const template = templates[Math.max(0, Number(choice || 1) - 1)] || templates[0];
  await writeRanking("/api/rankings", "POST", {name, template_id: template?.id || null});
}

function collectRankingPlacements() {
  return Object.fromEntries($$(".ranking-dropzone").map((zone) => [zone.dataset.tierId, $$("[data-ranking-anime]", zone).map((card) => Number(card.dataset.rankingAnime))]));
}

async function writeRanking(path, method, body, onSaved) {
  if (rankingWritePending) { toast("正在保存榜单，请稍候再试"); return; }
  rankingWritePending = true;
  const request = ++rankingBoardRequest;
  try {
    const result = await api(path, {method, ...(body ? {body: JSON.stringify(body)} : {})});
    if (request !== rankingBoardRequest) return;
    state.ranking_boards = result.boards;
    state.rankingBoard = result.board || null;
    onSaved?.();
    renderRanking();
  } catch (error) {
    toast(error.message, "error");
  } finally {
    rankingWritePending = false;
  }
}

function bindRankingInteractions() {
  $("#addRankingTier").addEventListener("click", () => writeRanking(`/api/rankings/${state.rankingBoard.id}/tiers`, "POST", {name:"新等级"}));
  $("#renameRankingBoard").addEventListener("click", renameRankingBoard);
  $("#saveRankingTemplate").addEventListener("click", saveRankingTemplate);
  $$("[data-tier-name]").forEach(input => input.addEventListener("change", () =>
    writeRanking(`/api/rankings/${state.rankingBoard.id}/tiers/${input.dataset.tierName}`, "PATCH", {name: input.value})));
  $("#rankingImportButton").addEventListener("click", () => {
    const category = $("#rankingImportCategory").value;
    const period = $("#rankingImportPeriod").value;
    const low = $("#rankingScoreMin").value;
    const high = $("#rankingScoreMax").value;
    const ids = state.animes.filter(anime => {
      if (category !== "all" && Number(anime.collection_type) !== Number(category)) return false;
      if (period.startsWith("year:") && !String(anime.air_date || "").startsWith(period.slice(5))) return false;
      if (period.startsWith("season:") && animeSeasonKey(anime) !== period.slice(7)) return false;
      return (low === "" || Number(anime.bgm_score) >= Number(low))
        && (high === "" || Number(anime.bgm_score) <= Number(high));
    }).map(anime => anime.id);
    return writeRanking(`/api/rankings/${state.rankingBoard.id}/import`, "POST", {anime_ids: ids},
      () => toast(`已导入 ${ids.length} 部动漫`));
  });
  $("#saveRankingBoard").addEventListener("click", saveRankingPlacements);
  $("#deleteRankingBoard").addEventListener("click", deleteRankingBoard);
  let dragged=null;
  let canDeleteDraggedAnime = false;
  const trash = $("#rankingTrashDrop");
  const hideTrash = () => { canDeleteDraggedAnime = false; trash?.classList.add("hidden"); };
  $$("[data-ranking-anime]").forEach((card)=>{ card.addEventListener("dragstart",()=>{dragged=card; canDeleteDraggedAnime = card.closest('[data-tier-id="unranked"]') !== null; trash?.classList.toggle("hidden", !canDeleteDraggedAnime); card.classList.add("dragging");}); card.addEventListener("dragend",()=>{ card.classList.remove("dragging"); hideTrash(); }); });
  trash?.addEventListener("dragover", (event) => { if (canDeleteDraggedAnime) { event.preventDefault(); trash.classList.add("active"); } });
  trash?.addEventListener("dragleave", () => trash.classList.remove("active"));
  trash?.addEventListener("drop", async (event) => {
    event.preventDefault();
    const animeId = Number(dragged?.dataset.rankingAnime);
    const canDelete = canDeleteDraggedAnime;
    trash.classList.remove("active"); hideTrash();
    if (!canDelete || !animeId) return;
    await writeRanking(`/api/rankings/${state.rankingBoard.id}/items/${animeId}`, "DELETE", null,
      () => toast("已从待排名区删除"));
  });
  let preview = null;
  const clearPreview = () => { preview?.remove(); preview = null; };
  const updatePreview = (zone, event) => {
    if (!dragged) return;
    if (!preview) { preview = document.createElement("span"); preview.className = "ranking-drop-preview"; }
    const cards = $$("[data-ranking-anime]", zone).filter((card) => card !== dragged);
    const target = cards.find((card) => { const rect = card.getBoundingClientRect(); return event.clientY < rect.top + rect.height / 2 || (event.clientY < rect.bottom && event.clientX < rect.left + rect.width / 2); });
    zone.insertBefore(preview, target || $(".ranking-drop-hint", zone));
  };
  $$('[data-ranking-anime]').forEach((card) => card.addEventListener("dragend", clearPreview));
  $$(".ranking-dropzone").forEach((zone) => {
    zone.addEventListener("dragover", (event) => { event.preventDefault(); updatePreview(zone, event); }, true);
    zone.addEventListener("drop", (event) => {
      event.preventDefault(); event.stopPropagation();
      if (!dragged) return;
      zone.insertBefore(dragged, preview?.parentElement === zone ? preview : $(".ranking-drop-hint", zone));
      clearPreview();
      $$(".ranking-dropzone").forEach((dropzone) => { const hint = $(".ranking-drop-hint", dropzone); if ($$("[data-ranking-anime]", dropzone).length) hint?.remove(); else if (!hint) dropzone.insertAdjacentHTML("beforeend", `<span class="ranking-drop-hint">${dropzone.dataset.tierId === "unranked" ? "从这里拖到上方等级" : "拖放封面到这里"}</span>`); });
      const boardId = state.rankingBoard.id;
      state.rankingDirtyBoards.set(boardId, collectRankingPlacements());
      const label = $(`.ranking-board-button[data-board-id="${boardId}"] strong`);
      if (label && !$(".ranking-dirty-dot", label)) label.insertAdjacentHTML("beforeend", '<i class="ranking-dirty-dot"></i>');
      $("#saveRankingBoard").classList.remove("hidden");
    }, true);
  });
}

async function renameRankingBoard() {
  const name = prompt("请输入新的表单名称", state.rankingBoard.name);
  if (name === null) return;
  await writeRanking(`/api/rankings/${state.rankingBoard.id}`, "PATCH", {name});
}

async function saveRankingTemplate() {
  const name = prompt("请输入模板名称", `${state.rankingBoard.name} 模板`);
  if (name === null) return;
  try {
    const result = await api("/api/ranking-templates", {method:"POST", body:JSON.stringify({name, tiers: state.rankingBoard.tiers.map((tier) => tier.name)})});
    state.ranking_templates = result.templates; toast("等级模板已保存");
  } catch (error) { toast(error.message, "error"); }
}

async function saveRankingPlacements() {
  const boardId = state.rankingBoard.id;
  const draft = state.rankingDirtyBoards.get(boardId);
  await writeRanking(`/api/rankings/${boardId}/move`, "POST", {placements: collectRankingPlacements()}, () => {
    if (state.rankingDirtyBoards.get(boardId) === draft) {
      state.rankingDirtyBoards.delete(boardId);
      toast("排行榜已保存");
    } else {
      toast("已保存提交时的排序，还有新的改动待保存");
    }
  });
}

async function deleteRankingBoard() {
  if (!confirm(`删除排行榜“${state.rankingBoard.name}”？`)) return;
  const boardId = state.rankingBoard.id;
  await writeRanking(`/api/rankings/${boardId}`, "DELETE", null, () => state.rankingDirtyBoards.delete(boardId));
}

window.addEventListener("beforeunload", (event) => { if (state.rankingDirtyBoards.size) { event.preventDefault(); event.returnValue="排行榜有未保存的更改"; } });

