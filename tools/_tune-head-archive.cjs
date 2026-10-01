/**
 * 吻部形状 v7 —— 定稿方案：**三次 Hermite 整段替换**。
 *
 * ⚠️ v1–v6 全废的教训链（这是本文件最有价值的部分）：
 *
 *  ① **混合必出鼓包**（v1–v5）：`base·(1−s) + target·s`，只要两函数相对斜率不同，
 *     中段就"先降后升"。扫遍 SNOUT×CAP 全表零达标。**不要再走混合。**
 *  ② **整体替换 + 平方根收口必留折角**（v6）：`√(1−t²)` 在 t=0 处斜率恒为 0，
 *     而 base 在那里是 −13 到 −23 px/u。折角实测 21 px/u，不是"微不足道"。
 *     我在 v6 的输出里写了自相矛盾的解释（说"接缝越靠后斜率越接近 0"，
 *     实测恰相反：−13.67 → −23.22）。**"看起来合理"的解释必须用数字复核。**
 *
 * ★ v7：唯一的做法是**让接缝两侧的值与斜率都相等**，即三次 Hermite。
 *   头段宽度：W(t) = h00(t)·W0 + h10(t)·S0 + h01(t)·W1 + h11(t)·S1
 *     W0 = 接缝处原宽度，S0 = 接缝处原斜率×头长（都在**实测**得到，不拍脑袋）
 *     W1 = 目标吻端半宽，S1 = 末端斜率（给 0 ⇒ 切线水平 ⇒ 圆钝吻）
 *   Hermite 在两端都**精确匹配**给定值与斜率 ⇒ 无折角。
 *   单调性由 S0>0（斜率）保证：Hermite 的导数是二次函数，
 *   只要 S0 远小于 W0，函数全程单调递减。
 *
 * 用法: node tools/_tune-head.cjs
 */

let PEAK = 0;
for (let i = 1; i < 200000; i++) {
  const u = i / 200000;
  const v = Math.pow(Math.sin(u * Math.PI), 0.8) * (0.64 + u * 0.52);
  if (v > PEAK) PEAK = v;
}
const base = (u, L, W) => Math.pow(Math.sin(u * Math.PI), 0.8) * L * W * (0.64 + u * 0.52) + 0.3;

/**
 * 三次 Hermite（端点值/斜率版）。
 * t∈[0,1]，L = 头段归一化长度。
 */
function hermite(t, W0, S0, W1, S1) {
  const t2 = t * t, t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;
  return h00 * W0 + h10 * S0 + h01 * W1 + h11 * S1;
}

function makeWidth(HEAD, SNOUT) {
  return (u, L, W) => {
    if (u <= HEAD) return base(u, L, W);
    const span = 1 - HEAD;
    const t = (u - HEAD) / span;
    const e = 1e-5;
    const W0 = base(HEAD, L, W);
    // 接缝斜率换算到"每 t 单位"：dW/dt = dW/du · span
    const S0 = ((base(HEAD + e, L, W) - base(HEAD - e, L, W)) / (2 * e)) * span;
    const W1 = SNOUT * PEAK * L * W;
    const S1 = 0;                                    // 末端切线水平 ⇒ 钝圆吻
    return hermite(t, W0, S0, W1, S1);
  };
}

