if(location.port==="43127" && !globalThis.handbookVideoBridgeInstalled) {
  globalThis.handbookVideoBridgeInstalled = true;
  chrome.runtime.sendMessage({type:"handbook-ready"}).catch(()=>{});
  document.addEventListener("click",event=>{
    const link=event.target.closest("#bilibiliSearchLink[data-anime-id]");
    if(!link || event.button!==0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)return;
    event.preventDefault();
    chrome.runtime.sendMessage({type:"search",animeId:Number(link.dataset.animeId),name:link.dataset.animeName});
  });
  document.addEventListener("click", async event => {
    const link = event.target.closest("#recordShareTargets a[data-share-platform]");
    if (!link || !event.isTrusted || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    event.stopPropagation();
    const status = document.querySelector("#recordShareStatus");
    status.textContent = "正在打开平台编辑器…";
    try {
      const draft = {
        type: "handbook-share-draft",
        platform: link.dataset.sharePlatform,
        text: document.querySelector("#recordShareText").value,
        images: [...document.querySelectorAll("#recordShareImages a")].map(item => item.getAttribute("href")),
      };
      const result = await chrome.runtime.sendMessage(draft);
      status.textContent = result?.ok ? "已打开平台，填充进度会显示在新标签页。" : (result?.error || "打开失败，请刷新扩展和手账后重试。");
    } catch {
      status.textContent = "扩展未连接，请重新加载扩展并刷新手账。";
    }
  }, true);
}
