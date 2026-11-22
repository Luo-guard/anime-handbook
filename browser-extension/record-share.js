const sharePlatforms = {
  qzone: "https://qzone.qq.com/",
  bilibili: "https://t.bilibili.com/",
  heybox: "https://www.xiaoheihe.cn/home",
};
const activeShareTabs = new Set();
const shareKey = id => `recordShare:${id}`;
const maxShareAge = 10 * 60 * 1000;

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message.type !== "handbook-share-draft" || !sender.tab || sender.frameId !== 0 || !isHandbookURL(sender.url)) return;
  openRecordShare(message, sender).then(() => reply({ok:true}), error => reply({error:error.message}));
  return true;
});

async function openRecordShare(message, sender) {
  if (!Object.hasOwn(sharePlatforms, message.platform)) throw Error("该平台暂不支持自动填充");
  const text = typeof message.text === "string" ? message.text.trim() : "";
  if (text.length > 30000) throw Error("正文太长，请缩短后再试");
  const images = Array.isArray(message.images) ? message.images : [];
  if (!text && !images.length) throw Error("请先填写正文或添加配图");
  const localImages = images.filter(value => typeof value === "string" && /^\/api\/(?:record-images\/[\w-]+\.(?:png|jpg|webp)|character-covers\/\d+\/\d+)$/.test(value));
  // The draft stays in extension session storage and never goes in the tab URL.
  const tab = await chrome.tabs.create({url:sharePlatforms[message.platform],openerTabId:sender.tab.id});
  await chrome.storage.session.set({[shareKey(tab.id)]: {
    platform:message.platform, text, totalImages:images.length, paths:localImages.slice(0,9),
    origin:new URL(sender.url).origin, expires:Date.now()+maxShareAge,
  }});
  const current = await chrome.tabs.get(tab.id);
  if (current.status === "complete") fillShareTab(tab.id, current.url).catch(()=>{});
}

function isShareTab(platform, value) {
  try {
    const {protocol, hostname} = new URL(value);
    if (protocol !== "https:") return false;
    if (platform === "qzone") return hostname === "qzone.qq.com" || hostname.endsWith(".qzone.qq.com");
    if (platform === "bilibili") return hostname === "t.bilibili.com";
    return hostname === "www.xiaoheihe.cn" || hostname === "xiaoheihe.cn";
  } catch {
    return false;
  }
}

async function loadShareImages(draft) {
  const files = [];
  let bytes = 0;
  for (const path of draft.paths) {
    try {
      const response = await fetch(draft.origin+path,{redirect:"error",signal:AbortSignal.timeout(4000)});
      const mime = response.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase();
      if (!response.ok || !["image/png","image/jpeg","image/webp"].includes(mime)) continue;
      let blob = await response.blob();
      if (!blob.size || blob.size > 8*1024*1024) continue;
      if (draft.platform === "bilibili" && mime === "image/webp") {
        const bitmap = await createImageBitmap(blob);
        try {
          if (bitmap.width * bitmap.height > 32_000_000) continue;
          const image = new OffscreenCanvas(bitmap.width, bitmap.height);
          image.getContext("2d").drawImage(bitmap, 0, 0);
          blob = await image.convertToBlob({type:"image/png"});
        } finally {
          bitmap.close();
        }
      }
      const data = new Uint8Array(await blob.arrayBuffer());
      if (!data.length || data.length > 8*1024*1024 || bytes+data.length > 20*1024*1024) continue;
      const file = btoa(Array.from({length:Math.ceil(data.length/32768)}, (_,index) =>
        String.fromCharCode(...data.subarray(index*32768,(index+1)*32768))).join(""));
      const type = blob.type.split(";")[0].toLowerCase();
      files.push({mime:type, name:`手账配图-${files.length+1}.${type === "image/jpeg" ? "jpg" : type.split("/")[1]}`, data:file});
      bytes += data.length;
    } catch { /* Count the unavailable image in the final status. */ }
  }
  return files;
}