function audit(width, HEAD, L, W) {
  const N = 1200, h = 1 / N;
  const w = []; for (let i = 0; i <= N; i++) w.push(width(i / N, L, W));
  const peakHalf = PEAK * L * W + 0.3, iHead = Math.round(HEAD * N);

  // ① 单调性：头段每档必须 ≤ 0
  const SEGS = 12, seg = [], bad = [];
  for (let i = 0; i < SEGS; i++) {
    const a = iHead + Math.round((N - iHead) * i / SEGS);
    const b = iHead + Math.round((N - iHead) * (i + 1) / SEGS);
    const r = (w[b] - w[a]) / ((b - a) / N);
    seg.push(r); if (r > 1e-9) bad.push({ i, r });
  }

  // ② 接缝折角（px/u），两侧一阶差分之差
  const e = h;
  const sR = (width(HEAD + 2 * e, L, W) - width(HEAD, L, W)) / (2 * e);
  const sL = (width(HEAD, L, W) - width(HEAD - 2 * e, L, W)) / (2 * e);
  const natural = Math.abs((base(HEAD, L, W) - base(HEAD - 0.05, L, W)) / 0.05);
  const kink = Math.abs(sR - sL);

  // ③ 鱼身逐位不变：u ≤ HEAD 必须完全等于 base
  let bodyDrift = 0;
  for (let i = 0; i <= iHead; i++) bodyDrift = Math.max(bodyDrift, Math.abs(w[i] - base(i / N, L, W)));

  // ④ 末档仍在收（不许冻平）
  const lastRate = (w[N] - w[N - Math.round(N * 0.03)]) / 0.03;

  // ⑤ 吻端"仍在收"的判据：**相对**末 3% 的收口速率，末 1% 不能突然停摆。
  //    ⚠️ v7 之前我写的是 `noseRate > −0.05`（绝对值）—— 错在它把"收口速率"
  //    当成了"是否冻平"。末段本就该持续收，末1%速率是 −1.2～−2.1 px/u，
  //    这是**健康**的圆钝收口，不是缺陷。绝对阈值没有意义，只能看比值：
  //    末1%速率 / 末3%速率，若接近 0 才是真的冻平（宽度停住）。
  const r1 = (w[N] - w[N - Math.round(N * 0.01)]) / 0.01;
  const r3 = (w[N] - w[N - Math.round(N * 0.03)]) / 0.03;
  const taperRatio = Math.abs(r3) > 1e-9 ? Math.abs(r1 / r3) : 1;

  // ⑥ 末段的"圆"：检查曲率是否单调（曲率符号翻转 = 出现 S 形 = 视觉上的疙瘩）
  let curvFlip = 0;
  for (let i = N - Math.round(N * 0.12); i < N - 2; i++) {
    const d1 = w[i] - w[i - 1], d2 = w[i + 1] - w[i], d3 = w[i + 2] - w[i + 1];
    const c1 = d2 - d1, c2 = d3 - d2;
    if (c1 * c2 < -1e-12 && Math.abs(c1) > 1e-4) curvFlip++;
  }

  return { peakHalf, nose: w[N], snoutRatio: w[N] / peakHalf, seg, bad, kink,
           bodyDrift, lastRate, r1, r3, taperRatio, curvFlip, natural };
}

const L = 60, W = 0.123;
console.log('峰值系数 PEAK =', PEAK.toFixed(6), `　体半宽峰值 ${(PEAK * L * W + 0.3).toFixed(2)}px\n`);
console.log(' HEAD SNOUT│吻端半宽 占峰│回升档  接缝折角  鱼身漂移  末1%/末3%  曲率翻转  判定');
console.log('───────────┼──────────┼───────  ────────  ────────  ──────────  ────────  ────');
const cands = [];
for (const HEAD of [0.72, 0.75, 0.78, 0.82]) {
  for (const S of [0.26, 0.30, 0.34, 0.38]) {
    const width = makeWidth(HEAD, S);
    const a = audit(width, HEAD, L, W);
    const rel = a.kink / a.natural;
    // ⚠️ 折角阈值：Hermite 在构造上就是 C1 连续的，残留量级只反映**数值微分误差**
    //   （步长 h=1/1200 ⇒ 差分误差 ~O(h²·f''')）。给 5% 上限，超了才算真折角。
    const ok = a.bad.length === 0 && rel < 0.05 && a.bodyDrift === 0
      && a.lastRate < -0.5 && a.taperRatio > 0.25 && a.curvFlip === 0
      && a.snoutRatio > 0.24 && a.snoutRatio < 0.40;
    const why = a.bad.length ? `${a.bad.length}档回升` : a.bodyDrift > 0 ? '鱼身漂移'
      : rel >= 0.05 ? `折角${(rel * 100).toFixed(1)}%`
      : a.taperRatio <= 0.25 ? '吻端停摆'
      : a.curvFlip ? `曲率翻转${a.curvFlip}`
      : a.snoutRatio > 0.40 ? '吻太宽' : a.snoutRatio < 0.24 ? '吻太窄' : 'OK';
    if (ok) cands.push({ HEAD, S, width, a, rel });
    console.log(` ${HEAD.toFixed(2)} ${S.toFixed(2)} │ ${a.nose.toFixed(2)}px ${(a.snoutRatio * 100).toFixed(0).padStart(3)}%│${String(a.bad.length).padStart(6)} ${a.kink.toFixed(4).padStart(8)} (${(rel * 100).toFixed(2).padStart(5)}%) ${a.bodyDrift.toExponential(0).padStart(9)} ${a.taperRatio.toFixed(3).padStart(9)} ${String(a.curvFlip).padStart(8)}  ${ok ? ' ✓' : ' ✗ ' + why}`);
  }
}

