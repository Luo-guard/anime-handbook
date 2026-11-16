const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const moduleSource = fs.readFileSync(path.join(__dirname, "../static/modules/offline.js"), "utf8");
const source = moduleSource.slice(moduleSource.indexOf("function pcUpscaleCanvas("), moduleSource.indexOf("function pcSendDanmaku("));
let clock = 0;
const context = vm.createContext({ performance: { now: () => clock } });
vm.runInContext(source, context);

function pausedVideo(seekable = true) {
  let position = 2.31;
  return {
    currentSrc: "fixture.mp4",
    paused: true,
    seeking: false,
    seeks: [],
    seekable: { length: Number(seekable), start: () => 0, end: () => 5 },
    play() { assert.fail("paused screenshot must never play the video"); },
    get currentTime() { return position; },
    set currentTime(value) { this.seeks.push(value); this.seeking = true; position = value; },
  };
}

(async () => {
  const frame = { width: 640, height: 360 };
  const canvas = { isConnected: true };
  context.pcReadUpscaledFrame = () => frame;
  const readable = pausedVideo();
  assert.equal(await context.pcCaptureUpscaled(readable, canvas), frame);
  assert.deepEqual(readable.seeks, []);

  const refreshed = pausedVideo();
  context.pcReadUpscaledFrame = () => refreshed.seeks.length ? frame : null;
  context.pcNextFrame = async () => {
    refreshed.seeking = false;
    return true;
  };
  assert.equal(await context.pcCaptureUpscaled(refreshed, canvas), frame);
  assert.deepEqual(refreshed.seeks, [2.31]);
  assert.equal(refreshed.currentTime, 2.31);
  assert.equal(refreshed.paused, true);

  const changed = pausedVideo();
  context.pcReadUpscaledFrame = () => changed.seeks.length ? frame : null;
  context.pcNextFrame = async () => {
    changed.currentSrc = "different.mp4";
    return true;
  };
  assert.equal(await context.pcCaptureUpscaled(changed, canvas), null);

  const unavailable = pausedVideo();
  context.pcReadUpscaledFrame = () => null;
  context.pcNextFrame = async () => { clock += 500; return true; };
  assert.equal(await context.pcCaptureUpscaled(unavailable, canvas), null);
  assert.deepEqual(unavailable.seeks, [2.31]);
  const unseekable = pausedVideo(false);
  assert.equal(await context.pcCaptureUpscaled(unseekable, canvas), null);
  assert.deepEqual(unseekable.seeks, []);
  console.log("Paused upscaling: readable frame, same-position redraw, source change and fallback checked.");
})().catch(error => { console.error(error); process.exitCode = 1; });
