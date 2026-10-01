/**
 * 吻端「回折」诊断 —— 查清画布上吻端到底是不是一个尖点。
 *
 * 起因：落笔量具跑出来两个自相矛盾的读数
 *   · 改前 落笔/控制点 = 4.167（印证"贝塞尔只摸到控制点约一半"）
 *   · 改后 落笔/控制点 = 1.060（同一句话不成立）
 *   · 两版 u=1.000 的落笔半宽都近似 0（0.055 / 0.369）
 * ⇒ 怀疑不是 `width` 公式的问题，而是 `bodyPath` 点阵 + `smoothPath`
 *   闭合方式让吻端**必然**收成一个回折尖点。调 `width` 改不动它。
 *
 * 本脚本把吻端区（u≥.90）**每一个落笔采样点**按弧长顺序倒出来，
 * 直接看轮廓是怎么走的：走出去 → 折回来，还是圆润地合上。
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

  const out = await page.evaluate(({ LEN, W }) => {
    const fish = { x: 0, y: 0, heading: 0, length: LEN, width: W, variant: 2,
      phase: 1.15, swimAmplitude: 0.055, finPhase: 0.7, depth: 1, seed: 1, speed: 40, velocity: 30 };
    const STEPS = 20;
    const oldW = (u) => Math.sin(u * Math.PI) ** .8 * LEN * W * (.64 + u * .52) + .3;

    const buildPts = (wFn) => {
      const pts = [];
      for (let i = 0; i <= STEPS; i++) {
        const u = i / STEPS, p = koiBodyPoint(fish, u), w = wFn(u, p);
        pts.push({ x: p.x - p.nx * w, y: p.y - p.ny * w, u, side: -1 });
      }
      for (let i = STEPS; i >= 0; i--) {
        const u = i / STEPS, p = koiBodyPoint(fish, u), w = wFn(u, p);
        pts.push({ x: p.x + p.nx * w, y: p.y + p.ny * w, u, side: 1 });
      }
      return pts;
    };

    // 完全复刻 smoothPath 的落笔顺序
    const trace = (wFn, per = 10) => {
      const pts = buildPts(wFn);
      const n = pts.length;
      const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, u: (a.u + b.u) / 2 });
      let anchor = mid(pts[0], pts[n - 1]);
      const segs = [{ kind: 'moveTo', at: anchor, ctrl: null, u: anchor.u }];
      for (let i = 0; i < n; i++) {
        const C = pts[i], E = mid(C, pts[(i + 1) % n]);
        const samples = [];
        for (let k = 0; k <= per; k++) {
          const t = k / per, m = 1 - t;
          samples.push({
            x: m * m * anchor.x + 2 * m * t * C.x + t * t * E.x,
            y: m * m * anchor.y + 2 * m * t * C.y + t * t * E.y,
          });
        }
        segs.push({ kind: 'quad', from: anchor, ctrl: C, to: E, u: C.u, side: C.side, samples });
        anchor = E;
      }
      return { pts, segs };
    };

    // 脊线密采样
    const spine = [];
    for (let i = 0; i <= 4000; i++) {
      const u = i / 4000, p = koiBodyPoint(fish, u);
      spine.push({ x: p.x, y: p.y, u });
    }
    const near = (pt) => {
      let best = Infinity, bu = 0, bp = null;
      for (const a of spine) {
        const d = Math.hypot(pt.x - a.x, pt.y - a.y);
        if (d < best) { best = d; bu = a.u; bp = a; }
      }
      return { d: best, u: bu, p: bp };
    };

    const noseWalk = (wFn) => {
      const { segs } = trace(wFn, 10);
      // ⚠️ segs[0] 是 moveTo，所以 quad_i 在 segs[i+1]。
      //    吻端是 quad19/20/21/22：左 u=.95→1，中点合拢，右 u=1→.95。
      //    ⚠️ 别用 slice(-7)：那是尾端（u=0.30→0.00），我第一次就是这么取错的。
      const tail = segs.slice(19, 25);
      return tail.map((s) => {
        if (s.kind === 'moveTo') return { note: 'moveTo(尾端中点)' };
        const ex = near(s.samples[5]);       // 段中点附近 = 控制点影响最大处
        return {
          u: s.u, side: s.side,
          ctrlX: s.ctrl.x, ctrlY: s.ctrl.y,
          toX: s.to.x, toY: s.to.y,
          toU: s.to.u,
          midDist: ex.d, midU: ex.u,
        };
      });
    };

    // 关键：整条轮廓上，**离脊线最远**的点在哪里（u 多少）？吻端有没有折返？
    const extremes = (wFn) => {
      const { segs } = trace(wFn, 10);
      let nose = null, body = null;
      for (const s of segs) {
        if (s.kind !== 'quad') continue;
        for (let k = 1; k < s.samples.length; k++) {
          const q = near(s.samples[k]);
          if (!body || q.d > body.d) body = { d: q.d, u: q.u, side: s.side, sx: s.samples[k].x, sy: s.samples[k].y };
          if (!nose || (q.u > .93 && q.d > nose.d)) nose = { d: q.d, u: q.u, side: s.side, sx: s.samples[k].x, sy: s.samples[k].y };
        }
      }
      return { nose, body };
    };

    // 轮廓最前端 x（吻尖实际坐标）与 u=1 脊线点 x 的差 = "突出量"
    const tip = (wFn) => {
      const { segs } = trace(wFn, 10);
      let maxX = -1e9, at = null;
      for (const s of segs) {
        if (s.kind !== 'quad') continue;
        for (const q of s.samples) if (q.x > maxX) { maxX = q.x; at = near(q); }
      }
      const p1 = koiBodyPoint(fish, 1);
      return { tipX: maxX, spineTipX: p1.x, overshoot: maxX - p1.x, uAtTip: at.u, distAtTip: at.d };
    };

    // ★ 最直接的"钝度"判据：轮廓最前端 1% x 范围内的**纵向跨度**。
    //   尖吻 ⇒ 跨度→0（左右两侧在一点会合）
    //   钝吻 ⇒ 跨度≈2×吻端半宽
    const bluntness = (wFn) => {
      const { segs } = trace(wFn, 24);
      const all = [];
      for (const s of segs) {
        if (s.kind !== 'quad') continue;
        for (const q of s.samples) all.push(q);
      }
      const maxX = Math.max(...all.map((q) => q.x));
      const spanAt = (frac) => {
        const cut = maxX - (maxX - Math.min(...all.map((q) => q.x))) * frac;
        const ys = all.filter((q) => q.x >= cut).map((q) => q.y);
        return ys.length ? Math.max(...ys) - Math.min(...ys) : 0;
      };
      return { maxX, span1: spanAt(.01), span2: spanAt(.02), span5: spanAt(.05) };
    };

    return {
      walkNew: noseWalk((u, p) => p.width),
      walkOld: noseWalk((u) => oldW(u)),
      extNew: extremes((u, p) => p.width),
      extOld: extremes((u) => oldW(u)),
      tipNew: tip((u, p) => p.width),
      tipOld: tip((u) => oldW(u)),
      bluntNew: bluntness((u, p) => p.width),
      bluntOld: bluntness((u) => oldW(u)),
      spineTip: koiBodyPoint(fish, 1),
    };
  }, { LEN: 60, W: 0.123 });

  const P = (s, n) => String(s).padEnd(n);
  const R = (s, n) => String(s).padStart(n);

  console.log(`\n${'═'.repeat(96)}`);
  console.log('  吻端最后 6 段落笔（length=60）  —— 看轮廓是「折回」还是「合上」');
  console.log(`${'═'.repeat(96)}`);
  for (const [tag, walk] of [['改后', out.walkNew], ['改前', out.walkOld]]) {
    console.log(`\n  【${tag}】`);
    console.log(`  ${P('段u', 7)}${P('侧', 5)}${R('控制点x', 11)}${R('段终点x', 11)}${R('终点u', 9)}${R('段中点距脊', 12)}${R('该处u', 9)}`);
    for (const s of walk) {
      if (s.note) { console.log(`  ${P(s.note, 60)}`); continue; }
      console.log(`  ${P(s.u.toFixed(2), 7)}${P(s.side < 0 ? '左' : '右', 5)}${R(s.ctrlX.toFixed(2), 11)}${R(s.toX.toFixed(2), 11)}${R(s.toU.toFixed(3), 9)}${R(s.midDist.toFixed(3), 12)}${R(s.midU.toFixed(3), 9)}`);
    }
  }

  console.log(`\n${'─'.repeat(96)}`);
  console.log('  极值点：整条轮廓离脊线最远的地方');
  for (const [tag, e] of [['改后', out.extNew], ['改前', out.extOld]]) {
    console.log(`  ${tag}  身体峰 ${e.body.d.toFixed(3)}px @u=${e.body.u.toFixed(3)}   吻端区最远 ${e.nose.d.toFixed(3)}px @u=${e.nose.u.toFixed(3)}`);
  }

  console.log(`\n${'─'.repeat(96)}`);
  console.log('  吻尖：轮廓最前端 x vs 脊线 u=1 的 x');
  for (const [tag, t] of [['改后', out.tipNew], ['改前', out.tipOld]]) {
    console.log(`  ${tag}  吻尖x=${t.tipX.toFixed(2)}  脊线端x=${t.spineTipX.toFixed(2)}  突出 ${t.overshoot.toFixed(2)}px  该点距脊线 ${t.distAtTip.toFixed(3)}px @u=${t.uAtTip.toFixed(3)}`);
  }

  console.log(`\n${'─'.repeat(96)}`);
  console.log('  ★ 钝度：轮廓最前端 1%/2%/5% x 范围内的纵向跨度（越小越尖）');
  for (const [tag, b] of [['改后', out.bluntNew], ['改前', out.bluntOld]]) {
    console.log(`  ${tag}  前端1%跨度 ${b.span1.toFixed(3)}px   2% ${b.span2.toFixed(3)}px   5% ${b.span5.toFixed(3)}px`);
  }
  console.log('\n  ⚠️ 判读要点：跨度≈0 ⇒ 左右两侧在吻端合于一点 = 回折尖点。');
  console.log('     改 p.width 只能改"张开多大"，改不了"合不合" —— 后者由 bodyPath 点阵 + smoothPath 闭合方式决定。');

  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
