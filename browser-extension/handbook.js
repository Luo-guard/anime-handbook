if(location.port==="43127" && !globalThis.handbookVideoBridgeInstalled) {
  globalThis.handbookVideoBridgeInstalled = true;
  chrome.runtime.sendMessage({type:"handbook-ready"}).catch(()=>{});
  document.addEventListener("click",event=>{
    const link=event.target.closest("#bilibiliSearchLink[data-anime-id]");
    if(!link || event.button!==0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)return;
    event.preventDefault();
    chrome.runtime.sendMessage({type:"search",animeId:Number(link.dataset.animeId),name:link.dataset.animeName});
  });
}