async function fillShareTab(tabId, url) {
  if (activeShareTabs.has(tabId)) return;
  activeShareTabs.add(tabId);
  const key = shareKey(tabId);
  const run = (target, args) => chrome.scripting.executeScript({
    target:{tabId,...target},func:interactWithShareEditor,args,
    world:args[0] === "bilibili" && args[1] !== "notice" ? "MAIN" : "ISOLATED",
  });
  try {
    const draft = (await chrome.storage.session.get(key))[key];
    if (!draft) return;
    if (draft.expires < Date.now()) {
      await chrome.storage.session.remove(key);
      return;
    }
    if (!isShareTab(draft.platform,url)) return;
    let editor;
    let opened = false;
    const locate = [draft.platform,"locate",draft.text];
    for (let attempt=0; attempt<10; attempt++) {
      const frames = draft.platform === "qzone" ? {allFrames:true} : {};
      const results = await run(frames,locate).catch(() => run({},locate));
      editor = results.find(frame=>frame.result?.editor);
      if (editor) break;
      const entry = results.find(frame=>frame.result?.entry);
      if (entry && !opened) {
        opened = true;
        await run({frameIds:[entry.frameId]},[draft.platform,"open"]);
      }
      await new Promise(resolve=>setTimeout(resolve,750));
    }
    if (!editor) {
      const hint = draft.platform === "heybox" ? "请打开小黑盒的「发布图文」页面，再点下方重试。" : "请登录，打开写说说或发帖界面，再点下方重试。";
      await run({},[draft.platform,"notice",`手账暂未识别到编辑器。${hint}`]);
      return;
    }
    if (editor.result.occupied && !(editor.result.sameText && draft.paths.length)) {
      await run({},[draft.platform,"notice","编辑器里已有内容。手账保留了原稿，请打开空白编辑器后重试。"]);
      return;
    }
    const files = await loadShareImages(draft);
    const target = editor.documentId ? {documentIds:[editor.documentId]} : {frameIds:[editor.frameId]};
    const [result] = await run(target,[draft.platform,"fill",{text:draft.text,files}]);
    if (!result?.result?.ok) {
      await run({},[draft.platform,"notice","编辑器发生变化，手账未写入。请打开空白编辑器后重试。"]);
      return;
    }
    let sent = result.result.images;
    if (result.result.nativePicker && files.length) {
      const [upload] = await chrome.scripting.executeScript({
        target:{tabId,...target}, world:"MAIN", func:fillNativeShareImagePicker, args:[draft.platform,files,result.result.editorText],
      }).catch(()=>[]);
      sent = upload?.result || 0;
    }
    // QQ 空间的上传面板常在另一个 frame（甚至点完「图片」按钮才生成），
    // 编辑器帧里找不到 input 不代表没法传，这里做一次全 frame 的补投。
    if (draft.platform === "qzone" && files.length && !sent) {
      sent = await uploadQzoneImages(tabId, target, files);
    }
    await chrome.storage.session.remove(key);
    const unread = draft.totalImages - files.length;
    const message = unread
      ? ["草稿已准备。", `${unread} 张配图未能从手账读取。`,
        files.length ? "已填入的配图请检查编辑器预览。" : ""].join("")
      : sent === files.length && files.length
        ? "图文已填入，请检查图片预览后再发布。"
        : files.length
          ? `正文已填入。${files.length} 张配图没有自动上传，请在编辑器里点图片图标手动选择文件（配图就是这些文件）。`
          : "正文已填入，请在平台检查并发布。";
    await run({},[draft.platform,"notice",message,false]);
  } catch {
    await run({},[null,"notice","手账暂时无法访问编辑器。请检查扩展权限，或回到手账复制正文和保存配图。"]).catch(()=>{});
  } finally {
    activeShareTabs.delete(tabId);
  }
}

chrome.tabs.onUpdated.addListener((id, change, tab)=>{
  if (change.status === "complete") fillShareTab(id,tab.url).catch(()=>{});
});
chrome.tabs.onRemoved.addListener(id=>chrome.storage.session.remove(shareKey(id)));
chrome.runtime.onMessage.addListener((message,sender)=>{
  if (message.type === "handbook-share-retry" && sender.tab && sender.frameId === 0) fillShareTab(sender.tab.id,sender.url).catch(()=>{});
});

// ---------- QQ 空间：跨 frame 找上传面板的 file input ----------

async function imageInputSnapshot(tabId) {
  const results = await chrome.scripting.executeScript({
    target:{allFrames:true}, func:collectShareFileInputs,
  }).catch(()=>[]);
  return results.filter(item => Array.isArray(item.result))
    .flatMap(item => item.result.map(entry => ({...entry, frameId:item.frameId})));
}

// 注入：收集本 frame 里可用的图片 file input（QQ 空间的上传面板是点完按钮才生成的）。
function collectShareFileInputs() {
  const visible = node => node.getClientRects().length && getComputedStyle(node).visibility !== "hidden";
  return [...document.querySelectorAll('input[type="file"]:not([disabled])')]
    .filter(input => /image|png|jpe?g|webp/i.test(input.accept) || !input.accept)
    .map(input => ({
      key:`${input.id}§${input.name}§${input.accept}`,
      visible:visible(input), files:input.files.length,
    }));
}

