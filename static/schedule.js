function scheduleSource() { return ["yuc", "kazumi", "as"].includes(state.settings.schedule_source) ? state.settings.schedule_source : "yuc"; }
const scheduleSourceNames = {yuc: "長門番堂", kazumi: "Bangumi", as: "AnimeSchedule"};
let scheduleSettingsSourceValue = "yuc";
function scheduleSettingsSource() { return ["yuc", "kazumi", "as"].includes(scheduleSettingsSourceValue) ? scheduleSettingsSourceValue : "yuc"; }
/* Public season metadata is small; poster images and DOM cards load on demand. */
const scheduleState = {season: "", week: "", day: 1, data: null, search: "", timer: null, abort: null, request: 0, shown: 30, initialized: false, pickHidden: false};
const scheduleDays = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const scheduleSortNames = {time: "时间顺序", score: "评分优先", popularity: "热度优先"};
const scheduleCardFieldOptions = [
  ["tags", "显示标签与集数说明", "卡片下方的题材标签，或网络放送的集数说明。"],
  ["votes", "显示评分人数", "卡片左下角的评分人数或资料状态。"],
  ["release", "显示首播日期／平台", "右下角的首播日期；网络放送卡片对应播放平台。"],
  ["score", "显示评分", "封面右上角的 Bangumi 评分。"],
  ["collection", "显示收藏状态", "封面左上角的在看、想看等收藏状态。"],
  ["airtime", "显示放送时间", "封面底部的具体放送时间；网络放送对应上线日期。"],
  ["progress", "显示播出进度", "按下方选择的数据源显示；AS 无可靠资料时不推算。BGM 缺少逐集资料时的估算可能受停播影响。"],
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

function scheduleISOWeek(now = new Date()) {
  const date = new Date(scheduleToday(now).date);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
  const year = date.getUTCFullYear();
  const number = Math.ceil((((date - new Date(Date.UTC(year, 0, 1))) / 86400000) + 1) / 7);
  return `${year}-W${String(number).padStart(2, "0")}`;
}

function scheduleWeekMonday(key) {
  const year = Number(key.slice(0, 4)), week = Number(key.slice(-2));
  const day = new Date(Date.UTC(year, 0, 4));
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7) + (week - 1) * 7);
  return day;
}

function moveScheduleWeek(delta) {
  const day = scheduleWeekMonday(scheduleState.week || scheduleISOWeek());
  day.setUTCDate(day.getUTCDate() + delta * 7);
  // Noon Beijing is safely inside the broadcast day.
  scheduleState.week = scheduleISOWeek(new Date(day.getTime() + 4 * 3600000));
  scheduleState.data = null;
  scheduleState.shown = 30;
  loadSchedule();
}

const scheduleGroupDefaults = {collection: ['collected', 'uncollected'], status: ['1', '2', '3', '4', '5', 'uncollected']};
function schedulePrefsFor(source) {
  // 三套周表各自独立：新结构 schedule_preferences[source] 优先；
  // 老数据没有嵌套结构时回退到旧扁平键，第一次保存后该来源就固化下来。
  const nested = state.settings.schedule_preferences || {};
  const saved = nested[source];
  const flat = {
    schedule_sort: state.settings.schedule_sort,
    schedule_grouping: state.settings.schedule_grouping,
    schedule_statuses: state.settings.schedule_statuses,
    schedule_origins: state.settings.schedule_origins,
    schedule_uncollected: state.settings.schedule_uncollected,
  };
  const raw = saved && typeof saved === "object" && Object.keys(saved).length ? saved : flat;
  return {
    sort: scheduleSortNames[raw.schedule_sort] ? raw.schedule_sort : "time",
    statuses: Array.isArray(raw.schedule_statuses) ? raw.schedule_statuses.map(Number).filter(n => n >= 1 && n <= 5) : [1, 2, 3, 4, 5],
    origins: Array.isArray(raw.schedule_origins) ? raw.schedule_origins.filter(o => scheduleOriginOptions.some(([id]) => id === o)) : scheduleOriginOptions.map(([id]) => id),
    uncollected: raw.schedule_uncollected !== false,
    grouping: raw.schedule_grouping && typeof raw.schedule_grouping === "object" ? raw.schedule_grouping : {},
  };
}

