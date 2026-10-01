import test from 'node:test';
import assert from 'node:assert/strict';
import { PondSimulation } from '../src/engine/simulation.js';
import { FEEDING, FEED_CIRCLE } from '../src/engine/eco/constants.js';

const seeded = (seed = 79) => () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
const pond = (options = {}) => new PondSimulation(1000, 700, options, seeded());
// F-2.8：半径 = 视口短边 × 0.30。1000×700 的池子 ⇒ 210。
const CIRCLE = 700 * FEED_CIRCLE.radiusFraction;
// 行为层的身体缩放（与 simulation.js 里 mouth 的计算一致）
const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));
const BODY_SCALE = clamp(Math.min(1000 / 1250, 700 / 780), .78, 1.15);

// A missing initialization or accidentally disabled steering leaves the pond empty/static.
test('an initialized pond has twelve fish that continue to swim', () => {
  const sim = pond();
  assert.equal(sim.getStats().fishCount, 12);
  const before = sim.fish.map(({ x, y }) => ({ x, y }));
  for (let i = 0; i < 60; i++) sim.update(1 / 60);
  assert.ok(sim.fish.some((fish, i) => Math.hypot(fish.x - before[i].x, fish.y - before[i].y) > 3));
});

// Loss of the population and particle caps would make repeated UI interactions unbounded.
test('repeated feeding and custom fish replacement remain bounded', () => {
  const sim = pond();
  for (let i = 0; i < 200; i++) sim.feed(500, 350);
  assert.ok(sim.food.length > 0 && sim.food.length <= FEEDING.foodCap);
  assert.ok(sim.ripples.length <= 40);
  sim.setCustomFish(Array.from({ length: 100 }, (_, i) => ({ id: String(i), texture: 'data:image/png;base64,' })));
  assert.ok(sim.fish.length <= 36);
  sim.setCustomFish([]);
  assert.equal(sim.fish.length, 12);
});

// Without food attraction or eating, nearby reachable food never disappears.
test('a fish swims to and eats reachable food', () => {
  const sim = pond({ fishCount: 1 });
  assert.equal(sim.fish.length, 1);
  Object.assign(sim.fish[0], { x: 350, y: 350, heading: 0, targetX: 450, targetY: 350 });
  sim.feed(480, 350);
  const foodBefore = sim.food.length;
  assert.ok(foodBefore > 0);
  for (let i = 0; i < 10 * 60; i++) sim.update(1 / 60);
  assert.ok(sim.food.length < foodBefore, 'reachable food should be eaten within ten seconds');
});

// Removing finite input validation, frame clamping, or boundary recovery escapes the viewport.
test('resizing and a stalled animation frame keep fish finite and in the pond', () => {
  const sim = pond();
  assert.equal(sim.fish.length, 12);
  sim.setBounds(320, 220);
  sim.feed(Number.NaN, Infinity);
  sim.pointer(Number.NaN, Infinity, true);
  for (let i = 0; i < 3000; i++) sim.update(i === 0 ? 90 : 1 / 30);
  for (const fish of sim.fish) {
    assert.ok(Number.isFinite(fish.x) && Number.isFinite(fish.y) && Number.isFinite(fish.heading));
    assert.ok(fish.x >= 0 && fish.x <= 320 && fish.y >= 0 && fish.y <= 220);
  }
});

// A paused pond must not advance its fish or consume time-sensitive food.
test('pause freezes simulation and resume moves fish again', () => {
  const sim = pond();
  assert.equal(sim.fish.length, 12);
  sim.feed(500, 350);
  sim.updateOptions({ paused: true });
  const before = JSON.stringify({ fish: sim.fish, food: sim.food });
  sim.update(1);
  assert.equal(JSON.stringify({ fish: sim.fish, food: sim.food }), before);
  sim.updateOptions({ paused: false });
  sim.update(1 / 30);
  assert.notEqual(JSON.stringify({ fish: sim.fish, food: sim.food }), before);
});

// Forgetting the cursor repulsion branch lets fish approach a moving hand.
test('fish turn away from an active nearby pointer', () => {
  const sim = pond({ fishCount: 1 });
  assert.equal(sim.fish.length, 1);
  Object.assign(sim.fish[0], { x: 500, y: 350, heading: 0, targetX: 750, targetY: 350 });
  sim.pointer(525, 358, true);
  for (let i = 0; i < 40; i++) { sim.pointer(525, 358, true); sim.update(1 / 60); }
  assert.ok(Math.abs(sim.fish[0].heading) > 0.2);
});

