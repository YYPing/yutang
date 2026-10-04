/**
 * 翻译层的不变式护栏 —— 主要针对 2026-10-04 这一轮修掉的三个真 bug。
 *
 * ★ 为什么这些必须钉死：它们全属于「画面依然正常渲染、只是偏了」的类型。
 *   没有任何异常、没有任何崩溃，量具的绝对差值也照样有值 ——
 *   只有"派生量与真源对齐"这种断言才能在早期抓住。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { visualFor, seasonOf } from '../src/engine/term-visual.js';
import { termProfile, blendTerm, SOLAR_TERMS, TERM_SEASON } from '../src/engine/almanac.js';

const vOf = (t) => visualFor({ solarTerm: t, almanacProfile: { ...termProfile(t), deepWinter: 0 } });

/* 物候序（季内真实顺序）。
 * ⚠️ **不能**用 `SOLAR_TERMS.filter(...)` 取"某季的六档"再按 24 序断言：
 *   24 序是**历法序**、跨年排布（立春/雨水/惊蛰在末尾，春分/清明/谷雨在开头），
 *   filter 出来会是「谷雨→立夏」这种**跨季拼接**，
 *   步长 0.25、单季断言全部误判（我第一版就栽在这，4 项假红）。
 *   真实物候序必须显式写出 —— 它和 term-visual 的 TERM_RANK 是同一张表。 */
const RANK = {
  spring: ['立春', '雨水', '惊蛰', '春分', '清明', '谷雨'],
  summer: ['立夏', '小满', '芒种', '夏至', '小暑', '大暑'],
  autumn: ['立秋', '处暑', '白露', '秋分', '寒露', '霜降'],
  winter: ['立冬', '小雪', '大雪', '冬至', '小寒', '大寒'],
};

test('★ 24 档季节归属与 TERM_SEASON 完全一致（错季老 bug 的防线）', () => {
  // 旧实现按 warmth 阈值反推，实测 7/24 档错：立秋/处暑→summer、白露/秋分→spring、
  // 立春→winter、雨水/惊蛰→autumn。因为它只影响焦散倍率，画面"看着正常"，从未被发现。
  for (const t of SOLAR_TERMS) {
    const expected = TERM_SEASON[SOLAR_TERMS.indexOf(t)];
    assert.equal(vOf(t).season, expected, `${t} 判成 ${vOf(t).season}，真源是 ${expected}`);
  }
});

test('★ seasonOf 传节气名时以真源为准，不传时退回阈值兜底', () => {
  assert.equal(seasonOf(0.82, '立秋'), 'autumn');   // 阈值会判 summer
  assert.equal(seasonOf(0.30, '立春'), 'spring');   // 阈值会判 winter
  assert.equal(seasonOf(0.99), 'summer');          // 无节气名 ⇒ 阈值
  assert.equal(seasonOf(0.02), 'winter');
});

test('★ 季内 tint 步长恒定（秩次等距，而不是 warmth 线性）', () => {
  // 线性归一化实测步长比高达 40~60 倍（春 .08/.12/.08/.04/.06），最弱对 ΔE 仅 1.26。
  for (const [s, list] of Object.entries(RANK)) {
    const tints = list.map((t) => vOf(t).tintR);
    const steps = tints.slice(1).map((x, i) => Math.abs(x - tints[i]));
    const max = Math.max(...steps), min = Math.min(...steps);
    assert.ok(max - min < 1e-6, `${s} 组内 tintR 步长不恒定：${steps.map((x) => x.toFixed(4))}`);
  }
});

test('★ tintR 在物候序上单调递增（季初→季末越来越暖）', () => {
  for (const [s, list] of Object.entries(RANK)) {
    const tints = list.map((t) => vOf(t).tintR);
    for (let i = 1; i < tints.length; i++) {
      assert.ok(tints[i] > tints[i - 1],
        `${s} ${list[i - 1]}->${list[i]} tintR 反而下降：${tints[i - 1].toFixed(3)} -> ${tints[i].toFixed(3)}`);
    }
  }
});

test('★ 冬六档 tint 全部落在"冷端"（不出现"立冬是黄绿色"这种错季色）', () => {
  // 这是本次暴露老 bug 的直接症状：tint 秩次化后，错季被放大成明显的颜色错误。
  // ⚠️ 判据用 tintR：冷端的 R 最低（.30），暖端最高（.55）。**不能用 B**：
  //   B 在冷端最高、暖端最低，它其实是"暖→冷"的反向轴，写反了会得出错误结论。
  for (const t of RANK.winter) {
    const v = vOf(t);
    assert.ok(v.tintR <= 0.55 + 1e-9, `${t} tintR=${v.tintR.toFixed(3)} 超出冷端上限（说明被判成了暖季）`);
  }
  // 明确反例：立冬若错判成 summer，tintR 会落在 0.30~0.55 的**冷端起点**。
  // 正确判定下立冬是 winter 且秩次 0 ⇒ tintR 应为冷端最小值附近。
  assert.ok(vOf('立冬').tintR < 0.36, `立冬 tintR=${vOf('立冬').tintR.toFixed(3)} 不在冷端`);
  // 暖端对照：夏至应是全表 tintR 之一的高值
  assert.ok(vOf('夏至').tintR > 0.44, `夏至 tintR=${vOf('夏至').tintR.toFixed(3)} 不在暖端`);
});

