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

function matchOnlineEpisode(catalogue, target) {
  for (const source of catalogue.sources) {
    const numbers = source.episodes.map(episode => Number(episode.number)).filter(number => Number.isInteger(number) && number > 0);
    const start = Math.min(...numbers);
    const wanted = start === 1 ? target.number - target.first + 1 : target.number;
    const episode = source.episodes.find(item => Number(item.number) === wanted);
    if (episode) return { source, episode };
  }
  throw new Error(`稀饭暂无第 ${target.number} 集的可用线路。`);
}

window.onlinePlayback = (() => {
  let current = null;
  let lookup = null;

  function abortLookup() {
    lookup?.abort();
    lookup = null;
  }

  function resumeKey(session) {
    return `handbook:xifan:progress:${session.episode.id}`;
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
    return api("/api/preview/xifan/" + route + "?" + new URLSearchParams(query), { signal, timeoutMs: 24000 });
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

  async function play(catalogue, source, episode, animeId) {
    if (offlineView.playing) closeOfflinePlayer();
    saveResume();
    current?.controller.abort();
    pcResetVideo();
    clearSubtitleSession();
    const controller = new AbortController();
    const session = { catalogue, source, episode, animeId, controller, ready: false };
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
      saveResume();
      session.ready = false;
      controller.abort();
      pcResetVideo();
      setStatus(message, true);
    };
    pcSetTitle(catalogue.title, onlineEpisodeLabel(episode), `稀饭动漫 Next · ${source.name}`);
    $("#offlineSubtitleToggle").classList.add("hidden");
    $("#onlinePlayerOptions").classList.remove("hidden");
    $("#onlinePlayerOriginal").href = `${XIFAN_SITE}/anime/${catalogue.id}/play/${episode.id}`;
    selector.replaceChildren(...catalogue.sources.map(line => new Option(line.name, line.id)));
    selector.value = String(source.id);
    selector.hidden = catalogue.sources.length < 2;
    setStatus("正在连接视频…");
    pcRefreshEpisodes();
    openOfflinePlayerDialog();
    dmLoadFor({ id: 0, episode_key: `0:${episode.number}` }, catalogue.title, animeId, `xifan:${catalogue.id}:${episode.number || episode.id}`);
    const timer = setTimeout(() => fail("视频加载超时，可重试或打开原网页。"), 30000);
    controller.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
    try {
      const result = await request("play", { anime: catalogue.id, source: source.id, episode: episode.id }, controller.signal);
      if (controller.signal.aborted) return;
      video.addEventListener("canplay", () => {
        clearTimeout(timer);
        session.ready = true;
        setStatus("");
      }, { ...options, once: true });
      video.addEventListener("playing", () => {
        window.playbackHistory?.record({
          kind: "online", animeId, animeTitle: catalogue.title, episode: onlineEpisodeLabel(episode),
          providerId: catalogue.id, sourceId: source.id, episodeId: episode.id,
        });
      }, { ...options, once: true });
      video.addEventListener("error", () => fail("视频读取中断，可重试或切换线路。"), options);
      await pcLoadVideo(result.url, readResume(session));
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
      const catalogue = await request("catalogue", { url }, controller.signal);
      if (controller.signal.aborted) return;
      if (animeId && (!$("#progressModal").open || state.progressAnime?.id !== animeId)) return;
      const source = catalogue.sources.find(line => line.episodes.some(item => item.id === catalogue.selected))
        || catalogue.sources[0];
      const episode = source.episodes.find(item => item.id === catalogue.selected) || source.episodes[0];
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

  async function openAnime(anime, key, button) {
    abortLookup();
    const controller = new AbortController();
    lookup = controller;
    const original = button?.textContent;
    if (button) { button.disabled = true; button.textContent = "正在找片源…"; }
    const { signal } = controller;
    const stillOpen = () => !signal.aborted && $("#progressModal").open && state.progressAnime?.id === anime.id;
    const playResult = async item => {
      const catalogue = await request("catalogue", { url: XIFAN_SITE + "/anime/" + item.id }, signal);
      if (!stillOpen()) return;
      const { source, episode } = matchOnlineEpisode(catalogue, target);
      play(catalogue, source, episode, anime.id);
    };
    let target;
    try {
      target = mainPlaybackEpisode(anime, key);
      const titles = [...new Set([anime.name, anime.name_cn, anime.display_name].filter(Boolean))];
      const names = new Set(titles.map(normalizeTitle));
      const matches = new Map();
      for (const title of titles) {
        const result = await request("search", { title }, signal);
        if (!stillOpen()) return;
        for (const item of result.items) matches.set(item.id, item);
        const exact = [...matches.values()].filter(item => [item.title, item.original].some(name => name && names.has(normalizeTitle(name))));
        if (exact.length === 1) return await playResult(exact[0]);
      }
      if (!matches.size) throw new Error("稀饭没有搜到这部番。");
      const picker = $("#onlinePlaybackResults");
      picker.replaceChildren(...[...matches.values()].map(item => {
        const option = document.createElement("button");
        option.type = "button";
        option.className = "secondary-button";
        option.textContent = item.title;
        option.addEventListener("click", async () => {
          if (!stillOpen()) return;
          picker.closest("dialog").close();
          try { await playResult(item); }
          catch (error) { if (!signal.aborted) toast(error.message, "error"); }
        }, { once: true });
        return option;
      }));
      picker.closest("dialog").showModal();
    } catch (error) {
      if (stillOpen()) toast(errorMessage(error, "搜索片源超时，请重试。"), "error");
    } finally {
      if (button) { button.disabled = false; button.textContent = original; }
    }
  }

  async function resume(entry) {
    const catalogue = await request("catalogue", { url: `${XIFAN_SITE}/anime/${entry.providerId}/play/${entry.episodeId}` });
    const source = catalogue.sources.find(line => line.id === entry.sourceId && line.episodes.some(item => item.id === entry.episodeId))
      || catalogue.sources.find(line => line.episodes.some(item => item.id === entry.episodeId));
    const episode = source?.episodes.find(item => item.id === entry.episodeId);
    if (!episode) throw new Error("这集已不在原片源，请从番剧详情重新搜索。");
    if (!$("#jumpHistoryModal").open) return;
    return play(catalogue, source, episode, entry.animeId);
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
      const match = episode.number && source.episodes.find(item => item.number === episode.number);
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