// ★ 这条测试原来是「食物吸引**远处**的鱼横穿整个桌面奔袭」。
//   F-2.8 明确否掉了这个行为（「仅圈内鱼抢食、圈外正常游」，校准：1080p 半径约 270px，
//   圈内 3–6 条 / 圈外 19–27 条）。所以改成一对对照：圈内照样冲刺、圈外不许动。
test('food produces a clear rush from inside the sense circle, and none from across a wide desktop', () => {
  const radius = 1080 * FEED_CIRCLE.radiusFraction;
  assert.ok(Math.abs(radius - 324) < 1e-9, `1080p 短边 × 0.30 = 324，实际 ${radius}`);

  const near = new PondSimulation(1920, 1080, { fishCount: 1, season: 'summer' }, seeded());
  const swimmer = near.fish[0];
  Object.assign(swimmer, { x: 1200, y: 500, heading: 0, targetX: 1200, targetY: 500, speed: 20, velocity: 20 });
  near.feed(1400, 500);                       // 距圈心 200px ⇒ 圈内
  for (let i = 0; i < 60; i++) near.update(1 / 60);
  assert.ok(swimmer.velocity > 50, `Expected a visible feeding rush, got ${swimmer.velocity}`);
  assert.ok(swimmer.x > 1225, '圈内鱼应该朝饲料游过去');
  assert.ok(Math.abs(swimmer.y - 500) < 20);

  const far = new PondSimulation(1920, 1080, { fishCount: 1, season: 'summer' }, seeded());
  const scout = far.fish[0];
  Object.assign(scout, { x: 200, y: 500, heading: 0, targetX: 200, targetY: 400, speed: 20, velocity: 20, wander: 1e9 });
  far.feed(1400, 500);                        // 距圈心 1200px ⇒ 圈外
  for (let i = 0; i < 60; i++) far.update(1 / 60);
  assert.ok(scout.velocity <= 50, `圈外鱼不该冲刺，实测 ${scout.velocity}`);
  assert.ok(Math.abs(scout.x - 200) < 30, '圈外鱼照常游自己的路');
});

test('fish slow near food and settle back to cruising after it is gone', () => {
  const sim = new PondSimulation(1000, 700, { fishCount: 1, season: 'summer' }, seeded());
  const fish = sim.fish[0];
  Object.assign(fish, { x: 500, y: 350, heading: 0, speed: 20, velocity: 65 });
  sim.food = [{ x: 538, y: 350, age: 0, life: 100, phase: 0, size: 2 }];
  for (let i = 0; i < 24; i++) sim.update(1 / 60);
  assert.ok(fish.velocity < 30, 'Fish should brake as they reach a morsel');
  sim.food = [];
  for (let i = 0; i < 240; i++) sim.update(1 / 60);
  assert.ok(Math.abs(fish.velocity - fish.speed) < 0.5);
});

test('feeding clears the click-position scare while later mouse movement still repels fish', () => {
  const sim = pond({ fishCount: 1 });
  sim.pointer(500, 350, true);
  sim.feed(500, 350);
  assert.equal(sim.hand.life, 0);
  sim.pointer(520, 350, true);
  assert.ok(sim.hand.life > 0);
});

/* --- F-2.8 投喂感应圈 ---------------------------------------------------- */

// US-1 的验收是「圈内 ≥3 条转向、**圈外鱼不变**」—— 圈外不变就是这条。
test('fish outside the sense circle never rush the food', () => {
  const sim = pond({ fishCount: 4 });
  const radius = Math.min(1000, 700) * FEED_CIRCLE.radiusFraction;
  assert.equal(radius, CIRCLE);
  // 全部鱼放到左上角、游荡目标也设在远处（wander 极大 ⇒ 不换目标）
  sim.fish.forEach((fish, i) => Object.assign(fish, {
    x: 60 + i * 9, y: 90 + i * 11, heading: 0, velocity: 0,
    targetX: 60, targetY: 20, wander: 1e9,
  }));
  sim.feed(760, 520);                        // 圈心离每条鱼都 > 半径
  const before = sim.food.length;
  assert.ok(before > 0, '饲料应该撒下去了');
  for (const fish of sim.fish) {
    assert.ok(Math.hypot(fish.x - 760, fish.y - 520) > radius, '前置：鱼都在圈外');
    assert.equal(sim.canReachFood(fish, sim.food[0]), false);
  }
  for (let i = 0; i < 5 * 60; i++) sim.update(1 / 60);
  assert.equal(sim.food.length, before, '圈外鱼不该动这一把食');
});

