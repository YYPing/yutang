/* 受控实验：④c 的 +0.5697 到底是谁造成的？
 *
 * 已排除：① 抢食（门控漏网 0 次）② rng 错位（把对照组随机数流也对齐，读数不变）
 * 剩下的嫌疑：**碰撞反冲**（`koi-collision.js` 的分离会在穿透时给速度一个反冲，
 *            `resolveCollisions` 默认开 —— 见上一轮的改动）。
 *
 * 做法：同一条支线跑两遍，一遍默认（碰撞开）、一遍 `collision:false`，
 *      量「t=0 在圈外、且整个 120 帧从未进圈」那批鱼的速度超越量。
 *
 * 跑法：node tools/_probe-collision-edge.js
 */
import { PondSimulation } from '../src/engine/simulation.js';
import { FEED_CIRCLE } from '../src/engine/eco/constants.js';

const W = 1920, H = 1080;
const RADIUS = Math.min(W, H) * FEED_CIRCLE.radiusFraction;
const seeded = (s = 79) => () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
const build = (count = 28, opts = {}, seed = 20260930) => {
  const sim = new PondSimulation(W, H, { fishCount: count, season: 'summer', ...opts }, seeded(seed));
  for (let i = 0; i < 60 * 20; i++) sim.update(1 / 60);
  return sim;
};
const pickPoint = (sim, want = 3) => {
  for (let k = 0; k < 200; k++) {
    const x = W * (0.12 + 0.76 * ((k * 37) % 100) / 100), y = H * (0.16 + 0.68 * ((k * 61) % 100) / 100);
    const ins = sim.fish.filter((f) => Math.hypot(f.x - x, f.y - y) <= RADIUS);
    if (ins.length >= want) return { x, y, ids: ins.map((f) => f.id) };
  }
  return null;
};

for (const opts of [{}, { collision: false }]) {
  const tag = opts.collision === false ? 'collision:false' : 'collision:true (默认)';
  const fed = build(28, opts), ctl = build(28, opts);
  const p = pickPoint(fed);
  const outside0 = fed.fish.filter((f) => !p.ids.includes(f.id)).map((f) => f.id);
  fed.feed(p.x, p.y);
  const ever = new Set();
  for (let i = 0; i < 120; i++) {
    fed.update(1 / 60); ctl.update(1 / 60);
    for (const f of fed.fish) if (Math.hypot(f.x - p.x, f.y - p.y) <= RADIUS) ever.add(f.id);
  }
  const ids = outside0.filter((id) => !ever.has(id));
  let m = -Infinity, who = null, drift = 0;
  for (const id of ids) {
    const a = fed.fish.find((f) => f.id === id), b = ctl.fish.find((f) => f.id === id);
    const e = a.velocity - b.velocity;
    if (e > m) { m = e; who = { id, va: a.velocity, vb: b.velocity }; }
    drift = Math.max(drift, Math.hypot(a.x - b.x, a.y - b.y));
  }
  console.log(`${tag}  从未进圈 ${ids.length} 条 ⇒ 速度超越 +${m.toFixed(4)}` +
    `（${who ? `${who.id} ${who.va.toFixed(3)} vs ${who.vb.toFixed(3)}` : '-'}）· 最大位移偏差 ${drift.toFixed(2)}px`);
}
