/* 临时探针：把「门控漏了」与「群体耦合」分开。
 * A. 单尾圈外鱼：投喂 vs 不投喂，逐位对拍 —— 若零偏差，门控完备。
 * B. 28 尾：把耦合来源逐项关掉，看偏差怎么变化。
 */
import { PondSimulation } from '../src/engine/simulation.js';
import { FEED_CIRCLE } from '../src/engine/eco/constants.js';

const seeded = (seed = 79) => () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
const W = 1920, H = 1080;
const RADIUS = Math.min(W, H) * FEED_CIRCLE.radiusFraction;

// ---------- A. 单尾圈外鱼 ----------
console.log('\n=== A. 单尾圈外鱼（无群体耦合）===');
{
  const build = () => {
    const sim = new PondSimulation(W, H, { fishCount: 1, season: 'summer' }, seeded(20260930));
    for (let i = 0; i < 60 * 20; i++) sim.update(1 / 60);
    return sim;
  };
  const fed = build(), control = build();
  const f0 = fed.fish[0];
  // 选一个离鱼足够远的池内撒食点
  let point = null;
  for (let k = 0; k < 400 && !point; k++) {
    const x = W * (0.15 + 0.7 * ((k * 37) % 100) / 100), y = H * (0.2 + 0.6 * ((k * 61) % 100) / 100);
    if (Math.hypot(f0.x - x, f0.y - y) > RADIUS * 1.6) point = { x, y };
  }
  console.log(`     鱼在 (${f0.x.toFixed(1)}, ${f0.y.toFixed(1)})，撒食点 (${point.x.toFixed(0)}, ${point.y.toFixed(0)})，距离 ${Math.hypot(f0.x - point.x, f0.y - point.y).toFixed(1)}px > 半径 ${RADIUS}`);
  const r = fed.feed(point.x, point.y);
  console.log(`     feed() =`, JSON.stringify(r), `饲料 ${fed.food.length} 粒`);
  const before = { x: fed.fish[0].x, y: fed.fish[0].y, h: fed.fish[0].heading };
  for (let i = 0; i < 240; i++) { fed.update(1 / 60); control.update(1 / 60); }   // 4s
  const a = fed.fish[0], b = control.fish[0];
  const drift = Math.hypot(a.x - b.x, a.y - b.y);
  console.log(`     4s 后：投喂组 (${a.x.toFixed(4)}, ${a.y.toFixed(4)})  对照组 (${b.x.toFixed(4)}, ${b.y.toFixed(4)})`);
  console.log(`     位移偏差 ${drift.toExponential(3)}px  朝向偏差 ${Math.abs(a.heading - b.heading).toExponential(3)}`);
  console.log(`     鱼到撒食点距离：${Math.hypot(before.x - point.x, before.y - point.y).toFixed(1)} → ${Math.hypot(a.x - point.x, a.y - point.y).toFixed(1)}（对照组 → ${Math.hypot(b.x - point.x, b.y - point.y).toFixed(1)}）`);
}

// ---------- B. 28 尾，耦合来源分解 ----------
console.log('\n=== B. 28 尾：偏差随时间的演化 ===');
{
  const build = () => {
    const sim = new PondSimulation(W, H, { fishCount: 28, season: 'summer' }, seeded(20260930));
    for (let i = 0; i < 60 * 20; i++) sim.update(1 / 60);
    return sim;
  };
  const fed = build(), control = build();
  let point = null;
  for (let k = 0; k < 200 && !point; k++) {
    const x = W * (0.12 + 0.76 * ((k * 37) % 100) / 100), y = H * (0.16 + 0.68 * ((k * 61) % 100) / 100);
    const inside = fed.fish.filter((f) => Math.hypot(f.x - x, f.y - y) <= RADIUS);
    if (inside.length >= 3) point = { x, y };
  }
  const insideIds = new Set(fed.fish.filter((f) => Math.hypot(f.x - point.x, f.y - point.y) <= RADIUS).map((f) => f.id));
  const outsideIds = fed.fish.filter((f) => !insideIds.has(f.id)).map((f) => f.id);
  fed.feed(point.x, point.y);
  const dump = (label, n) => {
    let max = 0, over2 = 0;
    for (const id of outsideIds) {
      const a = fed.fish.find((f) => f.id === id), b = control.fish.find((f) => f.id === id);
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      max = Math.max(max, d); if (d > 2) over2++;
    }
    console.log(`     ${label.padEnd(6)} 圈外 ${outsideIds.length} 条：最大偏差 ${max.toFixed(2)}px，>2px 的 ${over2} 条`);
  };
  for (const [label, frames] of [['0.5s', 30], ['1s', 30], ['2s', 60], ['4s', 120]]) {
    for (let i = 0; i < frames; i++) { fed.update(1 / 60); control.update(1 / 60); }
    dump(label);
  }
}

// ---------- C. 圈外鱼到饲料的距离：有没有系统性靠近 ----------
console.log('\n=== C. 圈外鱼到撒食点的距离（"没被吸引"的直接度量）===');
{
  const build = () => {
    const sim = new PondSimulation(W, H, { fishCount: 28, season: 'summer' }, seeded(20260930));
    for (let i = 0; i < 60 * 20; i++) sim.update(1 / 60);
    return sim;
  };
  const fed = build(), control = build();
  let point = null;
  for (let k = 0; k < 200 && !point; k++) {
    const x = W * (0.12 + 0.76 * ((k * 37) % 100) / 100), y = H * (0.16 + 0.68 * ((k * 61) % 100) / 100);
    const inside = fed.fish.filter((f) => Math.hypot(f.x - x, f.y - y) <= RADIUS);
    if (inside.length >= 3) point = { x, y };
  }
  const insideIds = new Set(fed.fish.filter((f) => Math.hypot(f.x - point.x, f.y - point.y) <= RADIUS).map((f) => f.id));
  const outside = fed.fish.filter((f) => !insideIds.has(f.id));
  const meanDist = (list) => list.reduce((s, f) => s + Math.hypot(f.x - point.x, f.y - point.y), 0) / list.length;
  fed.feed(point.x, point.y);
  const d0 = meanDist(outside);
  let ctlMean0 = meanDist(control.fish.filter((f) => outside.some((o) => o.id === f.id)));
  for (let i = 0; i < 240; i++) { fed.update(1 / 60); control.update(1 / 60); }
  const fedOutsideNow = fed.fish.filter((f) => outside.some((o) => o.id === f.id));
  const ctlNow = control.fish.filter((f) => outside.some((o) => o.id === f.id));
  console.log(`     投喂组圈外鱼均值距离 ${d0.toFixed(1)} → ${meanDist(fedOutsideNow).toFixed(1)}  (Δ ${(meanDist(fedOutsideNow) - d0).toFixed(1)})`);
  console.log(`     对照组同批鱼均值距离 ${ctlMean0.toFixed(1)} → ${meanDist(ctlNow).toFixed(1)}  (Δ ${(meanDist(ctlNow) - ctlMean0).toFixed(1)})`);
  console.log(`     圈内鱼（投喂组）均值距离 ${meanDist(fed.fish.filter((f) => insideIds.has(f.id))).toFixed(1)}`);
  console.log(`     4s 后投喂组圈内鱼还剩 ${fed.fish.filter((f) => insideIds.has(f.id)).length} 条，饲料 ${fed.food.length} 粒`);
}
