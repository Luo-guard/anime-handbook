const fs=require('fs'),vm=require('vm'),assert=require('assert');
const source=require('./frontend_source.cjs'),start=source.indexOf('function setupSettingsTabs()'),end=source.indexOf('\n$$(".nav-item[data-view]")',start);
const order=['theme','collection','schedule','record','statistics','ranking','keyboard','data','sharing'];
const original=[...order].reverse();
const buttons=order.map(name=>({dataset:{settingsTab:name},addEventListener(){}}));
const list={children:original.flatMap(name=>[{dataset:{settingsSection:name},name:name+' heading'},{dataset:{},name:name+' control'}]),replaceChildren(...children){this.children=children}};
const ctx=vm.createContext({document:{createElement:()=>({dataset:{},children:[],append(child){this.children.push(child)}})},$:()=>list,$$:()=>buttons,switchSettingsTab(){},syncSettingsNavigation(){}});
vm.runInContext('let settingsGroupsInitialized=false;'+source.slice(start,end)+';setupSettingsTabs()',ctx);
assert.equal(list.children.map(panel=>panel.dataset.settingsGroup).join(','),order.join(','));
for(const panel of list.children)assert.equal(panel.children[1].name,panel.dataset.settingsGroup+' control');
const html=fs.readFileSync('static/index.html','utf8');
assert.deepEqual([...html.matchAll(/data-settings-tab="([^"]+)"/g)].map(match=>match[1]),order);
const sections=[...html.matchAll(/data-settings-section="([^"]+)"/g)];
const content=Object.fromEntries(sections.map((match,index)=>[match[1],html.slice(match.index,sections[index+1]?.index??html.indexOf('id="saveSettings"'))]));
for(const [group,ids] of Object.entries({theme:['themeProfileInput','defaultViewInput','launchAtLoginInput','sidebarSettingsList','shutdownBackendSettings','showShutdownButtonInput'],collection:['mergeBilibiliLinksInput','showSavedVideoListInput','collectionHomeInput','showCollectionBgmRatingInput','collectionRatingSourceInput','showCollectionRatingControlInput','settingsCustomCollections','showBgmRatingInput','showCharacterTabInput','showBilibiliSearchButtonInput','showEpisodeReviewRecordInput','showEpisodeRatingRecordInput','showOpedRecordInput'],schedule:['scheduleSortingSettings','scheduleCardFieldInputs'],record:['dayStartInput','newRecordDefaultsToOtherInput'],statistics:['showZeroStatisticsInput','statisticsDefaultThemeInput','showEpisodeBalanceInput','episodeBalanceDailyTargetInput'],ranking:['showRankingHoverTitlesInput','rankingHoverDelayInput'],keyboard:['keyboardEnabledInput','keyboardBindings','resetKeyboardBindings'],sharing:['handbookProfileInput','webdavUrlInput','sharingFolderInput']}))for(const id of ids){
 assert(content[group].includes(`id="${id}"`),`${id} must belong to ${group}`);
 assert.equal([...html.matchAll(new RegExp(`id="${id}"`,'g'))].length,1,`${id} must appear exactly once`);
}
console.log('Settings tabs: reordered navigation keeps all controls in the correct named group');
