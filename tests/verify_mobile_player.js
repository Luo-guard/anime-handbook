const assert = require("node:assert/strict");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const { chromium } = require("C:/Users/han/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright");

async function main() {
  const movie = execFileSync("ffmpeg", [
    "-v","error","-f","lavfi","-i","testsrc2=s=320x180:r=12:d=12",
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
      window.fetched = [];
      window.AndroidPlayer = {
        bars:hidden => nativeEvents.push(["bars",hidden]),
        volume:level => nativeEvents.push(["volume",level]),
        pip:() => window.HandbookPlayer.pictureInPicture(true),
        saveImage:(_,data) => nativeEvents.push(["shot",data]),
        external:url => nativeEvents.push(["external",url]),
        fetchText(id, url) {
          window.fetched.push(url);
          const reply = {
            "api.github.com": JSON.stringify([{name:"demo.json", download_url:"https://raw.githubusercontent.com/demo/rule/demo.json", size:120}]),
            "demo.json": JSON.stringify({
              name:"演示站", type:"anime", baseURL:"https://demo.test/",
              searchURL:"https://demo.test/search/@keyword",
              searchList:"//div[@class='item']", searchName:".//a", searchResult:".//a",
              chapterRoads:"//ul[@class='eps']", chapterResult:".//a", useWebview:false,
            }),
            "/search/": "<div class='item'><a href='/anime/1'>测试番 第一季</a></div>",
            "/anime/1": "<ul class='eps'><li><a href='/play/1-1'>第 1 集</a></li><li><a href='/play/1-2'>第 2 集</a></li></ul>",
            "/play/": "<script>var player={url:'https:\\/\\/video.example.test\\/rule.m3u8'};</script>",
          };
          const key = Object.keys(reply).find(item => url.includes(item));
          setTimeout(() => window.HandbookRules?.fetchResult(id, key ? reply[key] : null, key ? null : "没有匹配的测试响应"), 10);
        },
        requestDanmaku(id, raw) {
          const {path} = JSON.parse(raw);
          const payload = path.startsWith("/api/v2/search/")
            ? {animes:[{animeTitle:"测试番剧",episodes:[{episodeId:101,episodeTitle:"01 开场"},{episodeId:102,episodeTitle:"02 续篇"}]}]}
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
    const headers = {"Access-Control-Allow-Origin":"*"};
    await page.route("https://video.example.test/**", route => {
      const target = new URL(route.request().url());
      return target.pathname.endsWith(".m3u8") ? route.fulfill({
        headers,contentType:"application/vnd.apple.mpegurl",
        body:"#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:5\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:5,\nclip.ts\n#EXT-X-ENDLIST\n",
      }) : route.fulfill({headers,contentType:"video/mp2t",body:segment});
    });
    await page.goto("https://appassets.androidplatform.net/index.html");
    await page.getByRole("button",{name:/测试番剧/}).click();
    await page.getByRole("button",{name:"在手账里播放"}).click();
    await page.locator("#mpFiles").setInputFiles(["01.mp4","02.mp4"].map(name => ({name,mimeType:"video/mp4",buffer:movie})));
    await page.waitForFunction(() => document.querySelector("#offlineVideo").readyState >= 2);
    assert.match(await page.locator("#mpTitle").innerText(),/开场/);
    assert.match(await page.locator("#mpEpisodeLabel").innerText(),/第 1 \/ 2 集/);

    // 1) 控制层自动隐藏，点画面唤回
    await page.waitForTimeout(4600);
    assert.equal(await page.locator("#mobilePlayer").evaluate(n => n.classList.contains("mp-controls-hidden")), true, "播放中控制层应自动收起");
    await page.locator("#mpStage").click({position:{x:195,y:300}});
    await page.waitForTimeout(400);
    assert.equal(await page.locator("#mobilePlayer").evaluate(n => n.classList.contains("mp-controls-hidden")), false, "点画面应唤回控制层");

    // 2) 菜单里的倍速
    await page.locator("#mpMore").click();
    await page.locator("#mpSpeed").selectOption("1.5");
    assert.equal(await page.locator("video").evaluate(v => v.playbackRate),1.5);
    await page.locator("#mpMenu .mp-sheet-close").click();

    // 3) 超分档位（单选卡片）
    await page.locator("#mpMore").click();
    await page.locator("#mpUpscaleButton").click();
    await page.locator('input[name="mpQuality"][value="fast"]').check();
    await page.locator(".pc-native-upscale:not([hidden])").waitFor();
    await page.locator("#mpUpscale .mp-sheet-close").click();
    await page.locator("video").evaluate(v => { v.playbackRate = 1; });

    // 4) 截图仍然按超分后的尺寸
    await page.locator("#mpShot").click();
    await page.waitForFunction(() => nativeEvents.some(([type]) => type==="shot"));
    const shot = Buffer.from(await page.evaluate(() => nativeEvents.find(([type]) => type==="shot")[1]),"base64");
    assert.equal(shot.readUInt32BE(16),640);

    // 5) 双击右侧快进 10 秒
    await page.evaluate(() => { const v = document.querySelector("#offlineVideo"); v.currentTime = 0; });
    const box = await page.locator("#mpStage").boundingBox();
    await page.mouse.click(box.x + box.width * .86, box.y + box.height * .5);
    await page.waitForTimeout(120);
    await page.mouse.click(box.x + box.width * .86, box.y + box.height * .5);
    await page.waitForTimeout(600);
    const jumped = await page.locator("video").evaluate(v => v.currentTime);
    assert.ok(jumped > 8 && jumped < 12, `双击右侧应快进约 10 秒，实际 ${jumped}`);
    assert.match(await page.locator("#mpFlash").innerText(), /快进 10 秒/);

    // 6) 选集面板：分组网格、当前集高亮
    await page.locator("#mpEpisodesButton").click();
    assert.equal(await page.locator("#mpEpisodeGrid .mp-episode").count(), 2);
    assert.equal(await page.locator("#mpEpisodeGrid .mp-episode.is-current").count(), 1);
    await page.locator('#mpEpisodeGrid .mp-episode[data-episode-index="1"]').click();
    await page.waitForFunction(() => document.querySelector("#offlineVideo").readyState >= 2);
    assert.match(await page.locator("#mpTitle").innerText(),/续篇/);

    // 7) 弹幕设置与发送框
    await page.locator("#mpMore").click();
    await page.locator("#offlineDanmakuSettings").click();
    await page.locator("#dmOnlineSearch").click();
    await page.locator("#dmMatchRow:not(.hidden)").waitFor();
    await page.locator("#dmUseMatch").click();
    await page.waitForFunction(() => document.querySelector("#dmCount").textContent==="1 条");
    assert.equal(await page.locator("#dmSendInput").isVisible(), true);
    await page.locator("#dmPanelClose").click();

    // 8) 记录已看
    await page.locator("#mpMore").click();
    await page.locator("#mpWatched").click();
    assert.equal(await page.locator("#mpWatched").innerText(),"已记录");
    await page.locator("#mpMenu .mp-sheet-close").click();

    // 9) 沉浸模式与画中画
    await page.locator("#mpFullscreen").click();
    assert.equal(await page.locator("#mobilePlayer").evaluate(node => node.classList.contains("mp-fullscreen")),true);
    await page.locator("#mpMore").click();
    await page.locator("#mpPip").click();
    assert.equal(await page.locator("#mobilePlayer").evaluate(node => node.classList.contains("mp-pip")),true);
    await page.evaluate(() => window.HandbookPlayer.pictureInPicture(false));

    // 10) 返回键：收面板 → 退沉浸 → 关播放器
    for (let i = 0; i < 4 && await page.locator("#mobilePlayer").isVisible(); i += 1) {
      await page.evaluate(() => window.HandbookMobile.handleBack());
    }
    assert.equal(await page.locator("#mobilePlayer").isVisible(),false);
    assert.equal(await page.locator("video").getAttribute("src"),null);

    // 11) 直链 HLS
    await page.locator("nav").getByRole("button",{name:"播放",exact:true}).click();
    await page.locator("#mpUrl").fill("https://video.example.test/01.m3u8");
    await page.getByRole("button",{name:"添加并播放"}).click();
    await page.waitForFunction(() => document.querySelector("#offlineVideo").readyState >= 2);
    assert.equal(await page.locator("video").evaluate(v => v.videoWidth),320);
    await page.evaluate(() => window.HandbookMobile.handleBack());

    // 12) 规则仓库：装规则 → 按番名找源 → 解析直链播放
    await page.locator("nav").getByRole("button",{name:"播放",exact:true}).click();
    await page.locator("#mpMore").click();
    await page.locator("#mpSourcesButton").click();
    await page.locator("#mpRulesButton").click();
    await page.locator('[data-rule-tab="repo"]').click();
    await page.locator("#mpRuleRefresh").click();
    await page.waitForFunction(() => document.querySelectorAll("#mpRuleRepo [data-install]").length === 1);
    await page.locator("#mpRuleRepo [data-install]").click();
    await page.waitForFunction(() => document.querySelector("#mpRuleRepoStatus").textContent.includes("已安装"));
    await page.locator('[data-rule-tab="find"]').click();
    await page.locator("#mpRuleQuery").fill("测试番");
    await page.getByRole("button",{name:"搜索片源"}).click();
    await page.waitForFunction(() => document.querySelectorAll("#mpRuleResults [data-result]").length === 1);
    await page.locator('#mpRuleResults [data-result="0"]').click();
    await page.waitForFunction(() => document.querySelectorAll("#mpRuleEpisodes [data-play]").length === 2);
    await page.locator('#mpRuleEpisodes [data-play="0"]').click();
    await page.waitForFunction(() => document.querySelector("#offlineVideo").readyState >= 2 && (document.querySelector("#offlineVideo").currentSrc||"").includes("rule.m3u8"));
    assert.equal(await page.locator("video").evaluate(v => v.videoWidth),320);
    await page.screenshot({path:"C:/Users/han/AppData/Local/Temp/hb-shots/mobile-player.png"});

    assert.deepEqual(errors,[]);
    console.log("Mobile browser: gestures, auto-hide, menu, episodes, Anime4K, danmaku, rules repository and playback verified.");
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode=1; });
