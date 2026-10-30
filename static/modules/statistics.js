function statisticsMetricLabel() {
  return state.statisticsType === "watch" ? "观看集数" : "记录条数";
}

function statisticsDateLabel(label) {
  const value = String(label || "");
  if (state.statisticsPeriod === "day" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return `${value.slice(5, 7)}/${value.slice(8, 10)}`;
  }
  if (state.statisticsPeriod === "week") return value.replace("-W", " W");
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
        return `<div class="statistics-bar-item" title="${escapeHtml(item.label)}：${value} ${statisticsMetricLabel()}">
          <span class="statistics-value">${value}</span>
          <div class="statistics-bar-track">${value > 0 ? `<div class="statistics-bar-fill" style="height:${height}%"></div>` : ""}</div>
          <span class="statistics-label">${escapeHtml(statisticsDateLabel(item.label))}</span>
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

