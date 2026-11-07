// 「更多站点」第一次点开要先吃本机缓存，不能强制联网（审计 N10）。
// 以前 openRulesMenu 传的是 loadLinkRules(true)，刷新页面后第一次点都要等一次
// GitHub；断网时本机明明有几十条缓存，列表却是空的。
const fs = require('fs');
const assert = require('node:assert/strict');
const { chromium } = require('C:/Users/han/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

const html = fs.readFileSync('static/index.html', 'utf8');
const start = html.indexOf('<dialog class="modal rules-menu-dialog" id="rulesMenuModal">');
const end = html.indexOf('</dialog>', start) + '</dialog>'.length;
assert(start > 0 && end > start, 'rules menu modal exists');
const modal = html.slice(start, end);

const setup = `
const $=(s,r=document)=>r.querySelector(s),$$=(s,r=document)=>[...r.querySelectorAll(s)];
const escapeHtml=v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const state={settings:{}};
window.toasts=[];
const toast=(text,kind)=>toasts.push({text,kind});
const detailLinks=()=>[];
const detailLinkHref=(template)=>String(template);
const renderDetailLinks=()=>{};
const api=async()=>({ok:true,items:[]});
const linkRulesState={items:[],selected:new Set(),loading:false,error:'',fetchedAt:0,limit:12};
window.loadCalls=[];
// 模拟后端：force=false 读本机缓存（不发请求），force=true 才联网。
window.loadLinkRules=async(force=false)=>{
  loadCalls.push(Boolean(force));
  linkRulesState.loading=true;
  if (!force) {
    linkRulesState.items=[
      {id:'a',name:'站点甲',host:'jia.example',template:'https://jia.example/?q={title}'},
      {id:'b',name:'站点乙',host:'yi.example',template:'https://yi.example/?q={title}'},
    ];
    linkRulesState.fetchedAt=1762500000;
  }
  linkRulesState.loading=false;
};
`;

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setContent(`<style>${fs.readFileSync('static/styles.css', 'utf8')}</style>${modal}`);
    await page.addScriptTag({ content: setup + fs.readFileSync('static/modules/rules-menu.js', 'utf8') });
    await page.evaluate(() => document.dispatchEvent(new Event('DOMContentLoaded')));

    // 1) 空缓存第一次点开：先走缓存路径（force=false），列表立刻有内容。
    await page.evaluate(() => openRulesMenu({ id: 1, name_cn: '测试番' }));
    const calls = await page.evaluate(() => loadCalls);
    assert.deepEqual(calls, [false], `必须允许先读缓存：${JSON.stringify(calls)}`);
    const names = await page.locator('#rulesMenuList .rules-menu-name').allTextContents();
    assert.deepEqual(names, ['站点甲', '站点乙'], `菜单内容：${JSON.stringify(names)}`);
    const status = await page.locator('#rulesMenuStatus').textContent();
    assert.match(status, /共 2 个站点/, status);

    // 2) 缓存里已经有站点时再打开：一次请求都不发。
    await page.evaluate(() => {
      window.loadCalls = [];
      $('#rulesMenuModal').close();
    });
    await page.evaluate(() => openRulesMenu({ id: 2, name_cn: '另一部番' }));
    assert.deepEqual(await page.evaluate(() => loadCalls), [], '有缓存就不该再联网');

    assert.deepEqual(errors, [], 'no page errors');
    console.log('Rules menu cache first: 第一次点「更多站点」读本机缓存，不再强制联网。');
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exit(1); });
