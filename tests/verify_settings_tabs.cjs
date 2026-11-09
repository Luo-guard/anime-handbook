const fs=require('fs'),vm=require('vm'),assert=require('assert');
const source=require('./frontend_source.cjs'),start=source.indexOf('function setupSettingsTabs()'),end=source.indexOf('\n}',start)+2;
// 媒体库（offline）跟着主导航顺序走：收藏夹 → 番剧详情 → 媒体库 → 周表…
const order=['main','collection','detail','offline','schedule','record','statistics','ranking','keyboard','data','sharing'];
const original=[...order].reverse();
const buttons=order.map(name=>({dataset:{settingsTab:name},addEventListener(){}}));
const list={children:original.flatMap(name=>[{dataset:{settingsSection:name},name:name+' heading'},{dataset:{},name:name+' control'}]),replaceChildren(...children){this.children=children}};
const ctx=vm.createContext({document:{createElement:()=>({dataset:{},children:[],append(child){this.children.push(child)}})},$:()=>list,$$:()=>buttons,switchSettingsTab(){},syncSettingsNavigation(){}});
vm.runInContext('let settingsGroupsInitialized=false;'+source.slice(start,end)+';setupSettingsTabs()',ctx);
assert.equal(list.children.map(panel=>panel.dataset.settingsGroup).join(','),order.join(','));
for(const panel of list.children)assert.equal(panel.children[1].name,panel.dataset.settingsGroup+' control');
const html=fs.readFileSync('static/index.html','utf8');
assert.ok(/data-settings-tab="offline"[^>]*>媒体库</.test(html), '媒体库分类按钮要叫「媒体库」');
assert.ok(!/data-settings-tab="offline"[^>]*>离线下载</.test(html), '不能再叫「离线下载」');
assert.deepEqual([...html.matchAll(/data-settings-tab="([^"]+)"/g)].map(match=>match[1]),order);
const sections=[...html.matchAll(/data-settings-section="([^"]+)"/g)];
const content=Object.fromEntries(sections.map((match,index)=>[match[1],html.slice(match.index,sections[index+1]?.index??html.indexOf('id="saveSettings"'))]));
for(const [group,ids] of Object.entries({main:['themeProfileGrid','themeRandomOnOpenInput','themeWeeklyPlanEnabledInput','themeWeeklyPlan','defaultViewInput','launchAtLoginInput','sidebarSettingsList','shutdownBackendSettings','showShutdownButtonInput'],collection:['collectionHomeInput','showAllCollectionTabInput','showCollectionBgmRatingInput','collectionRatingSourceInput','showCollectionRatingControlInput','showCollectionProgressControlInput','showCreateCollectionControlInput','showMoveButtonWithoutCollectionsInput','hideCustomizedInput','settingsCustomCollections'],detail:['showBgmRatingInput','showCharacterTabInput','showEpisodeTitlesOnHoverInput','showEpisodeReviewRecordInput','showEpisodeRatingRecordInput','showOpedRecordInput','showAgeRelatedButtonInput','showSearchBgmLinkInput','mergeBilibiliLinksInput','showSavedVideoListInput','videoDefaultPinnedInput','detailLinkList'],schedule:['scheduleSortingSettings','scheduleCardFieldInputs'],record:['dayStartInput','newRecordDefaultsToOtherInput','timelineDefaultThemesMenu'],statistics:['showZeroStatisticsInput','statisticsDefaultThemeInput','showEpisodeBalanceInput','episodeBalanceDailyTargetInput'],ranking:['showRankingHoverTitlesInput','rankingHoverDelayInput'],keyboard:['keyboardEnabledInput','keyboardBindings','resetKeyboardBindings'],sharing:['handbookProfileInput','webdavUrlInput','sharingFolderInput'],offline:['librarySidebarMode','offlineMediaRoot','offlineDownloadRoot','offlineQbHost','offlineQbPort','offlineQbCategory','offlineSeedAfter','offlineAutoFollow','offlineSaveSettings','offlineResetRoot','offlineMigrate','offlineMediaHint','offlineCheckSubs']}))for(const id of ids){
 assert(content[group].includes(`id="${id}"`),`${id} must belong to ${group}`);
 assert.equal([...html.matchAll(new RegExp(`id="${id}"`,'g'))].length,1,`${id} must appear exactly once`);
}
console.log('Settings tabs: reordered navigation keeps all controls in the correct named group');
