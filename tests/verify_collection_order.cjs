// 回归：收藏夹内容变更（新增 / 调整 / 移入收纳夹 / 刷新）后顺序必须立刻一致。
// 以前各入口把新对象追加进 state.animes，界面顺序却在渲染时另算，
// 于是「刚加入在底部、刷新后归位」。现在统一走 commitAnimes()。
const fs = require('fs');
const assert = require('node:assert/strict');
const { chromium } = require('C:/Users/han/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

const harness = `
const $=(s,r=document)=>r.querySelector(s);
const $$=(s,r=document)=>[...r.querySelectorAll(s)];
const escapeHtml=v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const CATEGORIES=[{id:1,name:'在看'},{id:2,name:'想看'},{id:3,name:'看完'},{id:4,name:'搁置'},{id:5,name:'抛弃'}];
const state={
  animes:[],
  settings:{
    collection_sort_modes:{'1':'airdate'},
    collection_sort_directions:{'1':'desc'},
    builtin_collection_order:[1,2,3,4,5],
  },
  collectionKind:'builtin', category:1, customCollectionId:null, custom_collections:[],
  search:'', seasonFilters:new Set(), stats:{}, sync:{}, progressAnime:null,
};
function showProgressBar(){return false;}
function showCollectionBgmRating(){return false;}
function showCustomMoveButton(){return false;}
function episodeTotal(a){return Number(a.episode_count||0);}
function applyCollectionToolbarVisibility(){}
function openCustomMoveMenu(){}
function openProgress(){}
function toast(){}
async function api(){return {animes:state.animes};}
function makeAnime(id,name,date,category=1,extra={}){
  return {id,name,name_cn:name,display_name:name,collection_type:category,air_date:date,
    cover_url:'/api/covers/'+id,episode_count:12,watched_episodes:[],
    bgm_score:7,bgm_rank:100,bgm_rating_total:100,kazumi_updated_at:'2026-01-0'+id,
    kazumi_position:0,custom_sort_order:id,custom_collection_ids:[],in_custom_collection:false,
    ...extra};
}
`;

const domIds = () => `[...document.querySelectorAll('#animeGrid .anime-card')].map(x=>x.dataset.animeId)`;
const expected = () => `filteredAnimes().map(x=>String(x.id))`;

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 820 } });
    const html = fs.readFileSync('static/index.html', 'utf8')
      .replace(/<script[\s\S]*?<\/script>/g, '')
      .replace(/<link[^>]*>/g, '');
    await page.setContent(`<style>${fs.readFileSync('static/styles.css', 'utf8')}</style>${html}`);
    await page.addScriptTag({
      content: harness
        + fs.readFileSync('static/modules/collection.js', 'utf8')
        + '\n'
        + fs.readFileSync('static/modules/collection-cards.js', 'utf8'),
    });

    const result = await page.evaluate(() => {
      const ids = () => [...document.querySelectorAll('#animeGrid .anime-card')].map(x => x.dataset.animeId);
      const expected = () => filteredAnimes().map(x => String(x.id));
      const before = [1, 2, 3, 4, 5].map(i => makeAnime(i, '番剧' + i, '2025-0' + i + '-01'));

      // 初始入库（刷新/bootstrap 走的路）
      commitAnimes(before);
      const baseline = state.animes.map(x => x.id);
      const dom0 = ids();
      const expected0 = expected();

      // 新增：模拟后端把新条目放在数组末尾；airdate desc 下它应排到最前
      const fresh = makeAnime(9, '新入库番', '2026-11-06');
      commitAnimes([...state.animes, fresh]);
      const newPos = state.animes.findIndex(x => x.id === 9);
      const domAdded = ids();
      const expectedAdded = expected();
      const oldRelative = state.animes.filter(x => x.id !== 9).map(x => x.id);

      // 调整：改动一集的排序字段后重新提交
      const changed = state.animes.map(x => x.id === 9 ? { ...x, air_date: '2024-01-01' } : x);
      commitAnimes(changed);
      const domChanged = ids();
      const expectedChanged = expected();

      // 刷新：同一份数据以完全相反的初始顺序重新入库
      const orderBeforeRefresh = state.animes.map(x => x.id);
      commitAnimes([...state.animes].reverse());
      const domRefresh = ids();
      const expectedRefresh = expected();
      const orderAfterRefresh = state.animes.map(x => x.id);

      // 分类展示不受影响：只显示另一个分类
      state.animes[0].collection_type = 2;
      commitAnimes(state.animes, { render: false });
      state.category = 2;
      renderCollection();
      const categoryIds = expected();
      state.category = 1;

      // 名称比较器对暂时缺 display_name 的新条目不能抛错
      let missingNameOk = true;
      try {
        commitAnimes([...state.animes, { ...fresh, id: 10, display_name: undefined, name_cn: '', name: '' }], { render: false });
      } catch (_error) { missingNameOk = false; }

      return {
        baseline, dom0, expected0,
        newPos, lastIndex: state.animes.length - 1,
        domAdded, expectedAdded, oldRelative,
        domChanged, expectedChanged,
        domRefresh, orderBeforeRefresh, orderAfterRefresh, expectedRefresh,
        categoryIds, missingNameOk,
      };
    });

    // 初始渲染顺序 = 排序规则
    assert.deepEqual(result.dom0, result.expected0, '初次入库即按排序规则渲染');
    // 新增条目写入时就归位，而不是追加在底部
    assert.notEqual(result.newPos, result.lastIndex, '新增条目不能停留在数组末尾');
    assert.deepEqual(result.domAdded, result.expectedAdded, '新增后 DOM 顺序等于排序规则');
    assert.deepEqual(result.oldRelative, result.baseline, '已有条目的相对顺序不变');
    // 调整后立即保持规则
    assert.deepEqual(result.domChanged, result.expectedChanged, '调整后立即按规则重排');
    // 刷新前后一致（幂等）
    assert.deepEqual(result.domRefresh, result.domChanged, '刷新后顺序与调整后完全一致');
    assert.deepEqual(result.domRefresh, result.expectedRefresh, '刷新后仍等于排序规则');
    assert.deepEqual(result.orderAfterRefresh, result.orderBeforeRefresh, '重新入库不改变规范化后的数组顺序');
    // 分类过滤不受影响
    assert.ok(result.categoryIds.length > 0 && result.categoryIds.every(id => id !== '9'), '分类展示仍按 collection_type 过滤');
    assert.ok(result.missingNameOk, '缺少 display_name 的新条目不会让排序抛错');

    console.log('Collection order: inserted at #' + result.newPos + ', added/changed/refreshed DOM identical, existing items stable, category filter intact.');
    await page.close();
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exit(1); });
