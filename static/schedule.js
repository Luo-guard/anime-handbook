function scheduleSource() { return state.settings.schedule_source === "kazumi" ? "kazumi" : "yuc"; }
/* Public season metadata is small; poster images and DOM cards load on demand. */
const scheduleState = {season: "", day: 1, data: null, search: "", timer: null, abort: null, request: 0, shown: 30, initialized: false};
const scheduleDays = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const scheduleSortNames = {time: "时间顺序", score: "评分优先", popularity: "热度优先"};
const scheduleCardFieldOptions = [
  ["tags", "显示标签与集数说明", "卡片下方的题材标签，或网络放送的集数说明。"],
  ["votes", "显示评分人数", "卡片左下角的评分人数或资料状态。"],
  ["release", "显示首播日期／平台", "右下角的首播日期；网络放送卡片对应播放平台。"],
  ["score", "显示评分", "封面右上角的 Bangumi 评分。"],
  ["collection", "显示收藏状态", "封面左上角的在看、想看等收藏状态。"],
  ["airtime", "显示放送时间", "封面底部的具体放送时间；网络放送对应上线日期。"],
];

function scheduleCardVisibility() {
  const saved = state.settings.schedule_card_fields || {};
  return Object.fromEntries(scheduleCardFieldOptions.map(([key]) => [key, saved[key] !== false]));
}

function scheduleToday(now = new Date()) {
  const adjusted = new Date(now.getTime() + 4 * 3600000); // UTC + 8 minus the 04:00 day boundary
  return {year: adjusted.getUTCFullYear(), month: adjusted.getUTCMonth() + 1,
    day: (adjusted.getUTCDay() + 6) % 7 + 1, date: adjusted};
}

function scheduleSeasonName(season) {
  return `${season.slice(0, 4)} 年 · ${{"01":"冬", "04":"春", "07":"夏", "10":"秋"}[season.slice(4)]}季`;
}

const scheduleGroupDefaults = {collection: ['collected', 'uncollected'], status: ['1', '2', '3', '4', '5', 'uncollected']};
function scheduleGrouping() {
  const saved = state.settings.schedule_grouping || {};
  const order = mode => [...new Set([...(saved[mode + '_order'] || []).filter(id => scheduleGroupDefaults[mode].includes(id)), ...scheduleGroupDefaults[mode]])];
  return {mode: ['collection', 'status'].includes(saved.mode) ? saved.mode : 'none', collection_order: order('collection'), status_order: order('status'), sorts: {...saved.sorts}, direction: saved.direction, directions: {...saved.directions}};
}

function scheduleDefaultDirection(sort) { return sort === 'time' ? 'asc' : 'desc'; }
function scheduleDirectionLabel(key, direction) {
  return `${key === "uniform" ? "统一排序" : scheduleGroupName(key)}：${direction === "asc" ? "正序，从小到大" : "逆序，从大到小"}，点击切换`;
}
function scheduleDirectionButton(key, direction) {
  return `<button type="button" class="schedule-sort-direction" data-sort-direction="${key}" data-direction="${direction}" aria-label="${scheduleDirectionLabel(key, direction)}" title="${direction === 'asc' ? '正序，从小到大；点击切换' : '逆序，从大到小；点击切换'}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path class="direction-up" d="M7 20V4M3 8l4-4 4 4"/><path class="direction-down" d="M17 4v16m-4-4 4 4 4-4"/></svg></button>`;
}

function scheduleGroupName(id) {
  return id === 'collected' ? '已收藏' : id === 'uncollected' ? '未收藏' : CATEGORIES.find(c => String(c.id) === id)?.name || id;
}

function readScheduleSorting(selector) {
  const root = $(selector), draft = root.sortingDraft;
  const uniform = root.querySelector('[data-uniform-sort]');
  const mode = root.querySelector('[data-group-mode]');
  if (uniform) draft.sort = uniform.value;
  if (mode) draft.grouping.mode = mode.value;
  root.querySelectorAll('[data-group-sort]').forEach(input => {draft.grouping.sorts[input.dataset.groupSort] = input.value;});
  root.querySelectorAll('[data-sort-direction]').forEach(button => {
    if (button.dataset.sortDirection === 'uniform') draft.grouping.direction = button.dataset.direction;
    else draft.grouping.directions[button.dataset.sortDirection] = button.dataset.direction;
  });
  return {schedule_sort: draft.sort, schedule_grouping: JSON.parse(JSON.stringify(draft.grouping))};
}

