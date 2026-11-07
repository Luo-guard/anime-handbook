// 回归：详情弹窗头部的「周几更新」。
// 数据只用本地已有的东西算（后端 airing.next_at / episodes[].airdate / air_date），
// 这里锁住几条容易改坏的口径：
//   1. 取逐集日期的星期众数，个别延播集不能把结果带偏；
//   2. "2027-04" 这种只有年月的占位不能被当成日期；
//   3. 还有没播的集才说「更新」，已完结的只给星期；
//   4. 后端给了下集时刻（airing.next_at）时优先用它，且按北京时间判星期——
//      番剧凌晨档（JST 25:30）在 UTC 会落回前一天；
//   5. 一个日期都没有时整行（含 ·）收起来，不留一条孤零零的竖线；
//   6. 外链站点改成独立一行，不再和日期挤在同一个 .progress-meta 里。
const fs = require('fs');
const assert = require('node:assert/strict');
const { chromium } = require('C:/Users/han/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

const harness = `
const $=(s,r=document)=>r.querySelector(s);
const $$=(s,r=document)=>[...r.querySelectorAll(s)];
const escapeHtml=v=>String(v??'');
const state={ animes:[], settings:{}, progressAnime:null };
function toast(){}
function api(){return Promise.resolve({});}
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
      content: harness + fs.readFileSync('static/modules/details.js', 'utf8'),
    });

    const result = await page.evaluate(() => {
      const ep = (sort, airdate) => ({ sort, airdate, type: 0 });
      const today = new Date(2026, 10, 7);
      const weeks = (startIso, count, offsetDays = 0) => {
        const start = new Date(startIso);
        return Array.from({ length: count }, (_, i) => {
          const day = new Date(start);
          day.setDate(start.getDate() + i * 7 + offsetDays);
          const iso = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
          return ep(i + 1, iso);
        });
      };

      const ongoing = animeUpdateWeekday({
        air_date: '2026-10-04',
        episodes: weeks('2026-10-04', 12),
      }, today);

      const finished = animeUpdateWeekday({
        air_date: '2012-04-22',
        episodes: weeks('2012-04-22', 21),
      }, today);

      // 10 集周日里混进一集周三（第 6 集延播一周多一点）
      const skewedEpisodes = weeks('2026-09-06', 10);
      skewedEpisodes[5] = ep(6, '2026-10-14');
      const skewed = animeUpdateWeekday({ air_date: '2026-09-06', episodes: skewedEpisodes }, today);

      // 脏数据：只有年月的占位 + 不补零的日期
      const dirty = animeUpdateWeekday({
        air_date: '2026-10-05',
        episodes: [ep(1, '2026-10-05'), ep(2, '2026-10-12'), ep(3, '2027-04'), ep(4, '2026-10-26')],
      }, today);

      // 后端给的下集时刻：2026-11-08 00:30 北京时间 = 2026-11-07 16:30 UTC（周六）
      const withNextAt = animeUpdateWeekday({
        air_date: '2026-10-04',
        episodes: [],
        airing: { next_at: Math.floor(new Date('2026-11-08T00:30:00+08:00').getTime() / 1000), next_episode: 8 },
      }, today);

      const noData = animeUpdateWeekday({ air_date: '', episodes: [] }, today);

      // —— DOM 渲染 ——
      const render = (anime) => {
        renderProgressWeekday(anime);
        return {
          weekday: $('#progressWeekday').textContent,
          weekdayShown: !$('#progressWeekday').classList.contains('hidden'),
          sepShown: !$('#progressMetaSeparator').classList.contains('hidden'),
        };
      };
      $('#progressAirDate').textContent = '2026-10-04';
      const ongoingDom = render({ air_date: '2026-10-04', episodes: weeks('2026-10-04', 12) });
      const finishedDom = render({ air_date: '2012-04-22', episodes: weeks('2012-04-22', 21) });
      $('#progressAirDate').textContent = '';
      const emptyDom = render({ air_date: '', episodes: [] });
      // 有集日期但没有首播日的番：周几留着，分隔符要藏
      const danglingDom = render({ air_date: '', episodes: weeks('2026-10-04', 10) });

      const meta = $('.progress-meta');
      const links = $('.progress-links');
      return {
        ongoing, finished, skewed, dirty, withNextAt, noData,
        ongoingDom, finishedDom, emptyDom, danglingDom,
        structure: {
          linksInMeta: Boolean(meta && meta.querySelector('#detailLinks')),
          linksInsideOwnRow: Boolean(links && links.querySelector('#detailLinks')),
          weekdayInMeta: Boolean(meta && meta.querySelector('#progressWeekday')),
        },
      };
    });

    assert.deepEqual(result.ongoing, { weekday: '周日', ongoing: true }, `连载番：${JSON.stringify(result.ongoing)}`);
    assert.deepEqual(result.finished, { weekday: '周日', ongoing: false }, `完结番：${JSON.stringify(result.finished)}`);
    assert.equal(result.skewed.weekday, '周日', `一集延播不能把众数带偏，实际 ${result.skewed.weekday}`);
    assert.equal(result.dirty.weekday, '周一', `只有年月的占位要跳过，不补零的日期要接受，实际 ${result.dirty.weekday}`);
    assert.equal(result.withNextAt.weekday, '周日', `下集时刻要按北京时间判星期（UTC 下是周六），实际 ${result.withNextAt.weekday}`);
    assert.equal(result.withNextAt.ongoing, true, '有下集时刻就是连载中');
    assert.equal(result.noData, null, '一个日期都没有时应返回 null');

    assert.equal(result.ongoingDom.weekday, '每周日更新', `连载番文案：${result.ongoingDom.weekday}`);
    assert.ok(result.ongoingDom.weekdayShown && result.ongoingDom.sepShown, '连载番要有周几和分隔符');
    assert.equal(result.finishedDom.weekday, '每周日', `完结番不该说「更新」，实际 ${result.finishedDom.weekday}`);
    assert.ok(!result.emptyDom.weekdayShown, '没有日期时周几要藏起来');
    assert.ok(!result.emptyDom.sepShown, '没有日期时不能留一条孤零零的 ·');
    assert.equal(result.danglingDom.weekday, '每周日更新', '没有首播日但集日期齐全时仍要显示周几');
    assert.ok(!result.danglingDom.sepShown, '没有首播日时分隔符要藏');

    assert.ok(!result.structure.linksInMeta, '外链站点不能再放在 .progress-meta 里');
    assert.ok(result.structure.linksInsideOwnRow, '外链站点要独占 .progress-links 一行');
    assert.ok(result.structure.weekdayInMeta, '周几跟着日期走，留在 .progress-meta 里');

    console.log('verify_detail_weekday: ok');
  } finally {
    await browser.close();
  }
})();
