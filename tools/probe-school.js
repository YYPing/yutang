#!/usr/bin/env node
/* ============================================================================
 * probe-school.js —— 群游参数的**单次**探针（参数从命令行给，一次跑一组）
 * ----------------------------------------------------------------------------
 * 为什么要有这个工具（而不是拿 check-stage-look.js 反复调）：
 *   check-stage-look 是**验收**：它只回答"过没过"。调参需要的是**连续量**：
 *   「fry 的公平对照从 1.02 降到 0.71」这种信息，验收脚本给不出来。
 *   而且验收脚本每天只跑 5 秒运动 —— 群游是**队形**，5 秒根本还没成型，
 *   测出来的是"刚出生随机散布"，不是"稳态队形"。
 *
 * ── 为什么要单独一个进程 ────────────────────────────────────────────────
 * `simulation.js` 在**模块加载时**就把 `SCHOOL.weight` / `SCHOOL.spaceScale`
 * 快照成了 Map（`new Map(SCHOOL.weight)`）。所以「改常量 → 再 import」这个顺序
 * 必须在**同一个模块图里第一次** import simulation.js 之前完成。
 * 于是本工具用「先静态 import constants → 改数组 → 再 await import simulation」
 * 的写法，并且**一次只跑一组参数**；扫参数用 shell 循环起多个进程。
 * （不这么做的话，第二组参数会因为模块已缓存而完全不生效，扫出来全是同一个数 —— 静默错误。）
 *
 * ── 三个量分别是什么意思 ────────────────────────────────────────────────
 *   fair    公平对照 same/control。对每条鱼：
 *             same    = 到**最近同阶段同伴**的距离
 *             control = 从全体里随机抽「与它同阶段同伴数相同」那么多条、抽 60 次，
 *                       每次取最近的那个，再对这 60 次的最近距离取平均
 *           ⇒ control 是"如果它对这些同伴完全无所谓，最近的那个会在多远"。
 *             same/control <1 = 主动凑近同类 · ≈1 = 无所谓 · >1 = 主动避开同类。
 *           ★ 为什么必须这样对照：直接比「同阶段最近邻 vs 跨阶段最近邻」是**有偏**的 ——
 *             候选池越大，最小值的期望越小，而跨阶段的鱼永远比同阶段多。
 *   overlap 同阶段最近邻距离中位数 ÷ 该组中位鱼的 `bodyRadius()`。<1 = 两尾鱼叠在一起。
 *   nn      同阶段最近邻距离中位数的绝对值（px），用来看"抱团"是不是真的发生了。
 *
 * 跑法：
 *   node tools/probe-school.js --sense=0.17 --wfry=1.45 --welder=-0.80
 *   node tools/probe-school.js --days=16 --frames=3600 --sample=60 --json
 * ========================================================================== */

import { SCHOOL } from '../src/engine/eco/constants.js';
import { advanceDays } from '../src/engine/eco/world.js';

/* ------------------------------------------------------------- 命令行参数 */

const argv = new Map();
for (const raw of process.argv.slice(2)) {
  const m = /^--([^=]+)=(.*)$/.exec(raw);
  if (m) argv.set(m[1], m[2]);
  else if (raw.startsWith('--')) argv.set(raw.slice(2), 'true');
}
const num = (key, fallback) => (argv.has(key) && Number.isFinite(Number(argv.get(key))) ? Number(argv.get(key)) : fallback);
const asJson = argv.has('json');

const W = num('w', 1440), H = num('h', 900);
const DAYS = num('days', 16);
const FRAMES = num('frames', 3600);          // 每个真实天跑多少帧运动（60fps）
const SAMPLE = num('sample', 60);            // 每多少帧取一个样本
const SEED = num('seed', 20260930);

/* ---------------------------------------------- 改常量（必须在 import 行为层之前） */

const STAGE_KEYS = ['fry', 'juvenile', 'subadult', 'adult', 'elder'];
const applied = { senseFraction: SCHOOL.senseFraction, deadZoneFraction: SCHOOL.deadZoneFraction, weight: {}, spaceScale: {} };

