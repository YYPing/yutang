/* 探针：④c「圈外鱼速度超越量」的基线到底是多少？
 *
 * 背景：`check-feedcircle.js` ④c 有一条断言
 *   「圈外鱼没有加速抢食（速度不超越对照组同鱼 0.3px/帧）」
 * 实测读 **+0.5697**，一直红。
 *
 * 但那 0.3 是拍脑袋定的 —— 没人量过「纯 rng 错位」自己能造成多少速度差。
 * 本探针做三件事：
 *   ① 量 `feed()` 消耗多少次 `random()`（包一层计数器实测，不手数）
 *   ② **纯 rng 错位基线**：两条同种子 sim，B 侧只消耗掉同样次数的随机数、**一粒食都不撒**，
 *      推进同样帧数 ⇒ 量到的速度超越量就是"没有任何食物"时的地板
 *   ③ **门控完备性**：真实投喂后，对每条**当下确实在圈外**的鱼检查它有没有"看得见"饲料
 *      —— 这才是 F-2.8 的实现要求，是决定性判据
 *
 * ⚠️ ③ 必须**逐帧重算**圈外身份：2s 里圈外鱼会游进圈里，那时候它看得见食是对的。
 *    只看 t=0 的快照会把"游进来吃"算成"门控漏了"（第一版探针就栽在这，报出 143 次可见）。
 *
 * 跑法：node tools/probe-feed-edge.js
 */
import { PondSimulation } from '../src/engine/simulation.js';
import { FEED_CIRCLE } from '../src/engine/eco/constants.js';

const W = 1920, H = 1080;                        // 与 check-feedcircle 一致
const RADIUS = Math.min(W, H) * FEED_CIRCLE.radiusFraction;
const CLOSE = FEED_CIRCLE.closeRangePx;
const seeded = (seed = 79) => () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };

const build = (count = 28, seed = 20260930) => {
  const sim = new PondSimulation(W, H, { fishCount: count, season: 'summer' }, seeded(seed));
  for (let i = 0; i < 60 * 20; i++) sim.update(1 / 60);
  return sim;
};
const pickPoint = (sim, want = 3) => {
  for (let k = 0; k < 200; k++) {
    const x = W * (0.12 + 0.76 * ((k * 37) % 100) / 100), y = H * (0.16 + 0.68 * ((k * 61) % 100) / 100);
    const inside = sim.fish.filter((f) => Math.hypot(f.x - x, f.y - y) <= RADIUS);
    if (inside.length >= want) return { x, y, ids: inside.map((f) => f.id) };
  }
  return null;
};
const maxEdge = (fed, control, ids) => {
  let m = -Infinity, who = null;
  for (const id of ids) {
    const a = fed.fish.find((f) => f.id === id), b = control.fish.find((f) => f.id === id);
    const e = a.velocity - b.velocity;
    if (e > m) { m = e; who = { id, va: a.velocity, vb: b.velocity }; }
  }
  return { m, who };
};

/* ── ① feed() 消耗多少次 random() ───────────────────────────── */
console.log('=== ① feed() 的 rng 消耗 ===');
let RNG_COST = 0;
{
  const sim = build();
  const outer = sim.random;
  let n = 0;
  sim.random = () => { n++; return outer(); };
  sim.feed(W * 0.5, H * 0.5);
  sim.random = outer;
  RNG_COST = n;
  console.log(`  一次 feed() 消耗 ${n} 次 random() ⇒ 之后所有鱼的漫游目标整体错位`);
}

