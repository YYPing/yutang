/**
 * 昼夜连续化的**结构护栏** —— 防止以后又有人写回 `night ? A : B`。
 *
 * ★ 为什么需要它：这次重构把 15+ 处硬切换改成了 `byDaylight()`，
 *   但"改过"不等于"改全了"。散落在 6 个文件里，下一个人加个新图层
 *   完全可能顺手写 `o.night ? .1 : .3`，把跳变重新引进来 ——
 *   而**没有任何运行时断言会变红**（数值都是合法的）。
 *   唯一可靠的办法是**读源码**：列一份白名单，剩下的一律不允许。
 *
 * ── 判据 ──────────────────────────────────────────────────────
 *  ① 幅度类（alpha / 亮度 / 颜色强度）必须走 `byDaylight`
 *  ② 门控类（该**画不画**这一层）允许保留布尔 `night`
 *  ③ `daylightOf` / `byDaylight` 的兜底顺序：`dayLight` → `night` → 1（白昼）
 *  ④ 两个端点必须与旧的布尔口径**逐位一致**（重构不能改观感）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { daylightOf, byDaylight, LightField, LIGHT } from '../src/engine/light-field.js';
import { dayLightAt } from '../src/lib/environment.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src', 'engine');
const FILES = readdirSync(SRC).filter((f) => f.endsWith('.js'));

/* ★ 允许保留布尔 `night` 的**门控**点，以及为什么。
 * 门控 = 「这一层该不该存在」，它的答案本来就该是离散的：
 *   萤火虫只在夜里飞、蝴蝶只在白天飞 —— 若也做成连续插值，
 *   会出现"中午有 12 只半透明的萤火虫在飞"，比跳变更糟。 */
const GATE_ALLOWLIST = [
  { file: 'pond.js', pattern: /if \(weather === 'sunny' && !night\)/, why: '蝴蝶只在白昼飞' },
  { file: 'pond.js', pattern: /if \(night && season !== 'winter'\)/, why: '萤火虫只在非冬夜飞' },
  { file: 'pond.js', pattern: /if \(night \|\| weather === 'rainy'/, why: '雨天/雪天/冬��不画虫' },
  { file: 'turtles.js', pattern: /night=false/, why: '旧调用方兼容（内部已转daylight）' },
  { file: 'turtles.js', pattern: /\(night\?0:1\)/, why: '同上：兜底到布尔' },
  { file: 'simulation.js', pattern: /night: false/, why: 'options 默认值声明' },
  { file: 'light-field.js', pattern: /options\.night \? 0 : 1/, why: 'daylightOf 的兜底' },
  { file: 'light-field.js', pattern: /night: false/, why: 'options 默认值声明' },
];

test('★ 结构护栏：src/engine 里不再有幅度类 night 硬切换', () => {
  // 搜的是「赋值/参数里用 night 选数值」的模式，不是所有 night 出现。
  // 命中即报错，并提示应改用 byDaylight(nightValue, dayValue, options)。
  const VALUE_PICK = /(?:alpha|Alpha|INK|ink|opacity|Opacity)\s*=\s*[^;\n]*\bnight\b\s*\?/;
  const COLOR_PICK = /rgba\([^)]*\)\s*;\s*\/\/[^\n]*night|\bnight\s*\?\s*'rgba/;
  const offenders = [];
  for (const f of FILES) {
    const src = readFileSync(join(SRC, f), 'utf8');
    src.split('\n').forEach((line, i) => {
      if (/^\s*(\*|\/\/)/.test(line)) return;                // 注释不算
      if (VALUE_PICK.test(line) || COLOR_PICK.test(line)) {
        // 白名单：这个文件这一行确实是门控
        if (GATE_ALLOWLIST.some((g) => g.file === f && g.pattern.test(line))) return;
        offenders.push(`${f}:${i + 1}  ${line.trim().slice(0, 90)}`);
      }
    });
  }
  assert.equal(offenders.length, 0,
    `发现 ${offenders.length} 处昼夜硬切换，应改用 byDaylight()：\n  ${offenders.join('\n  ')}`);
});

test('★ 门控白名单本身是有效的（每条都还能在源码里匹配到，防白名单腐化）', () => {
  const missing = GATE_ALLOWLIST.filter((g) => {
    const src = readFileSync(join(SRC, g.file), 'utf8');
    return !g.pattern.test(src);
  }).map((g) => `${g.file} / ${g.pattern}`);
  assert.equal(missing.length, 0,
    `白名单里的门控在源码里已不存在（要么被改好了、要么该删白名单）：\n  ${missing.join('\n  ')}`);
});

test('★ daylightOf 兜底顺序正确：dayLight > night 布尔 > 白昼', () => {
  assert.equal(daylightOf({ dayLight: 0.35, night: true }), 0.35, 'dayLight 优先于 night');
  assert.equal(daylightOf({ dayLight: 0.35, night: false }), 0.35, 'dayLight 优先于 night');
  assert.equal(daylightOf({ night: true }), 0, '无 dayLight 时按 night 布尔');
  assert.equal(daylightOf({ night: false }), 1, '无 dayLight 时按 night 布尔');
  assert.equal(daylightOf({}), 1, '什么都没有时当白昼（与options 默认 night:false 一致）');
  // 越界必须被夹住，不能让 NaN/1.8 漏进渲染
  assert.equal(daylightOf({ dayLight: -3 }), 0);
  assert.equal(daylightOf({ dayLight: 1.8 }), 1);
  assert.equal(daylightOf({ dayLight: NaN, night: true }), 0, 'NaN 必须回退到 night 而不是 0');
});

