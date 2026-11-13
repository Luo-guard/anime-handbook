// 回归：设置弹窗及所有其它弹窗都不该出现横向滚动条。
// 曾经「番剧详情」/「周表」页签里动态生成的隐形开关 checkbox 被
// .detail-link-row input{width:100%} 撑成整个弹窗宽，又因 absolute 定位
// 叠加静态位置，硬生生撑出 689px 空白横向滚动区。
const fs = require('fs');
const assert = require('node:assert/strict');
const { chromium } = require('C:/Users/han/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

const html = fs.readFileSync('static/index.html', 'utf8');
const css = fs.readFileSync('static/styles.css', 'utf8');
const bare = html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<link[^>]*>/g, '');

// 模拟 settings.js 动态渲染的一行详情页链接：名称输入、网址输入、隐形开关。
const fakeRows = ['Bangumi #{id}', 'B站搜索', '已存视频', '更多站点 ▾'].map((name) => `
  <div class="detail-link-row">
    <input type="text" data-detail-link-name value="${name}" />
    <input type="text" data-detail-link-url value="https://example.com/{title}" />
    <div class="detail-link-order"><button type="button">↑</button><button type="button">↓</button></div>
    <label class="switch-row compact"><input type="checkbox" data-detail-link-enabled checked /><span class="switch"></span></label>
    <button type="button" class="secondary-button compact-button">删除</button>
  </div>`).join('');

(async () => {
  const browser = await chromium.launch({ headless: true });
  for (const viewport of [{ width: 1080, height: 720 }, { width: 1000, height: 600 }, { width: 430, height: 640 }, { width: 320, height: 480 }]) {
    const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
    await page.setContent(`<style>${css}</style>${bare}`);
    await page.evaluate((rows) => {
      const list = document.querySelector('#detailLinkList') || document.querySelector('.settings-list');
      list.insertAdjacentHTML('beforeend', rows);
      const dialog = document.querySelector('#settingsModal');
      dialog.showModal();
    }, fakeRows);

    const measured = await page.evaluate(() => {
      const dialog = document.querySelector('#settingsModal');
      const rect = dialog.getBoundingClientRect();
      const checks = [...dialog.querySelectorAll('[data-detail-link-enabled]')].map((input) => {
        const box = input.getBoundingClientRect();
        return {
          width: Math.round(box.width),
          height: Math.round(box.height),
          beyond: Math.round(box.right - (rect.left + dialog.clientWidth)),
        };
      });
      const textInput = dialog.querySelector('[data-detail-link-name]');
      return {
        overflow: dialog.scrollWidth - dialog.clientWidth,
        checks,
        textWidth: textInput ? Math.round(textInput.getBoundingClientRect().width) : 0,
      };
    });

    assert.equal(measured.overflow, 0, `设置弹窗 @${viewport.width}px 出现横向滚动条`);
    assert.equal(measured.checks.length, 4, '四行链接都有隐形开关');
    for (const check of measured.checks) {
      assert.ok(check.width <= 2 && check.height <= 2, `隐形 checkbox 尺寸异常 ${JSON.stringify(check)}`);
      assert.ok(check.beyond <= 0, `隐形 checkbox 超出弹窗右边界 ${JSON.stringify(check)}`);
    }
    assert.ok(measured.textWidth > 60, `名称输入框被误伤，宽度只有 ${measured.textWidth}px`);

    // 点击 label 仍能切换开关（隐形 checkbox 不能因为缩小而失去功能）
    const toggle = await page.evaluate(() => {
      const label = document.querySelector('#settingsModal .switch-row');
      const input = label.querySelector('input[type="checkbox"]');
      const before = input.checked;
      label.click();
      return before !== input.checked;
    });
    assert.ok(toggle, `@${viewport.width}px 开关点击后未切换`);

    // 其它弹窗逐个打开检查；窄视口下内容框写死 min(Npx,94vw) 曾多出 12px。
    const dialogs = await page.evaluate(() => {
      const rows = [];
      for (const dialog of document.querySelectorAll('dialog.modal')) {
        const wasOpen = dialog.open;
        try { if (!wasOpen) dialog.showModal(); } catch (_error) { continue; }
        rows.push({ id: dialog.id || '-', overflow: dialog.scrollWidth - dialog.clientWidth });
        try { if (!wasOpen) dialog.close(); } catch (_error) { /* ignore */ }
      }
      return rows;
    });
    for (const item of dialogs) {
      assert.equal(item.overflow, 0, `弹窗 ${item.id} @${viewport.width}px 横向溢出 ${item.overflow}px`);
    }
    console.log(`  ${viewport.width}x${viewport.height}: 设置弹窗 0px、${dialogs.length} 个弹窗全部 0px、开关可点击`);
    await page.close();
  }
  await browser.close();
  console.log('Settings dialogs: no horizontal scrollbar at 1080/1000/430/320px, hidden switches stay 1x1 and clickable.');
})().catch((error) => { console.error(error); process.exit(1); });