// 注入：把配图写进指定 frame 的 file input 并触发 change。
function setShareImageInput(key, files) {
  const input = [...document.querySelectorAll('input[type="file"]:not([disabled])')]
    .find(item => `${item.id}§${item.name}§${item.accept}` === key);
  if (!input) return 0;
  const transfer = new DataTransfer();
  for (const {name,mime,data} of files.slice(0, input.multiple ? files.length : 1)) {
    transfer.items.add(new File([Uint8Array.from(atob(data), char => char.charCodeAt(0))], name, {type:mime}));
  }
  input.files = transfer.files;
  input.dispatchEvent(new Event("input",{bubbles:true}));
  input.dispatchEvent(new Event("change",{bubbles:true}));
  return transfer.files.length;
}

// 注入：数编辑器/发布区里的图片缩略图，用来确认上传真的进来了。
function countShareComposerImages(rootSelectors) {
  return rootSelectors.reduce((total, selector) => total +
    [...document.querySelectorAll(`${selector} img`)]
      .filter(image => image.getClientRects().length).length, 0);
}

async function uploadQzoneImages(tabId, target, files) {
  const before = await imageInputSnapshot(tabId);
  await new Promise(resolve => setTimeout(resolve, 1200));   // 面板/输入框可能还没挂上
  const after = await imageInputSnapshot(tabId);
  const fresh = after.filter(item => !before.some(b => b.frameId === item.frameId && b.key === item.key));
  const candidates = (fresh.length ? fresh : after).filter(item => item.visible || fresh.length);
  const pick = candidates.find(item => item.files === 0) || candidates[0];
  if (!pick) return 0;
  const [upload] = await chrome.scripting.executeScript({
    target:{tabId, frameIds:[pick.frameId]}, func:setShareImageInput, args:[pick.key, files],
  }).catch(()=>[]);
  const handed = upload?.result || 0;
  if (!handed) return 0;
  // 上传面板接了文件不代表发布区里已经有图，等缩略图出现才算确认。
  const selectors = ["#tgb,.qz-poster,.mod-publisher,.msg-poster,.mood-publisher,#emotion_publisher",
    "body"];
  const baseline = await chrome.scripting.executeScript({
    target, func:countShareComposerImages, args:[selectors],
  }).catch(()=>[]);
  const base = baseline?.[0]?.result || 0;
  for (let attempt = 0; attempt < 40; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 500));
    const [current] = await chrome.scripting.executeScript({
      target, func:countShareComposerImages, args:[selectors],
    }).catch(()=>[]);
    if ((current?.result || 0) >= base + handed) return handed;
  }
  return 0;
}

