/* 碰撞体积（胶囊体）的验收：几何正确性 + 开关的零回归保证。
 *
 * ⚠️ 这个文件要守两件**方向相反**的事，别混：
 *   ① **开着**时：鱼真的会互相推开、不穿透、不产生 NaN、不飞出池子。
 *   ② **关着**时：`resolveCollisions` **一次都不能被调用** ——
 *      这是「与改动前逐位一致」的机制保证（逐位本身由 tools/trace-motion.js 守）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PondSimulation } from '../src/engine/simulation.js';
import { koiBody, capsuleOverlap, closestSegmentPoints, COLLISION } from '../src/engine/koi-collision.js';
import { WIDTH_PEAK } from '../src/engine/koi-motion.js';

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const W = 1440, H = 900;
const OPT = { season: 'autumn', weather: 'sunny', fishCount: 12, quality: 'high', ecoMode: false };
const mkSim = (extra = {}, seed = 7) => new PondSimulation(W, H, { ...OPT, ...extra }, mulberry32(seed));

const scaleOf = (sim) => Math.min(Math.max(Math.min(sim.width / 1250, sim.height / 780), .78), 1.15);

/** 造一条位置/朝向可控的鱼，其余字段从真实鱼里拷，避免"测试用的假鱼"与真鱼形状不一致。 */
function place(sim, i, { x, y, heading }) {
  const f = sim.fish[i];
  f.x = x; f.y = y; f.heading = heading;
  f.velocity = 0; f.speed = 0; f.turn = 0; f.angularVelocity = 0;
  f.targetX = x; f.targetY = y;
  return f;
}

/* ───────────────────────── 几何 ───────────────────────── */

test('碰撞段是体长的 78%，半径与渲染轮廓同源（WIDTH_PEAK）', () => {
  const fish = { x: 0, y: 0, heading: 0, length: 100, width: 0.12 };
  const b = koiBody(fish, 1);
  const span = Math.hypot(b.x2 - b.x1, b.y2 - b.y1);
  assert.ok(Math.abs(span - 100 * COLLISION.spanFraction) < 1e-9, `段长应为 78，实得 ${span}`);
  const expectR = 100 * 0.12 * WIDTH_PEAK * COLLISION.radiusScale;
  assert.ok(Math.abs(b.r - expectR) < 1e-9, `半径应与 WIDTH_PEAK 同源，期望 ${expectR}，实得 ${b.r}`);
  // 反向验证：手抄常数会差一个数量级（我踩过，抄成 .0602 时 r 掉到 1px 下限）
  assert.ok(b.r > 3, `半径 ${b.r} 太小 ⇒ 疑似把峰值系数抄错了`);
});

test('半径下限钳制到 1px（极小/极瘦的鱼不会出现零半径）', () => {
  const tiny = { x: 0, y: 0, heading: 0, length: 2, width: 0.01 };
  assert.equal(koiBody(tiny, 1).r, 1);
});

test('线段最近点：平行两段 → 距离等于横向间距', () => {
  const c = closestSegmentPoints(0, 0, 10, 0, 0, 5, 10, 5);
  assert.ok(Math.abs(c.dist - 5) < 1e-9, `期望 5，实得 ${c.dist}`);
});

test('线段最近点：十字交叉 → 距离 0', () => {
  const c = closestSegmentPoints(-5, 0, 5, 0, 0, -5, 0, 5);
  assert.ok(c.dist < 1e-9, `相交距离应为 0，实得 ${c.dist}`);
});

test('线段最近点：端点到端点（共线不重叠）', () => {
  const c = closestSegmentPoints(0, 0, 1, 0, 4, 0, 5, 0);
  assert.ok(Math.abs(c.dist - 3) < 1e-9, `期望 3，实得 ${c.dist}`);
});

test('线段最近点：退化成点（零长段）不产生 NaN', () => {
  const c = closestSegmentPoints(2, 2, 2, 2, 0, 0, 4, 0);
  assert.ok(Number.isFinite(c.dist) && Math.abs(c.dist - 2) < 1e-9, `实得 ${c.dist}`);
  const d = closestSegmentPoints(1, 1, 1, 1, 3, 3, 3, 3);
  assert.ok(Number.isFinite(d.dist) && Math.abs(d.dist - Math.hypot(2, 2)) < 1e-9, `实得 ${d.dist}`);
});

