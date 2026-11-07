// 回归：收藏页「筛选与排序」弹窗。
// 结构从「所有年份 × 四季平铺 + 内部滚动」改成「年份网格（默认 12 个，可展开）+ 单年四季」，
// 排序项右侧的升降序收成一组分段按钮。这里锁住几条不能被后续改动破坏的行为：
//   1. 年份数量多时默认只露 12 个，展开按钮能来回切换；
//   2. 当前年份落在折叠区间时自动展开，否则看不到高亮项；
//   3. 季度多选、选全年、清除全部的计数与文案；
//   4. 排序 7 项、每项一组升降序，选中项与方向都只高亮当前那个；
//   5. 弹窗打开后在常规桌面宽度下不出现横向溢出。
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

    const result = await page.evaluate(async () => {
      // 24 个年份，覆盖「会折叠」的规模
      state.animes = Array.from({ length: 24 }, (_, i) => {
        const year = 2003 + i;
        return {
          id: i + 1, name: `番${i}`, name_cn: `番${i}`, display_name: `番${i}`,
          collection_type: 1, air_date: `${year}-04-01`, episode_count: 12,
        };
      });
      const tick = () => new Promise((r) => setTimeout(r, 0));

      renderSeasonFilter();
      const panel = $('#seasonFilterPanel');
      const defaultTabs = panel.querySelectorAll('[data-season-year-tab]').length;
      const activeDefault = panel.querySelector('.season-year-tab.active').textContent.trim();
      const moreText = panel.querySelector('[data-season-years-more]').textContent.trim();

      // 展开 → 24，收起 → 12
      panel.querySelector('[data-season-years-more]').click();
      await tick();
      const expandedTabs = panel.querySelectorAll('[data-season-year-tab]').length;
      const collapseMode = panel.querySelector('[data-season-years-more]').dataset.seasonYearsMore;
      panel.querySelector('[data-season-years-more]').click();
      await tick();
      const collapsedTabs = panel.querySelectorAll('[data-season-year-tab]').length;

      // 选中折叠区间里的年份（2010）→ 自动展开，且该年高亮
      panel.querySelector('[data-season-year-tab="2024"]').click();
      await tick();
      const afterSwitch = {
        active: panel.querySelector('.season-year-tab.active').textContent.trim(),
        summary: panel.querySelector('.season-year-summary').textContent.trim(),
        firstKey: panel.querySelector('[data-season-key]').dataset.seasonKey,
        seasonCount: panel.querySelectorAll('[data-season-key]').length,
      };

      // 多选两个季度
      panel.querySelector('[data-season-key="2024-1"]').click();
      await tick();
      panel.querySelector('[data-season-key="2024-7"]').click();
      await tick();
      const picked = {
        size: state.seasonFilters.size,
        summary: panel.querySelector('.season-year-summary').textContent.trim(),
        note: $('#ccSeasonNote').textContent.trim(),
        noteActive: $('#ccSeasonNote').classList.contains('is-active'),
        pressed: [...panel.querySelectorAll('[data-season-key]')]
          .filter((b) => b.getAttribute('aria-pressed') === 'true')
          .map((b) => b.dataset.seasonKey).sort(),
        yearDot: panel.querySelector('[data-season-year-tab="2024"]').classList.contains('picked'),
        clearButton: Boolean(panel.querySelector('[data-season-action="clear"]')),
      };

      // 清除全部（此时正有 2 个季度）
      panel.querySelector('[data-season-action="clear"]').click();
      await tick();
      const cleared = {
        size: state.seasonFilters.size,
        note: $('#ccSeasonNote').textContent.trim(),
        clearGone: !panel.querySelector('[data-season-action="clear"]'),
      };

      // 选全年 → 四个季度全选，按钮变成「取消全年」
      panel.querySelector('[data-season-year="2024"]').click();
      await tick();
      const fullYear = {
        size: state.seasonFilters.size,
        allPicked: [...panel.querySelectorAll('[data-season-key]')].every((b) => b.getAttribute('aria-pressed') === 'true'),
        label: panel.querySelector('[data-season-year="2024"]').textContent.trim(),
      };
      panel.querySelector('[data-season-year="2024"]').click();
      await tick();
      const yearOff = { size: state.seasonFilters.size };

      // 折叠区间里的年份（2008）直接设进筛选 → 渲染时必须自动展开
      state.seasonFilters = new Set(['2008-10']);
      seasonFilterYear = null;
      renderSeasonFilter();
      const autoExpand = {
        tabs: panel.querySelectorAll('[data-season-year-tab]').length,
        active: panel.querySelector('.season-year-tab.active').textContent.trim(),
      };
      state.seasonFilters.clear();
      seasonFilterYear = null;
      renderSeasonFilter();

      // 排序面板结构
      const sortRows = [...document.querySelectorAll('#collectionSortPickerMenu > div')];
      const sortStruct = {
        rows: sortRows.length,
        modes: sortRows.map((r) => r.dataset.sortMode),
        labels: sortRows.map((r) => r.querySelector('span').textContent.trim()),
        dirButtons: sortRows.every((r) => r.querySelectorAll('[data-sort-direction]').length === 2),
        customHint: sortRows.at(-1).querySelector('.sort-row-hint')?.textContent.trim() || '',
      };

      // 高亮：只有当前模式那行 active，只有当前方向那个按钮 active
      state.settings.collection_sort_modes = { 1: 'rank' };
      state.settings.collection_sort_directions = { 1: 'desc' };
      updateSortPicker();
      const activeRow = sortRows.filter((r) => r.classList.contains('active'));
      const activeDirs = [...document.querySelectorAll('#collectionSortPickerMenu [data-sort-direction].active')];
      const highlight = {
        activeRows: activeRow.map((r) => r.dataset.sortMode),
        activeDir: activeDirs.map((b) => b.dataset.sortDirection),
        activeDirParent: activeDirs[0]?.closest('div[data-sort-mode]')?.dataset.sortMode || '',
      };

      // 打开弹窗量宽度：任何子元素都不能横向戳出弹窗
      const dialog = document.querySelector('#collectionFloatingPanel');
      if (!dialog.open) dialog.showModal();
      const box = dialog.getBoundingClientRect();
      let overflowX = 0;
      dialog.querySelectorAll('*').forEach((el) => {
        const r = el.getBoundingClientRect();
        if (!r.width) return;
        overflowX = Math.max(overflowX, Math.round(Math.max(r.right - box.right, box.left - r.left)));
      });
      const footer = dialog.querySelector('.cc-foot').getBoundingClientRect();

      return {
        defaultTabs, activeDefault, moreText, expandedTabs, collapseMode, collapsedTabs,
        afterSwitch, picked, fullYear, yearOff, cleared, autoExpand,
        sortStruct, highlight,
        layout: {
          modalW: Math.round(box.width),
          modalH: Math.round(box.height),
          overflowX,
          footerInside: footer.bottom <= box.bottom + 0.5,
          footerHasButtons: dialog.querySelectorAll('.cc-foot button').length,
        },
      };
    });

    assert.equal(result.defaultTabs, 12, `年份默认应只露 12 个，实际 ${result.defaultTabs}`);
    assert.equal(result.activeDefault, '2026', `默认应停在该年最新的年份，实际 ${result.activeDefault}`);
    assert.match(result.moreText, /更早的 12 个年份/, `展开按钮文案：${result.moreText}`);
    assert.equal(result.expandedTabs, 24, `展开后应显示全部 24 个年份，实际 ${result.expandedTabs}`);
    assert.equal(result.collapseMode, 'collapse', '展开后按钮应切换成收起模式');
    assert.equal(result.collapsedTabs, 12, `收起后应回到 12 个，实际 ${result.collapsedTabs}`);

    assert.equal(result.afterSwitch.active, '2024', '点年份应切到该年');
    assert.equal(result.afterSwitch.summary, '2024 年 · 已选 0/4', `摘要文案：${result.afterSwitch.summary}`);
    assert.equal(result.afterSwitch.seasonCount, 4, '每年固定四个季度');
    assert.equal(result.afterSwitch.firstKey, '2024-1', `季度 key 应跟着年份走，实际 ${result.afterSwitch.firstKey}`);

    assert.equal(result.picked.size, 2, '两个季度应都进筛选集合');
    assert.deepEqual(result.picked.pressed, ['2024-1', '2024-7'], `选中态：${result.picked.pressed}`);
    assert.match(result.picked.summary, /已选 2\/4/, `年内计数：${result.picked.summary}`);
    assert.match(result.picked.note, /已选 2 个季度/, `顶部计数：${result.picked.note}`);
    assert.ok(result.picked.noteActive, '有筛选时顶部计数要高亮');
    assert.ok(result.picked.yearDot, '选过季度的年份标签要有小圆点');
    assert.ok(result.picked.clearButton, '有筛选时才出现「清除全部」');

    assert.equal(result.fullYear.size, 4, '选全年应补满四个季度');
    assert.ok(result.fullYear.allPicked, '选全年后四个季度都应按下');
    assert.equal(result.fullYear.label, '取消全年', `按钮文案：${result.fullYear.label}`);
    assert.equal(result.yearOff.size, 0, '再点一次应取消整年');

    assert.equal(result.cleared.size, 0, '清除全部应清空筛选集合');
    assert.match(result.cleared.note, /可多选/, `清空后回到提示文案：${result.cleared.note}`);
    assert.ok(result.cleared.clearGone, '清空后「清除全部」应消失');

    assert.equal(result.autoExpand.tabs, 24, '当前年份在折叠区间时必须自动展开');
    assert.equal(result.autoExpand.active, '2008', `自动展开后应高亮 2008，实际 ${result.autoExpand.active}`);

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

    // 窄屏：320px 下弹窗仍不横向溢出，底部按钮仍可见
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
        yearColumns: getComputedStyle(document.querySelector('.season-year-tabs')).gridTemplateColumns.split(' ').length,
      };
    });
    assert.ok(narrow.modalW <= 320, `320px 视口下弹窗宽度 ${narrow.modalW} 超出屏幕`);
    assert.equal(narrow.overflowX, 0, `320px 下弹窗内横向溢出 ${narrow.overflowX}px`);
    assert.equal(narrow.sortColumns, 1, '360px 以下排序改成单列');
    assert.equal(narrow.yearColumns, 3, '420px 以下年份改成三列');

    console.log('verify_collection_filter_panel: ok');
  } finally {
    await browser.close();
  }
})();
