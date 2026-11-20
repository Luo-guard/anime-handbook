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
      if (!response.ok || !["image/png","image/jpeg","image/webp"].includes(response.headers.get("Content-Type"))) continue;
      const data = new Uint8Array(await response.arrayBuffer());
      if (!data.length || data.length > 8*1024*1024 || bytes+data.length > 20*1024*1024) continue;
      const mime = response.headers.get("Content-Type");
      const file = btoa(Array.from({length:Math.ceil(data.length/32768)}, (_,index) =>
        String.fromCharCode(...data.subarray(index*32768,(index+1)*32768))).join(""));
      files.push({mime, name:`手账配图-${files.length+1}.${mime === "image/jpeg" ? "jpg" : mime.split("/")[1]}`, data:file});
      bytes += data.length;
    } catch { /* Count the unavailable image in the final status. */ }
  }
  return files;
}

async function fillShareTab(tabId, url) {
  if (activeShareTabs.has(tabId)) return;
  activeShareTabs.add(tabId);
  const key = shareKey(tabId);
  const run = (target, args) => chrome.scripting.executeScript({target:{tabId,...target},func:interactWithShareEditor,args});
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
    const locate = [draft.platform,"locate",draft.platform === "bilibili" ? draft.text : ""];
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
    await chrome.storage.session.remove(key);
    let sent = result.result.images;
    if (draft.platform === "bilibili" && !sent && files.length) {
      const [upload] = await chrome.scripting.executeScript({
        target:{tabId,...target}, world:"MAIN", func:fillBilibiliImagePicker, args:[files,draft.text],
      }).catch(()=>[]);
      sent = upload?.result || 0;
    }
    const message = draft.totalImages > sent
      ? `已准备草稿，${draft.totalImages-sent} 张图片需要手动添加。请检查后发布。`
      : sent ? "正文和图片已交给编辑器，请检查图片预览后再发布。" : "正文已填入，请在平台检查并发布。";
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
  const editor = known.length===1 ? known[0] : null;
  const entry = !heyboxEditorPage && [...document.querySelectorAll("a,button,[role='button']")].find(node=>visible(node) && adapter.entry.includes(node.textContent.trim()));
  const editorText = node => (node.value ?? node.innerText ?? node.textContent).replace(/[\u200b\ufeff]/g,"").trim();
  const hasMedia = node => Boolean(node.querySelector("img,video,[data-attachment]"));
  // QQ Space puts this prompt inside the collapsed editor as ordinary text.
  const isQzonePrompt = node => platform === "qzone" && !hasMedia(node) &&
    ["说点儿什么吧", "说点什么吧"].includes(editorText(node));
  const hasBilibiliDraftDetails = root => platform === "bilibili" &&
    Boolean(root.querySelector(".bili-dyn-publishing__title__input")?.value.trim() ||
      root.querySelector(".bili-pics-uploader__item__remove"));
  const heyboxGallerySelector = ".editor-image-text__image-seletor.editor__image-wrapper";
  const heyboxImageSelector = ".editor-image-wrapper__box.draggable";
  const hasHeyboxDraftDetails = root => heyboxImageText &&
    ([...root.querySelectorAll(".hb-cpt__editor-title [contenteditable],.hb-cpt__editor-title input,.hb-cpt__editor-title textarea")]
      .some(title => editorText(title) || hasMedia(title)) ||
      Boolean(root.querySelector(`${heyboxGallerySelector} ${heyboxImageSelector}`)));
  const sameBilibiliText = ({node,root}, text) => platform === "bilibili" && Boolean(text) &&
    !hasMedia(node) && !hasBilibiliDraftDetails(root) && editorText(node) === text.trim();
  const occupied = ({node,root}) => hasMedia(node) || Boolean(editorText(node) && !isQzonePrompt(node)) ||
    hasBilibiliDraftDetails(root) || hasHeyboxDraftDetails(root);
  if (action === "locate") return {
    editor:Boolean(editor),occupied:editor ? occupied(editor) : false,entry:Boolean(entry),
    ...(editor && sameBilibiliText(editor,payload) ? {sameText:true} : {}),
  };
  if (action === "open" && !editor) {
    // Use only listed composer-entry labels. Never invoke form submission.
    if (entry && !entry.closest("form") && entry.getAttribute("type") !== "submit") entry.click();
    return;
  }
  const addImagesOnly = editor && payload.files.length && sameBilibiliText(editor,payload.text);
  if (!editor || (occupied(editor) && !addImagesOnly)) return {ok:false};
  const {node,root} = editor;
  const imageInputs = scope => [...scope.querySelectorAll('input[type="file"]:not([disabled])')];
  const acceptsImages = item => /image|png|jpe?g|webp/i.test(item.accept) ||
    (platform === "bilibili" && item.name === "upload" && !item.accept);
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
  if (heyboxImageText) {
    const galleries = [...root.querySelectorAll(heyboxGallerySelector)].filter(visible);
    const gallery = galleries.length === 1 ? galleries[0] : null;
    if (!node.isConnected || !gallery || hasHeyboxDraftDetails(root)) return {ok:true,images:0};
    const transfer = new DataTransfer();
    for (const {name,mime,data} of payload.files) {
      transfer.items.add(new File([Uint8Array.from(atob(data),char=>char.charCodeAt(0))],name,{type:mime}));
    }
    const handled = !gallery.dispatchEvent(new DragEvent("drop",{dataTransfer:transfer,bubbles:true,cancelable:true}));
    if (!handled) return {ok:true,images:0};
    const previews = () => gallery.querySelectorAll(`${heyboxImageSelector} .editor-image-wrapper__box-image`).length;
    let added = previews();
    for (let attempt=0; attempt<40 && added<transfer.files.length && gallery.isConnected; attempt++) {
      await new Promise(resolve=>setTimeout(resolve,250));
      added = previews();
    }
    return {ok:true,images:Math.min(added,transfer.files.length)};
  }
  input = imageInput();
  if (!input && platform === "qzone") {
    const before = new Set(imageInputs(document));
    const photoLabels = ["图片","照片","添加图片","上传照片","上传图片"];
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
  if ((!input && platform !== "bilibili") || input?.disabled || input?.files.length) return {ok:true,images:0};
  const files = new DataTransfer();
  for (const {name,mime,data} of payload.files.slice(0,!input || input.multiple ? payload.files.length : 1)) {
    files.items.add(new File([Uint8Array.from(atob(data),char=>char.charCodeAt(0))],name,{type:mime}));
  }
  if (!input) {
    // Some Bilibili builds keep the file picker off DOM. Use the editor's
    // paste event and count only attachments that appeared in the composer.
    node.dispatchEvent(new ClipboardEvent("paste",{clipboardData:files,bubbles:true,cancelable:true}));
    let previews = 0;
    for (let attempt=0; attempt<12 && previews<files.files.length; attempt++) {
      await new Promise(resolve=>setTimeout(resolve,200));
      previews = root.querySelectorAll(".bili-pics-uploader__item__remove").length;
    }
    return {ok:true,images:Math.min(previews,files.files.length)};
  }
  input.files = files.files;
  input.dispatchEvent(new Event("input",{bubbles:true}));
  input.dispatchEvent(new Event("change",{bubbles:true}));
  return {ok:true,images:files.files.length};
}

// Bilibili's add button may use a detached image input. Intercept only its
// picker call during this single click, then restore the page's prototypes.
async function fillBilibiliImagePicker(attachments, expectedText) {
  const root = document.querySelector(".bili-dyn-publishing");
  const add = root?.querySelector(".bili-pics-uploader__add");
  const thumbnail = ".bili-pics-uploader__item__remove";
  const editor = root?.querySelector(".bili-rich-textarea__inner");
  if (!editor || editor.innerText.replace(/[\u200b\ufeff]/g,"").trim() !== expectedText.trim() ||
      root.querySelector(".bili-dyn-publishing__title__input")?.value.trim() ||
      !add || !add.getClientRects().length || (add.closest("form") && add.type === "submit") ||
      root.querySelector(thumbnail)) return 0;
  const transfer = new DataTransfer();
  for (const {name,mime,data} of attachments) {
    transfer.items.add(new File([Uint8Array.from(atob(data),char=>char.charCodeAt(0))],name,{type:mime}));
  }
  const prototype = HTMLInputElement.prototype;
  const click = prototype.click;
  const showPicker = prototype.showPicker;
  let picker;
  function capture(input) {
    if (input.type !== "file" || input.name !== "upload" || input.files.length ||
        (input.isConnected && !root.contains(input))) return false;
    picker ||= input;
    return true;
  }
  prototype.click = function(...args) {
    if (!capture(this)) return click.apply(this,args);
  };
  if (showPicker) prototype.showPicker = function(...args) {
    if (!capture(this)) return showPicker.apply(this,args);
  };
  try {
    add.dispatchEvent(new MouseEvent("click",{bubbles:true,cancelable:true}));
  } finally {
    prototype.click = click;
    if (showPicker) prototype.showPicker = showPicker;
  }
  if (!picker || root.querySelector(thumbnail)) return 0;
  picker.files = transfer.files;
  picker.dispatchEvent(new Event("change",{bubbles:true}));
  let count = 0;
  for (let attempt=0; attempt<25 && count<transfer.files.length; attempt++) {
    await new Promise(resolve=>setTimeout(resolve,200));
    count = root.querySelectorAll(thumbnail).length;
  }
  return Math.min(count,transfer.files.length);
}
