let statisticsMode = "bars";
let statisticsMetric = "auto";
let statisticsWindow = 0;
let statisticsRequest = 0;
let statisticsData = null;
const STATISTICS_PAGE_SIZE = 16;
const STATISTICS_PERIOD_LABELS = { day: "日", week: "周", month: "月", year: "年" };
const STATISTICS_ACTIVITY_LABELS = { day: "活跃天数", week: "活跃周数", month: "活跃月数", year: "活跃年数" };

function statisticsPeriod() {
  return statisticsMode === "calendar" ? "day" : state.statisticsPeriod;
}

function statisticsMetricKey() {
  return statisticsMetric === "auto"
    ? (state.statisticsType === "watch" ? "episodes" : "records")
    : statisticsMetric;
}

function statisticsMetricLabel() {
  return statisticsMetricKey() === "episodes" ? "观看集数" : "记录条数";
}

// ISO 周（周一为起点）换算成具体日期，用来把 "2026-W28" 变成能看懂的日子。
function isoWeekStart(year, week) {
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const offset = (jan4.getUTCDay() + 6) % 7;
  return new Date(jan4.getTime() + ((week - 1) * 7 - offset) * 86400000);
}

function statisticsWeekRange(label) {
  const match = /^(\d{4})-W(\d{2})$/.exec(String(label || ""));
  if (!match) return null;
  const week = Number(match[2]);
  if (week < 1 || week > 53) return null;
  const start = isoWeekStart(Number(match[1]), week);
  return { start, end: new Date(start.getTime() + 6 * 86400000) };
}

function statisticsDateLabel(label, period = statisticsPeriod()) {
  const value = String(label || "");
  if (period === "day" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return `${value.slice(5, 7)}/${value.slice(8, 10)}`;
  }
  if (period === "week") {
    // 周号本身看不出是哪几天，横轴直接显示这一周的日期区间（同月省略重复的月份）。
    const range = statisticsWeekRange(value);
    if (range) {
      const startMonth = range.start.getUTCMonth() + 1;
      const endMonth = range.end.getUTCMonth() + 1;
      return startMonth === endMonth
        ? `${startMonth}/${range.start.getUTCDate()}–${range.end.getUTCDate()}`
        : `${startMonth}/${range.start.getUTCDate()}–${endMonth}/${range.end.getUTCDate()}`;
    }
  }
  if (period === "month" && /^\d{4}-\d{2}$/.test(value)) {
    return value.replace("-", "/");
  }
  return value;
}

// 悬停时给出完整说法，横轴太窄写不下的年份和周号放这里。
function statisticsPeriodTitle(label) {
  const value = String(label || "");
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (day) return `${Number(day[1])} 年 ${Number(day[2])} 月 ${Number(day[3])} 日`;
  const week = /^(\d{4})-W(\d{2})$/.exec(value);
  if (week) {
    const range = statisticsWeekRange(value);
    if (!range) return value;
    return `${week[1]} 年第 ${Number(week[2])} 周 · ${range.start.getUTCMonth() + 1} 月 ${range.start.getUTCDate()} 日 – ${range.end.getUTCMonth() + 1} 月 ${range.end.getUTCDate()} 日`;
  }
  const month = /^(\d{4})-(\d{2})$/.exec(value);
  if (month) return `${Number(month[1])} 年 ${Number(month[2])} 月`;
  return value;
}

function statisticsDefaultTheme() {
  const available = new Set(["all", ...allRecordThemes().map((theme) => theme.id)]);
  const configured = String(state.settings?.statistics_default_theme || "watch");
  return available.has(configured) ? configured : "watch";
}

function renderStatisticsTypeControls() {
  const select = $("#statisticsTypeSelect");
  if (!select) return;
  const themes = allRecordThemes();
  const validIds = new Set(["all", ...themes.map((theme) => theme.id)]);
  if (!validIds.has(state.statisticsType)) state.statisticsType = "all";
  select.innerHTML = [
    '<option value="all">全部记录</option>',
    ...themes.map((theme) => `<option value="${escapeHtml(theme.id)}">${escapeHtml(theme.name)}</option>`),
  ].join("");
  select.value = state.statisticsType;
}

function visibleStatisticsSeries(series) {
  if (enabledSetting("statistics_show_zero_periods")) return series;
  const metric = statisticsMetricKey();
  return series.filter(item => Number(item[metric] || 0) !== 0);
}

