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
    for (let attempt=0; attempt<10; attempt++) {
      const frames = draft.platform === "qzone" ? {allFrames:true} : {};
      const results = await run(frames,[draft.platform,"locate"]).catch(() => run({},[draft.platform,"locate"]));
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
      await run({},[draft.platform,"notice","手账暂未识别到编辑器。请登录，打开写说说或发帖界面，再点下方重试。"]);
      return;
    }
    if (editor.result.occupied) {
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
    const sent = result.result.images;
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
      root:".bili-dyn-publish,.dyn-publish,.bgd-publish",
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
  const known = candidates.filter(({node,root})=>isComposerText(node) || (platform !== "heybox" && candidates.length===1 && root.tagName!=="FORM"));
  const editor = known.length===1 ? known[0] : null;
  const entry = [...document.querySelectorAll("a,button,[role='button']")].find(node=>visible(node) && adapter.entry.includes(node.textContent.trim()));
  const occupied = node => Boolean((node.value ?? node.innerText ?? node.textContent).trim() || node.querySelector("img,video,[data-attachment]"));
  if (action === "locate") return {editor:Boolean(editor),occupied:editor ? occupied(editor.node) : false,entry:Boolean(entry)};
  if (action === "open" && !editor) {
    // Use only listed composer-entry labels. Never invoke form submission.
    if (entry && !entry.closest("form") && entry.getAttribute("type") !== "submit") entry.click();
    return;
  }
  if (!editor || occupied(editor.node)) return {ok:false};
  const {node,root} = editor;
  const imageInputs = scope => [...scope.querySelectorAll('input[type="file"]:not([disabled])')];
  const acceptsImages = item => /image|png|jpe?g|webp/i.test(item.accept);
  const findImageInput = inputs => inputs.find(acceptsImages) ||
    (platform === "qzone" && inputs.length === 1 && !inputs[0].accept ? inputs[0] : null);
  const imageInput = () => findImageInput(imageInputs(root));
  let input = imageInput();
  if (input?.files.length) return {ok:false};
  if (payload.text) {
    node.focus();
    if (node instanceof HTMLTextAreaElement) {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(node,payload.text);
      node.dispatchEvent(new Event("input",{bubbles:true}));
      node.dispatchEvent(new Event("change",{bubbles:true}));
    } else if (platform === "qzone") {
      // The legacy Qzone composer can serialize editor HTML as the message.
      // A plain text node preserves newlines without inserting <div> or <br>.
      node.style.whiteSpace = "pre-wrap";
      node.textContent = payload.text.replace(/\r\n?/g,"\n");
      node.dispatchEvent(new InputEvent("input",{bubbles:true,inputType:"insertText",data:node.textContent}));
    } else {
      const lines = payload.text.replace(/\r\n?/g,"\n").split("\n");
      const inserted = lines.every((line,index) =>
        (!index || document.execCommand("insertLineBreak")) &&
        (!line || document.execCommand("insertText",false,line)));
      if (!inserted || !occupied(node)) {
        node.replaceChildren(...lines.flatMap((line,index)=>index ? [document.createElement("br"),document.createTextNode(line)] : [document.createTextNode(line)]));
        node.dispatchEvent(new InputEvent("input",{bubbles:true,inputType:"insertText",data:payload.text}));
      }
    }
    if (!occupied(node)) return {ok:false};
  }
  if (!payload.files.length) return {ok:true,images:0};
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
  if (!input || input.disabled || input.files.length) return {ok:true,images:0};
  const files = new DataTransfer();
  for (const {name,mime,data} of payload.files.slice(0,input.multiple ? payload.files.length : 1)) {
    files.items.add(new File([Uint8Array.from(atob(data),char=>char.charCodeAt(0))],name,{type:mime}));
  }
  input.files = files.files;
  input.dispatchEvent(new Event("input",{bubbles:true}));
  input.dispatchEvent(new Event("change",{bubbles:true}));
  return {ok:true,images:files.files.length};
}
