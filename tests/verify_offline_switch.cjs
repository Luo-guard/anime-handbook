// 换一部番再点「找资源」，关键词和结果必须跟着换，不能停在上一部番。
const fs = require('fs');
const assert = require('node:assert/strict');
const { chromium } = require('C:/Users/han/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

const html = fs.readFileSync('static/index.html', 'utf8');
const start = html.indexOf('<dialog class="modal offline-modal" id="offlineModal">');
const end = html.indexOf('</dialog>', start) + '</dialog>'.length;
assert(start > 0 && end > start, 'offline modal exists');
const modal = html.slice(start, end);

const setup = `
const $=(s,r=document)=>r.querySelector(s),$$=(s,r=document)=>[...r.querySelectorAll(s)];
const escapeHtml=v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const state={progressAnime:null,settings:{}};
const toast=()=>{};
window.requests=[];
window.api=async(url)=>{
  requests.push(url);
  if(url.includes('/api/offline/search')){
    const q=decodeURIComponent(new URLSearchParams(url.split('?')[1]).get('q')||'');
    return {host:'mikanime.tv',truncated:false,items:[{
      id:'t-'+q,title:'【测试组】'+q+' 资源',group:'测试组',resolution:'1080p',codec:'H.264',
      bit_depth:'',subtitles:'',size_text:'1.0 GB',published_at:'2026-11-06',batch:false,
      torrent_url:'https://example.com/'+encodeURIComponent(q)+'.torrent',page_url:'https://example.com/'
    }]};
  }
  if(url.includes('/api/offline/state')) return {files:[],jobs:[]};
  if(url.includes('/api/offline/settings')) return {config:{},paths:{},writable:{ok:true}};
  return {};
};
`;

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setContent(`<style>${fs.readFileSync('static/styles.css', 'utf8')}</style>${modal}`);
    await page.addScriptTag({ content: setup + fs.readFileSync('static/modules/offline.js', 'utf8') + `
      warmSubtitleRenderer = () => null; // 本测试只关心搜索，不加载字幕渲染器
    ` });

    const open = async (id, name) => {
      await page.evaluate(({ id, name }) => {
        state.progressAnime = { id, display_name: name };
        openOffline();
      }, { id, name });
      await page.waitForTimeout(120);
    };
    const searchQueries = () => page.evaluate(() =>
      window.requests.filter((url) => url.includes('/api/offline/search'))
        .map((url) => decodeURIComponent(new URLSearchParams(url.split('?')[1]).get('q') || '')));

    // 1) 第一部番：自动填名字并自动搜索
    await open(1, '学生会也有洞！');
    assert.equal(await page.locator('#offlineQuery').inputValue(), '学生会也有洞！');
    assert.equal(await page.locator('#offlineTarget').textContent(), '学生会也有洞！');
    assert.deepEqual(await searchQueries(), ['学生会也有洞！']);
    assert.match(await page.locator('#offlineList').textContent(), /学生会也有洞！ 资源/);

    // 2) 换成另一部番再点「找资源」：关键词、结果、请求都得换
    await open(2, '凡人修仙传 第五季');
    assert.equal(await page.locator('#offlineQuery').inputValue(), '凡人修仙传 第五季', 'query follows the new anime');
    assert.equal(await page.locator('#offlineTarget').textContent(), '凡人修仙传 第五季');
    assert.deepEqual(await searchQueries(), ['学生会也有洞！', '凡人修仙传 第五季'], 'a new search is issued');
    const listText = await page.locator('#offlineList').textContent();
    assert.match(listText, /凡人修仙传 第五季 资源/);
    assert.doesNotMatch(listText, /学生会也有洞！ 资源/, 'old results are gone');
    assert.deepEqual(await page.evaluate(() => offlineView.local), { files: [], jobs: [] }, 'local cache reset');

    // 3) 同一部番里手动改过的关键词要保留，不能被重新覆盖
    await page.locator('#offlineQuery').fill('凡人修仙传 剧场版');
    await page.locator('#offlineSearchButton').click();
    await page.waitForTimeout(120);
    await open(2, '凡人修仙传 第五季');
    assert.equal(await page.locator('#offlineQuery').inputValue(), '凡人修仙传 剧场版', 'custom query survives reopening the same anime');

    assert.deepEqual(errors, [], 'no page errors');
    console.log('Offline switch: query, results and requests follow the anime; custom query preserved within the same anime.');
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exit(1); });
