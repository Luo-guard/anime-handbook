"use strict";
// Loaded only by the online entry point. The desktop page never loads this file.
window.handbookOnline = (() => {
  let revision = null, csrf = "", timer, polling = false, writes = 0, refreshPending = false;
  let mutationQueue = Promise.resolve();
  const auth = fetch("/api/auth/me", {cache: "no-store"}).then(async (response) => {
    if (response.status === 401) { location.replace("/login"); throw Error("请先登录"); }
    if (!response.ok) throw Error("无法连接手账服务器");
    const user = await response.json(); csrf = user.csrf; return user;
  });
  function offline(show) {
    let banner = document.querySelector("#onlineOffline");
    if (show && !banner) {
      banner = document.createElement("div"); banner.id = "onlineOffline"; banner.className = "online-offline";
      banner.textContent = "连接中断，修改尚未确认保存，请保留当前页面。"; banner.role = "status"; document.body.append(banner);
    } else if (!show) banner?.remove();
  }
  async function perform(path, options) {
    const user = await auth;
    const method = options.method || "GET", write = method !== "GET";
    if (write && user.read_only && path !== "/api/auth/logout") {
      // View preferences are temporary within this tab, never sent to the server.
      const preferences = path === "/api/settings" && method === "PATCH" ? JSON.parse(options.body || "{}") : null;
      const viewKeys = new Set(["schedule_sort", "schedule_grouping", "schedule_statuses", "schedule_uncollected", "collection_sort_modes", "collection_sort_directions", "category_rating_visibility", "category_progress_visibility"]);
      if (preferences && Object.keys(preferences).every(key => viewKeys.has(key))) return {ok: true, settings: {...state.settings, ...preferences}};
      throw Error("游客体验为只读，请注册自己的手账后记录");
    }
    const headers = {"Content-Type": "application/json", ...(options.headers || {})};
    if (write) { headers["X-CSRF-Token"] = csrf; headers["If-Match"] = String(revision); }
    let response;
    try { response = await fetch(path, {...options, headers, cache: "no-store"}); }
    catch (error) { if (error.name !== "AbortError") offline(true); throw error; }
    if (response.status === 401) { location.replace("/login"); throw Error("登录已过期"); }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      // Keep the old revision after conflicts: another save must never reuse stale form data.
      if (response.status !== 409 && write) {
        const value = response.headers.get("X-Handbook-Revision");
        if (value !== null) revision = Number(value);
      }
      throw Error(payload.message || `请求失败（${response.status}）`);
    }
    offline(false);
    if (payload.refresh_required) refreshPending = true;
    if ((path === "/api/bootstrap" && !options.onlinePoll) || write) {
      const value = response.headers.get("X-Handbook-Revision");
      if (value !== null) revision = Number(value);
    }
    return payload;
  }
  function request(path, options = {}) {
    if (!options.method || options.method === "GET") return perform(path, options);
    if (/^\/api\/animes\/\d+\/progress$/.test(path) && state.progressAnime) {
      const body = JSON.parse(options.body || "{}");
      body.base_episode_keys = [...(state.progressAnime.watched_episode_keys || [])];
      body.watched_at = new Date().toISOString();
      options = {...options, body: JSON.stringify(body)};
    }
    writes++;
    const task = mutationQueue.then(() => perform(path, options));
    mutationQueue = task.catch(() => {}).finally(() => writes--);
    return task;
  }
  function uploadImage(path, file, profileId) {
    if (!file.size || file.size > 8 * 1024 * 1024) return Promise.reject(Error("图片不能为空或超过 8 MB"));
    const target = profileId ? `${path}?profile_id=${encodeURIComponent(profileId)}` : path;
    return request(target, {method: "POST", headers: {"Content-Type": file.type || "application/octet-stream"}, body: file});
  }
  function editing() {
    return document.querySelector("dialog[open], #noteComposer:not(.hidden), .inline-event-editor") || /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) || state.rankingDirtyBoards.size;
  }
  async function poll() {
    if (document.hidden || polling || writes || editing()) return;
    polling = true;
    try {
      const change = await request("/api/changes");
      if ((change.revision !== revision || refreshPending) && !writes && !editing()) {
        const startingRevision = revision;
        const payload = await request("/api/bootstrap", {onlinePoll: true});
        if (writes || editing() || revision !== startingRevision) return;
        revision = payload.revision;
        refreshPending = false;
        Object.assign(state, payload);
        applyTheme(); applySidebarLayout(); renderStats(); renderSync(); renderTabs(); renderCollection(); renderSeasonFilter(); populateAnimeSelect();
        if (state.activeView === "timeline") await renderTimeline();
        if (state.activeView === "statistics") await renderStatistics();
        if (state.activeView === "schedule") renderSchedule();
        if (state.activeView === "ranking") { state.rankingBoard = null; renderRanking(); }
      }
    } catch { /* The next poll retries. Existing data and draft input remain visible. */ }
    finally { polling = false; }
  }
  function hideLocalControls() {
    ["launchAtLoginInput", "topSyncActionInput"].forEach((id) => document.getElementById(id)?.closest(".setting-row")?.classList.add("online-hidden"));
  }
  async function start() {
    if (timer) return;
    hideLocalControls();
    document.querySelector("#collectionView .eyebrow").textContent = "MY COLLECTION";
    document.querySelector("#rankingView .page-subtitle").textContent = "属于你的个人封面排行榜";
    const backgroundHint = document.querySelector("#customBackgroundInput")?.closest(".setting-row")?.querySelector("small");
    if (backgroundHint) backgroundHint.textContent = "原图保存到你的线上账号，不缩小、不重新压缩；单张最大 8 MB。";
    const user = await auth;
    if (user.read_only) setupGuestPresentation();
    const account = document.createElement("div"); account.className = "online-account";
    const name = document.createElement("span"); name.textContent = user.username;
    const logout = document.createElement("button"); logout.textContent = "退出登录";
    logout.textContent = user.read_only ? "返回登录" : "退出登录";
    logout.onclick = async () => {
      try { await request("/api/auth/logout", {method: "POST", body: "{}"}); location.replace("/login"); }
      catch (error) { toast(error.message, "error"); }
    };
    account.append(name, logout); document.querySelector(".sidebar").append(account);
    if (!user.read_only) {
      const actions = document.createElement("div"); actions.className = "online-actions";
      const add = document.createElement("button"); add.className = "primary-button"; add.textContent = "添加番剧";
      add.onclick = showAddSubject; actions.append(add);
      document.querySelector("#collectionView .page-header").append(actions);
      setupCategoryControl();
    }
    timer = setInterval(poll, 5000);
    document.addEventListener("visibilitychange", poll);
    window.addEventListener("focus", poll);
    window.addEventListener("online", poll);
  }
  function setupGuestPresentation() {
    document.body.classList.add("guest-mode");
    const banner = document.createElement("div"); banner.className = "guest-banner";
    banner.innerHTML = '<span>游客体验 · 番剧资料为公开快照，观看记录与排名为演示内容，仅供浏览。</span><a href="/login?mode=register">注册我的手账 ↗</a>';
    document.querySelector(".main-content, main").prepend(banner);
    const edits = '#createCollectionButton,#writeNoteButton,#createRankingButton,#saveSettings,#saveProgress,#openAnimeComment,#openAnimeRating,.edit-event,.delete-event,.card-move-button,.episode-quick-action,#addRankingTier,#renameRankingBoard,#saveRankingTemplate,#saveRankingBoard,#deleteRankingBoard,#rankingImportButton';
    document.addEventListener("click", event => {
      if (event.target.closest(edits)) { event.preventDefault(); event.stopImmediatePropagation(); }
    }, true);
    // Shared views render lazily. Disable only write controls, keeping navigation,
    // search, collection filters, chart ranges and detail tabs available.
    const disable = () => {
      document.querySelectorAll('[data-tier-name],#settingsModal input,#settingsModal select,#settingsModal textarea,#settingsModal .theme-profile-controls button,#settingsModal .setting-row button').forEach(node => { if (!node.disabled) node.disabled = true; });
      document.querySelectorAll('[data-ranking-anime][draggable="true"],#animeGrid [draggable="true"]').forEach(node => node.draggable = false);
    };
    disable();
    new MutationObserver(disable).observe(document.body, {childList: true, subtree: true});
  }
  function showAddSubject() {
    let dialog = document.querySelector("#onlineAddSubject");
    if (!dialog) {
      dialog = document.createElement("dialog"); dialog.id = "onlineAddSubject"; dialog.className = "online-dialog";
      dialog.innerHTML = '<form><h2>添加一部番剧</h2><p>输入 Bangumi 动画条目的 ID 或链接。</p><label>番剧 ID 或链接<input name="subject" required placeholder="例如：123456 或 https://bgm.tv/subject/123456"></label><label>收藏状态<select name="category"><option value="1">在看</option><option value="2" selected>想看</option><option value="3">搁置</option><option value="4">看过</option><option value="5">抛弃</option></select></label><div class="dialog-actions"><button type="button" class="text-button">取消</button><button type="submit" class="primary-button">加入收藏</button></div></form>';
      dialog.querySelector('[type="button"]').onclick = () => dialog.close();
      dialog.querySelector("form").onsubmit = async (event) => {
        event.preventDefault(); const form = event.currentTarget;
        const text = form.elements.subject.value.trim();
        const match = text.match(/^(?:https:\/\/(?:bgm.tv|bangumi.tv|chii.in)\/subject\/)?([1-9]\d*)\/?$/);
        if (!match) return toast("请输入正确的 Bangumi 动画条目 ID 或链接", "error");
        const button = form.querySelector('[type="submit"]'); button.disabled = true;
        try { await request("/api/subjects", {method: "POST", body: JSON.stringify({id: Number(match[1]), category: Number(form.elements.category.value)})}); dialog.close(); await reloadCollection(); toast("已加入收藏"); }
        catch (error) { toast(error.message, "error"); }
        finally { button.disabled = false; }
      };
      document.body.append(dialog);
    }
    dialog.showModal();
  }
  function setupCategoryControl() {
    const control = document.createElement("label"); control.className = "online-edit-category";
    control.innerHTML = '收藏状态 <select><option value="1">在看</option><option value="2">想看</option><option value="3">搁置</option><option value="4">看过</option><option value="5">抛弃</option><option value="0">移出收藏（保留记录）</option></select>';
    const modal = document.querySelector("#progressModal");
    modal.querySelector(".detail-tabs").before(control);
    const select = control.querySelector("select");
    const observer = new MutationObserver(() => { if (modal.open && state.progressAnime) select.value = String(state.progressAnime.collection_type); });
    observer.observe(modal, {attributes: true, attributeFilter: ["open"]});
    select.onchange = async () => {
      if (!state.progressAnime) return;
      try {
        await request(`/api/subjects/${state.progressAnime.id}`, {method: "PATCH", body: JSON.stringify({category: Number(select.value)})});
        modal.close(); await reloadCollection();
      } catch (error) { toast(error.message, "error"); }
    };
  }
  async function reloadCollection() {
    const payload = await request("/api/bootstrap"); Object.assign(state, payload);
    renderStats(); renderTabs(); renderCollection(); populateAnimeSelect();
  }
  return {request, uploadImage, start, poll};
})();