if (argv.has('sense')) { SCHOOL.senseFraction = num('sense', SCHOOL.senseFraction); applied.senseFraction = SCHOOL.senseFraction; }
if (argv.has('dead')) { SCHOOL.deadZoneFraction = num('dead', SCHOOL.deadZoneFraction); applied.deadZoneFraction = SCHOOL.deadZoneFraction; }
if (argv.has('elderSpeed')) { SCHOOL.elderSpeedScale = num('elderSpeed', SCHOOL.elderSpeedScale); applied.elderSpeedScale = SCHOOL.elderSpeedScale; }
if (argv.has('hill')) { SCHOOL.pullShape = argv.get('hill'); applied.pullShape = SCHOOL.pullShape; }

for (const key of STAGE_KEYS) {
  if (argv.has('w_' + key)) {
    const value = num('w_' + key, 0);
    const entry = SCHOOL.weight.find(([k]) => k === key);
    if (entry) entry[1] = value; else SCHOOL.weight.push([key, value]);
    applied.weight[key] = value;
  }
  if (argv.has('space_' + key)) {
    const value = num('space_' + key, 1);
    const entry = SCHOOL.spaceScale.find(([k]) => k === key);
    if (entry) entry[1] = value; else SCHOOL.spaceScale.push([key, value]);
    applied.spaceScale[key] = value;
  }
}

const { PondSimulation } = await import('../src/engine/simulation.js');

/* ------------------------------------------------------------------ 量具 */

