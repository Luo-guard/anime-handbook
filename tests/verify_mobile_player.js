const assert = require("node:assert/strict");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const { chromium } = require("C:/Users/han/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright");

async function main() {
  const movie = execFileSync("ffmpeg", [
    "-v","error","-f","lavfi","-i","testsrc2=s=320x180:r=12:d=5",
    "-c:v","libx264","-pix_fmt","yuv420p","-movflags","frag_keyframe+empty_moov","-f","mp4","pipe:1",
  ]);
  const segment = execFileSync("ffmpeg", [
    "-v","error","-f","lavfi","-i","testsrc2=s=320x180:r=12:d=5",
    "-c:v","libx264","-pix_fmt","yuv420p","-f","mpegts","pipe:1",
  ]);
  const browser = await chromium.launch({channel:"msedge"});
  try {
    const context = await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => {
      const anime = {id:42, name_cn:"测试番剧", collection_type:1,
        episodes:JSON.stringify([{key:"01",display_label:"01",name_cn:"开场"},{key:"02",display_label:"02",name_cn:"续篇"}])};
      let snapshot = JSON.stringify({tables:{anime:[anime],events:[],settings:[]}});
      window.AndroidHandbook = {
        state:() => snapshot, saveState:value => {snapshot=value;return true;},
        uiState:() => "{}", saveUiState:() => {}, config:() => "{}",
      };
      window.nativeEvents = [];
      window.AndroidPlayer = {
        bars:hidden => nativeEvents.push(["bars",hidden]),
        volume:level => nativeEvents.push(["volume",level]),
        pip:() => window.HandbookPlayer.pictureInPicture(true),
        saveImage:(_,data) => nativeEvents.push(["shot",data]),
        requestDanmaku(id, raw) {
          const {path} = JSON.parse(raw);
          const payload = path.startsWith("/api/v2/search/")
            ? {animes:[{animeTitle:"测试番剧",episodes:[{episodeId:101,episodeTitle:"01 开场"}]}]}
            : {comments:[{p:"1,1,16777215",m:"测试弹幕"}]};
          setTimeout(() => window.HandbookPlayer.danmakuResult(id,JSON.stringify(payload),null),20);
        },
      };
    });
    await page.route("https://appassets.androidplatform.net/**", route => {
      const name = new URL(route.request().url()).pathname.slice(1) || "index.html";
      const path = /^(modules|vendor)\//.test(name) ? "static/" + name : "android/app/src/main/assets/" + name;
      return fs.existsSync(path) ? route.fulfill({path}) : route.abort();
    });
    await page.goto("https://appassets.androidplatform.net/index.html");
    await page.getByRole("button",{name:/测试番剧/}).click();
    await page.getByRole("button",{name:"在手账里播放"}).click();
    await page.locator("#mpFiles").setInputFiles(["01.mp4","02.mp4"].map(name => ({name,mimeType:"video/mp4",buffer:movie})));
    await page.waitForFunction(() => document.querySelector("#offlineVideo").readyState >= 2);
    assert.match(await page.locator("#mpTitle").innerText(),/开场/);
    await page.locator("#mpSpeed").selectOption("1.5");
    assert.equal(await page.locator("video").evaluate(v => v.playbackRate),1.5);
    await page.locator("#mpUpscaleButton").click();
    await page.locator("#mpQuality").selectOption("fast");
    await page.locator(".pc-native-upscale:not([hidden])").waitFor();
    await page.locator("#mpUpscaleButton").click();
    await page.locator("#mpShot").click();
    await page.waitForFunction(() => nativeEvents.some(([type]) => type==="shot"));
    const shot = Buffer.from(await page.evaluate(() => nativeEvents.find(([type]) => type==="shot")[1]),"base64");
    assert.equal(shot.readUInt32BE(16),640);
    await page.locator("#offlineDanmakuSettings").click();
    await page.locator("#dmOnlineSearch").click();
    await page.locator("#dmMatchRow:not(.hidden)").waitFor();
    await page.locator("#dmUseMatch").click();
    await page.waitForFunction(() => document.querySelector("#dmCount").textContent==="1 条");
    await page.locator("#dmPanelClose").click();
    await page.locator("#mpNext").click();
    await page.waitForFunction(() => document.querySelector("#offlineVideo").readyState >= 2);
    assert.match(await page.locator("#mpTitle").innerText(),/续篇/);
    assert.match(await page.locator("#dmCount").innerText(),/0 条/);
    await page.locator("#mpWatched").click();
    assert.equal(await page.locator("#mpWatched").innerText(),"已记录");
    await page.locator("#mpFullscreen").click();
    assert.equal(await page.locator("#mobilePlayer").evaluate(node => node.classList.contains("mp-fullscreen")),true);
    await page.locator("#mpPip").click();
    assert.equal(await page.locator("#mobilePlayer").evaluate(node => node.classList.contains("mp-pip")),true);
    await page.evaluate(() => window.HandbookPlayer.pictureInPicture(false));
    await page.evaluate(() => window.HandbookMobile.handleBack());
    await page.evaluate(() => window.HandbookMobile.handleBack());
    assert.equal(await page.locator("#mobilePlayer").isVisible(),false);
    assert.equal(await page.locator("video").getAttribute("src"),null);
    const headers = {"Access-Control-Allow-Origin":"*"};
    await page.route("https://video.example.test/**", route => {
      const target = new URL(route.request().url());
      return target.pathname.endsWith(".m3u8") ? route.fulfill({
        headers,contentType:"application/vnd.apple.mpegurl",
        body:"#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:5\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:5,\nclip.ts\n#EXT-X-ENDLIST\n",
      }) : route.fulfill({headers,contentType:"video/mp2t",body:segment});
    });
    await page.locator("nav").getByRole("button",{name:"播放",exact:true}).click();
    await page.locator("#mpUrl").fill("https://video.example.test/01.m3u8");
    await page.getByRole("button",{name:"添加并播放"}).click();
    await page.waitForFunction(() => document.querySelector("#offlineVideo").readyState >= 2);
    assert.equal(await page.locator("video").evaluate(v => v.videoWidth),320);
    assert.deepEqual(errors,[]);
    console.log("Mobile browser: local and HLS playback, episodes, speed, Anime4K screenshot, danmaku, recording and cleanup verified.");
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode=1; });
