// 本地播放器的弹幕层：浮在 <video> 上的一张 canvas，pointer-events:none。
// 视频仍是原生 video + mp4 Range 流——弹幕不进视频帧，抓帧超分扩展照常接管。
// 时间轴直接用 video.currentTime 当唯一时钟，所以暂停、拖动、倍速、跳集都天然同步。
const DANMAKU_SETTINGS_KEY = "handbook.danmaku.settings";
const DANMAKU_MAPPING_KEY = "handbook.danmaku.mapping";
const DANMAKU_DEFAULTS = {
  enabled: true,
  fontSize: 24,
  duration: 8,
  opacity: 0.92,
  area: 0.5,
  density: 0,
  bold: true,
  topBottom: true,
  shield: "",
  onlineBase: "https://api.dandanplay.net",
  appId: "",
  appSecret: "",
  sourceMode: "public",
  publicBase: "",
};

// 社区公共弹幕源（免凭证，聚合 B 站等多站弹幕）。由志愿者提供，随起落失效；
// 前端逐个试、通了的记住，下次优先用。全部失效时提示换官方源。
const DANMAKU_PUBLIC_BASES = [
  "https://api.danmu.icu",
  "https://fc.lyz05.cn",
  "https://dmku.hls.one",
  "https://se.678.ooo",
  "https://danmu.56uxi.com",
  "https://dm.lxlad.com",
  "https://danmuapi.vercel.app",
];

const danmakuView = {
  settings: { ...DANMAKU_DEFAULTS },
  mapping: {},
  items: [],
  canvas: null,
  ctx: null,
  video: null,
  container: null,
  W: 0,
  H: 0,
  dpr: 1,
  raf: 0,
  fileId: 0,
  animeId: 0,
  animeName: "",
  episode: 0,
  source: "",
  sourceNote: "还没有加载弹幕",
  onlineCandidates: [],
};

function dmLoadPrefs() {
  try {
    const raw = JSON.parse(localStorage.getItem(DANMAKU_SETTINGS_KEY) || "{}");
    if (raw && typeof raw === "object") {
      Object.keys(DANMAKU_DEFAULTS).forEach((key) => {
        if (raw[key] !== undefined && raw[key] !== null) danmakuView.settings[key] = raw[key];
      });
    }
  } catch (error) { /* 坏掉的本地设置不值得打断播放 */ }
  try {
    const raw = JSON.parse(localStorage.getItem(DANMAKU_MAPPING_KEY) || "{}");
    if (raw && typeof raw === "object") danmakuView.mapping = raw;
  } catch (error) { /* 同上 */ }
}

function dmSavePrefs() {
  try { localStorage.setItem(DANMAKU_SETTINGS_KEY, JSON.stringify(danmakuView.settings)); } catch (error) { /* 无痕模式 */ }
}

function dmSaveMapping() {
  try { localStorage.setItem(DANMAKU_MAPPING_KEY, JSON.stringify(danmakuView.mapping)); } catch (error) { /* 无痕模式 */ }
}

