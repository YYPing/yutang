/* ============================================================================
 * breed.js —— §8.1 繁殖触发 / §8.2 繁殖流程（含遗传）
 * ----------------------------------------------------------------------------
 * §8.1 全部满足才可繁殖：
 *   日龄 ≥60（名义门槛，≈5 天）／体长 ≥0.45·L_cap（★实际约束项★）／饱食 ≥40／肥满度 ≥40
 *   ／脱离冷却（雌 40 日 ≈3.3 天、雄 8 日）／拥挤度 <1.0（硬闸门）
 *
 * ⚠️ 性成熟时间（C26）：日龄门槛与体长门槛**取更晚者**。
 *    体长达标于 ≈75.8–76.8 池塘日 = 6.3–6.4 真实天 ⇒ 实际性成熟 ≈6.4 真实天，
 *    不是 5 天（5 天只是日龄门槛）。
 * ========================================================================== */

import { BREED, POPULATION } from './constants.js';

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

/** §8.1 个体是否跨过繁殖门槛（不含拥挤度，拥挤度由调用方叠加）*/
export function isMature(fish) {
  return fish.ageDays >= BREED.minAgeDays &&
         fish.lengthCm >= BREED.minLengthFraction * fish.lCapCm &&
         fish.satiety >= BREED.minSatiety &&
         fish.condition >= BREED.minCondition &&
         fish.breedCooldown <= 0;
}

/** 体长门槛达标的日龄（解 L(d) = 0.45·L_cap），用于 C26 校验 */
export function ageAtLengthFraction(lCapCm, frac, kBirth, lengthAtAgeFn) {
  let lo = 0, hi = 400;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (lengthAtAgeFn(mid, lCapCm, kBirth) < frac * lCapCm) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * 本 tick 的繁殖概率密度（每日）。返回「每池塘日触发率」。
 * 基础速率见 BREED.ratePerDay（【v4 补齐】，文档未给绝对值）。
 */
export function breedRatePerDay(fish, crowd) {
  // §9.1 软抑制：crowd>0.8 概率 ×(1−crowd)；≥1 停止（与 §8.1 硬闸门**叠加**）
  let crowdFactor = 1;
  if (crowd > POPULATION.breedSuppressAbove) {
    crowdFactor = Math.max(0, 1 - crowd);
  }
  // F-7.5.4 肥满度 <30 求偶概率减半
  let condFactor = 1;
  if (fish.condition < BREED.courtshipPenaltyBelow) condFactor = BREED.courtshipPenaltyMult;

  return BREED.ratePerDay * crowdFactor * condFactor;
}

/** §8.2 产卵数 = round(体长cm × 0.8 × FECUNDITY × (0.6 + 0.4×肥满度/100)) */
export function clutchSize(fish) {
  const condFactor = BREED.fecundityCondBase +
                     BREED.fecundityCondSpan * (fish.condition / 100);
  return Math.max(1, Math.round(fish.lengthCm * BREED.eggsPerCm * fish.genes.fecundity * condFactor));
}

/** §8.2 孵化率 = clamp(0.2, 0.9, 0.8 × (1 − crowd × 0.6)) */
export function hatchRate(crowd) {
  const raw = BREED.hatchRateBase * (1 - crowd * BREED.hatchRateCrowdFactor);
  return clamp(raw, BREED.hatchRateRange[0], BREED.hatchRateRange[1]);
}

/** 冷却重置（雌 40 日 / 雄 8 日）*/
export function resetCooldown(fish) {
  fish.breedCooldown = fish.sex === 'F' ? BREED.cooldownFemaleDays : BREED.cooldownMaleDays;
}
