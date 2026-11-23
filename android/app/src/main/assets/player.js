(() => {
  const $ = id => document.getElementById(id);
  const host = window.AndroidPlayer;
  const overlay = $("mobilePlayer");
  const stage = $("mpStage");
  const surface = $("pcVideoSurface");
  const video = $("offlineVideo");
  const sheets = [...overlay.querySelectorAll(".mp-sheet")];
  const click = (id, fn) => $(id)?.addEventListener("click", fn);
  const change = (id, fn) => $(id)?.addEventListener("change", fn);
  const submit = (id, fn) => $(id)?.addEventListener("submit", event => { event.preventDefault(); fn(); });
  function read(key, fallback) {
    try { return JSON.parse(localStorage.getItem("mobile-player:" + key)) ?? fallback; } catch { return fallback; }
  }
  function write(key, value) {
    try { localStorage.setItem("mobile-player:" + key, JSON.stringify(value)); } catch { /* Playback stays available. */ }
  }
  const prefs = { speed: 1, skip: 80, quality: "off", volume: 1, brightness: 1, fit: "contain", autoNext: true, ...read("prefs", {}) };
  const sources = read("sources", {});
  const resume = read("resume", {});
  const local = new Map();
  const pending = new Map();
  let anime, episodes = [], index = 0, line = 0, source, hls, subtitle, model, modelGeneration = 0;
  let playbackGeneration = 0, mediaEvents, pipPending = false, pipWasPlaying = false, danmakuId = 0;
  let hlsImport, lastPositionSave = 0;

  const episode = () => episodes[index];
  const key = () => `${anime?.id || "local"}:${episode()?.key || "01"}`;
  const positionKey = item => !anime && item ? (item.file
    ? JSON.stringify([item.file.name,item.file.size,item.file.lastModified])
    : item.saved ? key() + ":" + item.saved : key()) : key();
  const linksKey = (template = false) => template ? `${anime?.id || "local"}:rule` : key();
  const notice = text => { $("mpStatus").textContent = text; };
  const escapeText = value => String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  function link(value) {
    try {
      const url = new URL(value);
      // 预览页用 localhost 的示例视频；真机除 HTTPS 外还允许回环（本地媒体服务）。
      const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
      const secure = url.protocol === "https:" || (window.__previewAllowHttp === true && loopback) || loopback;
      return secure && !url.username && !url.password ? url.href : "";
    } catch { return ""; }
  }

  // ---------- 面板 / 菜单 ----------
  const menuOpen = () => !$("mpMenu").hidden;
  const drawerOpen = () => !$("mpEpisodes").hidden;
  const sheetOpen = () => menuOpen() || drawerOpen() || sheets.some(sheet => !sheet.hidden)
    || !$("danmakuPanel").classList.contains("hidden");

  function closeMenu() { $("mpMenu").hidden = true; }
  function closeAll() {
    closeMenu();
    $("mpEpisodes").hidden = true;
    for (const sheet of sheets) sheet.hidden = true;
    $("danmakuPanel").classList.add("hidden");
    scheduleHide();
  }
  function setSheet(id) {
    closeMenu();
    $("mpEpisodes").hidden = true;
    for (const sheet of sheets) sheet.hidden = sheet.id !== id;
    $("danmakuPanel").classList.add("hidden");
    overlay.classList.remove("mp-controls-hidden");
    clearTimeout(hideTimer);
  }
  function openMenu() {
    if (menuOpen()) { closeMenu(); return; }
    for (const sheet of sheets) sheet.hidden = true;
    refreshMenuValues();
    $("mpMenu").hidden = false;
    overlay.classList.remove("mp-controls-hidden");
    clearTimeout(hideTimer);
  }

  // ---------- 控制层自动隐藏 ----------
  let hideTimer = 0;
  function hideControls() {
    if (sheetOpen() || video.paused) return;
    overlay.classList.add("mp-controls-hidden");
  }
  function scheduleHide() {
    clearTimeout(hideTimer);
    if (sheetOpen()) return;
    if (video.paused) { overlay.classList.remove("mp-controls-hidden"); return; }
    hideTimer = window.setTimeout(hideControls, 4000);
  }
  function toggleControls() {
    if (sheetOpen()) { closeAll(); return; }
    if (overlay.classList.contains("mp-controls-hidden")) {
      overlay.classList.remove("mp-controls-hidden");
      scheduleHide();
    } else {
      overlay.classList.add("mp-controls-hidden");
      clearTimeout(hideTimer);
    }
  }

  // ---------- HUD ----------
  let hudTimer = 0;
  function showHud(main, sub) {
    $("mpHudMain").textContent = main;
    $("mpHudSub").textContent = sub || "";
    $("mpHud").hidden = false;
    clearTimeout(hudTimer);
    hudTimer = window.setTimeout(() => { $("mpHud").hidden = true; }, 900);
  }

  // ---------- 时间与进度 ----------
  function time(seconds) {
    const n = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
    const h = Math.floor(n / 3600), m = Math.floor((n % 3600) / 60), s = n % 60;
    const pad = value => String(value).padStart(2, "0");
    return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  }
  let dragging = false;
  function paintProgress() {
    const duration = video.duration;
    const ratio = Number.isFinite(duration) && duration > 0 ? Math.min(1, video.currentTime / duration) : 0;
    $("mpPlayed").style.width = `${ratio * 100}%`;
    $("mpThumb").style.left = `${ratio * 100}%`;
    let buffered = 0;
    try {
      const ranges = video.buffered;
      for (let i = 0; i < ranges.length; i += 1) {
        if (ranges.start(i) <= video.currentTime + .5 && ranges.end(i) >= video.currentTime) buffered = Math.max(buffered, ranges.end(i));
      }
      if (!buffered && ranges.length) buffered = ranges.end(ranges.length - 1);
    } catch { /* 还没加载 */ }
    $("mpBuffer").style.width = `${Number.isFinite(duration) && duration > 0 ? Math.min(100, buffered / duration * 100) : 0}%`;
    $("mpTime").textContent = `${time(video.currentTime)} / ${time(duration)}`;
    if (!dragging) $("mpSeek").value = String(Math.round(ratio * 1000));
    $("mpSeek").disabled = !Number.isFinite(duration);
  }

  // ---------- 图标 ----------
  const ICON_PLAY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>';
  const ICON_PAUSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h4v14H6zM14 5h4v14h-4z" fill="currentColor"/></svg>';
  const PATH_FULL = "M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z";
  const PATH_EXIT = "M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z";
  function syncPlayIcon() {
    const paused = video.paused;
    $("mpPlay").innerHTML = paused ? ICON_PLAY : ICON_PAUSE;
    $("mpPlay").setAttribute("aria-label", paused ? "播放" : "暂停");
  }
  function sync() {
    syncPlayIcon();
    paintProgress();
    if (video.paused) overlay.classList.remove("mp-controls-hidden");
  }
  function refreshMenuValues() {
    const quality = { off: "关闭", fast: "效率档 2×", quality: "质量档 2×" }[prefs.quality] || "关闭";
    $("mpMenuSpeedValue").textContent = `${Number(prefs.speed).toFixed(2).replace(/0$/, "").replace(/\.$/, ".0")}x`;
    $("mpMenuRatioValue").textContent = prefs.fit === "cover" ? "填充" : "适应";
    $("mpMenuUpscaleValue").textContent = quality;
    $("mpMenuEpisodesValue").textContent = `${episodes.length} 集`;
    $("mpMenuSubtitleValue").textContent = subtitle ? (subtitle.track.mode === "showing" ? "已开启" : "已关闭") : "未加载";
  }

  // ---------- 播放核心 ----------
  function remember() {
    if (prefs.remember === false) return;
    if (!source || video.readyState < 1 || !Number.isFinite(video.duration)) return;
    resume[positionKey(source)] = video.ended || video.currentTime >= video.duration - 2 ? 0 : video.currentTime;
    write("resume", resume);
    lastPositionSave = Date.now();
  }
  function stopUpscale() { modelGeneration++; model?.stop(); model = null; }
  function stopVideo() {
    stopUpscale();
    playbackGeneration++;
    mediaEvents?.abort();
    hls?.destroy();
    hls = null;
    video.pause();
    video.removeAttribute("src");
    video.removeAttribute("crossorigin");
    video.load();
    if (subtitle) {
      subtitle.remove();
      URL.revokeObjectURL(subtitle.src);
      subtitle = null;
    }
    $("mpBuffering").hidden = true;
    $("mpEndCard").hidden = true;
    source = null;
  }
  async function upscale() {
    stopUpscale();
    const generation = modelGeneration;
    const report = error => {
      if (generation !== modelGeneration) return;
      $("mpQualityStatus").textContent = error ? `${error}。已使用原画。` : "内置超分生效中";
    };
    $("mpQualityStatus").textContent = prefs.quality === "off" ? "已关闭" : "等待可用视频帧…";
    if (prefs.quality === "off" || video.readyState < 2 || overlay.classList.contains("mp-pip")) return;
    try {
      const module = await import("./modules/player-upscale.js");
      if (generation !== modelGeneration) return;
      model = module.startPlayerUpscale(video, surface, prefs.quality, report);
    } catch (error) { report(error.message || "无法启动超分"); }
  }
  function loadHls() {
    if (window.Hls) return Promise.resolve(window.Hls);
    return hlsImport ||= new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "vendor/hls/hls.min.js";
      script.onload = () => resolve(window.Hls);
      script.onerror = () => { hlsImport = null; reject(Error("HLS 组件未能加载")); };
      document.head.append(script);
    });
  }
  function play() { video.play().catch(error => { if (error.name !== "AbortError") notice("请点播放，或检查当前片源"); }); }
  function seek(seconds) {
    if (Number.isFinite(video.duration)) video.currentTime = Math.max(0, Math.min(video.duration, video.currentTime + seconds));
  }
  function applyFit() {
    video.classList.toggle("mp-fill", prefs.fit === "cover");
  }
  async function loadLine(next, resumeAt = (prefs.remember === false ? 0 : Number(resume[positionKey(next)]) || 0)) {
    stopVideo();
    source = next;
    if (!next) { notice("请选择本机视频，或添加 HTTPS 视频地址"); sync(); return; }
    const generation = playbackGeneration;
    mediaEvents = new AbortController();
    const options = {signal:mediaEvents.signal};
    let retryWithoutCors = Boolean(next.file);
    notice("正在连接视频…");
    $("mpBuffering").hidden = false;
    video.addEventListener("loadedmetadata", () => {
      video.playbackRate = Number(prefs.speed) || 1;
      if (!host) video.volume = Number(prefs.volume);
      if (resumeAt > 0 && resumeAt < video.duration - 1) video.currentTime = resumeAt;
      sync();
    }, options);
    video.addEventListener("loadeddata", () => { notice(""); $("mpBuffering").hidden = true; upscale(); }, options);
    video.addEventListener("waiting", () => { $("mpBuffering").hidden = false; if (!video.paused) notice("正在缓冲…"); }, options);
    video.addEventListener("playing", () => { notice(""); $("mpBuffering").hidden = true; }, options);
    video.addEventListener("canplay", () => { $("mpBuffering").hidden = true; }, options);
    video.addEventListener("error", () => {
      if (!retryWithoutCors && !hls && !video.videoWidth) {
        retryWithoutCors = true;
        video.removeAttribute("crossorigin");
        video.src = next.url;
        play();
      } else { $("mpBuffering").hidden = true; notice("无法播放这条线路，可换源或检查设备是否支持该格式"); }
    }, options);
    try {
      if (!next.file && /\.m3u8(?:[?#]|$)/i.test(next.url) && !video.canPlayType("application/vnd.apple.mpegurl")) {
        const Hls = await loadHls();
        if (generation !== playbackGeneration) return;
        if (!Hls?.isSupported()) throw Error("此设备的 WebView 不支持 HLS 播放");
        hls = new Hls();
        hls.on(Hls.Events.ERROR, (_, event) => { if (event.fatal) notice("HLS 线路读取失败，请检查片源或切换线路"); });
        hls.on(Hls.Events.MANIFEST_PARSED, play);
        hls.loadSource(next.url);
        hls.attachMedia(video);
      } else {
        if (!next.file) video.crossOrigin = "anonymous";
        video.src = next.url;
        play();
      }
    } catch (error) { if (generation === playbackGeneration) notice(error.message); }
  }

  // ---------- 线路 / 选集 ----------
  let offlineLines = null;
  let offlineTitle = "";
  function lineItems() {
    if (offlineLines) return offlineLines.map(entry => ({ url: entry.url }));
    const direct = (sources[linksKey()] || []).map(url => ({ url, group: linksKey(), saved: url }));
    const rules = (sources[linksKey(true)] || []).map(value => {
      const ep = episode();
      const url = value.replaceAll("{episode}", encodeURIComponent(ep?.display_label || ep?.key || "01"))
        .replaceAll("{key}", encodeURIComponent(ep?.key || "01"));
      return {url:link(url), group:linksKey(true), saved:value, rule:true};
    }).filter(item => item.url);
    return [...(local.get(key()) || []), ...direct, ...rules];
  }
  function refreshLines() {
    const list = lineItems();
    $("mpLine").replaceChildren(...list.map((item, i) => new Option(
      item.file ? item.file.name : `${item.rule ? "分集规则" : "在线"} · ${new URL(item.url).hostname}`, i)));
    $("mpLine").disabled = !list.length;
    line = Math.min(line, Math.max(0, list.length - 1));
    $("mpLine").value = line;
    $("mpRemoveSource").disabled = !list[line];
    $("mpOriginal").disabled = !list[line] || Boolean(list[line].file);
    return list;
  }
  function selectEpisode(next) {
    remember();
    index = Math.max(0, Math.min(episodes.length - 1, next));
    line = 0;
    const ep = episode();
    $("mpEpisode").value = index;
    $("mpTitle").textContent = anime ? name(anime) : "本机播放";
    $("mpEpisodeLabel").textContent = [
      typeLabel(episodeType(ep)),
      ep.display_label || ep.key,
      ep.name_cn || ep.name,
    ].filter(Boolean).join(" · ");
    $("mpEndCard").hidden = true;
    refreshWatched();
    renderEpisodeGrid();
    loadLine(refreshLines()[line]);
    dmLoadFor({episode_key:ep.key}, anime ? name(anime) : "", anime?.id, key());
  }
  function renderEpisodeGrid() {
    const hostGrid = $("mpEpisodeGrid");
    if (!hostGrid) return;
    const current = anime && animes().find(item => Number(item.id) === Number(anime.id));
    const watched = new Set(arrayValue(current?.watched_episodes).map(String));
    const groups = new Map();
    episodes.forEach((ep, i) => {
      const type = episodeType(ep);
      if (!groups.has(type)) groups.set(type, []);
      groups.get(type).push({ ep, i });
    });
    hostGrid.innerHTML = [...groups].map(([type, items]) => `
      <div class="mp-episode-group">
        <h3>${typeLabel(type)} · ${items.length} 集</h3>
        <div class="mp-episode-grid">
          ${items.map(({ ep, i }) => `<button type="button" class="mp-episode${i === index ? " is-current" : ""}${watched.has(String(ep.key)) ? " is-watched" : ""}" data-episode-index="${i}">${escapeText(ep.display_label || ep.key)}</button>`).join("")}
        </div>
      </div>`).join("");
    hostGrid.querySelectorAll("[data-episode-index]").forEach(button => {
      button.onclick = () => { selectEpisode(Number(button.dataset.episodeIndex)); closeAll(); };
    });
    hostGrid.querySelector(".mp-episode.is-current")?.scrollIntoView({block:"nearest"});
  }
  function refreshWatched() {
    const current = anime && animes().find(item => Number(item.id) === Number(anime.id));
    const watched = Boolean(current && arrayValue(current.watched_episodes).map(String).includes(String(episode()?.key)));
    $("mpWatched").setAttribute("aria-pressed", String(watched));
    $("mpWatched").disabled = !current || watched;
  }

  // ---------- 打开 / 关闭 ----------
  // 离线播放列表（手账整理目录扫描出来的番剧）：一次给全部分集，支持连播。
  function showOffline(title, list) {
    if (!Array.isArray(list) || !list.length) { notice("这个文件夹里没有识别出可播放的视频"); return false; }
    const mapped = list.map(entry => ({ url: link(entry.url) })).filter(entry => entry.url);
    if (!mapped.length) { notice("视频地址不可用，请重新扫描离线目录"); return false; }
    offlineTitle = title;
    offlineLines = mapped;
    const id = `offline:${title}`;
    show({
      id,
      name_cn: title,
      collection_type: 1,
      episodes: JSON.stringify(list.map((entry, i) => ({
        key: String(i + 1).padStart(2, "0"),
        display_label: entry.label || String(i + 1),
        type: 0,
      }))),
    }, "01");
    return true;
  }

  function show(item, preferred) {
    if (!overlay.hidden) close();
    anime = item;
    episodes = item ? episodeList(item) : [];
    if (!episodes.length) episodes = [{key:"01",display_label:"第 1 集",type:0}];
    const watched = arrayValue(item?.watched_episodes).map(String);
    const requested = episodes.findIndex(ep => String(ep.key) === String(preferred));
    const unwatched = episodes.findIndex(ep => episodeType(ep) === 0 && !watched.includes(String(ep.key)));
    $("mpEpisode").replaceChildren(...episodes.map((ep, i) => new Option(
      [typeLabel(episodeType(ep)), ep.display_label || ep.key, ep.name_cn || ep.name].filter(Boolean).join(" · "), i)));
    overlay.hidden = false;
    document.body.classList.add("mobile-playing");
    $("mpQuality").value = prefs.quality;
    document.querySelectorAll('input[name="mpQuality"]').forEach(input => { input.checked = input.value === prefs.quality; });
    applyFit();
    selectEpisode(requested >= 0 ? requested : Math.max(0, unwatched));
    closeAll();
    if (!source && !offlineLines) setSheet("mpSources");
    scheduleHide();
  }
  function close() {
    remember();
    stopVideo();
    dmClear();
    offlineLines = null;
    offlineTitle = "";
    closeAll();
    immersive(false);
    for (const items of local.values()) for (const item of items) URL.revokeObjectURL(item.url);
    local.clear();
    overlay.hidden = true;
    overlay.classList.remove("mp-controls-hidden");
    document.body.classList.remove("mobile-playing");
  }
  function immersive(active) {
    overlay.classList.toggle("mp-fullscreen", active);
    $("mpFullscreen").setAttribute("aria-pressed", String(active));
    $("mpFullscreenPath").setAttribute("d", active ? PATH_EXIT : PATH_FULL);
    host?.bars(active);
    try {
      if (active && screen.orientation?.lock) screen.orientation.lock("landscape").catch(() => {});
      else if (!active && screen.orientation?.unlock) screen.orientation.unlock();
    } catch { /* 有些 WebView 不支持 */ }
    dmResize(true);
  }

  // ---------- 结束卡片 ----------
  let endTimer = 0;
  function showEndCard() {
    const hasNext = index < episodes.length - 1;
    $("mpEndNext").hidden = !hasNext;
    $("mpEndCard").hidden = false;
    overlay.classList.remove("mp-controls-hidden");
    clearInterval(endTimer);
    if (!hasNext || prefs.autoNext === false) {
      $("mpEndHint").textContent = hasNext ? "" : "已经是最后一集。";
      return;
    }
    let left = 5;
    $("mpEndHint").textContent = `${left} 秒后自动播放下一集`;
    endTimer = window.setInterval(() => {
      left -= 1;
      if (left <= 0) {
        clearInterval(endTimer);
        $("mpEndCard").hidden = true;
        if (index < episodes.length - 1) selectEpisode(index + 1);
        return;
      }
      $("mpEndHint").textContent = `${left} 秒后自动播放下一集`;
    }, 1000);
  }

  // ---------- 手势：单击收放控制条、双击播放/暂停、横向拖动进度、纵向调亮度/音量 ----------
  let gesture = null, lastTap = 0, tapTimer = 0;
  stage.addEventListener("pointerdown", event => {
    if (event.target.closest("button, input, select, .mp-menu, .mp-sheet, .mp-drawer, #danmakuPanel, .mp-send")) return;
    gesture = {
      x: event.clientX, y: event.clientY, t: Date.now(),
      mode: "", start: video.currentTime, startVolume: Number(prefs.volume) || 0,
      startBrightness: Number(prefs.brightness) || 1, moved: false, delta: 0,
    };
  });
  stage.addEventListener("pointermove", event => {
    if (!gesture) return;
    const dx = event.clientX - gesture.x, dy = event.clientY - gesture.y;
    if (!gesture.mode) {
      if (Math.abs(dx) < 12 && Math.abs(dy) < 12) return;
      gesture.moved = true;
      gesture.mode = Math.abs(dx) >= Math.abs(dy) ? "seek" : (gesture.x > window.innerWidth * .5 ? "volume" : "brightness");
      if (gesture.mode === "seek") { overlay.classList.add("mp-controls-hidden"); $("mpProgress").classList.add("is-dragging"); }
    }
    if (gesture.mode === "seek") {
      // 整条屏幕宽度对应 120 秒，跟手且不会太灵敏
      const duration = Number.isFinite(video.duration) ? video.duration : 0;
      gesture.delta = dx / window.innerWidth * 120;
      const target = Math.max(0, Math.min(duration, gesture.start + gesture.delta));
      const sign = gesture.delta >= 0 ? "+" : "-";
      showHud(time(target), `${sign}${Math.abs(Math.round(gesture.delta))} 秒`);
      event.preventDefault();
    } else if (gesture.mode === "volume") {
      const value = Math.max(0, Math.min(1, gesture.startVolume - dy / (window.innerHeight * .6)));
      prefs.volume = Math.round(value * 100) / 100;
      if (host) host.volume(prefs.volume); else video.volume = prefs.volume;
      write("prefs", prefs);
      showHud(`音量 ${Math.round(prefs.volume * 100)}%`, "");
      event.preventDefault();
    } else if (gesture.mode === "brightness") {
      const value = Math.max(.2, Math.min(1, gesture.startBrightness - dy / (window.innerHeight * .6)));
      prefs.brightness = Math.round(value * 100) / 100;
      video.style.filter = `brightness(${prefs.brightness})`;
      write("prefs", prefs);
      showHud(`亮度 ${Math.round(prefs.brightness * 100)}%`, "");
      event.preventDefault();
    }
  });
  stage.addEventListener("pointerup", event => {
    if (!gesture) return;
    const state = gesture;
    gesture = null;
    $("mpProgress").classList.remove("is-dragging");
    if (state.mode === "seek") {
      if (Number.isFinite(video.duration)) {
        video.currentTime = Math.max(0, Math.min(video.duration, state.start + state.delta));
      }
      showHud(time(video.currentTime), `${state.delta >= 0 ? "+" : "-"}${Math.abs(Math.round(state.delta))} 秒`);
      scheduleHide();
      return;
    }
    if (state.moved) { scheduleHide(); return; }
    if (event.target.closest("button, input, select, .mp-menu, .mp-sheet, .mp-drawer, #danmakuPanel, .mp-send")) return;
    const now = Date.now();
    if (now - lastTap < 280) {
      lastTap = 0;
      clearTimeout(tapTimer);
      if (video.paused) play(); else video.pause();
      sync();
      return;
    }
    lastTap = now;
    clearTimeout(tapTimer);
    tapTimer = window.setTimeout(() => toggleControls(), 250);
  });
  stage.addEventListener("pointercancel", () => { gesture = null; $("mpProgress").classList.remove("is-dragging"); });
  stage.addEventListener("dblclick", event => event.preventDefault());

  // ---------- 通用选择器 ----------
  function picker(title, options, current, onPick) {
    $("mpPickerTitle").textContent = title;
    $("mpPickerBody").innerHTML = options.map(([value, label]) => `
      <button type="button" class="mp-option" data-value="${escapeText(value)}">
        <span>${escapeText(label)}</span>${String(value) === String(current) ? "<i>✓</i>" : ""}
      </button>`).join("");
    $("mpPickerBody").querySelectorAll("[data-value]").forEach(button => {
      button.onclick = () => { closeAll(); onPick(button.dataset.value); };
    });
    setSheet("mpPicker");
  }

  // ---------- 事件 ----------
  for (const event of ["play", "pause", "timeupdate", "durationchange", "volumechange", "ended", "progress"]) video.addEventListener(event, sync);
  video.addEventListener("play", () => { overlay.classList.remove("mp-controls-hidden"); scheduleHide(); });
  video.addEventListener("pause", () => { clearTimeout(hideTimer); overlay.classList.remove("mp-controls-hidden"); });
  video.addEventListener("timeupdate", () => { if (Date.now() - lastPositionSave > 5000) remember(); });
  video.addEventListener("ended", () => { remember(); showEndCard(); });
  video.addEventListener("loadedmetadata", () => overlay.classList.remove("mp-controls-hidden"));

  click("mpClose", close);
  click("mpPlay", () => { if (!source) setSheet("mpSources"); else if (video.paused) play(); else video.pause(); });
  click("mpSkip", () => { seek(prefs.skip); showHud(`+${prefs.skip} 秒`, ""); });
  click("mpPip", () => {
    if (!host || video.readyState < 2) { notice("视频载入后可开启画中画"); return; }
    pipPending = true;
    pipWasPlaying = !video.paused;
    overlay.classList.add("mp-pip");
    host.pip(video.videoWidth, video.videoHeight);
  });
  click("mpWatched", () => { if (anime && !$("mpWatched").disabled) { toggleEpisode(anime.id, episode().key); refreshWatched(); renderEpisodeGrid(); notice("已记录本集"); } });
  click("mpMore", openMenu);
  click("mpFullscreen", () => immersive(!overlay.classList.contains("mp-fullscreen")));
  click("mpReplay", () => { $("mpEndCard").hidden = true; video.currentTime = 0; play(); });
  click("mpEndNext", () => { clearInterval(endTimer); $("mpEndCard").hidden = true; if (index < episodes.length - 1) selectEpisode(index + 1); });

  // 长按快进按钮改步长（Kazumi 的做法）
  let skipHold = 0;
  $("mpSkip").addEventListener("pointerdown", () => {
    skipHold = window.setTimeout(() => {
      skipHold = 0;
      picker("快进步长", [[15,"15 秒"],[30,"30 秒"],[60,"60 秒"],[80,"80 秒"],[120,"120 秒"]], prefs.skip, value => {
        prefs.skip = Number(value) || 80;
        write("prefs", prefs);
      });
    }, 520);
  });
  for (const type of ["pointerup", "pointerleave", "pointercancel"]) {
    $("mpSkip").addEventListener(type, () => { if (skipHold) { clearTimeout(skipHold); skipHold = 0; } });
  }

  // ⋮ 菜单
  const MENU_ACTIONS = {
    episodes() { closeMenu(); renderEpisodeGrid(); $("mpEpisodes").hidden = false; },
    speed() { picker("倍速", [[0.5,"0.5x"],[0.75,"0.75x"],[1,"1x"],[1.25,"1.25x"],[1.5,"1.5x"],[2,"2x"],[3,"3x"]], prefs.speed, setSpeed); },
    ratio() { picker("视频比例", [["contain","适应画面"],["cover","填满屏幕"]], prefs.fit, value => { prefs.fit = value; write("prefs", prefs); applyFit(); }); },
    upscale() { closeMenu(); setSheet("mpUpscale"); },
    danmaku() { closeMenu(); $("danmakuPanel").classList.remove("hidden"); dmSyncControls(); },
    subtitle() {
      closeMenu();
      if (!subtitle) { $("mpSubtitleFile").click(); return; }
      subtitle.track.mode = subtitle.track.mode === "showing" ? "disabled" : "showing";
      notice(subtitle.track.mode === "showing" ? "字幕已开启" : "字幕已关闭");
    },
    download() { closeMenu(); downloadCurrentEpisode(); },
    shot() { closeMenu(); takeScreenshot(); },
    sources() { closeMenu(); setSheet("mpSources"); },
    pip() { closeMenu(); $("mpPip").click(); },
  };
  $("mpMenu").querySelectorAll("[data-menu]").forEach(button => {
    button.onclick = () => MENU_ACTIONS[button.dataset.menu]?.();
  });

  function setSpeed(value) {
    prefs.speed = Number(value) || 1;
    video.playbackRate = prefs.speed;
    write("prefs", prefs);
    showHud(`${prefs.speed}x`, "播放速度");
  }
  change("mpEpisode", () => { selectEpisode(Number($("mpEpisode").value)); closeAll(); });
  document.querySelectorAll('input[name="mpQuality"]').forEach(input => input.addEventListener("change", () => {
    if (!input.checked) return;
    prefs.quality = input.value;
    write("prefs", prefs);
    upscale();
  }));
  change("mpSeek", () => {
    if (Number.isFinite(video.duration)) video.currentTime = Number($("mpSeek").value) / 1000 * video.duration;
    dragging = false;
  });
  $("mpSeek").addEventListener("input", () => { dragging = true; });
  $("mpSeek").addEventListener("pointerup", () => { dragging = false; });

  click("mpRulesButton", () => window.HandbookRules?.open("player"));
  click("mpOpenFile", () => $("mpFiles").click());
  change("mpFiles", () => {
    const files = [...$("mpFiles").files];
    $("mpFiles").value = "";
    if (!files.length) return;
    const extras = index + files.length - episodes.length;
    if (extras > 0 && !anime) {
      for (let i = 0; i < extras; i++) {
        const number = episodes.length + 1;
        episodes.push({key:String(number).padStart(2,"0"),display_label:`第 ${number} 项`});
        $("mpEpisode").add(new Option(`第 ${number} 项`, number - 1));
      }
    }
    files.slice(0, episodes.length - index).forEach((file, i) => {
      const entry = `${anime?.id || "local"}:${episodes[index + i].key}`;
      local.set(entry, [...(local.get(entry) || []), {file, url:URL.createObjectURL(file)}]);
    });
    selectEpisode(index);
    if (files.length > episodes.length - index) notice("部分文件超过该番剩余集数，请按集单独选择");
    closeAll();
  });
  change("mpLine", () => {
    const at = video.currentTime;
    line = Number($("mpLine").value);
    loadLine(refreshLines()[line], at);
  });
  submit("mpAddSource", () => {
    const value = $("mpUrl").value.trim();
    const isRule = $("mpUseTemplate").checked;
    if (!link(value.replaceAll("{episode}","1").replaceAll("{key}","01")) ||
        (isRule && !/\{(?:episode|key)\}/.test(value))) {
      notice("请输入有效的 HTTPS 地址，分集规则需要集数占位符");
      return;
    }
    const group = linksKey(isRule);
    sources[group] = [...new Set([...(sources[group] || []), isRule ? value : link(value)])];
    write("sources", sources);
    const list = lineItems();
    line = list.findIndex(item => item.group === group && item.saved === (isRule ? value : link(value)));
    loadLine(refreshLines()[line]);
    $("mpUrl").value = "";
    closeAll();
  });
  click("mpRemoveSource", () => {
    const entry = lineItems()[line];
    if (!entry) return;
    if (entry.file) {
      local.set(key(), local.get(key()).filter(item => item !== entry));
      URL.revokeObjectURL(entry.url);
    } else {
      sources[entry.group] = sources[entry.group].filter(item => item !== entry.saved);
      write("sources", sources);
    }
    loadLine(refreshLines()[line]);
  });
  click("mpOriginal", () => { const entry = lineItems()[line]; if (entry && !entry.file) host?.external(entry.url); });
  click("mpSubtitleImport", () => $("mpSubtitleFile").click());
  change("mpSubtitleFile", async () => {
    const file = $("mpSubtitleFile").files[0];
    $("mpSubtitleFile").value = "";
    if (!file || !source || file.size > 3 * 1024 * 1024) return;
    const generation = playbackGeneration;
    try {
      let text = (await file.text()).replace(/^\uFEFF/,"");
      if (generation !== playbackGeneration) return;
      if (/\.srt$/i.test(file.name)) text = "WEBVTT\n\n" + text.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g,"$1.$2");
      if (!/^WEBVTT/.test(text)) { notice("请选择 WebVTT 或 SRT 字幕"); return; }
      if (subtitle) { URL.revokeObjectURL(subtitle.src); subtitle.remove(); }
      const track = document.createElement("track");
      track.kind = "subtitles";
      track.src = URL.createObjectURL(new Blob([text],{type:"text/vtt"}));
      video.append(track);
      track.track.mode = "showing";
      subtitle = track;
      notice("字幕已加载");
    } catch { notice("无法读取字幕文件"); }
  });
  function takeScreenshot() {
    if (video.readyState < 2) { notice("请等待画面加载"); return; }
    try {
      let frame = model?.capture();
      if (!frame) {
        frame = document.createElement("canvas");
        frame.width = video.videoWidth;
        frame.height = video.videoHeight;
        frame.getContext("2d").drawImage(video,0,0);
      }
      const label = [anime ? name(anime) : "动漫手账", episode().display_label || episode().key]
        .join("-").replace(/[\\/:*?"<>|]/g," ").slice(0,90);
      frame.toBlob(blob => {
        if (!blob) { notice("无法生成截图"); return; }
        if (blob.size > 16 * 1024 * 1024) { notice("截图超过 16 MB"); return; }
        const reader = new FileReader();
        reader.onload = () => {
          host?.saveImage(`${label}-${Date.now()}.png`, String(reader.result).split(",")[1]);
          notice("截图已保存");
        };
        reader.onerror = () => notice("无法读取截图");
        reader.readAsDataURL(blob);
      }, "image/png");
    } catch { notice("此片源限制读取画面，无法截图"); }
  }
  // 下载当前这一集到 App 的媒体目录（「本机视频」里自动出现）
  let downloadTimer = 0;
  function downloadCurrentEpisode() {
    if (!host?.downloadStart) { notice("当前安装包不支持下载，请更新"); return; }
    if (!source || !/^https?:/i.test(source.url) || !/^https:/i.test(source.url)) { notice("先播放一集在线片源再下载"); return; }
    if (!anime && !offlineTitle) { notice("先播放一集在线片源再下载"); return; }
    const ep = episode();
    const title = anime ? name(anime) : ($("mpTitle").textContent.trim() || offlineTitle || "在线视频");
    const id = `${anime?.id || title}:${ep?.key || "01"}`;
    host.downloadStart(JSON.stringify({
      id,
      url: source.url,
      referer: source.rule ? "" : "",
      title,
      animeId: Number(anime?.id) || 0,
      episode: ep?.display_label || ep?.key || "01",
      key: ep?.key || "01",
    }));
    $("mpMenuDownloadValue").textContent = "准备中…";
    notice("开始下载：" + (ep?.display_label || ep?.key || "本集"));
    clearTimeout(downloadTimer);
    downloadTimer = setTimeout(() => { $("mpMenuDownloadValue").textContent = "离线保存"; }, 4000);
  }

  click("mpShot", takeScreenshot);

  submit("mpSend", () => { if (dmSendMine($("dmSendInput").value)) $("dmSendInput").value = ""; });
  submit("mpDanmakuConfig", () => {
    const settings = danmakuView.settings;
    const mode = $("mpDmMode").value;
    const custom = mode === "custom" && link($("mpDmBase").value.trim());
    if (mode === "custom" && !custom) { notice("请输入兼容服务的 HTTPS 地址"); return; }
    settings.sourceMode = mode;
    settings.onlineBase = custom || "https://api.dandanplay.net";
    settings.appId = $("mpDmId").value.trim();
    settings.appSecret = $("mpDmSecret").value.trim();
    dmSavePrefs();
    dmSyncControls();
    closeAll();
    if (episode()) dmLoadFor({episode_key:episode().key},anime ? name(anime) : "",anime?.id,key());
  });
  // 弹幕开关：顶栏快捷按钮转发给隐藏的原开关，状态由 danmaku.js 写回
  click("mpDanmakuQuick", () => $("offlineDanmakuToggle").click());
  new MutationObserver(() => {
    $("mpDanmakuQuick").setAttribute("aria-pressed", $("offlineDanmakuToggle").getAttribute("aria-pressed") ?? "true");
  }).observe($("offlineDanmakuToggle"), {attributes:true, attributeFilter:["aria-pressed"]});
  overlay.querySelectorAll(".mp-sheet-close").forEach(button => { button.onclick = closeAll; });
  overlay.querySelectorAll(".mp-drawer .mp-sheet-close").forEach(button => { button.onclick = closeAll; });

  // 与 app.js 的 seedDanmakuDefaults 同逻辑：内置凭据只在没填过时生效
  (function seedDanmakuDefaults() {
    const builtin = window.HANDBOOK_DANMAKU_DEFAULTS;
    if (!builtin?.appId || !builtin?.appSecret) return;
    try {
      const saved = JSON.parse(localStorage.getItem("handbook.danmaku.settings") || "{}");
      if (saved.appId && saved.appSecret) return;
      localStorage.setItem("handbook.danmaku.settings", JSON.stringify({
        ...saved,
        sourceMode: saved.sourceMode || builtin.sourceMode || "dandanplay",
        appId: builtin.appId,
        appSecret: builtin.appSecret,
      }));
    } catch { /* 存储不可写就跳过 */ }
  })();
  window.openHandbookSettings = () => {
    const settings = danmakuView.settings;
    $("mpDmMode").value = settings.sourceMode;
    $("mpDmBase").value = settings.onlineBase;
    $("mpDmId").value = settings.appId;
    $("mpDmSecret").value = settings.appSecret;
    setSheet("mpDanmakuSource");
  };
  window.handbookDanmakuAnime = id => animes().find(item => Number(item.id) === id);
  window.episodeStorageKey = value => {
    const raw = String(value || "");
    return /^\d+$/.test(raw) ? `0:${Number(raw)}` : raw;
  };
  window.handbookDanmakuRequest = (_, options) => new Promise((resolve,reject) => {
    const id = ++danmakuId;
    const signal = options.signal;
    if (!host || signal?.aborted) { reject(Error("弹幕请求已停止")); return; }
    const abort = () => { pending.delete(id); reject(signal.reason); };
    signal?.addEventListener("abort",abort,{once:true});
    pending.set(id,(text,error) => {
      signal?.removeEventListener("abort",abort);
      resolve({ok:!error,json:async () => ({text,error})});
    });
    host.requestDanmaku(id,options.body);
  });

  window.HandbookPlayer = {
    show,
    showOffline,
    scanResult(raw) {
      const callback = window.HandbookMobile?.renderOfflineLibrary;
      if (!callback) return;
      let data = null;
      try { data = JSON.parse(raw); } catch { data = { error: "scanFailed", message: "扫描结果无法解析" }; }
      callback(data);
    },
    downloadState(raw) {
      let state = null;
      try { state = JSON.parse(raw); } catch { return; }
      const value = $("mpMenuDownloadValue");
      if (state.status === "downloading" || state.status === "start") {
        if (value) value.textContent = `${state.percent || 0}%`;
        return;
      }
      if (value) value.textContent = state.status === "done" ? "已完成" : "离线保存";
      clearTimeout(downloadTimer);
      if (state.status === "done") {
        notice("");
        window.HandbookMobile?.toast?.(`已下载：${state.episode}，可在「本机视频」离线观看`);
        window.HandbookMobile?.refreshOfflineLibrary?.();
      } else if (state.status === "error") {
        notice(state.message || "下载失败");
        window.HandbookMobile?.toast?.("下载失败：" + (state.message || "检查网络后再试"));
      } else if (state.status === "cancelled") {
        window.HandbookMobile?.toast?.("已取消下载");
      }
    },
    mediaRootPicked(path) {
      window.HandbookMobile?.mediaRootPicked?.(path);
    },
    playStandalone(url, title, label) {
      const value = link(url);
      if (!value) { notice("这条规则没有给出可播放的 HTTPS 地址"); return false; }
      if (overlay.hidden) {
        show({
          id: null,
          name_cn: title || "在线播放",
          episodes: JSON.stringify([{ key: "01", display_label: label || "正片", type: 0 }]),
        }, "01");
        closeAll();
      }
      return this.playUrl(value, label);
    },
    playUrl(url, label) {
      const value = link(url);
      if (!value) { notice("这条规则没有给出可播放的 HTTPS 地址"); return false; }
      const group = linksKey();
      sources[group] = [value, ...(sources[group] || []).filter(item => item !== value)];
      write("sources", sources);
      line = 0;
      loadLine(refreshLines()[line]);
      if (label) notice(`正在播放：${label}`);
      return true;
    },
    currentName() { return anime ? name(anime) : ""; },
    notice,
    back() {
      if (overlay.hidden) return false;
      if (menuOpen() || drawerOpen() || sheets.some(sheet => !sheet.hidden) || !$("danmakuPanel").classList.contains("hidden")) closeAll();
      else if (overlay.classList.contains("mp-fullscreen")) immersive(false);
      else close();
      return true;
    },
    background(inPip) {
      remember();
      if (!inPip && !pipPending) video.pause();
    },
    pictureInPicture(active) {
      overlay.classList.toggle("mp-pip",active);
      pipPending = false;
      if (active) {
        stopUpscale();
        if (pipWasPlaying && video.paused) play();
      } else if (!overlay.hidden) upscale();
    },
    clearResume() {
      for (const key of Object.keys(resume)) delete resume[key];
      write("resume", resume);
    },
    clearSources() {
      for (const key of Object.keys(sources)) delete sources[key];
      write("sources", sources);
      if (!overlay.hidden) refreshLines();
    },
    commitDanmakuPrefs() {
      if (typeof dmLoadPrefs !== "function") return;
      dmLoadPrefs();
      if (typeof dmSyncControls === "function") dmSyncControls();
      if (typeof dmResize === "function") dmResize(true);
    },
    danmakuResult(id,text,error) {
      const callback = pending.get(id);
      pending.delete(id);
      callback?.(text,error);
    },
  };
  document.addEventListener("keydown", event => {
    if (overlay.hidden || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey ||
        event.target.closest("input,select,textarea,button,[contenteditable]")) return;
    const action = {
      " ":() => $("mpPlay").click(), ArrowLeft:() => seek(-5), ArrowRight:() => seek(5),
      f:() => $("mpFullscreen").click(), s:() => takeScreenshot(), m:() => { video.muted = !video.muted; },
      p:() => { if (index > 0) selectEpisode(index - 1); }, n:() => { if (index < episodes.length - 1) selectEpisode(index + 1); },
      k:() => $("mpSkip").click(), d:() => $("mpDanmakuQuick").click(),
    }[event.key.length === 1 ? event.key.toLowerCase() : event.key];
    if (action) { event.preventDefault(); action(); }
  });
  function applyPrefs() {
    const saved = read("prefs", {});
    if (saved && typeof saved === "object") Object.assign(prefs, saved);
    video.playbackRate = Number(prefs.speed) || 1;
    $("mpQuality").value = prefs.quality;
    document.querySelectorAll('input[name="mpQuality"]').forEach(input => { input.checked = input.value === prefs.quality; });
    applyFit();
    video.style.filter = prefs.brightness && prefs.brightness !== 1 ? `brightness(${prefs.brightness})` : "";
    if (!host) video.volume = Number(prefs.volume);
    if (!overlay.hidden) upscale();
    refreshMenuValues();
  }
  applyPrefs();
  window.HandbookPlayer.applyPrefs = applyPrefs;
})();
