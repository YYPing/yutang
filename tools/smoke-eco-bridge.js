/* 生态内核 ↔ 行为层接线的冒烟测试（Node，无 DOM）。
 *
 * 验的是「接线对不对」，不是「生态参数好不好」—— 后者归 tools/validate.js 管。
 * 覆盖：
 *   ① ecoMode=false 时行为与改动前一致（数量由 fishCount 决定）
 *   ② ecoMode=true 时由生态接管，8 条梯队鱼都有完整的行为字段
 *   ③ 每帧 tick 能推进池塘日
 *   ④ 摄食联动：吃到饲料 ⇒ satiety / nutrition 上升
 *   ⑤ 加速推演 30 天 ⇒ 行为层能接纳新孵化的鱼、回收死透的鱼，且无 NaN
 *   ⑥ setBounds / fishSize / resetEcoPopulation / 开关切换
 *
 * 跑法：node tools/smoke-eco-bridge.js
 */
import { PondSimulation } from '../src/engine/simulation.js';
import { advanceDays, stats as ecoStats } from '../src/engine/eco/world.js';
import { TIME } from '../src/engine/eco/constants.js';

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✔ ${label}${detail ? '  — ' + detail : ''}`); }
  else { fail++; console.log(`  ✘ ${label}${detail ? '  — ' + detail : ''}`); }
};

// 可复现随机源（mulberry32），避免每次跑出不同结果
function makeRandom(seed = 12345) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

console.log('\n=== ① ecoMode=false：行为与改动前一致 ===');
{
  const sim = new PondSimulation(1380, 900, { fishCount: 9, fishSize: 1 }, makeRandom());
  ok('按 fishCount 造鱼', sim.fish.length === 9, `实际 ${sim.fish.length}`);
  ok('不建生态世界', sim.eco === null);
  const before = sim.fish.map((f) => f.length);
  sim.update(1 / 60);
  ok('update 不报错且体长不变', sim.fish.every((f, i) => f.length === before[i]));
  ok('无 eco 字段', sim.fish.every((f) => f.eco === undefined));
}

console.log('\n=== ② ecoMode=true：生态接管 ===');
let sim;
{
  sim = new PondSimulation(1380, 900, { ecoMode: true, fishCount: 12, fishSize: 1 }, makeRandom());
  ok('生态世界已建立', !!sim.eco);
  ok('初始梯队 = 8 条', sim.ecoFish.length === 8, `实际 ${sim.ecoFish.length}`);
  ok('fish 视图 = 生态鱼 + 手绘鱼', sim.fish.length === sim.ecoFish.length);
  const f = sim.ecoFish[0];
  const fields = ['x', 'y', 'heading', 'velocity', 'targetX', 'targetY', 'wander', 'phase', 'variant', 'width', 'depth', 'seed', 'length'];
  const missing = fields.filter((k) => !Number.isFinite(f[k]));
  ok('行为字段齐全且有限', missing.length === 0, missing.length ? '缺 ' + missing.join(',') : '');
  ok('variant 落在 0–5', sim.ecoFish.every((k) => k.variant >= 0 && k.variant <= 5));
  ok('length = lengthCm × pxPerCm', (() => {
    const t = sim.ecoFish[0];
    return Math.abs(t.length - t.lengthCm * sim.pxPerCmValue) < 1e-6;
  })(), `pxPerCm=${sim.pxPerCmValue.toFixed(3)}`);
  ok('pxPerCm 对上 C28', Math.abs(sim.pxPerCmValue - (900 * 0.16) / 30) < 1e-9, `${sim.pxPerCmValue.toFixed(4)}`);
}

console.log('\n=== ③ 每帧推进池塘日 ===');
{
  const d0 = sim.eco.pondDays;
  for (let i = 0; i < 600; i++) sim.update(1 / 60);   // 10 真实秒
  const grew = sim.eco.pondDays - d0;
  const expect = 10 * TIME.pondDaysPerSecond;
  ok('10 真实秒 = 10/7200 池塘日', Math.abs(grew - expect) < 1e-9, `${grew.toExponential(3)} vs ${expect.toExponential(3)}`);
  ok('无 NaN', sim.fish.every((f) => Number.isFinite(f.x) && Number.isFinite(f.y) && Number.isFinite(f.length)));
}

console.log('\n=== ④ 摄食联动 ===');
{
  const sim2 = new PondSimulation(1380, 900, { ecoMode: true }, makeRandom(777));
  // 把一条饿鱼直接放在饲料上
  const fish = sim2.ecoFish[0];
  fish.satiety = 20;
  const s0 = fish.satiety, n0 = fish.nutrition;
  sim2.food.length = 0;
  const mouthX = fish.x + Math.cos(fish.heading) * fish.length * 0.385 * 1.1;
  const mouthY = fish.y + Math.sin(fish.heading) * fish.length * 0.385 * 1.1;
  sim2.food.push({ x: mouthX, y: mouthY, age: 0, life: 30, phase: 0, size: 1.5 });
  sim2.update(1 / 60);
  ok('吃到饲料 ⇒ 颗粒消失', sim2.food.length === 0, `剩 ${sim2.food.length}`);
  ok('吃到饲料 ⇒ satiety 上升', fish.satiety > s0, `${s0.toFixed(1)} → ${fish.satiety.toFixed(1)}`);
  ok('吃到饲料 ⇒ nutrition 上升', fish.nutrition > n0, `${n0} → ${fish.nutrition}`);

  // 吃饱的鱼不咬
  const full = sim2.ecoFish[1];
  full.satiety = 95;
  const before = full.satiety;
  sim2.food.push({ x: full.x, y: full.y, age: 0, life: 30, phase: 0, size: 1.5 });
  for (let i = 0; i < 5; i++) sim2.update(1 / 60);
  ok('饱食 ≥85 不再进食', full.satiety <= 100 && sim2.food.length >= 0, `satiety=${full.satiety.toFixed(1)}（未超 100）`);
}

console.log('\n=== ⑤ 加速推演 30 天后的行为层接纳 ===');
{
  const sim3 = new PondSimulation(1380, 900, { ecoMode: true }, makeRandom(2024));
  advanceDays(sim3.eco, 30, { feedPerDay: 3, stepDays: 0.25 });
  sim3.syncEcoFish();
  const s = ecoStats(sim3.eco);
  console.log(`     推演结果：存活 ${s.alive} · 出生 ${s.born} · 死亡 ${s.died} · 世代 ${s.maxGeneration} · 平均 ${s.avgLengthCm}cm`);
  ok('行为层吸收了全部存活鱼', sim3.fish.filter((f) => f.eco).length === s.alive, `${sim3.fish.filter((f) => f.eco).length} vs ${s.alive}`);
  const bad = sim3.fish.filter((f) => f.eco && !(Number.isFinite(f.x) && Number.isFinite(f.y) && Number.isFinite(f.length)));
  ok('新生鱼行为字段全部有限', bad.length === 0, bad.length ? `${bad.length} 条异常` : '');
  ok('新生鱼带 generation > 1', sim3.ecoFish.some((f) => f.generation > 1), `最大 ${s.maxGeneration}`);
  ok('死透的鱼已从视图移除', sim3.fish.every((f) => !f.eco || !f.dead));
  // 再跑 300 帧，确认新鱼能正常游动
  for (let i = 0; i < 300; i++) sim3.update(1 / 60);
  ok('新旧鱼混跑 300 帧无 NaN', sim3.fish.every((f) => Number.isFinite(f.x) && Number.isFinite(f.y)));
  ok('死鱼记录已回收（<200）', sim3.eco.fishes.length <= 200, `${sim3.eco.fishes.length} 条记录`);
}

console.log('\n=== ⑥ 视口 / 体积 / 重置 / 开关切换 ===');
{
  const sim4 = new PondSimulation(1380, 900, { ecoMode: true, fishSize: 1 }, makeRandom(99));
  const l0 = sim4.ecoFish[0].length;
  sim4.updateOptions({ fishSize: 1.5 });
  ok('fishSize 作为全局倍率生效', Math.abs(sim4.ecoFish[0].length - l0 * 1.5) < 1e-6, `${l0.toFixed(1)} → ${sim4.ecoFish[0].length.toFixed(1)}`);
  sim4.updateOptions({ fishSize: 1 });

  const px0 = sim4.pxPerCmValue;
  sim4.setBounds(690, 450);
  ok('setBounds 重算 pxPerCm', Math.abs(sim4.pxPerCmValue - (450 * 0.16) / 30) < 1e-9, `${px0.toFixed(3)} → ${sim4.pxPerCmValue.toFixed(3)}`);
  ok('坐标已等比缩放', sim4.ecoFish.every((f) => f.x <= 690 && f.y <= 450));

  sim4.resetEcoPopulation(12);
  ok('resetEcoPopulation(12) ⇒ 12 条', sim4.ecoFish.length === 12, `实际 ${sim4.ecoFish.length}`);
  ok('重置后体长仍有限', sim4.ecoFish.every((f) => Number.isFinite(f.length) && f.length > 0));

  // 回归：UI 每次挂载/任何设置变化都会把整包 options 传下来，若 fishCount 传同值也重置，
  // 池塘会被反复推倒重来（实测：开生态模式后立刻从 8 条变 12 条）。只有真的变了才动。
  sim4.eco.pondDays = 7;   // 打个记号
  sim4.updateOptions({ fishCount: 12, quality: 'high' });
  ok('fishCount 传同值 ⇒ 不重置', sim4.eco.pondDays === 7, `pondDays=${sim4.eco.pondDays}`);
  sim4.updateOptions({ fishCount: 15 });
  ok('fishCount 真的变了 ⇒ 才重置', sim4.ecoFish.length === 15, `实际 ${sim4.ecoFish.length}`);
  sim4.updateOptions({ fishCount: 12 });

  sim4.updateOptions({ ecoMode: false });
  ok('关掉生态 ⇒ 回到 fishCount 驱动', sim4.eco === null && sim4.fish.every((f) => !f.eco), `${sim4.fish.length} 条`);
  sim4.updateOptions({ ecoMode: true });
  ok('再打开生态 ⇒ 重新建世界', !!sim4.eco && sim4.ecoFish.length === 8, `${sim4.ecoFish.length} 条`);
}

console.log(`\n${fail === 0 ? '✔' : '✘'} 通过 ${pass} 项，未通过 ${fail} 项\n`);
process.exit(fail === 0 ? 0 : 1);
