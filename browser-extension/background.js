function isHandbookURL(value){
 try{const url=new URL(value);return url.protocol==="http:"&&["127.0.0.1","localhost"].includes(url.hostname)&&url.port==="43127";}catch{return false;}
}
chrome.runtime.onMessage.addListener((message,sender,reply)=>{
  if(message.type==="handbook-ready" && sender.tab && isHandbookURL(sender.tab.url)) {
    chrome.storage.session.set({lastHandbookTab:sender.tab.id});return;
  }
  if(message.type!=="search" || !sender.tab || !/^http:\/\/(127\.0\.0\.1|localhost):43127\//.test(sender.tab.url)) return;
  const id=Number(message.animeId);
  if(!Number.isSafeInteger(id)||id<1)return;
  chrome.tabs.create({url:"https://search.bilibili.com/all?keyword="+encodeURIComponent(String(message.name).slice(0,200)),openerTabId:sender.tab.id}).then(async tab=>{
    await chrome.storage.session.set({[String(tab.id)]:{animeId:id,handbookTab:sender.tab.id}});
  });
});
chrome.tabs.onRemoved.addListener(id=>chrome.storage.session.remove(String(id)));

async function saveVideoFromTab(tab){
 try{
  const url=new URL(tab.url||"");
  const isVideo=url.protocol==="https:"&&["www.bilibili.com","bilibili.com"].includes(url.hostname)&&/^(?:\/video\/BV[0-9A-Za-z]{10}|\/bangumi\/play\/(?:ss|ep)[1-9][0-9]{0,11})\/?$/.test(url.pathname);
  // 非 B 站视频页面也能存，按“其他链接”处理；只有 chrome:// 这类页面不能读。
  if(!isVideo&&!["http:","https:"].includes(url.protocol))throw Error("这个页面不能保存，请打开网页后重试");
  const [result]=await chrome.scripting.executeScript({target:{tabId:tab.id},func:()=>({url:location.href,title:document.querySelector("h1")?.textContent.trim()||document.title,uploader:document.querySelector(".up-name")?.textContent.trim()||document.querySelector(".up-detail-top a")?.textContent.trim()||""})});
  const video=result.result;
  const context=(await chrome.storage.session.get(String(tab.id)))[String(tab.id)];
  const payload=isVideo
    ?{kind:"video",url:String(video.url).slice(0,2000),title:String(video.title).slice(0,200),uploader:String(video.uploader).slice(0,100),anime_id:context?.animeId||null}
    :{kind:"link",url:String(video.url).slice(0,2000),title:String(video.title).slice(0,200),uploader:"",anime_id:context?.animeId||null};
  const fragment="#save-video="+encodeURIComponent(JSON.stringify(payload));
  const known=await chrome.storage.session.get("lastHandbookTab");
  const matches=(await chrome.tabs.query({url:["http://127.0.0.1/*","http://localhost/*"]})).filter(t=>isHandbookURL(t.url));
  const candidates=[context?.handbookTab,known.lastHandbookTab,...matches.map(t=>t.id)].filter(Number.isInteger);
  let target=null;
  for(const id of [...new Set(candidates)]) {
    try{const existing=await chrome.tabs.get(id);if(isHandbookURL(existing.url)){target=existing;break;}}catch{}
  }
  if(target){
    const destination=new URL(target.url);destination.hash=fragment;
    await chrome.tabs.update(target.id,{url:destination.href,active:true});
    await chrome.windows.update(target.windowId,{focused:true});
  }else{
    await chrome.tabs.create({url:"http://localhost:43127/"+fragment,openerTabId:tab.id});
  }
  await chrome.action.setBadgeText({tabId:tab.id,text:""});
  await chrome.action.setTitle({tabId:tab.id,title:"保存当前页面到动漫手账"});
 }catch(error){
  await chrome.action.setBadgeText({tabId:tab.id,text:"!"});
  await chrome.action.setBadgeBackgroundColor({tabId:tab.id,color:"#a64d4d"});
  await chrome.action.setTitle({tabId:tab.id,title:error.message||"读取页面失败，请刷新后重试"});
 }
}
chrome.action.onClicked.addListener(saveVideoFromTab);
