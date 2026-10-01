/* 拍一组「**有光柱 / 无光柱**」的实拍 A/B，用来判"阳光照耀"够不够亮。
 *
 * ── 为什么要专门做这个 ──────────────────────────────────────────────
 * `check-light-ui.cjs` 量的是**像素通道**（`.pond-canvas` 的 alpha），它证明了
 * 「亮带画在该在的位置、暗处是暗的」。但"够不够亮"是个**观感**问题，
 * 光看 ᾱ .118 这样的数字答不了 —— 必须把两帧摆在一起看。
 *
 * ── 两个坑，决定了这个脚本必须这么写 ──────────────────────────────
 * ① **同一会话、同一帧参数**。`light-01-pool-only.png` 与 `light-02-shaft.png`
 *    之间隔了好几次量测，鱼的位置、UI 文案都变了 ⇒ 直接相减会把鱼当成"光柱"。
 *    所以这里把鱼钉死、把 sim 冻住、把光柱的几何写死，只在两次 `render()` 之间切换。
 * ② **底图会动**。`.living-background`（WebGL 焦散）是 rAF 驱动的，两次 `page.screenshot()`
 *    之间它一定变了 —— 那是噪声不是信号。所以除了"带底图"的一组，再拍一组
 *    **把底图 `display:none`** 的：这一组里合成结果只有 2D 光照层，差分干净到可以直接当尺子。
 *
 * 用法：
 *   node tools/shot-sunlight-ab.cjs                 # 需要 5188 开着 dev server
 *   node tools/shot-sunlight-ab.cjs http://127.0.0.1:5200/
 * 产出：out/sun-ab.png（接触表）+ out/sun-ab-{A,B,A2,Bb,Ab}.png（单帧）
 */
const PW = require('C:/Users/Y/.workbuddy/binaries/node/workspace/node_modules/playwright-core');
const { join } = require('node:path');
const fs = require('node:fs');

const URL = process.argv[2] || 'http://127.0.0.1:5188/';
const OUT = join(__dirname, '..', 'out');
const EXE = 'C:/Users/Y/AppData/Local/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-win64/chrome-headless-shell.exe';

const SHAFT_U = 0.42;
const SHAFT_TILT = 0.42;

/** 页面内的最小工具集（只在 DEV 构建里有效，因为 `__pondEngine` 只在 DEV 挂出）。 */
function PAGE_TOOLS() {
  const e = () => window.__pondEngine;
  const freeze = () => {
    const p = e();
    p.light.shafts.length = 0;
    p.light.nextShaft = 1e9;
    p.light.update = () => {};
    p.sim.update = () => {};
    return p;
  };
  return {
    /** 布景：钉死几条鱼，并把它们摆到光柱带的内外两侧。 */
    stage(u, tilt) {
      const p = freeze();
      const W = p.width, H = p.height;
      const tan = Math.tan(tilt);
      const axisAt = (y) => u * W + tan * (y + 0.12 * H);
      // 三条鱼：两条落在带心附近、一条远在左侧暗处
      const spots = [
        [axisAt(H * 0.30), H * 0.30],
        [axisAt(H * 0.62), H * 0.62],
        [W * 0.14, H * 0.45],
      ];
      p.sim.fish.slice(0, 3).forEach((f, i) => {
        f.x = spots[i][0]; f.y = spots[i][1]; f.heading = 0;
        f.depth = 1; f.aFade = 1; f.aPale = 0; f.dying = 0;
        f.swimAmplitude = 0.072; f.variant = i === 2 ? 1 : 2;
      });
      p.render();
      return { width: W, height: H, axisAtMid: axisAt(H * 0.54), midY: H * 0.54, tan };
    },
    noShaft() { freeze(); e().light.shafts.length = 0; e().render(); return true; },
    /** 放一束"永生"的光柱，包络顶到 1（真实光柱只有 5.5–12s，这里为了拍照钉住）。 */
    withShaft(u, tilt) {
      const p = freeze();
      p.light.shafts.push({ u, tilt, width: 0.3, life: 1e9, seed: 1.2, age: 5e8, envelope: 1, lit: 1 });
      p.render();
      return true;
    },
    setQuality(q) { e().options.quality = q; e().render(); return q; },
    /**
     * 关/开 WebGL 底图 —— 关掉之后画面里只剩 2D 光照层，差分没有噪声。
     *
     * ⚠️ 必须用 `visibility`，**不能用 `display:none`**。踩过：
     *    `display:none` 会让这张画布退出布局，`.pond-canvas` 跟着重排 ⇒ 整个 2D 层
     *    换了个尺寸重画了一遍，差分里噪声均值直接冲到 **1.95 luma**（最大 168.8），
     *    比要量的光柱信号（3.7）还接近 —— 差点把它当成"信号太弱"的证据。
     *    `visibility:hidden` 保留占位、不改布局，2D 层一个像素都不动。
     */
    landscape(on) {
      const c = document.querySelector('.living-background');
      if (c) c.style.visibility = on ? '' : 'hidden';
      return Boolean(c);
    },
  };
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await PW.chromium.launch({ executablePath: EXE, args: ['--no-sandbox', '--use-gl=swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (err) => errors.push('PAGEERROR ' + err.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE ' + m.text()); });

  await page.goto(URL, { waitUntil: 'load', timeout: 60000 });
  await page.evaluate(() => {
    localStorage.setItem('fusheng-settings', JSON.stringify({
      season: 'summer', weather: 'sunny', day: 'day', fishCount: 12, fishSize: 1, turtleCount: 0,
      quality: 'high', reducedMotion: false, sound: false, volume: 0, ecoMode: false,
    }));
  });
  await page.reload({ waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => Boolean(window.__pondEngine), null, { timeout: 20000 });
  await page.waitForTimeout(1200);
  await page.evaluate(`window.__ab = (${PAGE_TOOLS.toString()})();`);

  const T = (fn, ...args) => page.evaluate(([src, a]) => window.__ab[src](...a), [fn, args]);
  const shot = async (name) => { await page.screenshot({ path: join(OUT, `sun-ab-${name}.png`) }); };

  const geom = await T('stage', SHAFT_U, SHAFT_TILT);
  console.log(`画布 ${geom.width}×${geom.height} · 带轴中点 x=${geom.axisAtMid.toFixed(0)} y=${geom.midY}`);

  // ── 第一组：带 WebGL 底图（看合成观感）
  await T('noShaft'); await shot('A');
  await T('withShaft', SHAFT_U, SHAFT_TILT); await shot('B');
  await T('noShaft'); await shot('A2');

  // ── 第二组：关掉底图，只剩 2D 光照层（干净差分）
  await T('landscape', false);
  await page.waitForTimeout(300);
  await T('noShaft'); await shot('Ab');
  await T('withShaft', SHAFT_U, SHAFT_TILT); await shot('Bb');
  await T('noShaft'); await shot('Ab2');
  await T('landscape', true);

  console.log(`截图：out/sun-ab-{A,B,A2,Ab,Bb,Ab2}.png`);
  if (errors.length) { console.log('⚠️ 页面报错：'); errors.slice(0, 8).forEach((e) => console.log('   ' + e)); }
  else console.log('页面无报错');
  await browser.close();
})();
