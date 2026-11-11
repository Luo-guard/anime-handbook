// 媒体库面板：搜蜜柑 → 交给 qBittorrent → 本地文件播放。
// 依赖 core.js 的 state/$/$$/escapeHtml/toast 与 network.js 的 api()。
const offlineView = {
  animeId: 0,
  animeName: "",
  items: [],
  group: "",
  local: { files: [], jobs: [] },
  // 请求版本号：慢响应（尤其是 3 秒轮询撞上换番）不能把新番的界面覆盖成旧数据。
  localToken: 0,
  searchToken: 0,
  retryLimit: 5,
  playing: null,
  resumeTimer: 0,
  subtitle: null,
  subtitleToken: 0,
  jassubPromise: null,
  subtitleBoot: null,
  // 打开播放器前收起的模态弹窗 id，关掉播放器后原样恢复。
  returnDialogs: [],
  // 「我的库」视图：全库聚合数据 + 筛选状态；libraryMode=false 表示正在看某个番的文件列表。
  library: { items: [], disk: null, filter: "all", query: "", token: 0, loaded: false },
  libraryMode: true,
  // 详情页「我的库」按钮置位：本地文件标签强制进总览（否则默认进当前番）。
};

function offlineStatus(target, text, isError = false) {
  const node = $(target);
  if (!node) return;
  node.textContent = text || "";
  node.classList.toggle("is-error", Boolean(isError));
}

// 集数标识的第一段是收藏里的类型：0 本篇、1 特别篇、2 OP、3 ED…
const OFFLINE_TYPE_LABELS = { 1: "特别篇", 2: "OP", 3: "ED", 4: "预告", 5: "MAD", 6: "其它" };

function episodeLabelOf(key) {
  const parts = String(key || "").split(":");
  // 只认「类型:集数」两段纯数字；收藏里还有 bgm:123 这类标识，原样显示。
  if (parts.length !== 2 || !/^\d+$/.test(parts[0])) return String(key || "");
  const number = Number(parts[1]);
  if (!Number.isFinite(number) || number <= 0) return String(key || "");
  const prefix = OFFLINE_TYPE_LABELS[Number(parts[0])];
  const padded = String(number).padStart(2, "0");
  return prefix ? `${prefix} ${padded}` : `第 ${padded} 集`;
}

function formatOfflineSize(text) {
  return String(text || "未知大小");
}

function openOffline() {
  const anime = state.progressAnime || {};
  const animeId = Number(anime.id || 0);
  const name = anime.display_name || anime.name_cn || anime.name || "";
  // 换了一部番就要把上一部的关键词、结果、字幕组筛选和本地文件缓存全部换掉。
  // 只在「搜索框为空」时填名字会留着旧番的词，用户得手动清空重搜。
  const switched = offlineView.animeId !== animeId || offlineView.animeName !== name;
  offlineView.animeId = animeId;
  offlineView.animeName = name;
  $("#offlineHeading").textContent = "媒体库";
  $("#offlineTarget").textContent = name || "";
  $("#offlineTarget").classList.toggle("hidden", !name);
  // 同一个番再次打开也要补填：搜索框可能被清空过，再点「找资源」
  // 看到的却是「先输入关键词」，会以为是没带上番名。
  if (switched || !$("#offlineQuery").value.trim()) {
    $("#offlineQuery").value = name;
    offlineView.items = [];
    offlineView.group = "";
    offlineView.local = { files: [], jobs: [] };
    $("#offlineGroups").innerHTML = "";
    renderOfflineList();
    renderOfflineLocal();
  }
  offlineStatus("#offlineStatus", "");
  offlineStatus("#offlineLocalStatus", "");
  const dialog = $("#offlineModal");
  if (!dialog.open) dialog.showModal();
  switchOfflineTab("search");
  refreshOfflineLocal();
  setOfflinePolling(true);
  warmSubtitleRenderer();
  // 换番必搜；同一部番里用户手动改过的关键词保留，只在结果为空时补搜一次。
  if (name && (switched || !offlineView.items.length)) runOfflineSearch();
}