async function requireScheduleSortingSupport() {
  const health = await api('/api/health');
  if (Number(health.features?.schedule_sorting || 0) < 2) {
    throw new Error('当前后台仍是旧版本，无法保存新的排序规则。请重启手账后台，再刷新页面后重试。');
  }
}

function verifyScheduleSortingSaved(settings, requested) {
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  const saved = settings?.schedule_grouping;
  const matches = saved && Object.entries(requested.schedule_grouping).every(([key, value]) => JSON.stringify(canonical(saved[key])) === JSON.stringify(canonical(value)));
  if (settings?.schedule_sort !== requested.schedule_sort || !matches) {
    throw new Error('后台未保存完整的排序规则，请重启手账后台并刷新页面后重试。');
  }
}

function renderScheduleSorting(selector, draft = null) {
  const root = $(selector);
  root.sortingDraft = draft || {sort: schedulePreferences().sort, grouping: scheduleGrouping()};
  const {sort, grouping} = root.sortingDraft;
  const options = selected => Object.entries(scheduleSortNames).map(([id, name]) => `<option value="${id}" ${id === selected ? 'selected' : ''}>${name}</option>`).join('');
  root.innerHTML = `<label class="schedule-sort-mode"><span>分组方式</span><select data-group-mode aria-label="分组方式">${[['none','不分组'],['collection','已收藏 / 未收藏'],['status','按六种收藏状态']].map(([id,name]) => `<option value="${id}" ${grouping.mode === id ? 'selected' : ''}>${name}</option>`).join('')}</select></label>
    <div class="schedule-sort-mode" ${grouping.mode === 'none' ? '' : 'hidden'}><span>统一排序</span><div class="schedule-sort-choice"><select data-uniform-sort aria-label="统一排序">${options(sort)}</select>${scheduleDirectionButton("uniform", grouping.direction || scheduleDefaultDirection(sort))}</div></div>
    ${grouping.mode === 'none' ? '' : `<div class="schedule-group-sort-list">${grouping[grouping.mode + '_order'].map((id, i, order) => `<div class="schedule-group-sort-row" data-sort-row="${id}"><span class="schedule-group-name">${scheduleGroupName(id)}</span><div class="schedule-sort-choice"><select data-group-sort="${id}" aria-label="${scheduleGroupName(id)}组内排序">${options(grouping.sorts[id] || sort)}</select>${scheduleDirectionButton(id, grouping.directions[id] || scheduleDefaultDirection(grouping.sorts[id] || sort))}</div><div class="schedule-group-moves"><button type="button" data-sort-move="-1" data-sort-group="${id}" aria-label="上移${scheduleGroupName(id)}" ${i === 0 ? 'disabled' : ''}><svg viewBox="0 0 12 8" aria-hidden="true"><path d="M1 7 6 1 11 7Z" fill="currentColor"/></svg></button><button type="button" data-sort-move="1" data-sort-group="${id}" aria-label="下移${scheduleGroupName(id)}" ${i === order.length - 1 ? 'disabled' : ''}><svg viewBox="0 0 12 8" aria-hidden="true"><path d="M1 1 6 7 11 1Z" fill="currentColor"/></svg></button></div></div>`).join('')}</div><small class="schedule-sort-hint">按从上到下的分组顺序排列；上下箭头调整优先级。显示范围仍由下方筛选控制。</small>`}`;
  root.onchange = event => {
    const input = event.target;
    if (!input.matches('[data-group-mode], [data-group-sort], [data-uniform-sort]')) return;
    const config = readScheduleSorting(selector);
    if (input.matches('[data-uniform-sort]')) config.schedule_grouping.direction = scheduleDefaultDirection(input.value);
    if (input.matches('[data-group-sort]')) config.schedule_grouping.directions[input.dataset.groupSort] = scheduleDefaultDirection(input.value);
    renderScheduleSorting(selector, {sort: config.schedule_sort, grouping: config.schedule_grouping});
  };
  root.onclick = event => {
    const directionButton = event.target.closest('[data-sort-direction]');
    if (directionButton) {
      directionButton.dataset.direction = directionButton.dataset.direction === 'asc' ? 'desc' : 'asc';
      const key = directionButton.dataset.sortDirection, direction = directionButton.dataset.direction;
      const label = scheduleDirectionLabel(key, direction);
      directionButton.setAttribute('aria-label', label);
      directionButton.title = label;
      readScheduleSorting(selector);
      return;
    }
    const button = event.target.closest('[data-sort-move]');
    if (!button || button.disabled) return;
    const config = readScheduleSorting(selector), grouping = config.schedule_grouping;
    const order = grouping[grouping.mode + '_order'], index = order.indexOf(button.dataset.sortGroup), target = index + Number(button.dataset.sortMove);
    if (target < 0 || target >= order.length) return;
    const rows = [...root.querySelectorAll('[data-sort-row]')];
    rows.forEach(row => {
      row.getAnimations?.().forEach(animation => animation.cancel());
      row.classList.remove('is-reordering');
    });
    const row = rows[index], neighbor = rows[target];
    const before = [row, neighbor].map(item => item.getBoundingClientRect().top);
    [order[index], order[target]] = [order[target], order[index]];
    root.sortingDraft = {sort: config.schedule_sort, grouping};
    const list = row.parentElement;
    if (target < index) list.insertBefore(row, neighbor);
    else list.insertBefore(neighbor, row);
    [...list.children].forEach((item, position) => {
      item.querySelector('[data-sort-move="-1"]').disabled = position === 0;
      item.querySelector('[data-sort-move="1"]').disabled = position === order.length - 1;
    });
    if (row.animate && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      [row, neighbor].forEach((item, position) => {
        const offset = before[position] - item.getBoundingClientRect().top;
        if (item === row) item.classList.add('is-reordering');
        const animation = item.animate([
          {transform: `translateY(${offset}px)`, ...(item === row ? {boxShadow: '0 8px 20px rgb(var(--theme-rgb) / .18)'} : {})},
          {transform: 'translateY(0)', boxShadow: 'none'},
        ], {duration: 280, easing: 'cubic-bezier(.22,.8,.25,1)'});
        item.reorderAnimation = animation;
        const finish = () => {
          if (item.reorderAnimation !== animation) return;
          item.classList.remove('is-reordering');
          item.reorderAnimation = null;
        };
        animation.onfinish = finish;
        animation.oncancel = finish;
      });
    }
    const focusButton = !button.disabled ? button : row.querySelector('[data-sort-move]:not(:disabled)');
    focusButton?.focus({preventScroll: true});
  };
}

