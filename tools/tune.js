#!/usr/bin/env node
/* ============================================================================
 * tune.js —— 数值诊断：定位「不投喂即灭绝 / 世代数偏低」的根因
 * ----------------------------------------------------------------------------
 * 只做诊断，不改 constants.js 的定稿值（跑完自动还原）。
 *
 * 两处单位/口径歧义：
 *   A) CONDITION.dailyDecay 的「日」= 池塘日 还是 真实天？
 *      §7.5.2「日衰减 −2」；§17「driftRate .05（时间常数 ≈20 日），日衰 −2」；
 *      而 §7.5.1 明写「时间常数 ≈20 池塘日 ≈ 1.7 天」⇒ §17 的「日」= 池塘日。
 *      按池塘日则是 −24/真实天，肥满度存不住（实测均值掉到 18）。
 *   B) FEEDING.forageRatio 是否恒定 0.93？
 *      恒定 ⇒ 饱食单调降到地板 15 ⇒ 低于繁殖门槛 40 ⇒ 不投喂必然断代，
 *      与 US-5「长期无人干预，数量稳定在软上限 ±30%」冲突。
 * ========================================================================== */

import { CONDITION, FEEDING, TIME, POPULATION } from '../src/engine/eco/constants.js';
import { createWorld, advanceDays, stats, aliveFishes } from '../src/engine/eco/world.js';

const orig = { dailyDecay: CONDITION.dailyDecay, forageFn: FEEDING.forageRatioFn };

/**
 * 觅食努力度：饱食越低越努力，使自然饵料形成负反馈。
 * 平衡点满足 ratio(s)=1 ⇒ 0.93 + 0.15·(70−s)/50 = 1 ⇒ s ≈ 46.7（高于繁殖门槛 40）。
 */
const driveFn = (satiety) => {
  const drive = Math.max(0, Math.min(1, (70 - satiety) / 50));
  return 0.93 + 0.15 * drive;
};

function scenario(label, { days, feedPerDay, seed = 20260930 }) {
  const world = createWorld({ seed });
  advanceDays(world, days, { feedPerDay, stepDays: 0.1, maxCatchUpDays: Infinity });
  const s = stats(world);
  const satAvg = aliveFishes(world).length
    ? aliveFishes(world).reduce((a, f) => a + f.satiety, 0) / aliveFishes(world).length : 0;
  return { label, ...s, satAvg, perYear: s.maxGeneration * (365 / days) };
}

const combos = [
  { name: 'A0      日衰=2/池塘日（文档字面）+ 恒定 .93', decay: 2, drive: false },
  { name: 'A1      日衰=2/真实天（÷12）      + 恒定 .93', decay: 2 / 12, drive: false },
  { name: 'A0+B    日衰=2/池塘日            + 觅食驱动', decay: 2, drive: true },
  { name: 'A1+B    日衰=2/真实天（÷12）      + 觅食驱动', decay: 2 / 12, drive: true },
];

const scenes = [
  ('放任 30 天', { days: 30, feedPerDay: 0 }),
];

for (const c of combos) {
  CONDITION.dailyDecay = c.decay;
  FEEDING.forageRatioFn = c.drive ? driveFn : undefined;

  console.log(`\n=== ${c.name} ===`);
  const rows = [
    scenario('放任 30 天', { days: 30, feedPerDay: 0 }),
    scenario('常规 2 次 180 天', { days: 180, feedPerDay: 2 }),
    scenario('疏于 1 次 365 天', { days: 365, feedPerDay: 1 }),
  ];
  for (const r of rows) {
    console.log(
      `  ${r.label.padEnd(16)} 存活 ${String(r.alive).padStart(3)}  拥挤 ${(r.crowd * 100).toFixed(0).padStart(3)}%  ` +
      `世代 ${String(r.maxGeneration).padStart(3)} (年化 ${r.perYear.toFixed(0).padStart(3)})  ` +
      `出生 ${String(r.born).padStart(4)}  肥满 ${r.avgCondition.toFixed(0).padStart(2)}  饱食 ${r.satAvg.toFixed(0)}`);
  }
}

/* -------------------------------------------------------------------------- *
 * 频次扫描：在 A1+B（唯一不灭绝的组合）下，投喂频次 → 存活 / 世代
 * 目的是核实 §17「一年最高世代 ≈50–60」到底需要多少投喂量才能达到。
 * -------------------------------------------------------------------------- */
CONDITION.dailyDecay = 2 / 12;
FEEDING.forageRatioFn = driveFn;
console.log('\n=== 频次扫描（A1+B：日衰=2/真实天 + 觅食驱动，365 天）===');
console.log('  投喂/天 | 存活 | 拥挤 | 世代 | 年化世代 | 出生 | 肥满 | 饱食 | 平均体长');
console.log('  ---:|---:|---:|---:|---:|---:|---:|---:|---:|');
for (const f of [0, 1, 2, 3, 5, 10]) {
  const r = scenario(`f${f}`, { days: 365, feedPerDay: f });
  console.log(`  ${String(f).padStart(6)} | ${String(r.alive).padStart(4)} | ${(r.crowd * 100).toFixed(0).padStart(3)}% | ${String(r.maxGeneration).padStart(4)} | ${r.perYear.toFixed(0).padStart(8)} | ${String(r.born).padStart(4)} | ${r.avgCondition.toFixed(0).padStart(4)} | ${r.satAvg.toFixed(0).padStart(4)} | ${r.avgLengthCm.toFixed(1).padStart(6)}cm`);
}

/* -------------------------------------------------------------------------- *
 * nutritionPerCm 扫描：这是【v4 补齐】的参数（文档只给了机制没给绝对值）。
 * 它同时决定两件事：① 世代速率（营养是性成熟的瓶颈）② US-2 投喂的可见收益。
 * 目标：每天 3 次投喂下，365 天世代落在 §17 口径 50–60。
 * -------------------------------------------------------------------------- */
import { CONDITION as C2, BREED } from '../src/engine/eco/constants.js';
CONDITION.dailyDecay = 2 / 12;
FEEDING.forageRatioFn = driveFn;
console.log('\n=== 繁殖触发率 × 营养单价 扫描（A1+B，每天 3 次 × 365 天）===');
console.log('  目标：年化世代 50–60（§17）｜ 存活 21–39（软上限 ±30%）');
console.log();
console.log('  ratePerDay \\ nutritionPerCm |   0.5 |   0.8 |   1.2');
console.log('  ---:|---:|---:|---:|');
for (const rate of [0.5, 1.0, 1.5, 2.0, 3.0]) {
  BREED.ratePerDay = rate;
  const cells = [];
  for (const npc of [0.5, 0.8, 1.2]) {
    C2.nutritionPerCm = npc;
    const r = scenario('x', { days: 365, feedPerDay: 3 });
    cells.push(` ${String(r.maxGeneration).padStart(2)}/${String(r.alive).padStart(2)} `);
  }
  console.log(`  ${String(rate).padStart(25)} |${cells.join('|')}|`);
}
console.log('  （单元格 = 世代/存活）');
BREED.ratePerDay = 1.5;
C2.nutritionPerCm = 1.2;

CONDITION.dailyDecay = orig.dailyDecay;
FEEDING.forageRatioFn = orig.forageFn;
console.log('\n（常量已还原，不影响 validate.js）');
console.log('目标：存活 21–39 ｜ 年化世代 50–60 ｜ 三个场景都不为 0');
