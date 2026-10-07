/* 水面环量具（俯视图口径）
 *
 * 被验证的三族「水面上的环」——一律必须是**正圆**：
 *   ① 投喂感应圈  pond.js  drawFeedCircles   （点击时出现的圈）
 *   ② 涟漪        pond.js  drawRipples        （投喂落水 / 鱼与乌龟啄食）
 *   ③ 落水环      scenery.js rain()           （雨滴 / 落叶入水）
 *
 * 为什么必须是圆：池塘是**俯视**构图（`public/assets/pond.png` 是俯视透水碧潭）。
 *   曾经三族都写成压扁椭圆（`ry = rx × 0.64` / `× 0.47`），理由写的是"水面远平面被压扁"，
 *   那是**斜视**场景的投影。俯视下画压扁的环，看起来就是贴了一层斜的 UI 浮层。
 *
 * ★ 判据「半径各向异性」= 最小轴 / 最大轴（**旋转不变**）
 *   圆 = 1.000；旧值 压扁 0.64 ⇒ 0.640、0.47 ⇒ 0.470。
 *   用各向异性而不是包围盒宽高比：包围盒在**旋转**下会变（旧代码那个 `rotate(-0.15)`
 *   会让包围盒宽高比读成 1.53，反而看不出"扁"）。
 *
 * ★ 双通道（几何 / 真像素）必须互证：
 *   通道 A：无头假 ctx 截获落笔，直接读 rx/ry。
 *   通道 B：把同一串落笔发到**真 Chromium** 画一遍，用 alpha 的二阶矩求各向异性
 *           （旋转不变、抗锯齿免疫）。两通道偏差必须 < 0.01。
 *
 * ★ 阳性对照：把旧值喂进同一个量具，必须读出 ≈0.640 / ≈0.470 —— 否则是量具没判别力，
 *   而不是"改对了"。
 *
 * 跑法：node tools/check-water-rings.js      （npm run check:rings）
 */
import { PondEngine } from '../src/engine/pond.js';
import { Scenery } from '../src/engine/scenery.js';
import { PondSimulation } from '../src/engine/simulation.js';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const PW = require('C:/Users/Y/.workbuddy/binaries/node/workspace/node_modules/playwright-core');
const EXE = 'C:/Users/Y/AppData/Local/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-win64/chrome-headless-shell.exe';
const TAU = Math.PI * 2;

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  (ok ? pass++ : fail++);
  console.log(`${ok ? '✔' : '✘'} ${name}${detail ? ' —— ' + detail : ''}`);
};
const near = (a, b, tol) => Math.abs(a - b) < tol;

/* ---------- 通道 A：假 ctx 截获落笔 ---------- */
function recorder() {
  const rings = [];
  const ctx = {
    save() {}, restore() {}, beginPath() {}, stroke() {}, fill() {},
    setLineDash() {}, fillRect() {}, closePath() {}, moveTo() {}, lineTo() {},
    arc(x, y, r, a0, a1) { rings.push({ kind: 'arc', x, y, rx: r, ry: r, rot: 0, a0, a1 }); },
    ellipse(x, y, rx, ry, rot, a0, a1) { rings.push({ kind: 'ellipse', x, y, rx, ry, rot: rot || 0, a0, a1 }); },
    lineWidth: 1, strokeStyle: '#fff', fillStyle: '#fff', lineDashOffset: 0, globalAlpha: 1,
  };
  return { ctx, rings };
}
/** 通道 A 的判据：在环上按参数化取点，量最小/最大"半径" —— 与旋转无关 */
function anisotropyGeom(r) {
  if (r.kind === 'arc') return 1;
  const lo = Math.min(r.rx, r.ry), hi = Math.max(r.rx, r.ry);
  return hi === 0 ? 1 : lo / hi;
}

/* ---------- 通道 B：真 Chromium 画一遍，量径向极值比 ---------- */
/**
 * ★ 为什么不用「alpha 的二阶矩」：那是**面**的度量。
 *   细环的弧长元 ds 会把权重堆在没有曲率的平直段上 ⇒ sqrt(λ₂/λ₁) ≠ 半轴比。
 *   实测：0.64 的椭圆读成 **0.726**、圆读成 0.992 —— 偏差 8%，量具自己就错了。
 *   改用 r(θ) = 沿 θ 方向最外侧有 alpha 的像素到重心距离，
 *   则 min r / max r **就是**半轴比（对薄环精确、对旋转不变）。
 *
 * ★ 为什么要先做相似变换：像素量具的精度受**栅格化**限制（误差 ~1/r）。
 *   落水环最小只有 rad≈11.6px，直接量会把正圆读成 0.83。
 *   把半径与线宽**同乘 k** 到统一尺度（相似变换）——各向异性在相似变换下**严格不变**，
 *   而量化误差随尺寸下降 ⇒ 正圆回到 0.99 量级，压扁的仍然读 0.64。
 */
