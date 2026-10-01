/**
 * 头部改动对照图（给**人眼**看的，不是量具）。
 *
 * 产出 `out/koi-head-compare.png`：左右两条鱼并排，走**同一条真实渲染管线**
 * （`KoiRenderer.drawFish`，含须子、鳃、眼、鳞、花纹）。
 *   · 左 = 改前的宽度公式（旧吻部：针尖）
 *   · 右 = 改后的宽度公式（新吻部：钝头 + 4 条须子）
 * 另出 `out/koi-head-zoom.png`：两条鱼的吻部放大并排，看得清 4 条须子。
 *
 * ★ 怎么在同一页里同时画「改前 / 改后」：
 *   `koi-motion.js` 里的 `export function koiBodyPoint` 去 `export` 后是**全局函数声明**，
 *   而 `koi-renderer.js` 的 `bodyPath/drawHead` 都是在**调用那一刻**才解析这个名字。
 *   所以把 `window.koiBodyPoint` 换掉，渲染器就跟着换 —— 两边走的都是真渲染代码，
 *   不是"我照着画一遍"。这比截图对比可靠得多。
 *   改前口径 = 只把 `width` 换回旧公式，`x/y/angle` 仍用真值（那本来就不受改动影响）。
 */

const PW = require('C:/Users/Y/.workbuddy/binaries/node/workspace/node_modules/playwright-core');
const { join } = require('node:path');
const fs = require('node:fs');

const EXE = 'C:/Users/Y/AppData/Local/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-win64/chrome-headless-shell.exe';
const ROOT = join(__dirname, '..');
const OUT = join(ROOT, 'out');

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await PW.chromium.launch({ executablePath: EXE, args: ['--no-sandbox', '--use-gl=swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1200, height: 700 }, deviceScaleFactor: 2 });
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  await page.setContent('<!doctype html><meta charset="utf-8"><body style="margin:0"></body>');
  for (const f of ['src/engine/koi-motion.js', 'src/engine/koi-renderer.js']) {
    await page.addScriptTag({
      content: fs.readFileSync(join(ROOT, f), 'utf8')
        .replace(/^import .*?;$/gm, '').replace(/^export /gm, ''),
    });
  }

  const shot = await page.evaluate(() => {
    const LEN = 200;                       // 放大 3.3×（真实鱼 43–104）
    const W = 1200, H = 700;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    // 水色底，和池水接近，避免白底把鱼衬托得像"漂白"
    const grd = ctx.createLinearGradient(0, 0, 0, H);
    grd.addColorStop(0, '#1b3b36'); grd.addColorStop(1, '#122b27');
    ctx.fillStyle = grd; ctx.fillRect(0, 0, W, H);

    const real = koiBodyPoint;
    const oldW = (fish, u) => Math.sin(u * Math.PI) ** .8 * fish.length * fish.width * (.64 + u * .52) + .3;
    const oldPoint = (fish, u) => Object.assign({}, real(fish, u), { width: oldW(fish, u) });

    const mk = (x, y) => ({
      // 侧视时宽度会显得很大，这里用 0.085（真实锦鲤俯视宽 ~0.12，侧视更窄）
      x, y, heading: 0, length: LEN, width: 0.085, variant: 2,
      phase: 1.15, swimAmplitude: 0.05, finPhase: 0.7, depth: 1,
      seed: 1.3, speed: 40, velocity: 30,
    });

    const draw = (fish, useOld) => {
      koiBodyPoint = useOld ? oldPoint : real;
      const r = new KoiRenderer(ctx);
      r.width = W; r.height = H;
      r.options = { quality: 'high', night: false };
      ctx.save();
      ctx.translate(fish.x, fish.y);
      r.drawFish(fish, false);
      ctx.restore();
    };

    // 上下两条：上 = 改前，下 = 改后（横向排更宽，纵向排更容易比对面部）
    const fy1 = H * 0.30, fy2 = H * 0.72;
    draw(mk(W * 0.5, fy1), true);
    draw(mk(W * 0.5, fy2), false);
    koiBodyPoint = real;

    // 标签
    ctx.font = '600 22px system-ui,"Microsoft YaHei",sans-serif';
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ff8a7a'; ctx.fillText('改前 · 吻端为针尖（半宽 0.30px）', 28, fy1 - 78);
    ctx.fillStyle = '#7fe3c4'; ctx.fillText('改后 · 钝吻 + 4 条须子（半宽 2.30px）', 28, fy2 - 78);

    // 吻端竖直参考线（两条鱼共用，便于看出尖端位置）
    const tipX = LEN * 0.41 + W * 0.5;
    ctx.strokeStyle = 'rgba(255,255,255,.22)'; ctx.setLineDash([6, 6]); ctx.lineWidth = 1.5;
    for (const y of [fy1, fy2]) {
      ctx.beginPath(); ctx.moveTo(tipX, y - 60); ctx.lineTo(tipX, y + 60); ctx.stroke();
    }
    ctx.setLineDash([]);

    return c.toDataURL('image/png');
  });
  fs.writeFileSync(join(OUT, 'koi-head-compare.png'), Buffer.from(shot.split(',')[1], 'base64'));
  console.log('  → out/koi-head-compare.png');

  // 吻部放大：只画头，两条鱼上下并排
  const zoom = await page.evaluate(() => {
    const LEN = 300;
    const W = 1000, H = 560;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#142f2b'; ctx.fillRect(0, 0, W, H);

    const real = koiBodyPoint;
    const oldW = (fish, u) => Math.sin(u * Math.PI) ** .8 * fish.length * fish.width * (.64 + u * .52) + .3;
    const oldPoint = (fish, u) => Object.assign({}, real(fish, u), { width: oldW(fish, u) });
    const mk = (x, y) => ({ x, y, heading: 0, length: LEN, width: 0.085, variant: 2,
      phase: 1.15, swimAmplitude: 0.05, finPhase: 0.7, depth: 1, seed: 1.3, speed: 40, velocity: 30 });

    // 把吻端推到画面右侧：鱼局部 +x 是头，所以把它放右侧
    const draw = (fish, useOld) => {
      koiBodyPoint = useOld ? oldPoint : real;
      const r = new KoiRenderer(ctx);
      r.width = W; r.height = H;
      r.options = { quality: 'high', night: false };
      ctx.save(); ctx.translate(fish.x, fish.y); r.drawFish(fish, false); ctx.restore();
    };
    draw(mk(W * 0.18, H * 0.32), true);
    draw(mk(W * 0.18, H * 0.74), false);
    koiBodyPoint = real;

    ctx.font = '600 20px system-ui,"Microsoft YaHei",sans-serif';
    ctx.textAlign = 'right'; ctx.textBaseline = 'top';
    ctx.fillStyle = '#ff8a7a'; ctx.fillText('改前：吻端收成一点', W - 24, 18);
    ctx.fillStyle = '#7fe3c4'; ctx.fillText('改后：圆钝吻 · 上唇须(短) + 嘴角须(长)', W - 24, H * 0.74 - 24);
    return c.toDataURL('image/png');
  });
  fs.writeFileSync(join(OUT, 'koi-head-zoom.png'), Buffer.from(zoom.split(',')[1], 'base64'));
  console.log('  → out/koi-head-zoom.png');

  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
