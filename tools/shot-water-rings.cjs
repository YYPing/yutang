/* 真机截图：投喂感应圈 + 水面涟漪（俯视图正圆）。
 *
 * 自包含一次性：起窗口 → 点击投喂 → 按时间点截三张 → 收工。
 * ⚠️ CDP 是**附着**连接，核对完**不能**调 browser.close()（那会把应用一起关掉）。
 *
 * 跑法：node tools/shot-water-rings.cjs    （先 npm run build）
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const APP = path.join(__dirname, '..');
const PORT = Number(process.env.POND_DESKTOP_PORT || 4173);
const CDP_PORT = Number(process.env.POND_CDP_PORT || 9224);
const OUT = path.join(APP, 'out');
const PW = require('C:/Users/Y/.workbuddy/binaries/node/workspace/node_modules/playwright-core');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, args) => new Promise((res) => {
  const c = spawn(cmd, args, { cwd: APP });
  c.on('exit', (code) => res(code));
  c.on('error', () => res(null));
});
async function waitHttp(url, tries = 30) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.ok) return true; } catch {}
    await sleep(1000);
  }
  return false;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const launcher = spawn(process.execPath, [path.join(__dirname, 'launch-desktop.cjs')], {
    cwd: APP, stdio: ['ignore', 'pipe', 'pipe'],
  });
  launcher.stdout.on('data', () => {});
  launcher.stderr.on('data', () => {});
  let browser = null;
  try {
    if (!await waitHttp(`http://127.0.0.1:${PORT}/`)) throw new Error('站点没起来');
    if (!await waitHttp(`http://127.0.0.1:${CDP_PORT}/json/version`, 20)) throw new Error('CDP 没起来');
    browser = await PW.chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
    const page = browser.contexts()[0].pages().slice(-1)[0];
    await page.waitForTimeout(2500);

    const bundle = await page.evaluate(() => [...document.querySelectorAll('script[src]')].map((s) => s.src).join(' '));
    console.log('页面加载的产物:', bundle.replace(/^.*\//, '') || '(inline)');

    const box = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
    const cx = Math.round(box.w * 0.44), cy = Math.round(box.h * 0.52);
    console.log(`窗口 ${box.w}×${box.h} · 点击点 (${cx}, ${cy})`);

    await page.mouse.move(cx, cy);
    await page.waitForTimeout(120);
    await page.mouse.click(cx, cy);

    // ① 点击瞬间：虚线感应圈 + 起始脉冲
    await page.waitForTimeout(240);
    await page.screenshot({ path: path.join(OUT, 'water-rings-01-click.png') });
    await page.screenshot({ path: path.join(OUT, 'water-rings-02-circle-zoom.png'), clip: { x: cx - 400, y: cy - 400, width: 800, height: 800 } });

    // ② 涟漪扩散
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(OUT, 'water-rings-03-ripple-zoom.png'), clip: { x: cx - 160, y: cy - 160, width: 320, height: 320 } });

    // ③ 鱼群来吃：多处小涟漪
    await page.waitForTimeout(3500);
    await page.screenshot({ path: path.join(OUT, 'water-rings-04-fish-eat.png') });

    console.log('已写 out/water-rings-01-click.png / 02-circle-zoom.png / 03-ripple-zoom.png / 04-fish-eat.png');
  } catch (e) {
    console.log('✘', e.message);
  } finally {
    // ⚠️ 不调 browser.close()：那是 Browser.close，会把 Electron 一起关掉
    await run('taskkill', ['/PID', String(launcher.pid), '/T', '/F']);
  }
  process.exit(0);
})();
