// 主题方案：卡片即时切换、独立编辑面板、取消回滚、背景延迟上传、删除与同名保护。
const fs = require('fs');
const http = require('http');
const path = require('path');
const assert = require('node:assert/strict');
const { chromium } = require('C:/Users/han/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

const ROOT = path.resolve('static');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

const SETTINGS = {
  theme_profiles: [
    { id: 'default', name: 'v家', theme_color: 'slate', custom_theme_color: '#F5C1CA', custom_background_enabled: false, custom_background_version: 0, custom_background_overlay_opacity: 0 },
    { id: 'night', name: '夜间深色', theme_color: 'indigo', custom_theme_color: '#5269B6', custom_background_enabled: false, custom_background_version: 0, custom_background_overlay_opacity: 78 },
  ],
  active_theme_profile: 'default',
  theme_color: 'slate',
  custom_theme_color: '#F5C1CA',
  custom_background_enabled: false,
  custom_background_version: 0,
  custom_background_overlay_opacity: 0,
  theme_random_on_open: false,
  sidebar_order: ['collection', 'schedule', 'timeline', 'statistics', 'ranking', 'settings'],
  sidebar_visibility: {},
};
const BOOT = {
  settings: SETTINGS,
  active_profile: { id: 'local', name: '本机' },
  animes: [],
  custom_collections: [],
  ranking_boards: [],
  ranking_templates: [],
  stats: {},
  sync: { running: false },
  revision: 1,
};
const patches = [];
const uploads = [];
const deletes = [];
let failSettings = false;

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://x').pathname;
  const send = (code, body, type = 'application/json') => {
    res.writeHead(code, { 'Content-Type': type });
    res.end(Buffer.isBuffer(body) || typeof body === 'string' ? body : JSON.stringify(body));
  };
  if (pathname === '/api/health') return send(200,{features:{schedule_sorting:2,keyboard_shortcuts:1,deferred_theme_background:1}});
  if (pathname === '/api/bootstrap') return send(200, BOOT);
  if (pathname === '/api/status') return send(200, { sync: { running: false }, stats: {}, revision: 1 });
  if (pathname === '/api/background' && req.method === 'GET') return send(200, PNG, 'image/png');
  if (pathname === '/api/background' && req.method === 'DELETE') {
    deletes.push(new URL(req.url, 'http://x').search);
    return send(200, { ok: true, removed: 1 });
  }
  if (pathname === '/api/background' && req.method === 'POST') {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      uploads.push({ profile_id: body.profile_id, bytes: String(body.data || '').length });
      if(!body.defer_settings){SETTINGS.custom_background_enabled=true;SETTINGS.custom_background_version=12345;}
      send(200, { ok: true, version:12345,settings: SETTINGS });
    });
    return;
  }
  if (pathname === '/api/settings' && req.method === 'PATCH') {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const patch = JSON.parse(raw || '{}');
      if(failSettings)return send(503,{error:"fixture save failed"});
      patches.push(patch);
      Object.assign(SETTINGS, patch);
      send(200, { ok: true, settings: SETTINGS });
    });
    return;
  }
  if (pathname.startsWith('/api/')) return send(200, { ok: true, items: [] });
  const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).slice(1);
  const full = path.join(ROOT, relative);
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return send(404, 'not found', 'text/plain');
  return send(200, fs.readFileSync(full), MIME[path.extname(full)] || 'application/octet-stream');
});

