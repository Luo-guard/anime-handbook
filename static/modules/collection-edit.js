// All entry points share one status editor and one account-scoped write endpoint.
let collectionSearchVersion=0;
function collectionStatusOptions(selected=2) {
 return CATEGORIES.map(c=>`<option value="${c.id}" ${c.id===selected?'selected':''}>${escapeHtml(c.name)}</option>`).join('');
}
async function changeCollectionStatus(id,status) {
 const result=await api('/api/collection-status',{method:'POST',body:JSON.stringify({anime_id:Number(id),status:Number(status)})});
 state.animes=result.animes;if(result.stats){state.stats=result.stats;renderStats();}renderCollection();renderTabs();
 if(state.progressAnime?.id===Number(id)) {state.progressAnime=state.animes.find(a=>a.id===Number(id));$('#progressCategory').textContent=state.progressAnime.category_name;}
 toast(window.handbookOnline?'收藏已更新':'收藏已更新，已加入 Kazumi 待写回队列');
 return result.anime;
}
function collectionAction(id,status=2) {
 const box=document.createElement('div');box.className='collection-edit-actions';
 box.innerHTML=`<select aria-label="收藏状态">${collectionStatusOptions(status)}</select><button type="button" class="primary-button">保存收藏状态</button>`;
 box.querySelector('button').onclick=async()=>{const button=box.querySelector('button');button.disabled=true;try{await changeCollectionStatus(id,box.querySelector('select').value);}catch(e){toast(e.message,'error');}finally{button.disabled=false;}};
 return box;
}
$('#collectionSearchButton').onclick=()=>$('#collectionSearchModal').showModal();
$('#collectionSearchClose').onclick=()=>{$('#collectionSearchModal').close();collectionSearchVersion++;};
$('#collectionSearchForm').onsubmit=async event=>{
 event.preventDefault();const version=++collectionSearchVersion,results=$('#collectionSearchResults');results.textContent='正在搜索…';
 try{
  const result=await api(`/api/collection-search?q=${encodeURIComponent($('#collectionSearchQuery').value)}`);
  if(version!==collectionSearchVersion||!$('#collectionSearchModal').open)return;
  results.replaceChildren();
  for(const row of result.items){
   const card=document.createElement('article');card.className='collection-search-result';
   const title=document.createElement('strong');title.textContent=row.name_cn||row.name;card.append(title);
   const note=document.createElement('p');note.textContent=[row.name,row.date].filter(Boolean).join(' · ');card.append(note);
   card.append(collectionAction(row.id,state.animes.find(a=>a.id===row.id)?.collection_type||2));results.append(card);
  }
  if(!result.items.length)results.textContent='没有找到匹配的动画条目。';
 }catch(e){if(version===collectionSearchVersion)results.textContent=e.message;}
};

$('#collectionOutboxButton').onclick=async()=>{try{const result=await api('/api/collection-outbox');$('#collectionOutboxStatus').textContent=result.items.length?result.items.map(item=>`#${item.anime_id}：${item.error||'等待 Kazumi 关闭后写回'}`).join('；'):'没有待同步任务';}catch(e){toast(e.message,'error');}};