function switchOfflineTab(tab) {
  $$(".offline-tab").forEach((button) => {
    const active = button.dataset.offlineTab === tab;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
  $("#offlineSearchPanel").classList.toggle("hidden", tab !== "search");
  $("#offlineLocalPanel").classList.toggle("hidden", tab !== "local");
  if (tab === "local") {
    if (offlineView.libraryMode === false) {
      showLibraryChrome(false);
    } else if (offlineView.animeId) {
      // 从详情页进来：默认直接看这一番的本地文件。
      openAnimeLocalView(offlineView.animeId, offlineView.animeName);
    } else {
      openLibraryView();
    }
  }
}

async function runOfflineSearch() {
  const query = $("#offlineQuery").value.trim();
  if (!query) {
    offlineStatus("#offlineStatus", "先输入关键词", true);
    return;
  }
  const button = $("#offlineSearchButton");
  const animeId = Number(offlineView.animeId);
  const token = (offlineView.searchToken += 1);
  button.disabled = true;
  offlineStatus("#offlineStatus", "正在搜索蜜柑…");
  try {
    const data = await api(
      `/api/offline/search?q=${encodeURIComponent(query)}&anime_id=${animeId}&limit=60`,
    );
    // 搜完之前换了番或又搜了一次：旧结果不能覆盖当前的列表。
    if (token !== offlineView.searchToken || animeId !== Number(offlineView.animeId)) return;
    offlineView.items = data.items || [];
    offlineView.group = "";
    renderOfflineGroups();
    renderOfflineList();
    const host = String(data.host || "").replace(/^https?:\/\//, "");
    offlineStatus(
      "#offlineStatus",
      `在 ${host} 找到 ${offlineView.items.length} 条${data.truncated ? "（蜜柑单次最多 100 条）" : ""}`,
    );
  } catch (error) {
    if (token !== offlineView.searchToken || animeId !== Number(offlineView.animeId)) return;
    offlineView.items = [];
    renderOfflineList();
    offlineStatus("#offlineStatus", error.message || "搜索失败", true);
  } finally {
    button.disabled = false;
  }
}

// 标题开头的 [字幕组] 与下面单独显示的字幕组重复，去掉再显示。
function cleanTorrentTitle(title) {
  return String(title || "").replace(/^\s*[\[【][^\]】]{1,40}[\]】]\s*/, "");
}

function renderOfflineGroups() {
  const host = $("#offlineGroups");
  const groups = [...new Set(offlineView.items.map((item) => item.group).filter(Boolean))];
  if (!groups.length) {
    host.innerHTML = "";
    return;
  }
  const chips = [
    `<button type="button" class="offline-chip${offlineView.group ? "" : " active"}" data-group="">全部</button>`,
    ...groups.map(
      (group) =>
        `<button type="button" class="offline-chip${offlineView.group === group ? " active" : ""}" data-group="${escapeHtml(group)}">${escapeHtml(group)}</button>`,
    ),
  ];
  host.innerHTML = chips.join("");
}

function offlineVisibleItems() {
  return offlineView.group
    ? offlineView.items.filter((item) => item.group === offlineView.group)
    : offlineView.items;
}

function renderOfflineList() {
  const host = $("#offlineList");
  const items = offlineVisibleItems();
  if (!items.length) {
    host.innerHTML = `<p class="offline-empty">没有结果。换个关键词试试，蜜柑按标题搜索，不支持拼音。</p>`;
    return;
  }
  host.innerHTML = items
    .map((item, index) => {
      const tags = [
        item.resolution,
        item.codec,
        item.bit_depth,
        item.subtitles,
        item.batch ? "合集" : "",
      ]
        .filter(Boolean)
        .map((text) => `<span class="offline-tag">${escapeHtml(text)}</span>`)
        .join("");
      return `
        <article class="offline-row" data-index="${index}">
          <div class="offline-row-main">
            <p class="offline-row-title" title="${escapeHtml(item.title)}">${escapeHtml(cleanTorrentTitle(item.title))}</p>
            <p class="offline-row-meta">
              <span class="offline-group">${escapeHtml(item.group || "未标注字幕组")}</span>
              ${tags}
              <span class="offline-size">${escapeHtml(formatOfflineSize(item.size_text))}</span>
              <span class="offline-date">${escapeHtml(String(item.published_at || "").slice(0, 10))}</span>
            </p>
          </div>
          <div class="offline-row-actions">
            <button type="button" class="offline-subscribe" data-subscribe="${index}" title="记下这个字幕组；到 设置 → 数据来源 打开「自动追新番」后，有新集才会自动下载">订阅</button>
            <button type="button" class="offline-download" data-index="${index}">下载</button>
          </div>
        </article>`;
    })
    .join("");
}

async function startOfflineDownload(index) {
  const item = offlineVisibleItems()[index];
  if (!item) return;
  const button = $(`#offlineList .offline-download[data-index="${index}"]`);
  if (button) {
    button.disabled = true;
    button.textContent = "提交中…";
  }
  try {
    await api("/api/offline/download", {
      method: "POST",
      body: JSON.stringify({
        anime_id: offlineView.animeId,
        torrent_url: item.torrent_url,
        title: item.title,
        group_name: item.group || "",
        resolution: item.resolution || "",
        codec: item.codec || "",
      }),
    });
    toast("已交给 qBittorrent");
    if (button) button.textContent = "已提交";
    refreshOfflineLocal();
  } catch (error) {
    if (button) {
      button.disabled = false;
      button.textContent = "下载";
    }
    toast(error.message || "提交失败", "error");
  }
}

async function refreshOfflineLocal() {
  if (!offlineView.animeId) return;
  const animeId = Number(offlineView.animeId);
  const token = (offlineView.localToken += 1);
  try {
    const data = await api(`/api/offline/state?anime_id=${animeId}`);
    // 期间换了番、或又发了一次新的请求：这次的结果已经过期，直接丢弃。
    if (token !== offlineView.localToken || animeId !== Number(offlineView.animeId)) return;
    offlineView.local = { files: data.files || [], jobs: data.jobs || [] };
    if (data.archive_retry_limit) offlineView.retryLimit = Number(data.archive_retry_limit);
    renderOfflineLocal();
    // 下载/归档完成后立刻把「已下载」角标刷到集数格子上，不用等重开详情。
    if (typeof syncEpisodeDownloadMarks === "function") syncEpisodeDownloadMarks(data.files || []);
  } catch (error) {
    if (token !== offlineView.localToken || animeId !== Number(offlineView.animeId)) return;
    offlineStatus("#offlineLocalStatus", error.message || "读取本地文件失败", true);
  }
}

// ===== 我的库：全库番组卡片（数据来自 /api/offline/library，纯读） =====

function showLibraryChrome(inLibrary) {
  $("#offlineLibraryView")?.classList.toggle("hidden", !inLibrary);
  $("#offlineAnimeView")?.classList.toggle("hidden", inLibrary);
}

async function openLibraryView() {
  offlineView.libraryMode = true;
  showLibraryChrome(true);
  $("#offlineLibraryBack")?.classList.add("hidden");
  await loadLibrary();
}

// 从媒体库点进某个番：复用现有的单番文件列表（播放/删除/任务全都在）。
async function openAnimeLocalView(animeId, name) {
  offlineView.libraryMode = false;
  showLibraryChrome(false);
  $("#offlineLibraryBack")?.classList.remove("hidden");
  offlineView.animeId = Number(animeId) || 0;
  offlineView.animeName = String(name || "");
  $("#offlineTarget").textContent = offlineView.animeName;
  $("#offlineTarget").classList.toggle("hidden", !offlineView.animeName);
  $("#offlineQuery").value = $("#offlineQuery").value.trim() ? $("#offlineQuery").value : offlineView.animeName;
  await refreshOfflineLocal();
}

async function loadLibrary() {
  const token = ++offlineView.library.token;
  offlineStatus("#offlineLocalStatus", "媒体库加载中…");
  try {
    const data = await api("/api/offline/library");
    if (token !== offlineView.library.token) return;
    offlineView.library.items = data.items || [];
    offlineView.library.disk = data.disk || null;
    offlineView.library.loaded = true;
    offlineStatus("#offlineLocalStatus", "");
    renderLibrary();
  } catch (error) {
    if (token === offlineView.library.token) {
      offlineStatus("#offlineLocalStatus", `媒体库加载失败：${error.message || error}`, true);
    }
  }
}

function libraryFiltered() {
  const { items, filter, query } = offlineView.library;
  const q = query.trim().toLowerCase();
  return items.filter((item) =>
    (filter === "all" || String(item.collection_type) === filter)
    && (!q || item.name.toLowerCase().includes(q)));
}

function renderLibrary() {
  const grid = $("#offlineLibraryGrid");
  if (!grid) return;
  const visible = libraryFiltered();
  grid.innerHTML = visible.length
    ? visible.map(libraryCard).join("")
    : '<p class="offline-empty">没有匹配的番：换个筛选或关键词，或者先用「找资源」下载几集</p>';
  const disk = offlineView.library.disk;
  const diskNode = $("#offlineLibraryDisk");
  if (diskNode) {
    diskNode.textContent = disk && disk.total_gb
      ? `媒体库目录 ${disk.media_root} · 剩余 ${disk.free_gb} GB / 共 ${disk.total_gb} GB`
      : "";
    diskNode.classList.toggle("hidden", !diskNode.textContent);
  }
}

function libraryCard(item) {
  const total = Math.max(item.episode_count || 0, item.file_count, 1);
  const downloadPct = Math.min(100, Math.round((item.file_count / total) * 100));
  const watchedPct = Math.min(100, Math.round((item.watched_count / total) * 100));
  const size = item.size_bytes >= (1 << 30)
    ? `${(item.size_bytes / (1 << 30)).toFixed(1)} GB`
    : `${Math.max(1, Math.round(item.size_bytes / (1 << 20)))} MB`;
  const category = CATEGORIES.find((entry) => entry.id === item.collection_type);
  const resume = item.continue_resume_ms;
  const minutes = Math.floor(resume / 60000);
  const seconds = String(Math.floor((resume % 60000) / 1000)).padStart(2, "0");
  const continueLabel = `${episodeLabelOf(item.continue_episode_key)}${resume > 0 ? ` · 看到 ${minutes}:${seconds}` : " · 从头看"}`;
  return `
    <article class="library-card" data-anime="${item.anime_id}" data-name="${escapeHtml(item.name)}" role="button" tabindex="0" aria-label="打开《${escapeHtml(item.name)}》的本地文件">
      <div class="library-cover">
        <img src="/api/covers/${item.anime_id}" loading="lazy" alt="" onerror="this.style.visibility='hidden'" />
        ${category ? `<span class="library-badge">${escapeHtml(category.name)}</span>` : ""}
        <span class="library-size">${escapeHtml(size)}</span>
        ${item.continue_file_id ? `<button type="button" class="library-play-fab" data-continue="${item.continue_file_id}" data-anime="${item.anime_id}" title="继续播放" aria-label="继续播放"><svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><path d="M8 5.5v13l11-6.5z"/></svg></button>` : ""}
      </div>
      <div class="library-body">
        <p class="library-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</p>
        <p class="library-meta">已收 ${item.file_count}${item.episode_count ? ` / 全 ${item.episode_count}` : ""} 集 · 已看 ${item.watched_count}</p>
        <div class="library-bar" title="绿色：已收 ${item.file_count} 集；深色：已看 ${item.watched_count} 集"><i style="width:${downloadPct}%"></i><i class="watched" style="width:${watchedPct}%"></i></div>
        ${item.continue_file_id ? `<button type="button" class="library-continue" data-continue="${item.continue_file_id}" data-anime="${item.anime_id}">▶ ${escapeHtml(continueLabel)}</button>` : ""}
      </div>
    </article>`;
}

async function continueWatching(animeId, fileId) {
  const item = offlineView.library.items.find((entry) => Number(entry.anime_id) === Number(animeId));
  offlineView.animeId = Number(animeId) || 0;
  offlineView.animeName = item ? item.name : "";
  await refreshOfflineLocal();
  playLocalFile(Number(fileId));
}

function renderOfflineLocal() {
  const { files, jobs } = offlineView.local;
  // 后端每次 state 都会核对 file_path 是否还在。外接盘没插、文件被手动删/挪，
  // 记录还留着但播不了 —— 单独列出来，不混进「可以播放」。
  const playable = files.filter((file) => file.exists !== false);
  const gone = files.filter((file) => file.exists === false);
  const active = jobs.filter((job) => ["queued", "downloading", "processing"].includes(job.status));
  const failed = jobs.filter((job) => job.status === "failed");
  $("#offlineLocalCount").textContent = playable.length ? String(playable.length) : "";
  const blocks = [];
  if (playable.length) {
    blocks.push(
      `<h3 class="offline-section-title">可以播放 · ${playable.length} 集</h3>`,
      ...playable.map((file) => {
        const label = episodeLabelOf(file.episode_key);
        const size = file.file_size ? `${(file.file_size / (1 << 20)).toFixed(0)} MB` : "";
        const progress = file.resume_ms ? `看到 ${Math.floor(file.resume_ms / 60000)}:${String(Math.floor((file.resume_ms % 60000) / 1000)).padStart(2, "0")}` : "没看过";
        return `
          <article class="offline-row" data-file="${file.id}">
            <div class="offline-row-main">
              <p class="offline-row-title">${escapeHtml(label)}</p>
              <p class="offline-row-meta"><span class="offline-size">${escapeHtml(size)}</span><span class="offline-date">${escapeHtml(progress)}</span>${file.has_subtitle ? '<span class="offline-tag">字幕</span>' : ""}</p>
            </div>
            <div class="offline-row-actions">
              <button type="button" class="offline-play" data-file="${file.id}">播放</button>
              <button type="button" class="offline-remove" data-file="${file.id}" title="删除文件与记录（不进回收站）">删除</button>
            </div>
          </article>`;
      }),
    );
  }
  if (gone.length) {
    blocks.push(
      `<h3 class="offline-section-title">文件不在了 · ${gone.length} 集</h3>`,
      ...gone.map((file) => {
        const label = episodeLabelOf(file.episode_key);
        return `
          <article class="offline-row offline-row-missing" data-file="${file.id}">
            <div class="offline-row-main">
              <p class="offline-row-title">${escapeHtml(label)}</p>
              <p class="offline-row-meta"><span class="offline-error">磁盘上找不到这个文件</span></p>
              <p class="offline-row-hint">外接盘没插就插回去，挪过就放回原位，这条记录会自动恢复；确定不要了再删掉记录。</p>
            </div>
            <div class="offline-row-actions">
              <button type="button" class="offline-remove" data-file="${file.id}" title="只删掉这条记录，磁盘上没有文件可删">删除记录</button>
            </div>
          </article>`;
      }),
    );
  }
  if (active.length) {
    blocks.push(
      `<h3 class="offline-section-title">正在下载 · ${active.length}</h3>`,
      ...active.map((job) => {
        const live = job.live || {};
        const percent = Math.max(0, Math.min(100, Number(job.progress || 0)));
        // 后端 live.paused 是准的（qB 4 的 pausedDL / qB 5 的 stoppedDL 都认）；
        // 老数据没有这个字段时退回看状态字符串。
        const paused = typeof live.paused === "boolean"
          ? live.paused
          : /^(paused|stopped)/.test(String(live.state || "").toLowerCase());
        const label = job.status === "processing" ? "正在整理" : paused ? "已暂停" : job.status === "queued" ? "排队中" : `${percent.toFixed(1)}%`;
        const detail = [
          live.dlspeed ? `${formatSpeed(live.dlspeed)}/s` : "",
          live.eta && live.eta > 0 && live.eta < 604800 ? `剩余 ${formatEta(live.eta)}` : "",
          live.seeds ? `${live.seeds} 个做种` : "",
        ]
          .filter(Boolean)
          .join(" · ");
        return `
          <article class="offline-row offline-row-task">
            <div class="offline-row-main">
              <p class="offline-row-title" title="${escapeHtml(job.source_title || job.torrent_name)}">${escapeHtml(job.torrent_name || job.source_title || "未命名任务")}</p>
              <div class="offline-bar"><span style="width:${percent}%"></span></div>
              <p class="offline-row-meta"><span class="offline-tag">${escapeHtml(label)}</span>${detail ? `<span>${escapeHtml(detail)}</span>` : ""}${job.error ? `<span class="offline-error">${escapeHtml(job.error)}</span>` : ""}</p>
            </div>
            <div class="offline-row-actions">
              <button type="button" class="offline-play" data-task="${job.id}" data-action="${paused ? "resume" : "pause"}">${paused ? "继续" : "暂停"}</button>
              <button type="button" class="offline-remove" data-job="${job.id}" title="从下载器移除并删除记录">移除</button>
            </div>
          </article>`;
      }),
    );
  }
  if (failed.length) {
    blocks.push(
      `<h3 class="offline-section-title">出问题了 · ${failed.length}</h3>`,
      ...failed.map((job) => {
        const limit = Number(offlineView.retryLimit || 5);
        const attempts = Number(job.archive_retries || 0);
        const stopped = attempts >= limit;
        // 提示要能指导下一步：还在自动重试就说明会自己再试，到顶了就说要人处理什么。
        const hint = stopped
          ? "自动重试已用完：按上面的原因处理后点「重试归档」"
          : attempts
            ? `还会自动再试（已用 ${attempts}/${limit} 次）；也可以现在点「重试归档」`
            : "点「重试归档」立即再试一次";
        return `
        <article class="offline-row">
          <div class="offline-row-main">
            <p class="offline-row-title" title="${escapeHtml(job.source_title || job.torrent_name)}">${escapeHtml(job.torrent_name || job.source_title || "未命名任务")}</p>
            <p class="offline-row-meta"><span class="offline-error">${escapeHtml(job.error || "未知原因")}</span></p>
            <p class="offline-row-hint">${escapeHtml(hint)}｜已入库的集会跳过，只补缺的</p>
          </div>
          <div class="offline-row-actions">
            <button type="button" class="offline-play" data-retry="${job.id}" title="${escapeHtml(hint)}">重试归档</button>
            <button type="button" class="offline-remove" data-job="${job.id}" title="从下载器移除并删除记录">移除</button>
          </div>
        </article>`;
      }),
    );
  }
  if (!blocks.length) {
    blocks.push(`<p class="offline-empty">还没有下载过任何一集。到左边「找资源」搜一下。</p>`);
  }
  $("#offlineLocalList").innerHTML = blocks.join("");
  offlineStatus("#offlineLocalStatus", files.length ? "" : "");
}

// 详情页的单集「播放」手势会在从没打开过离线面板时触发：缓存要么是空的、
// 要么还挂着上一部番的身份。这里自己按当前番拉一份最新的再找文件，
// 既不吃面板缓存的亏，也不受轮询「过期响应直接丢弃」的影响。
async function localFileForEpisode(key) {
  const anime = state.progressAnime || {};
  const animeId = Number(anime.id || 0);
  const name = anime.display_name || anime.name_cn || anime.name || "";
  if (offlineView.animeId !== animeId || offlineView.animeName !== name) {
    offlineView.animeId = animeId;
    offlineView.animeName = name;
    offlineView.local = { files: [], jobs: [] };
  }
  if (!offlineView.animeId) return null;
  try {
    const data = await api(`/api/offline/state?anime_id=${animeId}`);
    if (animeId !== Number(offlineView.animeId)) return null;
    offlineView.local = { files: data.files || [], jobs: data.jobs || [] };
    if (typeof syncEpisodeDownloadMarks === "function") syncEpisodeDownloadMarks(data.files || []);
  } catch (error) {
    return null;
  }
  // 两套 key 先归一化再比：有 Bangumi 逐集资料的番，格子是 bgm:xxx，
  // 入库写的是 0:N，直接字符串比会永远找不到，扇区「播放」一直报没下载。
  const files = offlineView.local?.files || [];
  if (typeof findLocalEpisodeFile === "function") return findLocalEpisodeFile(files, key, anime);
  // 极简环境（只加载本模块的回归脚本）没有 presentation.js 时不能整条失效。
  return files.find(
    (item) => item && String(item.episode_key) === String(key) && item.exists !== false
  ) || null;
}

// 原生 <video> 的超分由浏览器扩展（NijiLucid 等）接管，扩展通常把开关按钮
// 以 position:fixed 挂在 body 上。模态 dialog 会进入 top layer，z-index 再高
// 的扩展控件也会被它整个挡住 —— B 站视频能显示超分按钮、我们播放器不能，
// 根因就在这里。所以看片时收起其它模态弹窗，播放器改用非模态 show()，
// 让扩展控件浮在播放器之上；关掉播放器再把原来的弹窗恢复。
function openOfflinePlayerDialog() {
  const player = $("#offlinePlayer");
  if (!player || player.open) return;
  offlineView.returnDialogs = [...document.querySelectorAll("dialog[open]")]
    .filter((node) => node !== player && node.id)
    .map((node) => node.id);
  offlineView.returnDialogs.forEach((id) => {
    const node = document.getElementById(id);
    if (node && node.open) node.close();
  });
  const backdrop = $("#offlinePlayerBackdrop");
  if (backdrop) backdrop.hidden = false;
  player.show();
  // 非模态 dialog 不自动拿焦点；聚焦 dialog 本体（不是关闭按钮，否则那个 ×
  // 会多一圈焦点环），Esc 与 Tab 的顺序才和模态时一致。
  player.focus({ preventScroll: true });
}

function restoreOfflineReturnDialogs() {
  const ids = offlineView.returnDialogs || [];
  offlineView.returnDialogs = [];
  ids.forEach((id) => {
    const node = document.getElementById(id);
    if (!node || node.open) return;
    try { node.showModal(); } catch (error) { /* 已被别处接管就不强求 */ }
  });
  // 离线面板在 close 时会停掉轮询，恢复后要重新打开。
  if (ids.includes("offlineModal") && $("#offlineModal")?.open) setOfflinePolling(true);
}

function playLocalFile(fileId) {
  const file = offlineView.local.files.find((item) => Number(item.id) === Number(fileId));
  if (!file) return;
  if (file.exists === false) {
    toast("这个文件在磁盘上找不到了，看看外接盘插好了没", "error");
    refreshOfflineLocal();
    return;
  }
  offlineView.playing = file;
  const video = $("#offlineVideo");
  const stageTitle = `${offlineView.animeName || "本地文件"} · ${episodeLabelOf(file.episode_key)}`;
  $("#offlinePlayerTitle").textContent = stageTitle;
  const stageTitleNode = $("#pcStageTitle");
  if (stageTitleNode) stageTitleNode.textContent = stageTitle;
  const sourceTitle = String(file.source_title || "").trim();
  const sourceNode = $("#offlinePlayerSource");
  if (sourceNode) {
    sourceNode.textContent = sourceTitle;
    sourceNode.title = sourceTitle;
    sourceNode.classList.toggle("hidden", !sourceTitle);
  }
  clearSubtitleSession();
  const toggle = $("#offlineSubtitleToggle");
  toggle.classList.toggle("hidden", !file.subtitle_path);
  toggle.classList.remove("is-off");
  toggle.textContent = "字幕 · 开";
  toggle.setAttribute("aria-pressed", "true");
  $("#offlinePlayerMeta").textContent = file.subtitle_path
    ? "页面内字幕加载中（第一次约需十几秒，之后切集是即时的）…"
    : "这一集没有内封字幕。";
  video.src = `/api/offline/stream/${file.id}.mp4`;
  if (file.subtitle_path) setupSubtitleRenderer(file, video);
  openOfflinePlayerDialog();
  video.addEventListener(
    "loadedmetadata",
    () => {
      if (file.resume_ms > 3000) video.currentTime = file.resume_ms / 1000;
      // 浏览器换 src 后会重置倍速/音量，这里把记忆值贴回去。
      const prefs = pcLoadPrefs();
      video.playbackRate = prefs.speed;
      video.volume = prefs.volume;
      video.muted = prefs.muted;
      pcSync();
    },
    { once: true },
  );
  video.play().catch(() => {});
  // 弹幕层：浮在 video 上的 canvas，不碰播放内核。同目录弹幕文件 / 已匹配的在线分集
  // 由 dmLoadFor 自己找，找不到会在弹幕设置面板里提示，不打断播放。
  if (typeof dmLoadFor === "function") dmLoadFor(file, offlineView.animeName, offlineView.animeId);
  pcRefreshEpisodes();
  window.clearInterval(offlineView.resumeTimer);
  offlineView.resumeTimer = window.setInterval(() => saveOfflineResume(), 8000);
}

async function saveOfflineResume() {
  const file = offlineView.playing;
  const video = $("#offlineVideo");
  if (!file || !video || !video.duration) return;
  const ms = Math.floor(video.currentTime * 1000);
  if (ms < 1000) return;
  try {
    await api("/api/offline/resume", {
      method: "POST",
      body: JSON.stringify({ anime_id: offlineView.animeId, episode_key: file.episode_key, resume_ms: ms }),
    });
    file.resume_ms = ms;
  } catch (error) {
    /* 进度存不上不是关键路径，不打扰用户。 */
  }
}

function closeOfflinePlayer() {
  saveOfflineResume();
  clearSubtitleSession();
  if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
  if (typeof dmClear === "function") dmClear();
  window.clearInterval(offlineView.resumeTimer);
  const video = $("#offlineVideo");
  video.pause();
  video.removeAttribute("src");
  video.load();
  const dialog = $("#offlinePlayer");
  if (dialog.open) dialog.close();
  const backdrop = $("#offlinePlayerBackdrop");
  if (backdrop) backdrop.hidden = true;
  restoreOfflineReturnDialogs();
  const sourceNode = $("#offlinePlayerSource");
  if (sourceNode) { sourceNode.textContent = ""; sourceNode.title = ""; sourceNode.classList.add("hidden"); }
  offlineView.playing = null;
  refreshOfflineLocal();
}

async function removeLocalFile(fileId) {
  const file = offlineView.local.files.find((item) => Number(item.id) === Number(fileId));
  if (!file) return;
  const gone = file.exists === false;
  const label = episodeLabelOf(file.episode_key);
  // 直接删盘上的文件，不进回收站——提示里必须说清楚删了找不回来。
  if (!window.confirm(gone
    ? `删掉「${label}」这条记录？磁盘上已经没有这个文件了，这一步只清记录。`
    : `删除 ${label}？会直接把视频文件从硬盘上删掉，不进回收站，删了找不回来。`)) return;
  try {
    await api("/api/offline/delete", {
      method: "POST",
      body: JSON.stringify({ mode: "file", anime_id: offlineView.animeId, episode_key: file.episode_key }),
    });
    toast(gone ? "已删掉记录" : "已删除文件");
    refreshOfflineLocal();
  } catch (error) {
    toast(error.message || "删除失败", "error");
  }
}

async function removeJob(mediaId) {
  if (!window.confirm("从下载器移除这个任务？已下载的文件会保留在硬盘上。")) return;
  try {
    await api("/api/offline/delete", {
      method: "POST",
      body: JSON.stringify({ mode: "task", media_id: mediaId }),
    });
    toast("任务已移除");
    refreshOfflineLocal();
  } catch (error) {
    toast(error.message || "移除失败", "error");
  }
}

// 面板开着时同步下载进度/归档状态。后端已有全局心跳在推进任务，
// 这里的轮询只负责把推进的结果画到开着的界面上：
// · 有任务在动（下载/整理/还能自动重试的失败）→ 3 秒一次，进度看着是活的；
// · 全都静止（没有任务、只剩已放弃的失败）→ 放慢到 15 秒，别白白压 qB；
// · 面板关了或页面切到后台就停，切回来立刻补一次。
const OFFLINE_POLL_FAST_MS = 3000;
const OFFLINE_POLL_IDLE_MS = 15000;
let offlinePollTimer = 0;
let offlinePolling = false;

function offlinePollDelay() {
  const jobs = offlineView.local?.jobs || [];
  const limit = Number(offlineView.retryLimit || 5);
  const moving = jobs.some((job) => {
    if (["queued", "downloading", "processing"].includes(job.status)) return true;
    // 归档失败但自动重试还没到上限的任务仍会自己恢复，值得按快节奏盯着。
    return (
      job.status === "failed" &&
      String(job.error || "").startsWith("归档失败") &&
      Number(job.archive_retries || 0) < limit
    );
  });
  return moving ? OFFLINE_POLL_FAST_MS : OFFLINE_POLL_IDLE_MS;
}

function setOfflinePolling(on) {
  offlinePolling = Boolean(on);
  window.clearTimeout(offlinePollTimer);
  offlinePollTimer = 0;
  if (!offlinePolling) return;
  const tick = async () => {
    if (!offlinePolling) return;
    if ($("#offlineModal")?.open && !document.hidden) {
      try {
        await refreshOfflineLocal();
      } catch (error) {
        // 轮询失败不该弹提示打断观看，下一轮会自己重试。
      }
    }
    if (offlinePolling) offlinePollTimer = window.setTimeout(tick, offlinePollDelay());
  };
  offlinePollTimer = window.setTimeout(tick, OFFLINE_POLL_FAST_MS);
}

// 切回这个标签页时立刻补一次，别等下一轮 3/15 秒。
document.addEventListener("visibilitychange", () => {
  if (document.hidden || !offlinePolling) return;
  if (!$("#offlineModal")?.open) return;
  refreshOfflineLocal().catch(() => {});
  setOfflinePolling(true);
});

document.addEventListener("DOMContentLoaded", () => {
  $("#openOffline")?.addEventListener("click", openOffline);
  $("#offlineClose")?.addEventListener("click", () => $("#offlineModal").close());
  $("#offlineModal")?.addEventListener("close", () => setOfflinePolling(false));
  $("#offlineSearchButton")?.addEventListener("click", runOfflineSearch);
  $("#offlineQuery")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      runOfflineSearch();
    }
  });
  $$(".offline-tab").forEach((button) => {
    button.addEventListener("click", () => {
      switchOfflineTab(button.dataset.offlineTab);
      if (button.dataset.offlineTab === "local") refreshOfflineLocal();
    });
  });
  $("#offlineGroups")?.addEventListener("click", (event) => {
    const chip = event.target.closest("[data-group]");
    if (!chip) return;
    offlineView.group = chip.dataset.group || "";
    renderOfflineGroups();
    renderOfflineList();
  });
  $("#offlineList")?.addEventListener("click", (event) => {
    const subscribe = event.target.closest("[data-subscribe]");
    if (subscribe) return subscribeFromResult(Number(subscribe.dataset.subscribe));
    const button = event.target.closest(".offline-download");
    if (button) startOfflineDownload(Number(button.dataset.index));
  });
  $("#offlineCheckSubs")?.addEventListener("click", checkSubscriptions);
  $("#offlineLocalList")?.addEventListener("click", (event) => {
    const retry = event.target.closest("[data-retry]");
    if (retry) return retryEpisodeArchive(retry.dataset.retry);
    const task = event.target.closest("[data-task]");
    if (task) return taskAction(task.dataset.task, task.dataset.action);
    const play = event.target.closest(".offline-play");
    if (play) return playLocalFile(play.dataset.file);
    const remove = event.target.closest(".offline-remove");
    if (!remove) return;
    if (remove.dataset.file) return removeLocalFile(remove.dataset.file);
    if (remove.dataset.job) return removeJob(remove.dataset.job);
  });
  $("#offlineSaveSettings")?.addEventListener("click", saveOfflineSettings);
  // 设置面板已搬进主设置弹窗，但读写逻辑共用这套字段，启动时先填一次。
  loadOfflineSettings();
  $("#offlineMigrate")?.addEventListener("click", migrateMediaRoot);
  $("#offlineResetRoot")?.addEventListener("click", () => {
    $("#offlineMediaRoot").value = "";
    $("#offlineDownloadRoot").value = "";
  });
  $("#offlineLibraryFilter")?.addEventListener("change", (event) => {
    offlineView.library.filter = event.target.value;
    renderLibrary();
  });
  $("#offlineLibrarySearch")?.addEventListener("input", (event) => {
    offlineView.library.query = event.target.value;
    renderLibrary();
  });
  $("#offlineLibraryGrid")?.addEventListener("click", (event) => {
    // 卡片右下角的「▶ 看到 12:34」和封面中央的播放圆钮都是续播入口，
    // 少写一个就会被下面那条「点卡片=打开本地文件」抢走，点了不播反而跳列表。
    const continueButton = event.target.closest(".library-continue, .library-play-fab");
    if (continueButton) {
      event.stopPropagation();
      continueWatching(continueButton.dataset.anime, continueButton.dataset.continue);
      return;
    }
    const card = event.target.closest(".library-card");
    if (card) openAnimeLocalView(card.dataset.anime, card.dataset.name);
  });
  $("#offlineLibraryBack")?.addEventListener("click", openLibraryView);
  $("#offlineSubtitleToggle")?.addEventListener("click", toggleSubtitleRenderer);
  pcInit();
  $("#offlinePlayerClose")?.addEventListener("click", closeOfflinePlayer);
  $("#offlinePlayerBackdrop")?.addEventListener("click", closeOfflinePlayer);
  // 非模态 dialog 按 Esc 不会自动关闭，自己补上（其它弹窗此时已收起）。
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !event.defaultPrevented && !$("#quickRecordDialog")?.open && $("#offlinePlayer")?.open) {
      // 全屏时第一下 Esc 退全屏（对齐 Kazumi 的 exitfullscreen），再按才关播放器。
      if (document.fullscreenElement) {
        event.preventDefault();
        pcToggleFullscreen();
        return;
      }
      event.preventDefault();
      closeOfflinePlayer();
    }
  });
  $("#offlinePlayer")?.addEventListener("close", () => {
    if (offlineView.playing) closeOfflinePlayer();
  });
  $("#offlineVideo")?.addEventListener("ended", () => {
    saveOfflineResume();
  });
});


