/**
 * 须子落笔前的定位探针 —— 量新轮廓在吻端附近的**真实边界**。
 *
 * 为什么必须先量：`drawHead()` 里的须根是硬编码的 `l*.379` / `l*.44`，
 * 那是按**旧轮廓**（吻端半宽 0.30px 的针尖）设计的。
 * 吻端改钝后轮廓形状完全不同，直接沿用旧坐标可能让须根
 * 浮在轮廓**外面**（看着像从空气里长出来）或被轮廓裁掉。
 *
 * 输出：每个 u 的脊线点、左右轮廓点、以及该 u 处"可安全落笔的 y 范围"。
 * 判据：须根的 y 必须落在 [−w+margin, +w−margin] 内（margin = 线宽的一半 + 余量）。
 */

const PW = require('C:/Users/Y/.workbuddy/binaries/node/workspace/node_modules/playwright-core');
const { join } = require('node:path');
const fs = require('node:fs');

const EXE = 'C:/Users/Y/AppData/Local/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-win64/chrome-headless-shell.exe';
const ROOT = join(__dirname, '..');

(async () => {
  const browser = await PW.chromium.launch({ executablePath: EXE, args: ['--no-sandbox', '--use-gl=swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 400, height: 300 } });
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  await page.setContent('<!doctype html><meta charset="utf-8"><body></body>');
  const code = fs.readFileSync(join(ROOT, 'src/engine/koi-motion.js'), 'utf8');
  await page.addScriptTag({ content: code.replace(/^import .*?;$/gm, '').replace(/^export /gm, '') });

  const r = await page.evaluate(({ LEN, W }) => {
    const fish = { x: 0, y: 0, heading: 0, length: LEN, width: W, variant: 2,
      phase: 1.15, swimAmplitude: 0.055, finPhase: 0.7, depth: 1, seed: 1, speed: 40, velocity: 30 };
    const oldW = (u) => Math.sin(u * Math.PI) ** .8 * LEN * W * (.64 + u * .52) + .3;
    const US = [0.90, 0.92, 0.94, 0.95, 0.96, 0.97, 0.98, 0.99, 0.995, 1.0];
    const rows = US.map((u) => {
      const p = koiBodyPoint(fish, u);
      return {
        u,
        x: p.x, y: p.y, angle: p.angle,
        wNew: p.width, wOld: oldW(u),
        // 轮廓点（bodyPath 的实际采样点）
        leftX: p.x - p.nx * p.width, leftY: p.y - p.ny * p.width,
        rightX: p.x + p.nx * p.width, rightY: p.y + p.ny * p.width,
      };
    });
    const p1 = koiBodyPoint(fish, 1);
    // 旧代码里须子用的坐标，换算成 u 与"距轮廓内侧多少"
    const legacy = [
      { name: '旧须根', x: LEN * 0.379, y: LEN * 0.014 },
      { name: '旧须中', x: LEN * 0.423, y: LEN * 0.024 },
      { name: '旧须尖', x: LEN * 0.44, y: LEN * 0.057 },
    ].map((q) => {
      // 找最近的 u（按 x）
      let bu = 0, bd = 1e9, bp = null;
      for (let i = 0; i <= 2000; i++) {
        const p = koiBodyPoint(fish, i / 2000);
        const d = Math.abs(p.x - q.x);
        if (d < bd) { bd = d; bu = i / 2000; bp = p; }
      }
      return { ...q, u: bu, w: bp.width, inside: Math.abs(q.y) < bp.width, over: Math.abs(q.y) - bp.width };
    });
    return { rows, legacy, tip: { x: p1.x, y: p1.y, w: p1.width }, LEN };
  }, { LEN: 60, W: 0.123 });

  const P = (s, n) => String(s).padEnd(n);
  const R = (s, n) => String(s).padStart(n);

  console.log(`\n${'═'.repeat(104)}`);
  console.log(`  新轮廓定位探针  length=${r.LEN}   吻端(u=1) 脊线点 x=${r.tip.x.toFixed(2)}  半宽=${r.tip.w.toFixed(2)}px`);
  console.log(`${'═'.repeat(104)}`);
  console.log(`  ${P('u', 8)}${R('脊线x', 10)}${R('脊线y', 9)}${R('新半宽', 10)}${R('旧半宽', 10)}${R('轮廓左x', 10)}${R('轮廓左y', 10)}${R('轮廓右y', 10)}${R('x占l', 9)}`);
  for (const q of r.rows) {
    console.log(`  ${P(q.u, 8)}${R(q.x.toFixed(2), 10)}${R(q.y.toFixed(2), 9)}${R(q.wNew.toFixed(2), 10)}${R(q.wOld.toFixed(2), 10)}`
      + `${R(q.leftX.toFixed(2), 10)}${R(q.leftY.toFixed(2), 10)}${R(q.rightY.toFixed(2), 10)}${R((q.x / r.LEN).toFixed(4), 9)}`);
  }

  console.log(`\n${'─'.repeat(104)}`);
  console.log('  ★ 旧须子坐标在新轮廓下的落点（inside=false ⇒ 浮在轮廓外）');
  console.log(`  ${P('点', 10)}${R('x', 10)}${R('y', 10)}${R('最近u', 9)}${R('该u半宽', 11)}${R('|y|-w', 10)}${'  判定'}`);
  for (const q of r.legacy) {
    console.log(`  ${P(q.name, 10)}${R(q.x.toFixed(2), 10)}${R(q.y.toFixed(2), 10)}${R(q.u.toFixed(4), 9)}`
      + `${R(q.w.toFixed(2), 11)}${R(q.over.toFixed(2), 10)}   ${q.inside ? '✔ 在轮廓内' : '✘ 浮在轮廓外'}`);
  }

  console.log(`\n  ⇒ 旧须根 (l·.379, l·.014) 在新轮廓下：${r.legacy[0].inside ? '仍可用' : '**不可用，须重定位**'}`);
  console.log(`  ⇒ 须根可用的 y 上限（按 l=.379 处的轮廓）= ±${r.legacy[0].w.toFixed(2)}px  = ±${(r.legacy[0].w / r.LEN).toFixed(4)}·l`);

  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
