// 详情页的「更多站点」：点开列出本机已缓存的 Kazumi 规则站点，
// 选一个就在新标签里搜这部番；也可以把某个站点固定到详情页，变成独立的普通链接。
let rulesMenuAnime = null;
let rulesMenuPreferred = null;
let rulesMenuValues = null;

function rulesMenuCache() {
  return typeof linkRulesState === "object" && linkRulesState ? linkRulesState : null;
}

function rulesMenuLimit() {
  const cache = rulesMenuCache();
  return Number(cache?.limit) || 12;
}

function rulesMenuFixedUrls() {
  return new Set(detailLinks().map((link) => String(link.url || "").trim()).filter(Boolean));
}

function rulesMenuSetStatus(message, isError = false) {
  const status = $("#rulesMenuStatus");
  if (!status) return;
  status.textContent = message || "";
  status.classList.toggle("is-error", Boolean(isError));
}

// 把某个站点固定到详情页：写库后立刻重绘，不需要再进设置。
async function rulesMenuPin(item) {
  const links = detailLinks();
  if (links.some((link) => String(link.url || "").trim() === item.template)) {
    toast(`「${item.name}」已经在详情页了`);
    return;
  }
  if (links.length >= rulesMenuLimit()) {
    toast(`详情页链接最多 ${rulesMenuLimit()} 条，请先删掉一些`, "error");
    return;
  }
  const next = [
    ...links,
    { id: detailLinkId(), kind: "custom", name: item.name, url: item.template, enabled: true },
  ];
  try {
    const payload = await api("/api/settings", { method: "PATCH", body: JSON.stringify({ detail_links: next }) });
    if (payload.settings) state.settings = payload.settings;
    if (rulesMenuAnime) renderDetailLinks(rulesMenuAnime, rulesMenuPreferred);
    renderRulesMenu();
    toast(`已把「${item.name}」固定到详情页`);
  } catch (error) {
    toast(error.message, "error");
  }
}

function renderRulesMenu() {
  const list = $("#rulesMenuList");
  if (!list) return;
  const cache = rulesMenuCache();

  if (!cache) {
    list.innerHTML = `<p class="rules-empty">规则还没加载。</p>`;
    return;
  }
  if (cache.loading && !cache.items.length) {
    rulesMenuSetStatus("正在获取规则…");
    list.innerHTML = `<p class="rules-empty">正在获取规则…</p>`;
    return;
  }
  if (!cache.items.length) {
    const reason = cache.error || "还没有规则缓存。";
    rulesMenuSetStatus(reason, Boolean(cache.error));
    list.innerHTML = `<p class="rules-empty">${escapeHtml(reason)}<br />可以在设置 → 番剧详情里点「检查规则更新」获取一次。</p>`;
    return;
  }
  const keyword = String($("#rulesMenuSearch")?.value || "").trim().toLowerCase();
  const fixed = rulesMenuFixedUrls();
  const matched = cache.items.filter((item) => !keyword
    || String(item.name || "").toLowerCase().includes(keyword)
    || String(item.host || "").toLowerCase().includes(keyword));
  rulesMenuSetStatus(`共 ${cache.items.length} 个站点；固定到详情页的会单独占一条链接（上限 ${rulesMenuLimit()} 条）。`);
  if (!matched.length) {
    list.innerHTML = `<p class="rules-empty">没有匹配「${escapeHtml(keyword)}」的站点。</p>`;
    return;
  }
  const scroll = list.scrollTop;
  list.replaceChildren();
  matched.forEach((item) => {
    const row = document.createElement("div");
    row.className = "rules-menu-row";
    row.dataset.ruleId = item.id;

    // 站点入口用真 <a>：中键新标签、右键复制地址、Ctrl/Shift 点击都是浏览器原生行为，
    // 不再用 window.open 模拟。
    const open = document.createElement("a");
    open.className = "rules-menu-open";
    open.title = item.template;
    open.href = detailLinkHref(item.template, rulesMenuValues || { title: "" });
    open.target = "_blank";
    open.rel = "noreferrer";
    const name = document.createElement("span");
    name.className = "rules-menu-name";
    name.textContent = item.name;
    const host = document.createElement("span");
    host.className = "rules-menu-host";
    host.textContent = item.host;
    open.append(name, host);
    open.addEventListener("click", (event) => {
      // 普通左键：浏览器自己开新标签（target=_blank），这里只负责记一笔并关掉弹窗；
      // 中键与带修饰键的点击不触发 click，跳转记录一并交给浏览器默认行为。
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      if (typeof recordJump === "function") {
        recordJump({
          anime_id: rulesMenuAnime?.id || null,
          anime_name: rulesMenuAnime?.display_name || rulesMenuAnime?.name_cn || rulesMenuAnime?.name || "",
          title: `${item.name}搜索`,
          url: open.href,
          kind: "link",
        });
      }
      $("#rulesMenuModal")?.close();
    });

    const pinned = fixed.has(item.template);
    const pin = document.createElement("button");
    pin.type = "button";
    pin.className = "rules-menu-pin";
    pin.textContent = pinned ? "✓" : "📌";
    pin.title = pinned ? "已经在详情页" : `把「${item.name}」固定到详情页`;
    pin.setAttribute("aria-label", pin.title);
    pin.disabled = pinned;
    pin.addEventListener("click", () => rulesMenuPin(item));

    row.append(open, pin);
    list.append(row);
  });
  list.scrollTop = scroll;
}