function dmParseText(text) {
  const stripped = String(text || "").replace(/^\uFEFF/, "").trim();
  if (stripped.startsWith("<")) {
    const items = [];
    const pattern = /<d\s+p=["']([^"']*)["'][^>]*>([\s\S]*?)<\/d>/gi;
    let match;
    while ((match = pattern.exec(stripped)) !== null) {
      const fields = match[1].split(",");
      const time = Number(fields[0]);
      if (!Number.isFinite(time)) continue;
      const content = match[2].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
      if (!content) continue;
      let mode = Number(fields[1]) || 1;
      if (![1, 4, 5, 6, 7, 8].includes(mode)) mode = 1;
      let color = "#ffffff";
      const numeric = Number(fields[3]);
      if (Number.isFinite(numeric)) color = `#${(numeric & 0xffffff).toString(16).padStart(6, "0")}`;
      const size = Math.max(12, Math.min(48, Number(fields[2]) || 25));
      items.push({ time, mode, color, size, text: content.slice(0, 200) });
    }
    return items;
  }
  let payload;
  try { payload = JSON.parse(stripped); } catch (error) { return []; }
  const list = Array.isArray(payload)
    ? payload
    : (payload.comments || payload.danmaku || payload.items || []);
  if (!Array.isArray(list)) return [];
  return list.map((entry) => {
    if (!entry || typeof entry !== "object") return null;
    let time, mode, color = "#ffffff";
    if (entry.p !== undefined) {
      const fields = String(entry.p).split(",");
      time = Number(fields[0]);
      mode = Number(fields[1]) || 1;
      const numeric = Number(fields[2]);
      if (Number.isFinite(numeric)) color = `#${(numeric & 0xffffff).toString(16).padStart(6, "0")}`;
    } else {
      time = Number(entry.time);
      mode = Number(entry.mode) || 1;
      if (/^#[0-9a-fA-F]{6}$/.test(String(entry.color || ""))) color = entry.color;
    }
    const text = String(entry.m || entry.text || "").replace(/\s+/g, " ").trim();
    if (!Number.isFinite(time) || !text) return null;
    return { time, mode: [1, 4, 5, 6, 7, 8].includes(mode) ? mode : 1, color,
      size: 25, text: text.slice(0, 200) };
  }).filter(Boolean);
}

function dmShieldWords() {
  return String(danmakuView.settings.shield || "")
    .split(/[,，\s]+/).map((word) => word.trim()).filter(Boolean);
}

function dmShielded(text, words) {
  return words.some((word) => text.toLowerCase().includes(word.toLowerCase()));
}

function dmMineItems() {
  try {
    const raw = JSON.parse(localStorage.getItem("handbook.danmaku.mine") || "{}");
    const list = raw[danmakuView.mineKey];
    return Array.isArray(list) ? list : [];
  } catch (error) {
    return [];
  }
}

function dmSetItems(items, source, note) {
  const words = dmShieldWords();
  // 自己发过的弹幕一直都在：换源、重载后也合并回来。
  const mine = dmMineItems();
  danmakuView.items = (Array.isArray(items) ? items : []).concat(mine)
    .filter((item) => item && Number.isFinite(Number(item.time)) && item.text)
    .map((item) => ({
      time: Number(item.time),
      mode: Number(item.mode) || 1,
      color: /^#[0-9a-fA-F]{6}$/.test(String(item.color || "")) ? item.color : "#ffffff",
      size: Number(item.size) || 25,
      text: String(item.text).slice(0, 200),
      lane: -1,
    }))
    .filter((item) => !dmShielded(item.text, words))
    .sort((a, b) => a.time - b.time);
  danmakuView.source = source;
  danmakuView.sourceNote = note || (danmakuView.items.length ? `已加载 ${danmakuView.items.length} 条弹幕` : "没有弹幕");
  dmAssignLanes();
  dmRenderPanelStatus();
}

// 发送弹幕：没有弹幕服务器，只进本机画面并存进 localStorage（换集/重启都在）。
function dmSendMine(text) {
  const clean = String(text || "").trim().slice(0, 100);
  if (!clean || !danmakuView.video || !danmakuView.mineKey) return false;
  const time = Number(danmakuView.video.currentTime) || 0;
  const item = { time, mode: 1, color: "#ffffff", size: 25, text: clean, lane: -1 };
  danmakuView.items = [...danmakuView.items, item].sort((a, b) => a.time - b.time);
  dmAssignLanes();
  dmRenderPanelStatus();
  try {
    const raw = JSON.parse(localStorage.getItem("handbook.danmaku.mine") || "{}");
    const key = danmakuView.mineKey;
    const list = Array.isArray(raw[key]) ? raw[key] : [];
    list.push({ time, mode: 1, color: "#ffffff", size: 25, text: clean });
    raw[key] = list.slice(-500);
    localStorage.setItem("handbook.danmaku.mine", JSON.stringify(raw));
  } catch (error) { /* 存不上就只在本局显示 */ }
  return true;
}

function dmFontFor(item) {
  const s = danmakuView.settings;
  const size = Math.max(13, Math.min(52, Math.round(s.fontSize * (item.size || 25) / 25)));
  return { size, css: `${s.bold ? "700" : "500"} ${size}px "Microsoft YaHei", "PingFang SC", sans-serif` };
}

function dmTextWidth(item, ctx) {
  ctx.font = dmFontFor(item).css;
  return ctx.measureText(item.text).width;
}

// 轨道预分配：同一条轨道上，上一条弹幕的尾部完全进入画面之后才允许放下一条。
// 位置由 currentTime 现算，所以拖动进度条也不需要重建状态。
function dmAssignLanes() {
  const s = danmakuView.settings;
  const W = danmakuView.W || 960;
  const H = danmakuView.H || 540;
  const ctx = danmakuView.ctx;
  if (!ctx) return;
  const laneHeight = s.fontSize * 1.4;
  const laneCount = Math.max(2, Math.floor((H * s.area) / laneHeight));
  const speed = (W + 260) / Math.max(2, s.duration);
  // 最上面一条轨道留给顶部固定弹幕，最下面留给底部固定弹幕，
  // 滚动弹幕从第二条开始——否则两种弹幕会抢 lane 0，文字叠成一团。
  const rolling = new Array(Math.max(1, laneCount - 1)).fill(-Infinity);
  const topLanes = new Array(1).fill(-Infinity);
  const bottomLanes = new Array(1).fill(-Infinity);
  danmakuView.items.forEach((item) => {
    item.lane = -1;
    if (item.mode !== 1 && !s.topBottom) return;
    const lanes = item.mode === 1 ? rolling : (item.mode === 5 ? topLanes : bottomLanes);
    const width = dmTextWidth(item, ctx);
    const gap = item.mode === 1 ? width / Math.max(speed, 1) + 0.2 : 4.2;
    for (let i = 0; i < lanes.length; i += 1) {
      if (item.time >= lanes[i]) {
        item.lane = i;
        lanes[i] = item.time + gap;
        break;
      }
    }
  });
  danmakuView.laneHeight = laneHeight;
}

function dmResize(force) {
  const video = danmakuView.video;
  const canvas = danmakuView.canvas;
  if (!video || !canvas) return;
  const width = Math.max(1, Math.round(video.clientWidth));
  const height = Math.max(1, Math.round(video.clientHeight));
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  if (!force && width === danmakuView.W && height === danmakuView.H && dpr === danmakuView.dpr) return;
  danmakuView.W = width;
  danmakuView.H = height;
  danmakuView.dpr = dpr;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  danmakuView.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  dmAssignLanes();
}

function dmLowerBound(time) {
  const items = danmakuView.items;
  let left = 0;
  let right = items.length;
  while (left < right) {
    const middle = (left + right) >> 1;
    if (items[middle].time < time) left = middle + 1;
    else right = middle;
  }
  return left;
}

function dmDraw(ctx, item, x, y) {
  ctx.font = dmFontFor(item).css;
  ctx.textBaseline = "top";
  ctx.lineWidth = 2.2;
  ctx.strokeStyle = "rgba(0,0,0,.82)";
  ctx.strokeText(item.text, x, y);
  ctx.fillStyle = item.color;
  ctx.fillText(item.text, x, y);
}

function dmFrame() {
  danmakuView.raf = window.requestAnimationFrame(dmFrame);
  const video = danmakuView.video;
  const ctx = danmakuView.ctx;
  if (!video || !ctx) return;
  dmResize(false);
  const W = danmakuView.W;
  const H = danmakuView.H;
  ctx.clearRect(0, 0, W, H);
  const s = danmakuView.settings;
  if (!s.enabled || !danmakuView.items.length || !Number.isFinite(video.currentTime)) return;
  const now = video.currentTime;
  const fixedDuration = 4;
  const windowStart = now - Math.max(s.duration, fixedDuration) - 0.2;
  const start = dmLowerBound(windowStart);
  const end = dmLowerBound(now + 0.02);
  const laneHeight = danmakuView.laneHeight || s.fontSize * 1.4;
  ctx.globalAlpha = Number(s.opacity) || 1;
  let drawn = 0;
  for (let i = start; i < end; i += 1) {
    const item = danmakuView.items[i];
    if (item.lane < 0) continue;
    const age = now - item.time;
    let x = 0;
    let y = 0;
    if (item.mode === 1) {
      if (age < 0 || age > s.duration) continue;
      const width = dmTextWidth(item, ctx);
      x = W - (age / s.duration) * (W + width);
      y = (item.lane + 1) * laneHeight + 4;
    } else {
      if (age < 0 || age > fixedDuration) continue;
      const width = dmTextWidth(item, ctx);
      x = (W - width) / 2;
      y = item.mode === 5 ? 4 : H - laneHeight - 8;
    }
    if (s.density > 0 && drawn >= s.density) break;
    dmDraw(ctx, item, x, y);
    drawn += 1;
  }
  ctx.globalAlpha = 1;
}

function dmStart() {
  if (!danmakuView.raf) danmakuView.raf = window.requestAnimationFrame(dmFrame);
  dmResize(true);
}

function dmStop() {
  if (danmakuView.raf) window.cancelAnimationFrame(danmakuView.raf);
  danmakuView.raf = 0;
  if (danmakuView.ctx) danmakuView.ctx.clearRect(0, 0, danmakuView.W, danmakuView.H);
}

function dmBaseCandidates() {
  const s = danmakuView.settings;
  if (s.sourceMode === "dandanplay") return [s.onlineBase || "https://api.dandanplay.net"];
  if (s.sourceMode === "custom") return [s.onlineBase].filter(Boolean);
  const remembered = s.publicBase && DANMAKU_PUBLIC_BASES.includes(s.publicBase) ? [s.publicBase] : [];
  return [...remembered, ...DANMAKU_PUBLIC_BASES.filter((base) => base !== s.publicBase)];
}

async function dmProxy(apiPath, validateText) {
  const s = danmakuView.settings;
  const bases = dmBaseCandidates();
  if (!bases.length) throw new Error("还没填弹幕服务地址");
  let lastError = null;
  for (const base of bases) {
    try {
      const response = await fetch("/api/danmaku/proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          base,
          path: apiPath,
          app_id: s.sourceMode === "dandanplay" ? (s.appId || "") : "",
          app_secret: s.sourceMode === "dandanplay" ? (s.appSecret || "") : "",
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.ok === false) throw new Error(payload.error || "弹幕服务没有响应");
      const text = payload.text || "";
      // 公共源可能是「活着但内容不对」（维护页/空结果），换下一个前先验货。
      if (validateText && !validateText(text)) throw new Error("这个源没返回有效数据");
      if (s.sourceMode === "public" && base !== s.publicBase) {
        s.publicBase = base;
        dmSavePrefs();
      }
      return text;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`${lastError ? lastError.message : "连不上"}（已试过 ${bases.length} 个公共源）`);
}

function dmMappingKey() {
  return danmakuView.animeId
    ? `${danmakuView.animeId}:${danmakuView.episode || 0}`
    : danmakuView.mineKey;
}

function dmEpisodeNumber(file) {
  const parts = String(file?.episode_key || "").split(":");
  if (parts.length === 2 && /^\d+$/.test(parts[1])) return Number(parts[1]);
  const match = String(file?.episode_key || "").match(/(\d+)/);
  return match ? Number(match[1]) : 0;
}

let dmLoadVersion = 0;

async function dmLoadOnline(episodeId, version = dmLoadVersion) {
  const text = await dmProxy(`/api/v2/comment/${encodeURIComponent(episodeId)}?format=json`,
    (text) => { try { return ((JSON.parse(text).comments) || []).length > 0; } catch (error) { return false; } });
  const items = dmParseText(text);
  if (!items.length) throw new Error("这个分集没有返回弹幕");
  if (version !== dmLoadVersion) return false;
  dmSetItems(items, "online", `在线弹幕已加载 ${items.length} 条`);
  return items.length;
}

// 打开一集时调用：先找同目录弹幕文件，再试已经匹配过的在线分集，都没有就等用户操作。
async function dmLoadFor(file, animeName, animeId, onlineKey = "") {
  const version = ++dmLoadVersion;
  danmakuView.episodeContext = { file, animeName, animeId, onlineKey };
  danmakuView.fileId = Number(file?.id) || 0;
  danmakuView.mineKey = onlineKey || String(danmakuView.fileId);
  danmakuView.animeName = String(animeName || "");
  danmakuView.animeId = Number(animeId) || 0;
  danmakuView.episode = dmEpisodeNumber(file);
  danmakuView.onlineCandidates = [];
  document.getElementById("dmMatch")?.classList.add("hidden");
  document.getElementById("dmUseMatch")?.classList.add("hidden");
  dmSetItems([], "", "正在找这一集的弹幕…");
  dmStart();
  if (danmakuView.fileId) {
    try {
      const response = await fetch(`/api/danmaku/local?file_id=${danmakuView.fileId}`);
      const payload = await response.json().catch(() => ({}));
      if (version !== dmLoadVersion) return;
      const local = payload.items || [];
      if (local.length) {
        dmSetItems(local, "local", `同目录弹幕文件 · ${local.length} 条`);
        return;
      }
    } catch (error) {
      console.warn("本地弹幕读取失败：", error);
    }
  }
  if (version !== dmLoadVersion) return;
  const episodeId = danmakuView.mapping[dmMappingKey()];
  if (episodeId) {
    try {
      await dmLoadOnline(episodeId, version);
      return;
    } catch (error) {
      console.warn("在线弹幕加载失败：", error);
    }
  }
  if (version === dmLoadVersion)
    dmSetItems([], "", onlineKey ? "可搜索在线弹幕或导入 .xml / .json" : dmNoSourceNote());
}

function dmNoSourceNote() {
  const s = danmakuView.settings;
  if (s.sourceMode === "public") {
    return "这一集没有本地弹幕文件；公共弹幕源这会儿可能不可用（按钮已自动试过全部候选），可在「在线弹幕源」里换官方源，或导入 .xml / .json";
  }
  return "这一集没有本地弹幕文件；点「搜索在线弹幕」或导入 .xml / .json";
}

function dmClear() {
  dmLoadVersion++;
  danmakuView.mineKey = "";
  danmakuView.episodeContext = null;
  dmStop();
  dmSetItems([], "", "还没有加载弹幕");
  danmakuView.fileId = 0;
}

function dmRenderPanelStatus() {
  const node = document.getElementById("dmSource");
  if (node) node.textContent = danmakuView.sourceNote;
  const count = document.getElementById("dmCount");
  if (count) count.textContent = danmakuView.items.length ? `${danmakuView.items.length} 条` : "0 条";
  const toggle = document.getElementById("offlineDanmakuToggle");
  if (toggle) {
    const on = Boolean(danmakuView.settings.enabled);
    // Kazumi 式：纯图标按钮，角标（对勾）随开关显隐，不写文字节点。
    toggle.setAttribute("aria-pressed", String(on));
    toggle.classList.toggle("is-off", !on);
    const input = document.getElementById("dmSendInput");
    if (input) {
      input.placeholder = on ? "发个友善的弹幕见证当下" : "已关闭弹幕";
      input.disabled = !on;
    }
    const send = document.getElementById("dmSendButton");
    if (send) send.disabled = !on;
  }
}

function dmToggle() {
  danmakuView.settings.enabled = !danmakuView.settings.enabled;
  dmSavePrefs();
  dmRenderPanelStatus();
}

function dmSyncControls() {
  const s = danmakuView.settings;
  const values = {
    dmEnabled: s.enabled, dmFontSize: s.fontSize, dmDuration: s.duration,
    dmOpacity: s.opacity, dmArea: s.area, dmDensity: s.density,
    dmBold: s.bold, dmTopBottom: s.topBottom, dmShield: s.shield,
    dmBase: s.onlineBase, dmAppId: s.appId, dmAppSecret: s.appSecret,
    dmSourceMode: s.sourceMode,
  };
  Object.entries(values).forEach(([id, value]) => {
    const node = document.getElementById(id);
    if (!node) return;
    if (node.type === "checkbox") node.checked = Boolean(value);
    else node.value = value;
  });
  ["dmFontSize", "dmDuration", "dmOpacity", "dmArea", "dmDensity"].forEach((id) => {
    const label = document.getElementById(`${id}Value`);
    if (label) label.textContent = String(valueFor(id));
  });
  dmRenderPanelStatus();
}

function valueFor(id) {
  const s = danmakuView.settings;
  return ({ dmFontSize: s.fontSize, dmDuration: s.duration, dmOpacity: s.opacity,
    dmArea: s.area, dmDensity: s.density })[id] || "";
}

function dmBindSetting(id, key, transform) {
  const node = document.getElementById(id);
  if (!node) return;
  const handler = () => {
    const raw = node.type === "checkbox" ? node.checked : node.value;
    danmakuView.settings[key] = transform ? transform(raw) : raw;
    dmSavePrefs();
    const label = document.getElementById(`${id}Value`);
    if (label) label.textContent = String(danmakuView.settings[key]);
    if (["dmFontSize", "dmDuration", "dmArea", "dmShield", "dmEnabled"].includes(id)) dmAssignLanes();
    dmRenderPanelStatus();
  };
  node.addEventListener("change", handler);
  if (node.type === "range") node.addEventListener("input", handler);
}

function dmEscape(text) {
  if (typeof escapeHtml === "function") return escapeHtml(text);
  return String(text).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

async function dmSearchOnline() {
  const version = dmLoadVersion;
  const button = document.getElementById("dmOnlineSearch");
  const select = document.getElementById("dmMatch");
  if (!danmakuView.animeName) { dmSetNote("缺少番剧名称，没法搜索在线弹幕"); return; }
  if (button) button.disabled = true;
  dmSetNote("正在搜索在线弹幕…");
  try {
    const text = await dmProxy(`/api/v2/search/episodes?anime=${encodeURIComponent(danmakuView.animeName)}`,
      (text) => { try { return ((JSON.parse(text).animes) || []).length > 0; } catch (error) { return false; } });
    if (version !== dmLoadVersion) return;
    let payload;
    try { payload = JSON.parse(text); } catch (error) { throw new Error("弹幕服务返回的不是 JSON"); }
    const animes = Array.isArray(payload) ? payload : (payload.animes || payload.results || []);
    const flat = [];
    animes.forEach((anime) => {
      const title = anime.animeTitle || anime.title || anime.name || "";
      (anime.episodes || []).forEach((episode) => {
        const id = episode.episodeId || episode.id;
        if (id) flat.push({ id, label: `${title} · ${episode.episodeTitle || episode.title || id}` });
      });
    });
    danmakuView.onlineCandidates = flat;
    if (!flat.length) throw new Error("没搜到这部番的分集，换个关键词或检查服务配置");
    if (select) {
      const guess = flat.find((item) => new RegExp(`(^|\\D)0*${danmakuView.episode}(?!\\d)`).test(item.label));
      select.innerHTML = flat.map((item) =>
        `<option value="${dmEscape(String(item.id))}" ${item === guess ? "selected" : ""}>${dmEscape(item.label)}</option>`).join("");
      select.classList.remove("hidden");
    }
    dmSetNote(`搜到 ${flat.length} 个分集，选好这一集后点「用这个分集」`);
    document.getElementById("dmUseMatch")?.classList.remove("hidden");
  } catch (error) {
    if (version === dmLoadVersion) dmSetNote(`在线搜索失败：${error.message}`);
  } finally {
    if (button) button.disabled = false;
  }
}

function dmSetNote(text) {
  danmakuView.sourceNote = text;
  dmRenderPanelStatus();
}

async function dmUseMatch() {
  const version = dmLoadVersion;
  const select = document.getElementById("dmMatch");
  const id = select && select.value;
  if (!id) return;
  dmSetNote("正在拉取弹幕…");
  try {
    if (!await dmLoadOnline(id, version) || version !== dmLoadVersion) return;
    danmakuView.mapping[dmMappingKey()] = id;
    dmSaveMapping();
  } catch (error) {
    if (version === dmLoadVersion) dmSetNote(`拉弹幕失败：${error.message}`);
  }
}

function dmImportFile(file) {
  if (!file) return;
  const reader = new FileReader();
  const version = dmLoadVersion;
  reader.onload = () => {
    if (version !== dmLoadVersion) return;
    const items = dmParseText(String(reader.result || ""));
    if (!items.length) { dmSetNote("这个文件里没解析到弹幕（支持 B 站 XML 或弹弹play JSON）"); return; }
    dmSetItems(items, "import", `已导入 ${items.length} 条弹幕（来自 ${file.name}）`);
  };
  reader.onerror = () => { if (version === dmLoadVersion) dmSetNote("弹幕文件读取失败"); };
  reader.readAsText(file, "utf-8");
}

function initDanmaku() {
  dmLoadPrefs();
  danmakuView.video = document.getElementById("offlineVideo");
  danmakuView.canvas = document.getElementById("danmakuCanvas");
  danmakuView.container = document.getElementById("offlinePlayerVideoWrap");
  if (!danmakuView.video || !danmakuView.canvas) return;
  danmakuView.ctx = danmakuView.canvas.getContext("2d");
  const panel = document.getElementById("danmakuPanel");
  document.getElementById("offlineDanmakuToggle")?.addEventListener("click", dmToggle);
  document.getElementById("offlineDanmakuSettings")?.addEventListener("click", () => {
    panel?.classList.toggle("hidden");
    if (panel && !panel.classList.contains("hidden")) dmSyncControls();
  });
  document.getElementById("dmPanelClose")?.addEventListener("click", () => panel?.classList.add("hidden"));
  dmBindSetting("dmEnabled", "enabled");
  dmBindSetting("dmFontSize", "fontSize", Number);
  dmBindSetting("dmDuration", "duration", Number);
  dmBindSetting("dmOpacity", "opacity", Number);
  dmBindSetting("dmArea", "area", Number);
  dmBindSetting("dmDensity", "density", Number);
  dmBindSetting("dmBold", "bold");
  dmBindSetting("dmTopBottom", "topBottom");
  dmBindSetting("dmShield", "shield");
  dmBindSetting("dmBase", "onlineBase");
  dmBindSetting("dmAppId", "appId");
  dmBindSetting("dmAppSecret", "appSecret");
  dmBindSetting("dmSourceMode", "sourceMode");
  const applySourceMode = () => {
    const mode = danmakuView.settings.sourceMode || "public";
    document.getElementById("dmBase")?.classList.toggle("hidden", mode === "public");
    document.getElementById("dmOfficialFields")?.classList.toggle("hidden", mode !== "dandanplay");
    document.querySelectorAll(".danmaku-note").forEach((node) => {
      node.classList.toggle("hidden", node.dataset.note !== mode);
    });
  };
  applySourceMode();
  if (!initDanmaku.sourceModeBound) {
    initDanmaku.sourceModeBound = true;
    document.getElementById("dmSourceMode")?.addEventListener("change", applySourceMode);
  }
  document.getElementById("dmImport")?.addEventListener("click", () => document.getElementById("dmFile")?.click());
  document.getElementById("dmFile")?.addEventListener("change", (event) => {
    dmImportFile(event.target.files?.[0]);
    event.target.value = "";
  });
  document.getElementById("dmOnlineSearch")?.addEventListener("click", dmSearchOnline);
  document.getElementById("dmUseMatch")?.addEventListener("click", dmUseMatch);
  document.getElementById("dmReload")?.addEventListener("click", () => {
    const context = danmakuView.episodeContext;
    if (context) dmLoadFor(context.file, context.animeName, context.animeId, context.onlineKey);
  });
  window.addEventListener("resize", () => { if (danmakuView.W) dmResize(true); });
  // 原生 <video> 全屏时 canvas 不会跟着进去。改成让整个容器全屏，
  // 这样字幕 canvas、弹幕 canvas 和弹幕设置面板都在同一层里。
  document.addEventListener("fullscreenchange", () => {
    // 用户点原生全屏按钮时，浏览器只会把 <video> 本身送进全屏，弹幕/字幕 canvas
    // 留在页面里看不见。规范允许对已有全屏元素直接 requestFullscreen 来「替换」
    // 全屏元素，所以这里把容器直接切进去。不要先 exitFullscreen 再请求——
    // 过渡期里的第二次请求会被浏览器拒绝，结果视频退了、容器又没进去，
    // 全屏按钮看起来就是「点了没反应」。
    if (document.fullscreenElement === danmakuView.video && danmakuView.container) {
      danmakuView.container.requestFullscreen().catch((error) => {
        // 个别浏览器不接受「替换全屏元素」：退避一小段避开过渡期再走两步。
        console.warn("直接切容器全屏被拒，退避重试：", error);
        document.exitFullscreen()
          .then(() => new Promise((resolve) => window.setTimeout(resolve, 120)))
          .then(() => danmakuView.container.requestFullscreen())
          .catch((retryError) => console.warn("容器全屏没切过去，保留视频自身全屏：", retryError));
      });
    }
    window.setTimeout(() => dmResize(true), 60);
  });
  dmSyncControls();
}

document.addEventListener("DOMContentLoaded", initDanmaku);
