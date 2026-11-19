const assert = require('node:assert/strict');
const fs = require('node:fs');
const {chromium} = require('C:/Users/han/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

async function checkDesktopSync(browser) {
  const page = await browser.newPage({viewport:{width:360,height:640}});
  const html = fs.readFileSync('static/index.html', 'utf8');
  const dialogMarkup = html.match(/<dialog[^>]+id="webdavConflictModal"[\s\S]*?<\/dialog>/)[0];
  await page.setContent('<button id="syncWebdavButton">同步</button>' + dialogMarkup);
  await page.addStyleTag({content:fs.readFileSync('static/styles.css', 'utf8')});
  const events = fs.readFileSync('static/modules/events.js', 'utf8');
  const syncCode = events.slice(events.indexOf('async function syncWebdav('), events.indexOf('$("#copyWebdavAccountIdButton")'));
  await page.addScriptTag({content:fs.readFileSync('static/modules/collection.js', 'utf8')});
  await page.addScriptTag({content:`
    const $ = selector => document.querySelector(selector);
    const state = {};
    const requests = [];
    const noop = () => {};
    Object.assign(window, {renderStats:noop, renderTabs:noop, renderSyncButton:noop});
    const saveWebdavSettings = noop, applyTheme = noop,
      renderCollection = noop, renderSettingsPanels = noop,
      renderWebdavSettings = noop, switchView = noop, toast = noop;
    async function api(path, options) {
      const body = JSON.parse(options.body);
      requests.push(body);
      return body.resolution ? {ok:true} : {conflict:true, conflict_token:'desktop-version-test'};
    }
    ${syncCode}
  `});
  const dialog = page.getByRole('dialog', {name:'选择同步版本'});
  const syncButton = page.getByRole('button', {name:'同步', exact:true});
  for (const choice of ['cancel', 'escape', 'local', 'remote']) {
    await syncButton.click();
    await dialog.waitFor();
    assert.equal(await dialog.locator('[autofocus]').evaluate(button => button === document.activeElement), true);
    if (choice === 'escape') await page.keyboard.press('Escape');
    else await dialog.locator(`button[value="${choice}"]`).click();
    await dialog.waitFor({state:'hidden'});
    await page.waitForFunction(() => !document.querySelector('#syncWebdavButton').disabled);
  }
  assert.deepEqual(await page.evaluate(() => requests), [
    {}, {}, {}, {resolution:'local', conflict_token:'desktop-version-test'},
    {}, {resolution:'remote', conflict_token:'desktop-version-test'},
  ]);
  await page.close();
}

async function checkMobile(browser) {
  const page = await browser.newPage({viewport:{width:320,height:460}, isMobile:true, hasTouch:true});
  const base = 'android/app/src/main/assets';
  await page.setContent(fs.readFileSync(`${base}/index.html`, 'utf8').replace(/<script[^>]*><\/script>/g, ''));
  await page.addStyleTag({content:fs.readFileSync(`${base}/style.css`, 'utf8')});
  await page.evaluate(() => {
    window.syncCalls = [];
    window.AndroidHandbook = {state:() => '{}', sync:value => syncCalls.push(value)};
  });
  await page.addScriptTag({content:fs.readFileSync(`${base}/app.js`, 'utf8')});
  const show = silent => page.evaluate(silent => HandbookMobile.completeSync('{"conflict":true,"conflict_token":"version-test"}', silent), silent);
  const dialog = page.getByRole('dialog', {name:'选择同步版本'});
  await show(true);
  assert.equal(await dialog.isVisible(), false);
  await show(false);
  assert.equal(await dialog.isVisible(), true);
  await dialog.getByRole('button', {name:'暂不同步'}).click();
  await show(false);
  assert.equal(await page.evaluate(() => HandbookMobile.handleBack()), true);
  await show(false);
  await page.keyboard.press('Escape');
  assert.equal(await dialog.isVisible(), false);
  assert.deepEqual(await page.evaluate(() => syncCalls), []);
  for (const name of [/保留手机版本.*覆盖云端/, /使用云端版本.*替换本机/]) {
    await show(false);
    await dialog.getByRole('button', {name}).click();
    assert.equal(await dialog.isVisible(), false);
  }
  assert.deepEqual(await page.evaluate(() => syncCalls), ['local:version-test','remote:version-test']);
  await page.close();
}

async function checkRanking(browser) {
  const page = await browser.newPage();
  await page.setContent('<style>.hidden{display:none}</style><div id="rankingBoardList"></div><main id="rankingWorkspace"></main>');
  await page.addScriptTag({content:`
    const $ = (s, root = document) => root.querySelector(s);
    const $$ = (s, root = document) => [...root.querySelectorAll(s)];
    const escapeHtml = value => String(value);
    const CATEGORIES = [], SEASONS = [];
    const availableSeasonYears = () => [];
    const showRankingHoverTitles = () => false;
    const rankingHoverDelay = () => 0;
    const toast = () => {};
    const item = id => ({anime_id:id,name:String(id),tier_id:null});
    const board = {id:1,name:'第一榜',tiers:[{id:7,name:'A'}],items:[item(1),item(2)]};
    const other = {id:2,name:'第二榜',tiers:[{id:7,name:'B'}],items:[item(1)]};
    const state = {rankingBoard:structuredClone(board),ranking_boards:[board,other],rankingDirtyBoards:new Map(),animes:[{id:3}]};
    let rejectedSave = false, sentPlacements;
    async function api(path, options) {
      if (path.endsWith('/tiers')) board.tiers.push({id:8,name:'新等级'});
      if (path.endsWith('/import')) board.items.push(item(3));
      if (path.endsWith('/move')) {
        if (rejectedSave) throw new Error('模拟保存失败');
        sentPlacements = JSON.parse(options.body).placements;
        const items = new Map(board.items.map(row => [row.anime_id,row]));
        board.items = Object.entries(sentPlacements).flatMap(([tier, ids]) => ids.map(id =>
          ({...items.get(id),tier_id:tier === 'unranked' ? null : Number(tier)})));
      }
      return {board:structuredClone(path.endsWith('/2') ? other : board),boards:[board,other]};
    }
    ${fs.readFileSync('static/modules/ranking.js', 'utf8')}
    renderRanking();
  `});
  const order = tier => page.locator(`[data-tier-id="${tier}"] [data-ranking-anime]`).evaluateAll(nodes => nodes.map(n => Number(n.dataset.rankingAnime)));
  async function move(id, tier) {
    const card = page.locator(`[data-ranking-anime="${id}"]`);
    await card.dispatchEvent('dragstart');
    await page.locator(`[data-tier-id="${tier}"]`).dispatchEvent('drop');
    await card.dispatchEvent('dragend');
  }
  await move(2, 7);
  await move(1, 7);
  await page.locator('#addRankingTier').click();
  await page.locator('[data-tier-id="8"]').waitFor();
  assert.deepEqual(await order(7), [2,1]);
  await page.locator('#rankingImportButton').click();
  await page.locator('[data-tier-id="unranked"] [data-ranking-anime="3"]').waitFor();
  assert.deepEqual(await order(7), [2,1]);
  await page.locator('[data-board-id="2"]').click();
  assert.deepEqual(await order(7), []);
  await page.locator('[data-board-id="1"]').click();
  assert.deepEqual(await order(7), [2,1]);
  await page.evaluate(() => { rejectedSave = true; });
  await page.locator('#saveRankingBoard').click();
  assert.deepEqual(await order(7), [2,1]);
  assert.equal(await page.locator('#saveRankingBoard').isVisible(), true);
  await page.evaluate(() => { rejectedSave = false; });
  await page.locator('#saveRankingBoard').click();
  await page.locator('#saveRankingBoard').waitFor({state:'hidden'});
  assert.deepEqual(await page.evaluate(() => sentPlacements), {7:[2,1],8:[],unranked:[3]});
  assert.equal(await page.locator('#saveRankingBoard').isVisible(), false);
  await page.close();
}

(async () => {
  const browser = await chromium.launch();
  try {
    await checkDesktopSync(browser);
    await checkMobile(browser);
    await checkRanking(browser);
    console.log('Desktop and Android conflict choices and ranking draft preservation passed.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
