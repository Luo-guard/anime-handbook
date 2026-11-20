const fs = require("node:fs");
const assert = require("node:assert/strict");
const { chromium } = require("C:/Users/han/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright");

async function main() {
  const browser = await chromium.launch();
  try {
    const fixtures = [
      ["qzone", "qz-poster", '<textarea placeholder="写说说"></textarea>'],
      ["bilibili", "bili-dyn-publishing", '<input class="bili-dyn-publishing__title__input" placeholder="好的标题更容易获得支持，选填20字"><div class="bili-rich-textarea__inner" contenteditable="true" placeholder="有什么想和大家分享的？">&#8203;</div>'],
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
    await page.setContent('<section class="bili-dyn-publishing"><input class="bili-dyn-publishing__title__input" value="我的标题"><div class="bili-rich-textarea__inner" contenteditable="true">&#8203;</div></section>');
    const bili = await page.evaluate(async () => {
      const draft = await interactWithShareEditor("bilibili","locate");
      document.querySelector("input").value = "";
      const body = document.querySelector("[contenteditable]");
      body.addEventListener("paste", event => {
        for (const image of event.clipboardData.files) {
          const thumb = document.createElement("span");
          thumb.className = "bili-pics-uploader__item__remove";
          thumb.textContent = image.name;
          body.parentElement.append(thumb);
        }
      });
      const fill = await interactWithShareEditor("bilibili","fill",{
        text:"这是正文",files:[{name:"截图.png",mime:"image/png",data:"AA=="}],
      });
      return {draft,fill,title:document.querySelector("input").value,body:body.innerText};
    });
    assert.deepEqual(bili,{draft:{editor:true,occupied:true,entry:false},fill:{ok:true,images:1},title:"",body:"这是正文"});
    await page.setContent('<section class="bili-dyn-publishing"><div class="bili-rich-textarea__inner" contenteditable="true">原来的正文</div><button type="button" class="bili-pics-uploader__add">＋</button><button type="button" class="publish">发布</button></section>');
    const detached = await page.evaluate(async () => {
      const add = document.querySelector(".bili-pics-uploader__add");
      const previousClick = HTMLInputElement.prototype.click;
      let published = 0;
      let uploaded = [];
      document.querySelector(".publish").onclick = () => published++;
      const input = document.createElement("input");
      input.type = "file";
      input.name = "upload";
      input.multiple = true;
      input.onchange = () => {
        uploaded = [...input.files].map(file=>file.name);
        for (const name of uploaded) {
          const preview = document.createElement("span");
          preview.className = "bili-pics-uploader__item__remove";
          preview.textContent = name;
          add.parentElement.append(preview);
        }
      };
      add.onclick = () => input.click();
      const matches = await interactWithShareEditor("bilibili","locate","原来的正文");
      const files = [{name:"截图.png",mime:"image/png",data:"AA=="},{name:"另一张.jpg",mime:"image/jpeg",data:"AA=="}];
      const mismatched = await fillBilibiliImagePicker(files,"另一篇正文");
      const count = await fillBilibiliImagePicker(files,"原来的正文");
      const repeat = await fillBilibiliImagePicker(files,"原来的正文");
      return {matched:matches.sameText,mismatched,count,repeat,uploaded,published,restored:HTMLInputElement.prototype.click===previousClick};
    });
    assert.deepEqual(detached,{matched:true,mismatched:0,count:2,repeat:0,uploaded:["截图.png","另一张.jpg"],published:0,restored:true});
    console.log("All three adapter fixtures preserve multiline text, accept multiple images, and leave final submission to the user.");
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
