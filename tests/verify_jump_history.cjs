const fs=require('fs'),assert=require('node:assert/strict');
const {chromium}=require('C:/Users/han/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const harness=[
  "const $=s=>document.querySelector(s);",
  "const $$=s=>[...document.querySelectorAll(s)];",
  "const state={settings:{}};",
  "const collectionEditingSupported=()=>window.editingSupported!==false;",
  "window.editingSupported=true;",
  "window.posts=[];",
  "window.rows=[];",
  "const api=async(path,options)=>{",
  "  if(options){posts.push(JSON.parse(options.body));return {ok:true,items:[]};}",
  "  return {items:window.rows};",
  "};",
  "window.confirm=()=>true;",
].join("\n");
(async()=>{const browser=await chromium.launch({headless:true});try{
const page=await browser.newPage({viewport:{width:1100,height:820}});
const html=fs.readFileSync('static/index.html','utf8').replace(/<script[\s\S]*?<\/script>/g,'').replace(/<link[^>]*>/g,'');
await page.setContent(`<style>${fs.readFileSync('static/styles.css','utf8')}</style>${html}`);
await page.addScriptTag({content:harness+"\n"+fs.readFileSync('static/modules/jump-history.js','utf8')});
// 记录一条跳转：直接 POST，带番剧名与类型。
await page.evaluate(()=>recordJump({anime_id:1,anime_name:'测试番剧',title:'某视频',url:'https://www.bilibili.com/video/BV1NJHG6eE9z/',kind:'video'}));
assert.deepEqual(await page.evaluate(()=>posts),[{anime_id:1,anime_name:'测试番剧',title:'某视频',url:'https://www.bilibili.com/video/BV1NJHG6eE9z/',kind:'video'}]);
// 打开记录：按 今天 / 昨天 / 更早 分组。
await page.evaluate(()=>{
  const local=(offsetDays,hour,minute)=>{
    const now=new Date();
    const value=new Date(now.getFullYear(),now.getMonth(),now.getDate()-offsetDays,hour,minute,0);
    const pad=n=>String(n).padStart(2,'0');
    return `${value.getFullYear()}-${pad(value.getMonth()+1)}-${pad(value.getDate())}T${pad(value.getHours())}:${pad(value.getMinutes())}:00`;
  };
  window.rows=[
    {id:4,title:'今天的链接',url:'https://example.com/a',kind:'link',host:'example.com',anime_name:'测试番剧',visited_at:local(0,9,5)},
    {id:3,title:'今天的视频',url:'https://www.bilibili.com/video/BV1NJHG6eE9z/',kind:'video',host:'bilibili.com',anime_name:'测试番剧',visited_at:local(0,8,40)},
    {id:2,title:'昨天的视频',url:'https://www.bilibili.com/video/BV1NJHG6eE11/',kind:'video',host:'bilibili.com',anime_name:'另一部',visited_at:local(1,21,10)},
    {id:1,title:'更早的链接',url:'https://old.example/x',kind:'link',host:'old.example',anime_name:'',visited_at:local(6,12,0)},
  ];
});
await page.locator('#jumpHistoryButton').click();
await page.waitForSelector('#jumpHistoryList .jump-row');
assert.equal(await page.locator('#jumpHistoryModal').evaluate(node=>node.open),true);
assert.deepEqual(await page.locator('.jump-day').allTextContents(),['今天','昨天','更早']);
assert.equal(await page.locator('.jump-row').count(),4);
assert.deepEqual(await page.locator('.jump-title').allTextContents(),['今天的链接','今天的视频','昨天的视频','更早的链接']);
assert.equal(await page.locator('.jump-row').first().getAttribute('href'),'https://example.com/a');
assert.equal(await page.locator('.jump-row').first().getAttribute('data-jump-kind'),'link');
assert.equal(await page.locator('.jump-row').nth(1).getAttribute('data-jump-kind'),'video');
assert.equal(await page.locator('.jump-meta').first().textContent(),'测试番剧 · example.com');
assert.match(await page.locator('#jumpHistoryStatus').textContent(),/共 4 条/);
// 清空记录
await page.locator('#clearJumpHistory').click();
await page.waitForFunction(()=>document.querySelectorAll('#jumpHistoryList .jump-row').length===0);
assert.deepEqual(await page.evaluate(()=>posts.at(-1)),{action:'clear'});
assert.match(await page.locator('#jumpHistoryStatus').textContent(),/已清空/);
assert.match(await page.locator('#jumpHistoryList').textContent(),/还没有跳转记录/);
await page.evaluate(()=>document.querySelector('#jumpHistoryModal').close());
// 只读/线上模式不显示入口
await page.evaluate(()=>{window.editingSupported=false;
  document.querySelector('#jumpHistoryButton').classList.remove('hidden');
  setupJumpHistory();
});
assert.equal(await page.locator('#jumpHistoryButton').evaluate(node=>node.classList.contains('hidden')),true);
console.log('Jump history: record POST, day grouping, kinds, clear and read-only entry hidden passed.');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exit(1)});