// ===== 自绘播放器控制栏（Kazumi 式）：原生 controls 移除后的全部界面与快捷键 =====

const PC_PREFS_KEY = "handbook.player.prefs";
const PC_SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];

function pcLoadPrefs() {
  try {
    const raw = JSON.parse(localStorage.getItem(PC_PREFS_KEY) || "{}");
    const skip = Math.round(Number(raw.skip));
    return {
      speed: PC_SPEEDS.includes(Number(raw.speed)) ? Number(raw.speed) : 1,
      volume: Number.isFinite(Number(raw.volume)) ? Math.min(1, Math.max(0, Number(raw.volume))) : 1,
      muted: raw.muted === true,
      // 顶栏快进按钮一次跳的秒数（Kazumi buttonSkipTime），默认 80
      skip: Number.isFinite(skip) && skip > 0 ? Math.min(600, skip) : 80,
    };
  } catch (error) {
    return { speed: 1, volume: 1, muted: false, skip: 80 };
  }
}

function pcSavePrefs(patch) {
  try {
    localStorage.setItem(PC_PREFS_KEY, JSON.stringify({ ...pcLoadPrefs(), ...patch }));
  } catch (error) { /* 忽略 */ }
}

// 快进按钮的界面同步：悬停提示文案 + 图标里的秒数数字都跟着偏好走。
function pcApplySkipUI() {
  const skip = pcLoadPrefs().skip;
  const btn = $("#pcSkipForward");
  if (btn) btn.dataset.tip = `快进${skip}秒，长按修改时间`;
  const glyph = $("#pcSkipGlyphText");
  if (glyph) glyph.textContent = String(skip);
}

