const fs=require('node:fs'),assert=require('node:assert/strict');
const {chromium}=require('C:/Users/han/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
(async()=>{const browser=await chromium.launch({headless:true});try{
 const page=await browser.newPage();
 const html=fs.readFileSync('static/index.html','utf8').replace(/<script[\s\S]*?<\/script>/g,'').replace(/<link[^>]*>/g,'');
 await page.setContent(`<style>${fs.readFileSync('static/styles.css','utf8')}</style>${html}`);
 await page.evaluate(()=>{const spacer=document.createElement('div');spacer.style.height='5000px';document.querySelector('.settings-list').append(spacer);document.querySelector('#settingsModal').showModal()});
 for(const [width,height] of [[1920,1080],[1100,700],[390,844],[320,640]]){
  await page.setViewportSize({width,height});
  for(const preview of [false,true]){
   await page.evaluate(enabled=>{document.querySelector('#themePreviewStatus').hidden=!enabled;document.querySelector('#themePagePreview').hidden=!enabled},preview);
   let initial;
   for(const fraction of [0,.5,1]){
    await page.evaluate(f=>{const modal=document.querySelector('#settingsModal');modal.scrollTop=f*(modal.scrollHeight-modal.clientHeight)},fraction);
    const box=await page.locator('#saveSettings').evaluate(button=>{
     const b=button.getBoundingClientRect(),m=document.querySelector('#settingsModal').getBoundingClientRect();
     const hit=document.elementFromPoint(b.x+b.width/2,b.y+b.height/2);
     return {top:b.top,right:b.right,bottom:b.bottom,inside:b.left>=m.left&&b.right<=m.right&&b.top>=m.top&&b.bottom<=m.bottom,clickable:hit===button||button.contains(hit),dialogRight:m.right,dialogBottom:m.bottom};
    });
    assert(box.inside&&box.clickable,JSON.stringify({width,preview,fraction,...box}));
    if(!initial)initial=box;
    assert(Math.abs(box.bottom-initial.bottom)<2,JSON.stringify({width,preview,fraction,initial,box}));
    assert(box.dialogBottom-box.bottom<55,'save stays near dialog bottom');
   }
  }
 }
 console.log('Floating settings save passed: desktop/mobile, top/middle/bottom scrolling, preview controls and clickable button remain inside dialog');
}finally{await browser.close()}})().catch(e=>{console.error(e);process.exitCode=1});
