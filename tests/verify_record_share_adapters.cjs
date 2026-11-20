const fs = require("node:fs");
const assert = require("node:assert/strict");
const { chromium } = require("C:/Users/han/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright");

async function main() {
  const browser = await chromium.launch();
  try {
    const fixtures = [
      ["qzone", "qz-poster", '<textarea placeholder="写说说"></textarea>'],
      ["bilibili", "bili-dyn-publish", '<div contenteditable="true" data-placeholder="写动态"></div>'],
      ["heybox", "publish-editor", '<div contenteditable="true"><p data-placeholder="请输入正文"></p></div>'],
    ];
    const page = await browser.newPage();
    for (const [platform, root, editor] of fixtures) {
      await page.goto("about:blank");
      await page.setContent(`<form class="${root}">${editor}<input type="file" accept="image/*" multiple><button type="submit">发布</button></form>`);
      await page.addScriptTag({content:`
        const noop=()=>{};
        const chrome={runtime:{onMessage:{addListener:noop}},tabs:{onUpdated:{addListener:noop},onRemoved:{addListener:noop}}};
        ${fs.readFileSync("browser-extension/record-share.js","utf8")}
        let submitted=0, changed=0;
        document.querySelector("form").onsubmit=e=>{e.preventDefault();submitted++};
        document.querySelector("[type=file]").onchange=()=>changed++;
      `});
      const locate = () => page.evaluate(platform => interactWithShareEditor(platform, "locate"), platform);
      assert.deepEqual(await locate(), {editor:true, occupied:false, entry:false});
      const fill = () => page.evaluate(platform => interactWithShareEditor(platform, "fill", {
        text:"两行内容\n第二行",
        files:[{name:"1.png", mime:"image/png", data:"AA=="}, {name:"2.jpg", mime:"image/jpeg", data:"AA=="}],
      }), platform);
      assert.deepEqual(await fill(), {ok:true, images:2});
      assert.deepEqual(await fill(), {ok:false});
      const current = await page.evaluate(() => {
        const editor = document.querySelector("textarea,[contenteditable]");
        return {text:editor.value ?? editor.innerText, submitted, changed,
          files:[...document.querySelector("[type=file]").files].map(file => file.name)};
      });
      assert.deepEqual(current, {text:"两行内容\n第二行", submitted:0, changed:1, files:["1.png","2.jpg"]});
    }
    assert.equal(await page.evaluate(() => isShareTab("qzone", "https://qzone.qq.com.example.org/")), false);
    await page.setContent('<section class="qz-poster"><div contenteditable="true">说点儿什么吧</div><button type="button" aria-label="图片">图片</button></section>');
    await page.evaluate(() => {
      document.querySelector('[aria-label="图片"]').onclick = () => {
        const picker = document.createElement("input");
        picker.type = "file";
        picker.multiple = true;
        document.body.append(picker);
      };
    });
    const qzone = await page.evaluate(async () => {
      const before = await interactWithShareEditor("qzone", "locate");
      const result = await interactWithShareEditor("qzone", "fill", {
        text:"第一行\n\n第三行", files:[{name:"截图.jpg", mime:"image/jpeg", data:"AA=="}],
      });
      return {before, result, serialized:document.querySelector("[contenteditable]").innerHTML, uploaded:document.querySelector("[type=file]").files[0]?.name};
    });
    assert.deepEqual(qzone, {before:{editor:true,occupied:false,entry:false}, result:{ok:true,images:1}, serialized:"第一行\n\n第三行", uploaded:"截图.jpg"});
    await page.evaluate(() => document.querySelector("[contenteditable]").textContent = "说点儿什么吧，这是我自己的草稿。");
    assert.equal(await page.evaluate(async () => (await interactWithShareEditor("qzone", "locate")).occupied), true);
    console.log("All three adapter fixtures preserve multiline text, accept multiple images, and leave final submission to the user.");
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
