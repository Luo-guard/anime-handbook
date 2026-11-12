const XIFAN_SITE = "https://next.xifanacg.com";
const XIFAN_SAMPLE = XIFAN_SITE + "/anime/3435/play/203809";

function isOnlinePlaybackLink(value) {
  try {
    const url = new URL(value);
    return url.origin === XIFAN_SITE && !url.username && !url.password
      && /^\/anime\/[1-9]\d{0,8}(?:\/play\/[1-9]\d{0,8})?\/?$/.test(url.pathname);
  } catch { return false; }
}

function onlineEpisodeLabel(episode) {
  return [episode.number ? `第 ${episode.number} 集` : "", episode.title].filter(Boolean).join(" · ") || "播放";
}

function mainPlaybackEpisode(anime, key) {
  const episodes = (anime.episodes || []).filter(episode => Number(episode.type || 0) === 0);
  const numberOf = value => Number(/^0:(\d+)$/.exec(episodeStorageKey(value, anime))?.[1]) || 0;
  const numbers = episodes.map(episode => numberOf(episode.key)).filter(Boolean);
  const first = numbers.length ? Math.min(...numbers) : 1;
  const watched = anime.watched_episode_keys || anime.watched_episodes || [];
  const number = key ? numberOf(key) : Math.max(first - 1, ...watched.map(numberOf)) + 1;
  if (!number) throw new Error("该播放源暂只支持正片集数。");
  const total = Number(anime.episode_count) || numbers.length;
  if (!key && total > 0 && number >= first + total)
    throw new Error("已看完手账目前收录的正片，可从单集菜单重播。");
  return { number, first };
}

