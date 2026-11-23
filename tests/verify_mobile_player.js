const assert = require("node:assert/strict");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const { chromium } = require("C:/Users/han/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright");

async function main() {
  const movie = execFileSync("ffmpeg", [
    "-v","error","-f","lavfi","-i","testsrc2=s=320x180:r=12:d=60",
    "-c:v","libx264","-pix_fmt","yuv420p","-movflags","frag_keyframe+empty_moov","-f","mp4","pipe:1",
  ], {maxBuffer: 32 * 1024 * 1024});
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
      const bare = {id:43, name_cn:"无线路番剧", collection_type:1, episodes:"[]", episode_count:2};
      let snapshot = JSON.stringify({tables:{anime:[anime,bare],events:[],settings:[]}});
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
        external:url => nativeEvents.push(["external",url]),
        fetchText(id, url) {
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
    await page.locator(".play-fab").click();
    await page.locator("#mpFiles").setInputFiles(["01.mp4","02.mp4"].map(name => ({name,mimeType:"video/mp4",buffer:movie})));
    await page.waitForFunction(() => document.querySelector("#offlineVideo").readyState >= 2);
    assert.match(await page.locator("#mpTitle").textContent(),/测试番剧/);
    assert.match(await page.locator("#mpEpisodeLabel").textContent(),/开场/);

    // 1) 底栏只有 播放/进度/时间/全屏，上下集不再常驻
    assert.equal(await page.locator(".mp-bottom .mp-btn").count(), 2, "底栏应只有播放与全屏两个按钮");
    assert.equal(await page.locator("#mpPrevious").count(), 0, "上下集不再常驻底栏");

    // 2) 控制层自动隐藏；点一下画面唤回
    await page.waitForTimeout(4600);
    assert.equal(await page.locator("#mobilePlayer").evaluate(n => n.classList.contains("mp-controls-hidden")), true, "播放中控制层应自动收起");
    await page.mouse.click(195, 300);
    await page.waitForTimeout(400);
    assert.equal(await page.locator("#mobilePlayer").evaluate(n => n.classList.contains("mp-controls-hidden")), false, "点画面应唤回控制层");

    // 3) 双击 = 播放/暂停（Kazumi 行为）
    await page.mouse.click(195, 300);
    await page.waitForTimeout(120);
    await page.mouse.click(195, 300);
    await page.waitForTimeout(400);
    assert.equal(await page.locator("#offlineVideo").evaluate(v => v.paused), true, "双击应暂停");
    await page.mouse.click(195, 300);
    await page.waitForTimeout(120);
    await page.mouse.click(195, 300);
    await page.waitForTimeout(500);
    assert.equal(await page.locator("#offlineVideo").evaluate(v => v.paused), false, "再双击应继续播放");

    // 4) 横向拖动 = 快进，HUD 显示目标时间
    await page.evaluate(() => { const v = document.querySelector("#offlineVideo"); v.pause(); v.currentTime = 10; });
    await page.waitForTimeout(300);
    const box = await page.locator("#mpStage").boundingBox();
    const y = box.y + box.height * .5;
    await page.mouse.move(box.x + 120, y);
    await page.mouse.down();
    await page.mouse.move(box.x + 220, y, {steps: 6});
    await page.mouse.up();
    await page.waitForTimeout(400);
    const afterDrag = await page.locator("#offlineVideo").evaluate(v => v.currentTime);
    assert.ok(afterDrag > 36 && afterDrag < 45, `向右拖 100px（整屏 120 秒）应前进约 30 秒，实际 ${afterDrag}`);
    assert.match(await page.locator("#mpHudMain").innerText(), /^\d{2}:\d{2}$/);

    // 5) 右半屏纵向拖动 = 音量（走原生）
    await page.evaluate(() => { nativeEvents.length = 0; });
    await page.mouse.move(box.x + box.width * .8, box.y + 400);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * .8, box.y + 300, {steps: 6});
    await page.mouse.up();
    await page.waitForTimeout(300);
    assert.ok(await page.evaluate(() => nativeEvents.some(([type]) => type === "volume")), "右半屏上下滑应调音量");

    // 6) ⋮ 菜单：倍速
    await page.locator("#mpMore").click();
    await page.locator("#mpMenu").waitFor();
    await page.locator('#mpMenu [data-menu="speed"]').click();
    await page.locator('#mpPicker .mp-option[data-value="1.5"]').click();
    assert.equal(await page.locator("video").evaluate(v => v.playbackRate),1.5);

    // 7) ⋮ 菜单：超分辨率
    await page.locator("#mpMore").click();
    await page.locator('#mpMenu [data-menu="upscale"]').click();
    await page.locator('input[name="mpQuality"][value="fast"]').check();
    await page.locator(".pc-native-upscale:not([hidden])").waitFor();
    await page.locator("#mpUpscale .mp-sheet-close").click();
    await page.evaluate(() => { document.querySelector("#offlineVideo").playbackRate = 1; });

    // 8) ⋮ 菜单：截图（超分后按 2 倍尺寸保存）
    await page.locator("#mpMore").click();
    await page.locator('#mpMenu [data-menu="shot"]').click();
    await page.waitForFunction(() => nativeEvents.some(([type]) => type==="shot"));
    const shot = Buffer.from(await page.evaluate(() => nativeEvents.find(([type]) => type==="shot")[1]),"base64");
    assert.equal(shot.readUInt32BE(16),640);

    // 9) 选集抽屉（右侧滑出）
    await page.locator("#mpMore").click();
    await page.locator('#mpMenu [data-menu="episodes"]').click();
    await page.locator("#mpEpisodes").waitFor();
    assert.equal(await page.locator("#mpEpisodeGrid .mp-episode").count(), 2);
    await page.locator('#mpEpisodeGrid .mp-episode[data-episode-index="1"]').click();
    await page.waitForFunction(() => document.querySelector("#offlineVideo").readyState >= 2);
    assert.match(await page.locator("#mpEpisodeLabel").textContent(),/续篇/);

    // 10) 弹幕设置与发送框
    await page.locator("#mpMore").click();
    await page.locator('#mpMenu [data-menu="danmaku"]').click();
    await page.locator("#dmOnlineSearch").click();
    await page.locator("#dmMatchRow:not(.hidden)").waitFor();
    await page.locator("#dmUseMatch").click();
    await page.waitForFunction(() => document.querySelector("#dmCount").textContent==="1 条");
    assert.equal(await page.locator("#dmSendInput").isVisible(), true);
    await page.locator("#dmPanelClose").click();

    // 11) 顶栏：记录已看 / 沉浸 / 画中画
    await page.locator("#mpWatched").click();
    assert.equal(await page.locator("#mpWatched").getAttribute("aria-pressed"),"true");
    await page.locator("#mpFullscreen").click();
    assert.equal(await page.locator("#mobilePlayer").evaluate(node => node.classList.contains("mp-fullscreen")),true);
    await page.locator("#mpMore").click();
    await page.locator('#mpMenu [data-menu="pip"]').click();
    assert.equal(await page.locator("#mobilePlayer").evaluate(node => node.classList.contains("mp-pip")),true);
    await page.evaluate(() => window.HandbookPlayer.pictureInPicture(false));

    // 12) 返回：先收面板 → 退沉浸 → 关播放器
    for (let i = 0; i < 4 && await page.locator("#mobilePlayer").isVisible(); i += 1) {
      await page.evaluate(() => window.HandbookMobile.handleBack());
    }
    assert.equal(await page.locator("#mobilePlayer").isVisible(),false);
    assert.equal(await page.locator("video").getAttribute("src"),null);

    // 13) 直链 HLS（从详情页进播放器，片源面板自动弹出）
    await page.locator(".play-fab").click();
    await page.locator("#mpUrl").fill("https://video.example.test/01.m3u8");
    await page.getByRole("button",{name:"添加并播放"}).click();
    await page.waitForFunction(() => document.querySelector("#offlineVideo").readyState >= 2);
    assert.equal(await page.locator("video").evaluate(v => v.videoWidth),320);
    await page.evaluate(() => window.HandbookMobile.handleBack());

    // 14) 规则：导航「规则」→ 装规则 → 按番名找源 → 解析直链播放
    await page.locator("nav").getByRole("button",{name:"规则",exact:true}).click();
    await page.locator("#rulesPage").waitFor();
    await page.locator('[data-rule-tab="repo"]').click();
    await page.locator("#mpRuleRefresh").click();
    await page.waitForFunction(() => document.querySelectorAll("#mpRuleRepo [data-install]").length === 1);
    await page.locator("#mpRuleRepo [data-install]").click();
    await page.waitForFunction(() => document.querySelector("#mpRuleRepoStatus").textContent.includes("已安装"));
    await page.locator('[data-rule-tab="find"]').click();
    await page.locator("#mpRuleQuery").fill("测试番");
    await page.locator("#mpRuleFindForm button").click();
    await page.waitForFunction(() => document.querySelectorAll("#mpRuleResults [data-result]").length === 1);
    await page.locator('#mpRuleResults [data-result="0"]').click();
    await page.waitForFunction(() => document.querySelectorAll("#mpRuleEpisodes [data-play]").length === 2);
    await page.locator('#mpRuleEpisodes [data-play="0"]').click();
    await page.waitForFunction(() => document.querySelector("#offlineVideo").readyState >= 2 && (document.querySelector("#offlineVideo").currentSrc||"").includes("rule.m3u8"));
    assert.equal(await page.locator("video").evaluate(v => v.videoWidth),320);
    await page.screenshot({path:"C:/Users/han/AppData/Local/Temp/hb-shots/mobile-player.png"});

    // 15) 详情页悬浮「播放」：无线路的番自动按番名搜规则源并展开分集（Kazumi 式）
    await page.evaluate(() => window.HandbookMobile.handleBack());
    await page.locator(".back").click();
    await page.getByRole("button",{name:/无线路番剧/}).click();
    await page.locator(".play-fab").click();
    await page.locator("#rulesPage").waitFor();
    await page.waitForFunction(() => document.querySelector("#mpRuleQuery").value === "无线路番剧", null, {timeout:5000});
    await page.waitForFunction(() => document.querySelectorAll("#mpRuleEpisodes [data-play]").length === 2, null, {timeout:8000});
    assert.match(await page.locator("#mpRuleStatus").innerText(), /找到 2 集/, "分集应已自动展开");
    await page.locator('#mpRuleEpisodes [data-play="0"]').click();
    await page.waitForFunction(() => document.querySelector("#offlineVideo").readyState >= 2 && (document.querySelector("#offlineVideo").currentSrc||"").includes("rule.m3u8"));

    assert.deepEqual(errors,[]);
    console.log("Mobile browser: Kazumi-style controls, gestures, menu, drawer, Anime4K, danmaku, rules, auto-search play verified.");
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode=1; });
