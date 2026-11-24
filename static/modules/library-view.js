// ===== 动漫库侧边栏：媒体库 / 订阅管理 / 找资源 =====
// 数据全部来自现成接口：/api/offline/library、/api/offline/state、
// /api/offline/subscriptions、/api/offline/search、/api/offline/download。
// 播放/删除复用 offline.js 的 playLocalFile / removeLocalFile。

const librarySidebar = {
  tab: "media",
  kind: "video",       // video / image：媒体库里的视频与截图两个视图
  imageGroups: [],
  imageFlat: [],
  imageIndex: 0,
  imageRoot: "",
  imageTotal: 0,
  imageFolder: "",     // 图片库里选中的分组（空 = 全部）
  imageSelecting: false,
  imageSelected: new Set(),   // 多选要删的截图（存 relative）
  imagesLoaded: false,
  items: [],
  disk: null,
  filter: "all",
  query: "",
  sort: "recent",
  token: 0,
  loaded: false,
  loadedAt: 0,        // 上次成功拉到列表的时间戳，用来做 30 秒缓存
  detail: null,       // 打开的番 { animeId, name }
  playToken: 0,
  files: [],
  missing: 0,         // 详情里「记录还在、文件不在」的集数
  jobs: [],
  sourceFilter: "",   // 选中的字幕组（多来源时）
  subs: [],
  subsLoaded: false,
  resourceSearch: null,
  heroKey: "",        // 已经渲染过的续看横幅（避免搜索时反复重建图片）
};

// 来回切页签时没必要每次都重新扫一遍媒体库目录：30 秒内直接用上次的结果，
// 超过窗口、点了刷新、或刚删/刚下载过才重新拉。
const LIB_CACHE_MS = 30000;

const LIB_SORT_OPTIONS = [
  { id: "recent", label: "最近更新" },
  { id: "watched", label: "续看优先" },
  { id: "progress", label: "观看进度" },
  { id: "name", label: "名称" },
  { id: "size", label: "占用空间" },
  { id: "episodes", label: "已收集数" },
];

function libBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value >= (1 << 30)) return `${(value / (1 << 30)).toFixed(value >= 10 * (1 << 30) ? 0 : 1)} GB`;
  if (value >= (1 << 20)) return `${Math.round(value / (1 << 20))} MB`;
  return `${Math.max(1, Math.round(value / 1024))} KB`;
}

// 侧边栏显示开关：show / hide / auto（媒体库为空时隐藏）。
async function applyLibrarySidebarVisibility() {
  const button = $("#libraryNavButton");
  if (!button) return;
  const mode = state.settings?.library_sidebar || "show";
  let hide = false;
  if (mode === "hide") hide = true;
  else if (mode === "auto") {
    try {
      if (!librarySidebar.loaded) {
        const data = await api("/api/offline/library");
        librarySidebar.items = data.items || [];
        librarySidebar.disk = data.disk || null;
        librarySidebar.loaded = true;
        librarySidebar.loadedAt = Date.now();
      }
      hide = librarySidebar.items.length === 0;
    } catch (error) { hide = false; }
  }
  button.classList.toggle("hidden", hide);
  if (hide && state.activeView === "library") switchView("collection");
}

function renderLibrarySidebarView() {
  switchLibraryTab(librarySidebar.tab || "media");
  applyLibrarySidebarVisibility();
}

function switchLibraryTab(tab) {
  librarySidebar.playToken += 1;
  librarySidebar.tab = tab;
  $$(".library-tab").forEach((item) => {
    const active = item.dataset.libraryTab === tab;
    item.classList.toggle("active", active);
    item.setAttribute("aria-selected", String(active));
  });
  // 详情是「替换」不是「追加」：否则详情会排在总览下面，得往下滚才看得见。
  $("#libraryMediaPanel")?.classList.toggle("hidden", tab !== "media" || Boolean(librarySidebar.detail));
  $("#libraryDetailPanel")?.classList.toggle("hidden", tab !== "media" || !librarySidebar.detail);
  $("#librarySubsPanel")?.classList.toggle("hidden", tab !== "subs");
  $("#librarySearchPanel")?.classList.toggle("hidden", tab !== "search");
  if (tab === "media") loadLibrarySidebar();
  if (tab === "subs") loadLibrarySubs();
}

// ---------- 媒体库总览 ----------

async function loadLibrarySidebar(force = false) {
  // 已经有结果、而且还在缓存窗口里：直接用现成的重绘，不发请求。
  if (!force && librarySidebar.loaded && Date.now() - librarySidebar.loadedAt < LIB_CACHE_MS) {
    renderLibraryGrid();
    applyLibrarySidebarVisibility();
    return;
  }
  const token = ++librarySidebar.token;
  const button = $("#libRefresh");
  button?.classList.add("spinning");
  try {
    const data = await api("/api/offline/library");
    if (token !== librarySidebar.token) return;
    librarySidebar.items = data.items || [];
    librarySidebar.disk = data.disk || null;
    librarySidebar.loaded = true;
    librarySidebar.loadedAt = Date.now();
    renderLibraryGrid();
    applyLibrarySidebarVisibility();
  } catch (error) {
    if (token === librarySidebar.token) {
      const grid = $("#libGrid");
      if (grid) grid.innerHTML = `<div class="lib-empty"><b>媒体库加载失败</b><p>${escapeHtml(error.message || String(error))}</p></div>`;
    }
  } finally {
    if (token === librarySidebar.token) button?.classList.remove("spinning");
  }
}

function libFilteredItems() {
  const { items, filter, query, sort } = librarySidebar;
  const q = query.trim().toLowerCase();
  const list = items.filter((item) =>
    (filter === "all" || String(item.collection_type) === filter)
    && (!q || item.name.toLowerCase().includes(q)));
  const byRecent = (a, b) => String(b.last_updated || "").localeCompare(String(a.last_updated || ""));
  const comparators = {
    recent: byRecent,
    watched: (a, b) => (Number(Boolean(b.continue_file_id)) - Number(Boolean(a.continue_file_id))) || byRecent(a, b),
    progress: (a, b) => libProgress(b) - libProgress(a) || byRecent(a, b),
    name: (a, b) => String(a.name || "").localeCompare(String(b.name || ""), "zh-Hans-CN"),
    size: (a, b) => (Number(b.size_bytes) || 0) - (Number(a.size_bytes) || 0),
    episodes: (a, b) => (Number(b.file_count) || 0) - (Number(a.file_count) || 0) || byRecent(a, b),
  };
  return list.sort(comparators[sort] || byRecent);
}

function libProgress(item) {
  const total = Math.max(Number(item.episode_count) || 0, Number(item.file_count) || 0, 1);
  return Math.min(1, (Number(item.watched_count) || 0) / total);
}

