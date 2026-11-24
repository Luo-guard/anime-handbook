const XIFAN_SITE = "https://next.xifanacg.com";
const XIFAN_SAMPLE = XIFAN_SITE + "/anime/3435/play/203809";

function isOnlinePlaybackLink(value) {
  try {
    const url = new URL(value);
    return url.origin === XIFAN_SITE && !url.username && !url.password
      && /^\/anime\/[1-9]\d{0,8}(?:\/play\/[1-9]\d{0,8})?\/?$/.test(url.pathname);
  } catch { return false; }
}

// 播放代理地址里带着一次性令牌；下载要靠它复用同一份解析结果。
function playbackToken(url) {
  const match = String(url || "").match(/\/api\/playback\/stream\/([^/]+)\//);
  return match ? decodeURIComponent(match[1]) : "";
}

// 选集对话框里的一行：勾选框 + 集名 + 状态位。抽出来便于单独验证转义与勾选态。
function episodePickRow(row, index, checked) {
  return `<label class="episode-pick-row">
        <input type="checkbox" data-pick="${index}" ${checked ? "checked" : ""} />
        <span class="episode-pick-label">${escapeHtml(row.label)}</span>
        <span class="episode-pick-state" data-state="${index}"></span>
      </label>`;
}

// 下载时把「怎么再找到这一集」一并交给后端：失败后才能在原地重试，
// 不用让用户回播放器重新选集（Kazumi 的失败重试也是这个前提）。
function episodeRef(session) {
  const rule = String(session?.catalogue?.rule || "");
  const catalogue = String(session?.catalogue?.id ?? "");
  const source = String(session?.source?.id ?? "");
  const episode = String(session?.episode?.id ?? "");
  return rule && catalogue && source && episode ? { rule, catalogue, source, episode } : null;
}

function onlineEpisodeLabel(session, episode = session.episode) {
  const { animeId, context, source } = session;
  const number = onlineLocalEpisodeNumber(episode, source, context?.target.first);
  if (!number) return "播放";
  const label = `第 ${number} 集`;
  const anime = state.animes.find(item => item.id === animeId)
    || (state.progressAnime?.id === animeId ? state.progressAnime : context?.anime);
  const name = storedPlaybackEpisodeName(anime, `0:${number}`);
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
    clearInterval(downloadTimer);
    downloadLabel("下载", false);
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

  // ---- 网站资源下载：把当前线路的这一集存进媒体库 ----
  // Kazumi 的下载入口在播放器里，这里保持一致：地址只在解析后才知道，
  // 所以按钮跟着「当前正在播的这一集」走，而不是另开一个粘贴框。

  let downloadTimer = 0;

  function downloadLabel(text, disabled) {
    const button = $("#onlinePlayerDownload");
    if (!button) return;
    button.textContent = text;
    button.disabled = Boolean(disabled);
  }

  function downloadEpisodeName(session) {
    const title = session?.catalogue?.title || "未命名番剧";
    const episode = onlineEpisodeLabel(session);
    const line = session?.source?.name || "";
    return line ? `${title} · ${episode} · ${line}` : `${title} · ${episode}`;
  }

  function watchDownload(session, mediaId) {
    clearInterval(downloadTimer);
    const animeId = Number(session.animeId || 0);
    const tick = async () => {
      // 会话可能是从详情页「从网站下载」临时造的，没有在播的 current；
      // 只要选集对话框还记着它，就继续轮询进度。
      if (current !== session && downloadSheet.session !== session) {
        clearInterval(downloadTimer);
        return;
      }
      try {
        const data = await api(`/api/offline/state?anime_id=${animeId}`);
        const job = (data.jobs || []).find(item => Number(item.id) === Number(mediaId));
        if (!job) return;
        if (job.status === "ready") {
          clearInterval(downloadTimer);
          downloadLabel("已入库", true);
          offlineView.local = { files: data.files || [], jobs: data.jobs || [] };
          if (typeof syncEpisodeDownloadMarks === "function") syncEpisodeDownloadMarks(animeId, data.files || []);
          toast("这一集已经存进媒体库");
          return;
        }
        if (job.status === "failed") {
          clearInterval(downloadTimer);
          downloadLabel("重试下载", false);
          toast(job.error || "下载失败", "error");
          return;
        }
        const percent = Math.round(Number(job.progress || 0));
        downloadLabel(job.status === "processing" ? "正在整理…" : `下载 ${percent}%`, true);
      } catch { /* 轮询失败不打扰用户，下一拍再试 */ }
    };
    tick();
    downloadTimer = setInterval(tick, 2500);
  }

  // 换集/换线路时按钮要跟着变：同一集已经在下载或已入库就直接显示对应状态。
  async function reflectDownload(session, number) {
    clearInterval(downloadTimer);
    downloadLabel("下载", false);
    const animeId = Number(session?.animeId || 0);
    // 没有番剧上下文（直接从链接打开）时不预查，点下去会给一句明确提示。
    if (!animeId || !number) return;
    try {
      const data = await api(`/api/offline/state?anime_id=${animeId}`);
      if (!current || current !== session) return;
      const key = `0:${number}`;
      const job = (data.jobs || []).find(
        item => String(item.source_kind || "") === "web" && String(item.episode_key || "") === key,
      );
      if (!job) return;
      if (job.status === "ready") { downloadLabel("已入库", true); return; }
      if (job.status === "failed") return;
      watchDownload(session, job.id);
    } catch { /* 读不到就保持默认状态 */ }
  }

  // ---- 选集下载：和 Kazumi 一样，先选集再入队 ----

  const downloadSheet = { session: null, rows: [], selected: new Set(), busy: false };

  function sheetNumber(session, episode) {
    const first = session?.context?.target?.first || 1;
    return onlineLocalEpisodeNumber(episode, session?.source, first)
      || Number(session?.context?.target?.number || 0);
  }

  function updateDownloadSheet() {
    const count = downloadSheet.selected.size;
    const hint = $("#episodeDownloadHint");
    if (hint) hint.textContent = count ? `已选 ${count} 集` : "还没选";
    const confirm = $("#episodeDownloadConfirm");
    if (confirm) {
      confirm.disabled = downloadSheet.busy || count === 0;
      confirm.textContent = downloadSheet.busy ? "提交中…" : count ? `下载选中（${count} 集）` : "开始下载";
    }
    const all = $("#episodeDownloadSelectAll");
    if (all) all.textContent = count && count === downloadSheet.rows.length ? "取消全选" : "全选";
  }

  function renderDownloadSheet() {
    const list = $("#episodeDownloadList");
    if (!list) return;
    list.innerHTML = downloadSheet.rows
      .map((row, index) => episodePickRow(row, index, downloadSheet.selected.has(index)))
      .join("");
    updateDownloadSheet();
  }

  // 已经在下载或已入库的集标出来：用户不用点开媒体库才知道哪几集有了。
  async function markDownloadSheetStates(session) {
    const animeId = Number(session?.animeId || 0);
    if (!animeId) return;
    try {
      const data = await api(`/api/offline/state?anime_id=${animeId}`);
      if (downloadSheet.session !== session) return;
      const status = new Map();
      (data.jobs || []).forEach(job => {
        if (String(job.source_kind || "") === "web") status.set(String(job.episode_key || ""), job.status);
      });
      downloadSheet.rows.forEach((row, index) => {
        const node = document.querySelector(`#episodeDownloadList [data-state="${index}"]`);
        if (!node) return;
        const value = status.get(`0:${row.number}`);
        node.textContent = value === "ready" ? "已入库"
          : value ? "在下载" : "";
        node.dataset.kind = value || "";
      });
      updateDownloadSheet();
    } catch { /* 状态只是锦上添花，读不到不挡下载 */ }
  }

  function openDownloadSheet(preset = null) {
    // preset：从「从网站下载」进来时还没有在播的会话，直接把线路与目标集传进来。
    const session = preset || current;
    if (!session) return;
    const animeId = Number(session.animeId || 0);
    if (!animeId) {
      toast("先在详情页打开这一部，再下载才能归档到对应的番剧里。", "error");
      return;
    }
    const episodes = (session.source?.episodes || [])
      .map((episode, index) => ({ episode, index, number: sheetNumber(session, episode) }))
      .filter(item => item.number > 0);
    if (!episodes.length) {
      toast("这条线路认不出集数，先切换到带集数的线路。", "error");
      return;
    }
    // 只有一集、而且就是正在播的那一集：直接走单集下载（有现成的令牌）。
    if (episodes.length === 1 && !preset) {
      startWebDownload();
      return;
    }
    downloadSheet.session = session;
    downloadSheet.rows = episodes.map(item => ({
      id: String(item.episode.id),
      number: item.number,
      episodeTitle: String(item.episode.title || ""),
      label: `第 ${String(item.number).padStart(2, "0")} 集${item.episode.title ? ` · ${item.episode.title}` : ""}`,
    }));
    downloadSheet.selected = new Set(
      downloadSheet.rows.reduce((picked, row, index) => {
        if (row.number === sheetNumber(session, session.episode)) picked.push(index);
        return picked;
      }, []),
    );
    if (!downloadSheet.selected.size && downloadSheet.rows.length) downloadSheet.selected.add(0);
    downloadSheet.busy = false;
    $("#episodeDownloadTarget").textContent = `${session.catalogue?.title || ""}${session.source?.name ? ` · ${session.source.name}` : ""}`;
    $("#episodeDownloadStatus").textContent = "";
    renderDownloadSheet();
    const dialog = $("#episodeDownloadSheet");
    if (dialog && !dialog.open) dialog.showModal();
    markDownloadSheetStates(session);
  }

  // 批量下载时每集自己的标题：番名 · 第 XX 集[ · 本集标题] · 线路
  function batchEpisodeTitle(session, row) {
    const name = session.catalogue?.title || "未命名番剧";
    const line = session.source?.name || "";
    const episode = `第 ${String(row.number).padStart(2, "0")} 集${row.episodeTitle ? ` · ${row.episodeTitle}` : ""}`;
    return line ? `${name} · ${episode} · ${line}` : `${name} · ${episode}`;
  }

  async function submitDownloadSheet(event) {
    event?.preventDefault();
    const session = downloadSheet.session;
    if (!session || downloadSheet.busy) return;
    const picked = [...downloadSheet.selected]
      .sort((a, b) => a - b)
      .map(index => downloadSheet.rows[index])
      .filter(Boolean);
    if (!picked.length) {
      toast("先勾选要下载的集", "error");
      return;
    }
    downloadSheet.busy = true;
    updateDownloadSheet();
    const currentNumber = sheetNumber(session, session.episode);
    const onlyCurrent = picked.length === 1 && picked[0].number === currentNumber;
    const token = playbackToken(session.playback?.url);
    try {
      if (onlyCurrent && token) {
        // 只下正在播的这一集：直接用已经解析好的地址，省一次解析。
        const data = await api("/api/offline/web-download", {
          method: "POST",
          timeoutMs: 30000,
          body: JSON.stringify({
            anime_id: session.animeId,
            token,
            episode_key: `0:${currentNumber}`,
            title: downloadEpisodeName(session),
            group_name: session.catalogue?.ruleName || session.catalogue?.rule || "",
            ref: episodeRef(session),
          }),
        });
        $("#episodeDownloadSheet")?.close();
        toast(data.reused ? "这一集已经在下载或已入库" : "已开始下载，完成后出现在媒体库");
        watchDownload(session, data.job?.id);
        return;
      }
      const data = await api("/api/offline/web-download-batch", {
        method: "POST",
        timeoutMs: 60000,
        body: JSON.stringify({
          anime_id: session.animeId,
          rule: session.catalogue?.rule || "",
          catalogue: String(session.catalogue?.id ?? ""),
          source: String(session.source?.id ?? ""),
          title: downloadEpisodeName(session),
          group_name: session.catalogue?.ruleName || session.catalogue?.rule || "",
          items: picked.map(row => ({
            episode_key: `0:${row.number}`,
            episode_id: row.id,
            // 标题按这一集自己拼：批量时后端不能拿「当前播放那集」的标题套给所有集。
            title: batchEpisodeTitle(session, row),
          })),
        }),
      });
      $("#episodeDownloadSheet")?.close();
      const skipped = Number(data.skipped || 0);
      toast(`已加入 ${data.queued} 集下载队列${skipped ? `（${skipped} 集本来就在下载或已入库）` : ""}，进度见 媒体库 → 本地文件`);
      const currentJob = (data.jobs || []).find(
        job => String(job.episode_key || "") === `0:${currentNumber}`,
      );
      if (currentJob) watchDownload(session, currentJob.id);
      else downloadLabel("队列中…", true);
    } catch (error) {
      toast(error.message || "没能加入下载队列", "error");
      downloadSheet.busy = false;
      updateDownloadSheet();
    }
  }

  async function startWebDownload() {
    const session = current;
    if (!session) return;
    const animeId = Number(session.animeId || 0);
    if (!animeId) {
      toast("从详情页打开这一集后再下载，才能归档到对应的番剧里。", "error");
      return;
    }
    const number = sheetNumber(session, session.episode);
    if (!number) {
      toast("认不出这是第几集，先切换到带集数的线路。", "error");
      return;
    }
    const token = playbackToken(session.playback?.url);
    if (!token) {
      toast("这一集的地址还没解析好，稍等一下再点。", "error");
      return;
    }
    downloadLabel("提交中…", true);
    try {
      const data = await api("/api/offline/web-download", {
        method: "POST",
        timeoutMs: 30000,
        body: JSON.stringify({
          anime_id: animeId,
          token,
          episode_key: `0:${number}`,
          title: downloadEpisodeName(session),
          group_name: session.catalogue?.ruleName || session.catalogue?.rule || "",
          ref: episodeRef(session),
        }),
      });
      toast(data.reused ? "这一集已经在下载或已入库" : "已开始下载，完成后出现在媒体库");
      watchDownload(session, data.job?.id);
    } catch (error) {
      downloadLabel("下载", false);
      toast(error.message || "下载没能开始", "error");
    }
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
      // 记下这次解析出来的地址：下载按钮复用它，保证下到的和正在播的是同一个片源。
      session.playback = { url: result.url, format: result.format };
      reflectDownload(session, danmakuNumber);
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

    // 下载模式：拿着搜索结果去读选集，再把选集交给下载对话框（不播放）。
    async function downloadResult(item) {
      if (!isCurrent()) return;
      sourceOpening?.abort();
      const opening = new AbortController();
      sourceOpening = opening;
      latestForSource = opening;
      const openingSignal = AbortSignal.any([signal, opening.signal]);
      hint.textContent = "正在读取选集…";
      feedback.textContent = "";
      try {
        const catalogue = await request("catalogue", { rule, anime: item.id }, openingSignal);
        if (!isCurrent() || openingSignal.aborted || $("#settingsModal").open) return;
        const { source, episode } = matchOnlineEpisode(catalogue, target);
        lastRule = rule;
        try { localStorage.setItem("handbook:online-rule", rule); }
        catch { /* 存不下也能下载 */ }
        dialog.close();
        openDownloadSheet({
          animeId: Number(anime.id) || 0,
          catalogue,
          source,
          episode,
          context,
        });
      } catch (error) {
        if (isCurrent() && !openingSignal.aborted) {
          hint.textContent = "无法下载";
          feedback.textContent = errorMessage(error, "读取选集超时");
        }
      } finally {
        if (sourceOpening === opening) sourceOpening = null;
      }
    }

    async function playResult(item) {
      if (!isCurrent() || (auto && sourceOpening)) return;
      if (context.mode === "download") return downloadResult(item);
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

  async function openAnime(anime, key, _button, { choose = false, mode = "play" } = {}) {
    let target;
    try { target = mainPlaybackEpisode(anime, key); }
    catch (error) { toast(error.message, "error"); return; }
    abortLookup();
    clearSourceSearches();
    const context = { anime, target, mode };
    selection = context;
    const dialog = $("#onlinePlaybackPicker");
    const status = $("#onlineRuleStatus");
    // 同一个面板两种用途：播还是下。标题写清楚，免得用户以为点错了。
    $("#onlinePlaybackPickerTitle").textContent = mode === "download" ? "从网站下载" : "播放来源";
    $("#onlineSourceAnime").textContent = `${anime.display_name || anime.name_cn || anime.name} · 第 ${target.number} 集`;
    $("#onlinePlaybackResults").replaceChildren();
    status.textContent = "正在读取已安装来源…";
    if (!dialog.open) dialog.showModal();
    try {
      const result = await request("rules", {});
      if (!dialog.open || selection !== context) return;
      installed = result.items;
      defaultRule = result.default_rule || "";
      renderInstalled({ autoPlay: !choose && mode !== "download" });
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
    // 详情页「⋯ → 从网站下载」：先选站点/线路，再选集，最后批量入队。
    $("#openSiteDownload")?.addEventListener("click", event => {
      const menu = $("#modernDetailMenu");
      if (menu) menu.open = false;
      const anime = state.progressAnime;
      if (!anime) {
        toast("先打开一部番剧的详情，再选择下载来源。", "error");
        return;
      }
      openAnime(anime, "", event.currentTarget, { choose: true, mode: "download" });
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
    $("#onlinePlayerDownload").addEventListener("click", openDownloadSheet);
    $("#episodeDownloadForm").addEventListener("submit", submitDownloadSheet);
    $("#episodeDownloadClose").addEventListener("click", () => $("#episodeDownloadSheet").close());
    $("#episodeDownloadCancel").addEventListener("click", () => $("#episodeDownloadSheet").close());
    $("#episodeDownloadSelectAll").addEventListener("click", () => {
      const all = downloadSheet.selected.size === downloadSheet.rows.length;
      downloadSheet.selected = all ? new Set() : new Set(downloadSheet.rows.map((_row, index) => index));
      renderDownloadSheet();
    });
    $("#episodeDownloadList").addEventListener("change", (event) => {
      const input = event.target.closest("input[data-pick]");
      if (!input) return;
      const index = Number(input.dataset.pick);
      if (input.checked) downloadSheet.selected.add(index); else downloadSheet.selected.delete(index);
      updateDownloadSheet();
    });
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
