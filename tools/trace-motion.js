/* 非生态运动轨迹基线（逐位回归守卫）。
 *
 * ── 为什么需要它 ─────────────────────────────────────────────────────
 * C 方案要给鱼加「阶段群游」（§6 鱼苗紧密群游 / 老鱼离群独处）。这条改动写进了
 * `simulation.js` 那个 **O(n²) 邻居循环**里 —— 而那个循环同时也是**手绘鱼**（非生态）
 * 唯一的避让逻辑。
 *
 * 于是风险是：给生态鱼加的聚合项，会不会顺手动到手绘鱼的浮点路径？
 *   `node --test` 的 251 个测试**发现不了**这种"数值上差一点点"的问题 ——
 *   它们断言的是范围（速度变异 .15–.45 之类），不是逐位相等。
 *
 * 所以这里做一件很硬的事：改动**之前**用固定种子跑一遍非生态池子，
 * 把每一帧每一条鱼的 x/y/heading/velocity/phase/angularVelocity 全部量化成
 * 字符串、连起来取 sha256，把**摘要**存进 fixture。
 * 改动**之后**再跑一遍，摘要必须**一字不差**。
 *
 * ★ 为什么摘要里不含体长：`length` 会随 `fishSize` 变，而本工具要守的是**运动**。
 *   体长的守卫在 tests/ 里。
 *
 * ── 三个场景（后加的，见 SCENARIOS 上的注释）──────────────────────────
 *   normal / reduced-motion  碰撞**关** ⇒ 守「转向路径」的历史基线，永不重录
 *   collision-on             碰撞**开** ⇒ 守新加的分离层
 * 加碰撞功能时**没有**重录前两个场景的摘要（实测两行摘要逐字符相同），
 * 这正是"碰撞层之外手绘鱼运动一字未改"的证据。
 *
 * 用法：
 *   node tools/trace-motion.js --record   # 改动前录基线（只跑一次）
 *   node tools/trace-motion.js            # 改动后核验
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PondSimulation } from '../src/engine/simulation.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = join(ROOT, 'tools', 'fixtures', 'motion-baseline.json');

/** 固定种子 RNG（mulberry32）。用自带 rng 而不是 Math.random，基线才可复现。*/
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 场景表。三个场景覆盖：
 *  · normal / reduced-motion —— **碰撞关**，守「转向路径」的逐位基线（历史基线，不可变）
 *  · collision-on           —— **碰撞开**，守新加的分离力（这是唯一会动手绘鱼运动的新层）
 *
 * ⚠️⚠️ 为什么前两个场景要显式写 `collision: false`：
 *   本工具的职责是守**转向/邻居循环**的浮点路径别被无关改动污染。
 *   碰撞是**有意新增**的一层，它本来就该改变鱼的运动 —— 若让它进前两个场景，
 *   基线会因"预期的原因"变红 ⇒ 只能重录 ⇒ **历史基线就废了**，
 *   以后再也无法回答"转向路径到底有没有被动过"。
 *   所以：转向路径与碰撞层**分开守**。前两个场景开着碰撞关，
 *   等于持续证明「碰撞层之外，手绘鱼运动一字未改」。
 */
const SCENARIOS = [
  { name: 'normal', seed: 12345, options: {} },
  { name: 'reduced-motion', seed: 24680, options: { reducedMotion: true } },
  { name: 'collision-on', seed: 13579, options: { collision: true } },
];

const BASE = {
  season: 'autumn', weather: 'sunny', night: false, paused: false,
  reducedMotion: false, fishCount: 18, fishSize: 1.1, turtleCount: 0,
  quality: 'high', ecoMode: false,
  // 见上面 SCENARIOS 的注释：默认关，由 `collision-on` 单独打开。
  collision: false,
};

