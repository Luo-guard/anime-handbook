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
  offlineView.animeId = Number(anime.id || 0);
  const name = anime.display_name || anime.name_cn || anime.name || "";
  offlineView.animeName = name;
  $("#offlineHeading").textContent = name ? `离线下载 · ${name}` : "离线下载";
  if (!$("#offlineQuery").value.trim()) $("#offlineQuery").value = name;
  offlineStatus("#offlineStatus", "");
  offlineStatus("#offlineLocalStatus", "");
  const dialog = $("#offlineModal");
  if (!dialog.open) dialog.showModal();
  switchOfflineTab("search");
  refreshOfflineLocal();
  if (!offlineView.items.length && name) runOfflineSearch();
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
            <p class="offline-row-title" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</p>
            <p class="offline-row-meta">
              <span class="offline-group">${escapeHtml(item.group || "未标注字幕组")}</span>
              ${tags}
              <span class="offline-size">${escapeHtml(formatOfflineSize(item.size_text))}</span>
              <span class="offline-date">${escapeHtml(String(item.published_at || "").slice(0, 10))}</span>
            </p>
          </div>
          <button type="button" class="offline-download" data-index="${index}">下载</button>
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
          <div class="offline-row-actions"><button type="button" class="offline-remove" data-job="${job.id}" title="从下载器移除并删除记录">移除</button></div>
        </article>`),
    );
  }
  if (!blocks.length) {
    blocks.push(`<p class="offline-empty">还没有下载过任何一集。到左边「找资源」搜一下。</p>`);
  }
  $("#offlineLocalList").innerHTML = blocks.join("");
  offlineStatus("#offlineLocalStatus", files.length ? "" : "");
}

function playLocalFile(fileId) {
  const file = offlineView.local.files.find((item) => Number(item.id) === Number(fileId));
  if (!file) return;
  offlineView.playing = file;
  const video = $("#offlineVideo");
  $("#offlinePlayerTitle").textContent = `${offlineView.animeName || "本地文件"} · ${episodeLabelOf(file.episode_key)}`;
  $("#offlinePlayerMeta").textContent = file.subtitle_path
    ? "字幕文件已就位，但页面内字幕渲染还没接上，先用外部播放器可看到字幕。"
    : "这一集没有内封字幕。";
  video.src = `/api/offline/stream/${file.id}`;
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

document.addEventListener("DOMContentLoaded", () => {
  $("#openOffline")?.addEventListener("click", openOffline);
  $("#offlineClose")?.addEventListener("click", () => $("#offlineModal").close());
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
    const button = event.target.closest(".offline-download");
    if (button) startOfflineDownload(Number(button.dataset.index));
  });
  $("#offlineLocalList")?.addEventListener("click", (event) => {
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
  $("#offlineResetRoot")?.addEventListener("click", () => {
    $("#offlineMediaRoot").value = "";
    $("#offlineDownloadRoot").value = "";
  });
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
    offlineStatus(
      status,
      writable.ok ? "目录可写，qBittorrent 连接正常" : writable.error || "目录不可写",
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
