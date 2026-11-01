const DETAIL_LINK_PRESETS = [
  { kind: "bgm", name: "Bangumi #{id}", url: "{site}/subject/{id}", enabled: true },
  { kind: "bilibili", name: "B站搜索", url: "https://search.bilibili.com/all?keyword={title}", enabled: true },
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
  if (!name || !url) return null;
  return {
    id: String(item.id || "") || detailLinkId(),
    kind: ["bgm", "bilibili"].includes(item.kind) ? item.kind : "custom",
    name,
    url,
    enabled: item.enabled !== false,
  };
}

// 详情页那一行链接：预设的 BGM / B站 也是列表里的普通条目，可以改名、改网址、排序或删除。
function detailLinks() {
  const saved = state.settings.detail_links;
  if (Array.isArray(saved)) return saved.map(normalizeDetailLink).filter(Boolean);
  const legacy = Array.isArray(state.settings.custom_search_links) ? state.settings.custom_search_links : [];
  return [
    { ...DETAIL_LINK_PRESETS[0] },
    { ...DETAIL_LINK_PRESETS[1], enabled: enabledSetting("show_bilibili_search_button") },
    ...legacy.map((item) => normalizeDetailLink({ ...item, kind: "custom" })).filter(Boolean),
  ];
}

// 周表卡片详情用同一套条目结构，只是独立保存、独立开关。
function scheduleDetailLinks() {
  const saved = state.settings.schedule_detail_links;
  if (Array.isArray(saved)) return saved.map(normalizeDetailLink).filter(Boolean);
  return DETAIL_LINK_PRESETS.map((preset) => ({ ...preset }));
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
      label: `${detailLinkLabel(link.name, values)} ↗`,
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
  buildDetailLinkItems(detailLinks(), { id: anime.id, title, site })
    .filter((item) => !(merged && preferred && item.kind === "bilibili"))
    .forEach((item) => {
      const anchor = document.createElement("a");
      anchor.className = "detail-link";
      anchor.dataset.detailLinkKind = item.kind;
      anchor.target = "_blank";
      anchor.rel = "noreferrer";
      anchor.textContent = item.label;
      anchor.href = item.href;
      box.append(anchor);
    });
}

function renderBilibiliEntrypoints(anime, preferred = null) {
  const saved=$("#savedVideoDefaultLink");
  saved.textContent="已存视频 ↗";
  saved.classList.toggle("hidden",!preferred);
  if(preferred)saved.href=preferred.url;else saved.removeAttribute("href");
  renderDetailLinks(anime,preferred);
}

let videoLinksLoadVersion = 0;
async function renderVideoLinks(animeId) {
  const version = ++videoLinksLoadVersion;
  const panel = $("#savedVideoLinks");
  const section = $("#savedVideoSection");
  section.classList.add("hidden");
  renderBilibiliEntrypoints(state.progressAnime);
  panel.textContent = "正在读取已存视频…";
  try {
    const result = await api(`/api/video-links?anime_id=${animeId}`);
    if (version !== videoLinksLoadVersion || state.progressAnime?.id !== animeId) return;
    const preferred = result.items.find(item => item.is_default);
    renderBilibiliEntrypoints(state.progressAnime,preferred);
    section.classList.toggle("hidden", !enabledSetting("show_saved_video_list") || !result.items.length);
    panel.innerHTML = result.items.map(item => `<article class="saved-video-row">
      <a class="saved-video-open" href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">
        <span class="saved-video-play" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m9 6 9 6-9 6z"/></svg></span>
        <span class="saved-video-copy"><span class="saved-video-title">${escapeHtml(item.title)}</span>${item.uploader || item.note ? `<span class="saved-video-meta">${escapeHtml([item.uploader,item.note].filter(Boolean).join(" · "))}</span>` : ""}</span>
      </a>
      <div class="saved-video-actions">${item.is_default ? `<span class="saved-video-badge">默认</span><button type="button" class="saved-video-action" data-video-action="unset_default" data-video-id="${item.id}">取消默认</button>` : `<button type="button" class="saved-video-action" data-video-action="default" data-video-id="${item.id}">设为默认</button>`}<button type="button" class="saved-video-action" data-video-action="delete" data-video-id="${item.id}" aria-label="移除视频：${escapeHtml(item.title)}">移除</button></div>
    </article>`).join("");
    panel.querySelectorAll("[data-video-action]").forEach(button => button.addEventListener("click", async () => {
      if (button.dataset.videoAction === "delete" && !confirm("移除这个已存视频链接？")) return;
      if(button.dataset.videoAction === "unset_default" && !result.features?.optional_video_default) {
        toast("当前运行的是旧后台，尚不支持取消默认。请关闭手账后台，再通过启动快捷方式打开并刷新页面。", "error");return;
      }
      button.disabled = true;
      try {
        await api("/api/video-links", {method:"POST",body:JSON.stringify({anime_id:animeId,scope:result.scope,action:button.dataset.videoAction,id:Number(button.dataset.videoId)})});
        if (state.progressAnime?.id === animeId) renderVideoLinks(animeId);
      } catch (error) { toast(error.message,"error"); button.disabled=false; }
    }));
  } catch(error) { if (version === videoLinksLoadVersion) panel.textContent = `已存视频暂不可用：${error.message}`; }
}
window.addEventListener("focus", () => {
  if (state.progressAnime && $("#progressModal")?.open) renderVideoLinks(state.progressAnime.id);
});

function parseVideoCapture(fragment) {
  if (!fragment.startsWith("#save-video=")) return null;
  const payload=JSON.parse(decodeURIComponent(fragment.slice("#save-video=".length)));
  const url=new URL(payload.url);
  if(url.protocol!=="https:" || !["www.bilibili.com","bilibili.com"].includes(url.hostname) || url.username || url.password || url.port || !/^\/video\/BV[0-9A-Za-z]{10}\/?$/.test(url.pathname)) throw Error("无效的 B 站视频地址");
  return {url:url.href,title:String(payload.title||"B站视频").slice(0,200),uploader:String(payload.uploader||"").slice(0,100),anime_id:Number(payload.anime_id)||null};
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
    if(!$("#videoCaptureDefault").checked && !catalog.features?.optional_video_default) {
      status.textContent="当前运行的是旧后台，尚不支持只收藏而不设默认。请重启手账后台并刷新页面后再保存。";return;
    }
    saving=true;videoCaptureSaving=true;save.disabled=true;
    try {
      const animeId=Number(select.value);
      await api("/api/video-links",{method:"POST",body:JSON.stringify({...capture,title:$("#videoCaptureTitle").value.trim() || capture.title,anime_id:animeId,scope:catalog.scope,note:$("#videoCaptureNote").value,make_default:$("#videoCaptureDefault").checked})});
      dialog.close();toast("视频已保存");openProgress(animeId);
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