test('★ 胶囊体比圆贴合鱼形：并排且横向间距超过 2r 的两条鱼不算碰撞', () => {
  // 两条同向、并排的鱼。若用圆（半径 = bodyRadius ≈ 体长×.66）会误判为大幅重叠。
  const a = { x: 0, y: 0, heading: 0, length: 100, width: 0.12 };
  const b = { x: 0, y: 40, heading: 0, length: 100, width: 0.12 };
  const ba = koiBody(a, 1), bb = koiBody(b, 1);
  assert.equal(capsuleOverlap(ba, bb), null, '横向间距 40px > 2r，不该判为碰撞（圆会误判）');
  // 同一条鱼，用圆口径的半径来比：早就"重叠"了
  const circleR = 100 * .66 + 5;
  assert.ok(circleR * 2 > 40, '对照组：圆口径确实会误判，说明这条断言有区分力');
});

test('穿透深度与法线方向正确（法线由 b 指向 a）', () => {
  const a = { x: 0, y: 0, heading: 0, length: 100, width: 0.12 };
  const b = { x: 0, y: 5, heading: 0, length: 100, width: 0.12 };
  const ba = koiBody(a, 1), bb = koiBody(b, 1);
  const hit = capsuleOverlap(ba, bb);
  assert.ok(hit, '应判为碰撞');
  assert.ok(Math.abs(hit.depth - (ba.r + bb.r - 5)) < 1e-9, `深度应为 r+r-5，实得 ${hit.depth}`);
  assert.ok(Math.abs(Math.hypot(hit.nx, hit.ny) - 1) < 1e-9, '法线必须是单位向量');
  assert.ok(hit.ny < 0, `法线应由 b 指向 a（a 在上方 ⇒ ny<0），实得 ny=${hit.ny}`);
});

test('完全重合的胶囊体不产生 NaN，且法线仍是单位向量', () => {
  const a = { x: 0, y: 0, heading: 0.3, length: 100, width: 0.12 };
  const hit = capsuleOverlap(koiBody(a, 1), koiBody({ ...a }, 1));
  assert.ok(hit, '完全重合应判为碰撞');
  assert.ok(Number.isFinite(hit.nx) && Number.isFinite(hit.ny) && Number.isFinite(hit.depth));
  assert.ok(Math.abs(Math.hypot(hit.nx, hit.ny) - 1) < 1e-9, '退化情形也必须给出单位法线');
});

/* ───────────────────────── 开关（零回归） ───────────────────────── */

test('★ 碰撞关闭时 resolveCollisions 一次都不被调用（零回归的机制保证）', () => {
  const sim = mkSim({ collision: false });
  let called = 0;
  const real = sim.resolveCollisions.bind(sim);
  sim.resolveCollisions = (...args) => { called++; return real(...args); };
  for (let i = 0; i < 240; i++) sim.update(1 / 60);
  assert.equal(called, 0, '关掉开关后不应进入碰撞求解，否则「逐位一致」无从谈起');
});

test('碰撞默认为开（老存档缺这个键时升级即生效）', () => {
  const sim = mkSim();
  assert.notEqual(sim.options.collision, false, '默认应为开');
  let called = 0;
  const real = sim.resolveCollisions.bind(sim);
  sim.resolveCollisions = (...args) => { called++; return real(...args); };
  for (let i = 0; i < 120; i++) sim.update(1 / 60);
  assert.ok(called > 0, '默认开启时应当被调用');
});

test('显式传 collision:false 后，即便中途换回 true 也能重新生效', () => {
  const sim = mkSim({ collision: false });
  let called = 0;
  const real = sim.resolveCollisions.bind(sim);
  sim.resolveCollisions = (...args) => { called++; return real(...args); };
  for (let i = 0; i < 30; i++) sim.update(1 / 60);
  assert.equal(called, 0);
  sim.updateOptions({ collision: true });
  for (let i = 0; i < 30; i++) sim.update(1 / 60);
  assert.ok(called > 0, '开关必须可逆');
});

/* ───────────────────────── 分离行为 ───────────────────────── */

test('两条重叠的鱼会被推开，最终不再重叠', () => {
  const sim = mkSim({ collision: true, fishCount: 3 });
  const a = place(sim, 0, { x: 600, y: 450, heading: 0 });
  const b = place(sim, 1, { x: 604, y: 450, heading: 0 });   // 几乎完全重合
  sim.fish = [a, b];   // 只留这两条，排除第三条的干扰
  const before = capsuleOverlap(koiBody(a, scaleOf(sim)), koiBody(b, scaleOf(sim)));
  assert.ok(before && before.depth > 0, '初始应处于重叠状态');
  const d0 = before.depth;
  // ⚠️ 别断言「变成 null」：位置修正是**渐近收敛**的（每步残留 1−correction = 62%），
  //    数学上永远差一点点。40 次后残差约 1e-5 px，视觉上早就是零。
  //    断言写成 null 会把一个正确的收敛过程判成失败（我就这么错过一次）。
  for (let i = 0; i < 40; i++) sim.resolveCollisions(1 / 60);
  const after = capsuleOverlap(koiBody(a, scaleOf(sim)), koiBody(b, scaleOf(sim)));
  const residual = after ? after.depth : 0;
  assert.ok(residual < 1e-3, `40 次求解后残差应可忽略，实得 ${residual}`);
  assert.ok(residual / d0 < 1e-4, `相对初始深度应衰减到万分之一以下，实得 ${(residual / d0).toExponential(2)}`);
});

