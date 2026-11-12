window.playbackHistory = (() => {
  let filter = "all";
  let opening = false;
  const limit = 200;
  const profileKey = () => `handbook:playback-history:${state.active_profile?.id || "default"}`;

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

  function render() {
    const items = read();
    const visible = filter === "all" ? items : items.filter(item => item.kind === filter);
    const list = $("#jumpHistoryList");
    list.replaceChildren(...visible.map(item => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "jump-row playback-history-row";
      const icon = document.createElement("span");
      icon.className = "jump-icon";
      icon.setAttribute("aria-hidden", "true");
      icon.textContent = "▶";
      const copy = document.createElement("span");
      copy.className = "jump-copy";
      const title = document.createElement("strong");
      title.className = "jump-title";
      title.textContent = item.animeTitle;
      const subtitle = document.createElement("small");
      subtitle.className = "jump-meta";
      subtitle.textContent = [item.kind === "online" ? "在线" : "缓存", item.episode].filter(Boolean).join(" · ");
      copy.append(title, subtitle);
      const time = document.createElement("span");
      time.className = "jump-time";
      time.textContent = new Date(item.playedAt).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
      row.append(icon, copy, time);
      row.addEventListener("click", async () => {
        if (opening) return;
        opening = true;
        row.disabled = true;
        try {
          if (item.kind === "online") await window.onlinePlayback.resume(item);
          else await resumeLocal(item);
        } catch (error) {
          $("#jumpHistoryStatus").textContent = error.message;
        } finally {
          opening = false;
          row.disabled = false;
        }
      });
      return row;
    }));
    if (!visible.length) {
      const empty = document.createElement("p");
      empty.className = "collect-search-hint";
      empty.textContent = "还没有这类播放记录。";
      list.append(empty);
    }
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