function statisticsDateRange(label, period) {
  if (period === "day" && /^\d{4}-\d{2}-\d{2}$/.test(label)) return [label, label];
  if (period === "week") {
    const range = statisticsWeekRange(label);
    if (range) return [range.start, range.end].map(date => date.toISOString().slice(0, 10));
  }
  if (period === "month" && /^\d{4}-\d{2}$/.test(label)) {
    const [year, month] = label.split("-").map(Number);
    return [`${label}-01`, new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10)];
  }
  if (period === "year" && /^\d{4}$/.test(label)) return [`${label}-01-01`, `${label}-12-31`];
  return null;
}

function statisticsPointLabel(item, value) {
  return `${statisticsPeriodTitle(item.label)}：${value} ${statisticsMetricLabel()}`;
}

function statisticsBars(series, values, max) {
  return `<div class="statistics-bars">${series.map((item, index) => {
    const value = values[index];
    const title = escapeHtml(statisticsPointLabel(item, value));
    return `<button type="button" class="statistics-bar-item" data-period-index="${index}" title="${title}" aria-label="${title}">
      <span class="statistics-value">${value}</span>
      <span class="statistics-bar-track">${value ? `<span class="statistics-bar-fill" style="height:${value / max * 100}%"></span>` : ""}</span>
      <span class="statistics-label">${escapeHtml(statisticsDateLabel(item.label))}</span>
    </button>`;
  }).join("")}</div>`;
}

function statisticsLine(series, values, max, previousTotal) {
  const cumulative = statisticsMode === "cumulative";
  let total = previousTotal;
  const heights = values.map(value => {
    total += value;
    return (cumulative ? total : value) / max;
  });
  return {
    heights,
    markup: `<div class="statistics-line-scroll"><div class="statistics-line" style="--point-count:${series.length}">
      <div class="statistics-line-plot"><canvas width="1200" height="440" aria-hidden="true"></canvas>
      ${series.map((item, index) => {
        const value = values[index];
        const running = Math.round(heights[index] * max);
        const title = escapeHtml(statisticsPointLabel(item, value) + (cumulative ? `，累计 ${running}` : ""));
        return `<button type="button" class="statistics-line-point" data-period-index="${index}" style="--x:${(index + .5) / series.length * 100}%;--y:${(1 - heights[index]) * 100}%" aria-label="${title}" title="${title}"><span>${cumulative ? running : value}</span></button>`;
      }).join("")}</div>
      <div class="statistics-line-labels">${series.map(item => `<span class="statistics-label">${escapeHtml(statisticsDateLabel(item.label))}</span>`).join("")}</div>
    </div></div>`,
  };
}

function drawStatisticsLine(canvas, heights) {
  const context = canvas.getContext("2d");
  if (!context) return;
  const { width, height } = canvas;
  const points = heights.map((value, index) => [(index + .5) * width / heights.length, (1 - value) * height]);
  const accent = getComputedStyle(canvas).color;
  context.beginPath();
  points.forEach(([x, y], index) => index ? context.lineTo(x, y) : context.moveTo(x, y));
  context.lineWidth = 3;
  context.lineJoin = "round";
  context.strokeStyle = accent;
  context.stroke();
  context.lineTo(points.at(-1)[0], height);
  context.lineTo(points[0][0], height);
  context.closePath();
  context.globalAlpha = .12;
  context.fillStyle = accent;
  context.fill();
}

function statisticsTable(series, values) {
  return `<table class="statistics-table"><thead><tr><th scope="col">时段</th><th scope="col">${statisticsMetricLabel()}</th></tr></thead><tbody>
    ${series.map((item, index) => `<tr><th scope="row"><button type="button" data-period-index="${index}">${escapeHtml(statisticsPeriodTitle(item.label))}</button></th><td>${values[index]}</td></tr>`).reverse().join("")}
  </tbody></table>`;
}