// 「<34px 贴脸饲料例外」—— 圈外鱼，但饲料就在嘴边时仍然吃。
test('a pellet right at the face is eaten even from outside the circle', () => {
  const sim = pond({ fishCount: 1 });
  const fish = sim.fish[0];
  Object.assign(fish, { x: 100, y: 100, heading: 0, velocity: 0, targetX: 100, targetY: 40, wander: 1e9 });
  sim.feed(760, 520);
  assert.ok(sim.food.length > 0);
  const pellet = sim.food[0];
  assert.equal(sim.canReachFood(fish, pellet), false, '圈外且离得远 ⇒ 看不见');

  // 挪到嘴边：嘴在 heading 方向 体长 × 0.385 × bodyScale 处
  const muzzle = fish.length * .385 * BODY_SCALE;
  pellet.x = fish.x + Math.cos(fish.heading) * muzzle;
  pellet.y = fish.y + Math.sin(fish.heading) * muzzle;
  assert.ok(Math.hypot(pellet.x - fish.x, pellet.y - fish.y) < FEED_CIRCLE.closeRangePx, '前置：在 34px 内');
  assert.equal(sim.canReachFood(fish, pellet), true, '贴脸 ⇒ 例外，看得见');

  const before = sim.food.length;
  sim.update(1 / 60);
  assert.ok(sim.food.length < before, '嘴前 6px（F-7.3.3）判定应该吃掉它');
});

// 圈半径必须随视口短边走，而不是写死像素。
test('the sense circle radius tracks the viewport short side', () => {
  const a = new PondSimulation(1600, 900, { fishCount: 1 }, seeded());
  a.feed(800, 450);
  assert.ok(Math.abs(a.feedCircles[0].radius - 900 * FEED_CIRCLE.radiusFraction) < 1e-9);
  const b = new PondSimulation(600, 1000, { fishCount: 1 }, seeded());   // 短边变高
  b.feed(300, 500);
  assert.ok(Math.abs(b.feedCircles[0].radius - 600 * FEED_CIRCLE.radiusFraction) < 1e-9);
});

// 虚线圈只活 displaySeconds（1.8s），而行为门控挂在饲料上、比它久。
test('the dashed circle overlay expires after displaySeconds but the gate does not', () => {
  const sim = pond({ fishCount: 1 });
  Object.assign(sim.fish[0], { x: 100, y: 100, heading: 0, velocity: 0, targetX: 100, targetY: 40, wander: 1e9 });
  sim.feed(700, 500);
  assert.equal(sim.feedCircles.length, 1);
  assert.equal(sim.feedCircles[0].life, FEED_CIRCLE.displaySeconds);

  const frames = Math.ceil((FEED_CIRCLE.displaySeconds - 0.05) * 60);
  for (let i = 0; i < frames; i++) sim.update(1 / 60);
  assert.equal(sim.feedCircles.length, 1, '还没到 1.8s，圈还在');
  for (let i = 0; i < 6; i++) sim.update(1 / 60);
  assert.equal(sim.feedCircles.length, 0, '过时后虚线圈消失');

  assert.ok(sim.food.length > 0, '饲料还在（落底才淡出）');
  assert.equal(sim.canReachFood(sim.fish[0], sim.food[0]), false, '圈没了但门控还在：圈外鱼仍然看不见');
});

// F-2.6 / F-7.3.6：未食用上限 200 粒，满了不再撒并回报给界面。
test('feeding stops at the 200-pellet cap and reports it', () => {
  const sim = pond();
  let cappedAt = null;
  for (let i = 0; i < 400 && cappedAt === null; i++) if (sim.feed(500, 350).capped) cappedAt = i;
  assert.ok(cappedAt !== null, '应该会撞到上限');
  assert.equal(sim.food.length, FEEDING.foodCap);
  const refused = sim.feed(500, 350);
  assert.equal(refused.ok, false);
  assert.equal(refused.capped, true);
  assert.equal(sim.food.length, FEEDING.foodCap, '被拒的这一把不改变水量');
  assert.equal(sim.feed(Number.NaN, Infinity).ok, false);
  assert.equal(sim.feed(Number.NaN, Infinity).capped, false, '非法坐标不算"够了"');
});
