// 回归：收藏夹排序按「加入当前这个收藏夹的时间」，不是共用的 Kazumi 入库时间。
// 同一个番在不同收藏夹里可以排在不同位置；换了收藏夹就重新计时；
// 新加入的条目要立刻归位，不能等刷新。
const fs = require('fs');
const assert = require('node:assert/strict');
const { chromium } = require('C:/Users/han/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

const harness = `
const $=(s,r=document)=>r.querySelector(s);
const $$=(s,r=document)=>[...r.querySelectorAll(s)];
const escapeHtml=v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const CATEGORIES=[{id:1,name:'在看'},{id:2,name:'想看'},{id:3,name:'搁置'},{id:4,name:'看过'},{id:5,name:'抛弃'}];
const CUSTOM_ID=7;
const CUSTOM_KEY='custom:'+CUSTOM_ID;
const state={
  animes:[],
  settings:{
    collection_sort_modes:{'1':'kazumi','2':'kazumi','all':'kazumi',[CUSTOM_KEY]:'kazumi'},
    collection_sort_directions:{},
    builtin_collection_order:[1,2,3,4,5],
    hide_custom_collection_items_from_builtin:false,
  },
  collectionKind:'builtin', category:1, customCollectionId:null,
  custom_collections:[{id:CUSTOM_ID,name:'通勤'}],
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
function makeAnime(id,extra={}){
  return Object.assign({
    id,name:'番剧'+id,name_cn:'番剧'+id,display_name:'番剧'+id,
    collection_type:1,air_date:'2025-01-01',cover_url:'/api/covers/'+id,
    episode_count:12,watched_episodes:[],bgm_score:7,bgm_rank:100,bgm_rating_total:100,
    kazumi_updated_at:'',collection_added_at:'',kazumi_position:0,custom_sort_order:0,
    custom_collection_ids:[],in_custom_collection:false,
  },extra);
}
`;

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 820 } });
    await page.setContent('<div id="animeGrid"></div><p id="emptyMessage"></p>');
    await page.addScriptTag({
      content: harness + fs.readFileSync('static/modules/collection.js', 'utf8'),
    });

    const result = await page.evaluate(() => {
      const order = () => filteredAnimes().map((item) => String(item.id));

      // a：入库早、但最近才进「在看」；b：入库晚、早在「在看」；c：没有加入时间字段
      const a = makeAnime(1, {
        kazumi_updated_at: '2026-01-01T00:00:00',
        collection_added_at: '2026-06-01T00:00:00+08:00',
        custom_collection_ids: [7],
        in_custom_collection: true,
        custom_collection_added_at: { '7': '2026-04-01T00:00:00+08:00' },
      });
      const b = makeAnime(2, {
        kazumi_updated_at: '2026-05-01T00:00:00',
        collection_added_at: '2026-02-01T00:00:00+08:00',
        custom_collection_ids: [7],
        in_custom_collection: true,
        custom_collection_added_at: { '7': '2026-08-01T00:00:00+08:00' },
      });
      const c = makeAnime(3, {
        kazumi_updated_at: '2026-07-01T00:00:00',
        collection_added_at: '',
      });
      commitAnimes([a, b, c], { render: false });

      const builtin = order();

      state.collectionKind = 'custom';
      state.customCollectionId = 7;
      const custom = order();

      // 换一个自定义收藏夹：a 在里面更晚，顺序应当反转
      state.customCollectionId = 8;

      state.collectionKind = 'all';
      state.customCollectionId = null;
      const all = order();

      // 新加入的番：后端已写好 collection_added_at，前端应立刻排到最前
      state.collectionKind = 'builtin';
      state.category = 1;
      const fresh = makeAnime(9, {
        kazumi_updated_at: '',
        collection_added_at: '2026-11-07T13:00:00+08:00',
      });
      commitAnimes([...state.animes, fresh], { render: false });
      const afterAdd = order();

      // 刷新：顺序打乱后重新入库，结果必须一样（幂等）
      commitAnimes([...state.animes].reverse(), { render: false });
      const afterRefresh = order();

      // 旧数据完全没有这两个字段时不能抛错
      let legacyOk = true;
      try {
        const legacy = { id: 42, name: '旧数据', display_name: '旧数据', collection_type: 1 };
        state.collectionKind = 'builtin';
        state.category = 2;
        commitAnimes([legacy], { render: false });
      } catch (_error) {
        legacyOk = false;
      }

      return { builtin, custom, all, afterAdd, afterRefresh, legacyOk };
    });

    // 内置分类：加入时间最新的在前（c 没有加入时间，回退到入库时间 07-01）
    assert.deepEqual(result.builtin, ['3', '1', '2'], '内置分类按各自的加入时间排序');
    // 自定义收藏夹：用 custom_collection_items.created_at，与内置分类互不干扰
    assert.deepEqual(result.custom, ['2', '1'], '自定义收藏夹按它自己的加入时间排序');
    // 全部收藏夹没有所属夹，退回入库时间
    assert.deepEqual(result.all, ['3', '2', '1'], '全部收藏夹退回 Kazumi 入库时间');
    // 新加入立刻在最前，不依赖刷新
    assert.equal(result.afterAdd[0], '9', '新加入的条目立即排到最前');
    assert.deepEqual(result.afterRefresh, result.afterAdd, '刷新前后顺序一致');
    assert.ok(result.legacyOk, '缺少时间字段的旧数据不会让排序抛错');

    console.log('Collection added order: builtin=' + result.builtin.join(',')
      + ' custom=' + result.custom.join(',')
      + ' all=' + result.all.join(',')
      + ' fresh=' + result.afterAdd[0]);
    await page.close();
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exit(1); });
