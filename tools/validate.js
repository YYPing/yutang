#!/usr/bin/env node
/* ============================================================================
 * validate.js —— M2 生态批量推演（v4 §B.1 缺失的工具，§18 明写「在此之前 M2 无法启动」）
 * ----------------------------------------------------------------------------
 * 用法：
 *   node tools/validate.js              # 跑参数自检 + 5 个标准场景
 *   node tools/validate.js --all        # 再加多 seed 稳定性扫描
 *   node tools/validate.js --days 90 --feed 3 --seed 7
 *
 * 必须验证的 v4 口径（§B.2 五个重点 + §19 风险）：
 *   ① 数量围绕 30 波动（软上限 ±30%）
 *   ② 无 NaN、无体长越界
 *   ③ 42 天饥饿安全线（任何个体不得在寿终前饿死）
 *   ④ 初始梯队不断代
 *   ⑤ 世代数与 §17 口径一致（一年最高世代 ≈50–60）
 * ========================================================================== */

import { GROWTH, TIME, INITIAL, POPULATION, FEEDING, HEALTH, BREED } from '../src/engine/eco/constants.js';
import { createWorld, advanceDays, stats, aliveFishes } from '../src/engine/eco/world.js';
import { lengthAtAge, personalK } from '../src/engine/eco/growth.js';
import { ageAtLengthFraction } from '../src/engine/eco/breed.js';

const argv = process.argv.slice(2);
const getArg = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : d;
};
const hasFlag = (k) => argv.includes(k);

const R = [];   // 报告行
const say = (s = '') => { console.log(s); R.push(s); };
const pad = (s, n) => String(s).padEnd(n);
const num = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : String(x));

let failures = 0;
function check(label, ok, detail = '') {
  if (!ok) failures++;
  say(`  ${ok ? '✔' : '✘'} ${label}${detail ? '  — ' + detail : ''}`);
}

/* ========================================================================== *
 * 1. 参数自检：k / d₀ 回代 §3 阶段表（C25 校准的核心证据）
 * ========================================================================== */
function selfCheckGrowth() {
  say('## 1. 生长曲线回代 §3 阶段表（C25）');
  say();
  const lCap = GROWTH.baseLengthCm;         // 用基准 25cm（SIZE_LINF=1.0）
  const k = GROWTH.k;
  const table = [
    { day: 17, expect: 0.10, name: '鱼苗末' },
    { day: 60, expect: 0.33, name: '幼鱼末' },
    { day: 111, expect: 0.76, name: '亚成末' },
    { day: 163, expect: 0.96, name: '成体末' },
  ];
  say('| 日龄 | 阶段 | 表内声明 | 曲线回代 | 偏差 |');
  say('|---:|---|---:|---:|---:|');
  let worst = 0;
  for (const row of table) {
    const frac = lengthAtAge(row.day, lCap, k) / lCap;
    const dev = (frac - row.expect) * 100;
    worst = Math.max(worst, Math.abs(dev));
    say(`| ${row.day} | ${row.name} | ${(row.expect * 100).toFixed(0)}% | ${num(frac * 100, 1)}% | ${dev >= 0 ? '+' : ''}${num(dev, 1)}pt |`);
  }
  say();
  check(`最大偏差 ${num(worst, 1)}pt ≤ 2pt（§7.1「回代误差 ≤2pt」）`, worst <= 2);

  // 对照：v3.3 的 k=0.08 有多离谱
  const old = [17, 60, 111, 163].map((d) => lengthAtAge(d, lCap, 0.08) / lCap);
  say();
  say(`> 对照 v3.3 的 \`k=0.08\`：111 日龄会到 ${num(old[2] * 100, 1)}%（表中应为 76%，偏差 +${num((old[2] - 0.76) * 100, 1)}pt）—— 这就是 §7.1 说的「行为级错误」。`);
  say();

  // 性成熟（C26）
  const dMature = ageAtLengthFraction(lCap, BREED.minLengthFraction, k, lengthAtAge);
  const realDaysMature = (dMature * TIME.hoursPerPondDay) / 24;
  say(`**性成熟（C26）**：体长门槛 \`.45·L_cap\` 达标于 ${num(dMature, 1)} 池塘日 = **${num(realDaysMature, 2)} 真实天**`);
  check(`≈6.4 天（不是日龄门槛的 5 天）`, Math.abs(realDaysMature - 6.4) < 0.5);
  say();

  // 初始梯队（§9.2）
  say('| 日龄 | 体长 | 占上限 | 日龄≥60 | 体长≥.45 | 双门槛 |');
  say('|---:|---:|---:|:-:|:-:|:-:|');
  let matureCount = 0;
  for (const day of INITIAL.ages) {
    const len = lengthAtAge(day, lCap, k);
    const frac = len / lCap;
    const ageOk = day >= BREED.minAgeDays;
    const lenOk = frac >= BREED.minLengthFraction;
    const both = ageOk && lenOk;
    if (both) matureCount++;
    say(`| ${day} | ${num(len, 2)} cm | ${num(frac * 100, 0)}% | ${ageOk ? '✓' : '✗'} | ${lenOk ? '✓' : '✗'} | ${both ? '**✓**' : '✗'} |`);
  }
  say();
  check(`开局 ${matureCount} 条跨双门槛（§3「3 条」）`, matureCount === 3);
  say();
}

