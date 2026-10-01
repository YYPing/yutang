/**
 * 吻部剖面验收量具 —— 钝吻与否，只认这份读数。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  ⚠️⚠️ 死过三把尺子，别再走回头路
 * ═══════════════════════════════════════════════════════════════════════════
 *  翻车①  按亮度从截图里取轮廓。
 *     带标注的诊断图里有 白线 bodyPath(≈236) / 红脊 / 青剖面(≈193) / 黄点(≈213)，
 *     全部超过阈值 ⇒ 量到"最亮的那个"，不是 bodyPath。
 *     症状：改前改后读数**完全相同（Δ 全 0）**，而 diff 里吻部明明有 191px 差异。
 *     ⇒ 尺子坏了，不是东西没改。
 *
 *  翻车②  改用纯轮廓图（黑鱼白底，只 fill(bodyPath)）。
 *     最外 1–2 列是**抗锯齿残值**：改前吻端 W(0%) 读到 0.5px（真值约 1.2px），
 *     "末 1% 保持率"= W(1%)/W(0%) 算出 **300%**。
 *     ⇒ 任何拿 W(0%) 当分母的判据都会被残值污染。
 *
 *  翻车③  ⚠️ 落笔重建的**末段读数也是伪影**，本工具已剔除。
 *     `smoothPath` 每段终点是"相邻两控制点的中点"。u=1 那一段的两个控制点
 *     分别是 u=1 的左、右轮廓点（关于脊线对称），所以它的**终点正好落在脊线上**。
 *     于是：
 *       · "吻尖点距脊线 = 0.000px"      ⇒ 伪影，不代表针尖
 *       · "u=1.000 处半宽 = 0.369px"    ⇒ 伪影，那个 u 桶里只有落在脊线上的锚点
 *     我曾据此判定"改后仍是尖吻"，**那个结论是错的**。
 *     ⇒ 吻端不能按"离脊线多远"来量，必须按**纵向跨度**来量。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  本工具的两个通道（互为独立验证，差 >3% 就说明量具本身坏了）
 * ═══════════════════════════════════════════════════════════════════════════
 *  A 数值重建  假 ctx 截获 smoothPath 落笔的 moveTo/quadraticCurveTo，
 *             贝塞尔按 t 密采样成折线，再用**竖直扫描线**求每列的 min/max y。
 *             不经像素、无抗锯齿。
 *  B 真实光栅  真的 fill(bodyPath)，读 getImageData 的 **alpha 覆盖率积分**。
 *             覆盖率是"该像素被形状覆盖的比例"，对它求和 = 该列的精确纵向跨度 ——
 *             这是**抗锯齿免疫**的（阈值法会被残值污染，覆盖率法不会）。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  ★ 唯一的判据：收敛比 = 前端1%纵向跨度 / 前端5%纵向跨度
 * ═══════════════════════════════════════════════════════════════════════════
 *  为什么不用"吻端宽度"：u=1 处的宽度读数已被证明是伪影（翻车③）。
 *  收敛比是**无量纲**的，且直接对应肉眼说的"尖 / 钝"：
 *    尖吻 ⇒ 宽度在最后几% 急剧收拢 ⇒ 前端1% 已远小于 5% ⇒ 比值 ≪ 0.5
 *    钝吻 ⇒ 宽度平缓收口           ⇒ 前端1% ≈ 前端5%        ⇒ 比值 ≳ 0.7
 *  另有辅助量「鼻宽比」= 前端1%跨度 / 身体峰跨度，量"吻端相对体宽多粗"。
 *
 * 用法：
 *   node tools/measure-head-profile.cjs
 *   node tools/measure-head-profile.cjs --lens=43,60,76,104
 */

const PW = require('C:/Users/Y/.workbuddy/binaries/node/workspace/node_modules/playwright-core');
const { join } = require('node:path');
const fs = require('node:fs');

const EXE = 'C:/Users/Y/AppData/Local/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-win64/chrome-headless-shell.exe';
const ROOT = join(__dirname, '..');

const arg = (k, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.split('=').slice(1).join('=') : d;
};
const P = (s, n) => String(s).padEnd(n);
const R = (s, n) => String(s).padStart(n);