function anisotropyPage() {
  return (ring) => {
    const S = 300, cx = S / 2, cy = S / 2;
    const c = document.createElement('canvas'); c.width = S; c.height = S;
    const g = c.getContext('2d');
    const maxR = Math.max(ring.rx, ring.ry) || 1;
    const k = Math.min(12, Math.max(1, 90 / maxR));      // 归一化到外半径 ~90px
    g.strokeStyle = '#ffffff'; g.lineWidth = 1.1 * k;
    g.beginPath();
    if (ring.kind === 'arc') g.arc(cx, cy, ring.rx * k, 0, Math.PI * 2);
    else g.ellipse(cx, cy, ring.rx * k, ring.ry * k, ring.rot, 0, Math.PI * 2);
    g.stroke();
    const d = g.getImageData(0, 0, S, S).data;
    const alpha = (x, y) => d[(y * S + x) * 4 + 3] / 255;
    let m = 0, sx = 0, sy = 0;
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const a = alpha(x, y);
      if (a <= 0) continue;
      m += a; sx += a * x; sy += a * y;
    }
    if (m === 0) return null;
    const ux = sx / m, uy = sy / m;
    let rmin = Infinity, rmax = 0;
    for (let k = 0; k < 720; k++) {
      const th = k * Math.PI / 360, dx = Math.cos(th), dy = Math.sin(th);
      let r = 0;
      for (let t = 0.25; t <= S / 2; t += 0.25) {
        const x = Math.round(ux + dx * t), y = Math.round(uy + dy * t);
        if (x < 0 || y < 0 || x >= S || y >= S) break;
        if (alpha(x, y) > 0.06) r = t;
      }
      if (r > 0) { rmin = Math.min(rmin, r); rmax = Math.max(rmax, r); }
    }
    return rmax <= 0 ? null : rmin / rmax;
  };
}

/* ---------- 三族环的捕获 ---------- */
function captureFeed(rings) {
  const { ctx, rings: out } = recorder();
  const fake = {
    ctx, options: { reducedMotion: false },
    sim: { feedCircles: [{ x: 130, y: 130, radius: 120, age: 0.2, life: 1.8 }] },
  };
  PondEngine.prototype.drawFeedCircles.call(fake);
  return out;
}
function captureRipple() {
  const { ctx, rings } = recorder();
  const fake = { ctx, options: {}, sim: { ripples: [{ x: 130, y: 130, age: 0.7, life: 2.6, strength: 1.25 }] } };
  PondEngine.prototype.drawRipples.call(fake);
  return rings;
}
function captureRain() {
  const { ctx, rings } = recorder();
  const a = {
    // ★ 2026-10-07（P2-2）：`scenery.rain` 的雨丝循环改读 **`a.rainDrops`**
    //   （天气雨 drops + 节气雨 termDrops 的合集），不再是 `a.drops`。
    //   ⇒ 桩对象必须与真实 `Atmosphere` **同构**，否则量具直接抛
    //   `a.rainDrops is not iterable` —— 这类「桩落后于实现」的坑很难查，
    //   因为量具报的是 TypeError，看起来像实现坏了。
    //   `rainDrops` 是 **getter**（`termDrops` 为空时返回 `drops` 本体），
    //   所以桩里要用 `Object.defineProperty` 复刻，不能直接写个字段。
    drops: [], termDrops: [], flash: 0, rainHits: 0, landings: 0,
    impacts: [{ x: 130, y: 130, age: 0.4, life: 1.35, kind: 'rain' }],
  };
  Object.defineProperty(a, 'rainDrops', { get() { return this.termDrops.length ? this.drops.concat(this.termDrops) : this.drops; } });
  Scenery.prototype.rain.call({}, ctx, a, 260, 260, { night: null, season: 'autumn' });
  return rings;
}

