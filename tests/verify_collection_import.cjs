const fs=require('fs'),assert=require('node:assert/strict');
const zlib=require('node:zlib');

// 手搓一个最小 xlsx（zip + xml）：store 与 deflate 两种压缩都覆盖。
// 解析器不校验 CRC，这里写 0 即可。
function zipEntry(name, data, deflate) {
  const nameBuf = Buffer.from(name, 'utf8');
  const payload = deflate ? zlib.deflateRawSync(data) : data;
  const local = Buffer.alloc(30 + nameBuf.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(deflate ? 8 : 0, 8);
  local.writeUInt32LE(payload.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  nameBuf.copy(local, 30);
  return { local, payload, nameBuf, method: deflate ? 8 : 0 };
}

function buildXlsx(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    locals.push(entry.local, entry.payload);
    const cd = Buffer.alloc(46 + entry.nameBuf.length);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(entry.method, 10);
    cd.writeUInt32LE(entry.payload.length, 20);
    cd.writeUInt32LE(entry.local.readUInt32LE(22), 24);
    cd.writeUInt16LE(entry.nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    entry.nameBuf.copy(cd, 46);
    centrals.push(cd);
    offset += entry.local.length + entry.payload.length;
  }
  const cdBuffer = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cdBuffer, eocd]);
}

function makeXlsx(names, { deflate = false } = {}) {
  const shared = `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${names.map((name) => `<si><t>${name}</t></si>`).join('')}</sst>`;
  const rows = names.map((_, index) => `<row r="${index + 1}"><c r="A${index + 1}" t="s"><v>${index}</v></c></row>`).join('');
  const sheet = `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`;
  return buildXlsx([
    zipEntry('xl/sharedStrings.xml', Buffer.from(shared, 'utf8'), deflate),
    zipEntry('xl/worksheets/sheet1.xml', Buffer.from(sheet, 'utf8'), deflate),
  ]);
}

