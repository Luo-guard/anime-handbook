// 手机版片源规则：KazumiRules 的规则在这里安装、搜索、解析分集。
// 规则格式与 Kazumi 一致（XPath）。页面有两种取法：
//   1. 原生直接抓 HTML —— 快，适合服务端渲染的站点；
//   2. 隐藏 WebView 渲染后再取 DOM —— 慢一点，但能跑 useWebview 的动态站。
// 先试 1，取不到结果自动退回 2，所以用户不用关心规则属于哪一种。
(() => {
  const $ = id => document.getElementById(id);
  const host = window.AndroidPlayer;
  const INSTALLED_KEY = "mobile-player:rules";
  const REPO_KEY = "mobile-player:rule-repo";
  const ACTIVE_KEY = "mobile-player:active-rule";
  const QUERY_KEY = "mobile-player:rule-query";
  const REPO_INDEX = "https://api.github.com/repos/Predidit/KazumiRules/contents/";
  const REPO_TTL = 12 * 60 * 60 * 1000;

  const escapeText = value => String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const read = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
  const write = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 存储满了也不影响播放 */ } };

  let installed = read(INSTALLED_KEY, []).filter(entry => entry && entry.rule);
  let repo = read(REPO_KEY, { at: 0, items: [] });
  let activeRule = read(ACTIVE_KEY, "");
  let lastKeyword = read(QUERY_KEY, "");
  let lastChapters = null;
  let loadingRepo = false;
  const pending = new Map();
  let sequence = 0;

  const page = () => $("rulesPage");

  // ---------- 原生联网 ----------
  // mode: "static" 直接抓 HTML；"render" 用隐藏 WebView 跑完脚本再取 DOM。
  function request(method, url, referer, timeout) {
    return new Promise((resolve, reject) => {
      if (!host?.[method]) { reject(Error(method === "renderText" ? "当前安装包不支持渲染网页，请更新" : "当前安装包不支持联网，请更新")); return; }
      const id = ++sequence;
      const timer = window.setTimeout(() => {
        if (pending.delete(id)) reject(Error("请求超时，检查网络后再试"));
      }, timeout);
      pending.set(id, {
        resolve: text => { clearTimeout(timer); resolve(text); },
        reject: error => { clearTimeout(timer); reject(error); },
      });
      try { host[method](id, url, JSON.stringify(referer ? { Referer: referer } : {})); }
      catch (error) { pending.delete(id); clearTimeout(timer); reject(Error("无法发起请求")); }
    });
  }
  const fetchText = (url, referer = "") => request("fetchText", url, referer, 15000);
  const renderText = (url, referer = "") => request("renderText", url, referer, 32000);

  // ---------- XPath ----------
  function xpathAll(node, expression) {
    if (!expression) return [];
    try {
      const doc = node.nodeType === 9 ? node : node.ownerDocument;
      const result = doc.evaluate(expression, node, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      const out = [];
      for (let i = 0; i < result.snapshotLength; i += 1) out.push(result.snapshotItem(i));
      return out;
    } catch { return []; }
  }
  function nodeText(node) {
    if (!node) return "";
    if (node.nodeType === 2) return String(node.value || "").trim();
    return String(node.textContent || "").replace(/\s+/g, " ").trim();
  }
  function nodeHref(node, base) {
    if (!node) return "";
    const raw = node.nodeType === 2 ? node.value : (node.getAttribute?.("href") || node.getAttribute?.("src") || node.href || "");
    try { return raw ? new URL(raw, base).href : ""; } catch { return ""; }
  }
  function parseHtml(text) { return new DOMParser().parseFromString(String(text || ""), "text/html"); }
  function absolute(rule, url) {
    try { return new URL(url, rule.baseURL || "https://example.com").href; } catch { return url; }
  }

  // ---------- 规则动作 ----------
  function pickRuleText(rule, keyword) {
    const template = String(rule.searchURL || "");
    if (!template) throw Error("这条规则没有搜索地址，只能从已安装条目进入");
    const encoded = encodeURIComponent(keyword);
    return absolute(rule, template.replaceAll("@keyword", encoded).replaceAll("{keyword}", encoded));
  }

  function parseSearch(rule, html, base) {
    const doc = parseHtml(html);
    return xpathAll(doc, rule.searchList).map(node => ({
      name: nodeText(xpathAll(node, rule.searchName)[0]) || nodeText(node).slice(0, 60),
      href: nodeHref(xpathAll(node, rule.searchResult)[0] || node, base),
    })).filter(item => item.href);
  }

  async function search(rule, keyword, report) {
    if (rule.usePost === true) throw Error("这条规则用 POST 提交搜索，手机版暂不支持，换一条试试");
    const target = pickRuleText(rule, keyword);
    const dynamic = rule.useWebview === true;
    let results = [];
    if (!dynamic) {
      report?.("正在搜索…");
      try { results = parseSearch(rule, await fetchText(target, rule.baseURL), target); }
      catch (error) { results = []; }
    }
    if (!results.length) {
      if (!host?.renderText) {
        throw Error(dynamic ? "这条规则要网页渲染才能用，当前安装包不支持" : "没有解析到结果，换条规则或换个关键词");
      }
      report?.(dynamic ? "这条规则是动态站，正在渲染页面…" : "直接读取没结果，改用网页渲染再试…");
      results = parseSearch(rule, await renderText(target, rule.baseURL), target);
    }
    if (!results.length) throw Error("站点返回的页面里没有匹配条目，换个关键词或换条规则");
    return results;
  }

  function parseChapters(rule, html, base) {
    const doc = parseHtml(html);
    const roads = xpathAll(doc, rule.chapterRoads);
    const groups = roads.length ? roads.map(road => xpathAll(road, rule.chapterResult)) : [xpathAll(doc, rule.chapterResult)];
    const list = [];
    groups.forEach((links, roadIndex) => {
      links.forEach((link, i) => {
        const url = nodeHref(link, base);
        if (url) list.push({ road: roadIndex, name: nodeText(link) || `第 ${i + 1} 集`, href: url });
      });
    });
    return list;
  }

  async function chapters(rule, href, report) {
    let list = [];
    if (rule.useWebview !== true) {
      report?.("正在读取分集…");
      try { list = parseChapters(rule, await fetchText(href, rule.baseURL), href); } catch { list = []; }
    }
    if (!list.length) {
      if (!host?.renderText) throw Error("没有解析到分集，这条规则可能需要网页渲染");
      report?.("正在渲染分集页面…");
      list = parseChapters(rule, await renderText(href, rule.baseURL), href);
    }
    if (!list.length) throw Error("这个条目没有可播放的分集");
    return list;
  }

  // 从剧集页里找直链：m3u8 优先，其次 mp4。很多站点把地址放在播放器配置或 iframe 里。
  function directMedia(html) {
    const flat = String(html).replace(/\\\//g, "/");
    const found = [...flat.matchAll(/https?:\/\/[^\s"'<>\\]+?\.(?:m3u8|mp4)(?:\?[^\s"'<>\\]*)?/gi)].map(match => match[0]);
    const unique = [...new Set(found)];
    return unique.find(url => /\.m3u8/i.test(url)) || unique[0] || "";
  }
  function iframeUrls(html, base) {
    const doc = parseHtml(html);
    return [...doc.querySelectorAll("iframe[src], iframe[data-src], frame[src]")]
      .map(node => node.getAttribute("src") || node.getAttribute("data-src"))
      .map(raw => { try { return new URL(raw, base).href; } catch { return ""; } })
      .filter(url => /^https?:/.test(url));
  }

  async function mediaUrl(rule, href, report) {
    let html = "";
    try { html = await fetchText(href, rule.baseURL); } catch { html = ""; }
    let direct = directMedia(html);
    if (direct) return direct;
    // 播放页常常只有一层 iframe，继续往里走一层
    for (const inner of iframeUrls(html).slice(0, 2)) {
      report?.("正在解析播放器地址…");
      try {
        const nested = await fetchText(inner, href);
        direct = directMedia(nested);
        if (direct) return direct;
      } catch { /* 换下一个 */ }
    }
    if (host?.renderText) {
      report?.("正在渲染播放页…");
      try { direct = directMedia(await renderText(href, rule.baseURL)); } catch { /* 下面统一报错 */ }
      if (direct) return direct;
    }
    return "";
  }

  // ---------- 仓库与安装 ----------
  function normalizeRule(raw, fallbackName) {
    if (!raw || typeof raw !== "object") throw Error("规则文件不是有效的 JSON 对象");
    const rule = { ...raw };
    rule.baseURL = raw.baseURL || raw.baseUrl || "";
    rule.name = String(raw.name || fallbackName || "").trim();
    if (!rule.name) throw Error("规则缺少名字");
    if (!/^https?:\/\//.test(rule.baseURL)) throw Error("规则缺少 baseURL");
    if (!rule.searchList || !rule.searchURL) throw Error("规则缺少 searchURL / searchList，无法搜索");
    return rule;
  }

  function persistInstalled() {
    write(INSTALLED_KEY, installed);
    if (!installed.some(entry => entry.name === activeRule)) activeRule = installed.find(entry => entry.enabled !== false)?.name || "";
    write(ACTIVE_KEY, activeRule);
    renderSummary();
    renderInstalled();
    renderPick();
  }

  function saveRule(raw, fallbackName) {
    const rule = normalizeRule(raw, fallbackName);
    installed = installed.filter(entry => entry.name !== rule.name);
    installed.push({ name: rule.name, rule, addedAt: Date.now(), enabled: true });
    if (!activeRule) activeRule = rule.name;
    persistInstalled();
    return rule.name;
  }

  async function loadRepo(force) {
    if (!force && repo.items.length && Date.now() - repo.at < REPO_TTL) return repo.items;
    if (loadingRepo) return repo.items;
    loadingRepo = true;
    setStatus("mpRuleRepoStatus", "正在读取仓库…");
    try {
      const text = await fetchText(REPO_INDEX);
      let parsed;
      try { parsed = JSON.parse(text); } catch { throw Error("GitHub 返回的不是 JSON，可能被限流了"); }
      if (!Array.isArray(parsed)) throw Error(parsed?.message || "GitHub 返回异常");
      repo = {
        at: Date.now(),
        items: parsed.filter(file => /\.json$/i.test(file.name)).map(file => ({
          name: file.name.replace(/\.json$/i, ""),
          url: file.download_url,
          size: file.size,
        })),
      };
      write(REPO_KEY, repo);
      setStatus("mpRuleRepoStatus", `仓库里有 ${repo.items.length} 条规则，点「安装」加入本机。`);
      return repo.items;
    } catch (error) {
      if (repo.items.length) {
        setStatus("mpRuleRepoStatus", `读取失败，先显示上次的 ${repo.items.length} 条缓存。${error.message || ""}`);
        return repo.items;
      }
      setStatus("mpRuleRepoStatus", `${error.message || "读取仓库失败"}。可以用「从链接导入」直接加规则。`, true);
      throw error;
    } finally {
      loadingRepo = false;
    }
  }

  async function installFromUrl(url) {
    if (!/^https:\/\//.test(url)) throw Error("规则链接必须是 HTTPS");
    const text = await fetchText(url);
    let parsed;
    try { parsed = JSON.parse(text); } catch { throw Error("这个链接不是规则 JSON"); }
    return saveRule(parsed, "");
  }

  async function install(item) {
    const text = await fetchText(item.url);
    let parsed;
    try { parsed = JSON.parse(text); } catch { throw Error("规则文件不是有效的 JSON"); }
    return saveRule(parsed, item.name);
  }

  function removeRule(name) {
    installed = installed.filter(entry => entry.name !== name);
    persistInstalled();
  }

  // ---------- 渲染 ----------
  function setStatus(id, text, error) {
    const node = $(id);
    if (!node) return;
    node.textContent = text || "";
    node.classList.toggle("is-error", Boolean(error));
  }

  function renderSummary() {
    const node = $("mpRuleSummary");
    if (!node) return;
    const enabled = installed.filter(entry => entry.enabled !== false).length;
    node.textContent = installed.length ? `已安装 ${installed.length} 条 · 启用 ${enabled} 条` : "还没有安装规则";
  }

  function renderPick() {
    const pick = $("mpRulePick");
    if (!pick) return;
    const enabled = installed.filter(entry => entry.enabled !== false);
    if (!enabled.some(entry => entry.name === activeRule)) activeRule = enabled[0]?.name || "";
    pick.replaceChildren(...(enabled.length
      ? enabled.map(entry => new Option(entry.name, entry.name))
      : [new Option("还没有可用规则", "")]));
    pick.value = activeRule;
    pick.disabled = !enabled.length;
    $("mpRuleFindForm")?.querySelectorAll("input, button").forEach(node => { node.disabled = !enabled.length; });
    const submit = $("mpRuleFindForm")?.querySelector("button");
    if (submit) submit.disabled = !enabled.length;
    const hint = $("mpRuleStatus");
    if (!enabled.length) {
      setStatus("mpRuleStatus", installed.length ? "规则都被停用了，去「已安装」里启用一条。" : "还没有规则。切到「规则仓库」装一条，或「已安装」里粘贴 JSON。");
    } else if (/还没有规则|都被停用/.test(hint?.textContent || "")) {
      setStatus("mpRuleStatus", "");
    }
  }

  function ruleBadges(entry) {
    const badges = [];
    if (entry.rule.useWebview === true) badges.push("动态站");
    if (entry.rule.deprecated === true) badges.push("作者已弃用");
    return badges.map(text => `<em class="tag${text.includes("弃用") ? " tag-warn" : ""}">${escapeText(text)}</em>`).join("");
  }

  function renderRepo() {
    const list = $("mpRuleRepo");
    if (!list) return;
    const filter = String($("mpRuleFilter")?.value || "").trim().toLowerCase();
    const items = repo.items.filter(item => !filter || item.name.toLowerCase().includes(filter));
    if (!items.length) {
      list.innerHTML = `<p class="hint">${repo.items.length ? "没有匹配的规则名。" : "点「刷新」从 GitHub 读取规则列表。"}</p>`;
      return;
    }
    list.innerHTML = items.map(item => {
      const have = installed.some(entry => entry.name === item.name);
      return `<div class="rule-item">
        <div class="rule-item-text"><b>${escapeText(item.name)}</b><small>${have ? "已安装 · 可重装覆盖" : `${Math.max(1, Math.round((item.size || 0) / 102.4) / 10)} KB`}</small></div>
        <button type="button" data-install="${escapeText(item.name)}">${have ? "重装" : "安装"}</button>
      </div>`;
    }).join("");
    list.querySelectorAll("[data-install]").forEach(button => {
      button.onclick = async () => {
        const item = repo.items.find(entry => entry.name === button.dataset.install);
        if (!item) return;
        const label = button.textContent;
        button.disabled = true;
        button.textContent = "安装中…";
        try {
          const name = await install(item);
          setStatus("mpRuleRepoStatus", `已安装「${name}」`);
          renderRepo();
          toast(`已安装规则：${name}`);
        } catch (error) {
          setStatus("mpRuleRepoStatus", error.message || "安装失败", true);
          button.disabled = false;
          button.textContent = label;
        }
      };
    });
  }

  function renderInstalled() {
    const list = $("mpRuleInstalled");
    if (!list) return;
    if (!installed.length) {
      list.innerHTML = `<p class="hint">还没有安装规则。去「规则仓库」挑一条，或粘贴规则 JSON。</p>`;
      renderPick();
      return;
    }
    list.innerHTML = installed.map(entry => `<div class="rule-item${entry.enabled !== false ? "" : " is-off"}">
      <div class="rule-item-text">
        <b>${escapeText(entry.name)}</b>
        <small>${escapeText((entry.rule.baseURL || "").replace(/^https?:\/\//, "").replace(/\/$/, ""))}${ruleBadges(entry)}</small>
      </div>
      <input type="checkbox" class="switch-input" data-toggle="${escapeText(entry.name)}" aria-label="启用这条规则" ${entry.enabled !== false ? "checked" : ""}>
      <button type="button" class="danger" data-remove="${escapeText(entry.name)}">删除</button>
    </div>`).join("");
    list.querySelectorAll("[data-toggle]").forEach(input => {
      input.onchange = () => {
        const entry = installed.find(item => item.name === input.dataset.toggle);
        if (!entry) return;
        entry.enabled = input.checked;
        persistInstalled();
        toast(entry.enabled ? `已启用：${entry.name}` : `已停用：${entry.name}`);
      };
    });
    list.querySelectorAll("[data-remove]").forEach(button => {
      button.onclick = () => {
        const name = button.dataset.remove;
        if (!confirm(`删除规则「${name}」？已添加的线路不受影响。`)) return;
        removeRule(name);
        renderRepo();
        toast("已删除规则");
      };
    });
    renderPick();
  }

  function renderResults(results) {
    const list = $("mpRuleResults");
    if (!list) return;
    list.innerHTML = `<p class="section-label">搜索结果 · ${results.length} 个</p>` + results.map((item, i) => `<div class="rule-item">
      <div class="rule-item-text"><b>${escapeText(item.name)}</b><small>${escapeText(item.href.replace(/^https?:\/\//, "").slice(0, 70))}</small></div>
      <button type="button" data-result="${i}">看分集</button>
    </div>`).join("");
    list.querySelectorAll("[data-result]").forEach(button => {
      button.onclick = () => openChapters(results[Number(button.dataset.result)]);
    });
  }

  async function openChapters(result) {
    const rule = installed.find(entry => entry.name === activeRule)?.rule;
    if (!rule || !result) return;
    const box = $("mpRuleEpisodes");
    box.innerHTML = "";
    setStatus("mpRuleStatus", `正在读取「${result.name}」…`);
    try {
      const list = await chapters(rule, result.href, text => setStatus("mpRuleStatus", text));
      lastChapters = { result, list };
      setStatus("mpRuleStatus", `${result.name} · 找到 ${list.length} 集`);
      const roads = new Map();
      list.forEach((item, i) => {
        if (!roads.has(item.road)) roads.set(item.road, []);
        roads.get(item.road).push({ item, i });
      });
      box.innerHTML = [...roads].map(([road, items]) => `
        <div class="rule-road">
          <p class="section-label">线路 ${road + 1} · ${items.length} 集</p>
          <div class="rule-episodes">${items.map(({ item, i }) => `<button type="button" data-play="${i}">${escapeText(item.name)}</button>`).join("")}</div>
        </div>`).join("") + `<button type="button" class="text-button" id="mpRuleOpenWeb">在浏览器里打开这个条目</button>`;
      box.querySelectorAll("[data-play]").forEach(button => {
        button.onclick = () => playEpisode(list[Number(button.dataset.play)], button);
      });
      $("mpRuleOpenWeb").onclick = () => host?.external(result.href);
    } catch (error) {
      setStatus("mpRuleStatus", error.message || "读取分集失败", true);
    }
  }

  async function playEpisode(item, button) {
    const rule = installed.find(entry => entry.name === activeRule)?.rule;
    if (!rule || !item) return;
    const label = button.textContent;
    button.disabled = true;
    button.textContent = "解析中…";
    try {
      const media = await mediaUrl(rule, item.href, text => setStatus("mpRuleStatus", text));
      if (!media) {
        setStatus("mpRuleStatus", "页面里没有直接的 m3u8／mp4 地址，可以到浏览器里打开这个条目", true);
        return;
      }
      const title = lastChapters?.result?.name || item.name;
      if (window.HandbookPlayer?.playStandalone(media, title, item.name)) {
        setStatus("mpRuleStatus", `正在播放：${item.name}`);
        close();
      } else {
        setStatus("mpRuleStatus", "播放器没有接管这个地址，试试用浏览器打开", true);
      }
    } catch (error) {
      setStatus("mpRuleStatus", error.message || "解析播放地址失败", true);
    } finally {
      button.disabled = false;
      button.textContent = label;
    }
  }

  // ---------- 面板 ----------
  function open(from = "app") {
    const node = page();
    if (!node) return;
    node.hidden = false;
    document.body.classList.add("page-open");
    renderSummary();
    renderPick();
    renderInstalled();
    renderRepo();
    switchTab("find");
    const query = $("mpRuleQuery");
    if (query && !query.value) query.value = lastKeyword;
    if (!installed.length && !repo.items.length) loadRepo(false).then(renderRepo).catch(() => {});
  }
  function close() {
    const node = page();
    if (!node || node.hidden) return false;
    node.hidden = true;
    document.body.classList.remove("page-open");
    setStatus("mpRuleStatus", "");
    $("mpRuleEpisodes").innerHTML = "";
    window.HandbookMobile?.syncNav?.();
    return true;
  }
  function isOpen() { return Boolean(page() && !page().hidden); }

  function switchTab(tab) {
    document.querySelectorAll("[data-rule-tab]").forEach(button => {
      button.setAttribute("aria-selected", String(button.dataset.ruleTab === tab));
    });
    document.querySelectorAll("[data-rule-view]").forEach(view => {
      view.hidden = view.dataset.ruleView !== tab;
    });
    if (tab === "repo" && !repo.items.length) loadRepo(false).then(renderRepo).catch(() => {});
  }

  document.addEventListener("DOMContentLoaded", () => {
    document.querySelectorAll("[data-rule-tab]").forEach(button => {
      button.addEventListener("click", () => switchTab(button.dataset.ruleTab));
    });
    $("mpRuleBack")?.addEventListener("click", close);
    $("mpRulePick")?.addEventListener("change", () => {
      activeRule = $("mpRulePick").value;
      write(ACTIVE_KEY, activeRule);
      $("mpRuleResults").innerHTML = "";
      $("mpRuleEpisodes").innerHTML = "";
      setStatus("mpRuleStatus", "");
    });
    $("mpRuleFindForm")?.addEventListener("submit", async event => {
      event.preventDefault();
      const rule = installed.find(entry => entry.name === activeRule)?.rule;
      const keyword = String($("mpRuleQuery")?.value || "").trim();
      if (!rule) { setStatus("mpRuleStatus", "先在「规则仓库」装一条规则", true); return; }
      if (!keyword) return;
      lastKeyword = keyword;
      write(QUERY_KEY, keyword);
      $("mpRuleResults").innerHTML = "";
      $("mpRuleEpisodes").innerHTML = "";
      const button = event.submitter || $("mpRuleFindForm").querySelector("button");
      button.disabled = true;
      try {
        const results = await search(rule, keyword, text => setStatus("mpRuleStatus", text));
        setStatus("mpRuleStatus", `找到 ${results.length} 个条目`);
        renderResults(results);
      } catch (error) {
        setStatus("mpRuleStatus", error.message || "搜索失败", true);
      } finally {
        button.disabled = false;
      }
    });
    $("mpRuleRefresh")?.addEventListener("click", async () => {
      const button = $("mpRuleRefresh");
      button.disabled = true;
      try { await loadRepo(true); renderRepo(); }
      catch (error) { setStatus("mpRuleRepoStatus", error.message || "读取仓库失败", true); }
      finally { button.disabled = false; }
    });
    $("mpRuleFilter")?.addEventListener("input", renderRepo);
    $("mpRuleLinkImport")?.addEventListener("click", async () => {
      const url = prompt("规则 JSON 的 HTTPS 链接");
      if (!url) return;
      try {
        const name = await installFromUrl(url.trim());
        switchTab("installed");
        toast(`已导入规则：${name}`);
      } catch (error) { alert(error.message || "导入失败"); }
    });
    $("mpRulePasteImport")?.addEventListener("click", () => {
      $("rulePasteText").value = "";
      $("rulePasteStatus").textContent = "";
      $("rulePasteDialog").showModal();
    });
    $("rulePasteDialog")?.addEventListener("submit", event => {
      if (event.submitter?.value !== "save") return;   // 取消时交给 dialog 自己关闭
      event.preventDefault();                          // 校验不过就留在弹窗里，别把错误一起关掉
      const raw = $("rulePasteText").value.trim();
      if (!raw) { $("rulePasteStatus").textContent = "先把规则 JSON 贴进来"; return; }
      try {
        const name = saveRule(JSON.parse(raw), "");
        $("rulePasteDialog").close();
        toast(`已导入规则：${name}`);
      } catch (error) {
        $("rulePasteStatus").textContent = error.message || "规则格式不对";
      }
    });
  });

  function toast(text) {
    let node = document.querySelector("#appToast");
    if (!node) {
      node = document.createElement("p");
      node.id = "appToast";
      node.setAttribute("role", "status");
      document.body.append(node);
    }
    node.textContent = text;
    node.classList.add("is-visible");
    clearTimeout(toast.timer);
    toast.timer = window.setTimeout(() => node.classList.remove("is-visible"), 2200);
  }

  window.HandbookRules = {
    open,
    close,
    isOpen,
    back() { return close(); },
    count() { return installed.filter(entry => entry.enabled !== false).length; },
    fetchResult(id, text, error) {
      const entry = pending.get(id);
      pending.delete(id);
      if (!entry) return;
      if (error) entry.reject(Error(error));
      else entry.resolve(String(text ?? ""));
    },
  };
})();
