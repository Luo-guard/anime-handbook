const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("C:/Users/han/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright");

// 设置页与规则页的独立回归：偏好是否真的落到本地、主题、弹幕参数、规则安装/停用/粘贴导入。
async function main() {
  const browser = await chromium.launch({ channel: "msedge" });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => {
      const anime = { id: 7, name_cn: "芙莉莲", collection_type: 1, active: 1,
        watched_episodes: "[]", episode_count: 3,
        episodes: JSON.stringify([{ key: "01", display_label: "01", type: 0 }]) };
      const snapshot = JSON.stringify({ tables: { anime: [anime], events: [], settings: [] } });
      window.AndroidHandbook = {
        state: () => snapshot, saveState: () => true, uiState: () => "{}", saveUiState: () => {},
        config: () => JSON.stringify({ url: "https://dav.jianguoyun.com/dav/", username: "demo", account: "", passwordSet: false, autoSync: true }),
        saveConfig: () => true,
        version: () => "1.0.21",
      };
      const rule = { name: "演示站", type: "anime", baseURL: "https://demo.test/",
        searchURL: "https://demo.test/search?wd=@keyword", searchList: "//div[@class='item']",
        searchName: ".//a", searchResult: ".//a", chapterRoads: "//ul", chapterResult: ".//a" };
      window.AndroidPlayer = {
        fetchText(id, url) {
          const reply = url.includes("api.github.com")
            ? JSON.stringify([{ name: "demo.json", download_url: "https://rules.test/demo.json", size: 640 }])
            : url.includes("demo.json") ? JSON.stringify(rule)
            : url.includes("demo.test/search") ? "<div class='item'><a href='https://demo.test/anime/1'>芙莉莲 第一季</a></div>"
            : url.includes("demo.test/anime/1") ? "<ul><li><a href='https://demo.test/play/1'>第 1 集</a></li></ul>"
            : url.includes("demo.test/play/1") ? "<script>var p={url:'https://video.test/rule.m3u8'};</script>"
            : null;
          setTimeout(() => window.HandbookRules?.fetchResult(id, reply, reply ? null : "no"), 10);
        },
        requestDanmaku(id) { setTimeout(() => window.HandbookPlayer?.danmakuResult(id, JSON.stringify({ comments: [] }), null), 10); },
      };
    });
    await page.route("http://mobile.test/**", route => {
      const name = new URL(route.request().url()).pathname.slice(1) || "index.html";
      const file = /^(modules|vendor)\//.test(name) ? "static/" + name : "android/app/src/main/assets/" + name;
      return fs.existsSync(file) ? route.fulfill({ path: file }) : route.fulfill({ status: 404, body: "" });
    });

    await page.goto("http://mobile.test/");
    assert.equal(await page.locator(".quick").count(), 2, "收藏页应有「本机视频」和「规则找片源」");

    // 1) 设置页：分组齐全，版本来自原生
    await page.locator('nav [data-page="settings"]').click();
    const text = await page.locator("#app").innerText();
    for (const group of ["播放", "弹幕", "外观", "规则", "坚果云同步", "关于"]) {
      assert.ok(text.includes(group), `设置页缺少「${group}」`);
    }
    assert.ok(text.includes("v1.0.21"), "设置页应显示版本号");

    // 2) 播放偏好落到 localStorage，播放器能读到
    await page.locator("#setSpeed").selectOption("1.5");
    await page.locator("#setSkip").selectOption("30");
    await page.locator("#setQuality").selectOption("fast");
    const prefs = await page.evaluate(() => JSON.parse(localStorage.getItem("mobile-player:prefs")));
    assert.equal(prefs.speed, 1.5);
    assert.equal(prefs.skip, 30);
    assert.equal(prefs.quality, "fast");
    await page.locator("#setAutoNext").uncheck();
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("mobile-player:prefs")).autoNext), false);

    // 3) 深色模式立刻生效
    await page.locator("#setTheme").selectOption("dark");
    assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
    const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const channels = (background.match(/\d+/g) || []).map(Number);
    assert.ok(channels.length >= 3 && channels[0] + channels[1] + channels[2] < 120, `深色背景应是深色，实际 ${background}`);
    await page.locator("#setTheme").selectOption("light");
    assert.equal(await page.locator("html").getAttribute("data-theme"), "light");

    // 4) 弹幕参数写入与播放器共用的键
    await page.locator("#setDmFont").evaluate(node => { node.value = 32; node.dispatchEvent(new Event("input", { bubbles: true })); node.dispatchEvent(new Event("change", { bubbles: true })); });
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("handbook.danmaku.settings")).fontSize), 32);
    assert.equal(await page.locator("#setDmFontValue").innerText(), "32");
    await page.screenshot({ path: "C:/Users/han/AppData/Local/Temp/hb-shots/android-settings.png", fullPage: true });

    // 5) 设置里进规则页，返回仍停在设置
    await page.locator(".setting-row.link").click();
    await page.locator("#rulesPage").waitFor();
    assert.match(await page.locator("#mpRuleSummary").innerText(), /还没有安装规则|已安装/);
    await page.locator("#mpRuleBack").click();
    assert.equal(await page.locator("#rulesPage").isVisible(), false);
    assert.ok((await page.locator("#app").innerText()).includes("坚果云同步"), "返回后应回到设置页");

    // 6) 规则仓库：装一条 → 已安装里能停用/启用
    await page.locator('nav [data-page="rules"]').click();
    await page.locator('[data-rule-tab="repo"]').click();
    await page.locator("#mpRuleRefresh").click();
    await page.waitForFunction(() => document.querySelectorAll("#mpRuleRepo [data-install]").length === 1);
    await page.locator("#mpRuleRepo [data-install]").click();
    await page.waitForFunction(() => document.querySelectorAll("#mpRuleInstalled [data-toggle]").length === 1);
    await page.locator('[data-rule-tab="installed"]').click();
    assert.ok((await page.locator("#mpRuleInstalled").innerText()).includes("演示站"));
    await page.locator("#mpRuleInstalled [data-toggle]").uncheck();
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("mobile-player:rules"))[0].enabled), false);
    await page.locator("#mpRuleInstalled [data-toggle]").check();
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("mobile-player:rules"))[0].enabled), true);

    // 7) 粘贴 JSON 导入
    await page.locator("#mpRulePasteImport").click();
    await page.locator("#rulePasteText").fill(JSON.stringify({ name: "粘贴站", baseURL: "https://paste.test/", searchURL: "https://paste.test/s?q=@keyword", searchList: "//li", searchName: ".//a", searchResult: ".//a" }));
    await page.locator('#rulePasteDialog button[value="save"]').click();
    await page.waitForFunction(() => document.querySelectorAll("#mpRuleInstalled [data-toggle]").length === 2);
    assert.ok((await page.locator("#mpRuleInstalled").innerText()).includes("粘贴站"));
    await page.screenshot({ path: "C:/Users/han/AppData/Local/Temp/hb-shots/android-rules.png" });

    // 8) 找片源：搜索 → 分集（站点返回由 mock 提供）
    await page.locator('[data-rule-tab="find"]').click();
    await page.locator("#mpRulePick").selectOption("演示站");
    await page.locator("#mpRuleQuery").fill("芙莉莲");
    await page.locator("#mpRuleFindForm button").click();
    await page.waitForFunction(() => document.querySelectorAll("#mpRuleResults [data-result]").length === 1);
    assert.match(await page.locator("#mpRuleStatus").innerText(), /找到 1 个条目/);
    await page.locator('#mpRuleResults [data-result="0"]').click();
    await page.waitForFunction(() => document.querySelectorAll("#mpRuleEpisodes [data-play]").length === 1);
    await page.locator('#mpRuleEpisodes [data-play="0"]').click();
    await page.waitForFunction(() => !document.querySelector("#rulesPage").hidden === false);
    await page.waitForFunction(() => document.querySelector("#offlineVideo").currentSrc.includes("rule.m3u8"));
    assert.equal(await page.locator("#mobilePlayer").isVisible(), true, "从规则页应能直接起播");
    assert.match(await page.locator("#mpTitle").innerText(), /芙莉莲/);

    assert.deepEqual(errors, []);
    console.log("Android pages passed: settings groups/version, player prefs, theme, danmaku prefs, rules install/toggle/paste/search feedback");
  } finally {
    await browser.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