const mulberry32 = (seed) => { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
const median = (list) => { if (!list.length) return NaN; const s = [...list].sort((a, b) => a - b); return s[s.length >> 1]; };
const pick = mulberry32(99);

const sim = new PondSimulation(W, H, { ecoMode: true, ecoSeed: SEED }, mulberry32(777));
const fair = {};
const overlap = {};
const bestFair = {};
const counts = {};
/** 每个阶段「到最近任一尾鱼的距离」，与**同一次采样里全池的中位**配对后取比值。*/
const isolate = {};
/** 每阶段有多少比例的样本落在离画幅边缘 13%（与 update() 的 marginX/Y 同源）的带里。*/
const wall = {};
let samples = 0;

function measure() {
  samples++;
  const pool = sim.fish.filter((f) => f.stage && !f.dead);
  const marginX = Math.min(85, W * 0.13), marginY = Math.min(75, H * 0.13);
  for (const f of pool) {
    const nearWall = f.x < marginX || f.x > W - marginX || f.y < marginY || f.y > H - marginY;
    (wall[f.stage] ??= []).push(nearWall ? 1 : 0);
  }
  if (pool.length >= 4) {
    const nearestAny = new Map();
    for (const a of pool) {
      let best = Infinity;
      for (const b of pool) if (b !== a) best = Math.min(best, Math.hypot(a.x - b.x, a.y - b.y));
      nearestAny.set(a, best);
    }
    const allMedian = median([...nearestAny.values()]);
    if (allMedian > 0) {
      for (const a of pool) (isolate[a.stage] ??= []).push(nearestAny.get(a) / allMedian);
    }
  }
  const byStage = {};
  for (const fish of pool) (byStage[fish.stage] ??= []).push(fish);

  for (const [key, list] of Object.entries(byStage)) {
    (counts[key] ??= []).push(list.length);
    if (list.length < 3) continue;

    const near = list.map((a) => Math.min(...list.filter((b) => b !== a).map((b) => Math.hypot(a.x - b.x, a.y - b.y))));
    const rep = list[Math.floor(list.length / 2)];
    const radius = sim.bodyRadius(rep);
    (overlap[key] ??= []).push(median(near) / radius);

    const bucket = (fair[key] ??= { same: [], control: [] });
    for (const a of list) {
      const candidates = pool.filter((b) => b !== a);
      if (candidates.length < list.length - 1) continue;
      bucket.same.push(Math.min(...list.filter((b) => b !== a).map((b) => Math.hypot(a.x - b.x, a.y - b.y))));
      const draws = list.length - 1;
      let acc = 0;
      for (let t = 0; t < 60; t++) {
        let best = Infinity;
        for (let k = 0; k < draws; k++) {
          const b = candidates[Math.floor(pick() * candidates.length)];
          best = Math.min(best, Math.hypot(a.x - b.x, a.y - b.y));
        }
        acc += best;
      }
      bucket.control.push(acc / 60);
    }
    if (bucket.same.length >= 4) {
      const ratio = median(bucket.same) / median(bucket.control);
      if (!(key in bestFair) || ratio < bestFair[key]) bestFair[key] = ratio;
    }
  }
}

for (let day = 1; day <= DAYS; day++) {
  advanceDays(sim.eco, 1, { feedPerDay: 2, stepDays: 0.05 });
  sim.syncEcoFish();
  for (let i = 0; i < FRAMES; i++) {
    sim.update(1 / 60);
    if (i % SAMPLE === 0) measure();
  }
}

/* ------------------------------------------------------------------ 输出 */

const rows = STAGE_KEYS.map((key) => {
  const bucket = fair[key];
  const ratio = bucket && bucket.same.length >= 6 ? median(bucket.same) / median(bucket.control) : NaN;
  return {
    stage: key,
    count: counts[key] ? median(counts[key]) : 0,
    maxCount: counts[key] ? Math.max(...counts[key]) : 0,
    n: bucket ? bucket.same.length : 0,
    same: bucket ? median(bucket.same) : NaN,
    control: bucket ? median(bucket.control) : NaN,
    fair: ratio,
    best: key in bestFair ? bestFair[key] : NaN,
    overlap: overlap[key] ? median(overlap[key]) : NaN,
    isolate: isolate[key] ? median(isolate[key]) : NaN,
    isolateN: isolate[key] ? isolate[key].length : 0,
    wall: wall[key] ? wall[key].reduce((a, b) => a + b, 0) / wall[key].length : NaN,
  };
});

if (asJson) {
  console.log(JSON.stringify({ params: applied, days: DAYS, frames: FRAMES, samples, rows }));
} else {
  console.log(`参数 sense=${applied.senseFraction} dead=${applied.deadZoneFraction} shape=${applied.pullShape ?? SCHOOL.pullShape} `
    + `weight=${JSON.stringify(Object.fromEntries(SCHOOL.weight))} space=${JSON.stringify(Object.fromEntries(SCHOOL.spaceScale))}`);
  console.log(`${DAYS} 真实天 × ${FRAMES} 帧/天，采样 ${samples} 次`);
  console.log('  阶段        中位尾数/峰值   样本   same    control  fair   best   nn/身半径  隔离度    贴边率');
  for (const r of rows) {
    console.log(`  ${r.stage.padEnd(10)} ${String(r.count).padStart(3)}/${String(r.maxCount).padEnd(4)} `
      + `${String(r.n).padStart(7)}  ${Number.isFinite(r.same) ? r.same.toFixed(0).padStart(6) : '     -'} `
      + ` ${Number.isFinite(r.control) ? r.control.toFixed(0).padStart(7) : '      -'} `
      + ` ${Number.isFinite(r.fair) ? r.fair.toFixed(2).padStart(5) : '    -'} `
      + ` ${Number.isFinite(r.best) ? r.best.toFixed(2).padStart(5) : '    -'} `
      + ` ${Number.isFinite(r.overlap) ? r.overlap.toFixed(2).padStart(8) : '       -'} `
      + ` ${Number.isFinite(r.isolate) ? (r.isolate.toFixed(2) + '(' + r.isolateN + ')').padStart(10) : '         -'}`
      + ` ${Number.isFinite(r.wall) ? (r.wall * 100).toFixed(0).padStart(5) + '%' : '     -'}`);
  }
  console.log(`  ⇒ fry fair ${Number.isFinite(rows[0].fair) ? rows[0].fair.toFixed(3) : '-'}  `
    + `elder fair ${Number.isFinite(rows[4].fair) ? rows[4].fair.toFixed(3) : '-'}  `
    + `elder 隔离 ${Number.isFinite(rows[4].isolate) ? rows[4].isolate.toFixed(3) : '-'}  `
    + `最紧 nn/身半径 ${Math.min(...rows.map((r) => r.overlap).filter(Number.isFinite)).toFixed(2)}`);
}
