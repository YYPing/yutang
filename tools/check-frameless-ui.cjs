/* 无边框改造的界面侧验收：
   ① Windows 下是否带上 platform-* 类名（拖动区留边靠它）；
   ② 自绘窗口条 .window-bar 是否真的渲染出来了；
   ③ 快捷键文案是否按平台显示（Windows 应为 "Ctrl + Shift + K"，不能是 ⌘）。
   连 CDP 读真实 DOM，顺带截一张图。 */
const PW = require('C:/Users/Y/.workbuddy/binaries/node/workspace/node_modules/playwright-core');
const PORT = process.argv[2] || '9223';

async function connect(tries = 10) {
  for (let i = 0; i < tries; i++) {
    try { return await PW.chromium.connectOverCDP('http://127.0.0.1:' + PORT); }
    catch { await new Promise(r => setTimeout(r, 2000)); }
  }
  throw new Error('连不上 CDP ' + PORT);
}

(async () => {
  const browser = await connect();
  const ctx = browser.contexts()[0];
  const pages = ctx ? ctx.pages() : [];
  const page = pages.find(p => /5188|浮生|pond/i.test(p.url())) || pages[0];
  if (!page) throw new Error('没有可用页面');
  await page.waitForTimeout(1200);

  let ok = true;

  const main = await page.evaluate(() => document.querySelector('main')?.className || '');
  console.log('main.className   =', main);
  const hasPlatform = /platform-win32/.test(main);
  console.log('  → platform-win32 类名:', hasPlatform ? '✔ 有' : '✘ 无');
  ok = ok && hasPlatform;

  const st = await page.evaluate(() => window.pondDesktop.getState());
  console.log('desktop          =', JSON.stringify({
    platform: st.platform, shortcut: st.shortcut, feedShortcut: st.feedShortcut,
    desktopSupported: st.desktopSupported, desktopMode: st.desktopMode,
  }));

  const bar = await page.evaluate(() => {
    const b = document.querySelector('.window-bar');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { h: Math.round(r.height), top: Math.round(r.top), visible: b.checkVisibility({ opacityProperty: true, visibilityProperty: true }) };
  });
  console.log('window-bar       =', JSON.stringify(bar), bar && bar.visible ? '✔ 自绘窗口条可见' : '✘ 未见');
  ok = ok && !!bar && bar.visible;

  const drag = await page.evaluate(() => {
    const d = document.querySelector('.window-drag');
    if (!d) return null;
    const cs = getComputedStyle(d); const r = d.getBoundingClientRect();
    return { marginLeft: cs.marginLeft, left: Math.round(r.left), width: Math.round(r.width) };
  });
  console.log('window-drag      =', JSON.stringify(drag));
  if (drag) {
    const nonMac = drag.marginLeft !== '85px';
    console.log('  → 拖动区左边距（Windows 应脱离 85px 红绿灯留白）:', nonMac ? '✔ ' + drag.marginLeft : '✘ 仍是 85px');
    ok = ok && nonMac;
  }

  // 打开设置面板读快捷键文案
  const setBtn = page.locator('button').filter({ hasText: /^设置$/ }).first();
  if (await setBtn.count()) { await setBtn.click({ timeout: 5000 }); await page.waitForTimeout(600); }
  const notes = await page.evaluate(() => [...document.querySelectorAll('.shortcut-note')].map(n => n.textContent.trim()));
  console.log('shortcut-note    =', JSON.stringify(notes));
  const joined = notes.join(' | ');
  const noCmd = !/⌘/.test(joined);
  console.log('  → 文案里没有 ⌘:', noCmd ? '✔' : '✘ 仍写死 ⌘');
  ok = ok && noCmd;

  await page.screenshot({ path: 'out/frameless-win.png' });
  console.log('已保存 out/frameless-win.png（窗口自身画面）');

  console.log('\n结果:', ok ? '✔ 界面侧全部通过' : '✘ 有项目未通过');
  await browser.close();
  setTimeout(() => process.reallyExit(ok ? 0 : 1), 200);
})().catch(e => { console.log('FAILED: ' + e.message); process.reallyExit(2); });