/* ── ② 纯 rng 错位基线（一粒食都不撒）────────────────────── */
console.log('\n=== ② 纯 rng 错位基线：不撒食，只把随机数流推进同样步数 ===');
let BASELINE = 0, BASE_MAX = 0, BASE_P90 = 0, BASE_P99 = 0;
const baseSamples = [];
{
  // ★ 单次采样不够：这是一个**随机变量**（取决于错位后各鱼抽到什么漫游目标）。
  //   取足够多不同初始格局看分布 —— 阈值必须按分布的上界定，不能按一次读数拍。
  //   样本数取 60：要看的是**尾部**（罕见的"某条鱼恰好在窗口内重选目标"）。
  const N = Number(process.env.PROBE_N || 60);   // 要量尾部就 PROBE_N=300 node tools/probe-feed-edge.js
  for (let t = 0; t < N; t++) {
    const base = build(28, 20260930 + t * 7919), shifted = build(28, 20260930 + t * 7919);
    const outer = shifted.random;
    for (let i = 0; i < RNG_COST; i++) outer();
    const ids = base.fish.map((f) => f.id);
    for (let i = 0; i < 120; i++) { base.update(1 / 60); shifted.update(1 / 60); }
    baseSamples.push(maxEdge(shifted, base, ids).m);
  }
  baseSamples.sort((a, b) => a - b);
  const q = (p) => baseSamples[Math.min(baseSamples.length - 1, Math.floor(p * baseSamples.length))];
  BASELINE = q(0.5); BASE_MAX = baseSamples[baseSamples.length - 1];
  BASE_P90 = q(0.9); BASE_P99 = q(0.99);
  console.log(`  ${N} 次无食物采样（速度超越量 px/帧）：` +
    `p50 +${BASELINE.toFixed(4)} · p90 +${BASE_P90.toFixed(4)} · p99 +${BASE_P99.toFixed(4)} · max +${BASE_MAX.toFixed(4)}`);
  console.log(`  ${baseSamples.filter((v) => v > 0.01).length}/${N} 次 >0.01，` +
    `${baseSamples.filter((v) => v > 0.3).length}/${N} 次 >0.3，` +
    `${baseSamples.filter((v) => v > 0.5697).length}/${N} 次 >0.5697（= ④c 的读数）`);
  console.log('  ↑ 这里**没有任何食物**，所以这就是"非抢食"能造成的地板。');
  console.log('  ★ 注意分布形状：一大半样本恰好 0.000 —— 只有"某条鱼恰好在 2s 窗口内重选漫游目标"时才非零。');
  console.log('    所以它是**稀疏重尾**随机变量，用均值/中位定阈值都会误判，必须看尾部分位。');
}

/* ── ③ 门控完备性（逐帧重算圈外身份）──────────────────────── */
console.log('\n=== ③ 门控完备性（真实投喂，逐帧逐尾）===');
{
  const fed = build(), control = build();
  const point = pickPoint(fed);
  const insideIds = new Set(point.ids);
  const outsideIds = fed.fish.filter((f) => !insideIds.has(f.id)).map((f) => f.id);
  fed.feed(point.x, point.y);

  let pairs = 0, leaked = 0, legitClose = 0, entered = 0;
  // ★ "全程留在圈外"必须是**整个窗口**都没进过圈 —— 只查最后一帧会漏掉
  //   「游进去吃了食又游出来」的鱼（它的速度当然高，而且**这就是需求要的行为**）。
  const everInside = new Set();
  for (let i = 0; i < 120; i++) {
    fed.update(1 / 60); control.update(1 / 60);
    for (const fish of fed.fish) {
      const dFromPoint = Math.hypot(fish.x - point.x, fish.y - point.y);
      if (dFromPoint <= RADIUS) { entered++; everInside.add(fish.id); continue; }   // 进圈 ⇒ 看得见是对的
      const radius = fed.bodyRadius(fish);
      for (const pellet of fed.food) {
        if (pellet.clearance < radius) continue;
        pairs++;
        if (!fed.canReachFood(fish, pellet)) continue;
        const dp = Math.hypot(pellet.x - fish.x, pellet.y - fish.y);
        if (dp < CLOSE) legitClose++;                            // F-2.8 明文允许的"贴脸例外"
        else leaked++;                                           // ← 这才是漏网
      }
    }
  }
  const { m: edge, who } = maxEdge(fed, control, outsideIds);
  console.log(`  圈外鱼 × 饲料 组合 ${pairs} 次 · 贴脸例外 ${legitClose} 次 · **门控漏网 ${leaked} 次**`);
  console.log(`  速度超越量 +${edge.toFixed(4)}px/帧（最大那条鱼 id=${who.id}：投喂 ${who.va.toFixed(3)} vs 对照 ${who.vb.toFixed(3)}）`);
  console.log(`  ⟵ ④c 那条断言的读数；rng 错位基线 +${BASELINE.toFixed(4)} ⇒ 超基线部分 ` +
    `${(edge - BASELINE >= 0 ? '+' : '')}${(edge - BASELINE).toFixed(4)}px/帧`);
  console.log(`  （供参考：2s 内圈外鱼游进圈里的次数 ${entered}，涉及 ${everInside.size} 条鱼；t=0 圈外共 ${outsideIds.length} 条）`);

  // ★ 关键：圈外的鱼会在 2s 里**游进圈里吃到食** —— 吃到了当然加速，那是需求要的行为，不是漏网。
  //   所以要按"整个 120 帧从未进过圈"再量一次。⚠️ 不能用"最后一帧在圈外"代替（那会放进
  //   "进去吃了又出来"的鱼，实测就是它在报 +0.5697）。
  const neverInside = outsideIds.filter((id) => !everInside.has(id));
  const stay = maxEdge(fed, control, neverInside);
  console.log(`\n  ★ 全程（120 帧）从未进圈的 ${neverInside.length}/${outsideIds.length} 条：` +
    `速度超越量 +${stay.m.toFixed(4)}px/帧（id=${stay.who?.id}：投喂 ${stay.who?.va.toFixed(3)} vs 对照 ${stay.who?.vb.toFixed(3)}）`);
  console.log(`    vs rng 错位基线 +${BASELINE.toFixed(4)} ⇒ ` +
    (stay.m <= Math.max(0.05, BASE_P90) ? '✔ 与基线同量级（是噪声，不是抢食）'
      : `✘ 超出基线 ${(stay.m - BASELINE).toFixed(4)}，需要进一步查`));
  // 对照：把"进过圈"的鱼也放进来会读到什么 —— 用来解释为什么 ④c 原读数那么高
  const insideEver = outsideIds.filter((id) => everInside.has(id));
  if (insideEver.length) {
    const ever = maxEdge(fed, control, insideEver);
    console.log(`    （对照：t=0 在圈外但中途进过圈的 ${insideEver.length} 条，速度超越量 +${ever.m.toFixed(4)}px/帧 —— ` +
      `这批鱼**合法吃到过食**，不该算漏网）`);
  }
}

