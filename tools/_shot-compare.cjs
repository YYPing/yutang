/* 拍一张与设计图同条件的对比截图：夏季 · 白昼 · 晴天（设计图就是这个条件）。
 * 顺带拍一张「沉浸」的纯画面图，便于逐要素对比水面本身。
 *
 * 跑法：node tools/_shot-compare.cjs [PORT]
 */
const PW = require('C:/Users/Y/.workbuddy/binaries/node/workspace/node_modules/playwright-core');
const PORT = process.argv[2] || '9223';

(async () => {
  const browser = await PW.chromium.connectOverCDP('http://127.0.0.1:' + PORT);
  const page = browser.contexts()[0].pages()[0];
  await page.waitForTimeout(2000);

  // 记下原设置，截完恢复（别把用户的季节/昼夜改了）
  const original = await page.evaluate(() => localStorage.getItem('fusheng-settings'));
  console.log('原设置:', original);

  await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('fusheng-settings') || '{}');
    s.season = 'summer'; s.day = 'day'; s.weather = 'sunny';
    localStorage.setItem('fusheng-settings', JSON.stringify(s));
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(7000);

  const state = await page.evaluate(() => ({
    app: document.querySelector('.app')?.className,
    status: document.querySelector('.scene-status')?.textContent?.replace(/\s+/g, ' ').trim(),
  }));
  console.log('当前状态:', JSON.stringify(state));

  await page.screenshot({ path: 'out/compare-day-ui.png' });
  console.log('已保存 out/compare-day-ui.png');

  // 沉浸模式：隐去 UI，只看水面
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find(b => /沉浸/.test(b.textContent));
    if (btn) btn.click();
  });
  await page.waitForTimeout(3500);
  await page.screenshot({ path: 'out/compare-day-immersive.png' });
  console.log('已保存 out/compare-day-immersive.png');

  // 恢复
  await page.evaluate((v) => {
    if (v === null) localStorage.removeItem('fusheng-settings');
    else localStorage.setItem('fusheng-settings', v);
  }, original);
  console.log('已恢复原设置');

  await browser.close().catch(() => {});
})().catch(e => { console.error('异常：', e.message); process.exit(1); });