function schedulePreferences() {
  return {sort: state.settings.schedule_sort || "time",
    statuses: state.settings.schedule_statuses || [1, 2, 3, 4, 5],
    uncollected: state.settings.schedule_uncollected !== false};
}

function scheduleFilteredItems() {
  const prefs = schedulePreferences(), keyword = scheduleState.search.trim().toLocaleLowerCase();
  return (scheduleState.data?.items || []).filter((item) => {
    const visible = item.collection_type ? prefs.statuses.includes(Number(item.collection_type)) : prefs.uncollected;
    return visible && (!keyword || [item.title, ...(item.aliases || [])].some((name) => name.toLocaleLowerCase().includes(keyword)));
  });
}

function scheduleComparator(a, b) {
  const grouping = scheduleGrouping();
  const groupFor = item => grouping.mode === "collection" ? (item.collection_type ? "collected" : "uncollected") : item.collection_type ? String(item.collection_type) : "uncollected";
  let sort = schedulePreferences().sort;
  if (grouping.mode !== "none") {
    const aGroup = groupFor(a), bGroup = groupFor(b), order = grouping[grouping.mode + "_order"];
    if (aGroup !== bGroup) return order.indexOf(aGroup) - order.indexOf(bGroup);
    sort = grouping.sorts[aGroup] || sort;
  }
  const key = groupFor(a);
  const direction = (grouping.mode === "none" ? grouping.direction : grouping.directions[key]) || scheduleDefaultDirection(sort);
  const factor = direction === "desc" ? -1 : 1;
  const title = () => a.title.localeCompare(b.title, "zh-CN");
  if (sort === "score") return factor * (Number(a.score || 0) - Number(b.score || 0) || Number(a.votes || 0) - Number(b.votes || 0)) || title();
  if (sort === "popularity") return factor * (Number(a.votes || 0) - Number(b.votes || 0) || Number(a.score || 0) - Number(b.score || 0)) || title();
  const time = item => {
    if (item.kind !== "network") return item.time_order == null ? null : Number(item.time_order);
    const match = String(item.release || "").match(/(\d{1,2})\/(\d{1,2})/);
    return match ? Number(match[1]) * 100 + Number(match[2]) : null;
  };
  const left = time(a), right = time(b);
  if (left === null || right === null) return (left === null) - (right === null) || title();
  return factor * (left - right) || title();
}

