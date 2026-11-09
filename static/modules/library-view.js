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
  imagesLoaded: false,
  items: [],
  disk: null,
  filter: "all",
  query: "",
  token: 0,
  loaded: false,
  detail: null,       // 打开的番 { animeId, name }
  files: [],
  jobs: [],
  sourceFilter: "",   // 选中的字幕组（多来源时）
  subs: [],
  subsLoaded: false,
  searching: false,
};

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
  $("#libraryMediaPanel")?.classList.toggle("hidden", tab !== "media");
  $("#libraryDetailPanel")?.classList.toggle("hidden", tab !== "media" || !librarySidebar.detail);
  $("#librarySubsPanel")?.classList.toggle("hidden", tab !== "subs");
  $("#librarySearchPanel")?.classList.toggle("hidden", tab !== "search");
  if (tab === "media") loadLibrarySidebar();
  if (tab === "subs") loadLibrarySubs();
}

// ---------- 媒体库总览 ----------

async function loadLibrarySidebar() {
  const token = ++librarySidebar.token;
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
      if (grid) grid.innerHTML = `<p class="offline-empty">媒体库加载失败：${escapeHtml(error.message || error)}</p>`;
    }
  }
}

function libFilteredItems() {
  const { items, filter, query } = librarySidebar;
  const q = query.trim().toLowerCase();
  return items.filter((item) =>
    (filter === "all" || String(item.collection_type) === filter)
    && (!q || item.name.toLowerCase().includes(q)));
}

function renderLibraryGrid() {
  const grid = $("#libGrid");
  if (!grid) return;
  const visible = libFilteredItems();
  grid.innerHTML = visible.length
    ? visible.map((item) => libraryCard(item)).join("")
    : '<p class="offline-empty">这里还没有可以播的番：用「找资源」下载几集，或到设置里检查媒体库目录</p>';
  const disk = librarySidebar.disk;
  const diskNode = $("#libDisk");
  if (diskNode) {
    diskNode.textContent = disk && disk.total_gb
      ? `媒体库目录 ${disk.media_root} · 剩余 ${disk.free_gb} GB / 共 ${disk.total_gb} GB`
      : "";
    diskNode.classList.toggle("hidden", !diskNode.textContent);
  }
}

// ---------- 番详情：按字幕组区分来源 ----------

