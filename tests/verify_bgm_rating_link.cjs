// 回归：设置开关 bgm_rating_link —— 详情页评分行整行跳 Bangumi。
// 锁住：URL 与上方 Bangumi 外链同源（同一模板 + 同一 bgm_site_base）、
// 开关关掉/无评分时不留 href、target/rel 与外链一致、前后端接线齐全。
const fs = require('fs');
const assert = require('node:assert/strict');
const { chromium } = require('C:/Users/han/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

const harness = `
const $=(s,r=document)=>r.querySelector(s);
const $$=(s,r=document)=>[...r.querySelectorAll(s)];
const escapeHtml=v=>String(v??'');
const state={ settings:{}, animes:[], progressAnime:null };
function toast(){}
function api(){return Promise.resolve({});}
function enabledSetting(key, fallback=false){ const v=state.settings?.[key]; return typeof v==='boolean' ? v : fallback; }
`;

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const html = fs.readFileSync('static/index.html', 'utf8')
      .replace(/<script[\s\S]*?<\/script>/g, '')
      .replace(/<link[^>]*>/g, '');
    await page.setContent(`<style>${fs.readFileSync('static/styles.css', 'utf8')}</style>${html}`);
    await page.addScriptTag({ content: harness
      + fs.readFileSync('static/modules/video-links.js', 'utf8')
      + fs.readFileSync('static/modules/details.js', 'utf8') });

    const result = await page.evaluate(() => {
      const anime = { id: 535669, name_cn: '冰之城墙', display_name: '冰之城墙', bgm_score: 7.3 };
      const rating = $('#animeRating');
      const snap = () => ({
        href: rating.getAttribute('href'), target: rating.getAttribute('target'),
        rel: rating.getAttribute('rel'), title: rating.getAttribute('title'),
      });

      state.settings = {};
      const defaultHref = bgmRatingHref(anime);
      applyBgmRatingLink(rating, anime, true);
      const on = snap();

      // 与上方 Bangumi 外链逐字一致
      const values = { id: anime.id, title: anime.name_cn,
        site: String(state.settings.bgm_site_base || 'https://bgm.tv') };
      const bgmPreset = detailLinks().find((link) => link && link.enabled && link.kind === 'bgm');
      const presetHref = detailLinkHref(bgmPreset.url, values);

      // 自定义镜像域名要跟着变
      state.settings = { bgm_site_base: 'https://bgm.example/' };
      const customSite = bgmRatingHref(anime);

      // 自定义 Bangumi 链接模板也要跟着变
      state.settings = { detail_links: [
        { id: 'x', kind: 'bgm', name: 'Bangumi', url: '{site}/subject/{id}?from=handbook', enabled: true },
      ] };
      const customTemplate = bgmRatingHref(anime);

      // 开关关掉
      state.settings = { bgm_rating_link: false };
      applyBgmRatingLink(rating, anime, true);
      const off = snap();

      // 开关开但没有评分数据
      state.settings = {};
      const empty = { ...anime, bgm_score: 0 };
      applyBgmRatingLink(rating, empty, false);
      const noRating = snap();

      return { defaultHref, presetHref, customSite, customTemplate, on, off, noRating,
        tag: rating.tagName };
    });

    assert.equal(result.tag, 'A', '评分行必须是真 <a>，中键/右键才有原生行为');
    assert.equal(result.defaultHref, 'https://bgm.tv/subject/535669', `默认链接：${result.defaultHref}`);
    assert.equal(result.defaultHref, result.presetHref, '评分行链接要和上方 Bangumi 外链逐字一致');
    assert.equal(result.customSite, 'https://bgm.example/subject/535669', `镜像域名：${result.customSite}`);
    assert.equal(result.customTemplate, 'https://bgm.tv/subject/535669?from=handbook', `自定义模板：${result.customTemplate}`);
    assert.equal(result.on.href, result.defaultHref, '开启时要挂 href');
    assert.equal(result.on.target, '_blank', '与外链一样在新标签打开');
    assert.equal(result.on.rel, 'noreferrer', '与外链一样的 rel');
    assert.match(result.on.title, /Bangumi/, '要有说明');
    assert.equal(result.off.href, null, '关掉开关不能留 href');
    assert.equal(result.off.target, null, '关掉开关不能留 target/rel/title');
    assert.equal(result.off.rel, null, '关掉开关不能留 rel');
    assert.equal(result.noRating.href, null, '没有评分数据时不能挂链接');

    // 前后端接线：漏一处设置就存不下来或渲染不出来
    const idx = fs.readFileSync('static/index.html', 'utf8');
    assert.match(idx, /id="bgmRatingLinkInput"/, '设置页要有开关');
    assert.match(idx, /<a class="anime-rating hidden" id="animeRating"><\/a>/, '评分行要改成 a 标签');
    assert.match(fs.readFileSync('static/modules/settings.js', 'utf8'), /bgmRatingLinkInput/);
    assert.match(fs.readFileSync('static/modules/settings-save.js', 'utf8'), /bgm_rating_link/);
    assert.match(fs.readFileSync('handbook/database.py', 'utf8'), /"bgm_rating_link": True/);
    const svc = fs.readFileSync('handbook/settings_service.py', 'utf8');
    assert.match(svc, /"bgm_rating_link",/, '后端白名单要允许保存');
    assert.match(svc, /key == "bgm_rating_link"/, '后端要做布尔归一化');

    console.log('verify_bgm_rating_link: ok');
  } finally {
    await browser.close();
  }
})();