function stopSchedulePolling() {
  clearTimeout(scheduleState.timer);
  scheduleState.abort?.abort();
  scheduleState.request += 1;
}

async function loadSchedule(refresh = false) {
  stopSchedulePolling();
  const request = scheduleState.request;
  scheduleState.abort = new AbortController();
  if (scheduleState.data?.season !== scheduleState.season || scheduleState.dataSource !== scheduleSource()) scheduleState.data = null;
  renderSchedule();
  $("#scheduleRefresh").disabled = true;
  try {
    const query = new URLSearchParams({season: scheduleState.season, source: scheduleSource()});
    if (refresh) query.set("refresh", "true");
    const data = await api(`/api/schedule?${query}`, {signal: scheduleState.abort.signal});
    if (request !== scheduleState.request) return;
    scheduleState.data = data;
    scheduleState.dataSource = scheduleSource();
    renderSchedule();
    if (data.loading && state.activeView === "schedule") scheduleState.timer = setTimeout(() => loadSchedule(), 1800);
  } catch (error) {
    if (error.name !== "AbortError" && request === scheduleState.request) {
      $("#scheduleNotice").textContent = `${pageLabel("schedule")}暂时无法加载，可稍后刷新。`;
      $("#scheduleNotice").hidden = false;
    }
  } finally {
    if (request === scheduleState.request) $("#scheduleRefresh").disabled = false;
  }
}

function scheduleTimeLabel(item) {
  if (item.kind === "network") return item.release || "上线日期待公布";
  if (!item.time) return scheduleSource() === "kazumi" ? "未提供具体时刻" : "时间待公布";
  return `${item.calendar_weekday !== item.weekday ? "次日 " : ""}${item.time}`;
}

function scheduleVotesLabel(item) {
  if (Number(item.votes) > 0) return `${Number(item.votes).toLocaleString("zh-CN")} 人评分`;
  if (item.votes_known) return "暂无人评分";
  return item.id ? "评分人数暂缺" : "资料待匹配";
}

function scheduleCard(item) {
  const show = scheduleCardVisibility();
  const category = CATEGORIES.find((c) => c.id === item.collection_type);
  const image = `/api/schedule/cover?source=${scheduleSource()}&${new URLSearchParams({season: scheduleState.season, key: item.key})}`;
  const release = item.kind === "weekly" ? (item.release ? `${item.release.replace(/~$/, "")} 起` : "") : item.platforms?.[0]?.name || "";
  const votesHtml = show.votes ? `<span>${scheduleVotesLabel(item)}</span>` : "";
  const releaseHtml = show.release && release ? `<span class="schedule-card-release">${escapeHtml(release)}</span>` : "";
  return `<button type="button" class="anime-card schedule-card" data-schedule-key="${escapeHtml(item.key)}" aria-label="查看${escapeHtml(item.title)}的放送信息">
    <div class="poster-wrap">${item.image_url ? `<img src="${image}" alt="${escapeHtml(item.title)}" loading="lazy" decoding="async" onerror="this.style.display='none'" />` : ""}
      ${show.score && Number(item.score) > 0 ? `<span class="poster-score">${Number(item.score).toFixed(1)}</span>` : ""}
      ${show.collection && category ? `<span class="schedule-collection-badge">${category.name}</span>` : ""}
      ${show.airtime ? `<span class="schedule-airtime ${item.time || item.kind === "network" ? "" : "unknown"}">${escapeHtml(scheduleTimeLabel(item))}</span>` : ""}
    </div><div class="card-body"><div class="card-title">${escapeHtml(item.title)}</div>
    ${show.tags ? `<p class="schedule-card-meta">${escapeHtml(item.kind === "network" ? item.release_note || "网络放送" : item.tags?.slice(0, 2).join(" · ") || "每周放送")}</p>` : ""}
    ${votesHtml || releaseHtml ? `<div class="schedule-card-footer">${votesHtml}${releaseHtml}</div>` : ""}</div>
  </button>`;
}