function onlineLineStartsAtOne(source) {
  const numbers = source.episodes.map(episode => Number(episode.number)).filter(number => Number.isInteger(number) && number > 0);
  return Math.min(...numbers) === 1;
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
  let hlsLibrary;
  let managing = false;

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
    const episode = source.episodes.find(item => item.id === id);
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
    const status = $("#offlinePlayerMeta");
    const retry = $("#onlinePlayerRetry");
    const selector = $("#onlinePlayerSource");
    const options = { signal: controller.signal };
    const setStatus = (message, failed = false) => {
      status.textContent = message;
      retry.hidden = !failed;
    };
    const fail = message => {
      if (current !== session || controller.signal.aborted) return;
      const tryAlternatives = tried && !session.ready;
      saveResume();
      session.ready = false;
      controller.abort();
      pcResetVideo();
      if (tryAlternatives) {
        const number = Number(episode.number) + (onlineLineStartsAtOne(source) ? context.target.first - 1 : 0);
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
      setStatus(message, true);
    };
    pcSetTitle(catalogue.title, onlineEpisodeLabel(episode), `${catalogue.ruleName} · ${source.name}`);
    $("#offlineSubtitleToggle").classList.add("hidden");
    $("#onlinePlayerOptions").classList.remove("hidden");
    $("#onlinePlayerOriginal").href = episode.url;
    $("#onlinePlayerRule").hidden = !context;
    selector.replaceChildren(...catalogue.sources.map(line => new Option(line.name, line.id)));
    selector.value = String(source.id);
    selector.hidden = catalogue.sources.length < 2;
    setStatus("正在连接视频…");
    pcRefreshEpisodes();
    openOfflinePlayerDialog();
    const provider = catalogue.rule === "xfdmnext" ? "xifan" : catalogue.rule;
    dmLoadFor({ id: 0, episode_key: `0:${episode.number}` }, catalogue.title, animeId, `${provider}:${catalogue.id}:${episode.number || episode.id}`);
    const timer = setTimeout(() => fail("视频加载超时，可重试或切换规则。"), 45000);
    controller.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
    try {
      const result = await request("play", { rule: catalogue.rule, anime: catalogue.id, source: source.id, episode: episode.id }, controller.signal);
      if (controller.signal.aborted) return;
      video.addEventListener("canplay", () => {
        if (!video.videoWidth) return;
        clearTimeout(timer);
        session.ready = true;
        setStatus("");
      }, options);
      video.addEventListener("playing", () => {
        if (!video.videoWidth) return;
        window.playbackHistory?.record({
          kind: "online", animeId, animeTitle: catalogue.title, episode: onlineEpisodeLabel(episode),
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
      play(catalogue, source, episode, animeId);
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

  function renderInstalled(preferred = lastRule || "xfdmnext") {
    const selector = $("#onlinePlaybackRule");
    selector.replaceChildren(...installed.map(rule => new Option(rule.name, rule.id)));
    if (!installed.length) selector.append(new Option("尚未下载规则", ""));
    if (installed.some(rule => rule.id === preferred)) selector.value = preferred;
    selector.disabled = !installed.length;
    $("#onlinePlaybackSearch").disabled = !installed.length;
  }

  async function refreshRuleCatalogue() {
    const status = $("#onlineRuleManagerStatus");
    const list = $("#onlineRuleCatalogue");
    status.textContent = "正在读取 KazumiRules…";
    let rules;
    try {
      rules = (await request("rules", { remote: "1" })).items;
      status.textContent = "";
    } catch (error) {
      rules = installed;
      status.textContent = error.message;
    }
    list.replaceChildren(...rules.map(rule => {
      const row = document.createElement("div");
      row.className = "online-rule-row";
      const copy = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = rule.name;
      const meta = document.createElement("small");
      meta.textContent = [rule.host, rule.version].filter(Boolean).join(" · ");
      copy.append(title, meta);
      const buttons = document.createElement("div");
      buttons.className = "online-rule-actions";
      const actions = rule.installed ? [["移除", "remove"]] : [["下载", "install"]];
      if (rule.update) actions.unshift(["更新", "install"]);
      for (const [label, action] of actions) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "secondary-button compact-button";
        button.textContent = label;
        button.addEventListener("click", () => manageRule(rule, action, button));
        buttons.append(button);
      }
      row.append(copy, buttons);
      return row;
    }));
  }

  async function manageRule(rule, action, button) {
    if (managing) return;
    managing = true;
    button.disabled = true;
    const status = $("#onlineRuleManagerStatus");
    try {
      const result = await api("/api/playback/rules", {
        method: "POST", body: JSON.stringify({ id: rule.id, action }), timeoutMs: 24000,
      });
      installed = result.items;
      renderInstalled(action === "install" ? rule.id : lastRule);
      if (action === "remove" && selection) {
        abortLookup();
        $("#onlinePlaybackResults").replaceChildren();
      }
      $("#onlineRuleStatus").textContent = installed.length ? "" : "先下载一个规则，再搜索片源。";
      await refreshRuleCatalogue();
    } catch (error) {
      status.textContent = error.message;
    } finally {
      button.disabled = false;
      managing = false;
    }
  }

  async function searchSelectedRule() {
    const context = selection;
    const rule = $("#onlinePlaybackRule").value;
    if (!context || !rule) return;
    const { anime, target } = context;
    abortLookup();
    const controller = new AbortController();
    lookup = controller;
    const { signal } = controller;
    const dialog = $("#onlinePlaybackPicker");
    const picker = $("#onlinePlaybackResults");
    const status = $("#onlineRuleStatus");
    const searchButton = $("#onlinePlaybackSearch");
    searchButton.disabled = true;
    picker.replaceChildren();
    status.textContent = "正在搜索片源…";
    const stillOpen = () => !signal.aborted && dialog.open && selection === context;
    const playResult = async item => {
      status.textContent = "正在读取选集…";
      const catalogue = await request("catalogue", { rule, anime: item.id }, signal);
      if (!stillOpen()) return;
      const { source, episode } = matchOnlineEpisode(catalogue, target);
      catalogue.title ||= anime.display_name || item.title;
      lastRule = rule;
      try { localStorage.setItem("handbook:online-rule", rule); }
      catch { /* Private browsing can deny storage. */ }
      lookup = null;
      dialog.close();
      play(catalogue, source, episode, anime.id, context, new Set([source.id]));
    };
    try {
      const titles = [...new Set([anime.name_cn, anime.display_name, anime.name].filter(Boolean))];
      const names = new Set(titles.map(normalizeTitle));
      const matches = new Map();
      for (const title of titles) {
        const result = await request("search", { rule, title }, signal);
        if (!stillOpen()) return;
        for (const item of result.items) matches.set(item.id, item);
        const exact = [...matches.values()].filter(item => [item.title, item.original].some(name => name && names.has(normalizeTitle(name))));
        if (exact.length === 1) return await playResult(exact[0]);
      }
      if (!matches.size) throw new Error("所选规则没有搜到这部番，可切换规则重试。");
      status.textContent = "请选择对应的番剧。";
      picker.replaceChildren(...[...matches.values()].map(item => {
        const option = document.createElement("button");
        option.type = "button";
        option.className = "secondary-button";
        option.textContent = item.title;
        option.addEventListener("click", async () => {
          if (!stillOpen()) return;
          option.disabled = true;
          try { await playResult(item); }
          catch (error) { if (stillOpen()) status.textContent = error.message; }
          finally { option.disabled = false; }
        });
        return option;
      }));
    } catch (error) {
      if (stillOpen()) status.textContent = errorMessage(error, "搜索片源超时，请重试。");
    } finally {
      if (selection === context && (!lookup || lookup === controller)) searchButton.disabled = !installed.length;
    }
  }

  async function openAnime(anime, key, _button, { choose = false } = {}) {
    let target;
    try { target = mainPlaybackEpisode(anime, key); }
    catch (error) { toast(error.message, "error"); return; }
    abortLookup();
    const context = { anime, target };
    selection = context;
    const dialog = $("#onlinePlaybackPicker");
    const status = $("#onlineRuleStatus");
    $("#onlinePlaybackPickerTitle").textContent = `在线播放 · 第 ${target.number} 集`;
    $("#onlinePlaybackResults").replaceChildren();
    $("#onlineRuleManager").open = false;
    renderInstalled();
    status.textContent = "正在读取已下载规则…";
    if (!dialog.open) dialog.showModal();
    try {
      const result = await request("rules", {});
      if (!dialog.open || selection !== context) return;
      installed = result.items;
      renderInstalled();
      status.textContent = installed.length ? "" : "先下载一个规则，再搜索片源。";
      if (!installed.length) $("#onlineRuleManager").open = true;
      else if (!choose) await searchSelectedRule();
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
    const context = anime && Number(episode.number) ? { anime, target: mainPlaybackEpisode(anime, `0:${episode.number}`) } : null;
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
      if (!$("#onlinePlaybackPicker").open && lookup) abortLookup();
    });
    $("#onlinePlaybackSearch").addEventListener("click", searchSelectedRule);
    $("#onlinePlaybackRule").addEventListener("change", searchSelectedRule);
    $("#onlineRuleManager").addEventListener("toggle", event => {
      if (event.currentTarget.open) refreshRuleCatalogue();
    });
    $("#onlinePlayerRule").addEventListener("click", () => {
      const context = current?.context;
      if (!context) return;
      const number = Number(current.episode.number);
      const episodeNumber = number
        ? number + (onlineLineStartsAtOne(current.source) ? context.target.first - 1 : 0)
        : context.target.number;
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
    $("#onlinePlayerRetry").addEventListener("click", () => selectEpisode(current?.episode.id));
    $("#onlinePlayerSource").addEventListener("change", event => {
      if (!current) return;
      const { catalogue, episode, animeId } = current;
      const source = catalogue.sources.find(line => line.id === Number(event.target.value));
      if (!source) return;
      const first = current.context?.target.first || 1;
      const number = Number(episode.number) + (onlineLineStartsAtOne(current.source) ? first - 1 : 0);
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

  return { get current() { return current; }, open, openAnime, resume, close, selectEpisode };
})();
