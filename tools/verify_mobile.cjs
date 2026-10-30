const fs=require('fs'),vm=require('vm'),assert=require('assert');
const path=require('path');
const projectRoot=path.resolve(__dirname,'..');
const fixture=process.argv[2]?JSON.parse(fs.readFileSync(process.argv[2],'utf8')):{anime:Array.from({length:30},(_,i)=>({id:i+1,collection_type:i%5+1,active:1,name_cn:['幸运星','冰菓','再见'][i%3]+i,display_name:['幸运星','冰菓','再见'][i%3]+i,bgm_rank:i%4?30-i:0,bgm_rating_total:i*10,air_date:i%3?'2026-09-'+String(i%28+1).padStart(2,'0'):'',kazumi_updated_at:i%2?'2026-09-15':'',kazumi_position:30-i,custom_sort_order:i%7}))};
const mobile=fs.readFileSync(path.join(projectRoot,'android/app/src/main/assets/app.js'),'utf8').slice(0,fs.readFileSync(path.join(projectRoot,'android/app/src/main/assets/app.js'),'utf8').lastIndexOf("document.querySelectorAll('nav button')"));
const desktop=require('../tests/frontend_source.cjs');
const comparator=desktop.slice(desktop.indexOf('function collectionComparator()'),desktop.indexOf('\nfunction ',desktop.indexOf('function collectionComparator()')+1));
const context=vm.createContext({window:{AndroidHandbook:{state:()=>JSON.stringify({tables:{anime:fixture.anime,settings:[],custom_collection_items:[]}})}},document:{querySelector:()=>({})},console});
vm.runInContext(mobile,context);
let checks=0;
for(const mode of ['name','rank','popularity','airdate','kazumi','custom'])for(const direction of ['asc','desc'])for(const category of [1,2,3,4,5]){
 const settings={collection_sort_modes:{[category]:mode},collection_sort_directions:{[category]:direction}};
 context.testSettings=Object.entries(settings).map(([key,value])=>({key,value:JSON.stringify(value)}));context.testCategory=category;
 const got=vm.runInContext('category=testCategory; tables().settings=testSettings; collectionItems().map(a=>a.id)',context);
 const ref=vm.createContext({state:{settings,category},activeVisibilityKey:()=>String(category)});
 vm.runInContext('function collectionSortMode(){return state.settings.collection_sort_modes[state.category]} function collectionSortDirection(){return state.settings.collection_sort_directions[state.category]}'+comparator,ref);
 const expected=fixture.anime.filter(a=>Number(a.collection_type)===category&&a.active!==0).sort(vm.runInContext('collectionComparator()',ref)).map(a=>a.id);
 assert.equal(JSON.stringify(got),JSON.stringify(expected));checks++;
}
context.testSettings=[{key:'hide_custom_collection_items_from_builtin',value:'true'}];context.testId=fixture.anime.find(a=>a.collection_type===1).id;
assert.equal(vm.runInContext('category=1;tables().settings=testSettings;tables().custom_collection_items=[{anime_id:testId}];collectionItems().some(a=>a.id===testId)',context),false);
const url=vm.runInContext("cover({image_url:'https://api.bgm.tv/v0/subjects/27364/image?type=large'})",context);assert(url.includes('covers.animehandbook.local/?url=https%3A%2F%2Fapi.bgm.tv'));
console.log(`${checks} desktop/mobile sort comparisons passed; custom visibility and cover routing passed`);

