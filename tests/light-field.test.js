/* §10.5 光照场单测。
 *
 * ⚠️ 这里**不重写**那些规格数字 —— 直接复用 `tools/check-light.js` 的 `runLightChecks()`。
 *    理由：需求给的六个数字（底光 .36 / 光池 .55 / σ .26 / 暗处 .67 / 明暗差 1.43 / 光柱 9–26s）
 *    是一组**互相咬合**的约束，拆成两条独立断言就会各自漏掉"它们能不能同时成立"。
 *    尺子只有一把，跑的地方有两处（人手动跑 + CI）。
 *
 * 本文件额外补的是 `check-light.js` 覆盖不到的两件事：
 *   ① 渲染几何 ↔ 采样口径是否一致（不会让任何数值断言变红，只能靠结构断言守）
 *   ② 光照场的**纯函数性**（不依赖 update() 的调用时机）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LightField, LIGHT } from '../src/engine/light-field.js';
import { runLightChecks } from '../tools/check-light.js';

test('§10.5 全部规格数字同时成立（复用 tools/check-light.js 的同一把尺子）', () => {
  const result = runLightChecks({ log: () => {} });
  const red = result.lines.filter((line) => line.trim().startsWith('✘'));
  assert.equal(result.fail, 0, red.length ? red.join('\n') : '');
  // 断言数量本身也要有下界：否则"删掉一半断言"也会绿。
  assert.ok(result.pass >= 45, `只跑了 ${result.pass} 条，期望 ≥ 45`);
});

test('渲染几何与采样口径一致：亮带画在哪，鱼就在哪被提亮', () => {
  const W = 1600, H = 1000;
  const field = new LightField(() => 0.5);
  field.configure({ weather: 'sunny', season: 'summer', night: false, quality: 'high' });
  const shaft = { u: 0.4, tilt: 0.22, width: 0.3, life: 10, seed: 0, age: 5, envelope: 1, lit: 1 };
  field.shafts.push(shaft);
  const geo = field.shaftGeometry(shaft, W, H);

  // `cx` 是建渐变用的锚点，必须正好落在带轴的 y = .54h 处。
  // 差一点点不会让任何数值断言变红，但会让渐变中心与亮带中心错开。
  assert.equal(geo.cx, geo.axisAt(0.54 * H), '渐变锚点不在带轴上');

  // 带轴上的亮度必须高于带外 —— 且"带外"是按同一个 halfWidth 判的。
  for (const ratio of [0.25, 0.5, 0.75]) {
    const y = H * ratio;
    const axisX = geo.axisAt(y);
    const onAxis = field.shaftAt(axisX, y, W, H);
    const outside = field.shaftAt(axisX + geo.halfWidth * 1.5, y, W, H);
    assert.ok(onAxis > 0, `y=${y} 的带轴上没有光`);
    assert.equal(outside, 0, `y=${y} 的带外还有光（几何与采样口径不一致）`);
  }

  // halfWidth 处横向二次衰减到 0（软边），不存在硬切。
  const midY = 0.54 * H;
  assert.equal(field.shaftAt(geo.axisAt(midY) + geo.halfWidth, midY, W, H), 0, '带边缘没有收到 0');

  // 纵向进出：两端归零，中段最亮。
  const axisAtTop = geo.axisAt(H * 0.02);
  const axisAtMid = geo.axisAt(midY);
  assert.ok(field.shaftAt(axisAtMid, midY, W, H) > field.shaftAt(axisAtTop, H * 0.02, W, H),
    '光柱没有"中段最亮"的纵向包络');
});

test('光照场是纯查询：不调 update() 也能立刻读到正确的值', () => {
  const W = 1600, H = 1000;
  const field = new LightField(() => 0.5);
  field.configure({ weather: 'sunny', season: 'summer' });
  // 快照回放 / 单帧渲染 / 手绘鱼预览都会在没跑过 tick 的情况下直接问它。
  assert.equal(field.dream, 0);
  const before = field.lightAt(992, 260, W, H);
  field.shafts.push({ u: 0.62, tilt: 0, width: 0.3, life: 10, seed: 0, age: 5, envelope: 1, lit: 1 });
  // 同一个点、同一帧：加了一束柱，读数必须**立刻**变（不是等到下一帧）。
  assert.ok(field.lightAt(992, 260, W, H) > before, '手工放柱后读数没反应（有陈旧缓存）');
  assert.equal(field.dream, 1);
});

test('光池外的鱼增益量化后恰好为 1（改动不外溢到池外）', () => {
  const W = 1600, H = 1000;
  const field = new LightField(() => 0.5);
  field.configure({ weather: 'sunny', season: 'summer' });
  const reference = field.fishBrightness(field.referenceLit);
  /** 渲染层真正用的就是量化后的值（见 koi-renderer 的 `Math.round(gain * 1000) / 1000`）。 */
  const quantize = (g) => Math.round(g * 1000) / 1000;

  // ⚠️ 不能断言"原始增益 === 1"：光池是**高斯**，在左下角也不是严格 0
  //    （实测 1.0000393）。真正让池外逐位不变的是**量化**这一步 ——
  //    量化成 1.000 之后 `gain === 1` 成立，整条着色分支被跳过，调色板一个字节都不改。
  //    所以判据要盯量化后的值，而不是原始值。
  const rawDark = field.fishBrightness(field.lightAt(96, 940, W, H)) / reference;
  assert.ok(rawDark > 1 && rawDark < 1.001, `暗处原始增益 ${rawDark}，不该超过千分之一`);
  assert.equal(quantize(rawDark), 1, '暗处增益量化后不是 1 —— 池外的鱼会被改动波及');

  // 光池内：量化后 > 1，且与需求给的 1.43 同量级。
  const rawPool = field.fishBrightness(field.lightAt(W * LIGHT.poolX + 0.34 * LIGHT.poolSigma * H, H * LIGHT.poolY, W, H)) / reference;
  assert.ok(quantize(rawPool) > 1.4 && quantize(rawPool) < 1.46, `光池内增益 ${rawPool}，期望 ≈ 1.43`);
});
