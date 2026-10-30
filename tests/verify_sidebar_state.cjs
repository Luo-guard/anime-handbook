const fs = require('fs'), vm = require('vm'), assert = require('node:assert/strict');
const appearance = fs.readFileSync('static/appearance.js', 'utf8');
const presentation = fs.readFileSync('static/modules/presentation.js', 'utf8');
const saved = new Map();
function boot(blocked = false) {
  const root = {dataset:{},style:{setProperty(){},removeProperty(){}},classList:{toggle(){}}};
  const classes = new Map();
  const context = vm.createContext({window:{},document:{documentElement:root,getElementById(){return null}},localStorage:{getItem(k){if(blocked)throw Error();return saved.get(k)},setItem(k,v){if(blocked)throw Error();saved.set(k,v)}},console,$:selector=>({classList:{toggle(name,value){classes.set(selector+name,value)}}}),showSidebarToggle:()=>true});
  vm.runInContext(appearance,context);
  vm.runInContext(presentation.slice(presentation.indexOf('function setSidebarCollapsed('),presentation.indexOf('const SIDEBAR_ITEMS')),context);
  return {context,root,classes};
}
let page=boot();assert.equal(page.root.dataset.sidebarCollapsed,'false');
vm.runInContext('setSidebarCollapsed(true)',page.context);
page=boot();assert.equal(page.root.dataset.sidebarCollapsed,'true');
vm.runInContext('setSidebarCollapsed(false)',page.context);
page=boot();assert.equal(page.root.dataset.sidebarCollapsed,'false');
page=boot(true);vm.runInContext('setSidebarCollapsed(true)',page.context);
assert.equal(page.root.dataset.sidebarCollapsed,'true');
console.log('Sidebar collapse/expand survives fresh page loads; blocked storage degrades safely.');