function statisticsCalendar(series, values, max, month) {
  const lookup = new Map(series.map((item, index) => [item.label, index]));
  const year = month.getUTCFullYear();
  const monthIndex = month.getUTCMonth();
  const blanks = (month.getUTCDay() + 6) % 7;
  const dates = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  return `<div class="statistics-calendar"><div class="statistics-calendar-grid">
    ${["一", "二", "三", "四", "五", "六", "日"].map(day => `<span class="statistics-calendar-weekday">周${day}</span>`).join("")}
    ${'<span aria-hidden="true"></span>'.repeat(blanks)}
    ${Array.from({length: dates}, (_, index) => {
      const date = index + 1;
      const key = new Date(Date.UTC(year, monthIndex, date)).toISOString().slice(0, 10);
      const itemIndex = lookup.get(key);
      if (itemIndex === undefined) return `<span class="statistics-calendar-day" aria-label="${escapeHtml(statisticsPeriodTitle(key))}">${date}</span>`;
      const value = values[itemIndex];
      const level = Math.ceil(value / max * 4);
      const title = escapeHtml(statisticsPointLabel(series[itemIndex], value));
      return `<button type="button" class="statistics-calendar-day" data-level="${level}" data-period-index="${itemIndex}" title="${title}" aria-label="${title}"><span>${date}</span><strong>${value || ""}</strong></button>`;
    }).join("")}
    </div><div class="statistics-calendar-legend" aria-label="颜色越深代表越活跃">少 ${[1, 2, 3, 4].map(level => `<i data-level="${level}"></i>`).join("")} 多</div>
  </div>`;
}

function renderStatisticsChart(series, { month, previousTotal = 0, max = 0 } = {}) {
  const chart = $("#statisticsChart");
  const period = statisticsPeriod();
  const type = state.statisticsType;
  const values = series.map(item => Number(item[statisticsMetricKey()] || 0));
  const hasData = series.length > 0 || month;
  const scale = Math.max(1, max, ...values);
  let line;
  if (hasData && ["trend", "cumulative"].includes(statisticsMode)) line = statisticsLine(series, values, scale, previousTotal);
  chart.innerHTML = !hasData ? '<div class="statistics-empty">当前筛选没有可显示的统计。</div>'
    : line ? line.markup
    : statisticsMode === "table" ? statisticsTable(series, values)
    : month ? statisticsCalendar(series, values, scale, month)
    : statisticsBars(series, values, scale);
  if (line) drawStatisticsLine($("canvas", chart), line.heights);
  const scrollable = $(".statistics-bars, .statistics-line-scroll", chart);
  if (scrollable) scrollable.scrollLeft = scrollable.scrollWidth;
  chart.onclick = event => {
    const button = event.target.closest("[data-period-index]");
    if (!button) return;
    const item = series[Number(button.dataset.periodIndex)];
    const range = item && statisticsDateRange(item.label, period);
    if (!range) return;
    applyTimelineDefaults();
    state.timelineThemes = new Set(type === "all" ? [] : [type]);
    state.timelineSearch = "";
    $("#timelineSearchInput").value = "";
    setTimelineDateRange(...range);
    switchView("timeline");
  };
}

function statisticsQuery() {
  return new URLSearchParams({ period: statisticsPeriod(), type: state.statisticsType }).toString();
}

function statisticsDataKey() {
  return `${state.active_profile?.id || ""}:${statisticsQuery()}`;
}

function statisticsNavigation(note, last) {
  const label = $("#statisticsWindowNote");
  if (!label) return;
  label.textContent = note;
  $("#statisticsNavigation").hidden = last === 0;
  $("#statisticsOlder").disabled = statisticsWindow >= last;
  $("#statisticsNewer").disabled = statisticsWindow === 0;
  $("#statisticsLatest").disabled = statisticsWindow === 0;
}