function pcOpenSkipDialog() {
  const dialog = $("#pcSkipModal");
  const input = $("#pcSkipInput");
  if (!dialog || !input) return;
  input.value = String(pcLoadPrefs().skip);
  dialog.showModal();
  input.focus();
  input.select();
}

function pcFormatTime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const sec = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${m}:${sec}` : `${m}:${sec}`;
}

function pcKeyOrder(key) {
  const [type, sort] = String(key || "0:0").split(":").map(Number);
  return (type || 0) * 100000 + (sort || 0);
}

function pcSortedFiles() {
  return offlineView.local.files
    .filter((file) => file.exists !== false)
    .sort((a, b) => pcKeyOrder(a.episode_key) - pcKeyOrder(b.episode_key));
}

let pcIdleTimer = 0;
let pcSeeking = false;

function pcWake() {
  const wrap = $("#offlinePlayerVideoWrap");
  if (wrap) wrap.classList.remove("player-idle");
  window.clearTimeout(pcIdleTimer);
  pcIdleTimer = window.setTimeout(pcSleep, 2600);
}

function pcSleep() {
  const wrap = $("#offlinePlayerVideoWrap");
  const video = $("#offlineVideo");
  if (!wrap || !video || video.paused || pcSeeking) return;
  // 面板/菜单开着、正在输弹幕时都不自动藏。
  if ($(".danmaku-panel:not(.hidden)")) return;
  if ($("#pcSpeedMenu") && !$("#pcSpeedMenu").classList.contains("hidden")) return;
  if ($("#pcPlaylistMenu") && !$("#pcPlaylistMenu").classList.contains("hidden")) return;
  if (document.activeElement === $("#dmSendInput")) return;
  wrap.classList.add("player-idle");
}

function pcSync() {
  const video = $("#offlineVideo");
  if (!video) return;
  const duration = Number(video.duration) || 0;
  const current = Number(video.currentTime) || 0;
  const time = $("#pcTime");
  if (time) time.textContent = `${pcFormatTime(current)} / ${pcFormatTime(duration)}`;
  const pct = duration ? Math.min(100, (current / duration) * 100) : 0;
  const played = $("#pcPlayed");
  if (played) played.style.width = `${pct}%`;
  const thumb = $("#pcThumb");
  if (thumb) thumb.style.left = `${pct}%`;
  try {
    const buffered = video.buffered;
    const end = buffered.length ? buffered.end(buffered.length - 1) : 0;
    const node = $("#pcBuffered");
    if (node) node.style.width = `${duration ? Math.min(100, (end / duration) * 100) : 0}%`;
  } catch (error) { /* buffered 偶发不可用 */ }
}

function pcSyncPlayState() {
  const video = $("#offlineVideo");
  const button = $("#pcPlay");
  if (!video || !button) return;
  const playing = !video.paused && !video.ended;
  button.dataset.state = playing ? "playing" : "paused";
  button.setAttribute("aria-label", playing ? "暂停" : "播放");
  pcWake();
}

function pcSyncVolume() {
  const video = $("#offlineVideo");
  const slider = $("#pcVolume");
  const mute = $("#pcMute");
  if (!video || !slider || !mute) return;
  slider.value = String(video.muted ? 0 : video.volume);
  mute.dataset.state = video.muted || video.volume === 0 ? "muted" : "on";
}

function pcSyncSpeed() {
  const video = $("#offlineVideo");
  const button = $("#pcSpeed");
  if (!video || !button) return;
  button.textContent = `${video.playbackRate}x`;
  $$("#pcSpeedMenu [data-rate]").forEach((item) => {
    item.classList.toggle("active", Number(item.dataset.rate) === video.playbackRate);
  });
}

function pcTogglePlay() {
  const video = $("#offlineVideo");
  if (!video || !video.src) return;
  if (video.paused || video.ended) video.play().catch(() => {});
  else video.pause();
}

function pcSeekBy(delta) {
  const video = $("#offlineVideo");
  if (!video || !Number.isFinite(video.duration)) return;
  video.currentTime = Math.min(video.duration, Math.max(0, video.currentTime + delta));
  pcSync();
}

function pcVolumeBy(delta) {
  const video = $("#offlineVideo");
  if (!video) return;
  video.muted = false;
  video.volume = Math.min(1, Math.max(0, Number(video.volume) + delta));
  pcSavePrefs({ volume: video.volume, muted: video.muted });
  pcSyncVolume();
}

function pcToggleMute() {
  const video = $("#offlineVideo");
  if (!video) return;
  video.muted = !video.muted;
  pcSavePrefs({ muted: video.muted });
  pcSyncVolume();
}

function pcToggleFullscreen() {
  const wrap = $("#offlinePlayerVideoWrap");
  if (!wrap) return;
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else wrap.requestFullscreen().catch(() => {});
}

function pcToggleMenu(id) {
  const menu = $(id);
  if (!menu) return;
  const willShow = menu.classList.contains("hidden");
  $$("#playerControls .pc-menu").forEach((node) => node.classList.add("hidden"));
  if (willShow) {
    if (id === "#pcPlaylistMenu") pcRenderPlaylist();
    if (id === "#pcSpeedMenu") pcSyncSpeed();
    menu.classList.remove("hidden");
  }
  pcWake();
}

function pcStep(direction) {
  const files = pcSortedFiles();
  if (!offlineView.playing) return;
  const index = files.findIndex((file) => Number(file.id) === Number(offlineView.playing.id));
  const target = files[index + direction];
  if (target) playLocalFile(target.id);
}

function pcRenderPlaylist() {
  const menu = $("#pcPlaylistMenu");
  if (!menu) return;
  const files = pcSortedFiles();
  menu.innerHTML = files.length
    ? files.map((file) => {
        const current = offlineView.playing && Number(file.id) === Number(offlineView.playing.id);
        return `<button type="button" data-id="${file.id}" class="${current ? "active" : ""}">${current ? "● " : ""}${escapeHtml(episodeLabelOf(file.episode_key))}</button>`;
      }).join("")
    : '<p class="pc-menu-empty">还没有可播放的集</p>';
}

function pcRefreshEpisodes() {
  const files = pcSortedFiles();
  const index = offlineView.playing
    ? files.findIndex((file) => Number(file.id) === Number(offlineView.playing.id))
    : -1;
  const prev = $("#pcPrev");
  const next = $("#pcNext");
  if (prev) prev.disabled = index <= 0;
  if (next) next.disabled = index < 0 || index >= files.length - 1;
  pcRenderPlaylist();
}

// 超分扩展（NijiLucid 等）会把放大后的画面画在自己的 canvas 上，同时把 <video>
// 设成 opacity:0；这时候 drawImage(video) 拿到的还是原分辨率的帧。
// 这里先找视频层里那块覆盖画布（排除弹幕层和字幕层），有就用它。
function pcUpscaleCanvas(video) {
  // 扩展一般把画布塞进 video 的父元素；万一是塞到播放器容器（旧结构/别的扩展），
  // 再往外找一层，两边都兜住。
  const roots = [video?.closest("#pcVideoSurface"), video?.parentElement, video?.closest("#offlinePlayerVideoWrap")];
  const found = [];
  for (const root of roots) {
    if (!root) continue;
    root.querySelectorAll("canvas").forEach((node) => {
      if (node.id === "danmakuCanvas" || node.classList.contains("JASSUB")) return;
      if (!node.width || !node.height) return;
      if (!found.includes(node)) found.push(node);
    });
  }
  if (!found.length) return null;
  // 取面积最大的那块：超分画布是源的 N 倍，弹幕/字幕都比它小。
  const best = found.sort((a, b) => b.width * b.height - a.width * a.height)[0];
  // 比原片还小的画布肯定不是超分结果（可能是某个扩展的 UI 浮层），
  // 用它截图反而会把画面截糊，宁可退回原视频帧。
  const native = Number(video?.videoWidth) || 0;
  if (native && best.width < native) return null;
  return best;
}

// WebGL 画布如果没开 preserveDrawingBuffer，合成之后再去读可能是一张全透明的图。
// 抽 24×14 的小样看一眼，全透明就当没抓到，退回原始视频帧。
function pcCanvasIsBlank(canvas) {
  try {
    const probe = document.createElement("canvas");
    probe.width = 24;
    probe.height = 14;
    const ctx = probe.getContext("2d");
    ctx.drawImage(canvas, 0, 0, probe.width, probe.height);
    const data = ctx.getImageData(0, 0, probe.width, probe.height).data;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] !== 0) return false;
    }
    return true;
  } catch (error) {
    return false;   // 读不出来就别乱退回，按有内容处理
  }
}

// 扩展的 WebGL 画布没开 preserveDrawingBuffer：一帧合成完缓冲区就被清空，
// 这时候 drawImage 拿到的是全透明。只有在「这一帧还没提交」的 rAF 回调里读
// 才是真画面（实测：直接读 0 像素，放进 rAF 满屏有效像素）。
// 后台标签页里 rAF 根本不跑，所以配一个超时兜底，别让截图卡死。
function pcNextFrame(timeout = 220) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => { if (!settled) { settled = true; resolve(ok); } };
    try { requestAnimationFrame(() => finish(true)); } catch (error) { finish(false); }
    window.setTimeout(() => finish(false), timeout);
  });
}

// 抓到超分画面就返回放大的 canvas，抓不到（没开超分/暂停/读不出）返回 null。
// 扩展只在视频出帧时重画：暂停后画布是空的，这时只能退回原画。
// 播放中也不是每帧都读到（刚 seek 完、切集时可能空一两帧），所以多试几帧。
async function pcCaptureUpscaled(video, source = pcUpscaleCanvas(video)) {
  if (!source) return null;
  if (video.paused) return null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (await pcNextFrame(300)) {
      try {
        const picture = pcDrawShot(video, source);
        if (!pcCanvasIsBlank(picture)) return picture;
      } catch (error) {
        // 读不出来就再等一帧
      }
    }
    await new Promise((resolve) => window.setTimeout(resolve, 60));
  }
  // rAF 一直被节流（窗口不可见之类）时，用 createImageBitmap 再兜一次。
  try {
    const bitmap = await createImageBitmap(source);
    const picture = pcDrawShot(bitmap, bitmap);
    bitmap.close?.();
    if (!pcCanvasIsBlank(picture)) return picture;
  } catch (error) {
    // 忽略：交给调用方退回原始帧
  }
  return null;
}

function pcDrawShot(video, source) {
  const width = source ? (source.width || source.videoWidth) : video.videoWidth;
  const height = source ? (source.height || source.videoHeight) : video.videoHeight;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d").drawImage(source || video, 0, 0, width, height);
  return canvas;
}

// 4K 的 PNG 常有 10~14MB，截图入口按 24MB 请求体放宽后能直接收；
// 只有真的超了才按面积比例缩一档（不是一刀切回 1080p，尽量保住超分后的清晰度）。
function pcShotBlob(canvas, maxBytes = 14 * 1024 * 1024) {
  const encode = (source) => new Promise((resolve, reject) => {
    source.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("浏览器没有返回图片"))), "image/png");
  });
  return (async () => {
    let current = canvas;
    let blob = await encode(current);
    for (let attempt = 0; attempt < 3 && blob.size > maxBytes && current.width > 1600; attempt += 1) {
      const scale = Math.max(0.6, Math.sqrt((maxBytes / blob.size)) * 0.94);
      const scaled = document.createElement("canvas");
      scaled.width = Math.round(current.width * scale);
      scaled.height = Math.round(current.height * scale);
      scaled.getContext("2d").drawImage(current, 0, 0, scaled.width, scaled.height);
      current = scaled;
      blob = await encode(current);
    }
    // 带上最终尺寸：缩过图的话外面要按实际存的尺寸提示，不能报原始大小。
    return { blob, width: current.width, height: current.height };
  })();
}

async function pcScreenshot() {
  const video = $("#offlineVideo");
  if (!video || !video.videoWidth) {
    toast("视频还没准备好，先等画面出来再截图", "error");
    return;
  }
  const upscaleCanvas = pcUpscaleCanvas(video);
  let canvas = upscaleCanvas ? await pcCaptureUpscaled(video, upscaleCanvas) : null;
  let upscaled = Boolean(canvas);
  if (!canvas) {
    // 没开超分、或者这帧没读到内容：老老实实截原始帧，至少不会是张透明图。
    try {
      canvas = pcDrawShot(video, null);
      upscaled = false;
    } catch (error) {
      toast(`截图失败：${error.message || error}`, "error");
      return;
    }
  }
  let blob;
  let shotSize = { width: canvas.width, height: canvas.height };
  try {
    const shot = await pcShotBlob(canvas);
    blob = shot.blob;
    shotSize = { width: shot.width, height: shot.height };
  } catch (error) {
    toast(`截图失败：${error.message || error}`, "error");
    return;
  }
  const anime = offlineView.animeName || "动漫";
  const episode = episodeLabelOf(offlineView.playing?.episode_key) || "第0集";
  const sizeTag = upscaled ? `超分 ${shotSize.width}×${shotSize.height} · ` : "";
  // 开着超分却没截到，只可能是暂停（扩展暂停后不再重画）：说清楚，别让人以为功能没生效。
  const shotNote = !upscaled && upscaleCanvas && video.paused ? "（暂停时截的是原画，播放中才有超分）" : "";
  // 先进媒体库的图片库（按番名分文件夹、按模板命名）；后台不可用时退回浏览器下载。
  try {
    const data = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(reader.error || new Error("读取截图失败"));
      reader.readAsDataURL(blob);
    });
    const result = await api("/api/offline/screenshot", {
      method: "POST",
      body: JSON.stringify({ anime, episode, seconds: video.currentTime, data }),
    });
    toast(`已存入媒体库 · ${sizeTag}图片：「${result.folder}」/ ${result.name}${shotNote}`);
  } catch (error) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const stamp = pcFormatTime(video.currentTime).replace(/:/g, "-");
    link.href = url;
    link.download = `${anime} ${episode} ${stamp}.png`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast(`入库失败（${error.message || error}），已改为下载到浏览器${shotNote}`, "error");
  }
}

function pcSendDanmaku() {
  const input = $("#dmSendInput");
  const text = String(input?.value || "").trim();
  if (!text || typeof dmSendMine !== "function") return;
  if (dmSendMine(text)) {
    input.value = "";
    toast(danmakuView.settings.enabled ? "弹幕已发出（保存在本机）" : "已记录；弹幕当前隐藏，开启后可见");
  }
}

// 播放器快捷键的动作表：id 必须和 keyboard.js 里的 player_* 一一对应。
const PC_SHORTCUT_RUNNERS = {
  player_play_pause: () => pcTogglePlay(),
  player_rewind: () => pcSeekBy(-5),
  player_forward: () => pcSeekBy(5),
  player_skip: () => pcSeekBy(pcLoadPrefs().skip),
  player_prev: () => pcStep(-1),
  player_next: () => pcStep(1),
  player_volume_up: () => pcVolumeBy(0.05),
  player_volume_down: () => pcVolumeBy(-0.05),
  player_mute: () => pcToggleMute(),
  player_fullscreen: () => pcToggleFullscreen(),
  player_danmaku: () => $("#offlineDanmakuToggle")?.click(),
  player_screenshot: () => pcScreenshot(),
  player_speed_up: () => pcStepSpeed(1),
  player_speed_down: () => pcStepSpeed(-1),
  player_speed_1: () => pcApplySpeed(1),
  player_speed_2: () => pcApplySpeed(2),
  player_speed_3: () => pcApplySpeed(3),
};

// 播放器里的「快捷键」说明：按当前绑定生成，用户改过键位也不会说错。
function pcRenderShortcutHelp() {
  const list = $("#pcShortcutHelpList");
  if (!list || typeof SHORTCUT_ACTIONS === "undefined" || typeof keyboardPreferences !== "function") return;
  const preferences = keyboardPreferences();
  const keysOf = (id) => {
    const item = preferences.bindings[id];
    if (!preferences.enabled || !item?.enabled) return "";
    return item.keys.map((key) => `<b>${shortcutLabel(key)}</b>`).join(" / ");
  };
  const lines = [
    ["player_play_pause", "player_rewind", "player_forward", "player_skip"],
    ["player_volume_up", "player_volume_down", "player_mute", "player_fullscreen"],
    ["player_prev", "player_next", "player_danmaku", "player_screenshot"],
    ["player_speed_down", "player_speed_up", "player_speed_1", "player_speed_2", "player_speed_3"],
  ];
  list.innerHTML = lines.map((ids) => {
    const parts = ids
      .map((id) => ({ action: SHORTCUT_ACTIONS.find((row) => row.id === id), keys: keysOf(id) }))
      .filter((row) => row.action && row.keys)
      .map((row) => `${row.keys} ${row.action.name.replace(/（.*?）/, "")}`);
    return parts.length ? `<li>${parts.join(" · ")}</li>` : "";
  }).filter(Boolean).join("") || '<li>播放器快捷键已全部关闭，可在设置里重新启用。</li>';
}

function pcApplySpeed(rate) {
  const video = $("#offlineVideo");
  if (!video || !PC_SPEEDS.includes(rate)) return;
  video.playbackRate = rate;
  pcSavePrefs({ speed: rate });
  pcSyncSpeed();
}

function pcStepSpeed(delta) {
  const video = $("#offlineVideo");
  if (!video) return;
  const index = PC_SPEEDS.indexOf(video.playbackRate);
  const next = Math.min(PC_SPEEDS.length - 1, Math.max(0, (index < 0 ? PC_SPEEDS.indexOf(1) : index) + delta));
  pcApplySpeed(PC_SPEEDS[next]);
}

// 当前按键命中哪个播放器动作；读用户的快捷键配置，读不到就退回默认键位。
function pcShortcutActionFor(event) {
  if (typeof shortcutKey !== "function" || typeof keyboardPreferences !== "function") return "";
  const preferences = keyboardPreferences();
  if (!preferences.enabled) return "";
  const key = shortcutKey(event);
  if (!key) return "";
  const match = SHORTCUT_ACTIONS.find((action) => action.scope === "player"
    && preferences.bindings[action.id]?.enabled
    && preferences.bindings[action.id].keys.includes(key));
  return match?.id || "";
}

function pcInit() {
  if (pcInit.bound) return;
  pcInit.bound = true;
  const video = $("#offlineVideo");
  const wrap = $("#offlinePlayerVideoWrap");
  const bar = $("#pcProgress");
  if (!video || !wrap || !bar) return;

  $("#pcPlay")?.addEventListener("click", pcTogglePlay);
  $("#pcPrev")?.addEventListener("click", () => pcStep(-1));
  $("#pcNext")?.addEventListener("click", () => pcStep(1));
  $("#pcFullscreen")?.addEventListener("click", pcToggleFullscreen);
  $("#pcMute")?.addEventListener("click", pcToggleMute);
  $("#pcPip")?.addEventListener("click", () => {
    if (!document.pictureInPictureEnabled) {
      toast("这个浏览器不支持画中画", "error");
      return;
    }
    if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
    else video.requestPictureInPicture().catch((error) => toast(`画中画没打开：${error.message || error}`, "error"));
  });
  $("#pcSpeed")?.addEventListener("click", () => pcToggleMenu("#pcSpeedMenu"));
  $("#pcPlaylist")?.addEventListener("click", () => pcToggleMenu("#pcPlaylistMenu"));
  $("#pcSpeedMenu")?.addEventListener("click", (event) => {
    const item = event.target.closest("[data-rate]");
    if (!item) return;
    video.playbackRate = Number(item.dataset.rate);
    pcSavePrefs({ speed: video.playbackRate });
    pcSyncSpeed();
    $("#pcSpeedMenu")?.classList.add("hidden");
  });
  $("#pcPlaylistMenu")?.addEventListener("click", (event) => {
    const item = event.target.closest("[data-id]");
    if (!item) return;
    $("#pcPlaylistMenu")?.classList.add("hidden");
    playLocalFile(Number(item.dataset.id));
  });
  $("#pcScreenshot")?.addEventListener("click", pcScreenshot);
  $(".pc-shortcuts")?.addEventListener("toggle", (event) => {
    if (event.target.open) pcRenderShortcutHelp();
  });
  // 顶栏快进按钮（Kazumi 式）：单击跳 skip 秒，长按 500ms 弹「跳过秒数」对话框。
  pcApplySkipUI();
  let pcSkipPressTimer = 0;
  let pcSkipLongPressed = false;
  $("#pcSkipForward")?.addEventListener("click", () => {
    if (pcSkipLongPressed) { pcSkipLongPressed = false; return; }
    const target = video.currentTime + pcLoadPrefs().skip;
    video.currentTime = Number.isFinite(video.duration) && video.duration > 0
      ? Math.min(video.duration - 0.05, target)
      : target;
  });
  $("#pcSkipForward")?.addEventListener("pointerdown", () => {
    pcSkipLongPressed = false;
    pcSkipPressTimer = setTimeout(() => {
      pcSkipLongPressed = true;
      pcOpenSkipDialog();
    }, 500);
  });
  ["pointerup", "pointerleave", "pointercancel"].forEach((type) => {
    $("#pcSkipForward")?.addEventListener(type, () => clearTimeout(pcSkipPressTimer));
  });
  $("#pcSkipForward")?.addEventListener("contextmenu", (event) => event.preventDefault());
  // 长按后 click 可能被模态弹窗吞掉，抑制标志要在弹窗关闭时复位，
  // 否则下一次点击（尤其键盘触发的、不带 pointerdown）会被误吃。
  $("#pcSkipModal")?.addEventListener("close", () => { pcSkipLongPressed = false; });
  $("#pcSkipInput")?.addEventListener("input", (event) => {
    event.target.value = event.target.value.replace(/\D+/g, "").slice(0, 3);
  });
  $("#pcSkipSave")?.addEventListener("click", () => {
    const value = Math.min(600, Math.max(1, parseInt($("#pcSkipInput")?.value, 10) || 0));
    if (value) {
      pcSavePrefs({ skip: value });
      pcApplySkipUI();
      toast(`快进秒数已改为 ${value} 秒`);
    }
    $("#pcSkipModal")?.close();
  });
  $("#pcSendFocus")?.addEventListener("click", () => {
    pcWake();
    $("#dmSendInput")?.focus();
  });
  $("#dmSendButton")?.addEventListener("click", pcSendDanmaku);
  $("#dmSendInput")?.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Enter") {
      event.preventDefault();
      pcSendDanmaku();
    }
  });
  $("#pcVolume")?.addEventListener("input", (event) => {
    video.muted = false;
    video.volume = Number(event.target.value);
    pcSavePrefs({ volume: video.volume, muted: video.muted });
    pcSyncVolume();
  });

  // 进度条：点按/拖动跳转；悬停显示时间。
  const seekTo = (event) => {
    const rect = bar.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    if (Number.isFinite(video.duration)) video.currentTime = ratio * video.duration;
  };
  bar.addEventListener("pointerdown", (event) => {
    pcSeeking = true;
    bar.setPointerCapture(event.pointerId);
    seekTo(event);
  });
  bar.addEventListener("pointermove", (event) => {
    if (pcSeeking) seekTo(event);
    const rect = bar.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    const tooltip = $("#pcTooltip");
    if (tooltip && Number.isFinite(video.duration)) {
      tooltip.hidden = false;
      tooltip.textContent = pcFormatTime(ratio * video.duration);
      tooltip.style.left = `${Math.min(96, Math.max(2, ratio * 100))}%`;
    }
  });
  bar.addEventListener("pointerup", (event) => {
    if (pcSeeking) seekTo(event);
    pcSeeking = false;
  });
  bar.addEventListener("pointerleave", () => {
    const tooltip = $("#pcTooltip");
    if (tooltip) tooltip.hidden = true;
  });

  video.addEventListener("timeupdate", pcSync);
  video.addEventListener("progress", pcSync);
  video.addEventListener("durationchange", pcSync);
  video.addEventListener("play", pcSyncPlayState);
  video.addEventListener("pause", pcSyncPlayState);
  video.addEventListener("ended", pcSyncPlayState);
  video.addEventListener("volumechange", pcSyncVolume);
  video.addEventListener("ratechange", pcSyncSpeed);

  // 点画面 = 播放/暂停；双击 = 全屏（Kazumi 习惯）。
  let pcClickTimer = 0;
  wrap.addEventListener("click", (event) => {
    if (event.target.closest("button, input, select, .danmaku-panel, .pc-progress, .pc-menu")) return;
    window.clearTimeout(pcClickTimer);
    pcClickTimer = window.setTimeout(() => pcTogglePlay(), 220);
  });
  wrap.addEventListener("dblclick", (event) => {
    if (event.target.closest("button, input, select, .danmaku-panel, .pc-progress, .pc-menu")) return;
    window.clearTimeout(pcClickTimer);
    pcToggleFullscreen();
  });

  // 鼠标不动 2.6 秒自动藏控制栏；暂停/面板打开时永远显示。
  wrap.addEventListener("mousemove", pcWake);
  wrap.addEventListener("pointerdown", pcWake);
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".pc-pop-host")) {
      $$("#playerControls .pc-menu").forEach((node) => node.classList.add("hidden"));
    }
  });

  // 快捷键：按键映射统一来自 设置 → 快捷键（keyboard.js 的 SHORTCUT_ACTIONS，
  // scope=player）。这里只负责把动作 id 派发到播放器函数，键位不再写死在 switch 里，
  // 用户在设置里改/禁用都能生效。
  document.addEventListener("keydown", (event) => {
    if (!$("#offlinePlayer")?.open || $("#quickRecordDialog")?.open || pcSeeking) return;
    if (event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229) return;
    if (event.target.closest?.("input, textarea, select, [contenteditable]")) return;
    const actionId = pcShortcutActionFor(event);
    if (!actionId) return;
    const handler = PC_SHORTCUT_RUNNERS[actionId];
    if (!handler) return;
    event.preventDefault();
    handler(video);
    pcWake();
  });

  const prefs = pcLoadPrefs();
  video.volume = prefs.volume;
  video.muted = prefs.muted;
  video.playbackRate = prefs.speed;
  const speedMenu = $("#pcSpeedMenu");
  if (speedMenu) {
    // 只显示倍率，和菜单里其它档位一致；以前 1x 后面还跟一个「正常」，看着像两种信息。
    speedMenu.innerHTML = PC_SPEEDS.map(
      (rate) => `<button type="button" data-rate="${rate}"><span>${rate}x</span></button>`,
    ).join("");
  }
  pcSyncVolume();
  pcSyncSpeed();
  pcRefreshEpisodes();
}

function formatSpeed(bytes) {
  const value = Number(bytes || 0);
  if (value <= 0) return "0 B";
  if (value >= 1 << 20) return `${(value / (1 << 20)).toFixed(1)} MB`;
  if (value >= 1 << 10) return `${(value / (1 << 10)).toFixed(0)} KB`;
  return `${value} B`;
}

function formatEta(seconds) {
  const value = Number(seconds || 0);
  if (value <= 0) return "";
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  if (hours > 0) return `${hours} 小时 ${minutes} 分`;
  if (minutes > 0) return `${minutes} 分`;
  return `${value} 秒`;
}

async function retryEpisodeArchive(mediaId) {
  const button = $(`#offlineLocalList [data-retry="${mediaId}"]`);
  if (button) { button.disabled = true; button.textContent = "整理中…"; }
  try {
    await api("/api/offline/retry", {
      method: "POST",
      body: JSON.stringify({ media_id: Number(mediaId) }),
    });
    toast("已重新开始整理，稍等一下");
    window.setTimeout(refreshOfflineLocal, 1500);
  } catch (error) {
    if (button) { button.disabled = false; button.textContent = "重试归档"; }
    toast(error.message || "重试失败", "error");
  }
}