// inlineStr 版本：第一列留空，番名写在 B 列。
function makeXlsxInline(rows) {
  const xml = rows.map((cols, r) => `<row r="${r + 1}">${cols.map((text, c) => text ? `<c r="${String.fromCharCode(65 + c)}${r + 1}" t="inlineStr"><is><t>${text}</t></is></c>` : '').join('')}</row>`).join('');
  const sheet = `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${xml}</sheetData></worksheet>`;
  return buildXlsx([zipEntry('xl/worksheets/sheet1.xml', Buffer.from(sheet, 'utf8'), false)]);
}

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const {chromium}=require('C:/Users/han/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const harness=[
  "const $=s=>document.querySelector(s);",
  "const $$=s=>[...document.querySelectorAll(s)];",
  "const state={animes:[],settings:{}};",
  "const CATEGORIES=[{id:1,name:'在看'},{id:2,name:'想看'},{id:3,name:'搁置'}];",
  "const escapeHtml=s=>String(s);",
  "function renderCollection(){}",
  "function commitAnimes(animes,options={}){if(!Array.isArray(animes))return state.animes;state.animes=[...animes];if(options.render!==false&&typeof renderCollection==='function')renderCollection();return state.animes;}",
  "function renderTabs(){}",
  "function renderStats(){}",
  "function toast(){}",
  "function booleanSetting(key,fallback=false){const v=state.settings?.[key];return typeof v==='boolean'?v:fallback;}",
  "function enabledSetting(key){return booleanSetting(key,true);}",
  "window.requests=[];",
  "window.queries=[];",
  "async function api(path,options){",
  "  if(options){const body=JSON.parse(options.body);requests.push(body);return {animes:[],anime:{id:body.anime_id,collection_type:body.status}};}",
  "  const rawQ=decodeURIComponent((/[?&]q=([^&]*)/.exec(path)||[])[1]||'');",
  "  const q=rawQ.replace(/^\"|\"$/g,'');queries.push(rawQ);",
  "  return {items:[{id:q==='葬送的芙莉莲'?100:200,name:'原名',name_cn:q,type:2,date:'2023-10-01',eps:12,rating:{score:8.1,total:900},images:{}}]};",
  "}"
].join("\n");
(async()=>{const browser=await chromium.launch({headless:true});try{
const page=await browser.newPage({viewport:{width:1100,height:820}});
await page.setContent(fs.readFileSync('static/index.html','utf8').replace(/<script[\s\S]*?<\/script>/g,'').replace(/<link[^>]*>/g,''));
await page.addScriptTag({content:harness+"\n"+fs.readFileSync('static/modules/toolbar-buttons.js','utf8')+"\n"+fs.readFileSync('static/modules/collection-edit.js','utf8')+"\n"+fs.readFileSync('static/modules/collection-import.js','utf8')});
// Parsers: plain lines, CSV with header, Excel-style tab paste, JSON objects.
assert.deepEqual(await page.evaluate(()=>parseImportText('葬送的芙莉莲\n药屋少女的呢喃\n\n葬送的芙莉莲')),['葬送的芙莉莲','药屋少女的呢喃']);
assert.deepEqual(await page.evaluate(()=>parseImportText('番剧,状态\n葬送的芙莉莲,看过\n药屋少女的呢喃,在看')),['葬送的芙莉莲','药屋少女的呢喃']);
assert.deepEqual(await page.evaluate(()=>parseImportText('葬送的芙莉莲\t1\n药屋少女的呢喃\t2')),['葬送的芙莉莲','药屋少女的呢喃']);
assert.deepEqual(await page.evaluate(()=>parseImportText('[{"name":"葬送的芙莉莲"},{"title":"药屋少女的呢喃"},"进击的巨人"]')),['葬送的芙莉莲','药屋少女的呢喃','进击的巨人']);
// Large lists are capped at 2000 entries instead of the old 300.
const capped=await page.evaluate(()=>{const lines=Array.from({length:2500},(_,i)=>'番剧'+i).join('\n');return parseImportText(lines).length;});
assert.equal(capped,2000);
// Flow
// 批量搜索 lives inside the search dialog now.
await page.locator('#collectionSearchButton').click({force:true});
await page.locator('#collectionImportButton').click({force:true});
// Excel(.xlsx)：zip 里的 deflate 与 store 两种压缩都要能读，读到的名称进文本框可继续编辑。
for (const [label, deflate] of [['store', false], ['deflate', true]]) {
  await page.locator('#importFile').setInputFiles({name:`list-${label}.xlsx`,mimeType:XLSX_MIME,buffer:makeXlsx(['番剧','葬送的芙莉莲','药屋少女的呢喃'],{deflate})});
  await page.waitForFunction(()=>document.querySelector('#importPaste').value.includes('药屋少女的呢喃'));
  assert.deepEqual((await page.inputValue('#importPaste')).split('\n'),['番剧','葬送的芙莉莲','药屋少女的呢喃'],`${label} xlsx rows`);
  assert.match(await page.locator('#importStatus').textContent(),/读取 3 条/);
}
assert.deepEqual(await page.evaluate(()=>parseImportText(document.querySelector('#importPaste').value)),['葬送的芙莉莲','药屋少女的呢喃'],'xlsx header row is dropped by the normal parser');
// 第一列空、番名在 B 列，且单元格是 inlineStr（没有 sharedStrings.xml）时也要读对。
await page.locator('#importFile').setInputFiles({name:'inline.xlsx',mimeType:XLSX_MIME,buffer:makeXlsxInline([['','葬送的芙莉莲'],['','药屋少女的呢喃']])});
await page.waitForFunction(()=>document.querySelector('#importPaste').value.includes('药屋少女的呢喃'));
assert.deepEqual((await page.inputValue('#importPaste')).split('\n'),['葬送的芙莉莲','药屋少女的呢喃'],'inline strings and a blank first column');
// Excel 的一行就是一整条番名：名称里的中文逗号不能被 CSV 规则截断。
await page.locator('#importFile').setInputFiles({name:'comma.xlsx',mimeType:XLSX_MIME,buffer:makeXlsx(['就算是哥哥，有爱就没问题了，对吧','葬送的芙莉莲'])});
await page.waitForFunction(()=>document.querySelector('#importPaste').value.includes('就算是哥哥'));
await page.locator('#importParse').click();
await page.waitForTimeout(200);
assert.equal(await page.locator('#importCount').textContent(),'1 / 2');
assert.equal(await page.locator('#importName').inputValue(),'就算是哥哥，有爱就没问题了，对吧','commas inside an xlsx name stay intact');
// 关闭后重新打开，回到初始步骤继续后面的 CSV 流程。
await page.locator('#collectionImportClose').click();
await page.waitForTimeout(250);
await page.locator('#collectionSearchButton').click();
await page.waitForTimeout(400);
await page.locator('#collectionImportButton').click();
await page.waitForTimeout(300);
// 前面的 Excel 用例已经发过搜索，这里清空后再断言 CSV 的首次查询。
await page.evaluate(()=>{window.queries=[];});
// 旧格式 .xls 明确拒绝，并指向另存为。
await page.locator('#importFile').setInputFiles({name:'old.xls',mimeType:'application/vnd.ms-excel',buffer:Buffer.from('x')});
await page.waitForFunction(()=>/xlsx/.test(document.querySelector('#importStatus').textContent));
assert.match(await page.locator('#importStatus').textContent(),/另存为/);

// A picked file lands in the textarea, so the user can still edit it before importing.
await page.locator('#importFile').setInputFiles({name:'list.csv',mimeType:'text/csv',buffer:Buffer.from('番剧,状态\n葬送的芙莉莲,看过','utf8')});
await page.waitForFunction(()=>document.querySelector('#importPaste').value.includes('葬送的芙莉莲'));
assert.match(await page.locator('#importStatus').textContent(),/list\.csv/);
await page.locator('#importPaste').fill('葬送的芙莉莲\n药屋少女的呢喃');
await page.locator('#importParse').click();
const work=page.locator('#importWork');
assert.equal(await work.evaluate(node=>node.classList.contains('hidden')),false);
assert.equal(await page.locator('#importCount').textContent(),'1 / 2');
assert.equal(await page.locator('#importName').inputValue(),'葬送的芙莉莲');
await page.waitForSelector('#importResults .collect-result-title');
assert.equal(await page.locator('#importResults .collect-result-title').textContent(),'葬送的芙莉莲');
// The import search asks Bangumi for the exact phrase first (quoted keyword).
assert.deepEqual(await page.evaluate(()=>queries.slice(0,1)),['"葬送的芙莉莲"']);
assert.match(await page.locator('#importSearched').textContent(),/完整标题匹配/);
// 下一条 / 上一条 switch the entry and re-search
await page.locator('#importNext').click();
await page.waitForFunction(()=>document.querySelector('#importName').value==='药屋少女的呢喃');
assert.equal(await page.locator('#importCount').textContent(),'2 / 2');
assert.equal(await page.locator('#importNext').isDisabled(),true);
await page.locator('#importPrev').click();
await page.waitForFunction(()=>document.querySelector('#importName').value==='葬送的芙莉莲');
assert.equal(await page.locator('#importPrev').isDisabled(),true);
// Adding through the card advances to the next entry automatically
await page.locator('#importResults [data-collect-trigger]').first().click();
await page.locator('.collect-menu [data-collect-value="1"]').click();
await page.waitForFunction(()=>document.querySelector('#importName').value==='药屋少女的呢喃');
assert.deepEqual(await page.evaluate(()=>requests),[{anime_id:100,status:1}]);
assert.match(await page.locator('#importProgress').textContent(),/已添加 1 条/);
// Skip marks the entry
await page.locator('#importSkip').click();
assert.match(await page.locator('#importProgress').textContent(),/已跳过 1 条/);
assert.match(await page.locator('#importProgress').textContent(),/全部处理完成/);
// Cached results are not re-fetched when going back
const before=await page.evaluate(()=>queries.length);
await page.locator('#importPrev').click();
await page.waitForTimeout(200);
assert.equal(await page.evaluate(()=>queries.length),before,'cached entry must not search again');
console.log('Batch import: list parsing (txt/csv/tsv/json/xlsx incl. deflate+store+inline strings), 2000-entry cap, entry switching, auto-advance after adding, skip and cache passed.');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exit(1)});
