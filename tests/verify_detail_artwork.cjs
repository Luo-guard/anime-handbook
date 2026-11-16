const assert = require("node:assert/strict");
const fs = require("node:fs");
const { chromium } = require("C:/Users/han/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright");

const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFElEQVR4nGP8z8DAwMDAxMDAwMAAAAwBAQDJ/pLvAAAAAElFTkSuQmCC", "base64");
const html = `<!doctype html><link rel="stylesheet" href="/styles.css">
  <dialog id="progressModal" data-detail-background="artwork">
    <div class="detail-artwork"><img id="detailArtworkCover" alt=""><img id="detailArtwork" alt=""></div>
    <img id="progressCover" alt="">
  </dialog>
  <script>
    const $ = (selector, root = document) => root.querySelector(selector);
    const $$ = selector => [...document.querySelectorAll(selector)];
    const state = {};
  </script><script defer src="/details.js"></script>`;

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const pending = new Map();
    const waiting = new Map();
    const artworkRequests = [];
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("http://handbook.test/**", async route => {
      const { pathname } = new URL(route.request().url());
      if (pathname === "/") return route.fulfill({ contentType: "text/html", body: html });
      if (pathname === "/details.js") return route.fulfill({ path: "static/modules/details.js", contentType: "text/javascript" });
      if (pathname === "/styles.css") return route.fulfill({ body: fs.readFileSync("static/styles.css"), contentType: "text/css" });
      if (pathname.startsWith("/covers/")) return route.fulfill({ contentType: "image/png", body: image });
      if (!pathname.startsWith("/api/detail-artwork/")) return route.abort();
      const id = Number(pathname.split("/").at(-1));
      artworkRequests.push(id);
      const status = await new Promise(resolve => {
        pending.set(id, resolve);
        waiting.get(id)?.();
      });
      const response = status === 204 ? { status } : { contentType: "image/png", body: image };
      await route.fulfill(response).catch(error => {
        if (id !== 3) throw error;
      });
    });
    await page.goto("http://handbook.test/");

    const changeAnime = async id => {
      const requested = new Promise(resolve => waiting.set(id, resolve));
      await page.evaluate(id => {
        state.progressAnime = { id, cover_url: `/covers/${id}.png` };
        $("#progressCover").src = state.progressAnime.cover_url;
        if (!$("#progressModal").open) $("#progressModal").showModal();
        updateDetailArtwork();
      }, id);
      await requested;
    };
    const loaded = id => page.waitForFunction(
      selector => document.querySelector(selector).classList.contains("loaded"), id,
    );
    const cover = page.locator("#detailArtworkCover");
    const artwork = page.locator("#detailArtwork");

    await changeAnime(1);
    await page.waitForFunction(() => $("#progressCover").naturalWidth > 0);
    assert.equal(await cover.getAttribute("src"), null, "portrait loaded before artwork must never become the background");
    assert.equal(await artwork.evaluate(node => getComputedStyle(node).visibility), "hidden");
    pending.get(1)(200);
    await loaded("#detailArtwork");
    assert.equal(await cover.getAttribute("src"), null);

    await changeAnime(2);
    assert.equal(await cover.getAttribute("src"), null);
    pending.get(2)(204);
    await loaded("#detailArtworkCover");
    assert.equal(await cover.getAttribute("src"), "/covers/2.png");
    await page.evaluate(() => updateDetailArtwork());
    assert.deepEqual(artworkRequests, [1, 2], "rerender must not retry a missing background while open");

    await changeAnime(3);
    assert.equal(await cover.getAttribute("src"), null, "previous anime's fallback is cleared immediately");
    await changeAnime(4);
    pending.get(4)(200);
    await loaded("#detailArtwork");
    pending.get(3)(204);
    assert.equal(await artwork.getAttribute("src"), "/api/detail-artwork/4?v=3");
    assert.equal(await cover.getAttribute("src"), null);
    assert.deepEqual(artworkRequests, [1, 2, 3, 4]);
    assert.deepEqual(errors, []);
    console.log("Detail artwork: pending artwork, missing fallback and rapid title changes use the original request count.");
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