function renderSchedule() {
  $("#scheduleSourceSwitch").hidden = state.settings.show_schedule_source_switch === false;
  $("#scheduleSourceSwitch").textContent = scheduleSource() === "kazumi" ? "Kazumi / Bangumi ▾" : "長門番堂 ▾";
  if (!scheduleState.season) return;
  const items = scheduleFilteredItems(), today = scheduleToday();
  $("#scheduleSeasonButton strong").textContent = scheduleSeasonName(scheduleState.season);
  const currentSeason = `${today.year}${String(Math.floor((today.month - 1) / 3) * 3 + 1).padStart(2, "0")}`;
  $("#scheduleWeek").innerHTML = [...scheduleDays.map((label, index) => {
    const day = index + 1, count = items.filter((item) => item.kind === "weekly" && item.weekday === day).length;
    const date = new Date(today.date); date.setUTCDate(date.getUTCDate() + day - today.day);
    return `<button type="button" data-schedule-day="${day}" class="${scheduleState.day === day ? "active" : ""}" aria-pressed="${scheduleState.day === day}"><strong>${day === today.day && currentSeason === scheduleState.season ? "今天" : label}</strong><span>${currentSeason === scheduleState.season ? `${String(date.getUTCMonth() + 1).padStart(2, "0")}/${String(date.getUTCDate()).padStart(2, "0")} · ` : ""}${count} 部</span></button>`;
  }), `<button type="button" data-schedule-day="0" class="schedule-network-tab ${scheduleState.day === 0 ? "active" : ""}" aria-pressed="${scheduleState.day === 0}"><strong>网络放送</strong><span>单独上线 · ${items.filter((i) => i.kind === "network").length} 部</span></button>`].join("");
  $$("[data-schedule-day]", $("#scheduleWeek")).forEach((button) => button.onclick = () => {scheduleState.day = Number(button.dataset.scheduleDay); scheduleState.shown = 30; renderSchedule();});
  const selected = items.filter((item) => scheduleState.day === 0 ? item.kind === "network" : item.kind === "weekly" && item.weekday === scheduleState.day).sort(scheduleComparator);
  const data = scheduleState.data;
  const notices = [data?.loading ? "正在更新季度资料，已有缓存仍可浏览…" : "", data?.error || "", ...(data?.warnings || [])].filter(Boolean);
  if (!data) notices.push(`正在读取${pageLabel("schedule")}…`);
  if (scheduleState.day === 0) notices.push("独立上线作品按日期排列；整季、分批或每周更新以平台公布为准，不推算集数。" );
  $("#scheduleNotice").textContent = notices.join(" · "); $("#scheduleNotice").hidden = !notices.length;
  $("#scheduleGrid").innerHTML = selected.slice(0, scheduleState.shown).map(scheduleCard).join("") || (data && !data.loading ? '<div class="schedule-empty"><strong>这一天，留一点空白。</strong><p>当前季度或筛选下暂无番剧，可以切换星期、季度或调整筛选。</p></div>' : "");
  if (selected.length > scheduleState.shown) $("#scheduleGrid").insertAdjacentHTML("beforeend", '<button type="button" class="secondary-button schedule-more" id="scheduleMore">继续展开本日番剧</button>');
  $("#scheduleMore")?.addEventListener("click", () => {scheduleState.shown += 30; renderSchedule();});
  $$("[data-schedule-key]", $("#scheduleGrid")).forEach((button) => button.onclick = () => showScheduleDetail(button.dataset.scheduleKey));
  $("#scheduleSource").innerHTML = `<span>播出日按北京时间 04:00—次日 03:59 划分；时间采用来源页面标注，不代表字幕上线时间。</span><span>时间：<a href="https://yuc.wiki/${scheduleState.season}/" target="_blank" rel="noopener noreferrer">長門番堂</a> · <a href="https://creativecommons.org/licenses/by-nc-sa/4.0/deed.zh" target="_blank" rel="noopener noreferrer">CC BY-NC-SA 4.0</a>　评分：Bangumi / Kazumi${data?.fetched_at ? `　缓存更新 ${new Date(data.fetched_at * 1000).toLocaleString("zh-CN")}` : ""}</span>`;
  if (scheduleSource() === "kazumi") $("#scheduleSource").textContent = "来源：Kazumi / Bangumi 放送列表。仅提供星期，不提供具体放送时刻；不推算更新集数。";
}

