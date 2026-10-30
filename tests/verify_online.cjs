const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('server/static/online.js', 'utf8');

function harness(guest = false) {
  const calls = [];
  let revision = 0, dialogs = false, active = 'BODY', changed = false, applied = 0;
  const state = {rankingDirtyBoards: new Set(), activeView: 'collection'};
  const context = {
    window: {}, state, location: {replace() {}},
    document: {hidden: false, querySelector: () => dialogs ? {} : null, get activeElement() {return {tagName: active};}},
    fetch: async (path, options = {}) => {
      calls.push({path, options});
      let status = 200, data;
      if (path === '/api/auth/me') data = {csrf: 'test-csrf', username: 'tester', read_only: guest};
      else if (path === '/api/changes') data = {revision};
      else if (path === '/api/bootstrap') data = {revision, animes: []};
      else if (options.method) {
        if (String(options.headers['If-Match']) !== String(revision)) {status = 409; data = {message:'stale'};}
        else {revision++; data = {ok:true};}
      }
      if (path === '/api/bootstrap' && changed) {state.rankingDirtyBoards.add(1); changed = false;}
      return {ok: status < 400, status, headers: {get: () => String(revision)}, json: async () => data};
    },
    renderCollection: () => applied++, applyTheme() {}, applySidebarLayout() {}, renderStats() {}, renderSync() {}, renderTabs() {}, renderSeasonFilter() {}, populateAnimeSelect() {},
    setInterval() {}, clearInterval() {}, console,
  };
  vm.createContext(context); vm.runInContext(source, context);
  return {api: context.window.handbookOnline, calls, state, setRevision: n => revision=n, setDialog: v => dialogs=v, setActive: v => active=v, race: () => changed=true, applied: () => applied};
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
  h.setDialog(true);
  const count = h.calls.length; await h.api.poll(); assert.equal(h.calls.length, count);
  h.setDialog(false); h.setActive('TEXTAREA'); await h.api.poll(); assert.equal(h.calls.length, count);
  h.setActive('BODY'); await h.api.poll(); assert.equal(h.applied(), 1);
  await h.api.request('/api/notes', {method:'POST',body:'{}'});
  h.setRevision(5); h.race(); await h.api.poll(); assert.equal(h.applied(), 1);
  h.state.rankingDirtyBoards.clear(); await h.api.poll(); assert.equal(h.applied(), 2);
  h.state.progressAnime = {watched_episode_keys: ['ep-1']};
  await h.api.request('/api/animes/1/progress', {method:'POST', body:JSON.stringify({episode_keys:['ep-1','ep-2']})});
  const delta = JSON.parse(h.calls.at(-1).options.body);
  assert.deepEqual(delta.base_episode_keys, ['ep-1']);
  assert.deepEqual(delta.episode_keys, ['ep-1','ep-2']);
  assert.ok(Number.isFinite(Date.parse(delta.watched_at)));
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
