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

  function show(url = "") {
    const dialog = $("#onlinePlaybackDialog");
    if (dialog.open) return;
    $("#onlinePlaybackUrl").value = url;
    $("#onlinePlaybackStatus").textContent = "";
    dialog.showModal();
  }

  document.addEventListener("DOMContentLoaded", () => {
    if (window.handbookOnline) {
      $("#openOnlinePlayback")?.classList.add("hidden");
      return;
    }
    $("#openOnlinePlayback")?.addEventListener("click", () => show());
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
      play(catalogue, source, match || source.episodes[0], animeId);
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

  return { get current() { return current; }, open, close, selectEpisode };
})();