function scheduleStatusMarkup(statuses, name) {
  return CATEGORIES.map((category) => `<label><input type="checkbox" name="${name}" value="${category.id}" ${statuses.includes(category.id) ? "checked" : ""} /><span>${category.name}</span></label>`).join("");
}

function renderScheduleSettings() {
  $("#scheduleSourceInput").value = scheduleSource();
  $("#scheduleSourceSwitchInput").checked = state.settings.show_schedule_source_switch !== false;
  const prefs = schedulePreferences();
  renderScheduleSorting("#scheduleSortingSettings");
  $("#scheduleStatusInputs").innerHTML = scheduleStatusMarkup(prefs.statuses, "scheduleSettingsStatus");
  $("#scheduleUncollectedInput").checked = prefs.uncollected;
  const visibility = scheduleCardVisibility();
  $("#scheduleCardFieldInputs").innerHTML = scheduleCardFieldOptions.map(([key, label, description]) =>
    `<label class="setting-row"><span><strong>${label}</strong><small>${description}</small></span><span class="switch-row compact"><input type="checkbox" data-schedule-field="${key}" ${visibility[key] ? "checked" : ""} /><span class="switch"></span></span></label>`).join("");
}

function openScheduleFilters() {
  const prefs = schedulePreferences();
  renderScheduleSorting("#scheduleSortOptions");
  $("#scheduleFilterStatuses").innerHTML = scheduleStatusMarkup(prefs.statuses, "scheduleFilterStatus");
  $("#scheduleFilterUncollected").checked = prefs.uncollected;
  $("#scheduleFilterModal").showModal();
}

function showScheduleDetail(key) {
  const item = scheduleState.data?.items.find((row) => row.key === key); if (!item) return;
  const siteBase = String(state.settings.bgm_site_base || "https://bgm.tv").replace(/\/+$/, "");
  const link = item.id ? `${siteBase}/subject/${Number(item.id)}` : "";
  const anime = state.animes.find((row) => row.id === item.local_id || row.id === item.id);
  const keyword = String(anime?.name_cn || anime?.name || item.title || "").trim();
  const bilibiliSearch = `https://search.bilibili.com/all?keyword=${encodeURIComponent(keyword)}`;
  $("#scheduleDetail").innerHTML = `<p class="eyebrow">${item.kind === "network" ? "STREAMING RELEASE" : "WEEKLY AIRING"}</p><h2>${escapeHtml(item.title)}</h2><div class="schedule-detail-time">${item.kind === "weekly" ? `${scheduleDays[item.weekday - 1]} · ` : ""}${escapeHtml(scheduleTimeLabel(item))}</div><p>${escapeHtml(item.summary || "暂无匹配的 Bangumi 简介，可通过下方链接查看详细介绍。")}</p><div class="schedule-detail-facts"><span>评分 ${Number(item.score) > 0 ? Number(item.score).toFixed(1) : "暂无"}</span><span>${scheduleVotesLabel(item)}</span><span>${escapeHtml(item.release_note || "")}</span></div><div class="schedule-detail-links">${link ? `<a href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer">Bangumi #${Number(item.id)} ↗</a>` : ""}${keyword ? `<a href="${escapeHtml(bilibiliSearch)}" target="_blank" rel="noopener noreferrer">B站搜索 ↗</a>` : ""}</div>${item.local_id && state.animes.some((a) => a.id === item.local_id) ? '<button type="button" class="primary-button" id="scheduleRecordProgress">记录观看进度</button>' : ""}`;
  $("#scheduleRecordProgress")?.addEventListener("click", () => {$("#scheduleDetailModal").close(); openProgress(item.local_id);});
  if(item.id) {
    if(collectionEditingSupported()){
      const row=document.createElement("div");row.className="schedule-detail-collect";
      const label=document.createElement("span");label.className="schedule-detail-collect-label";label.textContent="收藏状态";
      row.append(label,collectionAction(item.id,anime?.collection_type||2));
      const recordButton=$("#scheduleRecordProgress");
      if(recordButton)recordButton.before(row);else $("#scheduleDetail").append(row);
    }
  }
  else {const note=document.createElement('p');note.textContent='该条目尚未关联 Bangumi ID，可在收藏夹的搜索添加中确认对应番剧。';$("#scheduleDetail").append(note);}
  $("#scheduleDetailModal").showModal();
}

