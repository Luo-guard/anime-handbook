const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("C:/Users/han/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright");

async function verify() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const metadata = { id: "example", name: "Example", host: "example.test", version: "1" };
  const episode = { id: "episode-six", url: "https://example.test/episode-six", number: "6" };
  const catalogue = {
    id: "series", rule: "example", ruleName: "Example", title: "Example anime",
    sources: [1, 2].map(id => ({ id, name: `Line ${id}`, episodes: [episode] })),
  };
  const plays = [];
  let installed = false;
  await page.route("http://handbook.test/**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    const json = data => route.fulfill({ json: data });
    switch (url.pathname) {
      case "/api/bootstrap":
        return json({ settings: {}, stats: {}, sync: {}, animes: [], custom_collections: [] });
      case "/api/playback/rules":
        if (request.method() === "POST") installed = request.postDataJSON().action === "install";
        return json({ items: installed || url.searchParams.has("remote") ? [{ ...metadata, installed }] : [] });
      case "/api/playback/search":
        assert.equal(installed, true, "an uninstalled rule never searches");
        return json({ items: [{ id: "series", title: "Example anime" }] });
      case "/api/playback/catalogue":
        return json(catalogue);
      case "/api/playback/play":
        plays.push(Object.fromEntries(url.searchParams));
        return route.fulfill({ status: 502, json: { message: "Fixture stream unavailable" } });
      default:
        if (url.pathname.startsWith("/api/")) return json({ items: [], animes: [] });
        const file = path.join("static", url.pathname === "/" ? "index.html" : url.pathname);
        return fs.existsSync(file) && fs.statSync(file).isFile() ? route.fulfill({ path: file }) : route.fulfill({ status: 404 });
    }
  });
  try {
    await page.goto("http://handbook.test/");
    const open = () => page.evaluate(() => {
      const name = "Example anime";
      const anime = { id: 321, name, display_name: name, episode_count: 12 };
      state.progressAnime = anime;
      if (!$("#progressModal").open) $("#progressModal").showModal();
      window.onlinePlayback.openAnime(anime, "0:6");
    });
    await open();
    await page.getByRole("button", { name: "下载", exact: true }).waitFor();
    assert.equal(await page.locator("#onlinePlaybackRule option").first().textContent(), "尚未下载规则");
    await page.getByRole("button", { name: "下载", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("#onlinePlaybackRule").value === "example");
    await page.click("#onlinePlaybackSearch");
    await page.waitForFunction(() => document.querySelector("#offlinePlayerMeta").textContent === "Fixture stream unavailable");
    assert.deepEqual(plays, [1, 2].map(source => ({
      rule: "example", anime: "series", source: String(source), episode: episode.id,
    })));
    assert.equal(await page.locator("#onlinePlayerSource").inputValue(), "2");
    await page.click("#onlinePlayerRule");
    await page.locator("#onlinePlaybackPicker[open]").waitFor();
    assert.match(await page.locator("#onlinePlaybackPickerTitle").textContent(), /第 6 集/);
    await page.locator("#onlineRuleManager summary").click();
    await page.getByRole("button", { name: "移除", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("#onlinePlaybackRule").value === "");
    assert.equal(await page.locator("#onlinePlaybackSearch").isDisabled(), true);
    console.log("Online rules: explicit download, line fallback, rule switching and removal.");
  } finally {
    await browser.close();
  }
}

verify().catch(error => { console.error(error); process.exitCode = 1; });