async function openRulesMenu(anime, preferred = null, values = null) {
  const modal = $("#rulesMenuModal");
  if (!modal) return;
  rulesMenuAnime = anime || null;
  rulesMenuPreferred = preferred || null;
  rulesMenuValues = values || {
    id: anime?.id || "",
    title: String(anime?.name_cn || anime?.name || anime?.display_name || "").trim(),
    site: String(state.settings?.bgm_site_base || "https://bgm.tv").replace(/\/+$/, ""),
  };
  const search = $("#rulesMenuSearch");
  if (search) search.value = "";
  modal.showModal();
  renderRulesMenu();
  const cache = rulesMenuCache();
  if (cache && !cache.items.length && !cache.loading) {
    // 首次打开且本机还没有规则：顺手拉一次，用户已经主动点了按钮。
    await loadLinkRules(true);
    renderRulesMenu();
  }
}

if ($("#rulesMenuModal")) {
  $("#rulesMenuClose").addEventListener("click", () => $("#rulesMenuModal").close());
  $("#rulesMenuSearch").addEventListener("input", () => renderRulesMenu());
}

// 详情页「更多站点」入口是一条指向 #rules-menu=… 的真链接：中键/新标签打开时，
// 走到这里把哈希还原成菜单参数，再弹出同一个站点菜单。左键不会走到这里——
// video-links.js 在 click 里 preventDefault 并直接调 openRulesMenu。
function openRulesMenuFromLocation() {
  if (!location.hash.startsWith("#rules-menu=")) return;
  let payload = null;
  try {
    payload = JSON.parse(decodeURIComponent(location.hash.slice("#rules-menu=".length)));
  } catch (error) {
    payload = null;
  }
  try {
    history.replaceState(null, "", location.pathname + location.search);
  } catch (error) {
    // 某些嵌入环境（about:blank 等）不允许改历史记录；留着哈希不影响菜单弹出。
  }
  const anime = {
    id: payload?.id ?? null,
    name_cn: String(payload?.title || "").trim(),
  };
  if (payload?.site) {
    openRulesMenu(anime, null, { id: anime.id ?? "", title: anime.name_cn, site: String(payload.site) });
  } else {
    openRulesMenu(anime);
  }
}
window.addEventListener("hashchange", openRulesMenuFromLocation);
// defer 脚本执行完才触发 DOMContentLoaded，所以此时全部模块都已就绪；
// 新标签直接带着哈希打开页面时，靠这一步自动弹出菜单。
document.addEventListener("DOMContentLoaded", openRulesMenuFromLocation);
