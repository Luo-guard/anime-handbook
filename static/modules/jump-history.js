// 跳转记录：记录最近点开过的已存视频/链接，下次直接从这里打开。
const jumpHistoryState = { items: [], loading: false };

function jumpHistoryDay(iso) {
  const value = new Date(String(iso || "").replace(" ", "T"));
  if (Number.isNaN(value.getTime())) return "更早";
  const today = new Date();
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const startOfValue = new Date(value.getFullYear(), value.getMonth(), value.getDate());
  const days = Math.round((startOfToday - startOfValue) / 86400000);
  if (days <= 0) return "今天";
  if (days === 1) return "昨天";
  return "更早";
}

function jumpHistoryTime(iso) {
  const value = new Date(String(iso || "").replace(" ", "T"));
  if (Number.isNaN(value.getTime())) return "";
  const day = jumpHistoryDay(iso);
  const clock = `${String(value.getHours()).padStart(2, "0")}:${String(value.getMinutes()).padStart(2, "0")}`;
  if (day === "更早") return `${value.getMonth() + 1}月${value.getDate()}日`;
  return clock;
}

const JUMP_ICONS = {
  video: '<svg viewBox="0 0 24 24"><path d="m9 6 9 6-9 6z"/></svg>',
  link: '<svg viewBox="0 0 24 24"><path d="M10.6 13.4a4 4 0 0 0 5.7 0l2.3-2.3a4 4 0 1 0-5.7-5.7l-1.2 1.2"/><path d="M13.4 10.6a4 4 0 0 0-5.7 0l-2.3 2.3a4 4 0 1 0 5.7 5.7l1.2-1.2"/></svg>',
};

function renderJumpHistoryRows(items) {
  const list = $("#jumpHistoryList");
  if (!list) return;
  list.replaceChildren();
  if (!items.length) {
    list.innerHTML = `<div class="jump-empty">还没有跳转记录。在番剧详情里点开已存视频或链接后，这里就会留下痕迹。</div>`;
    return;
  }
  let currentDay = "";
  items.forEach((item) => {
    const day = jumpHistoryDay(item.visited_at);
    if (day !== currentDay) {
      currentDay = day;
      const heading = document.createElement("p");
      heading.className = "jump-day";
      heading.textContent = day;
      list.append(heading);
    }
    const anchor = document.createElement("a");
    anchor.className = "jump-row";
    anchor.href = item.url;
    anchor.target = "_blank";
    anchor.rel = "noreferrer";
    anchor.dataset.jumpKind = item.kind;
    const icon = document.createElement("span");
    icon.className = "jump-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.innerHTML = JUMP_ICONS[item.kind] || JUMP_ICONS.link;
    const copy = document.createElement("span");
    copy.className = "jump-copy";
    const title = document.createElement("span");
    title.className = "jump-title";
    title.textContent = item.title || item.url;
    const meta = document.createElement("span");
    meta.className = "jump-meta";
    meta.textContent = [item.anime_name, item.host].filter(Boolean).join(" · ");
    copy.append(title, meta);
    const time = document.createElement("span");
    time.className = "jump-time";
    time.textContent = jumpHistoryTime(item.visited_at);
    anchor.append(icon, copy, time);
    list.append(anchor);
  });
}

async function renderJumpHistory() {
  const status = $("#jumpHistoryStatus");
  if (!jumpHistoryState.items.length && status) status.textContent = "正在读取跳转记录…";
  try {
    const result = await api("/api/jump-history?limit=80");
    jumpHistoryState.items = Array.isArray(result.items) ? result.items : [];
    renderJumpHistoryRows(jumpHistoryState.items);
    if (status) status.textContent = jumpHistoryState.items.length ? `共 ${jumpHistoryState.items.length} 条，只保留最近 200 条。` : "";
  } catch (error) {
    if (status) status.textContent = `跳转记录暂不可用：${error.message}`;
    if ($("#jumpHistoryList")) $("#jumpHistoryList").innerHTML = "";
  }
}

// 点击已存条目时静默记账，失败不影响跳转本身。
function recordJump(payload) {
  if (!payload || !payload.url) return;
  api("/api/jump-history", { method: "POST", body: JSON.stringify(payload) }).catch(() => {});
}

function setupJumpHistory() {
  const button = $("#jumpHistoryButton");
  const modal = $("#jumpHistoryModal");
  if (!button || !modal) return;
  // 显隐与图标模式统一交给 applyCollectionToolbarButtons()（生命周期里调用），
  // 这里不再单独切换，避免设置还没读到时先闪出来。
  button.addEventListener("click", () => {
    jumpHistoryState.items = [];
    renderJumpHistoryRows([]);
    modal.showModal();
    renderJumpHistory();
  });
  $("#jumpHistoryClose")?.addEventListener("click", () => modal.close());
  $("#clearJumpHistory")?.addEventListener("click", async () => {
    if (!confirm("清空全部跳转记录？")) return;
    try {
      await api("/api/jump-history", { method: "POST", body: JSON.stringify({ action: "clear" }) });
      jumpHistoryState.items = [];
      renderJumpHistoryRows([]);
      $("#jumpHistoryStatus").textContent = "已清空跳转记录。";
    } catch (error) {
      $("#jumpHistoryStatus").textContent = error.message;
    }
  });
}

setupJumpHistory();