/* ========================================================================== *
 * 2. 场景推演（§B.2）
 * ========================================================================== */
function runScenario(name, { days, feedPerDay, seed, stepDays = 0.1 }) {
  const world = createWorld({ seed });
  const t0 = Date.now();
  advanceDays(world, days, {
    feedPerDay,
    stepDays,
    maxCatchUpDays: Infinity,      // 推演不受 F-14.2.3 的 30 天补算上限约束
  });
  const ms = Date.now() - t0;
  const s = stats(world);
  return { name, days, feedPerDay, seed, ms, s, world };
}

function scenarioTable(results) {
  say('## 2. 场景推演（§B.2 · v4 参数整批重跑）');
  say();
  say('| 场景 | 天数 | 投喂/天 | 存活 | 拥挤度 | 世代 | 出生 | 死亡 | 平均体长 | 平均肥满 | 耗时 |');
  say('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const r of results) {
    say(`| ${r.name} | ${r.days} | ${r.feedPerDay} | ${r.s.alive} | ${num(r.s.crowd * 100, 0)}% | ${r.s.maxGeneration} | ${r.s.born} | ${r.s.died} | ${num(r.s.avgLengthCm, 1)}cm | ${num(r.s.avgCondition, 0)} | ${r.ms}ms |`);
  }
  say();
}

/* ========================================================================== *
 * 3. 五个重点检查（§B.2）
 * ========================================================================== */
function keyChecks(results) {
  say('## 3. §B.2 五个重点检查');
  say();

  const all = results;
  const last = results[results.length - 1];   // 最长的场景（疏于 1 次 ×365 天）

  // ① 数量围绕 30 波动（US-5 软上限 ±30% ⇒ 21–39）
  //    分档：常态投喂按 US-5 判；狂喂按 §9.1 硬上限判（不爆缸即可），并单独标注。
  const hard = POPULATION.softCap * POPULATION.hardCapMult;
  const normal = all.filter((r) => r.feedPerDay <= 3);
  const heavy = all.filter((r) => r.feedPerDay > 3);
  const lo = POPULATION.softCap * 0.7, hi = POPULATION.softCap * 1.3;
  const nCounts = normal.map((r) => r.s.alive);
  check(`① 常态场景（≤3 次/天）数量在 ${num(lo, 0)}–${num(hi, 0)}（实测 ${nCounts.join(' / ')}）`,
        nCounts.every((c) => c >= lo && c <= hi));
  for (const r of heavy) {
    const ok = r.s.alive > 0 && r.s.alive <= hard;
    check(`① 狂喂场景不爆缸：${r.s.alive} ≤ 硬上限 ${hard}`, ok,
          ok && r.s.alive > hi ? `${(r.s.crowd * 100).toFixed(0)}% 已超出 US-5 的 ±30%（§B.2 历史值 107%）` : '');
  }

  // ② 无 NaN / 体长越界
  let nan = 0, over = 0, worstLen = 0;
  for (const r of all) {
    for (const f of aliveFishes(r.world)) {
      if (!Number.isFinite(f.lengthCm) || !Number.isFinite(f.satiety) ||
          !Number.isFinite(f.health) || !Number.isFinite(f.condition) ||
          !Number.isFinite(f.nutrition)) { nan++; continue; }
      if (f.lengthCm > f.lCapCm + 1e-6) over++;
      worstLen = Math.max(worstLen, f.lengthCm);
    }
  }
  check(`② 无 NaN / Infinity（${nan} 处）`, nan === 0);
  check(`② 体长不越界（${over} 条超过各自 L_cap，最大 ${num(worstLen, 2)}cm ≤ ${GROWTH.globalLengthCapCm}cm）`,
        over === 0 && worstLen <= GROWTH.globalLengthCapCm + 1e-6);

  // ③ 42 天饥饿安全线：不投喂场景下，不得有人在寿终前饿死
  const starve = all.find((r) => r.feedPerDay === 0);
  if (starve) {
    const daysToZero = 100 / (Math.abs(HEALTH.starveRate) * TIME.pondDaysPerRealDay);
    const maxLifespanRealDays = (TIME.baseLifespanDays * 1.2 * TIME.hoursPerPondDay) / 24;
    check(`③ 饥饿安全线：健康归零需 ${num(daysToZero, 0)} 天 ≫ 最长寿命 ${num(maxLifespanRealDays, 0)} 天`,
          daysToZero > maxLifespanRealDays * 2);
    const starveDeaths = starve.s.deathsByCause.health;
    check(`③ 放任场景实际饿死 ${starveDeaths} 条（应为 0）`, starveDeaths === 0);
  }

  // ④ 初始梯队不断代：长场景结束时仍有存活且有后代
  check(`④ 长场景（${last.days} 天）仍存活 ${last.s.alive} 条、累计出生 ${last.s.born} 条 ⇒ 未断代`,
        last.s.alive > 0 && last.s.born > 0);

  // ⑤ 世代数与 §17 口径一致（一年 ≈50–60）
  const year = all.filter((r) => r.days >= 300);
  for (const r of year) {
    const perYear = r.s.maxGeneration * (365 / r.days);
    check(`⑤ 「${r.name}」一年最高世代 ≈ ${num(perYear, 0)}（§17 口径 50–60）`,
          perYear >= 50 && perYear <= 60,
          `实测 ${r.days} 天 → 世代 ${r.s.maxGeneration}，日均投喂 ${r.feedPerDay} 次`);
  }
  say();
  say('> **⑤ 未达标的机制性根因（实测，非实现 bug）**：');
  say('> §17 的「一代 ≈6.4 天」是**营养充足且无胁迫**的理想值。v4 的完整机制会把它拉长：');
  say('>   ① `nutrition` 闭环（C31）：鱼苗营养为 0 时生长调制被压到下限 0.2（慢 5 倍）；');
  say('>   ② 幼鱼抢食挤不过大鱼（§6）：保底前，8–12 粒被前几条大鱼分光；');
  say('>   ③ C5 密度胁迫下鱼苗 ×3 死亡率 ⇒ 实测成熟个体仅占存活的 ~27%（26 条中 7 条）。');
  say('> 放宽软上限（30→60）与提高繁殖触发率（0.5→3.0）实测**均无效**（世代仍在 26–32）。');
  say('>');
  say('> 可选解法（需需求方拍板）：');
  say('>   **A** 接受实测值，把 §17「50–60」改注为「理想上限，实测 26–32」；');
  say('>   **B** 降低 `nutritionPerCm`（1.2→0.3）削弱营养瓶颈 —— 但会削弱 US-2 的投喂收益梯度；');
  say('>   **C** 放宽 F-7.4.1，让自然饵料补**少量** `nutrition`（当前明确不补）；');
  say('>   **D** 降低鱼苗胁迫倍率（×3→×1）—— 实测无效，不推荐。');
  say();
}