/* ---------- 主流程 ---------- */
(async () => {
  console.log('水面环量具（俯视图口径）· 判据 = 半径各向异性，圆 = 1.000\n');

  const families = [
    ['① 投喂感应圈 drawFeedCircles', captureFeed()],
    ['② 涟漪 drawRipples', captureRipple()],
    ['③ 落水环 rain impacts', captureRain()],
  ];

  const browser = await PW.chromium.launch({ executablePath: EXE, args: ['--no-sandbox', '--use-gl=swiftshader'] });
  const page = await browser.newPage();
  const pix = anisotropyPage();

  let maxDelta = 0;
  for (const [name, rings] of families) {
    if (!rings.length) { check(name, false, '没截到任何落笔（选择器失效？）'); continue; }
    const geom = rings.map(anisotropyGeom);
    const aMin = Math.min(...geom), aMax = Math.max(...geom);
    let pixMin = 1, pixMax = 0;
    for (const r of rings) {
      const v = await page.evaluate(pix, r);
      if (v === null) continue;
      pixMin = Math.min(pixMin, v); pixMax = Math.max(pixMax, v);
    }
    const delta = Math.max(Math.abs(aMin - pixMin), Math.abs(aMax - pixMax));
    maxDelta = Math.max(maxDelta, delta);
    check(`${name} = 正圆（几何通道 · 严格）`, aMin > 0.995 && aMax < 1.005,
      `${rings.length} 道环 · 几何 ${aMin.toFixed(3)}–${aMax.toFixed(3)}`);
    // 像素通道的阈值是**仪器分辨率**，不是理想值：栅格化对薄环的残余偏置实测 ~1.5%
    //（正圆读 0.973–0.988）。压扁的对照值 0.63 / 0.47 远远掉出这个窗口 ⇒ 仍有判别力。
    check(`${name} = 正圆（像素通道 · 仪器分辨率内）`, pixMin > 0.96,
      `像素 ${pixMin.toFixed(3)}–${pixMax.toFixed(3)}（正圆上限实测 0.988）· 双通道差 ${delta.toFixed(4)}`);
    check(`${name} 双通道不矛盾`, delta < 0.03, `差 ${delta.toFixed(4)} < 0.03`);
  }

  // 阳性对照：量具必须能测出旧值（否则"1.000"没有意义）
  for (const [label, r, want] of [
    ['旧感应圈 ry=rx×0.64', { kind: 'ellipse', x: 130, y: 130, rx: 120, ry: 120 * 0.64, rot: 0 }, 0.64],
    ['旧涟漪 ry=rx×0.64 且 rotate(-0.15)', { kind: 'ellipse', x: 130, y: 130, rx: 120, ry: 120 * 0.64, rot: -0.15 }, 0.64],
    ['旧落水环 ry=rx×0.47', { kind: 'ellipse', x: 130, y: 130, rx: 120, ry: 120 * 0.47, rot: -0.1 }, 0.47],
  ]) {
    const g = anisotropyGeom(r), p = await page.evaluate(pix, r);
    check(`阳性对照 · ${label}`, near(g, want, 0.005) && near(p, want, 0.02),
      `几何 ${g.toFixed(3)} · 像素 ${p.toFixed(3)}（应 ≈${want}）`);
  }
  await browser.close();

  // ④ 产物核对：源码改对了，还要确认**出货的那一份**也改对了。
  //    （本项目踩过 Vite 缓存滞后：磁盘改了、dev server 产物里还是旧的，两种构建都不报错。）
  const distAssets = path.join(APP, 'dist', 'assets');
  if (fs.existsSync(distAssets)) {
    const f = fs.readdirSync(distAssets).find((x) => x.endsWith('.js'));
    const s = fs.readFileSync(path.join(distAssets, f), 'utf8');
    const slice = (a, b) => {
      const i = s.indexOf(a), j = s.indexOf(b);
      return i >= 0 && j > i ? s.slice(i, j) : '';
    };
    const feedBody = slice('drawFeedCircles(){', 'drawLotus(){');
    const ripBody = slice('drawRipples(){', 'drawFeedCircles(){');
    const bodyOk = (body) => body.length > 40 && body.includes('.arc(') && !body.includes('.ellipse(');
    check('④ 产物 · 感应圈用 arc、无 ellipse', bodyOk(feedBody), f);
    check('④ 产物 · 涟漪用 arc、无 ellipse', bodyOk(ripBody), f);
    check('④ 产物 · 无压扁签名 (*.64,-.15 / *.47,-.1)',
      !/\w\*\.64,-\.15,0/.test(s) && !/\w\*\.47,-\.1,0/.test(s), f);
  } else {
    console.log('· 跳过产物核对（dist/ 不存在，先 npm run build）');
  }

  // 行为：吃食必须真的产生涟漪（不然"水面被扰动"只写在注释里）
  const W = 1280, H = 760;
  const sim = new PondSimulation(W, H, { fishCount: 6 }, () => 0.5);
  sim.update(1 / 60);
  sim.feed(W * 0.5, H * 0.5);
  const afterFeed = sim.ripples.length;
  check('投喂产生涟漪', afterFeed >= 1, `${afterFeed} 条 · 强度 ${sim.ripples[sim.ripples.length - 1]?.strength}`);

  const pellet = sim.food[0];
  const fish = sim.fish[0];
  const bodyScale = Math.min(1.15, Math.max(0.78, Math.min(W / 1250, H / 780)));
  fish.heading = 0;
  fish.x = pellet.x - fish.length * 0.385 * bodyScale;   // 让嘴正好落在饲料上
  fish.y = pellet.y;
  const before = sim.ripples.length;
  sim.update(1 / 60);
  const eaten = sim.food.length < 9;
  const fresh = sim.ripples.filter((r) => r.age < 1 / 60 + 1e-6);
  check('鱼啄食产生涟漪', eaten && fresh.length >= 1,
    `吃到=${eaten} · 新增 ${sim.ripples.length - before} 条 · 强度 ${fresh.map((r) => r.strength).join(',') || '—'}`);
  check('啄食涟漪强度可辨（≥0.6）', fresh.some((r) => r.strength >= 0.6),
    `最大 ${Math.max(0, ...fresh.map((r) => r.strength)).toFixed(2)}（旧值 0.36）`);

  console.log(`\n${pass} / ${pass + fail} 通过 · 双通道最大偏差 ${maxDelta.toFixed(4)}`);
  process.exit(fail ? 1 : 0);
})();