// This function is injected as a self-contained script into the destination document.
async function interactWithShareEditor(platform, action, payload, retry = true) {
  if (action === "notice") {
    document.getElementById("handbook-share-status")?.remove();
    const notice = document.createElement("aside");
    notice.id = "handbook-share-status";
    notice.setAttribute("role","status");
    notice.style.cssText = "position:fixed;right:14px;bottom:14px;z-index:2147483647;max-width:min(340px,calc(100vw - 28px));padding:12px 14px;border-radius:12px;background:#263443;color:white;font:14px/1.55 system-ui;box-shadow:0 8px 24px #0004";
    notice.append(payload);
    const button = label => {
      const item = document.createElement("button");
      item.type = "button";
      item.textContent = label;
      item.style.cssText = "margin:5px 0 0 8px;padding:3px 7px;border:0;border-radius:5px;color:#263443;background:#fff;cursor:pointer";
      notice.append(item);
      return item;
    };
    if (retry) button("重试填充").onclick = () => {
      notice.remove();
      chrome.runtime.sendMessage({type:"handbook-share-retry"});
    };
    button("关闭").onclick = () => notice.remove();
    document.body.append(notice);
    return;
  }
  const adapters = {
    qzone: {
      root:"#tgb,.qz-poster,.mod-publisher,.msg-poster,.mood-publisher,#emotion_publisher",
      entry:["写说说","发表说说"],
    },
    bilibili: {
      root:".bili-dyn-publishing,.bili-dyn-publish,.dyn-publish,.bgd-publish",
      entry:["写动态","发动态"],
    },
    heybox: {
      root:".post-editor,.publish-editor,.publish-content,.creation-editor,.editor-container,form",
      entry:["发布内容","发新帖","写帖子","写动态"],
    },
  };
  const adapter = adapters[platform];
  if (!adapter) return;
  const visible = node => node.getClientRects().length && getComputedStyle(node).visibility !== "hidden";
  const editorSelector = 'textarea:not([readonly]):not([disabled]),[contenteditable="true"],[contenteditable="plaintext-only"]';
  const editors = [...document.querySelectorAll(adapter.root)].flatMap(root =>
    [...root.querySelectorAll(editorSelector)].filter(node=>visible(node) && !node.closest('[aria-hidden="true"]')).map(node=>({root,node})));
  const candidates = [...new Map(editors.map(item=>[item.node,item])).values()];
  const isComposerText = node => /说说|动态|想说|分享|正文|内容/.test(node.getAttribute("placeholder") || node.getAttribute("data-placeholder") || node.getAttribute("aria-label") || node.querySelector("[data-placeholder]")?.getAttribute("data-placeholder") || "");
  const bilibiliBody = platform === "bilibili" && candidates.filter(({node}) =>
    node.matches('.bili-rich-textarea__inner,[placeholder="有什么想和大家分享的？"]'));
  const heyboxEditorPage = platform === "heybox" && /^\/creator\/editor(?:\/|$)/.test(location.pathname);
  const heyboxImageText = heyboxEditorPage && /^\/creator\/editor\/draft\/image_text(?:\/|$)/.test(location.pathname);
  const heyboxBodies = heyboxImageText ? [...document.querySelectorAll(".editor-image-text__section")].flatMap(root =>
    [...root.querySelectorAll('.image-text__edit-content--inner [contenteditable="true"]')]
      .filter(node => visible(node) && !node.closest('[aria-hidden="true"],[inert]'))
      .map(node => ({root,node}))) : [];
  const known = heyboxEditorPage ? heyboxBodies : bilibiliBody?.length ? bilibiliBody : candidates.filter(({node,root})=>
    isComposerText(node) || (platform !== "heybox" && candidates.length===1 && root.tagName!=="FORM"));
  let editor = known.length===1 ? known[0] : null;
  if (platform === "bilibili" && editor) {
    const publisher = editor.node.closest(".bili-dyn-publishing") || editor.root;
    const component = publisher.__vue__;
    // The editor is already visible while Bilibili retrieves and restores
    // its unpublished draft. Re-check once initialization has finished.
    if (component?.$options?.name === "bili-dyn-publishing" &&
        (component.loadingState?.init || !component.user)) editor = null;
    else editor.root = publisher;
  }
  const entry = !heyboxEditorPage && [...document.querySelectorAll("a,button,[role='button']")].find(node=>visible(node) && adapter.entry.includes(node.textContent.trim()));
  const editorText = node => (node.value ?? node.innerText ?? node.textContent).replace(/[\u200b\ufeff]/g,"").trim();
  const hasMedia = node => Boolean(node.querySelector("img,video,[data-attachment]"));
  // QQ Space puts this prompt inside the collapsed editor as ordinary text.
  const isQzonePrompt = node => platform === "qzone" && !hasMedia(node) &&
    ["说点儿什么吧", "说点什么吧"].includes(editorText(node));
  const hasBilibiliDraftDetails = root => platform === "bilibili" &&
    Boolean(root.querySelector(".bili-dyn-publishing__title__input")?.value.trim() ||
      root.querySelector(".bili-pics-uploader__item,.bili-pics-uploader__item__remove,.bili-dyn-publishing__attachment"));
  const heyboxGallerySelector = ".editor-image-text__image-seletor.editor__image-wrapper";
  const heyboxImageSelector = ".editor-image-wrapper__box.draggable";
  const hasHeyboxDraftDetails = root => heyboxImageText &&
    ([...root.querySelectorAll(".hb-cpt__editor-title [contenteditable],.hb-cpt__editor-title input,.hb-cpt__editor-title textarea")]
      .some(title => editorText(title) || hasMedia(title)) ||
      Boolean(root.querySelector(`${heyboxGallerySelector} ${heyboxImageSelector}`)));
  const canAddImages = ({node,root}, text) => (platform === "bilibili" || heyboxImageText) && Boolean(text) &&
    !hasMedia(node) && !hasBilibiliDraftDetails(root) && !hasHeyboxDraftDetails(root) &&
    editorText(node) === text.replace(/\r\n?/g,"\n").trim();
  const occupied = ({node,root}) => hasMedia(node) || Boolean(editorText(node) && !isQzonePrompt(node)) ||
    hasBilibiliDraftDetails(root) || hasHeyboxDraftDetails(root);
  if (action === "locate") return {
    editor:Boolean(editor),occupied:editor ? occupied(editor) : false,entry:Boolean(entry),
    ...(editor && canAddImages(editor,payload || "") ? {sameText:true} : {}),
  };
  if (action === "open" && !editor) {
    // Use only listed composer-entry labels. Never invoke form submission.
    if (entry && !entry.closest("form") && entry.getAttribute("type") !== "submit") entry.click();
    return;
  }
  const addImagesOnly = editor && payload.files.length && canAddImages(editor,payload.text);
  if (!editor || (occupied(editor) && !addImagesOnly)) return {ok:false};
  const {node,root} = editor;
  const imageInputs = scope => [...scope.querySelectorAll('input[type="file"]:not([disabled])')];
  const acceptsImages = item => /image|png|jpe?g|webp/i.test(item.accept);
  const findImageInput = inputs => inputs.find(acceptsImages) ||
    (platform === "qzone" && inputs.length === 1 && !inputs[0].accept ? inputs[0] : null);
  const imageInput = () => findImageInput(imageInputs(root));
  let input = imageInput();
  if (input?.files.length) return {ok:false};
  if (!addImagesOnly && (payload.text || isQzonePrompt(node))) {
    node.focus();
    if (!node.isConnected || occupied(editor)) return {ok:false};
    if (node instanceof HTMLTextAreaElement) {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(node,payload.text);
      node.dispatchEvent(new Event("input",{bubbles:true}));
      node.dispatchEvent(new Event("change",{bubbles:true}));
    } else if (platform === "qzone" || platform === "bilibili") {
      // Preserve newlines without editor-generated markup or empty markers.
      node.style.whiteSpace = "pre-wrap";
      node.textContent = payload.text.replace(/\r\n?/g,"\n");
      node.dispatchEvent(new InputEvent("input",{bubbles:true,inputType:"insertText",data:node.textContent}));
    } else {
      const lines = payload.text.replace(/\r\n?/g,"\n").split("\n");
      if (heyboxImageText) {
        const clipboard = new DataTransfer();
        clipboard.setData("text/plain", lines.join("\n"));
        node.dispatchEvent(new ClipboardEvent("paste",{clipboardData:clipboard,bubbles:true,cancelable:true}));
      }
      const inserted = editorText(node) || lines.every((line,index) =>
        (!index || document.execCommand("insertLineBreak")) &&
        (!line || document.execCommand("insertText",false,line)));
      if (!inserted || !editorText(node)) {
        node.replaceChildren(...lines.flatMap((line,index)=>index ? [document.createElement("br"),document.createTextNode(line)] : [document.createTextNode(line)]));
        node.dispatchEvent(new InputEvent("input",{bubbles:true,inputType:"insertText",data:payload.text}));
      }
    }
    if (payload.text && !editorText(node)) return {ok:false};
  }
  if (!payload.files.length) return {ok:true,images:0};
  if (heyboxImageText || platform === "bilibili") return {ok:true,images:0,nativePicker:true,editorText:editorText(node)};
  input = imageInput();
  if (!input && platform === "qzone") {
    const before = new Set(imageInputs(document));
    const photoLabels = ["图片","照片","添加图片","上传照片","上传图片","插入图片","本地上传","本地图片","添加照片"];
    const picker = [...root.querySelectorAll('button,a,[role="button"],[title],[aria-label]')].find(item =>
      visible(item) && item.getAttribute("type") !== "submit" &&
      [item.getAttribute("title"),item.getAttribute("aria-label"),item.textContent.trim()].some(label=>photoLabels.includes(label)));
    if (picker) {
      picker.click();
      for (let attempt=0; attempt<12 && !input; attempt++) {
        await new Promise(resolve=>setTimeout(resolve,200));
        input = imageInput() || findImageInput(imageInputs(document).filter(item=>!before.has(item)));
      }
    }
  }
  if (!input || input.disabled || input.files.length) return {ok:true,images:0,photo:platform === "qzone" && payload.files.length > 0};
  const files = new DataTransfer();
  for (const {name,mime,data} of payload.files.slice(0,input.multiple ? payload.files.length : 1)) {
    files.items.add(new File([Uint8Array.from(atob(data),char=>char.charCodeAt(0))],name,{type:mime}));
  }
  input.files = files.files;
  input.dispatchEvent(new Event("input",{bubbles:true}));
  input.dispatchEvent(new Event("change",{bubbles:true}));
  return {ok:true,images:files.files.length};
}