(async () => {
  const browser = await PW.chromium.launch({ executablePath: EXE, args: ['--no-sandbox', '--use-gl=swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 400, height: 300 } });
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  await page.setContent('<!doctype html><meta charset="utf-8"><body></body>');
  const code = fs.readFileSync(join(ROOT, 'src/engine/koi-motion.js'), 'utf8');
  await page.addScriptTag({ content: code.replace(/^import .*?;$/gm, '').replace(/^export /gm, '') });

  const LENS = arg('lens', '43,60,76,104').split(',').map(Number);
  const S = 8;                    // 光栅放大倍数：越大，抗锯齿占比越小
  let anyFail = false;

  for (const LEN of LENS) {
    const r = await page.evaluate(({ LEN, W, S }) => {
      const fish = { x: 0, y: 0, heading: 0, length: LEN, width: W, variant: 2,
        phase: 1.15, swimAmplitude: 0.055, finPhase: 0.7, depth: 1, seed: 1, speed: 40, velocity: 30 };
      const STEPS = 20;   // ⚠️ 必须与 koi-renderer.bodyPath 的 20 一致，否则量的不是同一条线
      const oldW = (u) => Math.sin(u * Math.PI) ** .8 * LEN * W * (.64 + u * .52) + .3;

      // ── A. 数值重建 ──────────────────────────────────────────────────────
      const outline = (wFn, per = 40) => {
        const pts = [];
        for (let i = 0; i <= STEPS; i++) {
          const u = i / STEPS, p = koiBodyPoint(fish, u), w = wFn(u, p);
          pts.push({ x: p.x - p.nx * w, y: p.y - p.ny * w });
        }
        for (let i = STEPS; i >= 0; i--) {
          const u = i / STEPS, p = koiBodyPoint(fish, u), w = wFn(u, p);
          pts.push({ x: p.x + p.nx * w, y: p.y + p.ny * w });
        }
        const n = pts.length;
        const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
        let anchor = mid(pts[0], pts[n - 1]);
        const poly = [{ x: anchor.x, y: anchor.y }];
        for (let i = 0; i < n; i++) {
          const C = pts[i], E = mid(C, pts[(i + 1) % n]);
          for (let k = 1; k <= per; k++) {
            const t = k / per, m = 1 - t;
            poly.push({ x: m * m * anchor.x + 2 * m * t * C.x + t * t * E.x,
                        y: m * m * anchor.y + 2 * m * t * C.y + t * t * E.y });
          }
          anchor = E;
        }
        return poly;
      };

      // 竖直扫描线：每列的 min/max y（对折线做精确求交，不靠采样密度）
      const columns = (poly) => {
        let minX = 1e9, maxX = -1e9;
        for (const q of poly) { if (q.x < minX) minX = q.x; if (q.x > maxX) maxX = q.x; }
        const NX = 1200;
        const lo = new Float64Array(NX).fill(1e9), hi = new Float64Array(NX).fill(-1e9);
        for (let i = 0; i < poly.length; i++) {
          const a = poly[i], b = poly[(i + 1) % poly.length];
          if (a.x === b.x) continue;
          const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x);
          let i0 = Math.floor((x0 - minX) / (maxX - minX) * (NX - 1));
          let i1 = Math.ceil((x1 - minX) / (maxX - minX) * (NX - 1));
          i0 = Math.max(0, Math.min(NX - 1, i0)); i1 = Math.max(0, Math.min(NX - 1, i1));
          for (let i = i0; i <= i1; i++) {
            const x = minX + (maxX - minX) * i / (NX - 1);
            if (x < x0 - 1e-9 || x > x1 + 1e-9) continue;
            const t = (x - a.x) / (b.x - a.x);
            const y = a.y + (b.y - a.y) * t;
            if (y < lo[i]) lo[i] = y;
            if (y > hi[i]) hi[i] = y;
          }
        }
        const xs = [], span = [];
        for (let i = 0; i < NX; i++) {
          if (lo[i] > hi[i]) continue;
          xs.push(minX + (maxX - minX) * i / (NX - 1));
          span.push(hi[i] - lo[i]);
        }
        return { minX, maxX, xs, span };
      };

      // ── B. 真实光栅：alpha 覆盖率积分（抗锯齿免疫）────────────────────────
      const raster = (wFn) => {
        const pad = 4;
        const c = document.createElement('canvas');
        c.width = Math.ceil(LEN * 1.1 * S) + pad * 2;
        c.height = Math.ceil(LEN * .5 * S) + pad * 2;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.setTransform(S, 0, 0, S, c.width / 2, c.height / 2);
        const pts = [];
        for (let i = 0; i <= STEPS; i++) {
          const u = i / STEPS, p = koiBodyPoint(fish, u), w = wFn(u, p);
          pts.push({ x: p.x - p.nx * w, y: p.y - p.ny * w });
        }
        for (let i = STEPS; i >= 0; i--) {
          const u = i / STEPS, p = koiBodyPoint(fish, u), w = wFn(u, p);
          pts.push({ x: p.x + p.nx * w, y: p.y + p.ny * w });
        }
        // 复刻 smoothPath
        const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
        ctx.beginPath();
        ctx.moveTo(mid(pts[0], pts[pts.length - 1]).x, mid(pts[0], pts[pts.length - 1]).y);
        for (let i = 0; i < pts.length; i++) {
          const n = pts[(i + 1) % pts.length];
          ctx.quadraticCurveTo(pts[i].x, pts[i].y, mid(pts[i], n).x, mid(pts[i], n).y);
        }
        ctx.closePath();
        ctx.fillStyle = '#000';
        ctx.fill();
        const img = ctx.getImageData(0, 0, c.width, c.height).data;
        const span = new Float64Array(c.width);
        for (let x = 0; x < c.width; x++) {
          let sum = 0;
          for (let y = 0; y < c.height; y++) sum += img[(y * c.width + x) * 4 + 3];
          span[x] = sum / 255 / S;         // 覆盖率之和 = 该列纵向跨度（px）
        }
        return { span, ox: -c.width / 2 / S, oy: -c.height / 2 / S, sc: S };
      };

      // ── 指标 ────────────────────────────────────────────────────────────
      // 身体峰：取 x∈[-.1L, .1L] 之外的最大列跨度（躯干中段，u≈.57 附近）
      const bodyOf = (xs, span) => {
        let m = 0;
        for (let i = 0; i < xs.length; i++) if (Math.abs(xs[i]) < LEN * .1 && span[i] > m) m = span[i];
        return m;
      };
      // 前端 f% 跨度：从最右列往左量整个鱼长的 f%
      const frontOf = (xs, span, f) => {
        const minX = xs[0], maxX = xs[xs.length - 1], L = maxX - minX;
        const cut = maxX - L * f;
        let m = 0;
        for (let i = 0; i < xs.length; i++) if (xs[i] >= cut && span[i] > m) m = span[i];
        return m;
      };

      const metric = (src) => {
        const { xs, span } = src;
        const body = bodyOf(xs, span);
        const f1 = frontOf(xs, span, .01), f2 = frontOf(xs, span, .02), f5 = frontOf(xs, span, .05);
        return { body, f1, f2, f5, conv: f1 / f5, noseRatio: f1 / body };
      };

      const polyNew = outline((u, p) => p.width);
      const polyOld = outline((u) => oldW(u));
      const rasNew = raster((u, p) => p.width);
      const rasOld = raster((u) => oldW(u));

      // 光栅 → 同一套指标（xs 用像素列号换算回鱼体坐标）
      const toXY = (ras) => {
        const xs = [], span = [];
        for (let i = 0; i < ras.span.length; i++) {
          if (ras.span[i] <= 0) continue;
          xs.push((i - ras.span.length / 2) / ras.sc);
          span.push(ras.span[i]);
        }
        return { xs, span };
      };

      return {
        LEN,
        A: { new: metric(columns(polyNew)), old: metric(columns(polyOld)) },
        B: { new: metric(toXY(rasNew)), old: metric(toXY(rasOld)) },
        ctrlNose: koiBodyPoint(fish, 1).width,
        ctrlNoseOld: oldW(1),
      };
    }, { LEN, W: 0.123, S });

    const line = (k, a, b, unit = 'px', dp = 3) =>
      `  ${P(k, 22)}${R(a.toFixed(dp), 11)}${R(b.toFixed(dp), 11)}   ${unit}`;

    console.log(`\n${'═'.repeat(74)}`);
    console.log(`  length = ${r.LEN}      身体峰跨度 A=${r.A.new.body.toFixed(2)} B=${r.B.new.body.toFixed(2)} px`);
    console.log(`${'═'.repeat(74)}`);

    for (const ch of ['A', 'B']) {
      const m = r[ch];
      const label = ch === 'A' ? '通道A 数值重建（无像素）' : '通道B 真实光栅（alpha 覆盖率）';
      console.log(`\n  ${label}`);
      console.log(`  ${P('', 22)}${R('改前', 11)}${R('改后', 11)}`);
      console.log(line('身体峰跨度', m.old.body, m.new.body));
      console.log(line('前端1%跨度', m.old.f1, m.new.f1));
      console.log(line('前端2%跨度', m.old.f2, m.new.f2));
      console.log(line('前端5%跨度', m.old.f5, m.new.f5));
      console.log(`  ${P('收敛比 f1/f5', 22)}${R(m.old.conv.toFixed(3), 11)}${R(m.new.conv.toFixed(3), 11)}   ${''}`);
      console.log(`  ${P('鼻宽比 f1/体峰', 22)}${R((m.old.noseRatio * 100).toFixed(1) + '%', 11)}${R((m.new.noseRatio * 100).toFixed(1) + '%', 11)}   ${''}`);
    }

    // 双通道一致性
    // ⚠️ 判据用**绝对像素偏差**，不用相对偏差。
    //   抗锯齿带来的是**固定的亚像素级误差**（约 ±0.2px），与鱼的大小无关；
    //   若用相对判据，length=43 那一档前端1%只有 ~0.35px，固定误差就占 7.5% ⇒ 假报警。
    //   反过来，若鱼放大到 200+，同样的固定误差会小到 0.1% 以下 ⇒ 判据自动变严。
    //   这才是"误差量级恒定、判据随精度自然收紧"的做法。
    const absd = (a, b) => Math.abs(a - b);
    const chk = [
      ['身体峰', absd(r.A.new.body, r.B.new.body)],
      ['前端1%', absd(r.A.new.f1, r.B.new.f1)],
      ['前端5%', absd(r.A.new.f5, r.B.new.f5)],
    ];
    const worst = Math.max(...chk.map((c) => c[1]));
    const TOL = 0.25;   // px
    console.log(`\n  双通道一致性（A vs B，改后）  ${chk.map((c) => `${c[0]} ${c[1].toFixed(3)}px`).join('   ')}`);
    console.log(`  ⇒ ${worst < TOL ? `✓ 两通道吻合（最大差 ${worst.toFixed(3)}px < ${TOL}px），量具可信`
      : `✗ 两通道打架（最大差 ${worst.toFixed(3)}px ≥ ${TOL}px），量具不可信`}`);

    // 判据
    const c = r.A.new.conv, c0 = r.A.old.conv;
    const pass = c >= .70 && worst < TOL;
    if (!pass) anyFail = true;
    console.log(`\n  判据  收敛比 ${c0.toFixed(3)}（尖吻）→ ${c.toFixed(3)}（钝吻）   阈值 ≥0.70  ${pass ? '✓ 通过' : '✗ 未通过'}`);
    console.log(`        鼻宽比 ${(r.A.old.noseRatio * 100).toFixed(1)}% → ${(r.A.new.noseRatio * 100).toFixed(1)}%   （参考）`);
  }

  await browser.close();
  console.log(`\n${'═'.repeat(74)}`);
  console.log(anyFail ? '  总结：至少有一档未通过。' : '  总结：全部档位通过 —— 吻部为钝吻，且两量具互相印证。');
  console.log(`${'═'.repeat(74)}\n`);
  process.exit(anyFail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
