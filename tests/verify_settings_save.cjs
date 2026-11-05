const fs=require('fs'),vm=require('vm'),assert=require('node:assert/strict');
const elements=new Map(),notices=[];let release,calls=0,shouldFail=false;
const element=selector=>{if(!elements.has(selector))elements.set(selector,{value:'',checked:false,disabled:false,close(){this.closed=true}});return elements.get(selector)};
const context={ThemeSettingsSession:{lock(){},payload:async()=>({}),finish(){}},console,Set,JSON,Object,Number,Boolean,state:{settings:{},custom_collections:[],noteThemes:new Set(['other']),timelineThemes:new Set(),activeView:'collection'},
 $:element,$$:selector=>selector==='.builtin-visibility-check'?[{dataset:{category:1},checked:true}]:[],
 toast:message=>notices.push(message),readDetailLinks:()=>[],readScheduleDetailLinks:()=>[],detailLinks:()=>[],syncLinkAdditions:()=>({detail:[],schedule:[],synced:[]}),
 readKeyboardSettings:()=>({}),keyboardPreferences:()=>({}),readScheduleSorting:()=>({schedule_sort:'time'}),requireScheduleSortingSupport:async()=>{},verifyScheduleSortingSaved(){},
 builtinCollectionOrder:()=>[1],sidebarOrder:()=>[],recordThemes:()=>[{id:'other'}],
 api:async(path,options)=>{calls++;const body=JSON.parse(options.body);await new Promise(resolve=>release=resolve);if(shouldFail)throw Error('failed save');return {settings:body}},
};
for(const name of ['renderSyncButton','applyTheme','applyCharacterTabVisibility','applyCollectionEditingAvailability','ensureVisibleCollection','applySidebarLayout','applyNoteComposerMode','switchView','renderStats','renderTabs','renderCollection'])context[name]=()=>{};
vm.createContext(context);vm.runInContext(fs.readFileSync('static/modules/settings-save.js','utf8'),context);
const save=()=>vm.runInContext('HandbookSettings.save()',context);
(async()=>{
 const first=save();await new Promise(setImmediate);assert.equal(calls,1);assert(element('#saveSettings').disabled);
 await save();assert.equal(calls,1,'double save while request is pending');release();await first;
 assert(!element('#saveSettings').disabled);assert(notices.includes('设置已保存'));
 shouldFail=true;const failed=save();await new Promise(setImmediate);release();await failed;
 assert(!element('#saveSettings').disabled);assert(notices.includes('failed save'));
 console.log('Settings save: one in-flight submission, duplicate ignored, button restored after success and failure.');
})().catch(error=>{console.error(error);process.exit(1)});
