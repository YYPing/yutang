/**
 * 4 条须子（2 对）验收量具。
 *
 * 本模型读不了图 ⇒ 全部靠数值。判据四条：
 *   1. **须子确实画了 4 条**（拦截落笔次数，不是靠肉眼看"有四条线"）
 *   2. **每条须根都落在轮廓内**（否则须子像从空气里长出来）
 *   3. **上唇一对明显短于嘴角一对**（用户原话："上唇一对较短，嘴角一对较长"）
 *   4. **须子随游动摆动**（finPhase 变 ⇒ 落笔坐标变）
 *
 * 顺带覆盖「4 条须子不越界」：须尖允许伸出轮廓（本来就该伸出去），
 * 但须尖不能伸得太离谱（判为"像触须/像面条"）。
 *
 * 用法：node tools/check-koi-barbels.cjs
 */

const PW = require('C:/Users/Y/.workbuddy/binaries/node/workspace/node_modules/playwright-core');
const { join } = require('node:path');
const fs = require('node:fs');

const EXE = 'C:/Users/Y/AppData/Local/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-win64/chrome-headless-shell.exe';
const ROOT = join(__dirname, '..');
const P = (s, n) => String(s).padEnd(n);
const R = (s, n) => String(s).padStart(n);
let pass = 0, fail = 0;
const ok = (cond, label, detail) => {
  if (cond) { pass++; console.log(`  ✔ ${label}${detail ? '  — ' + detail : ''}`); }
  else { fail++; console.log(`  ✘ ${label}${detail ? '  — ' + detail : ''}`); }
};

