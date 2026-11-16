const assert = require("node:assert/strict");
const fs = require("node:fs");
const { chromium } = require("C:/Users/han/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright");

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    const html = fs.readFileSync("static/index.html", "utf8").replace(/<script[\s\S]*?<\/script>/g, "").replace(/<link[^>]*>/g, "");
    await page.route("**/*", route => route.request().isNavigationRequest()
      ? route.fulfill({ body: html, contentType: "text/html" })
      : route.abort());
    await page.goto("http://localhost:48953/");
    await page.addScriptTag({ content: `
      const $ = (selector, root = document) => root.querySelector(selector);
      const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
      const state = {settings: {}};
      const escapeHtml = value => String(value);
      const notices = [], captures = [], saves = [], copies = [], starts = [];
      let clipboardBlocked = false;
      function toast(message) { notices.push(message); }
      async function api(path, options) {
        saves.push({path, data: JSON.parse(options.body).data});
        return {folder:"test", name:"image.png"};
      }
      Object.defineProperty(navigator, "clipboard", { value: {
        async write([item]) {
          starts.push(navigator.userActivation.isActive);
          if (clipboardBlocked) throw new DOMException("blocked", "NotAllowedError");
          const blob = await item.getType("image/png");
          copies.push([...new Uint8Array(await blob.arrayBuffer())]);
        }
      }});
    ` });
    await page.addScriptTag({ path: "static/modules/keyboard.js" });
    await page.addScriptTag({ path: "static/modules/offline.js" });
    assert.deepEqual(errors, []);
    await page.evaluate(() => {
      const video = $("#offlineVideo");
      Object.defineProperties(video, { videoWidth: { value: 2 }, readyState: { value: 4 } });
      $("#offlinePlayer").show();
      pcCaptureScreenshot = () => new Promise(resolve => captures.push(resolve));
      pcInit();
    });

    const release = (index, color) => page.evaluate(async ([index, color]) => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 2;
      const context = canvas.getContext("2d");
      context.fillStyle = color;
      context.fillRect(0, 0, 2, 2);
      captures[index]({ ...await pcShotBlob(canvas), upscaled: false, usedOriginal: false });
    }, [index, color]);
    const waitForSaves = count => page.waitForFunction(count => saves.length === count && notices.length >= count, count);

    await page.keyboard.press("s");
    await release(0, "red");
    await waitForSaves(1);
    assert.deepEqual(await page.evaluate(() => starts), []);

    await page.keyboard.press("Shift+s");
    await page.waitForFunction(() => starts.length === 1);
    assert.deepEqual(await page.evaluate(() => starts), [true], "clipboard starts during user activation");
    await release(1, "blue");
    await waitForSaves(2);
    const image = await page.evaluate(() => ({ copied: copies[0], saved: saves[1], message: notices[1] }));
    assert.equal(image.saved.path, "/api/offline/screenshot");
    assert.deepEqual(Buffer.from(image.copied), Buffer.from(image.saved.data.split(",")[1], "base64"));
    assert.match(image.message, /已复制到剪贴板/);

    await page.evaluate(() => { clipboardBlocked = true; });
    await page.keyboard.press("Shift+s");
    await release(2, "green");
    await waitForSaves(3);
    assert.match(await page.evaluate(() => notices[2]), /已存入媒体库.*复制到剪贴板失败/);

    await page.evaluate(() => { clipboardBlocked = false; });
    await page.keyboard.press("Shift+s");
    await page.keyboard.press("Shift+s");
    await release(4, "cyan");
    await waitForSaves(4);
    await release(3, "orange");
    await waitForSaves(5);
    assert.equal(await page.evaluate(() => copies.length), 2, "late screenshot must not replace the newer copied image");

    const legacy = await page.evaluate(() => keyboardPreferences({
      bindings: { player_skip: { enabled: true, keys: ["Shift+s"] } },
    }).bindings);
    assert.equal(legacy.player_skip.enabled, true);
    assert.equal(legacy.player_screenshot_copy.enabled, false);
    assert.deepEqual(errors, []);
    console.log("Player screenshot clipboard: shortcut activation, identical PNG, save-only, denial and newest image verified.");
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