// 收藏夹页签：带计数，只留还有内容的分类，扫描时少一眼干扰。
function renderLibraryFilters() {
  const host = $("#libFilterTabs");
  if (!host) return;
  const q = librarySidebar.query.trim().toLowerCase();
  const scoped = librarySidebar.items.filter((item) => !q || item.name.toLowerCase().includes(q));
  const counts = new Map();
  scoped.forEach((item) => {
    const key = String(item.collection_type || 0);
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  const options = [
    { id: "all", name: "全部", count: scoped.length },
    ...CATEGORIES.map((category) => ({
      id: String(category.id),
      name: category.name,
      count: counts.get(String(category.id)) || 0,
    }))
      // 空分类不占位置；但正在看的那个分类留着，否则一搜索就把筛选悄悄重置了。
      .filter((option) => option.count > 0 || option.id === librarySidebar.filter),
  ];
  host.innerHTML = options.map((option) => `
    <button type="button" class="category-tab${librarySidebar.filter === option.id ? " active" : ""}"
      data-lib-filter="${option.id}" role="tab" aria-selected="${librarySidebar.filter === option.id}">
      <span>${escapeHtml(option.name)}</span><span class="tab-count">${option.count}</span>
    </button>`).join("");
}

function renderLibraryGrid() {
  const grid = $("#libGrid");
  if (!grid) return;
  renderLibraryFilters();
  const visible = libFilteredItems();
  const totalFiles = visible.reduce((sum, item) => sum + (Number(item.file_count) || 0), 0);
  const totalSize = visible.reduce((sum, item) => sum + (Number(item.size_bytes) || 0), 0);
  const hint = $("#libCountHint");
  if (hint) {
    hint.textContent = visible.length
      ? `${visible.length} 部 · ${totalFiles} 集 · ${libBytes(totalSize)}`
      : "";
  }
  grid.innerHTML = visible.length
    ? visible.map((item) => libraryCard(item)).join("")
    : (librarySidebar.items.length
      ? `<div class="lib-empty">
           <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="m21 21-4.4-4.4M19 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z"/></svg>
           <b>没有匹配的番</b><p>换个筛选或关键词试试。</p>
         </div>`
      : `<div class="lib-empty">
           <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2.6"/><path d="m10.2 9.2 4.6 2.8-4.6 2.8z"/></svg>
           <b>媒体库还是空的</b><p>用「找资源」搜到番剧下载几集，或到设置里检查媒体库目录。</p>
           <button type="button" class="primary-button" data-lib-go-search>去找资源</button>
         </div>`);
  renderLibraryHero();
  renderLibraryDisk();
  updateLibrarySubtitle();
  const count = $("#libraryVideoCount");
  if (count) count.textContent = librarySidebar.items.length ? String(librarySidebar.items.length) : "";
}

// 顶部横幅：最近看过的一部番，一键接着看（不跟着排序走，否则按名称排序时会挑到奇怪的那部）。
function renderLibraryHero() {
  const host = $("#libContinueHero");
  if (!host) return;
  const { items, filter, query } = librarySidebar;
  const q = query.trim().toLowerCase();
  let item;
  let latest = "";
  for (const entry of items) {
    if (!entry.continue_file_id || (filter !== "all" && String(entry.collection_type) !== filter)) continue;
    if (q && !entry.name.toLowerCase().includes(q)) continue;
    const updated = String(entry.last_updated || "");
    if (!item || updated.localeCompare(latest) > 0) {
      item = entry;
      latest = updated;
    }
  }
  if (!item) {
    host.classList.add("hidden");
    host.innerHTML = "";
    librarySidebar.heroKey = "";
    return;
  }
  const key = `${item.anime_id}:${item.continue_file_id}`;
  if (key === librarySidebar.heroKey && host.innerHTML) { host.classList.remove("hidden"); return; }
  librarySidebar.heroKey = key;
  const resume = Number(item.continue_resume_ms) || 0;
  const minutes = Math.floor(resume / 60000);
  const seconds = String(Math.floor((resume % 60000) / 1000)).padStart(2, "0");
  const bits = [episodeLabelOf(item.continue_episode_key)];
  if (resume > 0) bits.push(`看到 ${minutes}:${seconds}`);
  bits.push(`已收 ${item.file_count}${item.episode_count ? ` / 全 ${item.episode_count}` : ""} 集`);
  bits.push(libBytes(item.size_bytes));
  const cover = item.cover || `/api/covers/${item.anime_id}`;
  host.classList.remove("hidden");
  host.innerHTML = `
    <div class="lib-hero-bg" style="background-image:url('${escapeHtml(cover)}')"></div>
    <div class="lib-hero-body">
      <img class="lib-hero-thumb" src="${escapeHtml(cover)}" alt="" onerror="this.remove()" />
      <div class="lib-hero-text">
        <p class="lib-hero-label">继续观看</p>
        <h2 title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</h2>
        <p class="lib-hero-meta">${escapeHtml(bits.join(" · "))}</p>
        <div class="lib-hero-actions">
          <button type="button" class="lib-hero-play" data-hero-play="${item.continue_file_id}" data-hero-anime="${item.anime_id}">
            <svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><path d="M8 5.5v13l11-6.5z"/></svg>
            <span>继续播放</span>
          </button>
          <button type="button" class="lib-hero-detail" data-hero-detail="${item.anime_id}" data-hero-name="${escapeHtml(item.name)}">全部集数</button>
        </div>
      </div>
    </div>`;
}

function renderLibraryDisk() {
  const footer = $("#libFooter");
  const text = $("#libDisk");
  const meter = $("#libDiskMeter");
  const disk = librarySidebar.disk;
  const usable = disk && Number(disk.total_gb) > 0;
  footer?.classList.toggle("hidden", !usable);
  if (!usable) return;
  const usedPct = Math.min(100, Math.max(0, ((Number(disk.total_gb) - Number(disk.free_gb)) / Number(disk.total_gb)) * 100));
  if (text) text.textContent = `媒体库目录 ${disk.media_root} · 已用 ${usedPct.toFixed(0)}% · 剩余 ${disk.free_gb} GB / 共 ${disk.total_gb} GB`;
  if (meter) {
    meter.classList.toggle("warn", usedPct >= 80 && usedPct < 95);
    meter.classList.toggle("full", usedPct >= 95);
    const bar = meter.querySelector("i");
    if (bar) bar.style.width = `${usedPct}%`;
  }
}

function updateLibrarySubtitle() {
  const node = $("#librarySubtitle");
  if (!node) return;
  // 数字已经在面板里（筛选页签 + 计数），副标题只说一句人话，别再重复一遍。
  node.textContent = librarySidebar.items.length
    ? "本地文件、订阅与找资源，都在这里。"
    : "还没有本地文件：去「找资源」下几集，或到设置里检查媒体库目录。";
}

// ---------- 番详情：按字幕组区分来源 ----------

// 详情页的下载进度：面板本身不刷新，用户只能看到打开那一刻的快照，
// 于是「下了半天还是 0 集」。有任务在跑时按 3 秒静默重取一次。
let libDetailTimer = 0;

function stopLibDetailPolling() {
  window.clearTimeout(libDetailTimer);
  libDetailTimer = 0;
}

function libActiveJobs(jobs) {
  return (jobs || []).filter((job) => ["queued", "downloading", "processing"].includes(String(job.status || "")));
}

async function refreshLibraryDetail(silent = true) {
  const detail = librarySidebar.detail;
  if (!detail?.animeId) return;
  try {
    const data = await api(`/api/offline/state?anime_id=${detail.animeId}`);
    if (librarySidebar.detail !== detail) return;
    const activeBefore = libActiveJobs(librarySidebar.jobs).length;
    const raw = data.files || [];
    librarySidebar.files = raw.filter((file) => file.exists !== false);
    librarySidebar.missing = Number(data.missing_count ?? (raw.length - librarySidebar.files.length)) || 0;
    librarySidebar.jobs = data.jobs || [];
    renderLibraryDetail();
    // 这一番的下载刚好全部结束：媒体库卡片上的「已收 N 集」也变了，顺手刷一次总览。
    if (activeBefore > 0 && !libActiveJobs(librarySidebar.jobs).length) {
      loadLibrarySidebar(true).catch(() => {});
    }
  } catch (error) {
    if (!silent) throw error;
  }
}

async function openLibraryDetail(animeId, name) {
  // episode_count 只有总览列表里带着，详情单独取一次 state 拿不到它，
  // 这里顺手带上，否则「全 N 集」永远显示不出来。
  const known = librarySidebar.items.find((entry) => Number(entry.anime_id) === Number(animeId));
  const detail = {
    animeId: Number(animeId) || 0,
    name: String(name || ""),
    episodeCount: Number(known?.episode_count) || 0,
  };
  stopLibDetailPolling();
  if (librarySidebar.detail?.animeId !== detail.animeId) librarySidebar.sourceFilter = "";
  librarySidebar.detail = detail;
  librarySidebar.files = [];
  librarySidebar.jobs = [];
  librarySidebar.missing = 0;
  librarySidebar.selecting = false;
  librarySidebar.selected = new Set();
  switchLibraryTab("media");
  const panel = $("#libraryDetailPanel");
  if (panel) panel.classList.remove("hidden");
  $("#libDetailTitle").textContent = detail.name || `番剧 ${animeId}`;
  $("#libDetailCover").src = `/api/covers/${animeId}`;
  $("#libDetailMeta").textContent = "加载中…";
  $("#libDetailHint").textContent = "";
  $("#libEpisodes").innerHTML = "";
  $("#libSourceChips").classList.add("hidden");
  // 从总览卡片进来时要滚到详情，否则停在原来的网格位置像没反应。
  panel?.scrollIntoView({ behavior: "smooth", block: "start" });
  try {
    // 记录还在、文件却没了的集数：卡片和详情现在都只数能播的，但这件事得说出来，
    // 否则用户会以为「已收」无故少了一集。missing_count 由后台算好，别在前端再判一遍。
    await refreshLibraryDetail(false);
    if (librarySidebar.detail !== detail) return;
  } catch (error) {
    if (librarySidebar.detail !== detail) return;
    $("#libDetailMeta").textContent = `加载失败：${error.message || error}`;
  }
}

function libSourceGroups() {
  const groups = [];
  for (const file of librarySidebar.files) {
    const group = String(file.group_name || "").trim();
    if (group && !groups.includes(group)) groups.push(group);
  }
  return groups;
}

function libSortedFiles() {
  const keyOrder = (key) => {
    const [type, sort] = String(key || "0:0").split(":").map(Number);
    return (type || 0) * 100000 + (sort || 0);
  };
  return [...librarySidebar.files]
    .filter((file) => !librarySidebar.sourceFilter
      || String(file.group_name || "").trim() === librarySidebar.sourceFilter)
    .sort((a, b) => keyOrder(a.episode_key) - keyOrder(b.episode_key));
}

// 下载中的任务：一条概览 + 一集一行，和「本地文件」弹窗里那套视觉一致。
function renderLibDownloads(active, failed = []) {
  const host = $("#libDownloads");
  if (!host) return;
  host.classList.toggle("hidden", !active.length && !failed.length);
  if (!active.length && !failed.length) {
    host.innerHTML = "";
    return;
  }
  const average = Math.round(
    active.reduce((sum, job) => sum + Math.max(0, Math.min(100, Number(job.progress || 0))), 0) / active.length,
  );
  const speed = active.reduce((sum, job) => sum + Number((job.live || {}).dlspeed || 0), 0);
  const moving = active.filter((job) => job.status !== "queued").length;
  const bits = [];
  if (active.length) bits.push(`${moving} 集在下载`);
  if (active.length > moving) bits.push(`${active.length - moving} 集排队`);
  if (failed.length) bits.push(`${failed.length} 集失败`);
  if (speed > 0) bits.push(`${formatSpeed(speed)}/s`);
  host.innerHTML = `
    <div class="lib-download-head">
      <span>${escapeHtml(bits.join(" · "))}</span>
      ${active.length ? `<b>${average}%</b>` : ""}
      ${active.length ? `<div class="library-bar"><i style="width:${average}%"></i></div>` : ""}
    </div>
    ${active.map(libDownloadRow).join("")}
    ${failed.map(libFailedRow).join("")}`;
}

function libDownloadRow(job) {
  const live = job.live || {};
  const percent = Math.max(0, Math.min(100, Number(job.progress || 0)));
  const paused = typeof live.paused === "boolean"
    ? live.paused
    : /^(paused|stopped)/.test(String(live.state || "").toLowerCase());
  const state = job.status === "processing" ? "正在整理" : job.status === "queued" ? "排队中" : paused ? "已暂停" : `${percent.toFixed(1)}%`;
  const detail = [];
  if (Number(live.dlspeed) > 0) detail.push(`${formatSpeed(live.dlspeed)}/s`);
  if (Number(live.segments) > 0) detail.push(`${Number(live.done_segments || 0)}/${live.segments} 分片`);
  else if (Number(live.size) > 0) detail.push(`${libBytes(Number(live.downloaded || 0))} / ${libBytes(live.size)}`);
  if (live.eta > 0 && live.eta < 604800) detail.push(`剩余 ${formatEta(live.eta)}`);
  const badge = job.status === "queued" ? "queued" : job.status === "processing" ? "processing" : paused ? "paused" : "downloading";
  const canPause = job.status !== "queued" && job.status !== "processing";
  return `<div class="lib-download-row">
      <span class="lib-download-badge" data-state="${badge}" style="--p:${percent}"></span>
      <div class="lib-download-main">
        <b>${escapeHtml(episodeLabelOf(job.episode_key))}</b>
        <small>${escapeHtml([state, ...detail].filter(Boolean).join(" · "))}</small>
        <div class="library-bar"><i style="width:${percent}%"></i></div>
      </div>
      <div class="lib-download-actions">
        ${canPause ? `<button type="button" class="pc-btn pc-text" data-lib-task="${job.id}" data-action="${paused ? "resume" : "pause"}">${paused ? "继续" : "暂停"}</button>` : ""}
        <button type="button" class="pc-btn pc-text danger" data-lib-job="${job.id}">移除</button>
      </div>
    </div>`;
}

// 失败的一集留在原位：写清原因，并给一个不用离开这一页的重试。
function libFailedRow(job) {
  const reason = String(job.error || "下载失败");
  const web = String(job.source_kind || "") === "web";
  // 网站资源：任务里留了片源信息就能重新解析；BT：归档失败才会自动重试。
  const canRetry = web ? Boolean(job.retryable) : reason.startsWith("归档失败");
  const hint = web && !job.retryable ? "这条任务没有留下片源信息，回播放器重新点「下载」" : "";
  return `<div class="lib-download-row is-failed">
      <span class="lib-download-badge" data-state="failed"></span>
      <div class="lib-download-main">
        <b>${escapeHtml(episodeLabelOf(job.episode_key))}</b>
        <small class="lib-download-error">${escapeHtml(reason)}</small>
        ${hint ? `<small>${escapeHtml(hint)}</small>` : ""}
      </div>
      <div class="lib-download-actions">
        ${canRetry ? `<button type="button" class="pc-btn pc-text" data-lib-retry="${job.id}">重试</button>` : ""}
        <button type="button" class="pc-btn pc-text danger" data-lib-job="${job.id}">移除</button>
      </div>
    </div>`;
}

async function libRetryJob(mediaId) {
  const row = document.querySelector(`[data-lib-retry="${mediaId}"]`);
  if (row) { row.disabled = true; row.textContent = "重试中…"; }
  try {
    const job = (librarySidebar.jobs || []).find((entry) => Number(entry.id) === Number(mediaId)) || {};
    const url = String(job.source_kind || "") === "web" ? "/api/offline/web-retry" : "/api/offline/retry";
    await api(url, { method: "POST", body: JSON.stringify({ media_id: Number(mediaId) }) });
    toast("已重新开始，稍等一下");
    await refreshLibraryDetail();
  } catch (error) {
    toast(error.message || "重试失败", "error");
    if (row) { row.disabled = false; row.textContent = "重试"; }
  }
}

async function libTaskAction(mediaId, action) {
  try {
    await api("/api/offline/task", {
      method: "POST",
      body: JSON.stringify({ media_id: Number(mediaId), action }),
    });
    await refreshLibraryDetail();
  } catch (error) {
    toast(error.message || "操作失败", "error");
  }
}

async function libRemoveJob(mediaId) {
  if (!window.confirm("从下载器移除这个任务？已经下好的文件会保留。")) return;
  try {
    await api("/api/offline/delete", {
      method: "POST",
      body: JSON.stringify({ mode: "task", media_id: Number(mediaId) }),
    });
    await refreshLibraryDetail();
  } catch (error) {
    toast(error.message || "移除失败", "error");
  }
}

// ---- 批量删除 ----
// 一集一集点确认太慢：进「批量」态后勾选，全选/反选，一次确认删掉。
function libToggleSelecting(on) {
  librarySidebar.selecting = Boolean(on);
  if (!librarySidebar.selecting) librarySidebar.selected = new Set();
  renderLibraryDetail();
}

function renderLibBulk() {
  const bar = $("#libBulkBar");
  const toggle = $("#libSelectToggle");
  const selecting = Boolean(librarySidebar.selecting);
  toggle?.setAttribute("aria-pressed", String(selecting));
  if (toggle) toggle.textContent = selecting ? "退出批量" : "批量";
  if (!bar) return;
  bar.classList.toggle("hidden", !selecting);
  if (!selecting) return;
  const picked = librarySidebar.selected.size;
  const count = $("#libBulkCount");
  if (count) count.textContent = `已选 ${picked} 集`;
  const all = $("#libBulkAll");
  if (all) all.textContent = picked && picked === libSortedFiles().length ? "取消全选" : "全选";
  const remove = $("#libBulkDelete");
  if (remove) {
    remove.disabled = picked === 0;
    remove.textContent = picked ? `删除选中（${picked} 集）` : "删除选中";
  }
}

function libSyncPicked() {
  // 只改类名和勾选态，不整块重绘：重绘会丢掉滚动位置。
  for (const row of document.querySelectorAll("#libEpisodes .lib-episode")) {
    const key = row.dataset.key || "";
    const picked = librarySidebar.selected.has(key);
    row.classList.toggle("picked", picked);
    const box = row.querySelector("input[data-pick]");
    if (box) box.checked = picked;
  }
  renderLibBulk();
}

function libTogglePick(key, on) {
  const value = String(key || "");
  if (!value) return;
  if (on) librarySidebar.selected.add(value);
  else librarySidebar.selected.delete(value);
  libSyncPicked();
}

async function libDeleteSelected() {
  const keys = [...librarySidebar.selected];
  if (!keys.length) return;
  // 删盘不可逆：确认一次说清楚删几集、进不进回收站。
  if (!window.confirm(`删除选中的 ${keys.length} 集？视频文件会直接从硬盘删掉，不进回收站，删了找不回来。`)) return;
  const button = $("#libBulkDelete");
  if (button) { button.disabled = true; button.textContent = "删除中…"; }
  try {
    const data = await api("/api/offline/delete", {
      method: "POST",
      body: JSON.stringify({
        mode: "files",
        anime_id: Number(librarySidebar.detail?.animeId) || 0,
        episode_keys: keys,
      }),
    });
    const failed = data.failed || [];
    toast(failed.length
      ? `已删除 ${data.deleted} 集，${failed.length} 集没删掉：${failed[0].error}`
      : `已删除 ${data.deleted} 集`, failed.length ? "error" : undefined);
    librarySidebar.selected = new Set();
    await refreshLibraryDetail();
    loadLibrarySidebar(true).catch(() => {});
  } catch (error) {
    toast(error.message || "删除失败", "error");
  } finally {
    renderLibBulk();
  }
}

function renderLibraryDetail() {
  const groups = libSourceGroups();
  const chips = $("#libSourceChips");
  const multiple = groups.length > 1;
  chips.classList.toggle("hidden", !multiple);
  if (multiple) {
    const options = ["", ...groups];
    chips.innerHTML = options.map((group) =>
      `<button type="button" data-group="${escapeHtml(group)}" class="${librarySidebar.sourceFilter === group ? "active" : ""}">${escapeHtml(group || "全部来源")}</button>`).join("");
  }
  const files = libSortedFiles();
  const totalSize = files.reduce((sum, file) => sum + (Number(file.file_size) || 0), 0);
  const meta = $("#libDetailMeta");
  const metaParts = [`已收 ${librarySidebar.files.length} 集`];
  if (librarySidebar.detail.episodeCount) metaParts.push(`全 ${librarySidebar.detail.episodeCount} 集`);
  metaParts.push(libBytes(totalSize));
  if (multiple) metaParts.push(`${groups.length} 个来源`);
  meta.textContent = metaParts.join(" · ");
  const active = libActiveJobs(librarySidebar.jobs);
  const failed = (librarySidebar.jobs || []).filter((job) => String(job.status || "") === "failed");
  const hint = $("#libDetailHint");
  if (hint) {
    const bits = [`${libSortedFiles().length} 集可播放`];
    if (active.length) bits.push(`${active.length} 集下载中`);
    if (failed.length) bits.push(`${failed.length} 集失败`);
    if (multiple) bits.push(`${groups.length} 个来源`);
    if (librarySidebar.missing) bits.push(`另有 ${librarySidebar.missing} 集的文件已不在磁盘上`);
    hint.textContent = bits.join(" · ");
  }
  renderLibDownloads(active, failed);
  const host = $("#libEpisodes");
  host.innerHTML = files.length
    ? files.map((file) => {
        const group = String(file.group_name || "").trim();
        const resume = Number(file.resume_ms) || 0;
        const minutes = Math.floor(resume / 60000);
        const seconds = String(Math.floor((resume % 60000) / 1000)).padStart(2, "0");
        const bits = [group || "来源未知", libBytes(file.file_size)];
        if (file.subtitle_path) bits.push("内封字幕");
        if (resume > 0) bits.push(`看到 ${minutes}:${seconds}`);
        const picking = librarySidebar.selecting;
        const picked = picking && librarySidebar.selected.has(String(file.episode_key));
        return `<div class="lib-episode${resume > 0 ? " watched" : ""}${picking ? " picking" : ""}${picked ? " picked" : ""}" data-id="${file.id}" data-key="${escapeHtml(file.episode_key)}">
          ${picking ? `<label class="lib-ep-check"><input type="checkbox" data-pick="${escapeHtml(file.episode_key)}" ${picked ? "checked" : ""} aria-label="选择这一集" /></label>` : ""}
          <div class="lib-ep-info">
            <b>${escapeHtml(episodeLabelOf(file.episode_key))}</b>
            <small>${escapeHtml(bits.join(" · "))}</small>
            ${file.source_title ? `<small class="lib-source-title" title="${escapeHtml(file.source_title)}">${escapeHtml(file.source_title)}</small>` : ""}
          </div>
          ${picking ? "" : `<div class="lib-ep-actions">
            <button type="button" class="pc-btn pc-text lib-play" data-id="${file.id}">${resume > 0 ? "继续" : "播放"}</button>
            <button type="button" class="pc-btn pc-text lib-delete danger" data-id="${file.id}">删除</button>
          </div>`}
        </div>`;
      }).join("")
    : '<p class="offline-empty">这一番的文件都不在磁盘上了</p>';
  renderLibBulk();

  // 只有还在跑的任务才值得盯着；没有就停表，别空转。
  stopLibDetailPolling();
  if (active.length) {
    // 停在媒体库页上按 3 秒走；切去别的页就放慢到 8 秒，别在后台空转。
    const visible = Boolean($("#libraryView")?.classList.contains("active"));
    libDetailTimer = window.setTimeout(() => {
      refreshLibraryDetail().catch(() => {});
    }, visible ? 3000 : 8000);
  }
}

function setLibraryPlaybackContext(animeId, name, files, jobs) {
  offlineView.localToken += 1;
  offlineView.animeId = animeId;
  offlineView.animeName = name;
  offlineView.local = { files, jobs };
}

function libPlay(fileId) {
  const { detail, files, jobs } = librarySidebar;
  if (!detail || !files.some((file) => Number(file.id) === fileId)) return;
  librarySidebar.playToken += 1;
  setLibraryPlaybackContext(detail.animeId, detail.name, files, jobs);
  playLocalFile(fileId);
}

async function libDelete(fileId) {
  const { detail, files } = librarySidebar;
  if (!detail || !files.some((file) => Number(file.id) === fileId)) return;
  librarySidebar.playToken += 1;
  await removeLocalFile(fileId, { animeId: detail.animeId, files });
  if (librarySidebar.detail === detail) openLibraryDetail(detail.animeId, detail.name);
  loadLibrarySidebar(true);   // 删过文件，缓存作废
}

// ---------- 订阅管理 ----------

async function loadLibrarySubs() {
  const status = $("#libSubsStatus");
  try {
    const revision = subscriptionAutoDownloadRevision;
    const data = await api("/api/offline/subscriptions");
    librarySidebar.subs = data.items || [];
    librarySidebar.subsLoaded = true;
    if (!subscriptionAutoDownloadSaving && revision === subscriptionAutoDownloadRevision) {
      syncSubscriptionAutoDownload(data.auto_follow === true);
    }
    renderLibrarySubs();
    if (status) status.textContent = librarySidebar.subs.length
      ? `${librarySidebar.subs.filter((sub) => sub.enabled).length} 条启用中，共 ${librarySidebar.subs.length} 条订阅`
      : "还没有订阅。到「找资源」搜到资源后点「订阅」，新集就会自动下载。";
  } catch (error) {
    if (status) status.textContent = `订阅加载失败：${error.message || error}`;
  }
}

function renderLibrarySubs() {
  const host = $("#libSubList");
  if (!host) return;
  host.innerHTML = librarySidebar.subs.map((sub) => {
    const last = sub.last_checked ? String(sub.last_checked).slice(0, 16).replace("T", " ") : "还没检查过";
    const bits = [`关键词：${sub.keyword}`];
    if (sub.group_name) bits.push(`字幕组：${sub.group_name}`);
    bits.push(`上次检查：${last}`);
    return `<div class="lib-sub-item${sub.enabled ? "" : " off"}" data-id="${sub.id}">
      <img class="lib-sub-cover" src="/api/covers/${sub.anime_id}" alt="" loading="lazy" onerror="this.style.visibility='hidden'" />
      <div class="lib-sub-info">
        <b>${escapeHtml(sub.anime_name || `番剧 ${sub.anime_id}`)}</b>
        <small>${escapeHtml(bits.join(" · "))}</small>
      </div>
      <label class="switch-row compact" title="启用 / 停用这条订阅">
        <input type="checkbox" class="lib-sub-toggle" data-id="${sub.id}" ${sub.enabled ? "checked" : ""} /><span class="switch"></span>
      </label>
      <button type="button" class="pc-btn pc-text lib-sub-delete danger" data-id="${sub.id}">删除</button>
    </div>`;
  }).join("") || "";
}

async function libToggleSub(id, enabled) {
  try {
    await api("/api/offline/subscribe", {
      method: "POST",
      body: JSON.stringify({ id: Number(id), enabled }),
    });
    toast(enabled ? "订阅已启用" : "订阅已停用");
  } catch (error) {
    toast(`没改成：${error.message || error}`, "error");
  }
  loadLibrarySubs();
}

async function libDeleteSub(id) {
  if (!window.confirm("删除这条订阅？停更前不会再自动检查。")) return;
  try {
    await api("/api/offline/unsubscribe", { method: "POST", body: JSON.stringify({ id: Number(id) }) });
    toast("订阅已删除");
  } catch (error) {
    toast(`没删掉：${error.message || error}`, "error");
  }
  loadLibrarySubs();
}

async function libCheckSubs() {
  const status = $("#libSubsStatus");
  if (status) status.textContent = "正在检查全部订阅…";
  try {
    const data = await api("/api/offline/check", { method: "POST", timeoutMs: 120000, body: JSON.stringify({ force: true }) });
    if (status) {
      status.textContent = data.skipped
        ? `没跑：${data.reason || "订阅新集自动下载未开启"}（打开上面的开关后用「立即检查」手动跑一次）`
        : `检查了 ${data.checked || 0} 条订阅，新下载 ${data.downloaded || 0} 集`;
    }
    loadLibrarySubs();
  } catch (error) {
    if (status) status.textContent = `检查失败：${error.message || error}`;
  }
}

// ---------- 找资源 ----------

// 库视图的搜索没有详情页上下文：用关键词匹配收藏里的番，命中才能下载/订阅。
function libResourceLabel(anime) {
  const name = anime.display_name || anime.name_cn || anime.name || `Bangumi #${anime.id}`;
  const date = String(anime.air_date || "");
  const premiere = /^\d{4}-\d{2}/.exec(date)?.[0];
  const original = anime.name && anime.name !== name ? ` · ${anime.name}` : "";
  return `${name}${premiere ? ` · ${premiere} 首播` : ""}${original} · #${anime.id}`;
}

function resetLibResourceSearch() {
  librarySidebar.resourceSearch = null;
  $("#libSearchTarget").hidden = true;
  $("#libSearchStatus").textContent = "";
  $("#libSearchResults").replaceChildren();
}

function libSetupResourceTarget(search) {
  const q = search.query.toLocaleLowerCase();
  const matches = state.animes.filter((anime) =>
    [anime.display_name, anime.name_cn, anime.name]
      .some((name) => name && name.toLocaleLowerCase().includes(q)));
  const select = $("#libSearchAnime");
  select.replaceChildren(new Option("请选择收藏里的番剧", ""));
  const matchingIds = new Set(matches.map(anime => anime.id));
  const other = state.animes.filter(anime => !matchingIds.has(anime.id));
  for (const [label, rows] of [["匹配的番剧", matches], ["其他收藏", other]]) {
    if (!rows.length) continue;
    const group = document.createElement("optgroup");
    group.label = label;
    const options = rows.map(anime => new Option(libResourceLabel(anime), String(anime.id)));
    group.append(...options.sort((a, b) => a.text.localeCompare(b.text, "zh-CN")));
    select.append(group);
  }
  search.matches = matches.length;
  if (matches.length === 1) select.value = String(matches[0].id);
  $("#libSearchTarget").hidden = false;
  libUpdateResourceActions();
}

function libResourceAnimeId() {
  const search = librarySidebar.resourceSearch;
  if (!search || search.profile !== state.active_profile?.id) return 0;
  const id = Number($("#libSearchAnime").value);
  return state.animes.some(anime => Number(anime.id) === id) ? id : 0;
}

function libUpdateResourceActions() {
  const search = librarySidebar.resourceSearch;
  if (!search) return;
  const id = libResourceAnimeId();
  $("#libSearchTargetHint").textContent = id ? "下载和订阅将关联到所选番剧，可随时更换。"
    : search.matches > 1 ? `匹配到 ${search.matches} 部番剧，请核对标题和首播时间后选择。`
    : search.matches === 1 ? "请选择关联番剧后再下载或订阅。"
    : "关键词未匹配到收藏，请手动选择关联番剧。";
  $$(".lib-download, .lib-subscribe", $("#libSearchResults")).forEach(button => {
    if (button.dataset.pending) return;
    const done = id && button.dataset.completedFor === String(id);
    const download = button.classList.contains("lib-download");
    button.disabled = !id || Boolean(done);
    button.textContent = download ? (done ? "已提交" : "下载") : (done ? "已订阅" : "订阅");
  });
}

async function libSearch() {
  const query = String($("#libSearchQuery")?.value || "").trim();
  const status = $("#libSearchStatus");
  const host = $("#libSearchResults");
  if (!query || librarySidebar.resourceSearch?.loading) return;
  const search = {query, profile: state.active_profile?.id, loading: true};
  librarySidebar.resourceSearch = search;
  libSetupResourceTarget(search);
  if (status) status.textContent = "正在搜索蜜柑计划…";
  if (host) host.innerHTML = "";
  try {
    const data = await api(`/api/offline/search?q=${encodeURIComponent(query)}&anime_id=${libResourceAnimeId()}&limit=60`);
    if (librarySidebar.resourceSearch !== search || search.profile !== state.active_profile?.id) return;
    const items = data.items || [];
    if (status) {
      status.textContent = items.length
        ? `找到 ${items.length} 条资源 · 下载或订阅前请核对关联番剧`
        : "没有找到资源，换个关键词试试";
    }
    host.innerHTML = items.map((item) => {
      const bits = [item.group, item.resolution, item.codec, item.publish_date]
        .filter(Boolean).map((bit) => `<i>${escapeHtml(String(bit))}</i>`).join("");
      return `<div class="lib-search-item">
        <div class="lib-search-info">
          <b title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</b>
          <small>${bits}</small>
        </div>
        <div class="lib-ep-actions">
          <button type="button" class="pc-btn pc-text lib-subscribe" title="订阅这个关键词和字幕组">订阅</button>
          <button type="button" class="pc-btn pc-text lib-download" data-url="${escapeHtml(item.torrent_url)}" data-title="${escapeHtml(item.title)}" data-group="${escapeHtml(item.group || "")}" data-resolution="${escapeHtml(item.resolution || "")}" data-codec="${escapeHtml(item.codec || "")}">下载</button>
        </div>
      </div>`;
    }).join("") || "";
    libUpdateResourceActions();
  } catch (error) {
    if (librarySidebar.resourceSearch === search) status.textContent = `搜索失败：${error.message || error}`;
  } finally {
    search.loading = false;
  }
}

async function libDownload(button) {
  const animeId = libResourceAnimeId();
  if (!animeId) return;
  button.dataset.pending = "true";
  button.disabled = true;
  button.textContent = "提交中";
  try {
    await api("/api/offline/download", {
      method: "POST",
      timeoutMs: 60000,
      body: JSON.stringify({
        anime_id: animeId,
        torrent_url: button.dataset.url,
        title: button.dataset.title,
        group_name: button.dataset.group,
        resolution: button.dataset.resolution,
        codec: button.dataset.codec,
      }),
    });
    button.dataset.completedFor = String(animeId);
    toast("已交给 qBittorrent");
    // 下载会改变媒体库内容与磁盘占用，别让用户切回总览时还看 30 秒前的旧数据。
    librarySidebar.loadedAt = 0;
  } catch (error) {
    toast(`下载没提交上：${error.message || error}`, "error");
  } finally {
    delete button.dataset.pending;
    libUpdateResourceActions();
  }
}

async function libSubscribe(button) {
  const animeId = libResourceAnimeId();
  if (!animeId) return;
  const keyword = librarySidebar.resourceSearch.query;
  button.dataset.pending = "true";
  button.disabled = true;
  button.textContent = "提交中";
  try {
    await api("/api/offline/subscribe", {
      method: "POST",
      body: JSON.stringify({
        anime_id: animeId,
        keyword,
        group_name: button.closest(".lib-search-item")?.querySelector("[data-group]")?.dataset.group || "",
      }),
    });
    button.dataset.completedFor = String(animeId);
    toast("已订阅，开启「自动下载订阅的新集」后，新集会自动下载");
  } catch (error) {
    toast(`订阅失败：${error.message || error}`, "error");
  } finally {
    delete button.dataset.pending;
    libUpdateResourceActions();
  }
}

// ---------- 图片库（播放器截图，和视频同在一个媒体库里） ----------

function switchLibraryKind(kind) {
  librarySidebar.playToken += 1;
  librarySidebar.kind = kind === "image" ? "image" : "video";
  const isImage = librarySidebar.kind === "image";
  $$("#libraryKindSwitch .library-kind-btn").forEach((button) => {
    const active = button.dataset.libraryKind === librarySidebar.kind;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
  $("#libraryVideoPane")?.classList.toggle("hidden", isImage);
  $("#libraryImagePane")?.classList.toggle("hidden", !isImage);
  // 搜索框/刷新钮按类型换一个，别让两个搜索框同时出现。
  $("#libVideoSearchWrap")?.classList.toggle("hidden", isImage);
  $("#libImageSearchWrap")?.classList.toggle("hidden", !isImage);
  $("#libSortWrap")?.classList.toggle("hidden", isImage);
  $("#libRefresh")?.classList.toggle("hidden", isImage);
  $("#libImageRefresh")?.classList.toggle("hidden", !isImage);
  $("#libraryDetailPanel")?.classList.toggle("hidden", isImage || !librarySidebar.detail);
  $("#libImageSelect")?.classList.toggle("hidden", !isImage);
  if (!isImage && librarySidebar.imageSelecting) setImageSelecting(false);
  if (isImage) loadLibraryImages();
}

async function loadLibraryImages() {
  const hint = $("#libImageHint");
  const button = $("#libImageRefresh");
  button?.classList.add("spinning");
  if (hint && !librarySidebar.imagesLoaded) hint.textContent = "读取截图…";
  try {
    const data = await api("/api/offline/screenshots");
    librarySidebar.imageGroups = data.groups || [];
    librarySidebar.imageRoot = data.root || "";
    librarySidebar.imageTotal = Number(data.count || 0);
    librarySidebar.imagesLoaded = true;
    const badge = $("#libraryImageCount");
    if (badge) badge.textContent = librarySidebar.imageTotal ? String(librarySidebar.imageTotal) : "";
    renderLibraryImageFolders();
    renderLibraryImages();
  } catch (error) {
    if (hint) hint.textContent = `读取截图失败：${error.message || error}`;
  } finally {
    button?.classList.remove("spinning");
  }
}

function libImageUrl(relative) {
  return `/api/offline/screenshot-file?path=${encodeURIComponent(relative)}`;
}

function libImageTime(name, filenames) {
  const found = name.match(/^(.*?[^\d-])?(\d{2,})-(\d{2})(?:-(\d+))?(?:-(\d+))?(\.png)$/i);
  if (!found) return "";
  const [, prefix = "", first, second, third, copy, extension] = found;
  // 三段数字可能是时:分:秒，也可能是分:秒加重名序号。
  const original = `${prefix}${first}-${second}${extension}`;
  const validHours = third?.length === 2 && Number(first) > 0 && Number(third) < 60;
  const isDuplicate = Number(third) >= 2 && filenames.has(original);
  const hasHours = validHours && (copy || !isDuplicate);
  if (Number(second) >= 60 || (copy && !hasHours) || (!hasHours && Number(first) >= 60)) return "";
  return hasHours ? `${first}:${second}:${third}` : `${first}:${second}`;
}

function renderLibraryImageFolders() {
  const host = $("#libImageFolders");
  if (!host) return;
  const groups = librarySidebar.imageGroups || [];
  const total = groups.reduce((sum, group) => sum + group.images.length, 0);
  const options = [
    { folder: "", name: "全部截图", count: total },
    ...groups.map((group) => ({ folder: group.folder, name: group.folder, count: group.images.length })),
  ];
  if (librarySidebar.imageFolder && !options.some((option) => option.folder === librarySidebar.imageFolder)) {
    librarySidebar.imageFolder = "";
  }
  host.innerHTML = options.map((option) => `
    <button type="button" class="category-tab${librarySidebar.imageFolder === option.folder ? " active" : ""}"
      data-lib-folder="${escapeHtml(option.folder)}" role="tab" aria-selected="${librarySidebar.imageFolder === option.folder}">
      <span>${escapeHtml(option.name)}</span><span class="tab-count">${option.count}</span>
    </button>`).join("");
}

function renderLibraryImages() {
  const host = $("#libImageGroups");
  const hint = $("#libImageHint");
  if (!host) return;
  const query = String($("#libImageSearch")?.value || "").trim().toLocaleLowerCase();
  const groups = (librarySidebar.imageGroups || [])
    .filter((group) => !librarySidebar.imageFolder || group.folder === librarySidebar.imageFolder)
    .map((group) => ({
      ...group,
      filenames: new Set(group.images.map((image) => image.name)),
      images: group.images.filter((image) => !query
        || group.folder.toLocaleLowerCase().includes(query)
        || image.name.toLocaleLowerCase().includes(query)),
    })).filter((group) => group.images.length);
  const flat = [];
  groups.forEach((group) => group.images.forEach((image) => flat.push({ ...image, folder: group.folder })));
  librarySidebar.imageFlat = flat;
  const countHint = $("#libImageCountHint");
  if (countHint) countHint.textContent = flat.length ? `${flat.length} 张` : "";
  if (hint) {
    hint.textContent = flat.length
      ? `保存位置：${librarySidebar.imageRoot || "截图目录"}`
      : "";
  }
  if (!flat.length) {
    host.innerHTML = librarySidebar.imageTotal
      ? `<div class="lib-empty">
           <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="m21 21-4.4-4.4M19 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z"/></svg>
           <b>没有匹配的截图</b><p>换个关键词，或切回「全部截图」。</p>
         </div>`
      : `<div class="lib-empty">
           <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.5" width="18" height="15" rx="2.6"/><circle cx="8.6" cy="10" r="1.6"/><path d="m4 17.5 4.9-4.6 3.4 3.1 2.7-2.4 4.8 4.3"/></svg>
           <b>还没有截图</b><p>播放时按 S，或点播放器顶栏的相机按钮截图。</p>
         </div>`;
    return;
  }
  host.innerHTML = groups.map((group) => {
    const thumbs = group.images.map((image) => {
      const index = flat.findIndex((row) => row.relative === image.relative);
      const time = libImageTime(image.name, group.filenames);
      const selected = librarySidebar.imageSelected.has(image.relative);
      // 勾选泡用 <i>：<span> 被下面的时间码样式占着，会被一起改位置。
      return `<button type="button" class="lib-image-thumb${selected ? " is-selected" : ""}" data-image-index="${index}"
        aria-pressed="${selected}" title="${escapeHtml(image.name)}">
        <img src="${libImageUrl(image.relative)}" alt="${escapeHtml(image.name)}" loading="lazy" decoding="async" />
        <i class="lib-image-check" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m5 13 4.4 4.4L19.4 7.2"/></svg></i>
        <span>${escapeHtml(time || image.name)}</span>
      </button>`;
    }).join("");
    return `<section class="lib-image-group">
      <header><h3>${escapeHtml(group.folder)}</h3><span>${group.images.length} 张</span></header>
      <div class="lib-image-grid">${thumbs}</div>
    </section>`;
  }).join("");
}

function setImageSelecting(on) {
  librarySidebar.imageSelecting = Boolean(on);
  if (!on) librarySidebar.imageSelected.clear();
  const button = $("#libImageSelect");
  if (button) {
    button.setAttribute("aria-pressed", String(librarySidebar.imageSelecting));
    button.textContent = librarySidebar.imageSelecting ? "取消选择" : "选择";
  }
  $("#libImageGroups")?.classList.toggle("is-selecting", librarySidebar.imageSelecting);
  if (librarySidebar.imageSelecting) renderLibraryImages();
  else {
    // 退出时把已经画出来的选中态擦掉，不用整块重绘。
    $$("#libImageGroups .lib-image-thumb.is-selected").forEach((thumb) => {
      thumb.classList.remove("is-selected");
      thumb.setAttribute("aria-pressed", "false");
    });
  }
  updateImageActionBar();
}

function updateImageActionBar() {
  const bar = $("#libImageActionBar");
  if (!bar) return;
  const total = (librarySidebar.imageFlat || []).length;
  const count = librarySidebar.imageSelected.size;
  const node = $("#libImageSelCount");
  if (node) node.textContent = String(count);
  const del = $("#libImageDeleteSelected");
  if (del) del.disabled = count === 0;
  const all = $("#libImageSelectAll");
  if (all) all.textContent = total > 0 && count >= total ? "取消全选" : "全选";
  if (librarySidebar.imageSelecting) {
    if (bar.classList.contains("hidden")) {
      bar.classList.remove("hidden");
      void bar.offsetWidth;
      bar.classList.add("is-in");
    }
    return;
  }
  if (!bar.classList.contains("hidden")) {
    bar.classList.remove("is-in");
    window.setTimeout(() => { if (!librarySidebar.imageSelecting) bar.classList.add("hidden"); }, 200);
  }
}

function toggleImageSelected(index) {
  const image = (librarySidebar.imageFlat || [])[index];
  if (!image) return;
  const set = librarySidebar.imageSelected;
  if (set.has(image.relative)) set.delete(image.relative); else set.add(image.relative);
  const thumb = document.querySelector(`#libImageGroups .lib-image-thumb[data-image-index="${index}"]`);
  if (thumb) {
    thumb.classList.toggle("is-selected", set.has(image.relative));
    thumb.setAttribute("aria-pressed", String(set.has(image.relative)));
  }
  updateImageActionBar();
}

async function deleteSelectedImages() {
  const relatives = [...librarySidebar.imageSelected];
  if (!relatives.length) return;
  // 截图删了就是没了（不进回收站），批量更要拦一道。
  if (!window.confirm(`删除选中的 ${relatives.length} 张截图？删除后不可恢复。`)) return;
  const button = $("#libImageDeleteSelected");
  if (button) { button.disabled = true; button.textContent = "删除中…"; }
  try {
    const data = await api("/api/offline/screenshot/delete-batch", {
      method: "POST",
      body: JSON.stringify({ relatives }),
    });
    const deleted = (data.deleted || []).length;
    const failed = (data.failed || []).length;
    toast(failed ? `删了 ${deleted} 张，${failed} 张没删掉（可能已经被移走）` : `已删除 ${deleted} 张截图`);
    librarySidebar.imageSelected.clear();
    librarySidebar.imagesLoaded = false;
    await loadLibraryImages();
    if (!(librarySidebar.imageFlat || []).length) setImageSelecting(false);
    else updateImageActionBar();
  } catch (error) {
    toast(`删除失败：${error.message || error}`, "error");
  } finally {
    if (button) { button.disabled = false; button.textContent = "删除选中"; }
  }
}

let recordImageGallery = null;
let imagePreviewRequest = 0;
let visibleLibraryImage = null;
let libraryImageDeleting = false;

function openRecordImagePreview(images, index, folder, {fullscreen = true} = {}) {
  if (libraryImageDeleting) return;
  recordImageGallery = { images, index, folder };
  openLibraryImage(index);
  if (fullscreen) $("#libImageFullscreen").click();
}

async function openLibraryImage(index) {
  if (libraryImageDeleting) return;
  const flat = recordImageGallery?.images || librarySidebar.imageFlat || [];
  if (!flat.length) return;
  const total = flat.length;
  const current = ((Number(index) || 0) + total) % total;
  if (recordImageGallery) recordImageGallery.index = current;
  else librarySidebar.imageIndex = current;
  const image = flat[current];
  const folder = recordImageGallery?.folder || image.folder;
  const caption = $("#libImageCaption");
  const status = $("#libImageLoadStatus");
  const deleteButton = $("#libImageDelete");
  const request = ++imagePreviewRequest;
  status.hidden = false;
  status.textContent = "正在加载图片…";
  $("#libImagePrev").disabled = total <= 1;
  $("#libImageNext").disabled = total <= 1;
  deleteButton.hidden = Boolean(recordImageGallery);
  deleteButton.disabled = true;
  const dialog = $("#libImageViewer");
  if (!dialog.open) {
    visibleLibraryImage = null;
    caption.textContent = "";
    $("#libImageView").removeAttribute("src");
    dialog.setAttribute("aria-label", recordImageGallery ? "记录图片预览" : "截图预览");
    dialog.showModal();
  }
  const preview = new Image();
  preview.id = "libImageView";
  preview.alt = image.name;
  preview.src = recordImageGallery && image.url ? image.url : libImageUrl(image.relative);
  try {
    await preview.decode();
    if (request !== imagePreviewRequest || !dialog.open) return;
    $("#libImageView").replaceWith(preview);
    visibleLibraryImage = image;
    caption.textContent = `${folder} / ${image.name}　（${current + 1} / ${total}）`;
    status.hidden = true;
    deleteButton.disabled = false;
  } catch (_) {
    if (request === imagePreviewRequest && dialog.open) status.textContent = "图片加载失败，可以继续切换。";
  }
}

async function deleteLibraryImage() {
  const dialog = $("#libImageViewer");
  const deleteButton = $("#libImageDelete");
  if (!dialog.open || recordImageGallery || libraryImageDeleting || deleteButton.disabled) return;
  const image = visibleLibraryImage;
  if (!image) return;
  // 截图删掉就找不回来了，先拦一下。
  if (!window.confirm(`删除「${image.name}」？删除后不可恢复。`)) return;
  const request = imagePreviewRequest;
  libraryImageDeleting = true;
  deleteButton.disabled = true;
  $("#libImagePrev").disabled = $("#libImageNext").disabled = true;
  try {
    await api("/api/offline/screenshot/delete", { method: "POST", body: JSON.stringify({ relative: image.relative }) });
    toast(`已删除 ${image.name}`);
    librarySidebar.imageFlat = (librarySidebar.imageFlat || []).filter(item => item.relative !== image.relative);
    librarySidebar.imagesLoaded = false;
    await loadLibraryImages();
  } catch (error) {
    toast(`删除失败：${error.message || error}`, "error");
    if (request === imagePreviewRequest && dialog.open) {
      deleteButton.disabled = false;
      $("#libImagePrev").disabled = $("#libImageNext").disabled = (librarySidebar.imageFlat || []).length <= 1;
    }
    return;
  } finally {
    libraryImageDeleting = false;
  }
  if (request !== imagePreviewRequest || !dialog.open) return;
  const length = (librarySidebar.imageFlat || []).length;
  dialog.close();
  if (length) openLibraryImage(Math.min(librarySidebar.imageIndex, length - 1));
}

// ---------- 初始化 ----------

function initLibraryView() {
  if (initLibraryView.bound) return;
  initLibraryView.bound = true;

  $$(".library-tab").forEach((item) => item.addEventListener("click", () => {
    // 点顶部「媒体库」页签 = 回到总览，别把上次打开的详情留在原地。
    if (item.dataset.libraryTab === "media") {
      librarySidebar.detail = null;
      librarySidebar.sourceFilter = "";
    }
    switchLibraryTab(item.dataset.libraryTab);
  }));
  $$("#libraryKindSwitch .library-kind-btn").forEach((item) => item.addEventListener("click", () => switchLibraryKind(item.dataset.libraryKind)));
  $("#libSort")?.addEventListener("change", (event) => {
    librarySidebar.sort = event.target.value;
    renderLibraryGrid();
  });
  $("#libRefresh")?.addEventListener("click", () => loadLibrarySidebar(true));
  $("#libFilterTabs")?.addEventListener("click", (event) => {
    const tab = event.target.closest("[data-lib-filter]");
    if (!tab) return;
    librarySidebar.filter = tab.dataset.libFilter;
    renderLibraryGrid();
  });
  $("#libImageFolders")?.addEventListener("click", (event) => {
    const tab = event.target.closest("[data-lib-folder]");
    if (!tab) return;
    librarySidebar.imageFolder = tab.dataset.libFolder || "";
    renderLibraryImageFolders();
    renderLibraryImages();
  });
  $("#libImageSearch")?.addEventListener("input", () => renderLibraryImages());
  $("#libImageRefresh")?.addEventListener("click", () => { librarySidebar.imagesLoaded = false; loadLibraryImages(); });
  $("#libImageGroups")?.addEventListener("click", (event) => {
    const thumb = event.target.closest("[data-image-index]");
    if (!thumb) return;
    const index = Number(thumb.dataset.imageIndex);
    if (librarySidebar.imageSelecting) { toggleImageSelected(index); return; }
    openLibraryImage(index);
  });
  $("#libImageSelect")?.addEventListener("click", () => setImageSelecting(!librarySidebar.imageSelecting));
  $("#libImageCancelSelect")?.addEventListener("click", () => setImageSelecting(false));
  $("#libImageSelectAll")?.addEventListener("click", () => {
    const flat = librarySidebar.imageFlat || [];
    const all = flat.length > 0 && librarySidebar.imageSelected.size >= flat.length;
    librarySidebar.imageSelected = new Set(all ? [] : flat.map((image) => image.relative));
    renderLibraryImages();
    updateImageActionBar();
  });
  $("#libImageDeleteSelected")?.addEventListener("click", deleteSelectedImages);
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !librarySidebar.imageSelecting || event.defaultPrevented) return;
    if (document.querySelector("dialog[open]")) return;
    setImageSelecting(false);
  });
  const stepImage = offset => openLibraryImage((recordImageGallery?.index ?? librarySidebar.imageIndex) + offset);
  $("#libImagePrev")?.addEventListener("click", () => stepImage(-1));
  $("#libImageNext")?.addEventListener("click", () => stepImage(1));
  $("#libImageDelete")?.addEventListener("click", deleteLibraryImage);
  const imageViewer = $("#libImageViewer");
  const imageFrame = imageViewer.querySelector(".modal-frame");
  const imageFullscreen = $("#libImageFullscreen");
  let imageControlsTimer;
  const revealImageControls = () => {
    clearTimeout(imageControlsTimer);
    imageFrame.classList.remove("controls-idle");
    if (document.fullscreenElement === imageFrame) {
      imageControlsTimer = setTimeout(() => imageFrame.classList.add("controls-idle"), 2500);
    }
  };
  $("#libImageClose")?.addEventListener("click", () => imageViewer.close());
  imageFrame.addEventListener("pointermove", revealImageControls);
  imageFrame.addEventListener("pointerdown", revealImageControls);
  imageFullscreen?.addEventListener("click", async () => {
    try {
      if (document.fullscreenElement === imageFrame) await document.exitFullscreen();
      else await imageFrame.requestFullscreen();
    } catch {
      toast("无法进入或退出全屏", "error");
    }
  });
  imageFrame?.addEventListener("fullscreenchange", () => {
    revealImageControls();
    imageFullscreen.textContent = document.fullscreenElement === imageFrame ? "退出全屏" : "全屏看图";
  });
  imageViewer.addEventListener("close", () => {
    if (imageViewer.open) return;
    recordImageGallery = null;
    imagePreviewRequest += 1;
    visibleLibraryImage = null;
    clearTimeout(imageControlsTimer);
    if (document.fullscreenElement === imageFrame) document.exitFullscreen().catch(() => {});
  });
  imageViewer.addEventListener("keydown", (event) => {
    revealImageControls();
    if (event.key === "ArrowLeft") { event.preventDefault(); stepImage(-1); }
    else if (event.key === "ArrowRight") { event.preventDefault(); stepImage(1); }
  });

  $("#libSearch")?.addEventListener("input", (event) => {
    librarySidebar.query = event.target.value;
    renderLibraryGrid();
  });
  $("#libContinueHero")?.addEventListener("click", (event) => {
    const play = event.target.closest("[data-hero-play]");
    if (play) {
      const item = librarySidebar.items.find((entry) => Number(entry.anime_id) === Number(play.dataset.heroAnime));
      libPlayFromItem(item, Number(play.dataset.heroPlay));
      return;
    }
    const detail = event.target.closest("[data-hero-detail]");
    if (detail) openLibraryDetail(detail.dataset.heroDetail, detail.dataset.heroName || "");
  });
  $("#libGrid")?.addEventListener("click", (event) => {
    if (event.target.closest("[data-lib-go-search]")) { switchLibraryTab("search"); return; }
    const continueButton = event.target.closest(".library-continue, .library-play-fab");
    if (continueButton) {
      event.stopPropagation();
      const animeId = Number(continueButton.dataset.anime);
      const item = librarySidebar.items.find((entry) => Number(entry.anime_id) === animeId);
      libPlayFromItem(item, Number(continueButton.dataset.continue));
      return;
    }
    const card = event.target.closest(".library-card");
    if (card) openLibraryDetail(card.dataset.anime, card.dataset.name);
  });
  $("#libGrid")?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const card = event.target.closest?.(".library-card");
    if (!card || event.target !== card) return;
    event.preventDefault();
    card.click();
  });
  $("#libDetailBack")?.addEventListener("click", () => {
    stopLibDetailPolling();
    librarySidebar.selecting = false;
    librarySidebar.selected = new Set();
    librarySidebar.detail = null;
    librarySidebar.sourceFilter = "";
    switchLibraryTab("media");
  });
  $("#libSourceChips")?.addEventListener("click", (event) => {
    const chip = event.target.closest("[data-group]");
    if (!chip) return;
    librarySidebar.sourceFilter = chip.dataset.group;
    renderLibraryDetail();
  });
  $("#libSelectToggle")?.addEventListener("click", () => libToggleSelecting(!librarySidebar.selecting));
  $("#libBulkCancel")?.addEventListener("click", () => libToggleSelecting(false));
  $("#libBulkAll")?.addEventListener("click", () => {
    const keys = libSortedFiles().map((file) => String(file.episode_key));
    const allPicked = keys.length > 0 && keys.every((key) => librarySidebar.selected.has(key));
    librarySidebar.selected = new Set(allPicked ? [] : keys);
    libSyncPicked();
  });
  $("#libBulkDelete")?.addEventListener("click", libDeleteSelected);
  $("#libEpisodes")?.addEventListener("change", (event) => {
    const box = event.target.closest("input[data-pick]");
    if (box) libTogglePick(box.dataset.pick, box.checked);
  });
  $("#libEpisodes")?.addEventListener("click", (event) => {
    // 批量态下点整行也能勾选，不用非得点中那个小方框。
    if (librarySidebar.selecting && !event.target.closest("input[data-pick]")) {
      const row = event.target.closest(".lib-episode");
      if (row) {
        const key = row.dataset.key || "";
        libTogglePick(key, !librarySidebar.selected.has(key));
        return;
      }
    }
    const play = event.target.closest(".lib-play");
    if (play) { libPlay(Number(play.dataset.id)); return; }
    const remove = event.target.closest(".lib-delete");
    if (remove) libDelete(Number(remove.dataset.id));
  });
  $("#libDownloads")?.addEventListener("click", (event) => {
    const task = event.target.closest("[data-lib-task]");
    if (task) { libTaskAction(task.dataset.libTask, task.dataset.action); return; }
    const retry = event.target.closest("[data-lib-retry]");
    if (retry) { libRetryJob(retry.dataset.libRetry); return; }
    const remove = event.target.closest("[data-lib-job]");
    if (remove) libRemoveJob(remove.dataset.libJob);
  });
  $("#libAutoFollow")?.addEventListener("change", saveSubscriptionAutoDownload);
  $("#libCheckSubs")?.addEventListener("click", libCheckSubs);
  $("#libSubList")?.addEventListener("click", (event) => {
    const remove = event.target.closest(".lib-sub-delete");
    if (remove) { libDeleteSub(remove.dataset.id); return; }
  });
  $("#libSubList")?.addEventListener("change", (event) => {
    const toggle = event.target.closest(".lib-sub-toggle");
    if (toggle) libToggleSub(toggle.dataset.id, toggle.checked);
  });
  $("#libSearchGo")?.addEventListener("click", libSearch);
  $("#libSearchQuery")?.addEventListener("input", resetLibResourceSearch);
  $("#libSearchAnime")?.addEventListener("change", libUpdateResourceActions);
  $("#libSearchQuery")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); libSearch(); }
  });
  $("#libSearchResults")?.addEventListener("click", (event) => {
    const download = event.target.closest(".lib-download");
    if (download && !download.disabled) { libDownload(download); return; }
    const subscribe = event.target.closest(".lib-subscribe");
    if (subscribe && !subscribe.disabled) libSubscribe(subscribe);
  });

  // 设置里的显示开关：改动立即保存并生效。
  $("#librarySidebarMode")?.addEventListener("change", async (event) => {
    const select = event.currentTarget;
    if (select.disabled) return;
    const mode = select.value;
    select.disabled = true;
    try {
      await api("/api/settings", { method: "PATCH", body: JSON.stringify({ library_sidebar: mode }) });
      state.settings.library_sidebar = mode;
      applyLibrarySidebarVisibility();
      // 主界面设置里那颗「媒体库」勾选框也得跟着变，否则两个入口各说各话。
      syncLibraryVisibilityCheckbox?.();
      syncSettingsNavigation?.(true);
      toast("已保存");
    } catch (error) {
      toast(`没存上：${error.message || error}`, "error");
      syncLibraryVisibilityCheckbox?.();
    } finally {
      select.value = state.settings.library_sidebar || "show";
      select.disabled = false;
    }
  });

  // 启动时应用显示开关；bootstrap 若还没回来就稍后重试一次。
  const apply = () => applyLibrarySidebarVisibility();
  if (state.settings && Object.keys(state.settings).length) apply();
  else window.setTimeout(apply, 1600);
  window.addEventListener("load", () => window.setTimeout(apply, 300));
}

// 从总览卡片直接续播：上下文喂给 offlineView 再开播放器。
async function libPlayFromItem(item, fileId) {
  if (!item) return;
  const token = ++librarySidebar.playToken;
  try {
    const data = await api(`/api/offline/state?anime_id=${item.anime_id}`);
    if (token !== librarySidebar.playToken || state.activeView !== "library") return;
    const files = data.files || [];
    if (!files.some((file) => Number(file.id) === fileId)) {
      toast("本地文件已不存在，请刷新媒体库", "error");
      return;
    }
    setLibraryPlaybackContext(item.anime_id, item.name, files, data.jobs || []);
    playLocalFile(fileId);
  } catch (error) {
    if (token === librarySidebar.playToken && state.activeView === "library") {
      toast(error.message || "读取本地文件失败", "error");
    }
  }
}

initLibraryView();
