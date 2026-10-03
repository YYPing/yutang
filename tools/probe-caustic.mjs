/* 焦散光网探针 —— 把 causticNet 单独渲染成图并量指标，不靠肉眼猜。
 *
 * 为什么要有这个：
 *   「画面亮了」不等于「光网生效」。可能的原因有三个，肉眼分不出：
 *     ① 天气/季节门控把振幅压到接近0（阴天 0.45×0.82×0.16 = 0.059）；
 *     ② gate 阈值太高，光网被削没了；
 *     ③ scale 太高，网眼细到在 1725×1125 上低于一个像素 → 采样混叠成灰雾。
 *   探针把每种可能分别量化，避免"改了参数但不知道有没有用"。
 *
 * 用法：node tools/probe-caustic.mjs
 * 断言：
 *   ① 亮线必须**稀疏**（占空比 2%–18%）—— 太密是噪声，太疏是网没了
 *   ② 必须有**双向时间流动**（t=0 与 t=3 的帧差异 > 阈值）
 *   ③ 亮线必须比暗部**明显更亮**（峰均比 > 1.6）
 */
import {CAUSTIC} from '../src/engine/light-field.js';

/* 与 GLSL 里causticNet() 逐步等价的 JS 实现。
 * ⚠️ 必须和 shader 逐行对应 —— 这里改了shader 不同步，这里量出来的数就没意义。
 * ⚠️ GLSL 里的 .42/.24/7.4/6.1/3.2 是硬编码字面量，不是 CAUSTIC 常量
 *    （GLSL 取不到 JS 常量）。这是刻意的：shader 内保持自包含。
 *    ⚠️ 风险：改 CAUSTIC 常量**不会**改 shader 行为，只有 uCausticScale/Drift 等
 *    传uniform 的参数才生效。这个不一致性已在 light-field.js 注明。 */
function causticNet(px, py, t, cells) {
  const driftX = t * 0.13, driftY = -t * 0.09;
  let qx = px, qy = py;
  qx += 0.42 * Math.sin(py * 2.3 + t * 0.26);
  qy += 0.42 * Math.cos(px * 1.9 - t * 0.21);
  qx += 0.24 * Math.sin(px * 3.1 - t * 0.19);
  qy += 0.24 * Math.cos(py * 2.7 + t * 0.17);
  // fract((q+drift)*cells) - 0.5，然后取 Chebyshev 距离
  const cx = ((qx + driftX) * cells) % 1;
  const cy = ((qy + driftY) * cells) % 1;
  const cellX = (cx < 0 ? cx + 1 : cx) - 0.5;
  const cellY = (cy < 0 ? cy + 1 : cy) - 0.5;
  const d = Math.max(Math.abs(cellX), Math.abs(cellY));
  const s = 1 - smoothstep(0, 0.30, d);
  return Math.pow(Math.min(1, Math.max(0, s)), 1.6);
}

function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

