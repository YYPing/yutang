/* ============================================================================
 * population.js —— §9 种群治理（拥挤度 / 密度胁迫 / 软硬上限）
 * ----------------------------------------------------------------------------
 * ★C5 密度胁迫★ crowd>1 时：λ = (crowd−1) × 0.08 /池塘日，
 *   鱼苗 ×3、健康<50 ×1.8；用 P = 1 − e^(−λ·dt) 而不是 λ·dt —— 后者在 dt 大时会发散。
 *
 * ⚠️ §9.1 的两道抑制是**叠加**关系，不是二选一（v4 澄清）：
 *   - §8.1「拥挤度 <1.0」= 硬闸门（不满足直接不能繁殖）
 *   - §9.1「crowd>0.8 概率×(1−crowd)」= 软抑制（降低速率）
 * ========================================================================== */

import { POPULATION } from './constants.js';

/** §9.1 拥挤度 = 现存 / 软上限 */
export function crowdOf(aliveCount, softCap = POPULATION.softCap) {
  return aliveCount / softCap;
}

/**
 * C5 密度胁迫：本 tick 每条鱼的死亡概率。
 * @returns {number} P = 1 − e^(−λ·dt)
 */
export function stressDeathProbability(fish, crowd, dtDays) {
  if (crowd <= 1) return 0;
  let lambda = (crowd - 1) * POPULATION.densityStressRate;
  if (fish.stage === 'fry') lambda *= POPULATION.stressFryMult;
  if (fish.health < 50) lambda *= POPULATION.stressSickMult;
  return 1 - Math.exp(-lambda * dtDays);
}

/** §9.1 硬上限 = softCap × 1.5；超出时最老/最弱者**加速衰老**（不是直接杀）*/
export function hardCapOf(softCap = POPULATION.softCap) {
  return softCap * POPULATION.hardCapMult;
}

/** 超出硬上限时，返回需要加速衰老的鱼（按「最老 + 最弱」排序取前 n）*/
export function pickCullCandidates(fishes, aliveCount, softCap = POPULATION.softCap) {
  const hard = hardCapOf(softCap);
  const over = aliveCount - hard;
  if (over <= 0) return [];
  // 分数越低越该被淘汰：日龄大、健康低 → 分数高
  return fishes
    .filter((f) => !f.dead)
    .slice()
    .sort((a, b) => (b.ageDays - a.ageDays) || (a.health - b.health))
    .slice(0, Math.ceil(over));
}

/** §9.1 保底繁殖：≤2 条且有成熟异性时提高概率 */
export function needsRescue(aliveCount) {
  return aliveCount <= POPULATION.minBreedPair;
}

/** §9.1 性别纠偏：当前性别失衡度 ∈[−1,1]，正=雄多 */
export function sexBalance(fishes) {
  let m = 0, f = 0;
  for (const fish of fishes) {
    if (fish.dead) continue;
    if (fish.sex === 'M') m++; else f++;
  }
  const total = m + f;
  return total === 0 ? 0 : (m - f) / total;
}