function initializeSchedule() {
  if (scheduleState.initialized) return;
  scheduleState.initialized = true;
  const today = scheduleToday();
  scheduleState.day = today.day;
  scheduleState.season = `${today.year}${String(Math.floor((today.month - 1) / 3) * 3 + 1).padStart(2, "0")}`;
  $("#scheduleSourceSwitch").onclick = async () => {
    const source = scheduleSource() === "yuc" ? "kazumi" : "yuc";
    try {
      const payload = await api("/api/settings", {method: "PATCH", body: JSON.stringify({schedule_source: source})});
      if (payload.settings?.schedule_source !== source) throw new Error("当前后台不支持周表来源切换，请重启后台后刷新页面。");
      state.settings = payload.settings;
      scheduleState.data = null;
      scheduleState.shown = 30;
      renderScheduleSettings();
      loadSchedule();
    } catch (error) { toast(error.message, "error"); }
  };
  $("#scheduleRefresh").onclick = () => loadSchedule(true);
  $("#scheduleFilterButton").onclick = openScheduleFilters;
  $("#scheduleCloseDetail").onclick = () => $("#scheduleDetailModal").close();
  $("#scheduleSearch").oninput = (event) => {scheduleState.search = event.target.value; scheduleState.shown = 30; renderSchedule();};
  $("#scheduleSeasonButton").onclick = () => {
    $("#scheduleYears").innerHTML = Array.from({length: today.year - 2015 + 2}, (_, index) => today.year + 1 - index).map((year) => `<section><h3>${year}</h3><div>${[1, 4, 7, 10].map((month, i) => {const key = `${year}${String(month).padStart(2, "0")}`; return `<button type="button" data-schedule-season="${key}" class="${key === scheduleState.season ? "active" : ""}">${["冬季", "春季", "夏季", "秋季"][i]}</button>`;}).join("")}</div></section>`).join("");
    $$("[data-schedule-season]", $("#scheduleYears")).forEach((button) => button.onclick = () => {scheduleState.season = button.dataset.scheduleSeason; scheduleState.shown = 30; $("#scheduleSeasonModal").close(); loadSchedule();});
    $("#scheduleSeasonModal").showModal();
    $("[data-schedule-season].active", $("#scheduleYears"))?.scrollIntoView({block: "center"});
  };
  $("#scheduleApplyFilter").onclick = async () => {
    const button = $("#scheduleApplyFilter"); button.disabled = true;
    try {
      const sorting = readScheduleSorting("#scheduleSortOptions");
      await requireScheduleSortingSupport();
      const result = await api("/api/settings", {method: "PATCH", body: JSON.stringify({
        ...sorting,
        schedule_statuses: $$("#scheduleFilterStatuses input:checked").map((input) => Number(input.value)),
        schedule_uncollected: $("#scheduleFilterUncollected").checked,
      })});
      verifyScheduleSortingSaved(result.settings, sorting);
      state.settings = result.settings; scheduleState.shown = 30;
      $("#scheduleFilterModal").close(); renderScheduleSettings(); renderSchedule();
    } catch (error) {toast(error.message, "error");}
    finally {button.disabled = false;}
  };
}
