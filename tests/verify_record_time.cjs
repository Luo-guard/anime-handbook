const fs = require('fs'), assert = require('node:assert/strict');
const {chromium} = require('C:/Users/han/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
(async () => {
  const browser = await chromium.launch({headless:true});
  try {
    const page = await browser.newPage();
    page.on('pageerror',error=>console.error('PAGE',error.message));
    await page.route('http://127.0.0.1:43127/record-time-test',route=>route.fulfill({body:'<!doctype html><html><body></body></html>',contentType:'text/html'}));
    await page.goto('http://127.0.0.1:43127/record-time-test');
    await page.setContent(`<style>${fs.readFileSync('static/styles.css','utf8')}</style><form id="editor"><textarea>draft</textarea><button type="submit">保存</button></form>`);
    const source = fs.readFileSync('static/modules/records.js','utf8').split('function fitRecordEditor')[0];
    await page.addScriptTag({content:`const state={active_profile:{id:'test'}}; const calls=[]; async function api(url,options){calls.push(JSON.parse(options.body));} ${source}`});
    for (const width of [390,1000]) {
      await page.setViewportSize({width,height:800});
      for (const mode of ['keep','now','copy']) {
        await page.evaluate(() => {window.result=undefined;chooseRecordTimeMode().then(value=>window.result=value);});
        assert(await page.locator('input[value="keep"]').isChecked());
        await page.locator(`input[value="${mode}"]`).check();
        assert(await page.locator('.record-time-modal').evaluate(el=>el.getBoundingClientRect().width<=innerWidth));
        await page.getByRole('button',{name:'确认保存'}).click();
        await page.waitForFunction(()=>window.result !== undefined);
        assert.equal(await page.evaluate(()=>window.result),mode);
      }
    }
    await page.evaluate(()=>{window.result=undefined;saveEditedRecord(document.querySelector('#editor'),1,{content:'draft'}).then(value=>window.result=value);});
    await page.keyboard.press('Escape');
    await page.waitForFunction(()=>window.result !== undefined);
    assert.equal(await page.evaluate(()=>window.result),false);
    assert.equal(await page.locator('textarea').inputValue(),'draft');
    await page.evaluate(()=>{window.result=undefined;saveEditedRecord(document.querySelector('#editor'),1,{content:'draft'}).then(value=>window.result=value);saveEditedRecord(document.querySelector('#editor'),1,{content:'draft'});});
    await page.locator('input[value="copy"]').check();
    await page.getByRole('button',{name:'确认保存'}).click();
    await page.waitForFunction(()=>window.result !== undefined);
    assert.deepEqual(await page.evaluate(()=>calls.map(x=>x.time_mode)),['copy']);
    assert.equal(await page.evaluate(()=>window.result),true);
    assert.equal(await page.locator('#editor button').isDisabled(),false);
    console.log('Record save choices: modes, default, Escape/draft, responsive layout and duplicate-submit guard passed.');
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