test('★ byDaylight 端点逐位等于两个旧值（重构不能改变白昼/夜间的观感）', () => {
  for (const [a, b] of [[0.82, 0.98], [0.015, 0.025], [0.72, 1], [0.05, 0.1], [0.08, 0.28], [0.31, 0.5]]) {
    assert.equal(byDaylight(a, b, { dayLight: 0 }), a, `夜端应精确为 ${a}`);
    assert.equal(byDaylight(a, b, { dayLight: 1 }), b, `昼端应精确为 ${b}`);
    assert.equal(byDaylight(a, b, { night: true }), a, '走布尔兜底时夜端应一致');
    assert.equal(byDaylight(a, b, { night: false }), b, '走布尔兜底时昼端应一致');
    // 中点必须精确在中点（线性）
    assert.ok(Math.abs(byDaylight(a, b, { dayLight: 0.5 }) - (a + b) / 2) < 1e-12, '中点不是线性中点');
  }
});

test('★ byDaylight 随 dayLight 严格单调（两端不塌陷）', () => {
  let prev = byDaylight(0, 1, { dayLight: 0 });
  for (let i = 1; i <= 100; i++) {
    const v = byDaylight(0, 1, { dayLight: i / 100 });
    assert.ok(v > prev, `dayLight=${(i / 100).toFixed(2)} 没有继续上升（塌陷成阶梯）`);
    prev = v;
  }
});

test('★ 光场 ambient 随昼夜连续变化，端点仍是 .28/.36', () => {
  const f = new LightField(() => 0.5);
  f.configure({ night: true });
  assert.equal(f.referenceLit, LIGHT.waterBase + LIGHT.ambientNight, '夜间端点变了');
  f.configure({ night: false });
  assert.equal(f.referenceLit, LIGHT.waterBase + LIGHT.ambientDay, '白昼端点变了');
  // 中间值必须落在两端之间
  f.configure({ dayLight: 0.5 });
  const mid = f.referenceLit;
  assert.ok(Math.abs(mid - (LIGHT.waterBase + (LIGHT.ambientNight + LIGHT.ambientDay) / 2)) < 1e-12,
    `中点应为两端均值，实为 ${mid}`);
  // 逐 0.05 单调
  let p = f.referenceLit;
  for (let d = 0.55; d <= 1.001; d += 0.05) {
    f.configure({ dayLight: d });
    assert.ok(f.referenceLit >= p - 1e-12, `dayLight=${d.toFixed(2)} ambient 回落了`);
    p = f.referenceLit;
  }
});

test('★ dayLight 与 dayLightAt 的口径一致（别让两处曲线分叉）', () => {
  // ⚠️ 每次都**新建 LightField**：`configure()` 是 merge，旧调用留下的 `dayLight`
  //   会粘在新对象上（第一版就在同一个实例上连着 configure，量到的是残留值）。
  //   这不是缺陷 —— 真实路径里 auto 与手动互斥，`useEnvironment` 只返回一个值。
  const litWith = (opts) => { const f = new LightField(() => 0.5); f.configure(opts); return f.referenceLit; };
  const noon = litWith({ dayLight: dayLightAt(new Date(2026, 8, 27, 12, 0)) });
  const deep = litWith({ dayLight: dayLightAt(new Date(2026, 8, 27, 3, 0)) });
  const manualDay = litWith({ night: false });
  const manualNight = litWith({ night: true });
  assert.ok(Math.abs(noon - manualDay) < 1e-12, `正午 ${noon} ≠ 手动白昼 ${manualDay}`);
  assert.ok(Math.abs(deep - manualNight) < 1e-12, `深夜 ${deep} ≠ 手动夜 ${manualNight}`);
});

test('★ 手动模式必须精确取 0/1（用户显式选择，端点不能带夹取）', () => {
  // 模拟 useEnvironment 的三分支写法：auto 给曲线，day/night 给端点。
  const calc = (mode, local, isDayLive = false, isDay = true) => (
    mode === 'auto' ? (isDayLive ? (isDay ? Math.max(local, 0.55) : Math.min(local, 0.45)) : local)
      : mode === 'night' ? 0 : 1);
  assert.equal(calc('day', 0.3), 1, '手动白昼必须精确 1（哪怕本地时钟在深夜）');
  assert.equal(calc('night', 0.9), 0, '手动夜必须精确 0（哪怕本地时钟在正午）');
  // auto + 在线数据夹取：本地深夜但那边是白天 ⇒ 白天端（>0.5）
  assert.ok(calc('auto', 0.1, true, true) > 0.5, '本地深夜+在线白天应取白天端');
  // auto + 在线数据夹取：本地正午但那边是夜⇒ 夜端（<0.5）—— 时差场景
  assert.ok(calc('auto', 1, true, false) < 0.5, '本地正午+在线夜应取夜端（时差）');
  // 两者一致时不做任何夹取
  assert.equal(calc('auto', 1, true, true), 1, '本地正午+在线白天不该被夹');
  assert.equal(calc('auto', 0, true, false), 0, '本地深夜+在线夜不该被夹');
  // ★ 夹取必须让 night 与 dayLight 永不自相矛盾
  for (const local of [0, 0.2, 0.5, 0.8, 1]) {
    for (const isDay of [true, false]) {
      const dl = calc('auto', local, true, isDay);
      const night = !isDay;
      if (!night) assert.ok(dl > 0.5, `isDay=true（白天）时 dayLight=${dl} 却≤.5 ⇒ 会画出夜景`);
      else assert.ok(dl < 0.5, `isDay=false（夜）时 dayLight=${dl} 却 ≥.5 ⇒ 会画出白天`);
    }
  }
});