async function taskAction(mediaId, action) {
  try {
    await api("/api/offline/task", {
      method: "POST",
      body: JSON.stringify({ media_id: Number(mediaId), action }),
    });
    toast(action === "pause" ? "已暂停" : "已继续");
    refreshOfflineLocal();
  } catch (error) {
    toast(error.message || "操作失败", "error");
  }
}

async function loadOfflineSettings() {
  const status = "#offlineSettingsStatus";
  offlineStatus(status, "读取设置…");
  try {
    const data = await api("/api/offline/settings");
    const config = data.config || {};
    $("#offlineMediaRoot").value = config.media_root || "";
    $("#offlineDownloadRoot").value = config.download_root || "";
    $("#offlineScreenshotRoot").value = config.screenshot_root || "";
    $("#offlineScreenshotName").value = config.screenshot_name_format || "";
    $("#offlineQbHost").value = config.qb_host || "127.0.0.1";
    $("#offlineQbPort").value = config.qb_port || 8080;
    $("#offlineQbCategory").value = config.qb_category || "AnimeHandbook";
    $("#offlineSeedAfter").checked = config.seed_after_done !== false;
    $("#offlineAutoFollow").checked = config.auto_follow === true;
    const paths = data.paths || {};
    $("#offlineMediaRoot").placeholder = data.default_media_root || "";
    $("#offlineMediaHint").textContent = `当前实际使用：${paths.media_root || "?"} / ${paths.download_root || "?"}`;
    if ($("#offlineScreenshotHint")) $("#offlineScreenshotHint").textContent = `截图实际保存到：${paths.screenshot_root || "?"}`;
    const writable = data.writable || {};
    const room = writable.free_gb ? `，剩余 ${writable.free_gb} GB` : "";
    offlineStatus(
      status,
      writable.ok ? `目录可写${room}` : writable.error || "目录不可写",
      !writable.ok,
    );
  } catch (error) {
    offlineStatus(status, error.message || "读取设置失败", true);
  }
}

