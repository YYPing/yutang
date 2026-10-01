/* ============================================================================
 * feeding.js —— §7.3 摄食与饱食 · §7.4 自然饵料与饥饿地板 · §7.5 肥满度
 * ----------------------------------------------------------------------------
 * 本模块全部为纯函数：输入鱼的状态 + dt，输出新状态。不碰渲染、不碰 DOM。
 *
 * ★C31 闭环★ v3.3 里 `nutrition` 是个「定义了但没人读」的悬空属性。
 *   v4 把它接成生长/肥满度的原料池：
 *     投喂 → nutrition ↑  →（未到顶）被生长消耗    → 长得快
 *                          →（已到顶）全额转肥满度  → 更漂亮、更能生
 *   自然饵料**不补 nutrition**（F-7.4.1）⇒ 不投喂不仅变瘦，生长也趋缓。
 * ========================================================================== */

import { FEEDING, CONDITION, HEALTH } from './constants.js';

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

/** F-7.3.5 基础代谢（每池塘日）= 4 + 体长cm × 0.25 */
export function metabolismPerDay(lengthCm) {
  return FEEDING.metabolismBase + lengthCm * FEEDING.metabolismPerCm;
}

/**
 * F-7.4.1 自然饵料补给（每池塘日）= 代谢 × 0.93。
 *
 * ★ 留了一个 hook：若 FEEDING.forageRatioFn(satiety) 存在，则用它替代固定 0.93。
 *   为什么需要：固定 0.93 意味着净亏 7% 恒定，饱食必然单调降到地板 15，
 *   而繁殖门槛要求饱食 ≥40 ⇒ 长期不投喂必然断代，与 US-5「长期无人干预数量稳定」冲突。
 *   「觅食努力度」是最小改动的解法：饱食越低觅食越积极，形成负反馈平衡点。
 *   ⚠️ 现默认启用（FEEDING.forageRatioFn），因为不启用会与 US-5 冲突；
 *      论证与回退方式见 constants.js 内该字段的注释。
 */
export function forageFor(fish) {
  const ratio = typeof FEEDING.forageRatioFn === 'function'
    ? FEEDING.forageRatioFn(fish.satiety)
    : FEEDING.forageRatio;
  return metabolismPerDay(fish.lengthCm) * ratio;
}

/**
 * 推进一个 tick 的饱食 / 健康 / 肥满度 / nutrition。
 * @param fish  鱼（含 satiety/health/condition/nutrition/lengthCm/lCapCm/ageDays）
 * @param dtDays 本 tick 的池塘日数
 */
export function tickFeeding(fish, dtDays) {
  const metab = metabolismPerDay(fish.lengthCm);

  // F-7.4.1 自然饵料：只补饱食，不补 nutrition
  const forage = forageFor(fish);

  let satiety = fish.satiety + (forage - metab) * dtDays;
  // F-7.4.3 饥饿地板
  satiety = Math.max(FEEDING.satietyFloor, satiety);

  // F-7.4.5 / F-7.4.6 健康
  let health = fish.health;
  if (satiety < HEALTH.starveBelow) health += HEALTH.starveRate * dtDays;
  else if (satiety >= HEALTH.recoverAbove) health += HEALTH.recoverRate * dtDays;
  health = clamp(health, 0, HEALTH.max);

  // F-7.5.1 肥满度以 driftRate 趋向当前饱食（时间常数 ≈20 池塘日）
  let condition = fish.condition + (satiety - fish.condition) * CONDITION.driftRate * dtDays;
  // F-7.5.2 日衰减 −2
  condition -= CONDITION.dailyDecay * dtDays;

  let nutrition = fish.nutrition;
  const atCap = fish.lengthCm >= fish.lCapCm - 1e-9;

  if (atCap) {
    // F-7.5.2 到顶后：nutrition 盈余全额转入肥满度
    const canTransfer = Math.min(nutrition, CONDITION.maxTransferPerDay * dtDays);
    condition += canTransfer * CONDITION.conditionPerNutrition;
    nutrition -= canTransfer;
  }

  condition = clamp(condition, 0, 100);

  return { satiety, health, condition, nutrition };
}

/** F-7.3.2 吃下一粒饲料的效果 */
export function eatPellet(fish) {
  return {
    satiety: Math.min(100, fish.satiety + FEEDING.pelletSatiety),
    nutrition: fish.nutrition + FEEDING.pelletNutrition,
  };
}

/** F-7.3.4 是否参与抢食：感应圈内、饱食 <85 */
export function wantsFood(fish) {
  return fish.satiety < FEEDING.forageSatietyCeiling;
}

/**
 * F-7.3.8 生长调制系数。注意 nutrition 耗尽时回落到下限 0.2。
 */
export function growthMod(fish) {
  if (fish.nutrition <= 0) return FEEDING.growthModRange[0];
  return clamp(fish.satiety / FEEDING.growthModDivisor, ...FEEDING.growthModRange);
}

/** F-7.3.9 低饱食 → 活力 50%、感知 ×1.5 */
export function lowSatietyFactors(fish) {
  const low = fish.satiety < FEEDING.lowSatietyThreshold;
  return { vitality: low ? 0.5 : 1, perception: low ? 1.5 : 1 };
}
