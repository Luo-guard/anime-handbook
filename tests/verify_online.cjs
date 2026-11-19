const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('server/static/online.js', 'utf8');

function harness(guest = false) {
  const calls = [];
  let revision = 0, dialog = '', active = 'BODY', onBootstrap, applied = 0, labelRefreshes = 0;
  const state = {animes: [], settings: {}, category: 1, rankingDirtyBoards: new Set(), activeView: 'collection'};
  const context = {
    window: {}, state, offlineView: {returnDialogs: []}, location: {replace() {}},
    document: {hidden: false, querySelector: selector => selector.includes('dialog[open]') && dialog && !(dialog === 'offlinePlayer' && selector.includes(':not(#offlinePlayer)')) ? {} : null, get activeElement() {return {tagName: active};}},
    fetch: async (path, options = {}) => {
      calls.push({path, options});
      let status = 200, data;
      if (path === '/api/auth/me') data = {csrf: 'test-csrf', username: 'tester', read_only: guest};
      else if (path === '/api/changes') data = {revision};
      else if (path === '/api/bootstrap') data = {revision, settings: {collection_sort_modes: {'1':'rank'}}, animes: [{id:1,bgm_rank:2},{id:2,bgm_rank:1}]};
      else if (options.method) {
        if (String(options.headers['If-Match']) !== String(revision)) {status = 409; data = {message:'stale'};}
        else {revision++; data = {ok:true};}
      }
      if (path === '/api/bootstrap' && onBootstrap) {
        const callback = onBootstrap; onBootstrap = null; callback();
      }
      return {ok: status < 400, status, headers: {get: () => String(revision)}, json: async () => data};
    },
    renderCollection: () => applied++, applyTheme() {}, applySidebarLayout() {}, populateAnimeSelect() {},
    pcSyncEpisodeLabels: () => labelRefreshes++,
    setInterval() {}, clearInterval() {}, setTimeout, clearTimeout, AbortController, console,
  };
  vm.createContext(context);
  for (const file of ['network', 'collection']) vm.runInContext(fs.readFileSync(`static/modules/${file}.js`, 'utf8'), context);
  for (const name of ['renderStats', 'renderSync', 'renderTabs', 'renderSeasonFilter']) context[name] = () => {};
  vm.runInContext(source, context);
  return {api: context.window.handbookOnline, calls, state, setRevision: n => revision=n,
    setDialog: v => dialog=v, setActive: v => active=v, duringBootstrap: callback => onBootstrap=callback,
    suspendDialog: () => context.offlineView.returnDialogs.push('progressModal'),
    applied: () => applied, labelRefreshes: () => labelRefreshes};
}

(async () => {
  const h = harness();
  await h.api.request('/api/bootstrap');
  const originalFile = {size: 1234, type: 'image/png'};
  await h.api.uploadImage('/api/record-images', originalFile);
  assert.equal(h.calls.at(-1).options.body, originalFile);
  assert.equal(h.calls.at(-1).options.headers['Content-Type'], 'image/png');
  // Start the existing revision assertions with a fresh account revision.
  h.setRevision(0);
  await h.api.request('/api/bootstrap');
  h.calls.splice(0);
  await Promise.all([
    h.api.request('/api/notes', {method:'POST',body:'{}'}),
    h.api.request('/api/notes', {method:'POST',body:'{}'}),
  ]);
  const writes = h.calls.filter(c => c.options.method);
  assert.equal(writes[0].options.headers['X-CSRF-Token'], 'test-csrf');
  assert.equal(writes[0].options.headers['If-Match'], '0');
  assert.equal(writes[1].options.headers['If-Match'], '1');
  h.setRevision(3);
  await assert.rejects(h.api.request('/api/notes', {method:'POST',body:'{}'}), /stale/);
  await assert.rejects(h.api.request('/api/notes', {method:'POST',body:'{}'}), /stale/);
  h.setDialog('progressModal');
  const count = h.calls.length; await h.api.poll(); assert.equal(h.calls.length, count);
  h.setDialog(''); h.setActive('TEXTAREA'); await h.api.poll(); assert.equal(h.calls.length, count);
  h.setActive('BODY'); await h.api.poll(); assert.equal(h.applied(), 1);
  assert.deepEqual(Array.from(h.state.animes, anime => anime.id), [2,1]);
  assert.equal(h.labelRefreshes(), 1);
  await h.api.request('/api/notes', {method:'POST',body:'{}'});
  h.setRevision(5); h.duringBootstrap(() => h.state.rankingDirtyBoards.add(1)); await h.api.poll(); assert.equal(h.applied(), 1);
  h.state.rankingDirtyBoards.clear(); await h.api.poll(); assert.equal(h.applied(), 2);
  h.state.progressAnime = {watched_episode_keys: ['ep-1']};
  await h.api.request('/api/animes/1/progress', {method:'POST', body:JSON.stringify({episode_keys:['ep-1','ep-2']})});
  const delta = JSON.parse(h.calls.at(-1).options.body);
  assert.deepEqual(delta.base_episode_keys, ['ep-1']);
  assert.deepEqual(delta.episode_keys, ['ep-1','ep-2']);
  assert.ok(Number.isFinite(Date.parse(delta.watched_at)));
  h.setRevision(7);
  h.duringBootstrap(() => h.setDialog('offlinePlayer'));
  const beforePlayback = h.calls.length;
  await h.api.poll();
  assert.deepEqual(h.calls.slice(beforePlayback).map(call => call.path), ['/api/changes','/api/bootstrap']);
  assert.equal(h.labelRefreshes(), 3);
  h.setRevision(8);
  await h.api.poll();
  assert.equal(h.calls.length, beforePlayback + 2, 'an open player does not start extra polls');
  h.setDialog('');
  h.duringBootstrap(() => { h.setDialog('offlinePlayer'); h.suspendDialog(); });
  await h.api.poll();
  assert.equal(h.labelRefreshes(), 3, 'a suspended detail dialog still protects its draft');
  assert.match(source, /#noteComposer:not\(\.hidden\)/);
  assert.match(source, /inline-event-editor/);
  const guest = harness(true);
  await guest.api.request('/api/bootstrap');
  const before = guest.calls.length;
  const temporary = await guest.api.request('/api/settings', {method:'PATCH', body:JSON.stringify({schedule_sort:'score'})});
  assert.equal(temporary.settings.schedule_sort, 'score');
  assert.equal(guest.calls.length, before, 'guest view filters must stay within the tab');
  for (const path of ['/api/notes','/api/subjects','/api/background']) await assert.rejects(guest.api.request(path, {method:'POST',body:'{}'}), /游客体验为只读/);
  await assert.rejects(guest.api.request('/api/settings', {method:'PATCH',body:JSON.stringify({theme_color:'red'})}), /游客体验为只读/);
  assert.equal(guest.calls.length, before, 'guest writes must never be sent');
  await guest.api.request('/api/auth/logout', {method:'POST',body:'{}'});
  console.log('Online client: serialized writes, CSRF/version headers, conflict safety, edit guards, automatic updates and polling race passed.');
})().catch(error => {console.error(error); process.exitCode=1;});
