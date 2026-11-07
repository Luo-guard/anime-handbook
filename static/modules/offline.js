// 离线下载面板：搜蜜柑 → 交给 qBittorrent → 本地文件播放。
// 依赖 core.js 的 state/$/$$/escapeHtml/toast 与 network.js 的 api()。
const offlineView = {
  animeId: 0,
  animeName: "",
  items: [],
  group: "",
  local: { files: [], jobs: [] },
  playing: null,
  resumeTimer: 0,
  subtitle: null,
  subtitleToken: 0,
  jassubPromise: null,
  subtitleBoot: null,
};

function offlineStatus(target, text, isError = false) {
  const node = $(target);
  if (!node) return;
  node.textContent = text || "";
  node.classList.toggle("is-error", Boolean(isError));
}

function episodeLabelOf(key) {
  const parts = String(key || "").split(":");
  const number = Number(parts[1]);
  return Number.isFinite(number) && number > 0 ? `第 ${String(number).padStart(2, "0")} 集` : String(key || "");
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
  $("#offlineHeading").textContent = "离线下载";
  $("#offlineTarget").textContent = name || "";
  $("#offlineTarget").classList.toggle("hidden", !name);
  if (switched) {
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
  $("#offlineSettingsPanel").classList.toggle("hidden", tab !== "settings");
  if (tab === "settings") loadOfflineSettings();
}

async function runOfflineSearch() {
  const query = $("#offlineQuery").value.trim();
  if (!query) {
    offlineStatus("#offlineStatus", "先输入关键词", true);
    return;
  }
  const button = $("#offlineSearchButton");
  button.disabled = true;
  offlineStatus("#offlineStatus", "正在搜索蜜柑…");
  try {
    const data = await api(
      `/api/offline/search?q=${encodeURIComponent(query)}&anime_id=${offlineView.animeId}&limit=60`,
    );
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
            <button type="button" class="offline-subscribe" data-subscribe="${index}" title="以后这个字幕组有新集就自动下载">订阅</button>
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
  try {
    const data = await api(`/api/offline/state?anime_id=${offlineView.animeId}`);
    offlineView.local = { files: data.files || [], jobs: data.jobs || [] };
    renderOfflineLocal();
  } catch (error) {
    offlineStatus("#offlineLocalStatus", error.message || "读取本地文件失败", true);
  }
}

function renderOfflineLocal() {
  const { files, jobs } = offlineView.local;
  const active = jobs.filter((job) => ["queued", "downloading", "processing"].includes(job.status));
  const failed = jobs.filter((job) => job.status === "failed");
  $("#offlineLocalCount").textContent = files.length ? String(files.length) : "";
  const blocks = [];
  if (files.length) {
    blocks.push(
      `<h3 class="offline-section-title">可以播放 · ${files.length} 集</h3>`,
      ...files.map((file) => {
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
              <button type="button" class="offline-remove" data-file="${file.id}" title="移到回收站并删除记录">删除</button>
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
        const paused = String(live.state || "").toLowerCase().startsWith("paused");
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
      ...failed.map((job) => `
        <article class="offline-row">
          <div class="offline-row-main">
            <p class="offline-row-title" title="${escapeHtml(job.source_title || job.torrent_name)}">${escapeHtml(job.torrent_name || job.source_title || "未命名任务")}</p>
            <p class="offline-row-meta"><span class="offline-error">${escapeHtml(job.error || "未知原因")}</span></p>
          </div>
          <div class="offline-row-actions">
            <button type="button" class="offline-play" data-retry="${job.id}" title="文件已经下好时，重新整理入库">重试归档</button>
            <button type="button" class="offline-remove" data-job="${job.id}" title="从下载器移除并删除记录">移除</button>
          </div>
        </article>`),
    );
  }
  if (!blocks.length) {
    blocks.push(`<p class="offline-empty">还没有下载过任何一集。到左边「找资源」搜一下。</p>`);
  }
  $("#offlineLocalList").innerHTML = blocks.join("");
  offlineStatus("#offlineLocalStatus", files.length ? "" : "");
}

// 详情页的单集「播放」手势会在从没打开过离线面板时触发：缓存要么是空的、
// 要么还挂着上一部番的身份。先按当前详情番同步身份再拉一次列表再找文件，
// 否则会误报「还没下载」，甚至把上一部番的同集号文件播出来。
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
  await refreshOfflineLocal();
  return (
    (offlineView.local?.files || []).find(
      (item) => String(item.episode_key) === String(key)
    ) || null
  );
}

function playLocalFile(fileId) {
  const file = offlineView.local.files.find((item) => Number(item.id) === Number(fileId));
  if (!file) return;  offlineView.playing = file;
  const video = $("#offlineVideo");
  $("#offlinePlayerTitle").textContent = `${offlineView.animeName || "本地文件"} · ${episodeLabelOf(file.episode_key)}`;
  clearSubtitleSession();
  const toggle = $("#offlineSubtitleToggle");
  toggle.classList.toggle("hidden", !file.subtitle_path);
  toggle.classList.remove("is-off");
  toggle.textContent = "字幕 · 开";
  toggle.setAttribute("aria-pressed", "true");
  $("#offlinePlayerMeta").textContent = file.subtitle_path
    ? "页面内字幕加载中（第一次约需十几秒，之后切集是即时的）…"
    : "这一集没有内封字幕。";
  video.src = `/api/offline/stream/${file.id}`;
  if (file.subtitle_path) setupSubtitleRenderer(file, video);
  const dialog = $("#offlinePlayer");
  if (!dialog.open) dialog.showModal();
  video.addEventListener(
    "loadedmetadata",
    () => {
      if (file.resume_ms > 3000) video.currentTime = file.resume_ms / 1000;
    },
    { once: true },
  );
  video.play().catch(() => {});
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
  window.clearInterval(offlineView.resumeTimer);
  const video = $("#offlineVideo");
  video.pause();
  video.removeAttribute("src");
  video.load();
  const dialog = $("#offlinePlayer");
  if (dialog.open) dialog.close();
  offlineView.playing = null;
  refreshOfflineLocal();
}

async function removeLocalFile(fileId) {
  const file = offlineView.local.files.find((item) => Number(item.id) === Number(fileId));
  if (!file) return;
  if (!window.confirm(`删除 ${episodeLabelOf(file.episode_key)}？文件会移到媒体库的 _trash 目录，需要时可以找回来。`)) return;
  try {
    await api("/api/offline/delete", {
      method: "POST",
      body: JSON.stringify({ mode: "file", anime_id: offlineView.animeId, episode_key: file.episode_key }),
    });
    toast("已移到回收站");
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

// 面板开着时每 3 秒同步一次下载进度/归档状态。后端已有全局心跳在推进任务，
// 这里的轮询只负责把推进的结果画到开着的界面上；面板关了或页面切走就停。
let offlinePollTimer = 0;
function setOfflinePolling(on) {
  window.clearInterval(offlinePollTimer);
  offlinePollTimer = 0;
  if (!on) return;
  offlinePollTimer = window.setInterval(() => {
    if (!$("#offlineModal")?.open || document.hidden) return;
    refreshOfflineLocal();
  }, 3000);
}

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
  $("#offlineSubList")?.addEventListener("click", (event) => {
    const toggle = event.target.closest("[data-sub-toggle]");
    if (toggle) return toggleSubscription(toggle.dataset.subToggle, toggle.dataset.enabled !== "1");
    const remove = event.target.closest("[data-sub-del]");
    if (remove) return removeSubscription(remove.dataset.subDel);
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
  $("#offlineMigrate")?.addEventListener("click", migrateMediaRoot);
  $("#offlineResetRoot")?.addEventListener("click", () => {
    $("#offlineMediaRoot").value = "";
    $("#offlineDownloadRoot").value = "";
  });
  $("#offlineSubtitleToggle")?.addEventListener("click", toggleSubtitleRenderer);
  $("#offlinePlayerClose")?.addEventListener("click", closeOfflinePlayer);
  $("#offlinePlayer")?.addEventListener("close", () => {
    if (offlineView.playing) closeOfflinePlayer();
  });
  $("#offlineVideo")?.addEventListener("ended", () => {
    saveOfflineResume();
  });
});


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
    $("#offlineQbHost").value = config.qb_host || "127.0.0.1";
    $("#offlineQbPort").value = config.qb_port || 8080;
    $("#offlineQbCategory").value = config.qb_category || "AnimeHandbook";
    $("#offlineSeedAfter").checked = config.seed_after_done !== false;
    $("#offlineAutoFollow").checked = config.auto_follow === true;
    const paths = data.paths || {};
    $("#offlineMediaRoot").placeholder = data.default_media_root || "";
    $("#offlineMediaHint").textContent = `当前实际使用：${paths.media_root || "?"} / ${paths.download_root || "?"}`;
    const writable = data.writable || {};
    const room = writable.free_gb ? `，剩余 ${writable.free_gb} GB` : "";
    offlineStatus(
      status,
      writable.ok ? `目录可写${room}` : writable.error || "目录不可写",
      !writable.ok,
    );
    refreshSubscriptions();
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
        qb_host: $("#offlineQbHost").value.trim() || "127.0.0.1",
        qb_port: Number($("#offlineQbPort").value) || 8080,
        qb_category: $("#offlineQbCategory").value.trim() || "AnimeHandbook",
        seed_after_done: $("#offlineSeedAfter").checked,
        auto_follow: $("#offlineAutoFollow").checked,
      }),
    });
    const paths = data.paths || {};
    $("#offlineMediaHint").textContent = `当前实际使用：${paths.media_root || "?"} / ${paths.download_root || "?"}`;
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
  try {
    await api("/api/offline/subscribe", {
      method: "POST",
      body: JSON.stringify({
        anime_id: offlineView.animeId,
        keyword,
        group_name: item.group || "",
        enabled: true,
      }),
    });
    toast(`已订阅「${item.group || "这个关键词"}」的新集`);
    refreshSubscriptions();
  } catch (error) {
    toast(error.message || "订阅失败", "error");
  }
}