async function openLibraryDetail(animeId, name) {
  librarySidebar.detail = { animeId: Number(animeId) || 0, name: String(name || "") };
  switchLibraryTab("media");
  const panel = $("#libraryDetailPanel");
  if (panel) panel.classList.remove("hidden");
  $("#libDetailTitle").textContent = librarySidebar.detail.name || `番剧 ${animeId}`;
  $("#libDetailCover").src = `/api/covers/${animeId}`;
  $("#libDetailMeta").textContent = "加载中…";
  $("#libEpisodes").innerHTML = "";
  $("#libSourceChips").classList.add("hidden");
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
  const sizeText = totalSize >= (1 << 30)
    ? `${(totalSize / (1 << 30)).toFixed(1)} GB`
    : `${Math.max(1, Math.round(totalSize / (1 << 20)))} MB`;
  const meta = $("#libDetailMeta");
  const metaParts = [`已收 ${librarySidebar.files.length} 集`];
  if (librarySidebar.detail.episodeCount) metaParts.push(`全 ${librarySidebar.detail.episodeCount} 集`);
  metaParts.push(sizeText);
  if (multiple) metaParts.push(`${groups.length} 个来源`);
  meta.textContent = metaParts.join(" · ");
  const host = $("#libEpisodes");
  host.innerHTML = files.length
    ? files.map((file) => {
        const group = String(file.group_name || "").trim();
        const size = Number(file.file_size) >= (1 << 20)
          ? `${Math.round(Number(file.file_size) / (1 << 20))} MB`
          : `${Math.max(1, Math.round((Number(file.file_size) || 0) / 1024))} KB`;
        const resume = Number(file.resume_ms) || 0;
        const minutes = Math.floor(resume / 60000);
        const seconds = String(Math.floor((resume % 60000) / 1000)).padStart(2, "0");
        const bits = [group || "来源未知", size];
        if (file.subtitle_path) bits.push("内封字幕");
        if (resume > 0) bits.push(`看到 ${minutes}:${seconds}`);
        return `<div class="lib-episode" data-id="${file.id}">
          <div class="lib-ep-info">
            <b>${escapeHtml(episodeLabelOf(file.episode_key))}</b>
            <small>${escapeHtml(bits.join(" · "))}</small>
            ${file.source_title ? `<small class="lib-source-title" title="${escapeHtml(file.source_title)}">${escapeHtml(file.source_title)}</small>` : ""}
          </div>
          <div class="lib-ep-actions">
            <button type="button" class="pc-btn pc-text lib-play" data-id="${file.id}">播放</button>
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
    if (status) status.textContent = librarySidebar.subs.length ? "" : "还没有订阅。到「找资源」搜到资源后点「订阅」，新集就会自动下载。";
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
    return `<div class="lib-sub-item" data-id="${sub.id}">
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
  $$("#libraryKindSwitch .library-kind-btn").forEach((button) => {
    const active = button.dataset.libraryKind === librarySidebar.kind;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
  $("#libraryVideoPane")?.classList.toggle("hidden", librarySidebar.kind !== "video");
  $("#libraryImagePane")?.classList.toggle("hidden", librarySidebar.kind !== "image");
  $("#libraryDetailPanel")?.classList.toggle("hidden", librarySidebar.kind !== "video" || !librarySidebar.detail);
  if (librarySidebar.kind === "image") loadLibraryImages();
}

async function loadLibraryImages() {
  const hint = $("#libImageHint");
  if (hint && !librarySidebar.imagesLoaded) hint.textContent = "读取截图…";
  try {
    const data = await api("/api/offline/screenshots");
    librarySidebar.imageGroups = data.groups || [];
    librarySidebar.imageRoot = data.root || "";
    librarySidebar.imageTotal = Number(data.count || 0);
    librarySidebar.imagesLoaded = true;
    const badge = $("#libraryImageCount");
    if (badge) badge.textContent = librarySidebar.imageTotal ? String(librarySidebar.imageTotal) : "";
    renderLibraryImages();
  } catch (error) {
    if (hint) hint.textContent = `读取截图失败：${error.message || error}`;
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

function renderLibraryImages() {
  const host = $("#libImageGroups");
  const hint = $("#libImageHint");
  if (!host) return;
  const query = String($("#libImageSearch")?.value || "").trim().toLocaleLowerCase();
  const groups = (librarySidebar.imageGroups || []).map((group) => ({
    ...group,
    images: group.images.filter((image) => !query
      || group.folder.toLocaleLowerCase().includes(query)
      || image.name.toLocaleLowerCase().includes(query)),
  })).filter((group) => group.images.length);
  const flat = [];
  groups.forEach((group) => group.images.forEach((image) => flat.push({ ...image, folder: group.folder })));
  librarySidebar.imageFlat = flat;
  if (hint) {
    hint.textContent = flat.length
      ? `共 ${flat.length} 张 · 保存位置：${librarySidebar.imageRoot || "截图目录"}`
      : (librarySidebar.imageTotal ? "没有匹配的截图" : "还没有截图：在播放器里按 S 或点顶栏相机按钮截一张试试");
  }
  if (!flat.length) {
    host.innerHTML = "";
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

  $$(".library-tab").forEach((item) => item.addEventListener("click", () => switchLibraryTab(item.dataset.libraryTab)));
  $$("#libraryKindSwitch .library-kind-btn").forEach((item) => item.addEventListener("click", () => switchLibraryKind(item.dataset.libraryKind)));
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
  $("#libFilter")?.addEventListener("change", (event) => {
    librarySidebar.filter = event.target.value;
    renderLibraryGrid();
  });
  $("#libSearch")?.addEventListener("input", (event) => {
    librarySidebar.query = event.target.value;
    renderLibraryGrid();
  });
  $("#libGrid")?.addEventListener("click", (event) => {
    const continueButton = event.target.closest(".library-continue");
    if (continueButton) {
      event.stopPropagation();
      const animeId = Number(continueButton.dataset.anime);
      const item = librarySidebar.items.find((entry) => Number(entry.anime_id) === animeId);
      libPlayFromItem(item, Number(continueButton.dataset.continue));
      return;
    }
    const card = event.target.closest(".library-card");
    if (card) {
      const item = librarySidebar.items.find((entry) => Number(entry.anime_id) === Number(card.dataset.anime));
      if (item) {
        librarySidebar.detail = {
          animeId: item.anime_id,
          name: item.name,
          episodeCount: item.episode_count || 0,
        };
      }
      openLibraryDetail(card.dataset.anime, card.dataset.name);
    }
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