async function saveOfflineSettings() {
  const status = "#offlineSettingsStatus";
  offlineStatus(status, "保存中…");
  try {
    const data = await api("/api/offline/settings", {
      method: "POST",
      body: JSON.stringify({
        media_root: $("#offlineMediaRoot").value.trim(),
        download_root: $("#offlineDownloadRoot").value.trim(),
        screenshot_root: $("#offlineScreenshotRoot").value.trim(),
        screenshot_name_format: $("#offlineScreenshotName").value.trim(),
        qb_host: $("#offlineQbHost").value.trim() || "127.0.0.1",
        qb_port: Number($("#offlineQbPort").value) || 8080,
        qb_category: $("#offlineQbCategory").value.trim() || "AnimeHandbook",
        seed_after_done: $("#offlineSeedAfter").checked,
        auto_follow: $("#offlineAutoFollow").checked,
      }),
    });
    const paths = data.paths || {};
    $("#offlineMediaHint").textContent = `当前实际使用：${paths.media_root || "?"} / ${paths.download_root || "?"}`;
    if ($("#offlineScreenshotHint")) $("#offlineScreenshotHint").textContent = `截图实际保存到：${paths.screenshot_root || "?"}`;
    const writable = data.writable || {};
    offlineStatus(status, writable.ok ? "已保存，目录可写" : writable.error || "已保存，但目录不可写", !writable.ok);
    toast("离线设置已保存");
  } catch (error) {
    offlineStatus(status, error.message || "保存失败", true);
    toast(error.message || "保存失败", "error");
  }
}


