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
  imagesLoaded: false,
  items: [],
  disk: null,
  filter: "all",
  query: "",
  sort: "recent",
  token: 0,
  loaded: false,
  detail: null,       // 打开的番 { animeId, name }
  files: [],
  jobs: [],
  sourceFilter: "",   // 选中的字幕组（多来源时）
  subs: [],
  subsLoaded: false,
  searching: false,
  heroKey: "",        // 已经渲染过的续看横幅（避免搜索时反复重建图片）
};

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

function libVisible() {
  return !$("#libraryNavButton")?.classList.contains("hidden");
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

async function loadLibrarySidebar() {
  const token = ++librarySidebar.token;
  const button = $("#libRefresh");
  button?.classList.add("spinning");
  try {
    const data = await api("/api/offline/library");
    if (token !== librarySidebar.token) return;
    librarySidebar.items = data.items || [];
    librarySidebar.disk = data.disk || null;
    librarySidebar.loaded = true;
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
  return [...list].sort(comparators[sort] || byRecent);
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
  const q = librarySidebar.query.trim().toLowerCase();
  const candidates = librarySidebar.items.filter((entry) =>
    entry.continue_file_id
    && (librarySidebar.filter === "all" || String(entry.collection_type) === librarySidebar.filter)
    && (!q || entry.name.toLowerCase().includes(q)));
  const item = candidates.sort((a, b) => String(b.last_updated || "").localeCompare(String(a.last_updated || "")))[0];
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

async function openLibraryDetail(animeId, name) {
  // episode_count 只有总览列表里带着，详情单独取一次 state 拿不到它，
  // 这里顺手带上，否则「全 N 集」永远显示不出来。
  const known = librarySidebar.items.find((entry) => Number(entry.anime_id) === Number(animeId));
  librarySidebar.detail = {
    animeId: Number(animeId) || 0,
    name: String(name || ""),
    episodeCount: Number(known?.episode_count) || 0,
  };
  switchLibraryTab("media");
  const panel = $("#libraryDetailPanel");
  if (panel) panel.classList.remove("hidden");
  $("#libDetailTitle").textContent = librarySidebar.detail.name || `番剧 ${animeId}`;
  $("#libDetailCover").src = `/api/covers/${animeId}`;
  $("#libDetailMeta").textContent = "加载中…";
  $("#libDetailHint").textContent = "";
  $("#libEpisodes").innerHTML = "";
  $("#libSourceChips").classList.add("hidden");
  // 从总览卡片进来时要滚到详情，否则停在原来的网格位置像没反应。
  panel?.scrollIntoView({ behavior: "smooth", block: "start" });
  try {
    const data = await api(`/api/offline/state?anime_id=${Number(animeId)}`);
    librarySidebar.files = (data.files || []).filter((file) => file.exists !== false);
    librarySidebar.jobs = data.jobs || [];
    renderLibraryDetail();
  } catch (error) {
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
  const hint = $("#libDetailHint");
  if (hint) hint.textContent = `${libSortedFiles().length} 集可播放${multiple ? ` · ${groups.length} 个来源` : ""}`;
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
        return `<div class="lib-episode${resume > 0 ? " watched" : ""}" data-id="${file.id}">
          <div class="lib-ep-info">
            <b>${escapeHtml(episodeLabelOf(file.episode_key))}</b>
            <small>${escapeHtml(bits.join(" · "))}</small>
            ${file.source_title ? `<small class="lib-source-title" title="${escapeHtml(file.source_title)}">${escapeHtml(file.source_title)}</small>` : ""}
          </div>
          <div class="lib-ep-actions">
            <button type="button" class="pc-btn pc-text lib-play" data-id="${file.id}">${resume > 0 ? "继续" : "播放"}</button>
            <button type="button" class="pc-btn pc-text lib-delete danger" data-id="${file.id}" data-label="${escapeHtml(episodeLabelOf(file.episode_key))}">删除</button>
          </div>
        </div>`;
      }).join("")
    : '<p class="offline-empty">这一番的文件都不在磁盘上了</p>';
}

async function libPlay(fileId) {
  // 播放/上一集/下一集/弹幕匹配都吃 offlineView 的上下文，先喂给它。
  offlineView.animeId = librarySidebar.detail.animeId;
  offlineView.animeName = librarySidebar.detail.name;
  offlineView.local = { files: librarySidebar.files, jobs: librarySidebar.jobs };
  playLocalFile(Number(fileId));
}

async function libDelete(fileId, label) {
  // removeLocalFile 自带确认提示（直接删文件）；把上下文对齐让它删完能刷新对地方。
  offlineView.animeId = librarySidebar.detail.animeId;
  offlineView.animeName = librarySidebar.detail.name;
  offlineView.local = { files: librarySidebar.files, jobs: librarySidebar.jobs };
  await removeLocalFile(Number(fileId));
  openLibraryDetail(librarySidebar.detail.animeId, librarySidebar.detail.name);
  loadLibrarySidebar();
}

// ---------- 订阅管理 ----------

async function loadLibrarySubs() {
  const status = $("#libSubsStatus");
  try {
    const data = await api("/api/offline/subscriptions");
    librarySidebar.subs = data.items || [];
    librarySidebar.subsLoaded = true;
    const follow = $("#libAutoFollow");
    if (follow) follow.checked = data.auto_follow === true;
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
    const data = await api("/api/offline/check", { method: "POST", body: JSON.stringify({ force: true }) });
    if (status) {
      status.textContent = data.skipped
        ? `没跑：${data.reason || "自动追新番未开启"}（打开上面的开关后用「立即检查」手动跑一次）`
        : `检查了 ${data.checked || 0} 条订阅，新下载 ${data.downloaded || 0} 集`;
    }
    loadLibrarySubs();
  } catch (error) {
    if (status) status.textContent = `检查失败：${error.message || error}`;
  }
}

// ---------- 找资源 ----------

// 库视图的搜索没有详情页上下文：用关键词匹配收藏里的番，命中才能下载/订阅。
function libResolveAnime(query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return null;
  return state.animes.find((anime) =>
    [anime.display_name, anime.name_cn, anime.name]
      .some((name) => name && name.toLowerCase().includes(q))) || null;
}

async function libSearch() {
  const query = String($("#libSearchQuery")?.value || "").trim();
  const status = $("#libSearchStatus");
  const host = $("#libSearchResults");
  if (!query || librarySidebar.searching) return;
  librarySidebar.searching = true;
  if (status) status.textContent = "正在搜索蜜柑计划…";
  if (host) host.innerHTML = "";
  try {
    const anime = libResolveAnime(query);
    const data = await api(`/api/offline/search?q=${encodeURIComponent(query)}&anime_id=${anime ? anime.id : 0}&limit=60`);
    const items = data.items || [];
    if (status) {
      status.textContent = items.length
        ? `找到 ${items.length} 条资源${anime ? ` · 将关联到收藏里的「${anime.display_name || anime.name_cn}」` : " · 没匹配到收藏番剧，只能看不能下"}`
        : "没有找到资源，换个关键词试试";
    }
    host.innerHTML = items.map((item) => {
      const bits = [item.group, item.resolution, item.codec, item.publish_date]
        .filter(Boolean).map((bit) => `<i>${escapeHtml(String(bit))}</i>`).join("");
      const canDownload = Boolean(anime);
      return `<div class="lib-search-item">
        <div class="lib-search-info">
          <b title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</b>
          <small>${bits}</small>
        </div>
        <div class="lib-ep-actions">
          <button type="button" class="pc-btn pc-text lib-subscribe" data-url="${escapeHtml(item.torrent_url)}" title="订阅这个关键词+字幕组"${canDownload ? "" : " disabled"}>订阅</button>
          <button type="button" class="pc-btn pc-text lib-download" data-url="${escapeHtml(item.torrent_url)}" data-title="${escapeHtml(item.title)}" data-group="${escapeHtml(item.group || "")}" data-resolution="${escapeHtml(item.resolution || "")}" data-codec="${escapeHtml(item.codec || "")}"${canDownload ? "" : " disabled title=\"没匹配到收藏番剧，请在番剧详情页的「找资源」里下载\""}>下载</button>
        </div>
      </div>`;
    }).join("") || "";
    if (anime) $("#libSearchResults").dataset.animeId = anime.id;
    else delete $("#libSearchResults")?.dataset.animeId;
  } catch (error) {
    if (status) status.textContent = `搜索失败：${error.message || error}`;
  } finally {
    librarySidebar.searching = false;
  }
}

async function libDownload(button) {
  const animeId = Number($("#libSearchResults")?.dataset.animeId || 0);
  if (!animeId) return;
  button.disabled = true;
  button.textContent = "提交中";
  try {
    await api("/api/offline/download", {
      method: "POST",
      body: JSON.stringify({
        anime_id: animeId,
        torrent_url: button.dataset.url,
        title: button.dataset.title,
        group_name: button.dataset.group,
        resolution: button.dataset.resolution,
        codec: button.dataset.codec,
      }),
    });
    button.textContent = "已提交";
    toast("已交给 qBittorrent");
  } catch (error) {
    button.disabled = false;
    button.textContent = "下载";
    toast(`下载没提交上：${error.message || error}`, "error");
  }
}

async function libSubscribe(button) {
  const animeId = Number($("#libSearchResults")?.dataset.animeId || 0);
  if (!animeId) return;
  const anime = state.animes.find((item) => item.id === animeId);
  const keyword = String($("#libSearchQuery")?.value || "").trim();
  button.disabled = true;
  try {
    await api("/api/offline/subscribe", {
      method: "POST",
      body: JSON.stringify({
        anime_id: animeId,
        keyword: keyword || anime?.display_name || anime?.name_cn || "",
        group_name: button.closest(".lib-search-item")?.querySelector("[data-group]")?.dataset.group || "",
      }),
    });
    button.textContent = "已订阅";
    toast("已订阅，开启自动追新番后新集会自动下载");
  } catch (error) {
    button.disabled = false;
    toast(`订阅失败：${error.message || error}`, "error");
  }
}

// ---------- 图片库（播放器截图，和视频同在一个媒体库里） ----------

function switchLibraryKind(kind) {
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

function libImageTime(name) {
  // 文件名里的时间码：第03集_06-12 → 06:12；带小时就是 01-02-03 → 01:02:03
  const found = String(name || "").match(/(\d{2})-(\d{2})(?:-(\d{2}))?\.png$/i);
  if (!found) return "";
  return found[3] ? `${found[1]}:${found[2]}:${found[3]}` : `${found[1]}:${found[2]}`;
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
      const time = libImageTime(image.name);
      return `<button type="button" class="lib-image-thumb" data-image-index="${index}" title="${escapeHtml(image.name)}">
        <img src="${libImageUrl(image.relative)}" alt="${escapeHtml(image.name)}" loading="lazy" decoding="async" />
        <span>${escapeHtml(time || image.name)}</span>
      </button>`;
    }).join("");
    return `<section class="lib-image-group">
      <header><h3>${escapeHtml(group.folder)}</h3><span>${group.images.length} 张</span></header>
      <div class="lib-image-grid">${thumbs}</div>
    </section>`;
  }).join("");
}