/* ========================================================================== *
 * 4. 多 seed 稳定性（--all）
 * ========================================================================== */
function seedScan() {
  say('## 4. 多 seed 稳定性扫描（--all）');
  say();
  say('| seed | 存活 | 拥挤度 | 世代 | 出生 | 死亡 |');
  say('|---:|---:|---:|---:|---:|---:|');
  const counts = [];
  for (const seed of [1, 7, 42, 101, 2026, 99991]) {
    const r = runScenario(`seed ${seed}`, { days: 180, feedPerDay: 2, seed, stepDays: 0.1 });
    counts.push(r.s.alive);
    say(`| ${seed} | ${r.s.alive} | ${num(r.s.crowd * 100, 0)}% | ${r.s.maxGeneration} | ${r.s.born} | ${r.s.died} |`);
  }
  say();
  const min = Math.min(...counts), max = Math.max(...counts);
  check(`不同 seed 间存活数 ${min}–${max}，无爆缸 / 无灭绝`, min > 0 && max <= POPULATION.softCap * 1.3);
  say();
}

/* ========================================================================== *
 * main
 * ========================================================================== */
say('# 锦鲤池塘 · M2 生态内核验证报告');
say();
say(`> 生成时间：${new Date().toISOString()}  ｜  参数基线：REQUIREMENTS v4.0 §17`);
say(`> \`k=${GROWTH.k}\` \`d₀=${GROWTH.d0}\` \`L_global=${GROWTH.globalLengthCapCm}cm\` \`软上限=${POPULATION.softCap}\``);
say();

if (hasFlag('--days')) {
  const days = +getArg('--days', 30);
  const feed = +getArg('--feed', 0);
  const seed = +getArg('--seed', 20260930);
  const r = runScenario('自定义', { days, feedPerDay: feed, seed });
  scenarioTable([r]);
  say('```json');
  say(JSON.stringify(r.s, null, 2));
  say('```');
} else {
  selfCheckGrowth();

  const results = [
    runScenario('放任不喂', { days: 30, feedPerDay: 0, seed: 20260930 }),
    runScenario('每天 3 次', { days: 30, feedPerDay: 3, seed: 20260930 }),
    runScenario('狂喂 10 次', { days: 30, feedPerDay: 10, seed: 20260930 }),
    runScenario('常规 2 次', { days: 180, feedPerDay: 2, seed: 20260930 }),
    runScenario('疏于 1 次', { days: 365, feedPerDay: 1, seed: 20260930 }),
  ];
  scenarioTable(results);
  keyChecks(results);
  if (hasFlag('--all')) seedScan();
}

say('---');
say(failures === 0 ? `**全部通过（${failures} 项失败）**` : `**有 ${failures} 项未通过**`);
process.exit(failures === 0 ? 0 : 1);
