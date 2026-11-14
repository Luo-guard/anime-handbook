// 回归：收藏页「筛选与排序」弹窗的季度筛选。
// 结构是「一年一行 × 四季列」的紧凑矩阵，锁住这些不能被后续改动破坏的行为：
//   1. 年份多时默认 12 行，展开 / 收起可来回切；折叠区间的已选年份会自动展开；
//   2. 单格点选、按住拖过一片格子批量刷选（拖过的格子状态一致、不重复切换）；
//   3. 列头批量选同一季度、行首年份选全年、全选 / 清空；
//   4. 排序 7 项、每项一组升降序，选中项与方向都只高亮当前那个；
//   5. 弹窗在桌面与 320px 窄屏下都不横向溢出，底部按钮仍可见。
const fs = require('fs');
const assert = require('node:assert/strict');
const { chromium } = require('C:/Users/han/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

const harness = `
const $=(s,r=document)=>r.querySelector(s);
const $$=(s,r=document)=>[...r.querySelectorAll(s)];
const state={
  animes:[], settings:{}, seasonFilters:new Set(),
  collectionKind:'builtin', category:1, customCollectionId:null, custom_collections:[],
};
function renderCollection(){}
function toast(){}
// 单元格走 pointer 序列，不是 click；DOM 的 .click() 发不出 pointerdown。
function tapCell(el){
  el.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0}));
  document.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,button:0}));
}
function dragCell(el,panel){
  const r=el.getBoundingClientRect();
  panel.dispatchEvent(new PointerEvent('pointermove',{
    bubbles:true,button:0,clientX:r.left+r.width/2,clientY:r.top+r.height/2,
  }));
}
`;

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    const html = fs.readFileSync('static/index.html', 'utf8')
      .replace(/<script[\s\S]*?<\/script>/g, '')
      .replace(/<link[^>]*>/g, '');
    await page.setContent(`<style>${fs.readFileSync('static/styles.css', 'utf8')}</style>${html}`);
    await page.addScriptTag({
      content: harness + fs.readFileSync('static/modules/collection.js', 'utf8'),
    });

    const result = await page.evaluate(() => {
      // 24 个年份，覆盖「会折叠」的规模
      state.animes = Array.from({ length: 24 }, (_, i) => {
        const year = 2003 + i;
        return {
          id: i + 1, name: `番${i}`, name_cn: `番${i}`, display_name: `番${i}`,
          collection_type: 1, air_date: `${year}-04-01`, episode_count: 12,
        };
      });
      const panel = $('#seasonFilterPanel');
      const dialog = document.querySelector('#collectionFloatingPanel');
      // 拖选要用 elementFromPoint，弹窗必须先真的显示出来，否则矩阵坐标全是 0。
      if (!dialog.open) dialog.showModal();
      const sections = [...dialog.querySelectorAll(".collection-control-section")];
      const collapsedByDefault = sections.every((section) =>
        !section.open && section.querySelector(".cc-section-content").getBoundingClientRect().height === 0);
      if (!collapsedByDefault) throw new Error("筛选和排序默认收起");
      sections.forEach((section) => section.querySelector("summary").click());
      const rows = () => panel.querySelectorAll('.season-matrix-row').length;
      const pressed = () => [...panel.querySelectorAll('[data-season-key].active')]
        .map((b) => b.dataset.seasonKey).sort();
      const clear = () => { state.seasonFilters.clear(); renderSeasonFilter(); };

      renderSeasonFilter();
      const defaultRows = rows();
      const firstYear = panel.querySelector('.season-matrix-row').dataset.year;
      const moreText = panel.querySelector('[data-season-years-more]').textContent.trim();
      const cellCount = panel.querySelectorAll('[data-season-key]').length;
      const columnCount = panel.querySelectorAll('[data-season-column]').length;

      panel.querySelector('[data-season-years-more]').click();
      const expandedRows = rows();
      const collapseMode = panel.querySelector('[data-season-years-more]').dataset.seasonYearsMore;
      panel.querySelector('[data-season-years-more]').click();
      const collapsedRows = rows();

      // 单格点选：两个不同年份的格子，一次操作切换一次
      tapCell(panel.querySelector('[data-season-key="2026-1"]'));
      tapCell(panel.querySelector('[data-season-key="2025-7"]'));
      const picked = {
        size: state.seasonFilters.size,
        keys: pressed(),
        note: $('#ccSeasonNote').textContent.trim(),
        noteActive: $('#ccSeasonNote').classList.contains('is-active'),
        columnPartial: panel.querySelector('[data-season-column="1"]').classList.contains('partial'),
        yearPartial: panel.querySelector('[data-season-year="2026"]').classList.contains('partial'),
      };

      // 再点一次同一个格子必须取消，不能被 pointerdown + click 切两回
      tapCell(panel.querySelector('[data-season-key="2026-1"]'));
      const untapped = { size: state.seasonFilters.size, keys: pressed() };

      // 拖选：按下第一格，拖过同一行另外三格和第二行一格，全部刷成「选中」
      clear();
      const first = panel.querySelector('[data-season-key="2026-1"]');
      first.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
      ['2026-4', '2026-7', '2026-10', '2025-4'].forEach((key) => dragCell(panel.querySelector(`[data-season-key="${key}"]`), panel));
      const painted = [...state.seasonFilters].sort();
      document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
      const afterDrag = { size: state.seasonFilters.size, rows: rows() };

      // 列头批量：一次给所有可见年份选上同一个季度
      clear();
      panel.querySelector('[data-season-column="1"]').click();
      const columnBatch = {
        size: state.seasonFilters.size,
        allWinter: [...state.seasonFilters].every((key) => key.endsWith('-1')),
        columnActive: panel.querySelector('[data-season-column="1"]').classList.contains('active'),
      };
      panel.querySelector('[data-season-column="1"]').click();
      const columnOff = state.seasonFilters.size;

      // 行首年份：一次选满该年四季，再点取消
      clear();
      panel.querySelector('[data-season-year="2026"]').click();
      const fullYear = {
        size: state.seasonFilters.size,
        yearActive: panel.querySelector('[data-season-year="2026"]').classList.contains('active'),
        keys: pressed(),
      };
      panel.querySelector('[data-season-year="2026"]').click();
      const yearOff = state.seasonFilters.size;

      // 全选 / 清空
      panel.querySelector('[data-season-action="all"]').click();
      const all = { size: state.seasonFilters.size, expected: 12 * 4 };
      const clearButton = Boolean(panel.querySelector('[data-season-action="clear"]'));
      panel.querySelector('[data-season-action="clear"]').click();
      const cleared = { size: state.seasonFilters.size, clearGone: !panel.querySelector('[data-season-action="clear"]') };

      // 折叠区间里的已选年份会自动展开，否则用户看不到选中的格子
      state.seasonFilters = new Set(['2008-10']);
      renderSeasonFilter();
      const autoExpand = { rows: rows(), hasKey: Boolean(panel.querySelector('[data-season-key="2008-10"]')) };
      clear();

      // 排序面板结构（与季度改版无关，保持回归）
      const sortRows = [...document.querySelectorAll('#collectionSortPickerMenu > div')];
      const sortStruct = {
        rows: sortRows.length,
        labels: sortRows.map((r) => r.querySelector('span').textContent.trim()),
        dirButtons: sortRows.every((r) => r.querySelectorAll('[data-sort-direction]').length === 2),
        customHint: sortRows.at(-1).querySelector('.sort-row-hint')?.textContent.trim() || '',
      };
      state.settings.collection_sort_modes = { 1: 'rank' };
      state.settings.collection_sort_directions = { 1: 'desc' };
      updateSortPicker();
      if ($("#ccSortNote").textContent !== "评分 ↓") throw new Error("排序摘要应同步选择");
      const activeDirs = [...document.querySelectorAll('#collectionSortPickerMenu [data-sort-direction].active')];
      const highlight = {
        activeRows: sortRows.filter((r) => r.classList.contains('active')).map((r) => r.dataset.sortMode),
        activeDir: activeDirs.map((b) => b.dataset.sortDirection),
        activeDirParent: activeDirs[0]?.closest('div[data-sort-mode]')?.dataset.sortMode || '',
      };

      const box = dialog.getBoundingClientRect();
      let overflowX = 0;
      dialog.querySelectorAll('*').forEach((el) => {
        const r = el.getBoundingClientRect();
        if (!r.width) return;
        overflowX = Math.max(overflowX, Math.round(Math.max(r.right - box.right, box.left - r.left)));
      });
      const footer = dialog.querySelector('.cc-foot').getBoundingClientRect();
      const layout = {
        modalW: Math.round(box.width),
        overflowX,
        footerInside: footer.bottom <= box.bottom + 0.5,
        footerHasButtons: dialog.querySelectorAll('.cc-foot button').length,
      };

      return {
        defaultRows, firstYear, moreText, cellCount, columnCount,
        expandedRows, collapseMode, collapsedRows,
        picked, untapped, painted, afterDrag, columnBatch, columnOff,
        fullYear, yearOff, all, clearButton, cleared, autoExpand,
        sortStruct, highlight, layout,
      };
    });

    assert.equal(result.defaultRows, 12, `年份默认应只露 12 行，实际 ${result.defaultRows}`);
    assert.equal(result.firstYear, '2026', `第一行应是最新的 2026，实际 ${result.firstYear}`);
    assert.match(result.moreText, /更早的 12 个年份/, `展开按钮文案：${result.moreText}`);
    assert.equal(result.cellCount, 48, `12 行 × 4 季应有 48 个格子，实际 ${result.cellCount}`);
    assert.equal(result.columnCount, 4, '应有四个可批量点的列头');
    assert.equal(result.expandedRows, 24, `展开后应是 24 行，实际 ${result.expandedRows}`);
    assert.equal(result.collapseMode, 'collapse', '展开后按钮应切换成收起模式');
    assert.equal(result.collapsedRows, 12, `收起后回到 12 行，实际 ${result.collapsedRows}`);

    assert.equal(result.picked.size, 2, '两个不同年份的格子都应进筛选集合');
    assert.deepEqual(result.picked.keys, ['2025-7', '2026-1'], `选中态：${result.picked.keys}`);
    assert.match(result.picked.note, /已选 2 个季度/, `顶部计数：${result.picked.note}`);
    assert.ok(result.picked.noteActive, '有筛选时顶部计数要高亮');
    assert.ok(result.picked.columnPartial, '部分年份选了冬季，列头应显示半选');
    assert.ok(result.picked.yearPartial, '年份只选了一季，行首应显示半选');
    assert.equal(result.untapped.size, 1, '再点同一格应取消，不能切两回');
    assert.deepEqual(result.untapped.keys, ['2025-7']);

    assert.equal(result.painted.length, 5, `拖过 5 个格子应全部选中，实际 ${result.painted.length}`);
    assert.deepEqual(result.painted, ['2025-4', '2026-1', '2026-10', '2026-4', '2026-7'], `拖选结果：${result.painted}`);
    assert.equal(result.afterDrag.size, 5, '松手后筛选集合不应变化');
    assert.equal(result.afterDrag.rows, 12, '松手后应重渲染但保持 12 行');

    assert.equal(result.columnBatch.size, 12, `列头应一次选中 12 个年份的冬季，实际 ${result.columnBatch.size}`);
    assert.ok(result.columnBatch.allWinter, '列头批量只该影响该季度');
    assert.ok(result.columnBatch.columnActive, '全选后列头应高亮');
    assert.equal(result.columnOff, 0, '再点列头应全部取消');

    assert.equal(result.fullYear.size, 4, '选全年应补满四个季度');
    assert.deepEqual(result.fullYear.keys, ['2026-1', '2026-10', '2026-4', '2026-7']);
    assert.ok(result.fullYear.yearActive, '整年选满后行首年份应高亮');
    assert.equal(result.yearOff, 0, '再点行首应取消整年');

    assert.equal(result.all.size, result.all.expected, `全选应是 48 个季度，实际 ${result.all.size}`);
    assert.ok(result.clearButton, '有筛选时才出现「清空」');
    assert.equal(result.cleared.size, 0, '清空应清空筛选集合');
    assert.ok(result.cleared.clearGone, '清空后「清空」应消失');
    assert.equal(result.autoExpand.rows, 24, '折叠区间的已选年份应自动展开');
    assert.ok(result.autoExpand.hasKey, '自动展开后应能看到那个已选格子');

    assert.equal(result.sortStruct.rows, 7, `排序项应为 7 个，实际 ${result.sortStruct.rows}`);
    assert.deepEqual(result.sortStruct.labels, ['名称', '评分', '热度', '首播', '最新一集', '加入时间', '自定义'],
      `排序项名称：${result.sortStruct.labels}`);
    assert.ok(result.sortStruct.dirButtons, '每行都要有升序/降序两个按钮');
    assert.equal(result.sortStruct.customHint, '拖拽调整', '自定义行要说明靠拖拽调整顺序');
    assert.deepEqual(result.highlight.activeRows, ['rank'], `只有当前模式高亮：${result.highlight.activeRows}`);
    assert.deepEqual(result.highlight.activeDir, ['desc'], `只有当前方向高亮：${result.highlight.activeDir}`);
    assert.equal(result.highlight.activeDirParent, 'rank', '方向高亮不能跑到别的行上');

    assert.equal(result.layout.overflowX, 0, `弹窗内出现横向溢出 ${result.layout.overflowX}px`);
    assert.ok(result.layout.footerInside, '底部按钮栏不能被裁掉');
    assert.equal(result.layout.footerHasButtons, 2, '底部应有「恢复默认」和「完成」');

    await page.setViewportSize({ width: 320, height: 720 });
    const narrow = await page.evaluate(() => {
      const dialog = document.querySelector('#collectionFloatingPanel');
      const box = dialog.getBoundingClientRect();
      let overflowX = 0;
      dialog.querySelectorAll('*').forEach((el) => {
        const r = el.getBoundingClientRect();
        if (!r.width) return;
        overflowX = Math.max(overflowX, Math.round(Math.max(r.right - box.right, box.left - r.left)));
      });
      return {
        modalW: Math.round(box.width),
        overflowX,
        sortColumns: getComputedStyle(document.querySelector('#collectionSortPickerMenu')).gridTemplateColumns.split(' ').length,
        matrixColumns: getComputedStyle(document.querySelector('.season-matrix-row')).gridTemplateColumns.split(' ').length,
      };
    });
    assert.ok(narrow.modalW <= 320, `320px 视口下弹窗宽度 ${narrow.modalW} 超出屏幕`);
    assert.equal(narrow.overflowX, 0, `320px 下弹窗内横向溢出 ${narrow.overflowX}px`);
    assert.equal(narrow.sortColumns, 1, '360px 以下排序改成单列');
    assert.equal(narrow.matrixColumns, 5, '窄屏矩阵仍是 1 列年份 + 4 列季度');

    console.log('verify_collection_filter_panel: ok');
  } finally {
    await browser.close();
  }
})();