test('等质量的两条鱼被推开时位移对称（不会单方面后退）', () => {
  const sim = mkSim({ collision: true });
  const a = place(sim, 0, { x: 600, y: 450, heading: 0 });
  const b = place(sim, 1, { x: 603, y: 450, heading: 0 });
  a.length = b.length = 60;   // 同体长 ⇒ 同质量
  sim.fish = [a, b];
  const a0 = { x: a.x, y: a.y }, b0 = { x: b.x, y: b.y };
  sim.resolveCollisions(1 / 60);
  const da = Math.hypot(a.x - a0.x, a.y - a0.y);
  const db = Math.hypot(b.x - b0.x, b.y - b0.y);
  assert.ok(da > 0 && db > 0, '两边都该动');
  assert.ok(Math.abs(da - db) < 1e-9, `对称质量应等距推开，实得 ${da} vs ${db}`);
});

test('大鱼推小鱼：小鱼位移更大（质量按体长平方）', () => {
  const sim = mkSim({ collision: true });
  const big = place(sim, 0, { x: 600, y: 450, heading: 0 });
  const small = place(sim, 1, { x: 603, y: 450, heading: 0 });
  big.length = 100; small.length = 40;
  sim.fish = [big, small];
  const s0 = { x: small.x, y: small.y }, b0 = { x: big.x, y: big.y };
  sim.resolveCollisions(1 / 60);
  const dBig = Math.hypot(big.x - b0.x, big.y - b0.y);
  const dSmall = Math.hypot(small.x - s0.x, small.y - s0.y);
  assert.ok(dSmall > dBig * 2, `小鱼位移应显著更大，实得 大 ${dBig.toFixed(4)} / 小 ${dSmall.toFixed(4)}`);
});

test('分离力不会把鱼推出池子外', () => {
  const sim = mkSim({ collision: true, fishCount: 2 });
  // 把两条鱼塞到贴着左上角的角落，重叠
  const a = place(sim, 0, { x: 40, y: 40, heading: 0 });
  const b = place(sim, 1, { x: 44, y: 44, heading: 0 });
  sim.fish = [a, b];
  for (let i = 0; i < 60; i++) sim.resolveCollisions(1 / 60);
  for (const f of sim.fish) {
    assert.ok(Number.isFinite(f.x) && Number.isFinite(f.y), '位置不得为 NaN');
    assert.ok(f.x >= 0 && f.x <= W && f.y >= 0 && f.y <= H, `鱼被推出池外：(${f.x}, ${f.y})`);
  }
});

test('长时间开启碰撞：位置全程有限、速度非负、不出现数值爆炸', () => {
  const sim = mkSim({ collision: true, fishCount: 20 }, 99);
  let maxSpeed = 0;
  for (let i = 0; i < 1200; i++) {
    sim.update(1 / 60);
    for (const f of sim.fish) {
      assert.ok(Number.isFinite(f.x) && Number.isFinite(f.y), `第 ${i} 帧出现 NaN 位置`);
      assert.ok(Number.isFinite(f.velocity) && f.velocity >= 0, `第 ${i} 帧速度异常：${f.velocity}`);
      assert.ok(f.velocity < 1e4, `第 ${i} 帧速度爆炸：${f.velocity}`);
      maxSpeed = Math.max(maxSpeed, f.velocity);
    }
  }
  assert.ok(maxSpeed < 200, `峰值速度 ${maxSpeed.toFixed(1)} 过高，疑似弹飞`);
});

test('稳定后池中不应存在深度穿透（留 15% 松弛余量）', () => {
  const sim = mkSim({ collision: true, fishCount: 16 }, 4242);
  for (let i = 0; i < 900; i++) sim.update(1 / 60);
  const scale = scaleOf(sim);
  let worst = 0;
  for (let i = 0; i < sim.fish.length; i++) {
    for (let j = i + 1; j < sim.fish.length; j++) {
      const hit = capsuleOverlap(koiBody(sim.fish[i], scale), koiBody(sim.fish[j], scale));
      if (!hit) continue;
      const rSum = koiBody(sim.fish[i], scale).r + koiBody(sim.fish[j], scale).r;
      worst = Math.max(worst, hit.depth / rSum);
    }
  }
  assert.ok(worst < 0.15, `最大穿透深度占半径和 ${(worst * 100).toFixed(1)}% —— 转向力与分离力打架了`);
});
