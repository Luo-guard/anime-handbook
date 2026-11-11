(() => {
  const $ = id => document.getElementById(id);
  const SITE = "https://next.xifanacg.com";
  const SAMPLE = SITE + "/anime/3435/play/203809";
  const video = $("video");
  const playButton = $("play");
  const state = { catalogue: null, source: null, index: 0, playback: null, lookup: null, timer: null };
  let lastSavedAt = 0;

  async function api(route, query, signal) {
    const response = await fetch("/api/preview/xifan/" + route + "?" + new URLSearchParams(query), { signal });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || "连接失败，请稍后重试");
    return result;
  }

  function storage(key, value) {
    try {
      if (value !== undefined) localStorage.setItem(key, value);
      return Number(localStorage.getItem(key)) || 0;
    } catch { return 0; }
  }

  function saveProgress(force = false) {
    const current = state.playback;
    if (!current?.ready || (!force && Date.now() - lastSavedAt < 5000) || video.currentTime < 2) return;
    storage(current.key, video.ended ? 0 : video.currentTime);
    lastSavedAt = Date.now();
  }

  function resetVideo() {
    saveProgress(true);
    state.playback?.controller.abort();
    state.playback = null;
    clearTimeout(state.timer);
    video.pause();
    video.removeAttribute("src");
    video.load();
    video.hidden = true;
  }

  function showStatus(text, canPlay = true, label = "播放当前集") {
    $("screen-state").hidden = false;
    $("status").textContent = text;
    playButton.disabled = !canPlay;
    playButton.setAttribute("aria-label", label);
    playButton.textContent = label === "重试播放" ? "↻" : "▶";
  }

  function updateSelection() {
    const episode = state.source.episodes[state.index];
    $("episode-title").textContent = [episode.number ? "第 " + episode.number + " 集" : "", episode.title]
      .filter(Boolean).join("　");
    $("original").href = SITE + "/anime/" + state.catalogue.id + "/play/" + episode.id;
    $("previous").disabled = state.index === 0;
    $("next").disabled = state.index === state.source.episodes.length - 1;
    for (const button of $("episodes").children) button.setAttribute("aria-current", String(Number(button.dataset.index) === state.index));
  }

  function renderEpisodes() {
    const fragment = document.createDocumentFragment();
    const showTitles = state.source.episodes.length <= 16;
    state.source.episodes.forEach((episode, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "episode";
      button.dataset.index = String(index);
      const number = document.createElement("span");
      number.className = "episode-number";
      number.textContent = episode.number || String(index + 1);
      button.append(number);
      if (showTitles) {
        const title = document.createElement("span");
        title.className = "episode-name";
        title.textContent = episode.title;
        button.append(title);
      }
      button.title = episode.title || "第 " + (episode.number || index + 1) + " 集";
      button.setAttribute("aria-label", "第 " + (episode.number || index + 1) + " 集 " + episode.title);
      fragment.append(button);
    });
    $("episodes").classList.toggle("episodes-with-titles", showTitles);
    $("episodes").replaceChildren(fragment);
    $("count").textContent = state.source.episodes.length + " 集";
    updateSelection();
  }

  async function loadCatalogue(url) {
    state.lookup?.abort();
    const controller = new AbortController();
    state.lookup = controller;
    $("link-status").textContent = "正在读取选集…";
    try {
      const result = await api("catalogue", { url }, AbortSignal.any([controller.signal, AbortSignal.timeout(24000)]));
      if (state.lookup !== controller) return;
      resetVideo();
      state.catalogue = result;
      state.source = result.sources.find(source => source.episodes.some(episode => episode.id === result.selected)) || result.sources[0];
      state.index = Math.max(0, state.source.episodes.findIndex(episode => episode.id === result.selected));
      $("title").textContent = result.title;
      const selector = $("source");
      selector.replaceChildren(...result.sources.map(source => new Option(source.name, source.id)));
      selector.value = String(state.source.id);
      selector.hidden = result.sources.length < 2;
      renderEpisodes();
      showStatus("点击播放，或选择一集");
      $("link-status").textContent = result.selected && !state.source.episodes.some(episode => episode.id === result.selected)
        ? "这个链接指向的集数已不在选集里，已定位到第一集。" : "";
    } catch (error) {
      if (controller.signal.aborted) return;
      $("link-status").textContent = error.name === "TimeoutError" ? "读取选集超时，请重试" : error.message;
      if (!state.catalogue) showStatus("选集暂不可用，请重试载入", false);
    }
  }

  function playbackError(current, text) {
    if (state.playback !== current) return;
    resetVideo();
    showStatus(text, true, "重试播放");
  }

  async function startEpisode(index) {
    const episode = state.source?.episodes[index];
    if (!episode) return;
    resetVideo();
    state.index = index;
    updateSelection();
    const controller = new AbortController();
    const current = { controller, ready: false, key: "handbook:xifan:progress:" + episode.id };
    state.playback = current;
    showStatus("正在连接视频…", false);
    try {
      const result = await api("play", { anime: state.catalogue.id, episode: episode.id, source: state.source.id },
        AbortSignal.any([controller.signal, AbortSignal.timeout(24000)]));
      if (state.playback !== current) return;
      video.src = result.url;
      state.timer = setTimeout(() => playbackError(current, "视频加载超时，可以重试或打开原网页"), 20000);
      video.play().catch(error => {
        if (error.name !== "NotAllowedError" && error.name !== "AbortError")
          playbackError(current, "这条线路暂时无法播放，可以重试或打开原网页");
      });
    } catch (error) {
      if (!controller.signal.aborted)
        playbackError(current, error.name === "TimeoutError" ? "连接超时，可以重试" : error.message);
    }
  }

  video.addEventListener("loadedmetadata", () => {
    const current = state.playback;
    if (!current || !video.getAttribute("src")) return;
    const saved = storage(current.key);
    if (saved > 2 && saved < video.duration - 5) video.currentTime = saved;
    video.playbackRate = Number($("speed").value);
  });
  video.addEventListener("canplay", () => {
    if (!state.playback || !video.getAttribute("src")) return;
    state.playback.ready = true;
    clearTimeout(state.timer);
    video.hidden = false;
    $("screen-state").hidden = true;
  });
  video.addEventListener("error", () => {
    if (state.playback && video.getAttribute("src"))
      playbackError(state.playback, "视频读取中断，可以重试或打开原网页");
  });
  video.addEventListener("timeupdate", () => saveProgress());
  video.addEventListener("pause", () => saveProgress(true));
  video.addEventListener("ended", () => saveProgress(true));
  window.addEventListener("pagehide", () => saveProgress(true));
  $("speed").addEventListener("change", event => {
    video.playbackRate = Number(event.target.value);
    storage("handbook:xifan:speed", event.target.value);
  });
  const speed = String(storage("handbook:xifan:speed") || 1);
  if ([...$("speed").options].some(option => option.value === speed)) $("speed").value = speed;
  $("episodes").addEventListener("click", event => {
    const button = event.target.closest("button[data-index]");
    if (button) startEpisode(Number(button.dataset.index));
  });
  $("source").addEventListener("change", event => {
    const current = state.source.episodes[state.index];
    state.source = state.catalogue.sources.find(source => String(source.id) === event.target.value);
    state.index = Math.max(0, state.source.episodes.findIndex(episode => episode.number === current.number));
    renderEpisodes();
    startEpisode(state.index);
  });
  $("previous").addEventListener("click", () => startEpisode(state.index - 1));
  $("next").addEventListener("click", () => startEpisode(state.index + 1));
  playButton.addEventListener("click", () => startEpisode(state.index));
  $("link-form").addEventListener("submit", event => {
    event.preventDefault();
    loadCatalogue($("link").value.trim());
  });
  $("sample").addEventListener("click", () => {
    $("link").value = "";
    loadCatalogue(SAMPLE);
  });
  const start = new URLSearchParams(location.search).get("url");
  if (start) $("link").value = start;
  loadCatalogue(start || SAMPLE);
})();
