// 手机版片源规则：从 GitHub 的 KazumiRules 安装规则，按番名搜索、解析分集。
// 规则格式与 Kazumi 一致（XPath），但手机版只跑不需要网页渲染的静态站点：
// 页面 HTML 由原生桥抓取后交给 DOMParser，再用 XPath 取结果。
(() => {
  const $ = id => document.getElementById(id);
  const host = window.AndroidPlayer;
  const INSTALLED_KEY = "mobile-player:rules";
  const REPO_KEY = "mobile-player:rule-repo";
  const REPO_INDEX = "https://api.github.com/repos/Predidit/KazumiRules/contents/";
  const REPO_TTL = 12 * 60 * 60 * 1000;

  const escapeText = value => String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const read = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
  const write = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 存储满了也不影响播放 */ } };

  let installed = read(INSTALLED_KEY, []);
  let repo = read(REPO_KEY, { at: 0, items: [] });
  const pending = new Map();
  let sequence = 0;
  let activeRule = "";

  // ---------- 原生联网 ----------
  function fetchText(url, referer = "") {
    return new Promise((resolve, reject) => {
      if (!host?.fetchText) { reject(Error("当前安装包不支持规则联网，请更新到 1.0.17 及以上")); return; }
      const id = ++sequence;
      const timer = window.setTimeout(() => {
        if (pending.delete(id)) reject(Error("请求超时，请检查网络"));
      }, 15000);
      pending.set(id, {
        resolve: text => { clearTimeout(timer); resolve(text); },
        reject: error => { clearTimeout(timer); reject(error); },
      });
      try { host.fetchText(id, url, JSON.stringify(referer ? { Referer: referer } : {})); }
      catch (error) { pending.delete(id); clearTimeout(timer); reject(Error("无法发起请求")); }
    });
  }

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
    if (node.nodeType === 2) return String(node.value || "").trim();     // 属性节点
    return String(node.textContent || "").replace(/\s+/g, " ").trim();
  }
  function nodeHref(node, base) {
    if (!node) return "";
    const raw = node.nodeType === 2 ? node.value : (node.getAttribute?.("href") || node.getAttribute?.("src") || node.href || "");
    try { return raw ? new URL(raw, base).href : ""; } catch { return ""; }
  }
  function parseHtml(text) { return new DOMParser().parseFromString(String(text || ""), "text/html"); }

  function ruleAbs(rule, url) {
    try { return new URL(url, rule.baseURL || "https://example.com").href; } catch { return url; }
  }

  // ---------- 规则动作 ----------
  async function search(rule, keyword) {
    const target = String(rule.searchURL || "").replaceAll("@keyword", encodeURIComponent(keyword));
    if (!target) throw Error("这条规则没有配置搜索地址");
    const html = await fetchText(ruleAbs(rule, target), rule.baseURL);
    const doc = parseHtml(html);
    const nodes = xpathAll(doc, rule.searchList);
    const results = nodes.map(node => ({
      name: nodeText(xpathAll(node, rule.searchName)[0]) || nodeText(node),
      href: nodeHref(xpathAll(node, rule.searchResult)[0] || node, rule.baseURL),
    })).filter(item => item.href);
    if (!results.length) {
      throw Error(rule.useWebview
        ? "没有解析到结果：这条规则依赖网页脚本渲染，手机版暂时只支持纯静态页面"
        : "没有解析到结果，换个关键词或换一条规则试试");
    }
    return results;
  }

  async function chapters(rule, href) {
    const html = await fetchText(href, rule.baseURL);
    const doc = parseHtml(html);
    const roads = xpathAll(doc, rule.chapterRoads);
    const groups = roads.length ? roads.map(road => xpathAll(road, rule.chapterResult)) : [xpathAll(doc, rule.chapterResult)];
    const list = [];
    groups.forEach((links, roadIndex) => {
      links.forEach((link, i) => {
        const url = nodeHref(link, href);
        if (url) list.push({ road: roadIndex, name: nodeText(link) || `第 ${i + 1} 集`, href: url });
      });
    });
    if (!list.length) throw Error("这个条目没有解析到分集，可能也要网页渲染");
    return list;
  }

  // 从剧集页里找直链：m3u8 优先，其次 mp4。很多站点把地址放在播放器配置里。
  async function mediaUrl(rule, href) {
    const html = await fetchText(href, rule.baseURL);
    const flat = String(html).replace(/\\\//g, "/");
    const found = [...flat.matchAll(/https?:\/\/[^\s"'<>\\]+?\.(?:m3u8|mp4)(?:\?[^\s"'<>\\]*)?/gi)].map(match => match[0]);
    const unique = [...new Set(found)];
    return unique.find(url => /\.m3u8/i.test(url)) || unique[0] || "";
  }

  // ---------- 仓库与安装 ----------
  async function loadRepo(force) {
    if (!force && repo.items.length && Date.now() - repo.at < REPO_TTL) return repo.items;
    setStatus("mpRuleRepoStatus", "正在读取仓库…");
    const text = await fetchText(REPO_INDEX);
    let parsed;
    try { parsed = JSON.parse(text); } catch { throw Error("仓库返回的不是有效 JSON（可能被限流）"); }
    if (!Array.isArray(parsed)) throw Error(parsed?.message || "仓库返回异常");
    repo = {
      at: Date.now(),
      items: parsed.filter(file => /\.json$/i.test(file.name)).map(file => ({
        name: file.name.replace(/\.json$/i, ""),
        url: file.download_url,
        size: file.size,
      })),
    };
    write(REPO_KEY, repo);
    setStatus("mpRuleRepoStatus", `已读取 ${repo.items.length} 条规则，点「安装」加入本机。`);
    return repo.items;
  }

  async function install(item) {
    const text = await fetchText(item.url);
    let rule;
    try { rule = JSON.parse(text); } catch { throw Error("规则文件不是有效 JSON"); }
    if (!rule?.baseURL || !rule?.searchURL || !rule?.searchList) throw Error("这条规则缺少必要字段");
    const name = String(rule.name || item.name);
    installed = installed.filter(entry => entry.name !== name);
    installed.push({ name, rule, addedAt: Date.now(), enabled: true });
    write(INSTALLED_KEY, installed);
    renderInstalled();
    renderPick();
    return name;
  }

  function remove(name) {
    installed = installed.filter(entry => entry.name !== name);
    write(INSTALLED_KEY, installed);
    if (activeRule === name) activeRule = installed[0]?.name || "";
    renderInstalled();
    renderPick();
  }

  // ---------- 渲染 ----------
  function setStatus(id, text, error) {
    const node = $(id);
    if (!node) return;
    node.textContent = text || "";
    node.style.color = error ? "#ff9d94" : "";
  }

  function renderPick() {
    const pick = $("mpRulePick");
    if (!pick) return;
    const enabled = installed.filter(entry => entry.enabled !== false);
    if (!enabled.some(entry => entry.name === activeRule)) activeRule = enabled[0]?.name || "";
    pick.replaceChildren(...enabled.map(entry => new Option(entry.name, entry.name)));
    pick.value = activeRule;
    pick.disabled = !enabled.length;
    const form = $("mpRuleFindForm");
    form?.querySelector("button")?.toggleAttribute("disabled", !enabled.length);
    if (!enabled.length) setStatus("mpRuleStatus", "还没有安装规则。切到「规则仓库」装一条试试。");
  }

  function renderRepo() {
    const host = $("mpRuleRepo");
    if (!host) return;
    const filter = String($("mpRuleFilter")?.value || "").trim().toLowerCase();
    const items = repo.items.filter(item => !filter || item.name.toLowerCase().includes(filter));
    if (!items.length) {
      host.innerHTML = `<p class="mp-hint">${repo.items.length ? "没有匹配的规则名。" : "点「刷新列表」从 GitHub 读取规则。"}</p>`;
      return;
    }
    host.innerHTML = items.map(item => {
      const have = installed.some(entry => entry.name === item.name);
      return `<div class="mp-rule-item">
        <div><b>${escapeText(item.name)}</b><small>${have ? "已安装 · 可重新安装覆盖" : "KazumiRules"}</small></div>
        <button type="button" data-install="${escapeText(item.name)}">${have ? "重装" : "安装"}</button>
      </div>`;
    }).join("");
    host.querySelectorAll("[data-install]").forEach(button => {
      button.onclick = async () => {
        const item = repo.items.find(entry => entry.name === button.dataset.install);
        if (!item) return;
        button.disabled = true;
        button.textContent = "安装中…";
        try {
          const name = await install(item);
          setStatus("mpRuleRepoStatus", `已安装「${name}」`);
          renderRepo();
        } catch (error) {
          setStatus("mpRuleRepoStatus", error.message || "安装失败", true);
          button.disabled = false;
          button.textContent = "安装";
        }
      };
    });
  }

  function renderInstalled() {
    const host = $("mpRuleInstalled");
    if (!host) return;
    if (!installed.length) {
      host.innerHTML = `<p class="mp-hint">还没有安装规则。切到「规则仓库」选一条。</p>`;
      renderPick();
      return;
    }
    host.innerHTML = installed.map(entry => `<div class="mp-rule-item${entry.enabled !== false ? " is-active" : ""}">
      <div><b>${escapeText(entry.name)}</b><small>${escapeText((entry.rule.baseURL || "").replace(/^https?:\/\//, ""))}</small></div>
      <button type="button" data-toggle="${escapeText(entry.name)}">${entry.enabled !== false ? "停用" : "启用"}</button>
      <button type="button" data-remove="${escapeText(entry.name)}">删除</button>
    </div>`).join("");
    host.querySelectorAll("[data-toggle]").forEach(button => {
      button.onclick = () => {
        const entry = installed.find(item => item.name === button.dataset.toggle);
        if (!entry) return;
        entry.enabled = entry.enabled === false;
        write(INSTALLED_KEY, installed);
        renderInstalled();
        renderPick();
      };
    });
    host.querySelectorAll("[data-remove]").forEach(button => {
      button.onclick = () => { remove(button.dataset.remove); renderRepo(); };
    });
    renderPick();
  }

  function renderResults(results) {
    const host = $("mpRuleResults");
    if (!host) return;
    host.innerHTML = results.map((item, i) => `<div class="mp-rule-item">
      <div><b>${escapeText(item.name)}</b><small>${escapeText(item.href.replace(/^https?:\/\//, "").slice(0, 60))}</small></div>
      <button type="button" data-result="${i}">看分集</button>
    </div>`).join("");
    host.querySelectorAll("[data-result]").forEach(button => {
      button.onclick = () => openChapters(results[Number(button.dataset.result)]);
    });
  }

  async function openChapters(result) {
    const rule = installed.find(entry => entry.name === activeRule)?.rule;
    if (!rule || !result) return;
    setStatus("mpRuleStatus", `正在读取「${result.name}」的分集…`);
    $("mpRuleEpisodes").innerHTML = "";
    try {
      const list = await chapters(rule, result.href);
      setStatus("mpRuleStatus", `${result.name} · ${list.length} 集`);
      const host = $("mpRuleEpisodes");
      host.innerHTML = list.map((item, i) => `<div class="mp-rule-item">
        <div><b>${escapeText(item.name)}</b><small>第 ${item.road + 1} 线路</small></div>
        <button type="button" data-play="${i}">播放</button>
      </div>`).join("");
      host.querySelectorAll("[data-play]").forEach(button => {
        button.onclick = () => playEpisode(list[Number(button.dataset.play)], button);
      });
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
      const media = await mediaUrl(rule, item.href);
      if (media && window.HandbookPlayer?.playUrl(media, item.name)) {
        setStatus("mpRuleStatus", `已开始播放：${item.name}`);
        const sheet = document.getElementById("mpRules");
        if (sheet) sheet.hidden = true;
        return;
      }
      setStatus("mpRuleStatus", "这个页面里没有直接的 m3u8／mp4 地址，可以用「浏览器打开」。", true);
      host?.external(item.href);
    } catch (error) {
      setStatus("mpRuleStatus", error.message || "解析播放地址失败", true);
    } finally {
      button.disabled = false;
      button.textContent = label;
    }
  }

  // ---------- 面板 ----------
  function open() {
    renderPick();
    renderInstalled();
    renderRepo();
    switchTab("find");
  }
  function switchTab(tab) {
    document.querySelectorAll("[data-rule-tab]").forEach(button => {
      button.setAttribute("aria-selected", String(button.dataset.ruleTab === tab));
    });
    document.querySelectorAll("[data-rule-view]").forEach(view => {
      view.hidden = view.dataset.ruleView !== tab;
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    document.querySelectorAll("[data-rule-tab]").forEach(button => {
      button.addEventListener("click", () => switchTab(button.dataset.ruleTab));
    });
    $("mpRulePick")?.addEventListener("change", () => { activeRule = $("mpRulePick").value; });
    $("mpRuleFindForm")?.addEventListener("submit", async event => {
      event.preventDefault();
      const rule = installed.find(entry => entry.name === activeRule)?.rule;
      const keyword = String($("mpRuleQuery")?.value || "").trim();
      if (!rule) { setStatus("mpRuleStatus", "先安装并选择一条规则", true); return; }
      if (!keyword) return;
      setStatus("mpRuleStatus", "正在搜索…");
      $("mpRuleResults").innerHTML = "";
      $("mpRuleEpisodes").innerHTML = "";
      try {
        const results = await search(rule, keyword);
        setStatus("mpRuleStatus", `找到 ${results.length} 个条目`);
        renderResults(results);
      } catch (error) {
        setStatus("mpRuleStatus", error.message || "搜索失败", true);
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
  });

  window.HandbookRules = {
    open,
    fetchResult(id, text, error) {
      const entry = pending.get(id);
      pending.delete(id);
      if (!entry) return;
      if (error) entry.reject(Error(error));
      else entry.resolve(String(text ?? ""));
    },
  };
})();