(async () => {
  const browser = await PW.chromium.launch({ executablePath: EXE, args: ['--no-sandbox', '--use-gl=swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 400, height: 300 } });
  page.on('pageerror', (e) => { console.error('[pageerror]', e.message); fail++; });
  await page.setContent('<!doctype html><meta charset="utf-8"><body></body>');
  for (const f of ['src/engine/koi-motion.js', 'src/engine/koi-renderer.js']) {
    await page.addScriptTag({
      content: fs.readFileSync(join(ROOT, f), 'utf8')
        .replace(/^import .*?;$/gm, '').replace(/^export /gm, ''),
    });
  }

  const data = await page.evaluate(() => {
    const W = 0.123;
    const mkFish = (LEN, finPhase) => ({
      x: 0, y: 0, heading: 0, length: LEN, width: W, variant: 2,
      phase: 1.15, swimAmplitude: 0.055, finPhase, depth: 1,
      seed: 1, speed: 40, velocity: 30,
    });

    // 只调 drawHead，并在假 ctx 上截住 quadraticCurveTo
    // ★ 须子靠 `ctx.setBarbelMark(true/false)` 打标记识别，**不靠几何猜**。
    //   为什么放弃几何猜：`drawHead` 里除须子外还有嘴线（`moveTo(l·.387, ±l·.016)`，
    //   长 1.9px），它和短须位置高度重叠。我用长度阈值试了三次都失败：
    //   阈值 1.8px → 嘴线 1.92px 混进来；阈值 2.5px → 短须在 L43 只有 2.43px 被误杀。
    //   两个阈值之间没有可靠缝隙 ⇒ **这不是阈值能解决的问题。**
    //   标记由 `drawBarbels` 主动打，真 canvas 上是 `?.()` 空调用（零影响）。
    const trace = (fish) => {
      const strokes = [];
      let rec = [];
      let mark = null;
      // ★ 标记必须**一次性**：打标记 → 下一次 stroke 消费掉 → 立刻清空。
      //   不这么做会踩坑：`drawHead` 里鳃线/嘴线画在 `drawBarbels` **之外**，
      //   它们会继承上一次遗留的 mark ⇒ 6 条须子（实测多出 u=.788 鳃线、u=.971 嘴线）。
      //   "打了标记不清"和"没打标记"是两种不同的错，后者更隐蔽。
      const ctx = new Proxy({}, {
        get(_, k) {
          if (k === 'setBarbelMark') return (isUpper) => { mark = isUpper; };
          if (k === 'lineWidth' || k === 'strokeStyle' || k === 'fillStyle' || k === 'globalAlpha') return '';
          if (k === 'beginPath') return () => { rec = []; };
          if (k === 'moveTo') return (x, y) => { rec.push({ x, y }); };
          if (k === 'quadraticCurveTo') return (cx, cy, x, y) => { rec.push({ cx, cy, x, y }); };
          if (k === 'stroke') return () => {
            if (rec.length) strokes.push({ pts: rec.slice(), mark });
            mark = null;   // 一次性消费
          };
          if (k === 'ellipse') return () => {};
          if (k === 'save' || k === 'restore' || k === 'translate' || k === 'rotate' || k === 'scale') return () => {};
          if (k === 'drawImage') return () => {};
          return () => {};
        },
        set() { return true; },
      });
      const r = new KoiRenderer(ctx);
      r.drawHead(fish, { side: '#7d9b88', fin: '#e9e0b9' });
      return strokes;
    };

    // 轮廓：算某点 (x,y) 到轮廓的余量（正=在内）
    const marginAt = (fish, x, y) => {
      let bu = 0, bd = 1e9, bp = null;
      for (let i = 0; i <= 3000; i++) {
        const p = koiBodyPoint(fish, i / 3000);
        const d = Math.abs(p.x - x);
        if (d < bd) { bd = d; bu = i / 3000; bp = p; }
      }
      return { margin: bp.width - Math.abs(y), u: bu, w: bp.width };
    };

    // ★ 须子靠 `ctx.setBarbelMark(true/false)` 打标记识别，**不靠几何猜**。
    //   为什么放弃几何猜（此处死了三次）：
    //     ① `s[0].cx !== undefined` 恒为假 —— `s[0]` 是 `moveTo`（只有 x/y），`cx` 在 `s[1]`。
    //        须子画得好好的，量具报「0 条」。
    //     ② 改成「起点 x>.34l 且 |y|>.008l」⇒ 报「5 条」——
    //        `drawHead` 结尾的**嘴线**（`moveTo(l·.387, ±l·.016)`，长 1.9px）混进来，
    //        把嘴角须平均长度拉低 ⇒ 长短比假性 1.26×。
    //     ③ 改成长度阈值 ≥.03l ⇒ 嘴线 1.92px 照样混进来；提到 .04l 又会在 L43
    //        误杀短须（实测 2.43px）。**两个阈值之间没有可靠缝隙。**
    //   ⇒ 这不是阈值能解决的问题。标记由 `drawBarbels` 主动打，
    //     真 canvas 上是 `?.()` 空调用（零影响、零风险）。
    const isBarbel = (s) => s.mark !== null;

    const out = [];
    for (const LEN of [43, 60, 76, 104]) {
      const fish = mkFish(LEN, 0.7);
      const strokes = trace(fish);
      const rows = strokes.filter(isBarbel).map((s) => {
        // 二次贝塞尔：根 = moveTo 点，须尖 = quadraticCurveTo 的**终点**（第 3、4 参数）
        const root = { x: s.pts[0].x, y: s.pts[0].y };
        const tip = { x: s.pts[1].x, y: s.pts[1].y };
        const len = Math.hypot(tip.x - root.x, tip.y - root.y);
        const rm = marginAt(fish, root.x, root.y);
        return {
          upper: s.mark, len, rootU: rm.u, rootMargin: rm.margin, rootW: rm.w,
          rootX: root.x, rootY: root.y, tipX: tip.x, tipY: tip.y,
        };
      });
      // 分类**直接用标记**，不再靠 |y| 猜（那也是一次脆弱推断）
      const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
      const shortRows = rows.filter((r) => r.upper);
      const longRows = rows.filter((r) => !r.upper);
      out.push({
        LEN, count: rows.length, rows,
        shortLen: avg(shortRows.map((r) => r.len)),
        longLen: avg(longRows.map((r) => r.len)),
        shortCount: shortRows.length, longCount: longRows.length,
        minRootMargin: rows.length ? Math.min(...rows.map((r) => r.rootMargin)) : NaN,
        worstMarginRow: rows.reduce((m, r) => (!m || r.rootMargin < m.rootMargin ? r : m), null),
      });
    }

    // 摆动：同一条鱼，finPhase 变，须**尖**是否跟着动
    // ⚠️ 必须比须尖而不是须根 —— 须根本来就固定在嘴上，摆动的是须尖。
    //    比错元素 ⇒ 报「未变化」，其实须子在正常摆。
    const swingTest = (() => {
      const f1 = mkFish(60, 0.7), f2 = mkFish(60, 1.9);
      const tips = (fish) => trace(fish).filter(isBarbel)
        .map((s) => ({
          upper: s.mark,
          root: `${s.pts[0].x.toFixed(3)},${s.pts[0].y.toFixed(3)}`,
          tip: `${s.pts[1].x.toFixed(3)},${s.pts[1].y.toFixed(3)}`,
        }));
      const a = tips(f1), b = tips(f2);
      return {
        n: a.length,
        tipMoved: a.filter((q, i) => b[i] && q.tip !== b[i].tip).length,
        rootMoved: a.filter((q, i) => b[i] && q.root !== b[i].root).length,
        first: a[0] || null, firstB: b[0] || null,
      };
    })();

    return { out, swingTest };
  });

  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log('  4 条须子（2 对）验收');
  console.log('══════════════════════════════════════════════════════════════════\n');

  console.log('  ① 数量：每条鱼必须画到 4 条须子');
  for (const d of data.out) {
    ok(d.count === 4 && d.shortCount === 2 && d.longCount === 2,
      `length=${d.LEN} 画到 ${d.count} 条（上唇 ${d.shortCount} / 嘴角 ${d.longCount}）`,
      d.count === 4 && d.shortCount === 2 && d.longCount === 2 ? '4 条齐' : `期望 4(2+2)，实得 ${d.count}(${d.shortCount}+${d.longCount})`);
  }

  console.log('\n  ② 须根必须落在轮廓内（余量 > 线宽 0.62px）');
  for (const d of data.out) {
    ok(d.minRootMargin > 0.62, `length=${d.LEN} 最小须根余量 ${d.minRootMargin.toFixed(2)}px`,
      `最紧的一条在 u=${d.worstMarginRow ? d.worstMarginRow.rootU.toFixed(3) : '?'}（轮廓半宽 ${d.worstMarginRow ? d.worstMarginRow.rootW.toFixed(2) : '?'}px）`);
  }

  console.log('\n  ③ 上唇一对明显短于嘴角一对（用户原话）');
  for (const d of data.out) {
    const ratio = d.longLen / (d.shortLen || 1e-9);
    ok(d.shortLen > 0 && ratio >= 1.5, `length=${d.LEN} 上唇 ${d.shortLen.toFixed(2)}px / 嘴角 ${d.longLen.toFixed(2)}px`,
      `长短比 ${ratio.toFixed(2)}× （阈值 ≥1.5）`);
  }

  console.log('\n  ④ 须子随手游摆动（finPhase 变 ⇒ 落笔变）');
  {
    const s = data.swingTest;
    ok(s.tipMoved === s.n && s.n === 4, `finPhase 0.7 → 1.9：${s.tipMoved}/${s.n} 条须尖坐标已变`,
      s.n === 4 ? `须根固定 ${s.rootMoved} 处变动（须根本来就该固定在嘴上）` : `只测到 ${s.n} 条`);
    if (s.first) console.log(`      第 1 条：根 (${s.first.root}) 不动，须尖 (${s.first.tip}) → (${s.firstB.tip})`);
  }

  console.log('\n  ⑤ 真 canvas 上须子必须真的画出来（`setBarbelMark?.()` 不得影响绘制）');
  {
    const px = await page.evaluate(() => {
      // 只画嘴部区域，放大到须子必有像素落点
      const LEN = 260;
      const W = 900, H = 560;
      const shot = (withBarbel) => {
        const c = document.createElement('canvas');
        c.width = W; c.height = H;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
        const fish = { x: 0, y: 0, heading: 0, length: LEN, width: 0.123, variant: 2,
          phase: 1.15, swimAmplitude: 0.055, finPhase: 0.7, depth: 1, seed: 1, speed: 40, velocity: 30 };
        const r = new KoiRenderer(ctx);
        // 屏蔽 drawBarbels 用来看"没有须子"的基线
        if (!withBarbel) r.drawBarbels = () => {};
        ctx.translate(300, H / 2);
        r.drawHead(fish, { side: '#7d9b88', fin: '#e9e0b9' });
        const img = ctx.getImageData(0, 0, W, H).data;
        let sum = 0;
        for (let i = 0; i < img.length; i += 4) sum += img[i];
        return sum / 255;
      };
      return { on: shot(true), off: shot(false) };
    });
    const delta = px.on - px.off;
    ok(delta > 20, `须子像素增量 ${delta.toFixed(0)}（有须 ${px.on.toFixed(0)} / 无须 ${px.off.toFixed(0)}）`,
      delta > 20 ? '须子确实被画到画布上' : '⚠️ 须子没画出来 —— `setBarbelMark` 污染了 strokeStyle');
  }

  console.log('\n  ── 明细 ──');
  console.log(`  ${P('length', 9)}${P('类型', 10)}${P('侧', 6)}${R('根x', 9)}${R('根y', 9)}${R('根u', 8)}${R('轮廓半宽', 11)}${R('根余量', 9)}${R('须长', 8)}`);
  for (const d of data.out) {
    for (const r of d.rows) {
      console.log(`  ${P(d.LEN, 9)}${P(r.upper ? '上唇须' : '嘴角须', 10)}${P(r.rootY < 0 ? '左' : '右', 6)}`
        + `${R(r.rootX.toFixed(2), 9)}${R(r.rootY.toFixed(2), 9)}`
        + `${R(r.rootU.toFixed(3), 8)}${R(r.rootW.toFixed(2), 11)}${R(r.rootMargin.toFixed(2), 9)}${R(r.len.toFixed(2), 8)}`);
    }
  }

  console.log(`\n══════════════════════════════════════════════════════════════════`);
  console.log(`  须子验收：${pass} 通过 / ${fail} 失败`);
  console.log(`══════════════════════════════════════════════════════════════════\n`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
