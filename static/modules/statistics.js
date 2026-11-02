function statisticsMetricLabel() {
  return state.statisticsType === "watch" ? "观看集数" : "记录条数";
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

function statisticsDateLabel(label) {
  const value = String(label || "");
  if (state.statisticsPeriod === "day" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return `${value.slice(5, 7)}/${value.slice(8, 10)}`;
  }
  if (state.statisticsPeriod === "week") {
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
  if (state.statisticsPeriod === "month" && /^\d{4}-\d{2}$/.test(value)) {
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
  const metric = state.statisticsType === "watch" ? "episodes" : "records";
  return series.filter(item => Number(item[metric] || 0) !== 0);
}

function renderStatisticsChart(series) {
  const chart = $("#statisticsChart");
  const metric = state.statisticsType === "watch" ? "episodes" : "records";
  const max = Math.max(1, ...series.map((item) => Number(item[metric] || 0)));
  chart.innerHTML = series.length
    ? `<div class="statistics-bars">${series.map((item) => {
        const value = Number(item[metric] || 0);
        const height = value > 0 ? Math.max(6, Math.round((value / max) * 100)) : 0;
        return `<div class="statistics-bar-item" title="${escapeHtml(statisticsPeriodTitle(item.label))}：${value} ${statisticsMetricLabel()}">
          <span class="statistics-value">${value}</span>
          <div class="statistics-bar-track">${value > 0 ? `<div class="statistics-bar-fill" style="height:${height}%"></div>` : ""}</div>
          <span class="statistics-label" title="${escapeHtml(statisticsPeriodTitle(item.label))}">${escapeHtml(statisticsDateLabel(item.label))}</span>
        </div>`;
      }).join("")}</div>`
    : `<div class="statistics-empty">这个时间范围还没有对应记录。</div>`;
  const bars = $(".statistics-bars", chart);
  if (bars) requestAnimationFrame(() => { bars.scrollLeft = bars.scrollWidth; });
}

async function renderStatistics() {
  try {
    renderStatisticsTypeControls();
    const result = await api(`/api/statistics?period=${state.statisticsPeriod}&type=${state.statisticsType}`);
    const series = visibleStatisticsSeries(result.series);
    const metric = state.statisticsType === "watch" ? "episodes" : "records";
    const total = series.reduce((sum, item) => sum + Number(item[metric] || 0), 0);
    const balance = result.balance;
    const balanceHtml = balance?.enabled
      ? `<span class="statistics-balance ${Number(balance.value) > 0 ? "owing" : Number(balance.value) < 0 ? "ahead" : "even"}">${Number(balance.value) > 0 ? `还欠 ${balance.value} 集` : Number(balance.value) < 0 ? `超出 ${Math.abs(Number(balance.value))} 集` : "正好完成计划"}</span>`
      : "";
    $("#statisticsSummary").innerHTML = `<strong>${total}</strong><span>${statisticsMetricLabel()} · ${series.length} 个统计周期</span>${balanceHtml}`;
    renderStatisticsChart(series);
  } catch (error) {
    $("#statisticsChart").innerHTML = `<div class="statistics-empty">${escapeHtml(error.message)}</div>`;
  }
}

