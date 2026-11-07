const DETAIL_LINK_PRESETS = [
  // 外链的箭头（↗）写在默认名称里，而不是渲染时硬拼上去：这样它在设置里
  // 就是名称的一部分，不想看就删掉，改完立刻生效（#8446 的原话是「默认在名字里，
  // 能自己删掉」）。
  { kind: "bgm", name: "Bangumi #{id} ↗", url: "{site}/subject/{id}", enabled: true },
  { kind: "bilibili", name: "B站搜索 ↗", url: "https://search.bilibili.com/all?keyword={title}", enabled: true },
];

function detailLinkId() {
  const cryptoObject = window.crypto;
  if (cryptoObject?.randomUUID) return cryptoObject.randomUUID();
  return `lnk${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeDetailLink(item) {
  if (!item || typeof item !== "object") return null;
  const name = String(item.name || "").trim();
  const url = String(item.url || "").trim();
  // 旧版本把没填 id 的预设存成了字符串 "undefined"：那会让「新增同步」和去重
  // 把它们当成同一条。这里直接当没 id，重新生成。
  const rawId = String(item.id || "").trim();
  const safeId = rawId === "undefined" ? "" : rawId;
  if (item.kind === "saved_video") {
    return { id: safeId || "saved-video", kind: "saved_video", name: name || "已存视频", url: "", enabled: item.enabled !== false };
  }
  // 总链接：点开弹出规则仓库里的站点列表，本身没有网址。
  if (item.kind === "rules_menu") {
    return { id: safeId || "rules-menu", kind: "rules_menu", name: name || "更多站点 \u25be", url: "", enabled: item.enabled !== false };
  }
  if (!name || !url) return null;
  return {
    id: safeId || detailLinkId(),
    kind: ["bgm", "bilibili"].includes(item.kind) ? item.kind : "custom",
    name,
    url,
    enabled: item.enabled !== false,
  };
}

// 详情页那一行链接：预设的 BGM / B站 也是列表里的普通条目，可以改名、改网址、排序或删除。
// 「已存视频」和「更多站点」是两条内置入口：可以排序、改名、隐藏，但没有自己的网址。
// 默认只开 Bangumi、B站、更多站点三条；「已存视频」默认关闭，需要时自己勾。
function withBuiltinDetailLinks(links) {
  const list = (links || []).filter(Boolean);
  const result = list.some((link) => link.kind === "saved_video")
    ? list
    : [...list, { id: "saved-video", kind: "saved_video", name: "已存视频", url: "", enabled: false }];
  if (result.some((link) => link.kind === "rules_menu")) return result;
  return [...result, { id: "rules-menu", kind: "rules_menu", name: "更多站点 \u25be", url: "", enabled: true }];
}

function detailLinks() {
  const saved = state.settings.detail_links;
  if (Array.isArray(saved)) return withBuiltinDetailLinks(saved.map(normalizeDetailLink).filter(Boolean));
  const legacy = Array.isArray(state.settings.custom_search_links) ? state.settings.custom_search_links : [];
  return withBuiltinDetailLinks([
    { ...DETAIL_LINK_PRESETS[0], id: detailLinkId() },
    { ...DETAIL_LINK_PRESETS[1], id: detailLinkId(), enabled: enabledSetting("show_bilibili_search_button") },
    ...legacy.map((item) => normalizeDetailLink({ ...item, kind: "custom" })).filter(Boolean),
  ]);
}

// 周表卡片详情用同一套条目结构，只是独立保存、独立开关。
function scheduleDetailLinks() {
  const saved = state.settings.schedule_detail_links;
  if (Array.isArray(saved)) return saved.map(normalizeDetailLink).filter(Boolean);
  // 预设本身没有 id，这里补一个：不然存下去就是字符串 "undefined"。
  return DETAIL_LINK_PRESETS.map((preset) => ({ ...preset, id: detailLinkId() }));
}

// 统一把条目变成可点的链接；占位符取不到值时（例如没有 Bangumi 编号）跳过这一条。
function buildDetailLinkItems(links, values) {
  const items = [];
  (links || []).forEach((link) => {
    if (!link.enabled) return;
    if (link.url.includes("{id}") && !values.id) return;
    if ((link.url.includes("{title}") || link.name.includes("{title}")) && !values.title) return;
    items.push({
      kind: link.kind,
      label: detailLinkLabel(link.name, values),
      href: detailLinkHref(link.url, values),
    });
  });
  return items;
}

function detailLinkHref(template, values) {
  return String(template)
    .split("{site}").join(values.site)
    .split("{id}").join(String(values.id ?? ""))
    .split("{title}").join(encodeURIComponent(values.title));
}

function detailLinkLabel(name, values) {
  return String(name)
    .split("{id}").join(String(values.id ?? ""))
    .split("{title}").join(values.title)
    .split("{site}").join(values.site);
}

function renderDetailLinks(anime, preferred = null) {
  const box = $("#detailLinks");
  if (!box || !anime) return;
  box.replaceChildren();
  const title = String(anime.name_cn || anime.name || anime.display_name || "").trim();
  const site = String(state.settings.bgm_site_base || "https://bgm.tv").replace(/\/+$/, "");
  const merged = state.settings.merge_bilibili_links === true;
  const values = { id: anime.id, title, site };
  detailLinks().forEach((link) => {
    if (!link.enabled) return;
    if (link.kind === "rules_menu") {
      // 用真 <a> 而不是 <button>：中键新标签、右键复制地址都是浏览器原生行为。
      // href 指向本页的 #rules-menu 哈希——在新标签里打开时，rules-menu.js
      // 会在启动后读这个哈希并自动弹出同一个站点菜单。
      const anchor = document.createElement("a");
      anchor.className = "detail-link-menu";
      anchor.textContent = detailLinkLabel(link.name, values) || "更多站点";
      anchor.setAttribute("aria-haspopup", "dialog");
      anchor.href = `#rules-menu=${encodeURIComponent(JSON.stringify({
        id: anime?.id ?? null,
        title,
        site: values.site,
      }))}`;
      // 左键仍然走应用内的站点菜单（弹窗比新开一页快）；中键/右键不拦，交给浏览器。
      anchor.onclick = (event) => {
        event.preventDefault();
        if (typeof openRulesMenu === "function") openRulesMenu(anime, preferred, values);
      };
      box.append(anchor);
      return;
    }
    if (link.kind === "saved_video") {
      const anchor = document.createElement("a");
      anchor.id = "savedVideoDefaultLink";
      anchor.target = "_blank";
      anchor.rel = "noreferrer";
      anchor.textContent = detailLinkLabel(link.name, values);
      if (preferred) {
        anchor.href = bilibiliResumeUrl(preferred, anime);
        anchor.savedVideoItem = preferred;
        anchor.dataset.videoResumeUrl = preferred.url;
        anchor.onclick = () => typeof recordJump === "function" && recordJump({
          anime_id: anime?.id || null,
          anime_name: anime?.display_name || anime?.name_cn || "",
          title: preferred.title,
          url: anchor.href,
          kind: preferred.kind || "video",
        });
      } else {
        anchor.classList.add("hidden");
      }
      box.append(anchor);
      return;
    }
    if (link.url.includes("{id}") && !values.id) return;
    if ((link.url.includes("{title}") || link.name.includes("{title}")) && !values.title) return;
    if (merged && preferred && link.kind === "bilibili") return;
    const anchor = document.createElement("a");
    anchor.className = "detail-link";
    anchor.dataset.detailLinkKind = link.kind;
    anchor.target = "_blank";
    anchor.rel = "noreferrer";
    anchor.textContent = detailLinkLabel(link.name, values);
    anchor.href = detailLinkHref(link.url, values);
    box.append(anchor);
  });
}

function bilibiliResumeUrl(item, anime) {
  const original = String(item?.url || "");
  if (!anime || (item.kind || "video") !== "video") return original;
  let url;
  try { url = new URL(original); } catch { return original; }
  const official = /^\/bangumi\/play\/(?:ss|ep)[1-9][0-9]{0,11}\/?$/.test(url.pathname);
  if (url.protocol !== "https:" || !["www.bilibili.com", "bilibili.com"].includes(url.hostname)
      || (!official && !/^\/video\/BV[0-9A-Za-z]{10}\/?$/.test(url.pathname))) return original;
  // Resolve chapter identities rather than counting watched items (OP/ED and
  // gaps must not move a main episode to the wrong part).
  const main = (Array.isArray(anime.episodes) ? anime.episodes : [])
    .filter(episode => Number(episode.type || 0) === 0)
    .map(episode => ({key: String(episode.key), number: Number(episode.sort ?? episode.ep ?? episode.label)}))
    .filter(episode => Number.isInteger(episode.number) && episode.number > 0 && episode.number <= 10000)
    .sort((a, b) => a.number - b.number);
  if (!main.length) return original;
  const selected = state.progressAnime?.id === anime.id && state.pendingEpisodes instanceof Set
    ? state.pendingEpisodes : (anime.watched_episode_keys || anime.watched_episodes || []);
  const watched = new Set([...selected].map(String));
  const next = main.find(episode => !watched.has(episode.key)) || main.at(-1);
  if (official) {
    const target = item.episode_urls?.[String(next.number)];
    if (typeof target !== "string" || !/^https:\/\/www\.bilibili\.com\/bangumi\/play\/ep[1-9][0-9]{0,11}$/.test(target)) return original;
    return target;
  }
  url.searchParams.set("p", String(next.number));
  url.searchParams.delete("t");
  url.searchParams.delete("start_progress");
  return url.href;
}

function refreshSavedVideoTargets() {
  const anime = state.progressAnime;
  if (!anime) return;
  document.querySelectorAll("[data-video-resume-url]").forEach(anchor => {
    anchor.href = bilibiliResumeUrl(anchor.savedVideoItem || {url: anchor.dataset.videoResumeUrl, kind: "video"}, anime);
  });
}

function renderBilibiliEntrypoints(anime, preferred = null) {
  // 已存视频的入口由 renderDetailLinks 按设置里的顺序插入，不再固定追加在末尾。
  renderDetailLinks(anime, preferred);
}

let videoLinksLoadVersion = 0;

function savedLinkHost(url) {
  try { return new URL(String(url || "")).hostname.replace(/^www\./, ""); } catch { return ""; }
}

function savedVideoRow(item) {
  return `<article class="saved-video-row">
      <a class="saved-video-open" data-video-resume-url="${escapeHtml(item.url)}" href="${escapeHtml(bilibiliResumeUrl(item, state.progressAnime))}" target="_blank" rel="noreferrer">
        <span class="saved-video-play" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m9 6 9 6-9 6z"/></svg></span>
        <span class="saved-video-copy"><span class="saved-video-title">${escapeHtml(item.title)}</span>${item.uploader || item.note ? `<span class="saved-video-meta">${escapeHtml([item.uploader,item.note].filter(Boolean).join(" · "))}</span>` : ""}</span>
      </a>
      <div class="saved-video-actions">${item.is_default ? `<span class="saved-video-badge">默认</span><button type="button" class="saved-video-action" data-video-action="unset_default" data-video-id="${item.id}">取消默认</button>` : `<button type="button" class="saved-video-action" data-video-action="default" data-video-id="${item.id}">设为默认</button>`}<button type="button" class="saved-video-action" data-video-action="delete" data-video-id="${item.id}" aria-label="移除视频：${escapeHtml(item.title)}">移除</button></div>
    </article>`;
}

function savedLinkRow(item) {
  const meta = [savedLinkHost(item.url), item.note].filter(Boolean).join(" · ");
  return `<article class="saved-video-row">
      <a class="saved-video-open" href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">
        <span class="saved-link-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M10.6 13.4a4 4 0 0 0 5.7 0l2.3-2.3a4 4 0 1 0-5.7-5.7l-1.2 1.2"/><path d="M13.4 10.6a4 4 0 0 0-5.7 0l-2.3 2.3a4 4 0 1 0 5.7 5.7l1.2-1.2"/></svg></span>
        <span class="saved-video-copy"><span class="saved-video-title">${escapeHtml(item.title)}</span>${meta ? `<span class="saved-video-meta">${escapeHtml(meta)}</span>` : ""}</span>
      </a>
      <div class="saved-video-actions"><button type="button" class="saved-video-action" data-video-action="delete" data-video-id="${item.id}" aria-label="移除链接：${escapeHtml(item.title)}">移除</button></div>
    </article>`;
}

function bindSavedActions(panel, animeId, result) {
  panel.querySelectorAll("[data-video-action]").forEach(button => button.addEventListener("click", async () => {
    const removing = button.dataset.videoAction === "delete";
    if (removing && !confirm("移除这个已存条目？")) return;
    if(button.dataset.videoAction === "unset_default" && !result.features?.optional_video_default) {
      toast("当前运行的是旧后台，尚不支持取消默认。请关闭手账后台，再通过启动快捷方式打开并刷新页面。", "error");return;
    }
    button.disabled = true;
    try {
      await api("/api/video-links", {method:"POST",body:JSON.stringify({anime_id:animeId,scope:result.scope,action:button.dataset.videoAction,id:Number(button.dataset.videoId)})});
      if (state.progressAnime?.id === animeId) renderVideoLinks(animeId);
    } catch (error) { toast(error.message,"error"); button.disabled=false; }
  }));
}

async function renderVideoLinks(animeId) {
  const version = ++videoLinksLoadVersion;
  const panel = $("#savedVideoLinks");
  const section = $("#savedVideoSection");
  const linkPanel = $("#savedLinks");
  const linkSection = $("#savedLinkSection");
  section.classList.add("hidden");
  linkSection?.classList.add("hidden");
  renderBilibiliEntrypoints(state.progressAnime);
  panel.textContent = "正在读取已存视频…";
  if (linkPanel) linkPanel.textContent = "正在读取已存链接…";
  try {
    const result = await api(`/api/video-links?anime_id=${animeId}`);
    if (version !== videoLinksLoadVersion || state.progressAnime?.id !== animeId) return;
    const videos = result.items.filter(item => (item.kind || "video") === "video");
    const links = result.items.filter(item => item.kind === "link");
    const preferred = videos.find(item => item.is_default);
    renderBilibiliEntrypoints(state.progressAnime,preferred);
    // 普通链接不算“已存视频”，单独一块显示，顶部快捷入口也只指向默认视频。
    section.classList.toggle("hidden", !enabledSetting("show_saved_video_list") || !videos.length);
    panel.innerHTML = videos.map(savedVideoRow).join("");
    if (linkSection) {
      linkSection.classList.toggle("hidden", !enabledSetting("show_saved_video_list") || !links.length);
      linkPanel.innerHTML = links.map(savedLinkRow).join("");
    }
    bindSavedActions(panel, animeId, result);
    if (linkPanel) bindSavedActions(linkPanel, animeId, result);
    // 点开已存视频/链接时记一笔跳转记录，方便下次直接从这里打开。
    const anime = state.progressAnime || {};
    const remember = (item, url) => typeof recordJump === "function" && recordJump({
      anime_id: animeId,
      anime_name: anime.display_name || anime.name_cn || "",
      title: item.title,
      url,
      kind: item.kind || "video",
    });
    panel.querySelectorAll(".saved-video-open").forEach((anchor, index) => {
      anchor.savedVideoItem = videos[index];
      if (videos[index]) anchor.addEventListener("click", () => remember(videos[index], anchor.href));
    });
    linkPanel?.querySelectorAll(".saved-video-open").forEach((anchor, index) => {
      if (links[index]) anchor.addEventListener("click", () => remember(links[index], anchor.href));
    });
  } catch(error) {
    if (version === videoLinksLoadVersion) {
      panel.textContent = `已存视频暂不可用：${error.message}`;
      if (linkPanel) linkPanel.textContent = "";
    }
  }
}
window.addEventListener("focus", () => {
  if (state.progressAnime && $("#progressModal")?.open) renderVideoLinks(state.progressAnime.id);
});

function parseVideoCapture(fragment) {
  if (!fragment.startsWith("#save-video=")) return null;
  const payload=JSON.parse(decodeURIComponent(fragment.slice("#save-video=".length)));
  const url=new URL(payload.url);
  const isVideo=url.protocol==="https:" && ["www.bilibili.com","bilibili.com"].includes(url.hostname) && !url.username && !url.password && !url.port && /^(?:\/video\/BV[0-9A-Za-z]{10}|\/bangumi\/play\/(?:ss|ep)[1-9][0-9]{0,11})\/?$/.test(url.pathname);
  if (!isVideo) {
    // 非 B 站视频：可以当作普通链接保存，但地址必须是 http(s)。
    if (!["https:","http:"].includes(url.protocol)) throw Error("只能保存 http 或 https 链接");
    if (payload.kind !== "link") throw Error("无效的 B 站视频地址");
    return {kind:"link",url:url.href,title:String(payload.title||"外部链接").slice(0,200),uploader:"",anime_id:Number(payload.anime_id)||null};
  }
  return {kind:"video",url:url.href,title:String(payload.title||"B站视频").slice(0,200),uploader:String(payload.uploader||"").slice(0,100),anime_id:Number(payload.anime_id)||null};
}
let videoAnimePickerController=null;
function createVideoAnimePicker(animes, preferredId, dialog, onSelect = () => {}) {
  videoAnimePickerController?.abort();
  const root=$("#videoAnimePicker"),input=$("#videoCaptureSearch"),value=$("#videoCaptureAnime"),list=$("#videoAnimeOptions");
  const controller=new AbortController(),options={signal:controller.signal};
  videoAnimePickerController=controller;
  let matches=[],active=-1;
  const hide=()=>{list.hidden=true;input.setAttribute("aria-expanded","false");input.removeAttribute("aria-activedescendant");};
  const highlight=()=>{
    [...list.children].forEach((node,i)=>node.classList.toggle("highlighted",i===active));
    const node=list.children[active];
    if(node){input.setAttribute("aria-activedescendant",node.id);node.scrollIntoView({block:"nearest"});}
  };
  const choose=anime=>{value.value=String(anime.id);input.value=anime.name;input.setCustomValidity("");hide();onSelect(anime.id);};
  const show=(query="")=>{
    matches=animes.filter(a=>a.name.toLowerCase().includes(query.trim().toLowerCase()));active=-1;
    list.replaceChildren();
    matches.forEach((anime,i)=>{
      const item=document.createElement("div");item.id=`video-anime-option-${i}`;item.setAttribute("role","option");item.setAttribute("aria-selected",String(String(anime.id)===value.value));item.textContent=anime.name;
      item.addEventListener("pointerdown",event=>event.preventDefault());item.addEventListener("click",()=>choose(anime));list.append(item);
    });
    if(!matches.length){const empty=document.createElement("div");empty.className="video-anime-empty";empty.textContent="没有匹配的番剧";list.append(empty);}
    list.hidden=false;input.setAttribute("aria-expanded","true");input.removeAttribute("aria-activedescendant");
  };
  input.value="";value.value="";input.setCustomValidity("请从下拉选项中选择番剧");
  const preferred=animes.find(a=>a.id===preferredId);if(preferred)choose(preferred);
  input.addEventListener("focus",()=>show(),options);
  input.addEventListener("click",()=>{if(list.hidden)show();},options);
  input.addEventListener("input",()=>{value.value="";onSelect(null);input.setCustomValidity("请从下拉选项中选择番剧");show(input.value);},options);
  input.addEventListener("keydown",event=>{
    if(event.isComposing)return;
    if(event.key==="ArrowDown"||event.key==="ArrowUp") {event.preventDefault();if(list.hidden)show(input.value);if(matches.length){active=active<0?(event.key==="ArrowDown"?0:matches.length-1):(active+(event.key==="ArrowDown"?1:-1)+matches.length)%matches.length;highlight();}}
    else if(event.key==="Enter"&&!list.hidden) {event.preventDefault();if(matches.length)choose(matches[active<0?0:active]);}
    else if(event.key==="Escape"&&!list.hidden){event.preventDefault();event.stopPropagation();hide();}
    else if(event.key==="Tab")hide();
  },options);
  $("#videoAnimeToggle").addEventListener("click",()=>{if(list.hidden){input.focus();show();}else hide();},options);
  document.addEventListener("pointerdown",event=>{if(!root.contains(event.target))hide();},options);
  dialog.addEventListener("close",()=>{if(dialog.open)return;hide();controller.abort();},options);
  return {hide};
}
let videoCaptureVersion=0;
let videoCaptureSaving=false;
async function openVideoCaptureFromLocation() {
  if ($("#videoCaptureModal").open) return;
  if (!location.hash.startsWith("#save-video=")) return;
  let capture;
  try { capture=parseVideoCapture(location.hash); }
  catch(error) { history.replaceState(null,"",location.pathname+location.search);toast(error.message,"error");return; }
  // Fragment transports the selection, never a write command. Saving requires confirmation.
  history.replaceState(null,"",location.pathname+location.search);
  const dialog=$("#videoCaptureModal"),form=$("#videoCaptureForm"),save=$("#videoCaptureSave"),status=$("#videoCaptureStatus"),select=$("#videoCaptureAnime");
  $("#videoCaptureTitle").value=capture.title;
  $("#videoCaptureUploader").textContent=capture.uploader;
  const kindInputs=$$('input[name="videoCaptureKind"]');
  const urlField=$("#videoCaptureUrlField"),urlInput=$("#videoCaptureUrl");
  const captureKind=()=>kindInputs.find(input=>input.checked)?.value||"video";
  const applyKind=()=>{
    const isVideo=captureKind()==="video";
    $("#videoCaptureHeading").textContent=isVideo?"保存 B 站视频":"保存链接";
    save.textContent=isVideo?"保存视频":"保存链接";
    urlField.classList.toggle("hidden",isVideo);
    $("#videoCaptureUploader").classList.toggle("hidden",!isVideo);
    $("#videoCaptureDefaultRow").classList.toggle("hidden",!isVideo);
    if(!isVideo&&!urlInput.value)urlInput.value=capture.url;
  };
  kindInputs.forEach(input=>{input.checked=input.value===(capture.kind||"video");input.addEventListener("change",applyKind);});
  applyKind();
  const detailAnimeId=$("#progressModal")?.open ? Number(state.progressAnime?.id) : null;
  dialog.showModal();
  const version=++videoCaptureVersion;
  $("#videoCaptureSearch").value="";$("#videoCaptureNote").value="";$("#videoCaptureDefault").checked=false;
  save.disabled=true;select.value="";status.textContent="正在读取当前账号的番剧…";
  let catalog=null,saving=false,selectionVersion=0,selectionReady=false;
  const defaultSwitch=$("#videoCaptureDefault");
  defaultSwitch.disabled=true;
  const selectAnime=async animeId=>{
    const selection=++selectionVersion;
    selectionReady=false;save.disabled=true;defaultSwitch.checked=false;defaultSwitch.disabled=true;
    status.textContent="";
    if(!animeId)return;
    try {
      const result=await api(`/api/video-links?anime_id=${encodeURIComponent(animeId)}`);
      if(selection!==selectionVersion||version!==videoCaptureVersion||!dialog.open||Number(select.value)!==Number(animeId))return;
      if(result.scope!==catalog.scope)throw new Error("手账账号已切换，请重新打开保存窗口。");
      defaultSwitch.checked=!result.items.some(item=>Boolean(item.is_default));
      defaultSwitch.disabled=false;selectionReady=true;save.disabled=false;
    }catch(error){if(selection===selectionVersion&&version===videoCaptureVersion&&dialog.open)status.textContent=`无法检查默认视频：${error.message}，请重新选择番剧重试。`;}
  };
  const close=()=>{if(!saving)dialog.close();};
  $("#videoCaptureClose").onclick=close;$("#videoCaptureCancel").onclick=close;
  form.onsubmit=async event=>{
    event.preventDefault();if(!catalog||saving||!select.value||!selectionReady)return;
    if(captureKind()==="video" && !$("#videoCaptureDefault").checked && !catalog.features?.optional_video_default) {
      status.textContent="当前运行的是旧后台，尚不支持只收藏而不设默认。请重启手账后台并刷新页面后再保存。";return;
    }
    const kind=captureKind();
    const url=kind==="video"?capture.url:$("#videoCaptureUrl").value.trim();
    if(kind==="link"&&!/^https?:\/\//i.test(url)){status.textContent="请填写以 http:// 或 https:// 开头的链接";return;}
    saving=true;videoCaptureSaving=true;save.disabled=true;
    try {
      const animeId=Number(select.value);
      await api("/api/video-links",{method:"POST",body:JSON.stringify({...capture,kind,url,title:$("#videoCaptureTitle").value.trim() || capture.title,anime_id:animeId,scope:catalog.scope,note:$("#videoCaptureNote").value,make_default:kind==="video"&&$("#videoCaptureDefault").checked})});
      dialog.close();toast(kind==="video"?"视频已保存":"链接已保存");openProgress(animeId);
    }catch(error){status.textContent=error.message;}
    finally{saving=false;videoCaptureSaving=false;save.disabled=false;}
  };
  try {
    catalog=await api("/api/video-links");
    if(version!==videoCaptureVersion||!dialog.open)return;
    const preferredId=catalog.animes.some(a=>a.id===detailAnimeId)?detailAnimeId:capture.anime_id;
    createVideoAnimePicker(catalog.animes,preferredId,dialog,selectAnime);
    if(!catalog.animes.length)status.textContent="当前账号没有可选择的番剧。";
  }catch(error){status.textContent=`无法读取番剧：${error.message}`;}
}

window.addEventListener("hashchange",()=>openVideoCaptureFromLocation());
$("#videoCaptureModal").addEventListener("cancel",event=>{if(videoCaptureSaving)event.preventDefault();});
$("#videoCaptureModal").addEventListener("close",()=>{
  if($("#videoCaptureModal").open)return;
  videoCaptureVersion+=1;
  if(location.hash.startsWith("#save-video="))openVideoCaptureFromLocation();
});
