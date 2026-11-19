window.playbackHistory = (() => {
  let filter = "all";
  let query = "";
  let opening = false;
  const limit = 200;
  const profileKey = () => `handbook:playback-history:${state.active_profile?.id || "default"}`;
  const layoutKey = () => `${profileKey()}:layout`;
  const sessionLayouts = new Map();
  const dateLabel = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric" });
  const timeLabel = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const shortDate = new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" });

  function currentLayout() {
    const key = layoutKey();
    if (sessionLayouts.has(key)) return sessionLayouts.get(key);
    try { return localStorage.getItem(key) === "grid" ? "grid" : "list"; }
    catch { return "list"; }
  }

  function read() {
    try {
      const value = JSON.parse(localStorage.getItem(profileKey()) || "[]");
      return Array.isArray(value) ? value.filter(item => item && ["online", "local"].includes(item.kind)) : [];
    } catch { return []; }
  }

  function write(items) {
    localStorage.setItem(profileKey(), JSON.stringify(items));
  }

  function historyKey(item) {
    if (item.kind === "local") return `local:${item.animeId}:${item.fileId}`;
    return `online:${item.rule || "xfdmnext"}:${item.providerId}:${item.episodeId}`;
  }

  function record(item) {
    const key = historyKey(item);
    try { write([{ ...item, key, playedAt: Date.now() }, ...read().filter(entry => historyKey(entry) !== key)].slice(0, limit)); }
    catch { /* 禁用浏览器存储时仍可播放。 */ }
  }

  async function resumeLocal(item) {
    const data = await api(`/api/offline/state?anime_id=${encodeURIComponent(item.animeId)}`);
    const files = data.files || [];
    const file = files.find(row => row.id === item.fileId && row.exists !== false)
      || files.find(row => row.episode_key === item.episodeKey && row.exists !== false);
    if (!file) throw new Error("这一集的缓存文件已移除。");
    if (!$("#jumpHistoryModal").open) return;
    offlineView.animeId = item.animeId;
    offlineView.animeName = item.animeTitle;
    offlineView.local = { files, jobs: data.jobs || [] };
    playLocalFile(file.id);
  }

  function subjectKey(item) {
    if (Number(item.animeId) > 0) return `anime:${Number(item.animeId)}`;
    if (item.providerId) return `provider:${item.rule || "xfdmnext"}:${item.providerId}`;
    const title = String(item.animeTitle || "").trim().toLocaleLowerCase();
    return title ? `title:${title}` : historyKey(item);
  }

  function renderEntry(item, layout) {
    const entry = document.createElement("div");
    entry.className = "history-entry";
    const row = document.createElement("button");
    row.type = "button";
    row.className = "jump-row playback-history-row";
    const cover = document.createElement("span");
    cover.className = "playback-history-cover";
    cover.setAttribute("aria-hidden", "true");
    cover.textContent = "▶";
    if (Number.isSafeInteger(Number(item.animeId)) && Number(item.animeId) > 0) {
      const image = document.createElement("img");
      image.alt = "";
      image.loading = "lazy";
      image.decoding = "async";
      image.addEventListener("error", () => image.remove(), { once: true });
      image.src = `/api/covers/${Number(item.animeId)}`;
      cover.append(image);
    }
    const copy = document.createElement("span");
    copy.className = "jump-copy";
    const title = document.createElement("strong");
    title.className = "jump-title";
    title.textContent = item.animeTitle || "未命名番剧";
    title.title = title.textContent;
    const subtitle = document.createElement("small");
    subtitle.className = "jump-meta";
    subtitle.textContent = [item.kind === "online" ? "在线" : "缓存", item.episode].filter(Boolean).join(" · ");
    subtitle.title = subtitle.textContent;
    copy.append(title, subtitle);
    const time = document.createElement("span");
    time.className = "jump-time";
    const played = new Date(item.playedAt);
    if (Number.isFinite(played.getTime())) time.textContent = (layout === "grid" ? shortDate : timeLabel).format(played);
    row.append(cover, copy, time);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "history-remove";
    remove.textContent = "移除";
    remove.setAttribute("aria-label", `移除播放记录：${title.textContent} ${item.episode || ""}`);
    remove.onclick = () => {
      if (!confirm("移除这条播放历史？")) return;
      try { write(read().filter(record => historyKey(record) !== historyKey(item))); render(); $("#jumpHistoryList").focus(); }
      catch (error) { $("#jumpHistoryStatus").textContent = error.message; }
    };
    row.addEventListener("click", async () => {
      if (opening) return;
      opening = true;
      row.disabled = true;
      try {
        if (item.kind === "online") await window.onlinePlayback.resume(item);
        else await resumeLocal(item);
      } catch (error) {
        $("#jumpHistoryStatus").textContent = error.message;
        remove.classList.add("is-failed");
      } finally {
        opening = false;
        row.disabled = false;
      }
    });
    entry.append(row, remove);
    return entry;
  }

  function render() {
    const items = read().sort((a, b) => (Number(b.playedAt) || 0) - (Number(a.playedAt) || 0));
    const animeById = query ? new Map((state.animes || []).map(anime => [Number(anime.id), anime])) : null;
    const visible = items.filter(item => {
      if (filter !== "all" && item.kind !== filter) return false;
      if (!query) return true;
      const anime = animeById.get(Number(item.animeId));
      return [item.animeTitle, anime?.name, anime?.name_cn, anime?.display_name]
        .some(name => String(name || "").toLocaleLowerCase().includes(query));
    });
    const layout = currentLayout();
    const list = $("#jumpHistoryList");
    list.dataset.layout = layout;
    $$("[data-history-layout]").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.historyLayout === layout)));
    if (layout === "grid") {
      const seen = new Set();
      const cards = [];
      for (const item of visible) {
        const key = subjectKey(item);
        if (seen.has(key)) continue;
        seen.add(key);
        cards.push(renderEntry(item, layout));
      }
      list.replaceChildren(...cards);
    } else {
      const groups = new Map();
      for (const item of visible) {
        const date = new Date(item.playedAt);
        const key = Number.isFinite(date.getTime()) ? dateLabel.format(date) : "日期未知";
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(renderEntry(item, layout));
      }
      const today = new Date();
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);
      const todayKey = dateLabel.format(today);
      const yesterdayKey = dateLabel.format(yesterday);
      list.replaceChildren(...[...groups].flatMap(([key, rows]) => {
        const heading = document.createElement("h3");
        heading.className = "jump-day";
        heading.textContent = key === todayKey ? `今天 · ${key}` : key === yesterdayKey ? `昨天 · ${key}` : key;
        return [heading, ...rows];
      }));
    }
    if (!visible.length) {
      const empty = document.createElement("p");
      empty.className = "jump-empty";
      empty.textContent = query ? "没有匹配的播放记录。" : "还没有这类播放记录。";
      list.append(empty);
    }
    list.scrollTop = 0;
    $("#clearJumpHistory").disabled = items.length === 0;
    $("#jumpHistoryStatus").textContent = "";
  }

  document.addEventListener("DOMContentLoaded", () => {
    const modal = $("#jumpHistoryModal");
    if (!modal) return;
    $("#jumpHistoryButton")?.addEventListener("click", () => {
      if (window.handbookOnline) return;
      render();
      if (!modal.open) modal.showModal();
    });
    $("#jumpHistoryClose").addEventListener("click", () => modal.close());
    $("#playbackHistoryQuery").addEventListener("input", event => {
      query = event.target.value.trim().toLocaleLowerCase();
      render();
    });
    $("#playbackHistoryLayouts").addEventListener("click", event => {
      const button = event.target.closest("[data-history-layout]");
      if (!button || button.dataset.historyLayout === currentLayout()) return;
      const layout = button.dataset.historyLayout;
      sessionLayouts.set(layoutKey(), layout);
      try { localStorage.setItem(layoutKey(), layout); } catch { /* Session choice remains available. */ }
      render();
    });
    $("#playbackHistoryFilters").addEventListener("click", event => {
      const button = event.target.closest("[data-history-kind]");
      if (!button) return;
      filter = button.dataset.historyKind;
      $$("#playbackHistoryFilters button").forEach(item => {
        item.classList.toggle("active", item === button);
        item.setAttribute("aria-pressed", String(item === button));
      });
      render();
    });
    $("#clearJumpHistory").addEventListener("click", () => {
      if (!confirm("清空全部播放历史？")) return;
      try { write([]); render(); }
      catch (error) { $("#jumpHistoryStatus").textContent = error.message; }
    });
  });

  return { record };
})();