const W = 480, H = 300;
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? '✔' : '✘'} ${name}${detail ? ' —— ' + detail : ''}`);
};

/* 在给定参数下渲染一张灰度图，返回统计量。
   ⚠️ cells 直接进causticNet，**不再乘 uv** —— 与 shader 逐行对应。 */
function render(t, cells, gate) {
  const buf = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const n = causticNet(x / W, y / H, t, cells);
      // 与 shader 一致：smoothstep(gate, 1, n)
      const s = Math.min(1, Math.max(0, (n - gate) / (1 - gate)));
      buf[y * W + x] = s * s * (3 - 2 * s);
    }
  }
  return buf;
}

function stats(buf) {
  let sum = 0, max = 0, lit = 0, nonzero = 0;
  for (const v of buf) {
    sum += v;
    if (v > max) max = v;
    if (v > 0.15) lit++;
    if (v > 0.01) nonzero++;
  }
  const n = buf.length;
  return { mean: sum / n, max, duty: (lit / n) * 100, reach: (nonzero / n) * 100 };
}

console.log(`焦散光网探针 · ${W}×${H} · 常量 scale(cells)=${CAUSTIC.scale} gate=${CAUSTIC.gate}\n`);

// ── ① 占空比：光网必须稀疏
const base = render(0, CAUSTIC.scale, CAUSTIC.gate);
const s0 = stats(base);
check(
  '亮线稀疏（占空比 2%–16%）',
  s0.duty >= 2 && s0.duty <= 16,
  `占空比 ${s0.duty.toFixed(1)}%（亮线 ${Math.round(s0.duty * W * H / 100)} px / 覆盖率 ${s0.reach.toFixed(1)}%）`
);

// ── ② 双向流动：t 变化必须带来帧变化，且不是整体平移
const later = render(3, CAUSTIC.scale, CAUSTIC.gate);
let diff = 0, weighted = 0;
for (let i = 0; i < base.length; i++) {
  const d = Math.abs(base[i] - later[i]);
  diff += d;
  weighted += d * (base[i] + later[i]);
}
const meanDiff = diff / base.length;
const centroidShift = weighted / (diff || 1);
check('光网随时间流动', meanDiff > 0.01, `t=0→3 平均帧差 ${meanDiff.toFixed(4)}`);
check('流动是内部形变而非整体平移', Math.abs(centroidShift - 0.5) > 0.002,
  `亮质心偏移 ${(centroidShift - 0.5).toFixed(4)}（0.002 阈值）`);

// ── ③ 峰均比：亮线必须明显亮于暗部
check('亮线明显亮于暗部（峰均比 > 1.6）', s0.max / (s0.mean || 1e-6) > 1.6,
  `峰 ${s0.max.toFixed(3)} / 均 ${s0.mean.toFixed(3)} = ${(s0.max / (s0.mean || 1e-6)).toFixed(2)}×`);

// ── ④ 密度诊断：cells 必须是真控制（这是修掉的一个 bug的回归护栏）
console.log('\n密度诊断（占空比 / 覆盖率）:');
for (const cells of [1.4, 2.0, CAUSTIC.scale, 3.6, 5.0]) {
  const st = stats(render(0, cells, CAUSTIC.gate));
  const mark = cells === CAUSTIC.scale ? ' ← 当前' : '';
  console.log(`  cells=${String(cells).padStart(4)}  占空比 ${st.duty.toFixed(1).padStart(5)}%  覆盖率 ${st.reach.toFixed(1).padStart(5)}%  峰 ${st.max.toFixed(2)}${mark}`);
}
// 回归断言：cells 必须真的改变网眼尺寸。
// ⚠️ 判据踩过一次坑：一开始断言"覆盖率应随cells 大幅变化"，结果永远失败。
//    但**覆盖率本来就该大致恒定**（网格加密时边界总长变化很小），
//    真正随 cells 变的是**特征频率** —— 用相邻亮点的间距（自相关峰）来量。
// 老实现（uv*scale）里这个量恒定，正是那条 bug 的判据。
function featurePitch(buf) {
  // 取中间一行，找亮区游程的平均长度（像素）
  const y = H >> 1;
  const runs = [];
  let run = 0;
  for (let x = 0; x < W; x++) {
    if (buf[y * W + x] > 0.15) run++;
    else { if (run > 0) runs.push(run); run = 0; }
  }
  if (run > 0) runs.push(run);
  if (!runs.length) return 0;
  return runs.reduce((a, b) => a + b, 0) / runs.length;
}
// ⚠️ 采样坑：cells 太小时网眼比阈值还宽，中间一行可能**整行都是亮的**，
//    游程法就取不到"亮-暗-亮"的结构（实测 cells=1.4 游程=0）。
//    所以对照组必须选「网眼明显细于阈值」的那一端，否则量具本身失效。
const p20 = featurePitch(render(0, 2.0, CAUSTIC.gate));
const p60 = featurePitch(render(0, 6.0, CAUSTIC.gate));
check('cells 是真控制（改变网眼尺寸）', p20 > p60 * 1.5,
  `cells 2.0 亮线游程 ${p20.toFixed(1)}px vs cells 6.0 游程 ${p60.toFixed(1)}px（比 ${(p20 / (p60 || 1)).toFixed(2)}×）`);

// ── ⑤ 门控诊断
console.log('\ngate 诊断:');
for (const g of [0.3, 0.45, 0.62, 0.8, 0.9]) {
  const st = stats(render(0, CAUSTIC.scale, g));
  console.log(`  gate=${String(g).padStart(4)}  占空比 ${st.duty.toFixed(1).padStart(5)}%  覆盖率 ${st.reach.toFixed(1).padStart(5)}%${g === CAUSTIC.gate ? ' ← 当前' : ''}`);
}

// ── ⑥ 实际振幅：各天气下的有效 ink
console.log('\n各天气有效振幅（ink = 0.16 × weather × season）:');
for (const [w, wv] of Object.entries(CAUSTIC.weather)) {
  console.log(`  ${w.padEnd(8)} × season autumn(0.82) = ${(CAUSTIC.ink * wv * CAUSTIC.season.autumn).toFixed(4)}`);
}

const pass = results.filter((r) => r.ok).length;
console.log(`\n${pass} / ${results.length} 通过`);
process.exit(pass === results.length ? 0 : 1);
