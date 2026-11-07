// 回归：详情弹窗头部的「更新徽标」四态。
// 数据只用本地已有的东西算（air_time.time / airing.next_at / episodes[].airdate / air_date），
// 锁住这些口径：
//   1. 逐集日期取星期众数，个别延播集不能把结果带偏；
//   2. "2027-04" 这种只有年月的占位不能当日期；
//   3. 下集时刻按北京时间判星期（凌晨档在 UTC 会落回前一天）；
//   4. 连载中：「每周X HH:MM 更新 · 已播 N/总」；周表没钟点就省略钟点，绝不编造；
//   5. 已完结：只写「已完结 · 全 N 集」，**不写「已播完」**（2026-11-07 用户定的口径）；
//   6. 未开播：暖色「下周开播 · 每周X」，不显示「已播 0/N」；
//   7. 日期未知：不再是空行或一条孤零零的竖线；
//   8. 外链站点仍独占 .progress-links 一行。
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
      const ongoingEpisodes = weeks('2026-10-04', 12); // 前 5 集已播、后 7 集未播

      const ongoing = animeUpdateWeekday({ air_date: '2026-10-04', episodes: ongoingEpisodes }, today);
      const finished = animeUpdateWeekday({ air_date: '2012-04-22', episodes: weeks('2012-04-22', 21) }, today);
      const skewedEpisodes = weeks('2026-09-06', 10);
      skewedEpisodes[5] = ep(6, '2026-10-14');
      const skewed = animeUpdateWeekday({ air_date: '2026-09-06', episodes: skewedEpisodes }, today);
      const dirty = animeUpdateWeekday({
        air_date: '2026-10-05',
        episodes: [ep(1, '2026-10-05'), ep(2, '2026-10-12'), ep(3, '2027-04'), ep(4, '2026-10-26')],
      }, today);
      // 2026-11-08 00:30 北京时间 = 2026-11-07 16:30 UTC（周六）
      const withNextAt = animeUpdateWeekday({
        air_date: '2026-10-04', episodes: [],
        airing: { next_at: Math.floor(new Date('2026-11-08T00:30:00+08:00').getTime() / 1000), next_episode: 8 },
      }, today);
      const noData = animeUpdateWeekday({ air_date: '', episodes: [] }, today);

      // —— 四态 DOM 渲染 ——
      const render = (anime, date = '2026-10-04') => {
        $('#progressAirDate').textContent = date;
        renderProgressBadge(anime);
        const badge = $('#progressBadge');
        return {
          text: $('#progressBadgeText').textContent,
          kind: [...badge.classList].find((c) => c !== 'update-badge' && c !== 'hidden'),
          hidden: badge.classList.contains('hidden'),
          bg: getComputedStyle(badge).backgroundColor,
          title: badge.title,
        };
      };

      const ongoingDom = render({
        air_date: '2026-10-04', episodes: ongoingEpisodes,
        air_time: { time: '20:00' },
      });
      const noClockDom = render({ air_date: '2026-10-04', episodes: ongoingEpisodes });
      const nextAtDom = render({
        air_date: '2026-10-04', episodes: ongoingEpisodes,
        airing: { next_at: Math.floor(new Date('2026-11-08T20:00:00+08:00').getTime() / 1000), aired: 5, total: 12 },
      });
      const finishedDom = render({
        air_date: '2012-04-22', episodes: weeks('2012-04-22', 12), episode_count: 12,
      }, '2012-04-22');
      const upcomingDom = render({ air_date: '2026-11-12', episodes: [] }, '2026-11-12');
      const farUpcomingDom = render({ air_date: '2027-01-08', episodes: [] }, '2027-01-08');
      const emptyDom = render({ air_date: '', episodes: [] }, '');
      const danglingDom = render({ air_date: '', episodes: ongoingEpisodes }, '');

      const meta = $('.progress-meta');
      const links = $('.progress-links');
      // 外链挪出 .progress-meta 之后吃不到 .progress-meta a 的兜底样式，
      // 曾退回浏览器默认的「细体 + 下划线」。这里把样式锁住。
      const linkBox = $('#detailLinks');
      linkBox.innerHTML = '<a class="detail-link" href="#">Bangumi ↗</a>';
      const linkStyle = getComputedStyle(linkBox.querySelector('.detail-link'));
      const boxStyle = getComputedStyle(linkBox);
      return {
        ongoing, finished, skewed, dirty, withNextAt, noData,
        ongoingDom, noClockDom, nextAtDom, finishedDom, upcomingDom, farUpcomingDom, emptyDom, danglingDom,
        structure: {
          linksInMeta: Boolean(meta && meta.querySelector('#detailLinks')),
          linksInsideOwnRow: Boolean(links && links.querySelector('#detailLinks')),
          badgeInMeta: Boolean(meta && meta.querySelector('#progressBadge')),
          hasSeparator: Boolean(document.querySelector('.meta-separator')),
          hasDot: Boolean(document.querySelector('#progressBadge .update-badge-dot')),
          linkDeco: linkStyle.textDecorationLine,
          linkWeight: linkStyle.fontWeight,
          linkSize: linkStyle.fontSize,
          linkWrap: boxStyle.flexWrap,
        },
      };
    });

    assert.deepEqual(result.ongoing, { weekday: '周日', ongoing: true }, `连载番：${JSON.stringify(result.ongoing)}`);
    assert.deepEqual(result.finished, { weekday: '周日', ongoing: false }, `完结番：${JSON.stringify(result.finished)}`);
    assert.equal(result.skewed.weekday, '周日', `一集延播不能把众数带偏，实际 ${result.skewed.weekday}`);
    assert.equal(result.dirty.weekday, '周一', `只有年月的占位要跳过，实际 ${result.dirty.weekday}`);
    assert.equal(result.withNextAt.weekday, '周日', `下集时刻要按北京时间判星期，实际 ${result.withNextAt.weekday}`);
    assert.equal(result.withNextAt.ongoing, true, '有下集时刻就是连载中');
    assert.equal(result.noData, null, '一个日期都没有时应返回 null');

    assert.equal(result.ongoingDom.text, '每周日 20:00 更新 · 已播 5/12', `连载徽标：${result.ongoingDom.text}`);
    assert.equal(result.ongoingDom.kind, 'ongoing', '连载态要挂 ongoing 样式');
    assert.ok(!result.ongoingDom.hidden, '徽标不能藏起来');
    assert.match(result.ongoingDom.title, /周表/, '连载态要说明钟点来源');
    assert.equal(result.noClockDom.text, '每周日更新 · 已播 5/12', `没有钟点时：${result.noClockDom.text}`);
    assert.match(result.noClockDom.title, /没有放送钟点/, '没钟点要说明，不编造');
    assert.equal(result.nextAtDom.text, '每周日 20:00 更新 · 已播 5/12', `next_at 兜底钟点：${result.nextAtDom.text}`);

    assert.equal(result.finishedDom.text, '已完结 · 全 12 集', `完结徽标：${result.finishedDom.text}`);
    assert.equal(result.finishedDom.kind, 'finished', '完结态要挂 finished 样式');
    assert.ok(!result.finishedDom.text.includes('已播完'), '按口径只写「已完结」，不写「已播完」');
    assert.ok(!result.finishedDom.text.includes('更新'), '完结番不能谎报更新');

    assert.equal(result.upcomingDom.text, '下周开播 · 每周四', `未开播徽标：${result.upcomingDom.text}`);
    assert.equal(result.upcomingDom.kind, 'upcoming', '未开播要挂暖色样式');
    assert.ok(!result.upcomingDom.text.includes('已播 0'), '未开播不显示「已播 0/N」');
    assert.match(result.farUpcomingDom.text, /^\d+月\d+日开播 · 每周/, `较远的首播应给具体日期：${result.farUpcomingDom.text}`);

    assert.equal(result.emptyDom.text, '日期未知', `无日期徽标：${result.emptyDom.text}`);
    assert.equal(result.emptyDom.kind, 'unknown', '无日期要挂 unknown 样式');
    assert.equal(result.danglingDom.text, '每周日更新 · 已播 5/12', '没有首播日但集日期齐全时仍正常显示');
    assert.notEqual(result.ongoingDom.bg, result.finishedDom.bg, '连载与完结的底色要不同');
    assert.notEqual(result.ongoingDom.bg, result.upcomingDom.bg, '连载与未开播的底色要不同');

    assert.ok(!result.structure.linksInMeta, '外链站点不能再放在 .progress-meta 里');
    assert.ok(result.structure.linksInsideOwnRow, '外链站点要独占 .progress-links 一行');
    assert.ok(result.structure.badgeInMeta, '徽标跟着日期走，留在 .progress-meta 里');
    assert.ok(!result.structure.hasSeparator, '「·」分隔符已由徽标取代');
    assert.ok(result.structure.hasDot, '徽标要有状态色小圆点');
    assert.equal(result.structure.linkDeco, 'none', '详情外链不能退回浏览器默认下划线');
    assert.equal(result.structure.linkWeight, '700', '详情外链要保持粗体');
    assert.equal(result.structure.linkSize, '12px', '详情外链字号要跟头部一致');
    assert.equal(result.structure.linkWrap, 'wrap', '详情外链要能换行，窄屏才不顶出弹窗');

    console.log('verify_detail_weekday: ok');
  } finally {
    await browser.close();
  }
})();
