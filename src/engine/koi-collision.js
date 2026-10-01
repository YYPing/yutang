/**
 * 锦鲤的碰撞体积 —— 胶囊体（沿体轴的一条线段 + 一个半径）。
 *
 * ── 为什么是胶囊体，不是圆 ──────────────────────────────────────────────
 * 圆会把一条 60~104px 长、只有 14~24px 宽的鱼当成一个直径 = 长的圆
 * ⇒ 两条鱼头尾相距 40px（视觉上完全没碰到）也会被判为重叠而互推。
 * 胶囊体沿体轴伸长、半径只取体宽的一半，形状与鱼的真轮廓同构。
 *
 * ── 为什么放在独立文件 ────────────────────────────────────────────────
 * 它是纯几何、零状态、可单测。塞进 `simulation.js` 的话，
 * 「关掉开关必须与改动前逐位一致」这条红线就没法用单测守了。
 *
 * ── 段的两端怎么取 ────────────────────────────────────────────────────
 * `koi-motion.js` 里 `spine()` 的积分为 `x ∈ [−.37l, +.41l]`（局部坐标），
 * 也就是鱼头在 `+.41l`、鱼尾在 `−.37l`。碰撞段取体长的 **78%**，头尾各让一点。
 * 略短于真实轮廓是故意的 —— 留余量，否则视觉上"刚好碰上"时物理上还没接触，
 * 读起来会觉得"隔空被推"。
 *
 * ⚠️⚠️ 半径必须与渲染轮廓**同源**：`WIDTH_PEAK · l · width` 直接 import，
 *   绝不在这里手抄常数。我第一次手抄成 `.0602`（真值 ≈ .9201），
 *   半径塌到 1px 下限 ⇒ 鱼几乎完全重叠，而**没有任何报错**，
 *   只是"看起来没生效"。
 */

import { WIDTH_PEAK } from './koi-motion.js';

/**
 * 碰撞体几何常量。改这里就等于改手感，别在别处散落魔法数。
 */
export const COLLISION = Object.freeze({
  /** 碰撞段长度占体长的比例。 */
  spanFraction: .78,
  /** 半径占「体半宽峰值」的比例。取 .62 而不是 1.0：留出手感余量。 */
  radiusScale: .62,
  /** 分离力强度（px/s² 量级）。 */
  strength: 46,
  /** 速度反冲的上限（px/s），避免弹飞。 */
  maxSpeed: 34,
  /** 位置修正的松弛系数：1 表示一帧内完全分离（会显得生硬）。 */
  correction: .38,
});

const EPS = 1e-9;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * 一条鱼的碰撞体：世界坐标下的线段两端 + 半径。
 * @param {{x:number,y:number,heading:number,length:number,width:number}} fish
 * @param {number} bodyScale 与 `simulation.bodyRadius` 同一口径的画面缩放
 */
export function koiBody(fish, bodyScale = 1) {
  const l = fish.length;
  const half = l * COLLISION.spanFraction * .5;
  // 鱼头指向 heading；线段中心比几何中心略靠前一点点（头重尾轻）
  const cx = fish.x + Math.cos(fish.heading) * l * .01;
  const cy = fish.y + Math.sin(fish.heading) * l * .01;
  const ax = Math.cos(fish.heading), ay = Math.sin(fish.heading);
  const halfWidth = l * fish.width * WIDTH_PEAK;
  return {
    x1: cx - ax * half, y1: cy - ay * half,
    x2: cx + ax * half, y2: cy + ay * half,
    r: Math.max(1, halfWidth * COLLISION.radiusScale * bodyScale),
  };
}

/**
 * 两条线段的最近点对（Ericson, *Real-Time Collision Detection* §5.1.9）。
 *
 * ★ 为什么不用「沿段离散采样取最小距离」（我先写的那版）：
 *   段长约 `0.78 × 104 = 81px`，取 9 个点 ⇒ 间距 10px；
 *   而最小半径只有 `7.09 × .62 ≈ 4.4px`，两倍也才 8.8px。
 *   采样式**只能取到子集**，所以永远**低估距离 ⇒ 高估穿透深度**
 *   ⇒ 把"其实没碰到"的两条鱼也推开，误差可达 ~7px（相对 8.8px 的预算）。
 *   这是**系统性偏差**，不是噪声，加大采样数也只是缓解。
 *   ⇒ 换成精确解：零采样、零偏差，代价是 30 行代数。
 */
export function closestSegmentPoints(a1x, a1y, a2x, a2y, b1x, b1y, b2x, b2y) {
  const d1x = a2x - a1x, d1y = a2y - a1y;
  const d2x = b2x - b1x, d2y = b2y - b1y;
  const rx = a1x - b1x, ry = a1y - b1y;
  const A = d1x * d1x + d1y * d1y;
  const E = d2x * d2x + d2y * d2y;
  const F = d2x * rx + d2y * ry;
  let s = 0, t = 0;

  if (A <= EPS && E <= EPS) { s = 0; t = 0; }                 // 两段都退化成点
  else if (A <= EPS) { s = 0; t = clamp01(F / E); }           // 第一段退化
  else {
    const C = d1x * rx + d1y * ry;
    if (E <= EPS) { t = 0; s = clamp01(-C / A); }             // 第二段退化
    else {
      const B = d1x * d2x + d1y * d2y;
      const denom = A * E - B * B;
      // 平行时 denom ≈ 0 ⇒ 取 s = 0，再靠下面的 t 夹取分支收敛
      s = denom > EPS ? clamp01((B * F - C * E) / denom) : 0;
      t = (B * s + F) / E;
      if (t < 0) { t = 0; s = clamp01(-C / A); }
      else if (t > 1) { t = 1; s = clamp01((B - C) / A); }
    }
  }

  const Ax = a1x + d1x * s, Ay = a1y + d1y * s;
  const Bx = b1x + d2x * t, By = b1y + d2y * t;
  return { Ax, Ay, Bx, By, dist: Math.hypot(Ax - Bx, Ay - By) };
}

/**
 * 两个胶囊体的穿透深度与分离法线。
 * @returns {{depth:number, nx:number, ny:number}|null} 不重叠时返回 null
 */
export function capsuleOverlap(a, b) {
  const c = closestSegmentPoints(a.x1, a.y1, a.x2, a.y2, b.x1, b.y1, b.x2, b.y2);
  const depth = a.r + b.r - c.dist;
  if (depth <= 0) return null;
  // 分离方向 = 从 b 的最近点指向 a 的最近点（把 a 推开）
  let nx = c.Ax - c.Bx, ny = c.Ay - c.By;
  const len = Math.hypot(nx, ny);
  if (len < 1e-6) {
    // 完全重合：最近点对退化，没有方向可用。退到「两段中点连线」；
    // 仍然重合（两鱼同位同向）时用固定方向 —— 只要是**单位向量**即可，
    // 位置修正对称施加，方向选谁都不会让系统产生净偏置。
    const mx = ((a.x1 + a.x2) - (b.x1 + b.x2)) * .5;
    const my = ((a.y1 + a.y2) - (b.y1 + b.y2)) * .5;
    const mlen = Math.hypot(mx, my);
    if (mlen < 1e-6) { nx = 1; ny = 0; } else { nx = mx / mlen; ny = my / mlen; }
  } else { nx /= len; ny /= len; }
  return { depth, nx, ny };
}
