const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("C:/Users/han/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright");

async function verify() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  const metadata = { id: "example", name: "Example", host: "example.test", version: "1" };
  const episode = { id: "episode-six", url: "https://example.test/episode-six", number: "6" };
  const catalogue = {
    id: "series", rule: "example", ruleName: "Example", title: "Example anime",
    sources: [1, 2].map(id => ({ id, name: `Line ${id}`, episodes: [episode] })),
  };
  const plays = [];
  let installed = false;
  let version = "1";
  let availableVersion = "1";
  await page.route("http://handbook.test/**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    const json = data => route.fulfill({ json: data });
    switch (url.pathname) {
      case "/api/bootstrap":
        return json({ settings: {}, stats: {}, sync: {}, animes: [], custom_collections: [] });
      case "/api/settings":
        if (request.method() === "PATCH") return json({ settings: request.postDataJSON() });
        return json({ settings: {}, sync: {} });
      case "/api/health":
        return json({ features: { keyboard_shortcuts: true, schedule_sorting: 2 } });
      case "/api/status":
        return json({ sync: {}, stats: {} });
      case "/api/playback/rules":
        if (request.method() === "POST") {
          const { action } = request.postDataJSON();
          installed = action !== "remove";
          if (action === "update") version = availableVersion;
        }
        if (url.searchParams.get("refresh") === "1") availableVersion = "2";
        return json({ items: installed || url.searchParams.has("remote") ? [{
          ...metadata, installed, version, available_version: availableVersion,
          update: installed && version !== availableVersion,
        }] : [] });
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
    assert.equal(await page.locator("#onlinePlaybackRule option").first().textContent(), "尚未下载规则");
    await page.click("#openPlaybackRuleSettings");
    await page.locator('#settingsModal[open] [data-settings-tab="playback"].active').waitFor();
    assert.equal(await page.evaluate(() => document.activeElement.id), "playbackRulesHeading");
    await page.locator("#playbackSkipInput").fill("95");
    await page.locator('#dmSourceMode').selectOption("dandanplay");
    assert.equal(await page.locator("#dmAppSecret").isVisible(), true);
    await page.getByRole("button", { name: "下载", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("#onlinePlaybackRule").value === "example");
    await page.locator("#settingsModal .modal-close").click();
    assert.equal(await page.evaluate(() => pcLoadPrefs().skip), 80);
    assert.equal(await page.evaluate(() => danmakuView.settings.sourceMode), "public");
    await page.click("#onlinePlaybackSearch");
    await page.waitForFunction(() => document.querySelector("#pcPlaybackMessage").textContent === "Fixture stream unavailable");
    assert.ok(await page.locator("#pcPlaybackRetry").isVisible());
    const stage = await page.locator("#offlinePlayerVideoWrap").boundingBox();
    assert.ok(Math.abs(stage.width / stage.height - 16 / 9) < 0.02, "failed video keeps a widescreen stage");
    assert.deepEqual(plays, [1, 2].map(source => ({
      rule: "example", anime: "series", source: String(source), episode: episode.id,
    })));
    assert.equal(await page.locator("#onlinePlayerSource").inputValue(), "2");
    await page.click("#pcPlaybackRetry");
    await page.waitForFunction(() => document.querySelector("#pcPlaybackState").dataset.state === "error");
    assert.equal(plays.length, 3);
    await page.click("#managePlayerRules");
    await page.locator('#settingsModal[open] [data-settings-tab="playback"].active').waitFor();
    await page.keyboard.press("Escape");
    await page.locator("#settingsModal").waitFor({ state: "hidden" });
    assert.ok(await page.locator("#offlinePlayer[open]").isVisible());
    await page.click("#onlinePlayerRule");
    await page.locator("#onlinePlaybackPicker[open]").waitFor();
    assert.match(await page.locator("#onlinePlaybackPickerTitle").textContent(), /第 6 集/);
    await page.click("#openPlaybackRuleSettings");
    await page.getByRole("button", { name: "检查更新" }).click();
    const update = page.getByRole("button", { name: "更新", exact: true });
    await update.waitFor();
    assert.match(await page.locator("#onlineRuleCatalogue small").textContent(), /1 → 2/);
    await update.click();
    await update.waitFor({ state: "detached" });
    assert.equal(version, "2");
    await page.getByRole("button", { name: "移除", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("#onlinePlaybackRule").value === "");
    assert.equal(await page.locator("#onlinePlaybackSearch").isDisabled(), true);
    await page.locator("#episodePlaybackSourceInput").selectOption("local");
    await page.locator('label:has(#playbackResumeInput) .switch').click();
    assert.equal(await page.locator("#playbackResumeInput").isChecked(), false);
    await page.locator("#playbackSpeedInput").selectOption("1.5");
    await page.locator("#playbackSkipInput").fill("95");
    await page.locator('[data-dm-pref="fontSize"]').fill("32");
    await page.locator("#saveSettings").click();
    await page.locator("#settingsModal").waitFor({ state: "hidden", timeout: 8000 });
    assert.deepEqual(await page.evaluate(() => {
      const { resume, speed, skip } = pcLoadPrefs();
      return { resume, speed, skip, fontSize: danmakuView.settings.fontSize, source: episodeGestureConfig().playbackSource };
    }), { resume: false, speed: 1.5, skip: 95, fontSize: 32, source: "local" });
    await page.reload();
    assert.equal(await page.evaluate(() => pcLoadPrefs().resume), false);
    assert.equal(await page.evaluate(() => danmakuView.settings.fontSize), 32);
    const position = await page.evaluate(() => {
      const video = pcPrepareVideo(12);
      Object.defineProperty(video, "duration", { configurable: true, value: 60 });
      video.dispatchEvent(new Event("loadedmetadata"));
      const fromStart = video.currentTime;
      pcSavePrefs({ resume: true });
      pcPrepareVideo(12);
      video.dispatchEvent(new Event("loadedmetadata"));
      return [fromStart, video.currentTime];
    });
    assert.deepEqual(position, [0, 12], "the shared player honors the resume preference");
    assert.deepEqual(pageErrors, []);
    console.log("Online rules: explicit download, line fallback, rule switching and removal.");
  } finally {
    await browser.close();
  }
}

verify().catch(error => { console.error(error); process.exitCode = 1; });