async function subscribeFromResult(index) {
  const item = offlineVisibleItems()[index];
  if (!item) return;
  const keyword = $("#offlineQuery").value.trim();
  if (!keyword) return;
  const who = item.group || "这个关键词";
  try {
    const data = await api("/api/offline/subscribe", {
      method: "POST",
      body: JSON.stringify({
        anime_id: offlineView.animeId,
        keyword,
        group_name: item.group || "",
        enabled: true,
      }),
    });
    // 自动追番默认是关的。没开的时候说「已订阅就会自动下」是空头支票，
    // 必须把「还要去设置里打开总开关」讲出来。
    const autoFollow = Boolean(data && data.auto_follow);
    toast(
      autoFollow
        ? `已订阅「${who}」的新集`
        : `已订阅「${who}」；到 设置 → 数据来源 打开「自动追新番」后才会自动下载`,
    );
  } catch (error) {
    toast(error.message || "订阅失败", "error");
  }
}

async function checkSubscriptions() {
  try {
    const data = await api("/api/offline/check", {
      method: "POST",
      body: JSON.stringify({ force: true }),
    });
    const downloaded = Number(data.downloaded || 0);
    const checked = Number(data.checked || 0);
    toast(checked ? (downloaded ? `检查 ${checked} 条，下载了 ${downloaded} 集` : `检查 ${checked} 条，没有新集`) : "没有需要检查的订阅");
    refreshOfflineLocal();
  } catch (error) {
    toast(error.message || "检查失败", "error");
  }
}