test('拿不到节气名时退回线性归一化（老存档兼容），且不崩', () => {
  for (const bad of [{}, { solarTerm: '' }, { solarTerm: '不存在' }, { solarTerm: '大雪' }]) {
    const v = visualFor(bad);
    assert.ok(Number.isFinite(v.tintR) && Number.isFinite(v.tintG) && Number.isFinite(v.tintB),
      JSON.stringify(bad) + ' 的 tint 必须是有限数');
    assert.ok(v.tintR >= 0 && v.tintR <= 1, 'tintR 越界');
  }
});

test('秩次表每季恰好六档、且季节归属全对（物候序的形状护栏）', () => {
  // ⚠️ 秩次表是**季内物候序**，不能用 `SOLAR_TERMS.filter(...)` 推出来：
  //   24 序是历法序、跨年排布，filter 出来是「谷雨→立夏」这种跨季拼接。
  //   之前 bank-flora.js 也维护过一份同源的物候表，两处漂移会互相矛盾；
  //   该文件已回退（C 方案未通过目视验收），所以现在这张表是**唯一真源**，
  //   本测试就是它的形状护栏 —— 六档、季节全对、顺序单调。
  for (const [s, list] of Object.entries(RANK)) {
    assert.equal(list.length, 6, `${s} 不是六档`);
    for (const t of list) {
      assert.equal(TERM_SEASON[SOLAR_TERMS.indexOf(t)], s, `${t} 在 TERM_SEASON 里不是 ${s}`);
      assert.ok(SOLAR_TERMS.includes(t), `${t} 不在 SOLAR_TERMS 里`);
    }
  }
  // 四季必须无重无漏地覆盖 24 档 —— 漏一档会让那一档退回 warmth 线性兜底（步长不均）
  const flat = Object.values(RANK).flat();
  assert.equal(flat.length, 24);
  assert.equal(new Set(flat).size, 24, '秩次表里有重复节气');
  assert.deepEqual([...flat].sort(), [...SOLAR_TERMS].sort(), '秩次表没有覆盖全部 24 档');
});

/* ══════════════════════════════════════════════════════════════════
 * 档内连续性（2026-10-04 新增）
 *
 * ★ 这两条针对的是一个「参数级探针抓不到、只有单测能钉死」的缺陷：
 *   `seasonalWarmth()` 第一版只看 `RANK.get(term)`，而真实路径
 *   （`useEnvironment.js` 的 `blendTerm(almanac.term, t)`）里
 *   `solarTerm` 恒为离散的 from 档、`t` 才是档内进度。
 *   ⇒ 水色在**交节那一帧跳一下，然后 15 天一动不动**，是阶梯不是渐变。
 *   为什么"看起来全绿"：24 档的 t=0 取值全都对，秩次等距的收益也全都保住，
 *   只有真正跑到一档中间那 15 天，才会发现整段是死平的。
 * ══════════════════════════════════════════════════════════════════ */

const blendV = (t, k) => visualFor({
  solarTerm: t,
  almanacProfile: { ...blendTerm(t, k), deepWinter: 0 },
});

test('★ 档内 15 天水色是渐变，不是「跳一下然后恒定」的阶梯', () => {
  for (const t of SOLAR_TERMS) {
    const seq = [0, 1 / 6, 2 / 6, 3 / 6, 4 / 6, 5 / 6].map((k) => blendV(t, k).tintR);
    const steps = seq.slice(1).map((v, i) => Math.abs(v - seq[i]));
    const hi = Math.max(...steps);
    assert.ok(hi > 1e-4, `${t} 档内 tintR 全段恒定在 ${seq[0].toFixed(3)}（阶梯，不是渐变）`);
    assert.ok(hi / Math.min(...steps) <= 1.35,
      `${t} 档内步长不均：${steps.map((x) => x.toFixed(3)).join('/')}`);
  }
});

test('★ SEG 按日历序连（季末那档指向下一季首档，不是同季首档）', () => {
  // 反证：若 SEG 按 TERM_RANK 分组 + (i+1)%n 绕回，谷雨那段会指向「立春」——
  // 日历上谷雨之后是立夏，中间隔着整个夏天。表现是谷雨档内 tintR 恒定。
  const pairs = [['谷雨', '立夏'], ['大暑', '立秋'], ['霜降', '立冬'], ['大寒', '立春']];
  for (const [from, to] of pairs) {
    const w1 = termProfile(to).warmth;
    // 段内终点必须精确落在下一档的取值上（t=1 时反解精确 ⇒ 误差 ~0）
    const at1 = visualFor({
      solarTerm: from,
      almanacProfile: { ...termProfile(from), warmth: w1, deepWinter: 0 },
    }).tintR;
    const target = vOf(to).tintR;
    assert.ok(Math.abs(at1 - target) < 1e-6,
      `${from} 段末(warmth=${w1}) tintR=${at1.toFixed(4)}，但下一档 ${to} 是 ${target.toFixed(4)}`);
  }
});
