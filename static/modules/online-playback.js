const XIFAN_SITE = "https://next.xifanacg.com";
const XIFAN_SAMPLE = XIFAN_SITE + "/anime/3435/play/203809";

function isOnlinePlaybackLink(value) {
  try {
    const url = new URL(value);
    return url.origin === XIFAN_SITE && !url.username && !url.password
      && /^\/anime\/[1-9]\d{0,8}(?:\/play\/[1-9]\d{0,8})?\/?$/.test(url.pathname);
  } catch { return false; }
}

function onlineEpisodeLabel(session, episode = session.episode) {
  const { animeId, context, source } = session;
  const number = onlineLocalEpisodeNumber(episode, source, context?.target.first);
  if (!number) return "播放";
  const label = `第 ${number} 集`;
  const anime = state.progressAnime?.id === animeId ? state.progressAnime
    : state.animes.find(item => item.id === animeId) || context?.anime;
  const localEpisode = anime?.episodes?.find(item => episodeStorageKey(item.key, anime) === `0:${number}`);
  const name = [localEpisode?.name_cn, localEpisode?.name].map(value => String(value || "").trim())
    .find(value => value && value !== String(number) && value.replace(/\s/g, "") !== `第${number}集`);
  return name ? `${label} · ${name}` : label;
}

function mainPlaybackEpisode(anime, key, { providerEpisode, source } = {}) {
  const episodes = (anime.episodes || []).filter(episode => Number(episode.type || 0) === 0);
  const numberOf = value => Number(/^0:(\d+)$/.exec(episodeStorageKey(value, anime))?.[1]) || 0;
  const numbers = episodes.map(episode => numberOf(episode.key)).filter(Boolean);
  const first = numbers.length ? Math.min(...numbers) : 1;
  const watched = anime.watched_episode_keys || anime.watched_episodes || [];
  const number = providerEpisode ? onlineLocalEpisodeNumber(providerEpisode, source, first)
    : key ? numberOf(key) : Math.max(first - 1, ...watched.map(numberOf)) + 1;
  if (!number) throw new Error("该播放源暂只支持正片集数。");
  const total = Number(anime.episode_count) || numbers.length;
  if (!key && !providerEpisode && total > 0 && number >= first + total)
    throw new Error("已看完手账目前收录的正片，可从单集菜单重播。");
  return { number, first };
}

function onlineLineStartsAtOne(source) {
  const numbers = source.episodes.map(episode => Number(episode.number)).filter(number => Number.isInteger(number) && number > 0);
  return Math.min(...numbers) === 1;
}

function onlineLocalEpisodeNumber(episode, source, first = 1) {
  const number = Number(episode.number);
  return Number.isFinite(number) && number > 0
    ? number + (first > 1 && onlineLineStartsAtOne(source) ? first - 1 : 0)
    : 0;
}

function matchOnlineEpisode(catalogue, target) {
  for (const source of catalogue.sources) {
    const wanted = onlineLineStartsAtOne(source) ? target.number - target.first + 1 : target.number;
    const episode = source.episodes.find(item => Number(item.number) === wanted);
    if (episode) return { source, episode };
  }
  throw new Error(`所选规则暂无第 ${target.number} 集的可用线路。`);
}

