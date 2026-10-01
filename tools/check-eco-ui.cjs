/* 在真实 Electron 窗口里打开「生态模式」，验证界面侧接线 + 截一张图。
   连 CDP 操作真实 DOM：点设置 → 开生态模式 → 读 .eco-status → 截图。 */
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

  // 打开设置面板
  const setBtn = page.locator('button').filter({ hasText: /^设置$/ }).first();
  if (!(await setBtn.count())) throw new Error('找不到设置按钮');
  await setBtn.click({ timeout: 5000 });
  await page.waitForTimeout(600);

  const rows = await page.evaluate(() =>
    [...document.querySelectorAll('.toggle-row')].map(r => (r.querySelector('strong')?.textContent || '').trim()));
  console.log('设置面板开关:', JSON.stringify(rows));
  const hasEco = rows.includes('生态模式');
  console.log('  → 有「生态模式」开关:', hasEco ? '✔' : '✘');
  ok = ok && hasEco;

  // 勾上生态模式（input 是 opacity:0 的，用 click 触发 React onChange）。
  // 幂等：设置已经持久化到 localStorage，重跑时它可能已经是开着的 —— 只在该关才点。
  const toggled = await page.evaluate(() => {
    const row = [...document.querySelectorAll('.toggle-row')].find(r => (r.querySelector('strong')?.textContent || '').trim() === '生态模式');
    if (!row) return false;
    const input = row.querySelector('input');
    if (!input.checked) { input.click(); return true; }
    return false;
  });
  console.log('  本次是否执行了开启动作:', toggled ? '是' : '否（已是开启状态）');
  await page.waitForTimeout(2000);   // 等引擎 updateOptions → initEco → 状态每秒刷新

  const status = await page.evaluate(() => {
    const el = document.querySelector('.eco-status');
    return el ? el.textContent.replace(/\s+/g, ' ').trim() : null;
  });
  console.log('生态状态栏:', status ? JSON.stringify(status) : '（未出现）');
  const statusOk = !!status && /代/.test(status) && /存活/.test(status);
  console.log('  → 状态栏渲染:', statusOk ? '✔' : '✘');
  ok = ok && statusOk;

  const label = await page.evaluate(() => {
    const row = [...document.querySelectorAll('.range-row')].map(r => (r.querySelector('span')?.textContent || '').trim());
    return row;
  });
  console.log('滑杆标签:', JSON.stringify(label));
  const renamed = label.some(t => t.startsWith('重置种群'));
  console.log('  → fishCount 语义已改为「重置种群」:', renamed ? '✔' : '✘');
  ok = ok && renamed;

  await page.screenshot({ path: 'out/eco-mode-panel.png' });
  console.log('已保存 out/eco-mode-panel.png');

  // 关掉面板，核对左下角场景状态 → 拍一张池塘全景
  await page.keyboard.press('Escape');
  await page.waitForTimeout(2000);
  const scene = await page.evaluate(() => document.querySelector('.scene-status')?.textContent.replace(/\s+/g, ' ').trim() || '');
  console.log('左下角状态:', JSON.stringify(scene));
  const sceneOk = /第 1 代/.test(scene) && /8 尾锦鲤/.test(scene);
  console.log('  → 显示真实存活数（非滑杆值）:', sceneOk ? '✔' : '✘');
  ok = ok && sceneOk;

  await page.screenshot({ path: 'out/eco-mode-pond.png' });
  console.log('已保存 out/eco-mode-pond.png（池塘全景，8 条梯队鱼）');

  console.log('\n结果:', ok ? '✔ 生态模式界面侧通过' : '✘ 有项目未通过');
  await browser.close();
  setTimeout(() => process.reallyExit(ok ? 0 : 1), 200);
})().catch(e => { console.log('FAILED: ' + e.message); process.reallyExit(2); });
