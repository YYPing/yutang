/* ============================================================================
 * growth.js —— §7.1 体长增长曲线 + §7.2 体长硬上限（三重钳制）
 * ----------------------------------------------------------------------------
 * L(d) = L_birth + (L_cap − L_birth) / (1 + e^( −k · (d − d₀) ))
 *
 * ★C25★ k = 0.039 × GROWTH_K、d₀ = 82。这两个值与 §3 阶段表是**绑定参数**。
 *    v3.3 的 k=0.08 会让 111 日龄冲到 92.5%（表内应为 76%，偏差 +16.5pt），
 *    使「亚成 33–76% → 成体 76–96%」的渐进感消失，并提前触发到顶转肥满度。
 * ========================================================================== */

import { GROWTH, STAGES, MOTION, pxPerCm, CONDITION } from './constants.js';

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

/** §7.1 逻辑斯蒂曲线：给定日龄与个体上限，返回体长 cm */
export function lengthAtAge(ageDays, lCapCm, kPersonal = GROWTH.k) {
  const { lBirthCm, d0 } = GROWTH;
  if (ageDays <= 0) return lBirthCm;
  return lBirthCm + (lCapCm - lBirthCm) / (1 + Math.exp(-kPersonal * (ageDays - d0)));
}

/**
 * §7.2 个体天花板。三重钳制：
 *   ① L_gene  = 基准 25cm × SIZE_LINF(0.8–1.2)  → 20–30cm
 *   ② L_global= 全局硬顶（默认 30cm，可调 20–60）
 *   ③ F-7.2.2 屏幕占比 ≤ 短边 16%
 *
 * ★ 反直觉：第 ③ 条在 C28 的 pxPerCm 定义下**恒等于第 ② 条**——
 *   因为 pxPerCm = 短边 × .16 / L_global，于是「短边×.16 px」换算回 cm 恰好 = L_global。
 *   所以③不是多余的保险，而是 C28 换算口径自带的自洽性；
 *   保留它是为了把它做成**回归断言**（见 tools/validate.js 的屏幕占比检查），
 *   一旦有人改了 pxPerCm 的系数，断言会立刻炸。
 */
export function lengthCap(genes, opts = {}) {
  const globalCap = opts.globalLengthCapCm ?? GROWTH.globalLengthCapCm;
  const lGene = GROWTH.baseLengthCm * genes.sizeLinf;
  let cap = Math.min(lGene, globalCap);
  if (opts.viewportShortPx) {
    const maxCm = (opts.viewportShortPx * GROWTH.maxScreenFraction) /
                  pxPerCm(opts.viewportShortPx, globalCap);
    cap = Math.min(cap, maxCm);
  }
  return cap;
}

/** 个体陡度：k = 0.039 × GROWTH_K */
export function personalK(genes) {
  return GROWTH.k * genes.growthK;
}

/**
 * 推进一个 tick 的体长增长。
 * @returns {{lengthCm:number, grewCm:number, nutritionLeft:number, atCap:boolean}}
 *
 * F-7.3.8 生长调制：mod = clamp(0.2, 1.5, satiety/70)；
 *   且**每 tick 按本系数消耗 nutrition 原料池**，原料耗尽则 mod 回落到下限 0.2（C31 闭环）。
 *   这条正是「持续投喂 ⇒ 长得更快」的机制落点（US-2）。
 */
export function grow(fish, dtDays, opts = {}) {
  const lCap = fish.lCapCm;
  const prev = fish.lengthCm;

  if (prev >= lCap - 1e-9) {
    return { lengthCm: lCap, grewCm: 0, nutritionLeft: fish.nutrition, atCap: true };
  }

  const k = personalK(fish.genes);
  // 曲线在日龄 d 处的瞬时斜率（对日龄求导），乘 dt 得本 tick 增量
  const d = fish.ageDays;
  const { lBirthCm, d0 } = GROWTH;
  const expTerm = Math.exp(-k * (d - d0));
  const slope = (lCap - lBirthCm) * k * expTerm / ((1 + expTerm) ** 2);   // dL/dday

  // 生长调制
  let mod = clamp(fish.satiety / 70, 0.2, 1.5);
  const wantCm = slope * mod * dtDays;
  // ★ 直接读常量，不要经由 opts 传 —— 曾经写成 `opts.constants?.CONDITION?.nutritionPerCm ?? 1.2`，
  //   而调用方没传 ⇒ 永远取默认 1.2，改常量完全无效（tune.js 扫出来五档结果一模一样才发现）。
  const needNutrition = wantCm * CONDITION.nutritionPerCm;

  let actualCm = wantCm;
  let nutritionLeft = fish.nutrition;
  if (nutritionLeft <= 0) {
    // 原料耗尽 ⇒ 生长系数回落到下限（F-7.3.8）
    actualCm = slope * 0.2 * dtDays;
  } else if (needNutrition > nutritionLeft) {
    // 原料不够 ⇒ 按比例缩短增量，把剩余原料用尽
    actualCm = wantCm * (nutritionLeft / needNutrition);
    nutritionLeft = 0;
  } else {
    nutritionLeft -= needNutrition;
  }

  const next = clamp(prev + actualCm, 0, lCap);
  return { lengthCm: next, grewCm: next - prev, nutritionLeft, atCap: next >= lCap - 1e-9 };
}

/** §3 阶段判定（按日龄）*/
export function stageOf(ageDays) {
  if (ageDays < 0) return STAGES[0];            // 鱼卵（孵化倒计时）
  for (let i = 1; i < STAGES.length; i++) {
    if (ageDays < STAGES[i].to) return STAGES[i];
  }
  return STAGES[STAGES.length - 1];
}

/**
 * F-7.2.5 老鱼入阶钳制：进入老鱼（≥163 日）时若未到 L_cap，直接钳至 L_cap。
 * 消除 §3 表「成体末 96%」与老鱼「锁定在上限」之间的 4% 缺口。
 */
export function applyElderClamp(fish) {
  if (!GROWTH.clampElderToCap) return fish.lengthCm;
  if (fish.stage === 'elder' && fish.lengthCm < fish.lCapCm) return fish.lCapCm;
  return fish.lengthCm;
}

/** §12 体长 px（C28）：体长 px = lengthCm × pxPerCm */
export function lengthPx(fish, viewportShortPx, globalCapCm = GROWTH.globalLengthCapCm) {
  return fish.lengthCm * pxPerCm(viewportShortPx, globalCapCm);
}
