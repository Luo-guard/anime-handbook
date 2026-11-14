// 回归：收藏夹「最新一集」排序。
// 数据全部来自 bootstrap 已经下发的 anime.episodes（每条带 airdate），
// 这里验证取值规则本身：只算已播出的、未来排期不算、没有逐集日期退回首播、
// 一个日期都没有的排在最后（两个方向都最后）、方向可翻。
const fs = require('fs');
const assert = require('node:assert/strict');
const { chromium } = require('C:/Users/han/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

const harness = `
const $=(s,r=document)=>r.querySelector(s);
const $$=(s,r=document)=>[...r.querySelectorAll(s)];
const escapeHtml=v=>String(v??'');
const state={
  animes:[],
  settings:{collection_sort_modes:{'1':'latest'},collection_sort_directions:{'1':'asc'}},
  collectionKind:'builtin', category:1, customCollectionId:null, custom_collections:[],
  search:'', seasonFilters:new Set(), stats:{}, sync:{}, progressAnime:null,
};
function toast(){}
function api(){throw new Error('排序不需要任何请求');}
function showProgressBar(){return false;}
function showCollectionBgmRating(){return false;}
function showCustomMoveButton(){return false;}
function applyCollectionToolbarVisibility(){}
function episodeTotal(a){return (a.episodes||[]).length;}
`;

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 820 } });
    const html = fs.readFileSync('static/index.html', 'utf8')
      .replace(/<script[\s\S]*?<\/script>/g, '')
      .replace(/<link[^>]*>/g, '');
    await page.setContent(`<style>${fs.readFileSync('static/styles.css', 'utf8')}</style>${html}`);
    await page.addScriptTag({
      content: harness + fs.readFileSync('static/modules/collection.js', 'utf8'),
    });

    const result = await page.evaluate(() => {
      const ep = (sort, airdate, type = 0) => ({ key: `bgm:${sort}`, type, sort, airdate, label: String(sort), display_label: `本篇 ${sort}` });
      const anime = (id, name, episodes, extra = {}) => ({
        id, name, name_cn: name, display_name: name,
        collection_type: 1, air_date: '', cover_url: '', episode_count: episodes.length,
        watched_episodes: [], bgm_rank: 1, bgm_rating_total: 1, ...extra, episodes,
      });
      const order = (items, mode, direction) => {
        state.settings.collection_sort_modes = { '1': mode };
        state.settings.collection_sort_directions = { '1': direction };
        return [...items].sort(collectionComparator()).map((item) => item.display_name);
      };

      const items = [
        // 正在播：已播到 10-03，后面还有到 2027 的排期集（排期不算）
        anime(1, '正在播', [ep(11, '2026-09-12'), ep(12, '2026-09-19'), ep(13, '2026-09-26'), ep(14, '2026-10-03'), ep(15, '2027-02-06')]),
        // 完结：最后一集在 2026-06-20
        anime(2, '已完结', [ep(1, '2026-04-05'), ep(12, '2026-06-20')]),
        // 只有首播日期、没有逐集日期
        anime(3, '只有首播', [], { air_date: '2026-08-01', episode_count: 12 }),
        // 一个日期都没有
        anime(4, '没有日期', []),
        // 未开播：首播在未来
        anime(5, '未开播', [ep(1, '2099')], { air_date: '2027-01-10' }),
        // 只有年月
        anime(6, '只有年月', [ep(1, '2026-05')]),
      ];
      const 有日期_最新在前 = order(items, 'latest', 'asc');
      const 有日期_最早在前 = order(items, 'latest', 'desc');

      // 平手时按名称
      const tie = [anime(7, 'B番', [ep(1, '2026-05-01')]), anime(8, 'A番', [ep(1, '2026-05-01')])];
      const 平手 = order(tie, 'latest', 'asc');

      // 取值本身
      state.settings.collection_sort_modes = { '1': 'latest' };
      const today = localDayIso();
      const values = Object.fromEntries(items.map((item) => [item.display_name, latestAiredAt(item, today)]));

      // 未来日期不能被当成「最新一集」
      const futureOnly = anime(9, '排期排到很后面', [ep(1, '2027-05-29'), ep(2, '2027-06-01')], { air_date: '2027-05-01' });
      const future = latestAiredAt(futureOnly, today);
      // 其它排序方式不受影响
      const airdateOrder = order([anime(10, 'Z', [], { air_date: '2020-01-01' }), anime(11, 'A', [], { air_date: '2024-01-01' })], 'airdate', 'asc');

      // 性能：400 部番 × 20 集，比较器不能被调用一次就重扫一遍
      const many = Array.from({ length: 400 }, (_, index) => anime(1000 + index, `番${index}`,
        Array.from({ length: 20 }, (_, i) => ep(i + 1, `2026-${String((i % 12) + 1).padStart(2, '0')}-01`))));
      const started = performance.now();
      [...many].sort(collectionComparator());
      const sortedMs = performance.now() - started;

      // 排序方式面板里真的出现这一项，且两列补满
      const row = document.querySelector('[data-sort-mode="latest"]');
      // 7 项两列，最后一项要横跨两列（否则右下角留一个空洞）。
      // 弹窗默认是 display:none，量之前先打开，否则量到的是 0×0。
      const panel = document.querySelector('#collectionFloatingPanel');
      if (!panel.open) panel.showModal();
      document.querySelector('#collectionSortPickerMenu').closest('details').open = true;
      const gridColumns = getComputedStyle(document.querySelector('#collectionSortPickerMenu')).gridTemplateColumns;
      const menuBox = document.querySelector('#collectionSortPickerMenu').getBoundingClientRect().width;
      const customBox = document.querySelector('[data-sort-mode="custom"]').getBoundingClientRect().width;
      const customSpans = customBox > menuBox - 12;

      return {
        有日期_最新在前, 有日期_最早在前, 平手, values, future, airdateOrder, sortedMs,
        rows: document.querySelectorAll('#collectionSortPickerMenu > div').length,
        label: row ? row.querySelector('span').textContent : '',
        tip: row ? row.getAttribute('title') : '',
        gridColumns, customSpans, menuBox, customBox,
      };
    });

    assert.deepEqual(result.values, {
      '正在播': '2026-10-03',
      '已完结': '2026-06-20',
      '只有首播': '2026-08-01',
      '没有日期': '',
      '未开播': '',
      '只有年月': '2026-05-01',
    }, `latestAiredAt: ${JSON.stringify(result.values)}`);

    assert.equal(result.future, '', '全是未来排期时不能算成最新一集');

    assert.deepEqual(result.有日期_最新在前, ['正在播', '只有首播', '已完结', '只有年月', '没有日期', '未开播'],
      `最新在前: ${JSON.stringify(result.有日期_最新在前)}`);
    assert.deepEqual(result.有日期_最早在前, ['只有年月', '已完结', '只有首播', '正在播', '没有日期', '未开播'],
      `最早在前: ${JSON.stringify(result.有日期_最早在前)}`);

    assert.deepEqual(result.平手, ['A番', 'B番'], '同日按名称排');
    assert.deepEqual(result.airdateOrder, ['Z', 'A'], '其它排序方式不受影响');
    assert.ok(result.sortedMs < 400, `400 部番排序耗时 ${result.sortedMs.toFixed(1)}ms`);

    assert.equal(result.rows, 7, '排序方式应有 7 项');
    assert.equal(result.label, '最新一集');
    assert.ok(result.tip.includes('最新在前'), '要有方向说明的 tooltip');
    assert.ok(result.menuBox > 200, `排序菜单量到了真实宽度（${result.menuBox}）`);
    assert.ok(result.customSpans, `最后一项横跨两列，避免留空洞（${result.customBox} / ${result.menuBox}）`);

    console.log(`Collection latest order: values ok, asc/desc ok, future ignored, 400 items in ${result.sortedMs.toFixed(1)}ms, 7 rows / custom spans 2.`);
    await page.close();
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exit(1); });