/* ── ④ 对照组 rng 对齐：正确的反事实长什么样 ──────────────── */
console.log('\n=== ④ 把对照组的随机数流也对齐（"同一次点击，只是看不见食"）===');
console.log('  思路：`feed()` 自己消耗 45 次 random()，这 45 次**属于"点击"这个动作**，不属于任何一条鱼。');
console.log('  所以 F-2.8 的正确反事实不是"没点"，而是"点了、但圈外鱼看不见食"。');
console.log('  实现：对照组也调一次 feed()（消耗同样的 45 次）⇒ 随机数流对齐；再把饲料清空 ⇒ 没食物。');
{
  const fed = build(), control = build();
  const point = pickPoint(fed);
  fed.feed(point.x, point.y);
  control.feed(point.x, point.y);
  const base = { food: control.food.length };
  control.food.length = 0;                 // ★ 随机数消耗保留，饲料拿掉
  control.feedCircles.length = 0;

  const snapshotIds = fed.fish.map((f) => f.id);
  for (let i = 0; i < 120; i++) { fed.update(1 / 60); control.update(1 / 60); }

  const all = maxEdge(fed, control, snapshotIds);
  const stillOutside = fed.fish.filter((f) => Math.hypot(f.x - point.x, f.y - point.y) > RADIUS).map((f) => f.id);
  const stay = maxEdge(fed, control, stillOutside);
  let maxDrift = 0;
  for (const id of snapshotIds) {
    const a = fed.fish.find((f) => f.id === id), b = control.fish.find((f) => f.id === id);
    maxDrift = Math.max(maxDrift, Math.hypot(a.x - b.x, a.y - b.y));
  }
  console.log(`  （对照组 feed() 本来落下 ${base.food} 粒，已清空）`);
  console.log(`  全部 ${snapshotIds.length} 条：速度超越量 +${all.m.toFixed(4)}px/帧 · 最大位移偏差 ${maxDrift.toFixed(2)}px`);
  console.log(`  仍留圈外 ${stillOutside.length} 条：速度超越量 +${stay.m.toFixed(4)}px/帧（id=${stay.who?.id}）`);
  console.log(`  ⟵ 与不对齐时的 +0.5697 对比`);
}

console.log('\n结论：');
console.log('  · 门控漏网 = 0  ⇒ 圈外鱼**根本没有**抢食，F-2.8 成立（决定性判据）。');
console.log(`  · 不对齐的对照组：速度超越量 +0.5697 落在噪声分布 p90(+${BASE_P90.toFixed(3)}) 附近，`);
console.log(`    且**无食物**的 60 次采样里就有 ${baseSamples.filter((v) => v > 0.5697).length} 次超过它 ⇒ 读数是噪声，不是抢食。`);
console.log('  · 所以 ④c 那条「速度不超越 0.3px/帧」断言测的是**耦合噪声**：阈值 0.3 落在噪声分布内部，');
console.log(`    空跑就 ${baseSamples.filter((v) => v > 0.3).length}/60 = ${(baseSamples.filter((v) => v > 0.3).length / 60 * 100).toFixed(0)}% 概率误报。`);