function openLibraryImage(index) {
  const flat = librarySidebar.imageFlat || [];
  if (!flat.length) return;
  const total = flat.length;
  librarySidebar.imageIndex = ((Number(index) || 0) + total) % total;
  const image = flat[librarySidebar.imageIndex];
  $("#libImageView").src = libImageUrl(image.relative);
  $("#libImageView").alt = image.name;
  $("#libImageCaption").textContent = `${image.folder} / ${image.name}　（${librarySidebar.imageIndex + 1} / ${total}）`;
  $("#libImagePrev").disabled = total <= 1;
  $("#libImageNext").disabled = total <= 1;
  const dialog = $("#libImageViewer");
  if (dialog && !dialog.open) dialog.showModal();
}

async function deleteLibraryImage() {
  const flat = librarySidebar.imageFlat || [];
  const image = flat[librarySidebar.imageIndex];
  if (!image) return;
  try {
    await api("/api/offline/screenshot/delete", { method: "POST", body: JSON.stringify({ relative: image.relative }) });
    toast(`已删除 ${image.name}`);
    $("#libImageViewer")?.close();
    librarySidebar.imagesLoaded = false;
    await loadLibraryImages();
    if ((librarySidebar.imageFlat || []).length) openLibraryImage(Math.min(librarySidebar.imageIndex, librarySidebar.imageFlat.length - 1));
  } catch (error) {
    toast(`删除失败：${error.message || error}`, "error");
  }
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
  $("#libRefresh")?.addEventListener("click", () => {
    librarySidebar.loaded = false;
    loadLibrarySidebar();
  });
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
    if (thumb) openLibraryImage(Number(thumb.dataset.imageIndex));
  });
  $("#libImagePrev")?.addEventListener("click", () => openLibraryImage(librarySidebar.imageIndex - 1));
  $("#libImageNext")?.addEventListener("click", () => openLibraryImage(librarySidebar.imageIndex + 1));
  $("#libImageDelete")?.addEventListener("click", deleteLibraryImage);
  $("#libImageClose")?.addEventListener("click", () => $("#libImageViewer")?.close());
  $("#libImageDone")?.addEventListener("click", () => $("#libImageViewer")?.close());
  $("#libImageViewer")?.addEventListener("keydown", (event) => {
    if (event.key === "ArrowLeft") { event.preventDefault(); openLibraryImage(librarySidebar.imageIndex - 1); }
    else if (event.key === "ArrowRight") { event.preventDefault(); openLibraryImage(librarySidebar.imageIndex + 1); }
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
  $("#libEpisodes")?.addEventListener("click", (event) => {
    const play = event.target.closest(".lib-play");
    if (play) { libPlay(play.dataset.id); return; }
    const remove = event.target.closest(".lib-delete");
    if (remove) libDelete(remove.dataset.id, remove.dataset.label);
  });
  $("#libAutoFollow")?.addEventListener("change", async (event) => {
    const checked = event.target.checked;
    try {
      await api("/api/offline/settings", { method: "POST", body: JSON.stringify({ auto_follow: checked }) });
      const twin = $("#offlineAutoFollow");
      if (twin) twin.checked = checked;
      const twin2 = $("#autoFollowSetting");
      if (twin2) twin2.checked = checked;
      toast(checked ? "已开启自动追新番" : "已关闭自动追新番");
    } catch (error) {
      event.target.checked = !checked;
      toast(`没存上：${error.message || error}`, "error");
    }
  });
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
    const mode = event.target.value;
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
  offlineView.animeId = item.anime_id;
  offlineView.animeName = item.name;
  try {
    const data = await api(`/api/offline/state?anime_id=${item.anime_id}`);
    offlineView.local = { files: data.files || [], jobs: data.jobs || [] };
  } catch (error) {
    offlineView.local = { files: [], jobs: [] };
  }
  playLocalFile(Number(fileId));
}

initLibraryView();
