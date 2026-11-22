const assert = require("node:assert/strict");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const { chromium } = require("C:/Users/han/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright");

function sampleVideo(width, height) {
  return execFileSync("ffmpeg", [
    "-v", "error", "-f", "lavfi", "-i", `color=red:s=${width}x${height}:r=12:d=2`,
    "-vf", `drawbox=y=${height / 2}:w=iw:h=ih:color=blue:t=fill`,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "frag_keyframe+empty_moov", "-f", "mp4", "pipe:1",
  ]);
}

async function main() {
  const primary = sampleVideo(320, 180);
  const secondary = sampleVideo(160, 88);
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const origin = "http://localhost:48954";
    await page.route(`${origin}/**`, (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/") {
        const body = fs.readFileSync("static/index.html", "utf8")
          .replace(/<script[\s\S]*?<\/script>/g, "").replace(/<link[^>]*>/g, "");
        return route.fulfill({ body, contentType: "text/html" });
      }
      if (path === "/primary.mp4" || path === "/secondary.mp4") {
        return route.fulfill({ contentType: "video/mp4", body: path === "/primary.mp4" ? primary : secondary });
      }
      if (path === "/styles.css" || ["/modules/offline.js", "/modules/player-upscale.js", "/modules/anime4k-shaders.js"].includes(path)) {
        return route.fulfill({ path: `static${path}` });
      }
      return route.abort();
    });
    await page.goto(origin);
    await page.addStyleTag({ url: `${origin}/styles.css` });
    await page.addScriptTag({ content: `
      const $ = (selector, root = document) => root.querySelector(selector);
      const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
      const state = {settings: {}};
      const escapeHtml = value => String(value);
    ` });
    await page.addScriptTag({ url: `${origin}/modules/offline.js` });
    await page.evaluate(async () => {
      $("#offlinePlayer").show();
      pcInit();
      const video = pcPrepareVideo(0);
      video.src = "/primary.mp4";
      await new Promise((resolve) => video.addEventListener("loadeddata", resolve, { once: true }));
    });
    const menu = page.locator("#pcUpscale");
    async function select(mode) {
      await menu.click();
      await page.locator(`#pcUpscaleMenu [data-upscale="${mode}"]`).click();
    }
    const active = page.locator('#pcUpscale[data-active="true"]');
    const canvas = page.locator(".pc-native-upscale");
    assert.equal(await canvas.count(), 0, "default uses the native video");
    await select("fast");
    await active.waitFor({ timeout: 12000 });
    const pausedShot = await page.evaluate(async () => {
      const video = $("#offlineVideo");
      const {blob, width, height, upscaled} = await pcCaptureScreenshot(video, video.currentTime);
      const image = await createImageBitmap(blob);
      const output = document.createElement("canvas");
      output.width = width;
      output.height = height;
      const context = output.getContext("2d");
      context.drawImage(image, 0, 0);
      return {
        width, height, upscaled, paused: video.paused,
        top: [...context.getImageData(20, 20, 1, 1).data],
        bottom: [...context.getImageData(20, height - 20, 1, 1).data],
      };
    });
    assert.equal(pausedShot.upscaled, true);
    assert.equal(pausedShot.paused, true);
    assert.equal(pausedShot.width, 640);
    assert.equal(pausedShot.height, 360);
    assert(pausedShot.top[0] > 200 && pausedShot.top[2] < 40, "top remains red");
    assert(pausedShot.bottom[2] > 200 && pausedShot.bottom[0] < 40, "bottom remains blue");
    await select("quality");
    await active.waitFor({ timeout: 12000 });
    assert.match(await active.textContent(), /质量档/);
    assert.equal(await page.evaluate(() => pcLoadPrefs().upscale), "quality");
    await page.evaluate(async () => {
      const video = $("#offlineVideo");
      video.muted = true;
      await video.play();
    });
    await page.waitForFunction(() => $("#offlineVideo").currentTime > 0.25);
    await page.locator("#pcFullscreen").click();
    await page.waitForFunction(() => document.fullscreenElement?.contains(document.querySelector(".pc-native-upscale")));
    await page.evaluate(() => document.exitFullscreen());
    await page.evaluate(async () => {
      pcResetVideo();
      const video = pcPrepareVideo(0);
      video.src = "/secondary.mp4";
      await new Promise((resolve) => video.addEventListener("loadeddata", resolve, { once: true }));
    });
    await page.waitForFunction(() => document.querySelector(".pc-native-upscale:not([hidden])")?.width === 320);
    assert.match(await active.textContent(), /质量档/);
    await select("off");
    assert.equal(await canvas.count(), 0, "disabling releases the renderer");
    assert.equal(await page.evaluate(() => pcLoadPrefs().upscale), "off");
    await page.evaluate(() => {
      const getContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (kind, ...args) {
        return kind === "webgl2" ? null : getContext.call(this, kind, ...args);
      };
    });
    await select("fast");
    await page.waitForFunction(() => $("#pcUpscaleStatus").textContent.includes("已恢复普通播放"));
    assert.equal(await canvas.count(), 0, "unsupported GPU leaves the video visible");
    assert.equal(await page.evaluate(async () => {
      const video = $("#offlineVideo");
      const shot = await pcCaptureScreenshot(video, video.currentTime);
      return shot.width;
    }), 160);
    assert.deepEqual(errors, []);
    console.log("Edge Anime4K: Kazumi quality/lite chains, paused screenshot colors and size, playback, source change and shutdown verified.");
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