function scheduleGrouping(source = scheduleSource()) {
  const saved = schedulePrefsFor(source).grouping;
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

function verifySchedulePreferencesSaved(settings, source, requested) {
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  const saved = settings?.schedule_preferences?.[source] || {};
  const savedGrouping = saved.schedule_grouping;
  const matches = savedGrouping && Object.entries(requested.schedule_grouping).every(([key, value]) => JSON.stringify(canonical(savedGrouping[key])) === JSON.stringify(canonical(value)));
  if (saved.schedule_sort !== requested.schedule_sort || !matches) {
    throw new Error('后台未保存完整的排序规则，请重启手账后台并刷新页面后重试。');
  }
}

function renderScheduleSorting(selector, draft = null, source = scheduleSource()) {
  const root = $(selector);
  root.sortingDraft = draft || {sort: schedulePreferences(source).sort, grouping: scheduleGrouping(source)};
  const {sort, grouping} = root.sortingDraft;
  const options = selected => Object.entries(scheduleSortNames).map(([id, name]) => `<option value="${id}" ${id === selected ? 'selected' : ''}>${name}</option>`).join('');
  root.innerHTML = `<label class="schedule-sort-mode"><span>分组方式</span><select data-group-mode aria-label="分组方式">${[['none','不分组'],['collection','已收藏 / 未收藏'],['status','按六种收藏状态']].map(([id,name]) => `<option value="${id}" ${grouping.mode === id ? 'selected' : ''}>${name}</option>`).join('')}</select></label>
    <div class="schedule-sort-mode" ${grouping.mode === 'none' ? '' : 'hidden'}><span>统一排序</span><div class="schedule-sort-choice"><select data-uniform-sort aria-label="统一排序">${options(sort)}</select>${scheduleDirectionButton("uniform", grouping.direction || scheduleDefaultDirection(sort))}</div></div>
    ${grouping.mode === 'none' ? '' : `<div class="schedule-group-sort-list">${grouping[grouping.mode + '_order'].map((id, i, order) => `<div class="schedule-group-sort-row" data-sort-row="${id}"><span class="schedule-group-name">${scheduleGroupName(id)}</span><div class="schedule-sort-choice"><select data-group-sort="${id}" aria-label="${scheduleGroupName(id)}组内排序">${options(grouping.sorts[id] || sort)}</select>${scheduleDirectionButton(id, grouping.directions[id] || scheduleDefaultDirection(grouping.sorts[id] || sort))}</div><div class="schedule-group-moves"><button type="button" data-sort-move="-1" data-sort-group="${id}" aria-label="上移${scheduleGroupName(id)}" ${i === 0 ? 'disabled' : ''}><svg viewBox="0 0 12 8" aria-hidden="true"><path d="M1 7 6 1 11 7Z" fill="currentColor"/></svg></button><button type="button" data-sort-move="1" data-sort-group="${id}" aria-label="下移${scheduleGroupName(id)}" ${i === order.length - 1 ? 'disabled' : ''}><svg viewBox="0 0 12 8" aria-hidden="true"><path d="M1 1 6 7 11 1Z" fill="currentColor"/></svg></button></div></div>`).join('')}</div>`}`;
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

// 地区来自 Bangumi 的 meta 标签（条目页顶部 TV / 日本 / 2026年10月 那一行）。
// 数据里韩国是独立值，筛选界面按你选的五档把它并进「其他」。
const scheduleOriginOptions = [["jp", "日漫"], ["cn", "国漫"], ["us", "美漫"], ["other", "其他"], ["unknown", "未标注"]];
const scheduleOriginGroup = {jp: "jp", cn: "cn", us: "us", kr: "other", other: "other", "": "unknown"};

function scheduleOriginOf(item) {
  return scheduleOriginGroup[item.origin || ""] || "unknown";
}

function schedulePreferences(source = scheduleSource()) {
  const prefs = schedulePrefsFor(source);
  return {sort: prefs.sort, statuses: prefs.statuses, origins: prefs.origins, uncollected: prefs.uncollected};
}

// ===== 隐藏的番剧：按周表来源分开存，在哪一套里隐藏只影响那一套 =====
// 旧数据是扁平数组（三套通吃），读到时展开成三份，下次保存即固化成嵌套结构。
const SCHEDULE_SOURCE_KEYS = ["yuc", "kazumi", "as"];

function scheduleHiddenMap() {
  const raw = state.settings.schedule_hidden;
  if (Array.isArray(raw)) {
    const ids = raw.map(Number).filter((n) => n > 0);
    return Object.fromEntries(SCHEDULE_SOURCE_KEYS.map((source) => [source, [...ids]]));
  }
  return Object.fromEntries(SCHEDULE_SOURCE_KEYS.map((source) => [
    source,
    (Array.isArray(raw?.[source]) ? raw[source] : []).map(Number).filter((n) => n > 0),
  ]));
}

function scheduleHiddenIds(source = scheduleSource()) {
  return scheduleHiddenMap()[source] || [];
}

// 没关联 Bangumi 的条目（AS 里的国漫居多）没有数字 ID，只能按标题藏。
// 单独存一份，和 ID 列表取并集，两边都能用。
function scheduleHiddenTitleMap() {
  const raw = state.settings.schedule_hidden_titles;
  return Object.fromEntries(SCHEDULE_SOURCE_KEYS.map((source) => [
    source,
    (Array.isArray(raw?.[source]) ? raw[source] : []).map((title) => String(title || "").trim()).filter(Boolean),
  ]));
}

function scheduleHiddenTitles(source = scheduleSource()) {
  return scheduleHiddenTitleMap()[source] || [];
}

function scheduleTitleKey(title) {
  // 后端会把标题截到 120 字再存，这里跟着截，否则超长标题藏下去、
  // 匹配时用的是完整标题，两边对不上就会「藏了又回来」。
  return String(title || "").trim().slice(0, 120).toLocaleLowerCase();
}

function scheduleHiddenCount(source = scheduleSource()) {
  return scheduleHiddenIds(source).length + scheduleHiddenTitles(source).length;
}

function scheduleHiddenSets(source = scheduleSource()) {
  const ids = new Set(scheduleHiddenIds(source));
  const names = new Set();
  state.animes.forEach((anime) => {
    if (ids.has(Number(anime.id))) [anime.name_cn, anime.name, anime.display_name].forEach((n) => n && names.add(String(n).toLocaleLowerCase()));
  });
  const titles = new Set(scheduleHiddenTitles(source).map(scheduleTitleKey));
  return {ids, names, titles};
}
function scheduleItemHidden(item, hidden) {
  if (item.id && hidden.ids.has(Number(item.id))) return true;
  const title = String(item.title || "");
  if (!title) return false;
  const key = scheduleTitleKey(title);
  return hidden.titles.has(key) || hidden.names.has(key);
}

function scheduleFilteredItems() {
  const prefs = schedulePreferences(), keyword = scheduleState.search.trim().toLocaleLowerCase();
  const hidden = scheduleHiddenSets();
  return (scheduleState.data?.items || []).filter((item) => {
    if (scheduleItemHidden(item, hidden)) return false;
    const visible = item.collection_type ? prefs.statuses.includes(Number(item.collection_type)) : prefs.uncollected;
    return visible && prefs.origins.includes(scheduleOriginOf(item)) && (!keyword || [item.title, ...(item.aliases || [])].some((name) => name.toLocaleLowerCase().includes(keyword)));
  });
}

function scheduleComparator(a, b) {
  const grouping = scheduleGrouping(); // 当前来源（默认参数）
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
  if (scheduleSource() === "as") {
    if (scheduleState.day === 0) scheduleState.day = scheduleToday().day;
    if (!scheduleState.week) scheduleState.week = scheduleISOWeek();
    if (scheduleState.data?.week !== scheduleState.week) scheduleState.data = null;
  }
  renderSchedule();
  $("#scheduleRefresh").disabled = true;
  try {
    const query = new URLSearchParams({season: scheduleState.season, source: scheduleSource()});
    if (scheduleSource() === "as") query.set("week", scheduleState.week);
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
  if (item.delayed) return "放送延期";
  if (item.kind === "network") return item.release || "上线日期待公布";
  // 新缓存带北京时间；旧缓存只有日本时间，刷新季度后自动切换。
  const clock = item.bj_time || item.time;
  if (!clock) return scheduleSource() === "kazumi" ? "未提供具体时刻" : "时间待公布";
  const day = item.bj_weekday ?? item.calendar_weekday;
  return `${day !== item.weekday ? "次日 " : ""}${clock}`;
}

// 未收藏（或没有逐集日期）的番剧只能按首播日 + 每周放送时间推算。
// 不请求接口，也不抓资源站；停播、总集篇会让它偏大。
function schedulePremiereDate(item) {
  const airDate = String(item.air_date || "").match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (airDate) return new Date(Number(airDate[1]), Number(airDate[2]) - 1, Number(airDate[3]));
  const release = String(item.release || "").match(/(\d{1,2})\/(\d{1,2})/);
  if (!release) return null;
  const season = String(scheduleState.season || "");
  let year = Number(season.slice(0, 4)) || new Date().getFullYear();
  const seasonMonth = Number(season.slice(4, 6)) || new Date().getMonth() + 1;
  const month = Number(release[1]);
  // 冬季番（1 月季度）的 12 月首播属于上一年；其他季度跨年时属于下一年。
  if (seasonMonth === 1 && month >= 10) year -= 1;
  else if (month < seasonMonth - 6) year += 1;
  return new Date(year, month - 1, Number(release[2]));
}

function scheduleEstimatedEpisode(item, now = new Date()) {
  if (item.kind !== "weekly") return null;
  const premiere = schedulePremiereDate(item);
  if (!premiere || Number.isNaN(premiere.getTime())) return null;
  const clock = String(item.source_time || "").match(/(\d{1,2}):(\d{2})/);
  // 来源是日本时间，减 1 小时得到北京时间；没有时刻时按“那天过完”才算。
  const firstAt = clock
    ? new Date(premiere.getTime() + (Number(clock[1]) * 60 + Number(clock[2]) - 60) * 60000)
    : new Date(premiere.getTime() + 86400000);
  if (now < firstAt) return 0;
  return Math.floor((now - firstAt) / (7 * 86400000)) + 1;
}

function scheduleProgress(item) {
  if (item.kind !== "weekly") return null;
  const anime = item.local_id ? state.animes.find((row) => row.id === item.local_id) : null;
  if (state.settings.schedule_airing_source === "as") {
    const airing = item.as_airing || anime?.as_airing;
    if (!airing || airing.unavailable) return {
      text: airing?.status === "loading" ? "AS 进度加载中" : "暂无 AS 进度",
      estimated: true, detail: "", title: "未匹配或暂无可用 AS 资料，不使用其他来源代替",
    };
    const knownTotal = Number(airing.total) || Number(anime?.episode_count) || 0;
    const total = knownTotal >= airing.aired ? knownTotal : 0;
    return {
      text: total ? `已播 ${airing.aired} / ${total}` : `已播 ${airing.aired} 集`,
      estimated: false, detail: airing.next_label ? `下集 ${airing.next_label}（北京时间）` : "",
      title: `${airing.stale ? "AS 缓存暂未更新；" : ""}已播集数来自 AnimeSchedule 原声／字幕放送计划；总集数缺失时沿用条目资料，不代表各地区资源站更新时间`,
    };
  }
  const airing = anime?.airing;
  if (airing && Number(airing.total) > 0) {
    const aired = Math.max(0, Number(airing.aired) || 0);
    const total = Number(airing.total);
    return {
      text: aired >= total ? `已播完 ${total} / ${total}` : `已播 ${aired} / ${total}`,
      estimated: false,
      detail: airing.next_label ? `下集 ${airing.next_label}（北京时间）` : "",
      title: "按 Bangumi 逐集播出日期与放送时刻（北京时间）计算，不是资源站更新时间",
    };
  }
  if (scheduleSource() === "as") return null;
  const episode = scheduleEstimatedEpisode(item);
  if (episode === null) return null;
  return {
    text: episode > 0 ? `预计第 ${episode} 集` : "待开播",
    estimated: true,
    detail: "按首播日与每周放送时间推算，停播或总集篇会偏差",
    title: "未收藏或缺少逐集日期，只能按首播日推算；停播会偏差",
  };
}

function scheduleVotesLabel(item) {
  if (Number(item.votes) > 0) return `${Number(item.votes).toLocaleString("zh-CN")} 人评分`;
  if (item.votes_known) return "暂无人评分";
  return item.id ? "评分人数暂缺" : "资料待匹配";
}

function scheduleCard(item) {
  const show = scheduleCardVisibility();
  const category = CATEGORIES.find((c) => c.id === item.collection_type);
  const image = `/api/schedule/cover?source=${scheduleSource()}&${new URLSearchParams({season: scheduleState.season, key: item.key, ...(scheduleSource() === "as" ? {week: scheduleState.week} : {})})}`;
  const release = item.kind === "weekly" ? (item.release ? `${item.release.replace(/~$/, "")} 起` : "") : item.platforms?.[0]?.name || "";
  const votesHtml = show.votes ? `<span class="schedule-card-votes">${scheduleVotesLabel(item)}</span>` : "";
  const releaseHtml = show.release && release ? `<span class="schedule-card-release">${escapeHtml(release)}</span>` : "";
  const progress = show.progress ? scheduleProgress(item) : null;
  const progressHtml = progress
    ? `<span class="schedule-progress${progress.estimated ? " is-estimated" : ""}" title="${escapeHtml(progress.title)}">${escapeHtml(progress.text)}</span>`
    : "";
  const hasCornerInfo = (show.score && Number(item.score) > 0) || (show.collection && category);
  const metaText = item.kind === "network" ? item.release_note || "网络放送" : item.tags?.slice(0, 2).join(" · ") || "每周放送";
  const metaHtml = show.tags ? `<p class="schedule-card-meta">${escapeHtml(metaText)}</p>` : "";
  // 固定三层：标题 / 出处与首播 / 评分人数与播出进度。每层各占一行，位置不随内容跳动。
  const metaRow = metaHtml || releaseHtml ? `<div class="schedule-meta-row">${metaHtml}${releaseHtml}</div>` : "";
  const statsRow = progressHtml || votesHtml ? `<div class="schedule-card-footer">${votesHtml}${progressHtml}</div>` : "";
  return `<button type="button" class="anime-card schedule-card" data-schedule-key="${escapeHtml(item.key)}" aria-label="查看${escapeHtml(item.title)}的放送信息">
    <div class="poster-wrap${hasCornerInfo ? " schedule-poster-shaded" : ""}">${item.image_url ? `<img src="${image}" alt="${escapeHtml(item.title)}" loading="lazy" decoding="async" onerror="this.style.display='none'" />` : ""}
      ${show.score && Number(item.score) > 0 ? `<span class="poster-score">${Number(item.score).toFixed(1)}</span>` : ""}
      ${show.collection && category ? `<span class="schedule-collection-badge">${category.name}</span>` : ""}
      ${show.airtime ? `<span class="schedule-airtime ${item.bj_time || item.time || item.kind === "network" ? "" : "unknown"}">${escapeHtml(scheduleTimeLabel(item))}</span>` : ""}
    </div><div class="card-body"><div class="card-title" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</div>
    ${metaRow}${statsRow}</div>
  </button>`;
}

function renderSchedule() {
  $("#scheduleSourceSwitch").hidden = state.settings.show_schedule_source_switch === false;
  $("#scheduleSourceSwitch").value = scheduleSource();
  if (!scheduleState.season) return;
  const items = scheduleFilteredItems(), today = scheduleToday();
  const useAS = scheduleSource() === "as";
  $("#scheduleSearch").placeholder = useAS ? "搜索本周番剧" : "搜索本季番剧";
  $("#scheduleSearch").setAttribute("aria-label", useAS ? "搜索本周番剧" : "搜索本季番剧");
  $("#scheduleSeasonButton").hidden = useAS;
  $("#scheduleASWeek").hidden = !useAS;
  if (useAS) {
    const key = scheduleState.week || scheduleISOWeek(), monday = scheduleWeekMonday(key);
    const sunday = new Date(monday); sunday.setUTCDate(sunday.getUTCDate() + 6);
    const label = day => `${day.getUTCMonth() + 1}/${day.getUTCDate()}`;
    $("#scheduleASWeekTitle").textContent = `${key.slice(0, 4)} 年 · 第 ${Number(key.slice(-2))} 周`;
    $("#scheduleASWeekDates").textContent = `${label(monday)} — ${label(sunday)}`;
  }
  if ($("#scheduleWeek").style) $("#scheduleWeek").style.gridTemplateColumns = useAS ? "repeat(7, minmax(0, 1fr))" : "";
  $("#scheduleSeasonButton strong").textContent = scheduleSeasonName(scheduleState.season);
  const currentSeason = `${today.year}${String(Math.floor((today.month - 1) / 3) * 3 + 1).padStart(2, "0")}`;
  $("#scheduleWeek").innerHTML = [...scheduleDays.map((label, index) => {
    const day = index + 1, count = items.filter((item) => item.kind === "weekly" && item.weekday === day).length;
    const date = useAS ? scheduleWeekMonday(scheduleState.week || scheduleISOWeek()) : new Date(today.date);
    date.setUTCDate(date.getUTCDate() + (useAS ? day - 1 : day - today.day));
    const isCurrent = useAS ? scheduleState.week === scheduleISOWeek() : currentSeason === scheduleState.season;
    return `<button type="button" data-schedule-day="${day}" class="${scheduleState.day === day ? "active" : ""}" aria-pressed="${scheduleState.day === day}"><strong>${day === today.day && isCurrent ? "今天" : label}</strong><span>${useAS || currentSeason === scheduleState.season ? `${String(date.getUTCMonth() + 1).padStart(2, "0")}/${String(date.getUTCDate()).padStart(2, "0")} · ` : ""}${count} 部</span></button>`;
  }), ...(useAS ? [] : [`<button type="button" data-schedule-day="0" class="schedule-network-tab ${scheduleState.day === 0 ? "active" : ""}" aria-pressed="${scheduleState.day === 0}"><strong>网络放送</strong><span>单独上线 · ${items.filter((i) => i.kind === "network").length} 部</span></button>`])].join("");
  $$("[data-schedule-day]", $("#scheduleWeek")).forEach((button) => button.onclick = () => {scheduleState.day = Number(button.dataset.scheduleDay); scheduleState.shown = 30; renderSchedule();});
  const selected = items.filter((item) => scheduleState.day === 0 ? item.kind === "network" : item.kind === "weekly" && item.weekday === scheduleState.day).sort(scheduleComparator);
  const data = scheduleState.data;
  const notices = [data?.loading ? useAS ? "正在更新 AS 本周日程与条目关联，已有卡片仍可浏览…" : "正在更新季度资料，已有缓存仍可浏览…" : "", data?.error || "", ...(data?.warnings || [])].filter(Boolean);
  if (!data) notices.push(`正在读取${pageLabel("schedule")}…`);
  if (scheduleState.day === 0) notices.push("独立上线作品按日期排列；整季、分批或每周更新以平台公布为准，不推算集数。" );
  if (scheduleState.data?.items?.length) {
    const hiddenSets = scheduleHiddenSets();
    const hiddenCount = scheduleState.data.items.filter((item) => scheduleItemHidden(item, hiddenSets)).length;
    if (hiddenCount) notices.push(`已隐藏 ${hiddenCount} 部番剧（右下角「排序与筛选」→ 隐藏的番剧 可恢复）`);
  }
  $("#scheduleNotice").textContent = notices.join(" · "); $("#scheduleNotice").hidden = !notices.length;
  $("#scheduleGrid").innerHTML = selected.slice(0, scheduleState.shown).map(scheduleCard).join("") || (data && !data.loading ? '<div class="schedule-empty"><strong>这一天，留一点空白。</strong><p>当前季度或筛选下暂无番剧，可以切换星期、季度或调整筛选。</p></div>' : "");
  if (selected.length > scheduleState.shown) $("#scheduleGrid").insertAdjacentHTML("beforeend", '<button type="button" class="secondary-button schedule-more" id="scheduleMore">继续展开本日番剧</button>');
  $("#scheduleMore")?.addEventListener("click", () => {scheduleState.shown += 30; renderSchedule();});
  $$("[data-schedule-key]", $("#scheduleGrid")).forEach((button) => button.onclick = () => {
    if (scheduleState.pickHidden) { hideScheduleCard(button, button.dataset.scheduleKey); return; }
    showScheduleDetail(button.dataset.scheduleKey);
  });
  if (scheduleState.pickHidden) updateSchedulePickBar();
  $("#scheduleSource").innerHTML = `<span>播出日按北京时间 04:00—次日 03:59 划分；放送时间已换算为北京时间，不代表字幕上线时间。收藏进度按 Bangumi 逐集日程，未收藏的按首播日推算。</span><span>时间：<a href="https://yuc.wiki/${scheduleState.season}/" target="_blank" rel="noopener noreferrer">長門番堂</a> · <a href="https://creativecommons.org/licenses/by-nc-sa/4.0/deed.zh" target="_blank" rel="noopener noreferrer">CC BY-NC-SA 4.0</a>　评分：Bangumi / Kazumi${data?.fetched_at ? `　缓存更新 ${new Date(data.fetched_at * 1000).toLocaleString("zh-CN")}` : ""}</span>`;
  if (scheduleSource() === "kazumi") $("#scheduleSource").textContent = "来源：Kazumi / Bangumi 放送列表。仅提供星期，不提供具体放送时刻；未收藏作品的进度只能按日期估算。";
  if (useAS) $("#scheduleSource").innerHTML = '<span>北京时间 · 凌晨 4 点换日。采用 AS 原声／字幕的较早计划时间，合并重复放送；不代表各地区平台或字幕组同步上线。</span><span>日程：<a href="https://animeschedule.net" target="_blank" rel="noopener noreferrer">AnimeSchedule</a>　编号：<a href="https://github.com/Rhilip/BangumiExtLinker" target="_blank" rel="noopener noreferrer">BangumiExtLinker · CC BY 4.0</a>　评分：Bangumi / Kazumi</span>';
}

function scheduleStatusMarkup(statuses, name) {
  return CATEGORIES.map((category) => `<label><input type="checkbox" name="${name}" value="${category.id}" ${statuses.includes(category.id) ? "checked" : ""} /><span>${category.name}</span></label>`).join("");
}

function scheduleOriginMarkup(origins, name) {
  return scheduleOriginOptions.map(([id, label]) => `<label><input type="checkbox" name="${name}" value="${id}" ${origins.includes(id) ? "checked" : ""} /><span>${label}</span></label>`).join("");
}

// ===== 隐藏番剧的界面 =====
// 入口有两处（设置 → 周表 / 周表 → 排序与筛选），都能看、都能取消隐藏；
// 但「挑哪些条目隐藏」只在筛选弹窗里直接点周表条目，不打字输番名。
let scheduleHiddenModalSourceValue = "";

function scheduleHiddenModalSource() {
  const value = scheduleHiddenModalSourceValue || scheduleSource();
  return SCHEDULE_SOURCE_KEYS.includes(value) ? value : "yuc";
}

function renderScheduleHiddenSettings() {
  const source = scheduleSettingsSource();
  const count = scheduleHiddenCount(source);
  const node = $("#scheduleHiddenCount");
  if (node) node.textContent = count
    ? `当前来源「${scheduleSourceNames[source]}」已隐藏 ${count} 部；点右侧按钮查看与恢复`
    : `当前来源「${scheduleSourceNames[source]}」还没有隐藏任何番剧`;
  const manage = $("#scheduleHiddenManageFromFilter");
  if (manage) {
    const filterCount = scheduleHiddenCount(scheduleSource());
    manage.textContent = filterCount ? `查看已隐藏（${filterCount}）` : "查看已隐藏";
  }
  if ($("#scheduleHiddenModal")?.open) renderScheduleHiddenList();
}

function renderScheduleHiddenSources() {
  const host = $("#scheduleHiddenSources");
  if (!host) return;
  const current = scheduleHiddenModalSource();
  host.innerHTML = SCHEDULE_SOURCE_KEYS.map((source) => {
    const count = scheduleHiddenCount(source);   // ID 藏的和按标题藏的都算
    return `<button type="button" class="schedule-hidden-source${source === current ? " active" : ""}" data-hidden-source="${source}">${scheduleSourceNames[source]}${count ? ` · ${count}` : ""}</button>`;
  }).join("");
}

function renderScheduleHiddenList() {
  const host = $("#scheduleHiddenList");
  if (!host) return;
  renderScheduleHiddenSources();
  const source = scheduleHiddenModalSource();
  const label = scheduleSourceNames[source];
  const subtitle = $("#scheduleHiddenSubtitle");
  if (subtitle) subtitle.textContent = `隐藏只作用于「${label}」这一套周表，另外两套不受影响；取消隐藏后立即恢复。`;
  const ids = scheduleHiddenIds(source);
  const titles = scheduleHiddenTitles(source);
  const rows = [
    ...ids.map((id) => {
      const anime = state.animes.find((row) => Number(row.id) === id);
      // 收藏夹里没有的番只能显示 ID 太丑：先在当前周表数据里按 id 找一次名字。
      const scheduled = (scheduleState.data?.items || []).find((row) => Number(row.id) === id);
      const name = anime
        ? (anime.display_name || anime.name_cn || anime.name)
        : (scheduled?.title || `番剧 ${id}`);
      const cover = anime
        ? `<img src="/api/covers/${id}" alt="" loading="lazy" onerror="this.style.visibility='hidden'" />`
        : `<span class="schedule-hidden-thumb" aria-hidden="true"></span>`;
      return `<div class="schedule-hidden-item">${cover}<b>${escapeHtml(name)}</b><button type="button" class="secondary-button" data-schedule-unhide="${id}">取消隐藏</button></div>`;
    }),
    ...titles.map((title) => `<div class="schedule-hidden-item"><span class="schedule-hidden-thumb" aria-hidden="true"></span><b>${escapeHtml(title)}</b><em class="schedule-hidden-tag">按标题</em><button type="button" class="secondary-button" data-schedule-unhide-title="${escapeHtml(title)}">取消隐藏</button></div>`),
  ];
  host.innerHTML = rows.length
    ? rows.join("")
    : `<p class="page-subtitle">「${label}」还没有隐藏任何番剧。</p>`;
}

// 连点两张卡片时，两次保存都会「先读当前列表、再把新 id 拼上去」：
// 后一次读到的还是前一次写回来的旧列表，于是把前一次刚藏的又放了出来。
// 这里把写操作串起来，轮到谁执行时再读最新状态。
let scheduleHiddenWriteChain = Promise.resolve();
function queueScheduleHiddenWrite(task) {
  const next = scheduleHiddenWriteChain.then(task, task);
  scheduleHiddenWriteChain = next.catch(() => {});
  return next;
}

async function saveScheduleHidden(ids, source = scheduleSource()) {
  const map = scheduleHiddenMap();
  map[source] = [...new Set(ids.map(Number).filter((n) => n > 0))];
  const result = await api("/api/settings", {method: "PATCH", body: JSON.stringify({schedule_hidden: map})});
  const saved = result.settings?.schedule_hidden;
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) throw new Error("后台未保存隐藏列表，请重启手账后台后重试。");
  state.settings = result.settings;
  renderScheduleHiddenSettings();
  renderSchedule();
}

async function saveScheduleHiddenTitles(titles, source = scheduleSource()) {
  const map = scheduleHiddenTitleMap();
  const seen = new Set();
  map[source] = (titles || []).map((title) => String(title || "").trim()).filter((title) => {
    const key = scheduleTitleKey(title);
    if (!title || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const result = await api("/api/settings", {method: "PATCH", body: JSON.stringify({schedule_hidden_titles: map})});
  const saved = result.settings?.schedule_hidden_titles;
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) throw new Error("后台未保存隐藏列表，请重启手账后台后重试。");
  state.settings = result.settings;
  renderScheduleHiddenSettings();
  renderSchedule();
}

function renderScheduleSettings() {
  const settingsSource = scheduleSettingsSource();
  const settingsPrefs = schedulePreferences(settingsSource);
  const selector = $("#scheduleSettingsSource");
  if (selector && selector.value !== settingsSource) selector.value = settingsSource;
  $("#scheduleSourceInput").value = scheduleSource();
  $("#scheduleAiringSourceInput").value = state.settings.schedule_airing_source || "bgm";
  $("#scheduleSourceSwitchInput").checked = state.settings.show_schedule_source_switch !== false;
  renderScheduleSorting("#scheduleSortingSettings", null, settingsSource);
  $("#scheduleStatusInputs").innerHTML = scheduleStatusMarkup(settingsPrefs.statuses, "scheduleSettingsStatus");
  $("#scheduleOriginInputs").innerHTML = scheduleOriginMarkup(settingsPrefs.origins, "scheduleSettingsOrigin");
  $("#scheduleUncollectedInput").checked = settingsPrefs.uncollected;
  renderScheduleHiddenSettings();
  const visibility = scheduleCardVisibility();
  $("#scheduleCardFieldInputs").innerHTML = scheduleCardFieldOptions.map(([key, label, description]) =>
    `<label class="setting-row"><span><strong>${label}</strong><small>${description}</small></span><span class="switch-row compact"><input type="checkbox" data-schedule-field="${key}" ${visibility[key] ? "checked" : ""} /><span class="switch"></span></span></label>`).join("");
  // 这些行是动态生成的，重新挂一次说明问号。
  if (typeof setupSettingHelp === "function") setupSettingHelp();
}

// 筛选弹窗里的小字说明收进问号（和设置页同一套 interaction）：标题旁的问号讲
// 三套周表互相独立 + 会被记住；「排列方式」「显示地区」各有自己的说明。
function setupScheduleFilterHelp() {
  if (typeof appendSettingHelp !== "function") return;
  const dialog = $("#scheduleFilterModal");
  const heading = dialog?.querySelector("h2");
  if (!dialog || !heading) return;
  const note = (key) => dialog.querySelector(`[data-help="${key}"]`);
  const fieldTitle = (text) =>
    [...dialog.querySelectorAll(".schedule-field-title")].find((node) => node.textContent.trim().startsWith(text));
  appendSettingHelp(heading, heading, [note("tables"), note("remember")].filter(Boolean));
  const sortTitle = fieldTitle("排列方式");
  if (sortTitle) appendSettingHelp(sortTitle, sortTitle, [note("sort")].filter(Boolean));
  const originTitle = fieldTitle("显示地区");
  if (originTitle) appendSettingHelp(originTitle, originTitle, [note("regions")].filter(Boolean));
  const hiddenTitle = fieldTitle("隐藏的番剧");
  if (hiddenTitle) appendSettingHelp(hiddenTitle, hiddenTitle, [note("hidden")].filter(Boolean));
}

function openScheduleFilters() {
  const source = scheduleSource();
  const prefs = schedulePreferences(source);
  $("#scheduleFilterSourceLabel").textContent = `正在配置：${scheduleSourceNames[source]}`;
  renderScheduleSorting("#scheduleSortOptions", null, source);
  $("#scheduleFilterStatuses").innerHTML = scheduleStatusMarkup(prefs.statuses, "scheduleFilterStatus");
  $("#scheduleFilterOrigins").innerHTML = scheduleOriginMarkup(prefs.origins, "scheduleFilterOrigin");
  $("#scheduleFilterUncollected").checked = prefs.uncollected;
  // 打开筛选弹窗时刷新「查看已隐藏（N）」的计数，别显示上次的旧数字。
  renderScheduleHiddenSettings();
  setupScheduleFilterHelp();
  $("#scheduleFilterModal").showModal();
}

function showScheduleDetail(key) {
  const item = scheduleState.data?.items.find((row) => row.key === key); if (!item) return;
  const siteBase = String(state.settings.bgm_site_base || "https://bgm.tv").replace(/\/+$/, "");
  const anime = state.animes.find((row) => row.id === item.local_id || row.id === item.id);
  const keyword = String(anime?.name_cn || anime?.name || item.title || "").trim();
  let scheduleLinks = buildDetailLinkItems(scheduleDetailLinks(), { id: item.id || null, title: keyword, site: siteBase })
    .map((entry) => `<a href="${escapeHtml(entry.href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(entry.label)}</a>`)
    .join("");
  if (item.as_url && /^https:\/\/animeschedule\.net\/anime\/[a-z0-9-]+$/.test(item.as_url)) scheduleLinks += ` <a href="${escapeHtml(item.as_url)}" target="_blank" rel="noopener noreferrer">AnimeSchedule</a>`;
  const progress = scheduleProgress(item);
  const progressHtml = progress
    ? `<div class="schedule-detail-progress${progress.estimated ? " is-estimated" : ""}" title="${escapeHtml(progress.title)}"><strong>${escapeHtml(progress.text)}</strong>${progress.detail ? `<span>${escapeHtml(progress.detail)}</span>` : ""}</div>`
    : "";
  $("#scheduleDetail").innerHTML = `<p class="eyebrow">${item.kind === "network" ? "STREAMING RELEASE" : "WEEKLY AIRING"}</p><h2>${escapeHtml(item.title)}</h2><div class="schedule-detail-time">${item.kind === "weekly" ? `${scheduleDays[item.weekday - 1]} · ` : ""}${escapeHtml(scheduleTimeLabel(item))}</div>${progressHtml}<p>${escapeHtml(item.summary || "暂无匹配的 Bangumi 简介，可通过下方链接查看详细介绍。")}</p><div class="schedule-detail-facts"><span>评分 ${Number(item.score) > 0 ? Number(item.score).toFixed(1) : "暂无"}</span><span>${scheduleVotesLabel(item)}</span><span>${escapeHtml(item.release_note || "")}</span></div><div class="schedule-detail-links">${scheduleLinks}</div>${item.local_id && state.animes.some((a) => a.id === item.local_id) ? '<button type="button" class="primary-button" id="scheduleRecordProgress">记录观看进度</button>' : ""}`;
  $("#scheduleRecordProgress")?.addEventListener("click", () => {$("#scheduleDetailModal").close(); openProgress(item.local_id);});
  if(item.id) {
    if(collectionEditingSupported()){
      // 收藏状态和「记录观看进度」同一行：按钮在左，状态控件靠右下角。
      const footer=document.createElement("div");footer.className="schedule-detail-footer";
      const recordButton=$("#scheduleRecordProgress");
      if(recordButton)footer.append(recordButton);
      footer.append(collectionAction(item.id,anime?.collection_type||0));
      $("#scheduleDetail").append(footer);
    }
  }
  else {const note=document.createElement('p');note.textContent='该条目尚未关联 Bangumi ID，可在收藏夹的搜索添加中确认对应番剧。';$("#scheduleDetail").append(note);}
  $("#scheduleDetailModal").showModal();
}


// ===== 隐藏模式：从筛选弹窗回到周表，点卡片直接隐藏 =====
// 旧做法是在筛选弹窗里列一长条清单挨个点「隐藏」，离卡片上下文太远；
// 现在先把弹窗收起来、回到周表，卡片本身就是按钮，点哪张藏哪张。
function scheduleReduceMotion() {
  return Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches);
}

function openScheduleHiddenManager(source = scheduleSource()) {
  scheduleHiddenModalSourceValue = source;
  renderScheduleHiddenList();
  $("#scheduleHiddenModal")?.showModal();
}

// 弹窗收起要有个「退场」，否则界面会硬切；animationend 和超时双保险，
// 万一动画被系统关掉了也不会卡在关不掉的状态。
function closeScheduleDialogAnimated(dialog, after) {
  if (!dialog?.open) { after?.(); return; }
  if (scheduleReduceMotion()) { dialog.close(); after?.(); return; }
  let finished = false;
  let timer = 0;
  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    dialog.classList.remove("is-closing");
    try { dialog.close(); } catch (error) { /* 已经关掉了 */ }
    after?.();
  };
  dialog.addEventListener("animationend", finish, {once: true});
  timer = window.setTimeout(finish, 260);
  dialog.classList.add("is-closing");
}

function enterSchedulePickMode() {
  if (scheduleState.pickHidden) return;
  scheduleState.pickHidden = true;
  if (typeof switchView === "function" && state.activeView !== "schedule") switchView("schedule");
  $("#scheduleView")?.classList.add("pick-mode");
  // 右下角那颗「排序与筛选」浮钮会和工具条右侧的「完成」叠在一起，隐藏模式里先让它退场。
  document.body.classList.add("schedule-picking");
  renderSchedule();
  // 不主动滚动：弹窗关掉后用户本来就在原位，硬滚一下反而像页面跳了。
  window.setTimeout(() => schedulePulseCards(), 160);
}

function exitSchedulePickMode() {
  if (!scheduleState.pickHidden) return;
  scheduleState.pickHidden = false;
  $("#scheduleView")?.classList.remove("pick-mode");
  document.body.classList.remove("schedule-picking");
  $$("#scheduleGrid .schedule-card").forEach((card) => card.classList.remove("pick-in", "is-hiding"));
  updateSchedulePickBar();
  renderSchedule();
}

// 卡片逐个亮一下，告诉用户「现在这些都能点」。
function schedulePulseCards() {
  const cards = $$("#scheduleGrid .schedule-card");
  if (!cards.length || scheduleReduceMotion()) return;
  cards.forEach((card, index) => {
    if (card.classList.contains("is-hiding")) return;
    card.style.setProperty("--pick-delay", `${Math.min(index, 14) * 16}ms`);
    card.classList.add("pick-in");
    card.addEventListener("animationend", () => {
      card.classList.remove("pick-in");
      card.style.removeProperty("--pick-delay");
    }, {once: true});
  });
}

// 工具条：显示/隐藏都走 is-in / is-out，别直接切 hidden 造成硬跳。
function updateSchedulePickBar() {
  const bar = $("#schedulePickBar");
  if (!bar) return;
  const countNode = $("#schedulePickCount");
  if (countNode) countNode.textContent = String(scheduleHiddenCount(scheduleSource()));
  const cards = $$("#scheduleGrid .schedule-card").length;
  const hint = $("#schedulePickHint");
  if (hint) {
    hint.textContent = !scheduleState.data
      ? "正在读取周表，卡片出来就能点了…"
      : cards
        ? "点任意一张卡片，把它从这套周表里藏起来；换星期可以接着挑"
        : "这一天已经没有能挑的番剧了，换个星期继续，或者点「完成」";
  }
  if (scheduleState.pickHidden) {
    if (bar.classList.contains("hidden")) {
      bar.classList.remove("hidden", "is-out");
      void bar.offsetWidth;            // 先落一帧，is-in 的过渡才有起点
      bar.classList.add("is-in");
    }
    return;
  }
  if (!bar.classList.contains("hidden")) {
    bar.classList.remove("is-in");
    bar.classList.add("is-out");
    window.setTimeout(() => {
      if (!scheduleState.pickHidden) { bar.classList.add("hidden"); bar.classList.remove("is-out"); }
    }, 220);
  }
}

// 隐藏一张卡片：记下其它卡片的位置 → 卡片缩掉 → 写设置 → 剩下的滑到新位置。
function scheduleFlipCapture() {
  const map = new Map();
  $$("#scheduleGrid .schedule-card").forEach((card) => map.set(card.dataset.scheduleKey, card.getBoundingClientRect()));
  return map;
}

function scheduleFlipPlay(before) {
  if (!before?.size || scheduleReduceMotion()) return;
  $$("#scheduleGrid .schedule-card").forEach((card) => {
    const prev = before.get(card.dataset.scheduleKey);
    if (!prev) { card.classList.add("flip-enter"); return; }
    const now = card.getBoundingClientRect();
    const dx = prev.left - now.left, dy = prev.top - now.top;
    if (!dx && !dy) return;
    card.style.transition = "none";
    card.style.transform = `translate(${dx}px, ${dy}px)`;
    requestAnimationFrame(() => {
      card.classList.add("flip-moving");
      card.style.transition = "";
      card.style.transform = "";
      window.setTimeout(() => card.classList.remove("flip-moving"), 470);
    });
  });
}

async function hideScheduleCard(button, key) {
  if (button.dataset.hiding === "1") return;
  const item = scheduleState.data?.items.find((row) => row.key === key);
  if (!item) return;
  // 有 Bangumi ID 的按 ID 藏；没有的（AS 的国漫等）按标题藏——不因为「没关联」就拦着。
  const byId = Number(item.id) > 0;
  const title = String(item.title || "").trim();
  if (!byId && !title) {
    button.classList.add("pick-nudge");
    window.setTimeout(() => button.classList.remove("pick-nudge"), 420);
    toast("这个条目既没有 Bangumi 关联、也没有标题，藏不了", "error");
    return;
  }
  const before = scheduleFlipCapture();
  const source = scheduleSource();
  const name = title || "这部番";
  button.dataset.hiding = "1";
  button.classList.add("is-hiding");
  button.setAttribute("aria-hidden", "true");
  await new Promise((resolve) => window.setTimeout(resolve, scheduleReduceMotion() ? 0 : 190));
  try {
    if (byId) {
      await queueScheduleHiddenWrite(() => saveScheduleHidden([...scheduleHiddenIds(source), Number(item.id)], source));
    } else {
      await queueScheduleHiddenWrite(() => saveScheduleHiddenTitles([...scheduleHiddenTitles(source), title], source));
    }
    requestAnimationFrame(() => scheduleFlipPlay(before));
    toast(`已隐藏「${name}」 · 「查看已隐藏」里随时能恢复`);
  } catch (error) {
    button.classList.remove("is-hiding");
    button.removeAttribute("aria-hidden");
    delete button.dataset.hiding;
    toast(error.message, "error");
  }
}

function initializeSchedule() {
  if (scheduleState.initialized) return;
  scheduleState.initialized = true;
  const today = scheduleToday();
  scheduleState.day = today.day;
  scheduleState.season = `${today.year}${String(Math.floor((today.month - 1) / 3) * 3 + 1).padStart(2, "0")}`;
  $("#schedulePreviousWeek").onclick = () => moveScheduleWeek(-1);
  $("#scheduleNextWeek").onclick = () => moveScheduleWeek(1);
  $("#scheduleSourceSwitch").onchange = async (event) => {
    const source = event.target.value;
    const control = $("#scheduleSourceSwitch");
    control.disabled = true;
    try {
      const payload = await api("/api/settings", {method: "PATCH", body: JSON.stringify({schedule_source: source})});
      if (payload.settings?.schedule_source !== source) throw new Error("当前后台不支持周表来源切换，请重启后台后刷新页面。");
      state.settings = payload.settings;
      scheduleState.data = null;
      scheduleState.shown = 30;
      if (source === "as" && scheduleState.day === 0) scheduleState.day = scheduleToday().day;
      renderScheduleSettings();
      loadSchedule();
    } catch (error) { $("#scheduleSourceSwitch").value = scheduleSource(); toast(error.message, "error"); }
    finally { control.disabled = false; }
  };
  $("#scheduleRefresh").onclick = () => loadSchedule(true);
  $("#scheduleFilterButton").onclick = openScheduleFilters;
  $("#scheduleSettingsSource")?.addEventListener("change", (event) => {
    scheduleSettingsSourceValue = event.target.value;
    renderScheduleSettings();
  });
  // 两处入口共用同一个管理弹窗，各自带上自己的来源：设置页跟「配置哪一套周表」，
  // 筛选弹窗跟当前正在看的周表。
  $("#scheduleHiddenManage")?.addEventListener("click", () => openScheduleHiddenManager(scheduleSettingsSource()));
  // 设置页的「去周表设置」：关掉设置，跳到周表并直接打开排序与筛选。
  $("#scheduleHiddenGoFilter")?.addEventListener("click", () => {
    $("#settingsModal")?.close();
    if (typeof switchView === "function") switchView("schedule");
    setTimeout(() => {
      if (typeof openScheduleFilters === "function") openScheduleFilters();
    }, 220);
  });
  $("#scheduleHiddenManageFromFilter")?.addEventListener("click", () => openScheduleHiddenManager(scheduleSource()));
  // 筛选弹窗里的「去周表里选」：先让弹窗退场，再进隐藏模式，两段动画不打架。
  $("#scheduleHiddenEnterPick")?.addEventListener("click", () => {
    closeScheduleDialogAnimated($("#scheduleFilterModal"), () => {
      requestAnimationFrame(() => enterSchedulePickMode());
    });
  });
  $("#schedulePickDone")?.addEventListener("click", () => exitSchedulePickMode());
  $("#schedulePickManage")?.addEventListener("click", () => openScheduleHiddenManager(scheduleSource()));
  document.addEventListener("keydown", (event) => {
    if (!scheduleState.pickHidden || event.key !== "Escape" || event.defaultPrevented) return;
    if (document.querySelector("dialog[open]")) return;
    event.preventDefault();
    exitSchedulePickMode();
  });
  $("#scheduleHiddenSources")?.addEventListener("click", (event) => {
    const chip = event.target.closest("[data-hidden-source]");
    if (!chip) return;
    scheduleHiddenModalSourceValue = chip.dataset.hiddenSource;
    renderScheduleHiddenList();
  });
  $("#scheduleHiddenList")?.addEventListener("click", async (event) => {
    const byTitle = event.target.closest("[data-schedule-unhide-title]");
    if (byTitle) {
      const source = scheduleHiddenModalSource();
      const key = scheduleTitleKey(byTitle.dataset.scheduleUnhideTitle);
      try {
        await queueScheduleHiddenWrite(() => saveScheduleHiddenTitles(scheduleHiddenTitles(source).filter((title) => scheduleTitleKey(title) !== key), source));
        renderScheduleHiddenList();
        toast("已恢复显示");
      } catch (error) { toast(error.message, "error"); }
      return;
    }
    const button = event.target.closest("[data-schedule-unhide]");
    if (!button) return;
    const source = scheduleHiddenModalSource();
    try {
      await queueScheduleHiddenWrite(() => saveScheduleHidden(scheduleHiddenIds(source).filter((id) => id !== Number(button.dataset.scheduleUnhide)), source));
      renderScheduleHiddenList();
      toast("已恢复显示");
    } catch (error) { toast(error.message, "error"); }
  });
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
      const source = scheduleSource();
      const preferences = {...(state.settings.schedule_preferences || {})};
      preferences[source] = {
        schedule_sort: sorting.schedule_sort,
        schedule_grouping: sorting.schedule_grouping,
        schedule_statuses: $$("#scheduleFilterStatuses input:checked").map((input) => Number(input.value)),
        schedule_origins: $$("#scheduleFilterOrigins input:checked").map((input) => input.value),
        schedule_uncollected: $("#scheduleFilterUncollected").checked,
      };
      const result = await api("/api/settings", {method: "PATCH", body: JSON.stringify({schedule_preferences: preferences})});
      verifySchedulePreferencesSaved(result.settings, source, preferences[source]);
      state.settings = result.settings; scheduleState.shown = 30;
      $("#scheduleFilterModal").close(); renderScheduleSettings(); renderSchedule();
    } catch (error) {toast(error.message, "error");}
    finally {button.disabled = false;}
  };
}