const WIDTH = 1440;
const HEIGHT = 900;
const FRAMES = 600;
const DT = 1 / 60;
/** 每段投喂：[帧号, x, y]；另在手部扰动帧调用 pointer()。*/
const EVENTS = [
  { frame: 90, kind: 'pointer', x: 380, y: 300 },
  { frame: 120, kind: 'feed', x: 420, y: 340 },
  { frame: 300, kind: 'feed', x: 1020, y: 520 },
  { frame: 450, kind: 'pointer', x: 900, y: 260 },
  { frame: 500, kind: 'feed', x: 300, y: 620 },
];

const FIELDS = ['x', 'y', 'heading', 'velocity', 'phase', 'angularVelocity'];

function digestOf(scenario) {
  const sim = new PondSimulation(WIDTH, HEIGHT, { ...BASE, ...scenario.options }, mulberry32(scenario.seed));
  const hash = createHash('sha256');
  const events = EVENTS.map((e) => ({ ...e }));
  let fed = 0;

  hash.update(`scenario:${scenario.name}|${WIDTH}x${HEIGHT}|${FRAMES}|${JSON.stringify(scenario.options)}\n`);
  for (let frame = 0; frame < FRAMES; frame++) {
    for (const event of events) {
      if (event.frame !== frame) continue;
      if (event.kind === 'feed') { sim.feed(event.x, event.y); fed++; }
      else sim.pointer(event.x, event.y, true);
    }
    // 手部扰动只活 0.85s，到点得松开，否则后半场一直惊着鱼、测不到巡游。
    if (frame === 130 || frame === 490) sim.pointer(0, 0, false);
    sim.update(DT);
    hash.update(`f${frame}`);
    for (const fish of sim.fish) {
      for (const field of FIELDS) hash.update(`${fish[field].toFixed(9)},`);
    }
    // 饲料与涟漪也在动，一并纳入（它们是 feed() 随机序列的下游消耗者）
    for (const pellet of sim.food) hash.update(`${pellet.x.toFixed(9)},${pellet.y.toFixed(9)},`);
    for (const ripple of sim.ripples) hash.update(`${ripple.x.toFixed(9)},${ripple.y.toFixed(9)},`);
  }
  return {
    digest: hash.digest('hex'),
    fishCount: sim.fish.length,
    foodLeft: sim.food.length,
    feedsAccepted: fed,
    simTime: +sim.time.toFixed(6),
  };
}

function run() {
  const record = process.argv.includes('--record');
  const results = SCENARIOS.map((s) => ({ name: s.name, ...digestOf(s) }));

  if (record) {
    mkdirSync(dirname(FIXTURE), { recursive: true });
    writeFileSync(FIXTURE, `${JSON.stringify({ width: WIDTH, height: HEIGHT, frames: FRAMES, results }, null, 2)}\n`);
    for (const r of results) console.log(`记录 ${r.name.padEnd(16)} sha256 ${r.digest.slice(0, 16)}…  鱼 ${r.fishCount} 剩食 ${r.foodLeft}`);
    console.log(`\n基线已写入 ${FIXTURE.replace(ROOT, '.')}`);
    return;
  }

  let base;
  try {
    base = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  } catch {
    console.error(`找不到基线 ${FIXTURE}，先跑 node tools/trace-motion.js --record`);
    process.exit(1);
  }

  let failed = 0;
  console.log('非生态运动轨迹逐位核验（手绘鱼必须与改动前完全一致）\n');
  for (const now of results) {
    const before = base.results.find((r) => r.name === now.name);
    const same = before && before.digest === now.digest;
    if (!same) failed++;
    console.log(`  ${same ? '✔' : '✘'} ${now.name.padEnd(16)} ${same ? '逐位一致' : '轨迹已变'}  ${now.digest.slice(0, 16)}…`);
    if (!same && before) console.log(`      基线 ${before.digest.slice(0, 16)}…  鱼 ${before.fishCount}→${now.fishCount} 时间 ${before.simTime}→${now.simTime}`);
  }
  console.log(`\n${results.length - failed}/${results.length} 场景逐位一致`);
  if (failed) {
    console.error('\n★ 手绘鱼（非生态）的运动被改动了。群游必须只作用于 fish.stage 存在的生态鱼。');
    process.exit(1);
  }
}

run();