async function refreshSubscriptions() {
  const host = $("#offlineSubList");
  if (!host) return;
  try {
    const data = await api(`/api/offline/subscriptions?anime_id=${offlineView.animeId}`);
    const items = data.items || [];
    if (!items.length) {
      host.innerHTML = `<p class="offline-empty">还没有订阅。到「找资源」页，在结果上点「订阅」。</p>`;
      return;
    }
    host.innerHTML = items
      .map((sub) => {
        const enabled = Number(sub.enabled || 0) === 1;
        const checked = sub.last_checked ? String(sub.last_checked).slice(0, 16).replace("T", " ") : "还没检查";
        return `
          <article class="offline-row">
            <div class="offline-row-main">
              <p class="offline-row-title">${escapeHtml(sub.keyword)}</p>
              <p class="offline-row-meta"><span class="offline-group">${escapeHtml(sub.group_name || "不限字幕组")}</span><span class="offline-date">上次检查 ${escapeHtml(checked)}</span>${enabled ? "" : '<span class="offline-tag">已暂停</span>'}</p>
            </div>
            <div class="offline-row-actions">
              <button type="button" class="offline-play" data-sub-toggle="${sub.id}" data-enabled="${enabled ? 1 : 0}">${enabled ? "暂停" : "恢复"}</button>
              <button type="button" class="offline-remove" data-sub-del="${sub.id}">取消</button>
            </div>
          </article>`;
      })
      .join("");
  } catch (error) {
    host.innerHTML = `<p class="offline-empty">${escapeHtml(error.message || "读取订阅失败")}</p>`;
  }
}

async function toggleSubscription(subId, enabled) {
  try {
    await api("/api/offline/subscribe", {
      method: "POST",
      body: JSON.stringify({ id: Number(subId), enabled }),
    });
    refreshSubscriptions();
  } catch (error) {
    toast(error.message || "操作失败", "error");
  }
}

async function removeSubscription(subId) {
  if (!window.confirm("取消这条追番订阅？已经下好的文件不受影响。")) return;
  try {
    await api("/api/offline/unsubscribe", {
      method: "POST",
      body: JSON.stringify({ id: Number(subId) }),
    });
    toast("已取消订阅");
    refreshSubscriptions();
  } catch (error) {
    toast(error.message || "取消失败", "error");
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
    refreshSubscriptions();
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
      offlineStatus(status, `${data.copied} 集已复制，但有 ${failed.length} 集失败，目录没有切换`, true);
      toast("有文件没复制成功，已保持原目录", "error");
    } else {
      offlineStatus(status, `已迁移 ${data.copied} 集，目录已切换`);
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