async function migrateMediaRoot() {
  const target = $("#offlineMediaRoot").value.trim();
  if (!target) {
    toast("先在上面「媒体库目录」填目标路径", "error");
    return;
  }
  if (!window.confirm(`把已入库的文件复制到\n${target}\n\n复制并逐个校验大小，全部成功才切换目录；原文件保留不删。`)) return;
  const status = "#offlineSettingsStatus";
  offlineStatus(status, "正在复制…文件多的时候会慢一会儿");
  try {
    const data = await api("/api/offline/migrate", {
      method: "POST",
      body: JSON.stringify({ target }),
    });
    const failed = data.failed || [];
    if (failed.length) {
      // 后端是「全做完才切换」：失败时数据库和配置都没动，副本也已经清掉。
      const reason = failed.length === 1 ? failed[0].reason : `${failed.length} 个文件没复制成功`;
      offlineStatus(status, `迁移没有执行：${reason}。新目录里的副本已清掉，媒体库仍是原目录`, true);
      toast("迁移没有执行，媒体库仍是原目录", "error");
    } else {
      const warnings = (data.warnings || []).length;
      const extra = data.fonts ? `，字体 ${data.fonts} 个` : "";
      offlineStatus(
        status,
        `已迁移 ${data.copied} 集${extra}，目录已切换${warnings ? `（${warnings} 个字体没复制过去）` : ""}`,
      );
      toast(`迁移完成：${data.copied} 集`);
      refreshOfflineLocal();
    }
  } catch (error) {
    offlineStatus(status, error.message || "迁移失败", true);
    toast(error.message || "迁移失败", "error");
  }
}


// ---- 页面内字幕：jassub（libass 的 wasm 版，和弹弹play / Kazumi 同一个渲染引擎） ----
// 资源全部打包在 /vendor/jassub 下，离线可用，不依赖任何 CDN。
const JASSUB_ASSET = "/vendor/jassub";
// 预热实例先挂一个空字幕轨，等真正播放时再用 setTrack 换成这一集的字幕，
// 这样就不用为每集重新编译 2MB wasm（冷启动约 10 秒，换轨是瞬时的）。
const EMPTY_ASS = "[Script Info]\nScriptType: v4.00+\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,20,1\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n";

function loadJassub() {
  if (window.JASSUB) return Promise.resolve(window.JASSUB);
  if (!offlineView.jassubPromise) {
    offlineView.jassubPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = `${JASSUB_ASSET}/jassub.bundle.js`;
      script.onload = () => (window.JASSUB ? resolve(window.JASSUB) : reject(new Error("字幕渲染器没有正常加载")));
      script.onerror = () => reject(new Error("字幕渲染器加载失败"));
      document.head.appendChild(script);
    });
  }
  return offlineView.jassubPromise;
}

function warmSubtitleRenderer() {
  if (offlineView.subtitleBoot) return offlineView.subtitleBoot;
  const video = $("#offlineVideo");
  if (!video) return null;
  offlineView.subtitleBoot = loadJassub()
    .then((JASSUB) => {
      // 顺手把 worker/wasm/字体塞进 HTTP 缓存，避免点播放时和视频流抢连接。
      [
        "jassub-worker.bundle.js",
        "wasm/jassub-worker.js",
        "wasm/jassub-worker-modern.js",
        "wasm/jassub-worker.wasm",
        "wasm/jassub-worker-modern.wasm",
        "default.woff2",
        "noto-sans-sc-400.woff2",
      ].forEach((name) => {
        const link = document.createElement("link");
        link.rel = "prefetch";
        link.href = `${JASSUB_ASSET}/${name}`;
        document.head.appendChild(link);
      });
      const instance = new JASSUB({
        video,
        subContent: EMPTY_ASS,
        workerUrl: `${JASSUB_ASSET}/jassub-worker.bundle.js`,
        wasmWorkerUrl: `${JASSUB_ASSET}/wasm/jassub-worker.js`,
        wasmUrl: `${JASSUB_ASSET}/wasm/jassub-worker.wasm`,
        modernWasmWorkerUrl: `${JASSUB_ASSET}/wasm/jassub-worker-modern.js`,
        modernWasmUrl: `${JASSUB_ASSET}/wasm/jassub-worker-modern.wasm`,
        // 字幕组的 ASS 里写死的字体名（方正兰亭黑、思源黑体…）本机不一定有，
        // 全部回退到打包的 Noto Sans SC（OFL 授权，1.1MB，含简体中文），
        // 否则中文字幕会变成一片豆腐块。
        availableFonts: {
          "liberation sans": `${JASSUB_ASSET}/default.woff2`,
          "noto sans sc": `${JASSUB_ASSET}/noto-sans-sc-400.woff2`,
          "noto sans cjk sc": `${JASSUB_ASSET}/noto-sans-sc-400.woff2`,
          "source han sans": `${JASSUB_ASSET}/noto-sans-sc-400.woff2`,
          "思源黑体": `${JASSUB_ASSET}/noto-sans-sc-400.woff2`,
          "microsoft yahei": `${JASSUB_ASSET}/noto-sans-sc-400.woff2`,
          "微软雅黑": `${JASSUB_ASSET}/noto-sans-sc-400.woff2`,
          "simhei": `${JASSUB_ASSET}/noto-sans-sc-400.woff2`,
          "黑体": `${JASSUB_ASSET}/noto-sans-sc-400.woff2`,
          "方正兰亭黑": `${JASSUB_ASSET}/noto-sans-sc-400.woff2`,
          "arial": `${JASSUB_ASSET}/noto-sans-sc-400.woff2`,
        },
        defaultFont: "noto sans sc",
        queryFonts: false,
      });
      return instance.ready.then(() => ({
        instance,
        canvas: video.parentElement?.querySelector("canvas.JASSUB") || null,
        enabled: true,
        fileId: 0,
      }));
    })
    .catch((error) => {
      console.warn("字幕渲染器预热失败：", error);
      offlineView.subtitleBoot = null;
      return null;
    });
  return offlineView.subtitleBoot;
}

async function setupSubtitleRenderer(file, video) {
  const token = ++offlineView.subtitleToken;
  try {
    const [response, fontData] = await Promise.all([
      fetch(`/api/offline/subtitle/${file.id}`),
      fetch(`/api/offline/fonts/${file.id}`)
        .then((result) => (result.ok ? result.json() : { items: [] }))
        .catch(() => ({ items: [] })),
    ]);
    if (!response.ok) throw new Error("字幕文件读取失败");
    const subContent = await response.text();
    const boot = warmSubtitleRenderer();
    if (!boot) throw new Error("字幕渲染器不可用");
    // 首次要编译 wasm，给足时间；超时只影响提示，不影响视频播放。
    const session = await Promise.race([
      boot,
      new Promise((_, reject) => window.setTimeout(() => reject(new Error("字幕渲染器启动超时")), 30000)),
    ]);
    if (!session) throw new Error("字幕渲染器启动失败");
    if (token !== offlineView.subtitleToken) return; // 期间已经换集或关掉播放器
    // 片源自带的字体优先：libass 按 ASS 里写死的字体名匹配这些附件，
    // 匹配不到才回退到打包的 Noto Sans SC。同一套字体不重复加载。
    const fontUrls = (fontData.items || []).map((item) => item.url).filter(Boolean);
    const fontKey = fontUrls.join("|");
    if (fontUrls.length && session.loadedFontKey !== fontKey) {
      await session.instance.renderer.addFonts(fontUrls);
      session.loadedFontKey = fontKey;
    }
    if (token !== offlineView.subtitleToken) return;
    if (session.fileId !== file.id) {
      await session.instance.renderer.setTrack(subContent);
      session.fileId = file.id;
    }
    if (token !== offlineView.subtitleToken) return;
    session.enabled = true;
    if (session.canvas) session.canvas.style.display = "";
    offlineView.subtitle = session;
    const fontNote = fontUrls.length ? ` · 已加载 ${fontUrls.length} 个片源字体` : "";
    $("#offlinePlayerMeta").textContent = `页面内字幕已开启${fontNote}，右侧可随时关闭；视频播放不受字幕影响。`;
  } catch (error) {
    if (token !== offlineView.subtitleToken) return;
    console.warn("字幕渲染器初始化失败：", error);
    $("#offlineSubtitleToggle").classList.add("hidden");
    $("#offlinePlayerMeta").textContent = "页面内字幕没起来，可用外部播放器打开这一集；视频播放不受影响。";
  }
}

// 只结束这一集的会话，渲染器实例留着给下一集复用。
function clearSubtitleSession() {
  offlineView.subtitleToken += 1;
  offlineView.subtitle = null;
  $("#offlineSubtitleToggle")?.classList.add("hidden");
}

function toggleSubtitleRenderer() {
  const current = offlineView.subtitle;
  if (!current) return;
  current.enabled = !current.enabled;
  if (current.canvas) current.canvas.style.display = current.enabled ? "" : "none";
  const button = $("#offlineSubtitleToggle");
  button.textContent = current.enabled ? "字幕 · 开" : "字幕 · 关";
  button.setAttribute("aria-pressed", String(current.enabled));
  button.classList.toggle("is-off", !current.enabled);
}