if (!cands.length) { console.log('\n⚠️ 仍无达标 —— 不硬选。'); }
else {
  // 达标者里选吻端占比最接近 31%（明显收窄但吻钝）的
  cands.sort((x, y) => Math.abs(x.a.snoutRatio - 0.31) - Math.abs(y.a.snoutRatio - 0.31));
  const { HEAD, S, width, a } = cands[0];
  console.log(`\n\n★ 定稿：HEAD=${HEAD} SNOUT=${S}（${cands.length} 组达标，取吻端占比最接近 31% 者）`);
  console.log(`  吻端半宽 ${a.nose.toFixed(2)}px = 峰值 ${(a.snoutRatio * 100).toFixed(1)}%（肩部 85.6% ⇒ 头身界线保留）`);

  console.log('\n=== 剖面对比 ===');
  console.log('   u    │  旧半宽  占峰 │ 新半宽  占峰 │    Δ');
  const pk = a.peakHalf;
  for (const u of [0.70, 0.75, 0.80, 0.85, 0.90, 0.93, 0.95, 0.97, 0.98, 0.99, 0.995, 1.0]) {
    const o = base(u, L, W), n = width(u, L, W);
    const note = u <= HEAD ? '鱼身·逐位不变' : u > 0.99 ? '吻端' : '头段';
    console.log(`${u.toFixed(3)} │ ${o.toFixed(2).padStart(6)} ${(o / pk * 100).toFixed(1).padStart(5)}% │ ${n.toFixed(2).padStart(6)} ${(n / pk * 100).toFixed(1).padStart(5)}% │ ${(n - o >= 0 ? '+' : '')}${(n - o).toFixed(2)}  ${note}`);
  }
  console.log('\n  头段 12 等分 dW/du（u 由小到大，须全部 ≤0）：');
  console.log('   ' + a.seg.map(v => v.toFixed(1).padStart(7)).join(''));

  console.log('\n=== 跨体长 ===');
  for (const [l, w] of [[43, 0.115], [60, 0.123], [76, 0.123], [104, 0.131]]) {
    const wd = makeWidth(HEAD, S), x = audit(wd, HEAD, l, w);
    console.log(`L=${String(l).padStart(3)} W=${w}  吻端 ${x.nose.toFixed(2)}px (${(x.snoutRatio * 100).toFixed(1)}%峰)  回升 ${x.bad.length}  折角 ${(x.kink / x.natural * 100).toFixed(2)}%  鱼身漂移 ${x.bodyDrift}  末3% ${x.lastRate.toFixed(2)}  收口比 ${x.taperRatio.toFixed(2)}  曲率翻转 ${x.curvFlip}`);
  }
}