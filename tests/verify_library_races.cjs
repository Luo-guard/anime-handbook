const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const nodes = new Map();
const pending = [];
const played = [];
let deletion;
const context = vm.createContext({
  $: (selector) => {
    if (!nodes.has(selector)) nodes.set(selector, {
      classList: { add() {}, remove() {}, toggle() {} },
      addEventListener() {},
      scrollIntoView() {},
    });
    return nodes.get(selector);
  },
  $$: () => [],
  state: { activeView: "library", settings: {} },
  window: { addEventListener() {}, setTimeout() {} },
  document: { addEventListener() {} },
  api: (url) => new Promise((resolve, reject) => pending.push({ url, resolve, reject })),
  offlineView: { localToken: 0 },
  playLocalFile: (id) => played.push([context.offlineView.animeId, id]),
  removeLocalFile: (id, options) => new Promise((resolve) => { deletion = { id, options, resolve }; }),
  episodeLabelOf: (key) => key,
  escapeHtml: (value) => String(value),
});
const source = fs.readFileSync(path.join(__dirname, "../static/modules/library-view.js"), "utf8");
vm.runInContext(source.replace(/\ninitLibraryView\(\);\s*$/, ""), context);
const run = (code) => vm.runInContext(code, context);
run("loadLibrarySidebar = () => {}");

function episode(id) {
  return { files: [{ id, episode_key: "0:1", file_path: "sample.mp4" }], jobs: [] };
}

(async () => {
  const first = run('openLibraryDetail(1, "First")');
  const second = run('openLibraryDetail(2, "Second")');
  pending[1].resolve(episode(20));
  await second;
  pending[0].resolve(episode(10));
  await first;
  assert.equal(nodes.get("#libDetailTitle").textContent, "Second");
  assert.match(nodes.get("#libEpisodes").innerHTML, /data-id="20"/);
  assert.doesNotMatch(nodes.get("#libEpisodes").innerHTML, /data-id="10"/);
  run("libPlay(10); libPlay(20)");
  assert.deepEqual(played, [[2, 20]]);

  const removing = run("libDelete(20)");
  assert.equal(deletion.options.animeId, 2);
  assert.equal(deletion.options.files[0].id, 20);
  const third = run('openLibraryDetail(3, "Third")');
  deletion.resolve();
  await removing;
  assert.equal(pending.length, 3, "deleting from the previous detail must not reopen it");
  assert.equal(nodes.get("#libDetailTitle").textContent, "Third");
  run("librarySidebar.detail = null");
  pending[2].reject(new Error("Old request"));
  await third;
  assert.doesNotMatch(nodes.get("#libDetailMeta").textContent, /Old request/);

  const resumeFirst = run('libPlayFromItem({ anime_id: 1, name: "First" }, 10)');
  const resumeSecond = run('libPlayFromItem({ anime_id: 2, name: "Second" }, 20)');
  pending[4].resolve(episode(20));
  await resumeSecond;
  pending[3].resolve(episode(10));
  await resumeFirst;
  assert.deepEqual(played, [[2, 20], [2, 20]]);
  console.log("Media library: stale detail, deletion refresh and resume responses are ignored.");
})().catch((error) => { console.error(error); process.exitCode = 1; });