window.onlinePlayback = (() => {
  let current = null;
  let lookup = null;
  let selection = null;
  let installed = [];
  let lastRule = "";
  let defaultRule = "";
  let hlsLibrary;
  let managing = false;
  let checkingRules = false;

  try { lastRule = localStorage.getItem("handbook:online-rule") || ""; }
  catch { /* Private browsing can deny storage. */ }

  function abortLookup() {
    lookup?.abort();
    lookup = null;
  }

  function resumeKey(session) {
    return session.catalogue.rule === "xfdmnext"
      ? `handbook:xifan:progress:${session.episode.id}`
      : `handbook:online:progress:${session.catalogue.rule}:${session.catalogue.id}:${session.episode.id}`;
  }

  function readResume(session) {
    try { return Number(localStorage.getItem(resumeKey(session))) || 0; }
    catch { return 0; }
  }

  function saveResume() {
    const video = $("#offlineVideo");
    if (!current?.ready || !Number.isFinite(video.duration) || video.currentTime < 2) return;
    try {
      localStorage.setItem(resumeKey(current), video.ended || video.duration - video.currentTime < 5 ? 0 : video.currentTime);
    } catch { /* 浏览器禁用存储时仍可播放。 */ }
  }

  function close() {
    if (!current) return false;
    saveResume();
    current.controller.abort();
    current = null;
    $("#onlinePlayerOptions").classList.add("hidden");
    return true;
  }

  async function request(route, query, signal) {
    return api("/api/playback/" + route + "?" + new URLSearchParams(query), { signal, timeoutMs: 35000 });
  }

  function getHls() {
    if (!hlsLibrary) {
      hlsLibrary = new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = "/vendor/hls/hls.min.js?v=1.6.15";
        script.onload = () => window.Hls ? resolve(window.Hls) : reject(new Error("HLS 播放组件未加载"));
        script.onerror = () => reject(new Error("HLS 播放组件未加载"));
        document.head.append(script);
      }).catch(error => { hlsLibrary = null; throw error; });
    }
    return hlsLibrary;
  }

  async function loadMedia(result, session, fail) {
    const video = $("#offlineVideo");
    if (result.format !== "hls") {
      await pcLoadVideo(result.url, readResume(session));
      return;
    }
    const Hls = await getHls();
    const { signal } = session.controller;
    if (signal.aborted) return;
    if (!Hls.isSupported()) {
      if (!video.canPlayType("application/vnd.apple.mpegurl")) throw new Error("当前浏览器不支持 HLS 内置播放");
      await pcLoadVideo(result.url, readResume(session));
      return;
    }
    const hls = new Hls();
    signal.addEventListener("abort", () => hls.destroy(), { once: true });
    hls.on(Hls.Events.ERROR, (_, data) => {
      if (data.fatal) fail("HLS 视频读取失败，可重试或切换线路。");
    });
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      video.play().catch(error => {
        if (error.name !== "NotAllowedError") fail("视频未能开始播放，可重试或切换线路。");
      });
    });
    pcPrepareVideo(readResume(session));
    hls.loadSource(result.url);
    hls.attachMedia(video);
  }

  function errorMessage(error, timeoutMessage) {
    return error.name === "TimeoutError" ? timeoutMessage : error.message;
  }

  function selectEpisode(id) {
    if (!current) return;
    const { catalogue, source, animeId } = current;
    const episode = source.episodes.find(item => String(item.id) === String(id));
    if (episode) play(catalogue, source, episode, animeId);
  }

  async function play(catalogue, source, episode, animeId, context = current?.context, tried = null) {
    if (offlineView.playing) closeOfflinePlayer();
    saveResume();
    current?.controller.abort();
    pcResetVideo();
    clearSubtitleSession();
    const controller = new AbortController();
    const session = { catalogue, source, episode, animeId, controller, context, ready: false };
    current = session;
    const video = $("#offlineVideo");
    const selector = $("#onlinePlayerSource");
    const options = { signal: controller.signal };
    const fail = message => {
      if (current !== session || controller.signal.aborted) return;
      const tryAlternatives = tried && !session.ready;
      saveResume();
      session.ready = false;
      controller.abort();
      pcResetVideo();
      if (tryAlternatives) {
        const number = onlineLocalEpisodeNumber(episode, source, context.target.first);
        const alternatives = { sources: catalogue.sources.filter(line => !tried.has(line.id)) };
        let next;
        try { next = matchOnlineEpisode(alternatives, { ...context.target, number }); }
        catch { /* The available lines for this episode have been tried. */ }
        if (next) {
          tried.add(next.source.id);
          play(catalogue, next.source, next.episode, animeId, context, tried);
          return;
        }
      }
      pcSetPlaybackState("error", message, () => selectEpisode(episode.id));
    };
    pcSetTitle(catalogue.title, onlineEpisodeLabel(session), `${catalogue.ruleName} · ${source.name}`);
    $("#offlineSubtitleToggle").classList.add("hidden");
    $("#onlinePlayerOptions").classList.remove("hidden");
    $("#onlinePlayerOriginal").href = episode.url;
    $("#onlinePlayerRule").hidden = !context;
    selector.replaceChildren(...catalogue.sources.map(line => new Option(line.name, line.id)));
    selector.value = String(source.id);
    selector.hidden = catalogue.sources.length < 2;
    $("#offlinePlayerMeta").textContent = "";
    pcSetPlaybackState("loading", "正在连接视频…");
    pcRefreshEpisodes();
    openOfflinePlayerDialog();
    const provider = catalogue.rule === "xfdmnext" ? "xifan" : catalogue.rule;
    const danmakuNumber = onlineLocalEpisodeNumber(episode, source, context?.target.first);
    dmLoadFor({ id: 0, episode_key: `0:${danmakuNumber}` }, catalogue.title, animeId, `${provider}:${catalogue.id}:${episode.number || episode.id}`);
    const timer = setTimeout(() => fail("视频加载超时，可重试或切换规则。"), 45000);
    controller.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
    try {
      const result = await request("play", { rule: catalogue.rule, anime: catalogue.id, source: source.id, episode: episode.id }, controller.signal);
      if (controller.signal.aborted) return;
      video.addEventListener("canplay", () => {
        if (!video.videoWidth) return;
        clearTimeout(timer);
        session.ready = true;
      }, options);
      video.addEventListener("playing", () => {
        if (!video.videoWidth) return;
        window.playbackHistory?.record({
          kind: "online", animeId, animeTitle: catalogue.title, episode: onlineEpisodeLabel(session),
          rule: catalogue.rule, providerId: catalogue.id, sourceId: source.id, episodeId: episode.id,
        });
      }, { ...options, once: true });
      video.addEventListener("error", () => fail("视频读取中断，可重试或切换线路。"), options);
      await loadMedia(result, session, fail);
    } catch (error) {
      if (error.name !== "NotAllowedError") fail(errorMessage(error, "连接视频超时，可重试。"));
    }
  }

  async function open(url, animeId = 0) {
    abortLookup();
    const controller = new AbortController();
    lookup = controller;
    const status = $("#onlinePlaybackStatus");
    const button = $("#onlinePlaybackSubmit");
    status.textContent = "正在读取选集…";
    button.disabled = true;
    try {
      if (!isOnlinePlaybackLink(url)) throw new Error("请输入稀饭动漫 Next 的番剧或单集链接。");
      const [, id, selected] = /^\/anime\/(\d+)(?:\/play\/(\d+))?/.exec(new URL(url).pathname);
      const catalogue = await request("catalogue", { rule: "xfdmnext", anime: id }, controller.signal);
      if (controller.signal.aborted) return;
      if (animeId && (!$("#progressModal").open || state.progressAnime?.id !== animeId)) return;
      const source = catalogue.sources.find(line => line.episodes.some(item => String(item.id) === selected))
        || catalogue.sources[0];
      const episode = source.episodes.find(item => String(item.id) === selected) || source.episodes[0];
      status.textContent = "";
      const anime = animeId ? state.progressAnime : null;
      const context = anime && onlineLocalEpisodeNumber(episode, source)
        ? { anime, target: mainPlaybackEpisode(anime, "", { providerEpisode: episode, source }) }
        : null;
      play(catalogue, source, episode, animeId, context);
    } catch (error) {
      if (controller.signal.aborted) return;
      const message = errorMessage(error, "读取选集超时，请重试。");
      status.textContent = message;
      if (!$("#onlinePlaybackDialog").open) toast(message, "error");
    } finally {
      if (lookup === controller) {
        lookup = null;
        button.disabled = false;
      }
    }
  }

  function normalizeTitle(value) {
    return value.normalize("NFKC").toLowerCase()
      .replace(/第([一二三四五六七八九十])(?=[季期部])/g, (_, digit) => "第" + ("一二三四五六七八九十".indexOf(digit) + 1))
      .replace(/第(\d+)[季期部]/g, "第$1季")
      .replace(/[\p{P}\p{Z}\s]/gu, "");
  }

  const sourceSearches = new Map();
  let sourceOpening;

  function clearSourceSearches() {
    sourceOpening?.abort();
    sourceOpening = null;
    for (const controller of sourceSearches.values()) controller.abort();
    sourceSearches.clear();
  }

  function renderInstalled({ autoPlay = false } = {}) {
    clearSourceSearches();
    const list = $("#onlinePlaybackResults");
    const status = $("#onlineRuleStatus");
    list.replaceChildren();
    status.textContent = installed.length ? `${installed.length} 个已安装来源` : "暂无已安装来源，请先下载规则。";
    const preferred = installed.find(rule => rule.id === defaultRule)
      || installed.find(rule => rule.id === lastRule)
      || installed.find(rule => rule.id === "xfdmnext") || installed[0];
    const sources = preferred ? [preferred, ...installed.filter(rule => rule !== preferred)] : [];
    for (const rule of sources) {
      const group = document.createElement("details");
      group.className = "online-source";
      const summary = document.createElement("summary");
      const title = document.createElement("strong");
      title.textContent = rule.name;
      const hint = document.createElement("span");
      hint.textContent = "待检索";
      hint.className = "online-source-status";
      hint.setAttribute("role", "status");
      summary.append(title, hint);

      const form = document.createElement("form");
      form.className = "online-source-search";
      const input = document.createElement("input");
      input.type = "search";
      input.setAttribute("aria-label", `${rule.name}的检索词`);
      const titles = [...new Set([selection?.anime.name_cn, selection?.anime.display_name, selection?.anime.name].filter(Boolean))];
      input.value = titles[0] || "";
      input.required = true;
      const search = document.createElement("button");
      search.type = "submit";
      search.className = "secondary-button compact-button";
      search.textContent = "检索";
      form.append(input, search);
      const results = document.createElement("div");
      results.className = "online-source-results";
      const feedback = document.createElement("p");
      feedback.className = "online-source-feedback";
      feedback.setAttribute("role", "status");
      group.append(summary, form, feedback, results);
      list.append(group);

      const searchSource = (queries, auto) => searchRule(rule.id, queries, { hint, feedback, results, auto });
      let searched = false;
      group.addEventListener("toggle", () => {
        if (group.open && !searched) {
          searched = true;
          searchSource(titles, false);
        }
      });
      form.addEventListener("submit", event => {
        event.preventDefault();
        const query = input.value.trim();
        if (query) searchSource(query === titles[0] ? titles : [query], false);
      });
      if (autoPlay && defaultRule !== "manual" && rule === preferred) {
        searched = true;
        group.open = true;
        searchSource(titles, true);
      }
    }
  }

  let ruleCatalogue = [];
  let ruleFilter = "installed";

  function applyRuleList(result, remote = false) {
    installed = result.items.filter(rule => rule.installed);
    defaultRule = result.default_rule || "";
    if (remote) {
      ruleCatalogue = result.items;
    } else {
      const local = new Map(installed.map(rule => [rule.id, rule]));
      ruleCatalogue = ruleCatalogue.flatMap(rule => {
        if (local.has(rule.id)) {
          const current = local.get(rule.id);
          local.delete(rule.id);
          return [{ ...current, available_version: rule.available_version, update: rule.update && rule.version === current.version }];
        }
        return rule.available_version ? [{ ...rule, installed: false, update: false, version: rule.available_version }] : [];
      }).concat([...local.values()]);
    }
    const select = $("#onlineDefaultRule");
    select.replaceChildren(
      new Option("自动（上次使用的片源优先）", ""),
      new Option("每次手动选择", "manual"),
      ...installed.map(rule => new Option(rule.name, rule.id)),
    );
    select.value = defaultRule;
    select.disabled = false;
    renderRuleCatalogue();
  }

  async function refreshRuleCatalogue({ fresh = false, remote = false } = {}) {
    if (checkingRules || managing) return;
    checkingRules = true;
    const check = $("#onlineRuleCheckUpdates");
    const status = $("#onlineRuleManagerStatus");
    check.disabled = true;
    if (fresh) {
      ruleFilter = "installed";
      $("#onlineRuleFilter").value = "";
      renderRuleCatalogue();
    }
    try {
      if (!remote && !fresh) {
        status.textContent = "";
        applyRuleList(await request("rules", {}));
        return;
      }
      status.hidden = false;
      status.textContent = "正在读取 KazumiRules…";
      const result = await request("rules", fresh ? { remote: "1", refresh: "1" } : { remote: "1" });
      applyRuleList(result, true);
      const count = result.items.filter(rule => rule.update).length;
      status.textContent = count ? `${count} 条规则可更新` : fresh ? "暂无可用更新" : "";
    } catch (error) {
      status.hidden = false;
      status.textContent = error.message;
    } finally {
      checkingRules = false;
      check.disabled = false;
    }
  }

  function renderRuleCatalogue() {
    const list = $("#onlineRuleCatalogue");
    const query = $("#onlineRuleFilter").value.trim().toLowerCase();
    const rules = ruleCatalogue.filter(rule =>
      Boolean(rule.installed) === (ruleFilter === "installed")
      && `${rule.name} ${rule.host || ""}`.toLowerCase().includes(query));
    for (const button of $$("[data-rule-filter]")) {
      button.setAttribute("aria-pressed", String(button.dataset.ruleFilter === ruleFilter));
    }
    if (!rules.length) {
      list.textContent = query ? "没有匹配的规则。" : ruleFilter === "installed"
        ? "还没有安装规则。可新增自定义规则，或从规则仓库下载。" : "暂无可下载规则。";
      return;
    }
    list.replaceChildren(...rules.map(rule => {
      const row = document.createElement("div");
      row.className = "online-rule-row";
      const copy = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = rule.name;
      const meta = document.createElement("small");
      const version = rule.update ? `${rule.version} → ${rule.available_version}` : rule.version;
      meta.textContent = [rule.id === defaultRule && "默认", rule.custom ? "自定义" : rule.installed && "已安装", rule.host, version].filter(Boolean).join(" · ");
      copy.append(title, meta);
      const buttons = document.createElement("div");
      buttons.className = "online-rule-actions";
      const actions = rule.installed ? [["重命名", "rename"], ["移除", "remove"]] : [["下载", "install"]];
      if (rule.custom) actions.unshift(["编辑规则", "edit"]);
      if (rule.update) actions.unshift(["更新", "update"]);
      for (const [label, action] of actions) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "secondary-button compact-button";
        button.textContent = label;
        button.addEventListener("click", () => ["rename", "edit"].includes(action)
          ? openRuleEditor(action, rule) : manageRule({ id: rule.id, action }, button));
        buttons.append(button);
      }
      row.append(copy, buttons);
      return row;
    }));
  }

  async function manageRule(payload, button, errorBox = $("#onlineRuleManagerStatus")) {
    if (managing || checkingRules) return false;
    managing = true;
    button.disabled = true;
    $("#onlineRuleCheckUpdates").disabled = true;
    errorBox.hidden = true;
    try {
      const result = await api("/api/playback/rules", {
        method: "POST", body: JSON.stringify(payload), timeoutMs: 24000,
      });
      applyRuleList(result);
      if ($("#onlinePlaybackPicker").open) renderInstalled();
      return true;
    } catch (error) {
      errorBox.textContent = error.message;
      errorBox.hidden = false;
      return false;
    } finally {
      button.disabled = false;
      managing = false;
      $("#onlineRuleCheckUpdates").disabled = false;
    }
  }

  let editingRule;
  async function openRuleEditor(action, rule = {}) {
    if (managing || checkingRules || $("#onlineRuleEditor").open) return;
    const editor = $("#onlineRuleEditor");
    const custom = action !== "rename";
    const field = $("#onlineRuleConfig");
    try {
      const config = action === "edit" ? (await request("custom-rule", { id: rule.id })).config : null;
      if (editor.open) return;
      editingRule = { id: rule.id, action };
      $("#onlineRuleEditorTitle").textContent = { create: "新增自定义规则", edit: "编辑自定义规则", rename: "重命名规则" }[action];
      $("#onlineRuleCustomFields").hidden = !custom;
      $("#onlineRuleName").parentElement.querySelector('label[for="onlineRuleName"]').hidden = action === "edit";
      $("#onlineRuleName").hidden = action === "edit";
      $("#onlineRuleName").value = action === "rename" ? rule.name : "";
      $("#onlineRuleFile").value = "";
      field.value = config ? JSON.stringify(config, null, 2) : "";
      field.placeholder = '{"name":"片源名称","baseURL":"https://…","searchURL":"…","searchList":"…","searchName":"…","searchResult":"…","chapterRoads":"…","chapterResult":"…"}';
      field.required = custom;
      $("#onlineRuleEditorError").hidden = true;
      editor.showModal();
      (custom ? field : $("#onlineRuleName")).focus();
    } catch (error) {
      const status = $("#onlineRuleManagerStatus");
      status.textContent = error.message;
      status.hidden = false;
    }
  }

  async function searchRule(rule, titles, { hint, feedback, results, auto }) {
    if (!results.isConnected) return;
    const context = selection;
    const { anime, target } = context;
    const dialog = $("#onlinePlaybackPicker");
    const controller = new AbortController();
    const { signal } = controller;
    sourceSearches.get(rule)?.abort();
    sourceSearches.set(rule, controller);
    const isCurrent = () => !signal.aborted && dialog.open && selection === context && results.isConnected;
    hint.textContent = "检索中…";
    feedback.textContent = "";
    results.replaceChildren();
    let resultCount = 0;
    let latestForSource;

    async function playResult(item) {
      if (!isCurrent() || (auto && sourceOpening)) return;
      sourceOpening?.abort();
      const opening = new AbortController();
      sourceOpening = opening;
      latestForSource = opening;
      const openingSignal = AbortSignal.any([signal, opening.signal]);
      const reading = "正在读取选集…";
      feedback.textContent = "";
      hint.textContent = reading;
      try {
        const catalogue = await request("catalogue", { rule, anime: item.id }, openingSignal);
        if (!isCurrent() || openingSignal.aborted || $("#settingsModal").open) return;
        const { source, episode } = matchOnlineEpisode(catalogue, target);
        catalogue.title ||= anime.display_name || item.title;
        lastRule = rule;
        try { localStorage.setItem("handbook:online-rule", rule); }
        catch { /* Playback also works without storage. */ }
        dialog.close();
        play(catalogue, source, episode, anime.id, context, new Set([source.id]));
      } catch (error) {
        if (isCurrent() && !openingSignal.aborted) {
          hint.textContent = "无法播放";
          feedback.textContent = errorMessage(error, "读取选集超时");
        }
      } finally {
        if (sourceOpening === opening) sourceOpening = null;
        if (isCurrent() && latestForSource === opening && hint.textContent === reading) {
          hint.textContent = `${resultCount} 个结果`;
        }
      }
    }

    try {
      const matches = new Map();
      const names = new Set(titles.map(normalizeTitle));
      const isExact = item => [item.title, item.original].some(name => name && names.has(normalizeTitle(name)));
      for (const title of titles) {
        const result = await request("search", { rule, title }, signal);
        if (!isCurrent()) return;
        for (const item of result.items) matches.set(item.id, item);
        if ([...matches.values()].filter(isExact).length === 1) break;
      }
      resultCount = matches.size;
      hint.textContent = matches.size ? `${matches.size} 个结果` : "无结果";
      for (const item of matches.values()) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = item.title;
        button.addEventListener("click", () => playResult(item), { signal });
        results.append(button);
      }
      const exact = [...matches.values()].filter(isExact);
      if (auto && exact.length === 1 && !$("#settingsModal").open) await playResult(exact[0]);
    } catch (error) {
      if (isCurrent()) {
        hint.textContent = "检索失败";
        feedback.textContent = errorMessage(error, "检索超时");
      }
    }
  }

  async function openAnime(anime, key, _button, { choose = false } = {}) {
    let target;
    try { target = mainPlaybackEpisode(anime, key); }
    catch (error) { toast(error.message, "error"); return; }
    abortLookup();
    clearSourceSearches();
    const context = { anime, target };
    selection = context;
    const dialog = $("#onlinePlaybackPicker");
    const status = $("#onlineRuleStatus");
    $("#onlineSourceAnime").textContent = `${anime.display_name || anime.name_cn || anime.name} · 第 ${target.number} 集`;
    $("#onlinePlaybackResults").replaceChildren();
    status.textContent = "正在读取已安装来源…";
    if (!dialog.open) dialog.showModal();
    try {
      const result = await request("rules", {});
      if (!dialog.open || selection !== context) return;
      installed = result.items;
      defaultRule = result.default_rule || "";
      renderInstalled({ autoPlay: !choose });
    } catch (error) {
      if (dialog.open && selection === context) status.textContent = error.message;
    }
  }

  async function resume(entry) {
    const rule = entry.rule || "xfdmnext";
    const catalogue = await request("catalogue", { rule, anime: entry.providerId });
    const source = catalogue.sources.find(line => line.id === entry.sourceId && line.episodes.some(item => item.id === entry.episodeId))
      || catalogue.sources.find(line => line.episodes.some(item => item.id === entry.episodeId));
    const episode = source?.episodes.find(item => item.id === entry.episodeId);
    if (!episode) throw new Error("这集已不在原片源，请从番剧详情重新搜索。");
    if (!$("#jumpHistoryModal").open) return;
    catalogue.title ||= entry.animeTitle;
    const anime = state.animes.find(item => item.id === entry.animeId);
    const context = anime && onlineLocalEpisodeNumber(episode, source)
      ? { anime, target: mainPlaybackEpisode(anime, "", { providerEpisode: episode, source }) }
      : null;
    return play(catalogue, source, episode, entry.animeId, context);
  }

  function show(url = "") {
    const dialog = $("#onlinePlaybackDialog");
    if (dialog.open) return;
    $("#onlinePlaybackUrl").value = url;
    $("#onlinePlaybackStatus").textContent = "";
    dialog.showModal();
  }

  document.addEventListener("DOMContentLoaded", () => {
    if (window.handbookOnline) return;
    $("#detailOnlinePlay")?.classList.remove("hidden");
    $("#detailOnlinePlay")?.addEventListener("click", event => {
      playDetailEpisode("", event.currentTarget);
    });
    $("#closeOnlinePlaybackPicker")?.addEventListener("click", () => $("#onlinePlaybackPicker").close());
    $("#onlinePlaybackPicker").addEventListener("close", () => {
      if (!$("#onlinePlaybackPicker").open) clearSourceSearches();
    });
    const ruleEditor = $("#onlineRuleEditor");
    $("#onlineRuleAddCustom").addEventListener("click", () => openRuleEditor("create"));
    $("#onlineRuleEditorCancel").addEventListener("click", () => { if (!managing) ruleEditor.close(); });
    ruleEditor.addEventListener("cancel", event => { if (managing) event.preventDefault(); });
    $("#onlineRuleFile").addEventListener("change", async event => {
      const file = event.target.files[0];
      if (!file) return;
      const errorBox = $("#onlineRuleEditorError");
      try {
        if (file.size > 128 * 1024) throw new Error("规则 JSON 不能超过 128 KB");
        $("#onlineRuleConfig").value = await file.text();
        errorBox.hidden = true;
      } catch (error) {
        errorBox.textContent = error.message;
        errorBox.hidden = false;
      }
    });
    ruleEditor.querySelector("form").addEventListener("submit", async event => {
      event.preventDefault();
      if (await manageRule({
        ...editingRule, name: $("#onlineRuleName").value,
        ...(editingRule.action !== "rename" && { config: $("#onlineRuleConfig").value }),
      }, event.submitter, $("#onlineRuleEditorError"))) ruleEditor.close();
    });
    $("#onlineDefaultRule").addEventListener("change", async event => {
      const select = event.target;
      if (!await manageRule({ id: select.value, action: "default" }, select)) select.value = defaultRule;
    });
    $("#onlineRuleFilter").addEventListener("input", renderRuleCatalogue);
    for (const button of $$("[data-rule-filter]")) {
      button.addEventListener("click", () => {
        ruleFilter = button.dataset.ruleFilter;
        renderRuleCatalogue();
        if (ruleFilter === "catalogue") refreshRuleCatalogue({ remote: true });
      });
    }
    $("#openPlaybackRuleSettings").addEventListener("click", () => openHandbookSettings("playback", "#playbackRulesHeading"));
    $("#managePlayerRules").addEventListener("click", async () => {
      if (document.fullscreenElement) await document.exitFullscreen();
      openHandbookSettings("playback", "#playbackRulesHeading");
    });
    $("#onlineRuleCheckUpdates").addEventListener("click", () => refreshRuleCatalogue({ fresh: true }));
    $("#onlinePlayerRule").addEventListener("click", () => {
      const context = current?.context;
      if (!context) return;
      const episodeNumber = onlineLocalEpisodeNumber(current.episode, current.source, context.target.first)
        || context.target.number;
      closeOfflinePlayer();
      openAnime(context.anime, `0:${episodeNumber}`, null, { choose: true });
    });
    $("#onlinePlaybackForm").addEventListener("submit", event => {
      event.preventDefault();
      open($("#onlinePlaybackUrl").value.trim());
    });
    $("#onlinePlaybackSample").addEventListener("click", () => {
      $("#onlinePlaybackUrl").value = XIFAN_SAMPLE;
      open(XIFAN_SAMPLE);
    });
    $("#onlinePlaybackClose").addEventListener("click", () => $("#onlinePlaybackDialog").close());
    $("#onlinePlaybackDialog").addEventListener("close", () => {
      if (current || $("#onlinePlaybackDialog").open) return;
      abortLookup();
      $("#onlinePlaybackSubmit").disabled = false;
    });
    $("#onlinePlayerSource").addEventListener("change", event => {
      if (!current) return;
      const { catalogue, episode, animeId } = current;
      const source = catalogue.sources.find(line => line.id === Number(event.target.value));
      if (!source) return;
      const first = current.context?.target.first || 1;
      const number = onlineLocalEpisodeNumber(episode, current.source, first);
      const wanted = onlineLineStartsAtOne(source) ? number - first + 1 : number;
      const match = episode.number && source.episodes.find(item => Number(item.number) === wanted);
      if (match) play(catalogue, source, match, animeId);
      else {
        event.target.value = String(current.source.id);
        toast("这条线路没有当前这一集。", "error");
      }
    });
    const video = $("#offlineVideo");
    ["pause", "ended"].forEach(type => video.addEventListener(type, saveResume));
    let lastSaved = 0;
    video.addEventListener("timeupdate", () => {
      if (!current?.ready || Date.now() - lastSaved < 5000) return;
      lastSaved = Date.now();
      saveResume();
    });
    window.addEventListener("pagehide", saveResume);
    const url = new URL(location.href);
    if (url.searchParams.has("xifan")) {
      show(url.searchParams.get("xifan") || XIFAN_SAMPLE);
      url.searchParams.delete("xifan");
      history.replaceState(history.state, "", url);
    }
  });

  return {
    get current() { return current; },
    open, openAnime, resume, close, selectEpisode,
    loadRuleCatalogue() {
      if (!managing) return refreshRuleCatalogue();
    },
  };
})();