function redrawStatistics() {
  if (statisticsData?.key !== statisticsDataKey()) return;
  const { series, balance } = statisticsData.result;
  const visible = visibleStatisticsSeries(series);
  const metric = statisticsMetricKey();
  const { total, peak, active } = visible.reduce((summary, item) => {
    const value = Number(item[metric] || 0);
    summary.total += value;
    summary.peak = Math.max(summary.peak, value);
    summary.active += Number(value > 0);
    return summary;
  }, {total: 0, peak: 0, active: 0});
  const unit = metric === "episodes" ? "集" : "条";
  const period = statisticsPeriod();
  const balanceValue = Number(balance?.value) || 0;
  const balanceHtml = balance?.enabled
    ? `<span class="statistics-balance ${balanceValue > 0 ? "owing" : balanceValue < 0 ? "ahead" : "even"}">${balanceValue > 0 ? `还欠 ${balanceValue} 集` : balanceValue < 0 ? `超出 ${Math.abs(balanceValue)} 集` : "正好完成计划"}</span>`
    : "";
  $("#statisticsSummary").innerHTML = `<div><span>${statisticsMetricLabel()}</span><strong>${total}</strong></div>
    <div><span>${STATISTICS_ACTIVITY_LABELS[period]}</span><strong>${active}</strong></div>
    <div><span>单${STATISTICS_PERIOD_LABELS[period]}最高</span><strong>${peak}</strong><small>${unit}</small></div>${balanceHtml}`;
  if (statisticsMode === "calendar" && visible.length) {
    const first = new Date(`${visible[0].label}T00:00:00Z`);
    const last = new Date(`${visible.at(-1).label}T00:00:00Z`);
    const span = (last.getUTCFullYear() - first.getUTCFullYear()) * 12 + last.getUTCMonth() - first.getUTCMonth();
    statisticsWindow = Math.min(statisticsWindow, span);
    const month = new Date(Date.UTC(last.getUTCFullYear(), last.getUTCMonth() - statisticsWindow, 1));
    const monthKey = month.toISOString().slice(0, 7);
    statisticsNavigation(`${month.getUTCFullYear()} 年 ${month.getUTCMonth() + 1} 月`, span);
    renderStatisticsChart(visible.filter(item => item.label.startsWith(monthKey)), {month, max: peak});
    return;
  }
  const last = Math.max(0, Math.ceil(visible.length / STATISTICS_PAGE_SIZE) - 1);
  statisticsWindow = Math.min(statisticsWindow, last);
  const end = visible.length - statisticsWindow * STATISTICS_PAGE_SIZE;
  const start = Math.max(0, end - STATISTICS_PAGE_SIZE);
  const page = visible.slice(start, end);
  const cumulative = statisticsMode === "cumulative";
  const previousTotal = cumulative ? visible.slice(0, start).reduce((sum, item) => sum + Number(item[metric] || 0), 0) : 0;
  statisticsNavigation(page.length
    ? `${statisticsPeriodTitle(page[0].label)} 至 ${statisticsPeriodTitle(page.at(-1).label)} · 共 ${visible.length} 个统计周期`
    : "无统计周期", last);
  renderStatisticsChart(page, { previousTotal, max: cumulative ? total : peak });
}

function renderStatisticsControls() {
  const view = $("#statisticsView");
  if (!view) return;
  $("#statisticsPeriods").hidden = statisticsMode === "calendar";
  $$("[data-stat-mode], [data-stat-period]", view).forEach(button => {
    const active = button.dataset.statMode ? button.dataset.statMode === statisticsMode : button.dataset.statPeriod === statisticsPeriod();
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

async function renderStatistics() {
  const request = ++statisticsRequest;
  renderStatisticsTypeControls();
  renderStatisticsControls();
  const key = statisticsDataKey();
  if (statisticsData?.key !== key) {
    statisticsWindow = 0;
    statisticsNavigation("", 0);
    $("#statisticsSummary").innerHTML = "";
    $("#statisticsChart").innerHTML = '<div class="statistics-empty">正在读取统计…</div>';
  }
  try {
    const result = await api(`/api/statistics?${statisticsQuery()}`);
    if (request !== statisticsRequest || key !== statisticsDataKey()) return;
    statisticsData = {key, result};
    redrawStatistics();
  } catch (error) {
    if (request !== statisticsRequest || key !== statisticsDataKey()) return;
    statisticsData = null;
    statisticsNavigation("", 0);
    $("#statisticsSummary").replaceChildren();
    $("#statisticsChart").innerHTML = `<div class="statistics-empty">${escapeHtml(error.message)}</div>`;
  }
}

if ($("#statisticsView")) {
  $$("[data-stat-mode]").forEach(button => button.addEventListener("click", () => {
    if (statisticsMode === button.dataset.statMode) return;
    const period = statisticsPeriod();
    statisticsMode = button.dataset.statMode;
    statisticsWindow = 0;
    renderStatisticsControls();
    if (period !== statisticsPeriod()) renderStatistics();
    else redrawStatistics();
  }));
  $$("[data-stat-period]").forEach(button => button.addEventListener("click", () => {
    state.statisticsPeriod = button.dataset.statPeriod;
    renderStatistics();
  }));
  $("#statisticsTypeSelect").addEventListener("change", event => {
    state.statisticsType = event.target.value;
    renderStatistics();
  });
  $("#statisticsMetricSelect").addEventListener("change", event => {
    statisticsMetric = event.target.value;
    statisticsWindow = 0;
    redrawStatistics();
  });
  $("#statisticsOlder").onclick = () => { statisticsWindow++; redrawStatistics(); };
  $("#statisticsNewer").onclick = () => { statisticsWindow--; redrawStatistics(); };
  $("#statisticsLatest").onclick = () => { statisticsWindow = 0; redrawStatistics(); };
}