(async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${server.address().port}`,browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base);await page.waitForSelector('#settingsButton');
  await page.click('#settingsButton');await page.waitForSelector('#settingsModal[open]');
  assert.equal(await page.locator('.main-settings-section').count(),0);
  assert.deepEqual((await page.locator('.settings-subsection-title').allTextContents()).slice(0,4),['主题外观','主题自动切换','侧边栏与页面','启动与后台']);
  assert.equal(await page.locator('#themePagePreview').isVisible(),false);
  await page.click('[data-theme-pick="night"]');
  assert.equal(SETTINGS.active_theme_profile,'default');assert.equal(patches.length,0);
  assert.equal(await page.evaluate(()=>state.settings.active_theme_profile),'night');
  assert(await page.locator('#themePreviewStatus').isVisible());
  await page.click('#themePagePreview');await page.waitForSelector('#settingsModal:not([open])',{state:'attached'});
  assert(await page.locator('#themePagePreviewBar').isVisible());
  await page.click('#themePreviewReturn');assert(await page.locator('#settingsModal').isVisible());
  await page.click('#settingsModal .modal-close');await page.waitForTimeout(80);
  assert.equal(await page.evaluate(()=>state.settings.active_theme_profile),'default');
  assert.equal(patches.length,0);
  // Editor applies to the settings draft only, including background files.
  await page.click('#settingsButton');await page.click('[data-theme-edit="default"]');
  await page.locator('#customBackgroundInput').setInputFiles({name:'preview.png',mimeType:'image/png',buffer:PNG});
  await page.locator('#customBackgroundOpacityInput').evaluate(e=>e.value='35');await page.locator('#customBackgroundOpacityInput').dispatchEvent('input');
  await page.click('#themeEditorSave');await page.waitForSelector('#themeEditorModal:not([open])',{state:'attached'});
  assert.equal(uploads.length,0);assert.equal(patches.length,0);
  assert(await page.evaluate(()=>window.handbookThemePreview.backgroundUrl.startsWith('data:')));
  // Failed final save cannot change the saved theme or its image path.
  failSettings=true;await page.click('#saveSettings');await page.waitForFunction(()=>!document.querySelector('#saveSettings').disabled);
  assert.equal(uploads.length,1);assert.notEqual(uploads[0].profile_id,'default');
  assert.equal(SETTINGS.custom_background_enabled,false);assert.equal(SETTINGS.active_theme_profile,'default');
  assert(await page.locator('#settingsModal').isVisible());
  await page.click('#settingsModal .modal-close');await page.waitForTimeout(80);
  assert.equal(await page.evaluate(()=>state.settings.custom_background_enabled),false);
  // Selection and automatic switching commit together through the outer save.
  failSettings=false;await page.click('#settingsButton');await page.click('[data-theme-pick="night"]');
  await page.locator('#themeRandomOnOpenInput').evaluate(e=>{e.checked=true;e.dispatchEvent(new Event('change',{bubbles:true}))});
  assert.equal(SETTINGS.theme_random_on_open,false);assert.equal(patches.length,0);
  await page.click('#saveSettings');await page.waitForSelector('#settingsModal:not([open])',{state:'attached'});
  assert.equal(SETTINGS.active_theme_profile,'night');assert.equal(SETTINGS.theme_random_on_open,true);
  await page.reload();await page.waitForSelector('#settingsButton');assert.equal(await page.evaluate(()=>state.settings.active_theme_profile),'night');
  // A later staged image saves to a new identity, then survives reload.
  await page.click('#settingsButton');await page.click('[data-theme-edit="night"]');
  await page.locator('#customBackgroundInput').setInputFiles({name:'saved.png',mimeType:'image/png',buffer:PNG});
  await page.click('#themeEditorSave');await page.waitForSelector('#themeEditorModal:not([open])',{state:'attached'});
  await page.click('#saveSettings');await page.waitForSelector('#settingsModal:not([open])',{state:'attached'});
  assert.notEqual(SETTINGS.active_theme_profile,'night');assert.equal(SETTINGS.custom_background_enabled,true);
  assert(SETTINGS.theme_profiles.some(p=>p.id===SETTINGS.active_theme_profile&&p.custom_background_enabled));
  assert.equal(deletes.length,0);
  await page.reload();await page.click('#settingsButton');
  await page.screenshot({path:require('path').join(require('os').tmpdir(),'handbook-main-settings-preview.png')});
  await page.keyboard.press('Escape');await page.waitForTimeout(80);
  assert.equal(await page.evaluate(()=>ThemeSettingsSession.active),false);
  assert.deepEqual(errors,[]);
  console.log('Theme preview transaction passed: grouped layout, no writes before Save, preview return/cancel/Esc, editor files deferred, failed-save rollback, copy-on-write backgrounds, random setting and final-save reload persistence');
 }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(e=>{console.error(e);process.exitCode=1});
