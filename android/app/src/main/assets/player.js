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
  const prefs = { speed: 1, skip: 80, quality: "off", volume: 1, autoNext: true, ...read("prefs", {}) };
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
  function link(value) {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password ? url.href : "";
    } catch { return ""; }
  }

  // ---------- 面板 ----------
  function setSheet(id) {
    for (const sheet of sheets) sheet.hidden = sheet.id !== id;
    const open = sheets.some(sheet => !sheet.hidden);
    overlay.classList.remove("mp-controls-hidden");
    if (open) clearTimeout(hideTimer);
    else scheduleHide();
  }
  function closeSheets() {
    for (const sheet of sheets) sheet.hidden = true;
    scheduleHide();
  }
  const sheetOpen = () => sheets.some(sheet => !sheet.hidden) || !$("danmakuPanel").classList.contains("hidden");

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
    if (sheetOpen()) return;
    if (overlay.classList.contains("mp-controls-hidden")) {
      overlay.classList.remove("mp-controls-hidden");
      scheduleHide();
    } else {
      overlay.classList.add("mp-controls-hidden");
      clearTimeout(hideTimer);
    }
  }
  function flash(text) {
    const node = $("mpFlash");
    node.textContent = text;
    node.hidden = false;
    clearTimeout(flash.timer);
    flash.timer = window.setTimeout(() => { node.hidden = true; }, 900);
  }

  // ---------- 进度与时间 ----------
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
    $("mpTime").innerHTML = `${time(video.currentTime)}<i> / ${time(duration)}</i>`;
    if (!dragging) $("mpSeek").value = String(Math.round(ratio * 1000));
    $("mpSeek").disabled = !Number.isFinite(duration);
  }

  // ---------- 图标状态 ----------
  const PLAY_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.4v13.2L19 12z" fill="currentColor"/></svg>';
  const PAUSE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.5 5h3.2v14H7.5zM13.3 5h3.2v14h-3.2z" fill="currentColor"/></svg>';
  function sync() {
    const paused = video.paused;
    $("mpPlay").innerHTML = paused ? PLAY_ICON : PAUSE_ICON;
    $("mpPlay").setAttribute("aria-label", paused ? "播放" : "暂停");
    $("mpBigPlay").hidden = !paused || video.ended;
    $("mpMute").textContent = video.muted ? "取消静音" : "静音";
    paintProgress();
    if (paused) overlay.classList.remove("mp-controls-hidden");
  }

  // ---------- 播放核心 ----------
  function remember() {
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
    $("mpSubtitle").classList.remove("selected");
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
      $("mpUpscaleButton").classList.toggle("selected", !error);
    };
    $("mpUpscaleButton").classList.remove("selected");
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
  async function loadLine(next, resumeAt = Number(resume[positionKey(next)]) || 0) {
    stopVideo();
    source = next;
    if (!next) { notice("请选择本机视频，或添加 HTTPS 视频地址"); sync(); return; }
    const generation = playbackGeneration;
    mediaEvents = new AbortController();
    const options = {signal:mediaEvents.signal};
    let retryWithoutCors = Boolean(next.file);
    notice("正在连接视频…");
    video.addEventListener("loadedmetadata", () => {
      video.playbackRate = Number(prefs.speed) || 1;
      if (!host) video.volume = Number(prefs.volume);
      if (resumeAt > 0 && resumeAt < video.duration - 1) video.currentTime = resumeAt;
      $("mpBuffering").hidden = false;
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

  // ---------- 线路与选集 ----------
  function lineItems() {
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
    $("mpTitle").textContent = [anime ? name(anime) : "本机播放", ep.display_label, ep.name_cn || ep.name].filter(Boolean).join(" · ");
    $("mpEpisodeLabel").textContent = [
      `第 ${index + 1} / ${episodes.length} 集`,
      typeLabel(episodeType(ep)),
      ep.name_cn || ep.name,
    ].filter(Boolean).join(" · ");
    $("mpPrevious").disabled = index <= 0;
    $("mpNext").disabled = index >= episodes.length - 1;
    $("mpEndCard").hidden = true;
    refreshWatched();
    renderEpisodeGrid();
    loadLine(refreshLines()[line]);
    dmLoadFor({episode_key:ep.key}, anime ? name(anime) : "", anime?.id, key());
  }

  // 选集面板：按类型分组，标出已看与当前集
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
    $("mpEpisodeHint").textContent = `${episodes.length} 集 · 已看 ${episodes.filter(ep => watched.has(String(ep.key))).length}`;
    hostGrid.innerHTML = [...groups].map(([type, items]) => `
      <div class="mp-episode-group">
        <h3>${typeLabel(type)}</h3>
        <div class="mp-episode-grid">
          ${items.map(({ ep, i }) => `<button type="button" class="mp-episode${i === index ? " is-current" : ""}${watched.has(String(ep.key)) ? " is-watched" : ""}" data-episode-index="${i}">${escapeText(ep.display_label || ep.key)}</button>`).join("")}
        </div>
      </div>`).join("");
    hostGrid.querySelectorAll("[data-episode-index]").forEach(button => {
      button.onclick = () => { selectEpisode(Number(button.dataset.episodeIndex)); closeSheets(); };
    });
    hostGrid.querySelector(".mp-episode.is-current")?.scrollIntoView({block:"nearest"});
  }
  function escapeText(value) {
    return String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  }

  function refreshWatched() {
    const current = anime && animes().find(item => Number(item.id) === Number(anime.id));
    const watched = current && arrayValue(current.watched_episodes).map(String).includes(String(episode()?.key));
    $("mpWatched").disabled = !current || watched;
    $("mpWatched").textContent = watched ? "已记录" : "记录已看";
  }

  // ---------- 打开 / 关闭 ----------
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
    syncQuality();
    $("mpSpeed").value = prefs.speed;
    $("mpVolume").value = prefs.volume;
    $("mpSkipSeconds").value = prefs.skip;
    $("mpSkip").textContent = `+${prefs.skip} 秒`;
    $("mpSpeedChip").textContent = `${Number(prefs.speed).toFixed(2).replace(/0$/,"").replace(/\.$/,".0")}×`;
    selectEpisode(requested >= 0 ? requested : Math.max(0, unwatched));
    if (!source) setSheet("mpSources");
    scheduleHide();
    $("mpMore").focus();
  }
  function close() {
    remember();
    stopVideo();
    dmClear();
    closeSheets();
    $("danmakuPanel").classList.add("hidden");
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
    host?.bars(active);
    try {
      if (active && screen.orientation?.lock) screen.orientation.lock("landscape").catch(() => {});
      else if (!active && screen.orientation?.unlock) screen.orientation.unlock();
    } catch { /* 有些 WebView 不支持 */ }
    dmResize(true);
  }

  function syncQuality() {
    $("mpQuality").value = prefs.quality;
    document.querySelectorAll('input[name="mpQuality"]').forEach(input => { input.checked = input.value === prefs.quality; });
  }

  // ---------- 播放结束 ----------
  let endTimer = 0;
  function showEndCard() {
    const hasNext = index < episodes.length - 1;
    $("mpEndHint").textContent = hasNext ? "即将自动播放下一集，点一下取消。" : "已经是最后一集。";
    $("mpEndNext").hidden = !hasNext;
    $("mpEndCard").hidden = false;
    overlay.classList.remove("mp-controls-hidden");
    clearInterval(endTimer);
    if (!hasNext || prefs.autoNext === false) return;
    let left = 5;
    $("mpEndHint").textContent = `${left} 秒后自动播放下一集，点一下取消。`;
    endTimer = window.setInterval(() => {
      left -= 1;
      if (left <= 0) {
        clearInterval(endTimer);
        $("mpEndCard").hidden = true;
        if (index < episodes.length - 1) selectEpisode(index + 1);
        return;
      }
      $("mpEndHint").textContent = `${left} 秒后自动播放下一集，点一下取消。`;
    }, 1000);
  }

  // ---------- 手势 ----------
  let pointer = null, tapTimer = 0, lastTap = 0, holdTimer = 0, holding = false, volumeStart = 0;
  stage.addEventListener("pointerdown", event => {
    if (event.target.closest("button, input, select, .mp-sheet, #danmakuPanel, .mp-send")) return;
    pointer = { x: event.clientX, y: event.clientY, t: Date.now(), moved: false, mode: "" };
    volumeStart = Number(prefs.volume) || 0;
    clearTimeout(holdTimer);
    holding = false;
    holdTimer = window.setTimeout(() => {
      if (!pointer || pointer.moved || video.paused) return;
      holding = true;
      video.playbackRate = 2;
      flash("2× 快进中，松手恢复");
    }, 520);
  });
  stage.addEventListener("pointermove", event => {
    if (!pointer) return;
    const dx = event.clientX - pointer.x, dy = event.clientY - pointer.y;
    if (!pointer.moved && Math.hypot(dx, dy) > 12) {
      pointer.moved = true;
      clearTimeout(holdTimer);
      pointer.mode = Math.abs(dy) > Math.abs(dx) && event.clientX > window.innerWidth * .5 ? "volume" : "";
    }
    if (pointer.mode === "volume") {
      const next = Math.max(0, Math.min(1, volumeStart - dy / (window.innerHeight * .6)));
      prefs.volume = Math.round(next * 100) / 100;
      if (host) host.volume(prefs.volume); else video.volume = prefs.volume;
      $("mpVolume").value = prefs.volume;
      write("prefs", prefs);
      flash(`音量 ${Math.round(prefs.volume * 100)}%`);
      event.preventDefault();
    }
  });
  stage.addEventListener("pointerup", event => {
    clearTimeout(holdTimer);
    if (holding) {
      holding = false;
      video.playbackRate = Number(prefs.speed) || 1;
      pointer = null;
      return;
    }
    if (!pointer) return;
    const moved = pointer.moved, quick = Date.now() - pointer.t < 260;
    pointer = null;
    if (moved) return;
    if (!quick) return;
    if (event.target.closest("button, input, select, .mp-sheet, #danmakuPanel, .mp-send")) return;
    const x = event.clientX / window.innerWidth;
    const now = Date.now();
    if (now - lastTap < 280) {
      lastTap = 0;
      clearTimeout(tapTimer);
      if (x < .35) { seek(-10); flash("快退 10 秒"); }
      else if (x > .65) { seek(10); flash("快进 10 秒"); }
      else toggleControls();
      scheduleHide();
      return;
    }
    lastTap = now;
    clearTimeout(tapTimer);
    tapTimer = window.setTimeout(() => toggleControls(), 250);
  });
  stage.addEventListener("pointercancel", () => {
    clearTimeout(holdTimer);
    if (holding) { holding = false; video.playbackRate = Number(prefs.speed) || 1; }
    pointer = null;
  });
  // 双击时不要选中文字
  stage.addEventListener("dblclick", event => event.preventDefault());

  // ---------- 事件绑定 ----------
  for (const event of ["play", "pause", "timeupdate", "durationchange", "volumechange", "ended", "progress"]) video.addEventListener(event, sync);
  video.addEventListener("play", () => { overlay.classList.remove("mp-controls-hidden"); scheduleHide(); });
  video.addEventListener("pause", () => { clearTimeout(hideTimer); overlay.classList.remove("mp-controls-hidden"); });
  video.addEventListener("timeupdate", () => { if (Date.now() - lastPositionSave > 5000) remember(); });
  video.addEventListener("ended", () => { remember(); showEndCard(); });
  video.addEventListener("loadedmetadata", () => overlay.classList.remove("mp-controls-hidden"));

  click("mpClose", close);
  click("mpPlay", () => { if (!source) setSheet("mpSources"); else if (video.paused) play(); else video.pause(); });
  click("mpBigPlay", () => { if (!source) setSheet("mpSources"); else play(); });
  click("mpPrevious", () => { if (index > 0) selectEpisode(index - 1); });
  click("mpNext", () => { if (index < episodes.length - 1) selectEpisode(index + 1); });
  click("mpEpisodesButton", () => { renderEpisodeGrid(); setSheet("mpEpisodes"); });
  click("mpMore", () => setSheet("mpMenu"));
  click("mpSourcesButton", () => setSheet("mpSources"));
  click("mpRulesButton", () => { window.HandbookRules?.open(); setSheet("mpRules"); });
  click("mpUpscaleButton", () => setSheet("mpUpscale"));
  click("mpFullscreen", () => immersive(!overlay.classList.contains("mp-fullscreen")));
  click("mpMute", () => { video.muted = !video.muted; });
  click("mpSkip", () => { seek(prefs.skip); flash(`快进 ${prefs.skip} 秒`); });
  click("mpReplay", () => { $("mpEndCard").hidden = true; video.currentTime = 0; play(); });
  click("mpEndNext", () => { clearInterval(endTimer); $("mpEndCard").hidden = true; if (index < episodes.length - 1) selectEpisode(index + 1); });
  click("mpPip", () => {
    if (!host || video.readyState < 2) { notice("视频载入后可开启画中画"); return; }
    pipPending = true;
    pipWasPlaying = !video.paused;
    overlay.classList.add("mp-pip");
    host.pip(video.videoWidth, video.videoHeight);
  });
  click("mpWatched", () => { if (anime && !$("mpWatched").disabled) toggleEpisode(anime.id, episode().key); refreshWatched(); renderEpisodeGrid(); });
  click("mpSpeedChip", () => {
    const steps = [0.75, 1, 1.25, 1.5, 2];
    const at = steps.indexOf(Number(prefs.speed));
    setSpeed(steps[(at + 1) % steps.length]);
    flash(`${prefs.speed}×`);
  });
  function setSpeed(value) {
    prefs.speed = Number(value) || 1;
    video.playbackRate = prefs.speed;
    $("mpSpeed").value = prefs.speed;
    $("mpSpeedChip").textContent = `${prefs.speed.toFixed(2).replace(/0$/,"").replace(/\.$/,".0")}×`;
    write("prefs", prefs);
  }
  change("mpEpisode", () => { selectEpisode(Number($("mpEpisode").value)); closeSheets(); });
  change("mpSpeed", () => setSpeed($("mpSpeed").value));
  document.querySelectorAll('input[name="mpQuality"]').forEach(input => input.addEventListener("change", () => {
    if (!input.checked) return;
    prefs.quality = input.value;
    write("prefs", prefs);
    upscale();
  }));
  change("mpQuality", () => { prefs.quality = $("mpQuality").value; write("prefs", prefs); upscale(); });
  change("mpSeek", () => {
    if (Number.isFinite(video.duration)) video.currentTime = Number($("mpSeek").value) / 1000 * video.duration;
    dragging = false;
  });
  $("mpSeek").addEventListener("input", () => { dragging = true; });
  $("mpSeek").addEventListener("pointerup", () => { dragging = false; });
  $("mpVolume").addEventListener("input", () => {
    prefs.volume = Number($("mpVolume").value);
    if (host) host.volume(prefs.volume);
    else video.volume = prefs.volume;
    write("prefs", prefs);
  });
  change("mpSkipSeconds", () => {
    prefs.skip = Math.max(1, Math.min(600, Math.round(Number($("mpSkipSeconds").value)) || 80));
    $("mpSkip").textContent = `+${prefs.skip} 秒`;
    $("mpSkipSeconds").value = prefs.skip;
    write("prefs", prefs);
  });
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
    closeSheets();
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
    closeSheets();
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
  click("mpSubtitle", () => {
    if (!subtitle) $("mpSubtitleFile").click();
    else {
      subtitle.track.mode = subtitle.track.mode === "showing" ? "disabled" : "showing";
      $("mpSubtitle").classList.toggle("selected", subtitle.track.mode === "showing");
    }
  });
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
      $("mpSubtitle").classList.add("selected");
    } catch { notice("无法读取字幕文件"); }
  });
  click("mpShot", () => {
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
        reader.onload = () => host?.saveImage(`${label}-${Date.now()}.png`, String(reader.result).split(",")[1]);
        reader.onerror = () => notice("无法读取截图");
        reader.readAsDataURL(blob);
      }, "image/png");
    } catch { notice("此片源限制读取画面，无法截图"); }
  });
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
    closeSheets();
    if (episode()) dmLoadFor({episode_key:episode().key},anime ? name(anime) : "",anime?.id,key());
  });
  // 面板右上角的关闭键（markup 里写死的那些）
  overlay.querySelectorAll(".mp-sheet-close").forEach(button => { button.onclick = closeSheets; });
  // 弹幕开关：快捷按钮转发给原开关，状态由 danmaku.js 写回
  click("mpDanmakuQuick", () => $("offlineDanmakuToggle").click());
  new MutationObserver(() => {
    $("mpDanmakuQuick").setAttribute("aria-pressed", $("offlineDanmakuToggle").getAttribute("aria-pressed") ?? "true");
  }).observe($("offlineDanmakuToggle"), {attributes:true, attributeFilter:["aria-pressed"]});

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
    // 给规则仓库用：把解析出来的播放地址加进当前集的线路并直接播放。
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
      if (sheets.some(sheet => !sheet.hidden)) closeSheets();
      else if (!$("danmakuPanel").classList.contains("hidden")) $("danmakuPanel").classList.add("hidden");
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
      f:() => $("mpFullscreen").click(), s:() => $("mpShot").click(), m:() => $("mpMute").click(),
      p:() => $("mpPrevious").click(), n:() => $("mpNext").click(), k:() => $("mpSkip").click(),
      d:() => $("mpDanmakuQuick").click(),
    }[event.key.length === 1 ? event.key.toLowerCase() : event.key];
    if (action) { event.preventDefault(); action(); }
  });
})();