// Both sites create their picker off DOM. Only intercept the picker opened
// by the named image controls, then route files through the site's handler.
async function fillNativeShareImagePicker(platform, attachments, expectedText) {
  const bili = platform === "bilibili";
  const heybox = platform === "heybox" && /^\/creator\/editor\/draft\/image_text(?:\/|$)/.test(location.pathname);
  if (!bili && !heybox) return 0;
  const rootSelector = bili ? ".bili-dyn-publishing" : ".editor-image-text__section";
  const bodySelector = bili ? ".bili-rich-textarea__inner" : '.image-text__edit-content--inner [contenteditable="true"]';
  const gallerySelector = ".editor-image-text__image-seletor.editor__image-wrapper";
  const addSelector = bili ? ".bili-pics-uploader__add" : `${gallerySelector} .editor-image-wrapper__box.upload`;
  const itemSelector = bili ? ".bili-pics-uploader__item" : `${gallerySelector} .editor-image-wrapper__box.draggable`;
  const successSelector = bili ? `${itemSelector}.success` : `${itemSelector} .editor-image-wrapper__box-image`;
  const titleSelector = bili ? ".bili-dyn-publishing__title__input" : ".hb-cpt__editor-title [contenteditable]";
  const visible = (node) => node?.getClientRects().length && getComputedStyle(node).visibility !== "hidden";
  const textOf = (node) => (node.value ?? node.innerText ?? node.textContent).replace(/[\u200b\ufeff]/g,"").trim();
  function getEditor() {
    const editors = [...document.querySelectorAll(`${rootSelector} ${bodySelector}`)].filter(visible);
    return editors.length === 1 ? editors[0] : null;
  }
  const editor = getEditor();
  if (!editor) return 0;
  const root = editor.closest(rootSelector);
  const draftText = expectedText.replace(/\r\n?/g,"\n").trim();
  const isSameDraft = () => editor.isConnected && textOf(editor) === draftText &&
    !editor.querySelector("img,video,[data-attachment]") && !root.querySelector(".bili-dyn-publishing__attachment") &&
    ![...root.querySelectorAll(titleSelector)].some(title => textOf(title));
  if (!isSameDraft() || root.querySelector(itemSelector)) return 0;

  const prototype = HTMLInputElement.prototype;
  const click = prototype.click;
  let picker;
  prototype.click = function(...args) {
    const matching = this.type === "file" && !this.disabled && !this.files.length &&
      !this.isConnected && (bili ? this.name === "upload" : this.accept === "image/*");
    if (!matching) return click.apply(this,args);
    picker ||= this;
  };
  try {
    const add = root.querySelector(addSelector);
    const tool = bili && root.querySelector(".bili-dyn-publishing__tools__item.pic:not(.active):not(.disabled)");
    if (visible(add) && !add.matches('button[type="submit"]')) add.click();
    else if (visible(tool)) {
      tool.click();
      // Vue opens the panel and may request the picker in its update queue.
      await new Promise(resolve => setTimeout(resolve,0));
      const openedAdd = root.querySelector(addSelector);
      if (!picker && visible(openedAdd) && !openedAdd.matches('button[type="submit"]')) openedAdd.click();
    }
  } finally {
    prototype.click = click;
  }

  if (!picker || !isSameDraft() || root.querySelector(itemSelector)) return 0;
  const transfer = new DataTransfer();
  for (const {name,mime,data} of attachments.slice(0,picker.multiple ? attachments.length : 1)) {
    transfer.items.add(new File([Uint8Array.from(atob(data),char=>char.charCodeAt(0))],name,{type:mime}));
  }
  const expectedCount = transfer.files.length;
  picker.files = transfer.files;
  picker.dispatchEvent(new Event("change",{bubbles:true}));
  let count = 0;
  const href = location.href;
  for (let attempt=0; attempt<60 && location.href === href; attempt++) {
    const current = getEditor();
    const publisher = current && textOf(current) === draftText ? current.closest(rootSelector) : null;
    count = publisher?.querySelectorAll(successSelector).length || 0;
    if (count >= expectedCount ||
        (bili && publisher?.querySelectorAll(`${itemSelector}.success,${itemSelector}.error`).length >= expectedCount)) break;
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  return Math.min(count,expectedCount);
}
