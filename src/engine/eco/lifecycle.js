/* ============================================================================
 * lifecycle.js —— §6 生命周期状态机 / §7.6 死亡归因 / 死亡动画
 * ----------------------------------------------------------------------------
 * 死亡只有两种原因：
 *   ① 寿命耗尽：ageDays ≥ lifespanDays（基因寿命 180 × 0.8–1.2 → 12–18 天）
 *   ② 健康归零：health ≤ 0
 * ★ 饥饿不直接致死（C4 / F-7.4.4）：饱食再低也只是掉健康。
 *
 * §7.4 推演校验（C15）：完全不喂 → 饱食触底 15 → 健康 −2.4/真实天 → 约 42 天归零；
 *   而最长寿命 18 天，42 ≫ 18 ⇒ **任何个体都不可能在寿终前饿死**，安全余量充足。
 * ========================================================================== */

import { TIME, DEATH_FADE_SECONDS, STAGES } from './constants.js';

/** 基因寿命 = 基准 180 日 × 系数(0.8–1.2) */
export function lifespanOf(genes) {
  return TIME.baseLifespanDays * genes.lifespan;
}

/**
 * 判定是否死亡。返回 null 或 { cause }
 */
export function checkDeath(fish) {
  if (fish.ageDays >= fish.lifespanDays) return { cause: 'age' };
  if (fish.health <= 0) return { cause: 'health' };
  return null;
}

/**
 * 进入濒死：设置死亡动画计时（褪色 → 失衡 → 侧翻 → 沉降 → 淡出）。
 * 时长 6–10s（DEATH_FADE_SECONDS），期间仍占渲染但不再参与生态结算。
 */
export function beginDying(fish, rng) {
  fish.dying = true;
  fish.deathCause = fish.deathCause ?? 'age';
  fish.deathTimer = 0;
  fish.deathDuration = rng
    ? rng.range(DEATH_FADE_SECONDS[0], DEATH_FADE_SECONDS[1])
    : (DEATH_FADE_SECONDS[0] + DEATH_FADE_SECONDS[1]) / 2;
  fish.state = 'dying';
}

/** 推进死亡动画；返回 true 表示动画结束、可以移除 */
export function tickDying(fish, dtSeconds) {
  fish.deathTimer += dtSeconds;
  return fish.deathTimer >= fish.deathDuration;
}

/** §6 阶段推进（同时处理 F-7.2.5 老鱼入阶钳制）*/
export function advanceStage(fish, applyElderClamp) {
  const prev = fish.stage;
  let stage = STAGES[0];
  if (fish.ageDays >= 0) {
    for (let i = 1; i < STAGES.length; i++) {
      if (fish.ageDays < STAGES[i].to) { stage = STAGES[i]; break; }
      stage = STAGES[i];
    }
  }
  fish.stage = stage.key;
  if (fish.stage === 'elder' && prev !== 'elder') {
    fish.lengthCm = applyElderClamp(fish);
  }
  return fish.stage;
}

/** 鱼卵：孵化倒计时推进；返回 true 表示出苗 */
export function tickEgg(egg, dtDays) {
  egg.remainingDays -= dtDays;
  return egg.remainingDays <= 0;
}
