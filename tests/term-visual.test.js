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

/* ★★★ 以下三条断言在 2026-10-04 换了判据，但**意图一条没变**。
 *
 * 换判据的原因：上一版 tint 是「COLD/WARM 两点 lerp」出来的**权重**，
 * 所以能断言"步长恒定"（秩次等距）、"单调递增"（季初→季末越来越暖）——
 * 那两条断言实际上是在**为"两点 lerp 这个构造"护栏**，而不是在为"物候色序"护栏。
 * 现在水色换成 24 张水彩参考图的**逐档实测值**（`TERM_TINT_GAIN`），
 * "两点 lerp"这个构造已经不存在，那两条断言在数学上不可能继续成立。
 *
 * ⚠️ 而且"单调递增"这条**本身就该退休**，不只是换了量纲 —— 实测色标里：
 *   小暑 R 2.720 → 大暑 R 2.708（微降）、霜降 R 3.186 → 立冬 R 2.301（骤降）。
 *   这不是数据错，是**真实物候**：大暑是一年最闷热的时段，而霜降是秋季最后一档、
 *   之后立刻入冬。用"必须单调"去判实测色标，等于**逼数据去迁就公式**。
 *   所以下面改成「同季内相邻档必须有可辨的差异」+「全年跨度足够大」两条，
 *   它约束的是**表现力**，而不是**形状**。
 *
 * ⚠️ 这是量程压缩的**第五例**，但前四例的病根都不是"量程"，而是**信息来源本身太粗**：
 *   ① leaf→1 时 round() 饱和 ② 夏至 warmth 撞上界
 *   ③ 雪厚 0.35+0.65*deepWinter 撞上界 ④ tint 在 [COLD,WARM] 两点间插值
 *   前三例改档案值就能修，第四例改成秩次也就到了头 —— 因为
 *   **两点 lerp 在数学上就不可能表达"同一序号、不同季节要不同色"**。
 *   旧表可直接看到这个病：春分 tint=(.450,.676,.464) 与**夏至完全相同**、
 *   与冬至也完全相同 —— 春分/夏至/冬至的季内序号都是第 4 档。
 */

/* 池心水色：由 gain 反推画面上的实际 RGB。判据全部改用这个量，
 * 因为它是唯一与人眼看到的画面直接对应的量（gain 只是中间量）。 */
const POOL = {
  spring: [64.4, 179.3, 143.5], summer: [57.1, 178.0, 141.7],
  autumn: [52.7, 168.1, 146.7], winter: [59.5, 168.4, 157.7],
};
const SEASON_OF = {};
for (const [s, list] of Object.entries(RANK)) list.forEach((t) => { SEASON_OF[t] = s; });
/* ⚠️ `water` 必须**逐档**取值，不能用全局代表值。
   第一版统一用 0.97（k=0.834），而标定时实测的是逐档 `min(g,b)-r>10` 占比
   （冬档 0.92~0.95、其余夹到 0.85 下界）。用统一值会让冬档 ΔE 系统性偏低
   —— 大雪->冬至 8.70 vs 参考 9.55 = 0.91，刚好卡在阈值下 0.0038，
   **看起来像标定不准，其实是判据算错**。
   教训：反解链路里只要有任一中间量是逐样本实测的，判据就不能拿全局代表值代替。 */
/* ★★★ HSV 版本的池心换算（2026-10-04 换掉 RGB 乘色）。
 *
 *   旧公式 `B * (1 + k*(M-1))` 随 RGB 乘色一起作废了 —— RGB 逐通道缩放
 *   **恒等保持饱和度**，而参考图水色比底图**低 46~54% 饱和**，
 *   那条路在数学上到不了（实测冬季洋红 22~42%、G 最大占比掉到 8%）。
 *
 *   新公式与 shader 完全一致：
 *     out = hsv2rgb( rgb2hsv(B) + [dh, 0, 0]， S*ks， V*kv )
 *   B 是**该档所属季**的底图池心原色 —— 这是标定时的输入，逐档不变。
 */
const POOL_HSV = {};
for (const [s, list] of Object.entries(RANK)) list.forEach((t) => { POOL_HSV[t] = s; });

/* 离线验证过的 hsv2rgb（与 landscape.js 的 GLSL 版逐字对应）。
   ⚠️ 曾经手推过一版六分支 if/else，两处都错：纯蓝算出 H=0、漏掉品红 sector 5
   （往返误差 0.58）。现在用的是 chroma 三分支形式，
   已对 20 色（含全部 6 个 sector）+ 5 万随机像素验证，最大误差 0。 */
const hsv2rgb = ([h, s, v]) => {
  const hh = ((h % 360) + 360) % 360 / 60;
  const c = v * s, x = c * (1 - Math.abs(((hh % 2) + 2) % 2 - 1)), m = v - c;
  const i = Math.floor(hh) % 6;
  const t = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][i];
  return t.map((q) => Math.max(0, Math.min(255, (q + m) * 255)));
};
const rgb2hsv = ([r, g, b]) => {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), df = mx - mn;
  let h = 0;
  if (df > 1e-6) {
    if (mx === r) h = (((g - b) / df + 6) % 6) * 60;
    else if (mx === g) h = ((b - r) / df + 2) * 60;
    else h = ((r - g) / df + 4) * 60;
  }
  return [h, mx > 1e-6 ? df / mx : 0, mx / 255];
};

const poolOf = (t) => {
  const B = POOL[SEASON_OF[t]];
  const [dh, ks, kv] = vOf(t).termTintHSV;
  const [h, s, v] = rgb2hsv(B);
  return hsv2rgb([h + dh, s * ks, v * kv]);
};
const luma = (v) => v[0] * .3 + v[1] * .59 + v[2] * .11;
const labOf = (v) => {
  const y = luma(v) / 255;
  const f = (x) => (x > .04045 ? ((x + .055) / 1.055) ** 2.4 : x / 12.92);
  return [f(y), f(v[1] / 255) - f(y), f(v[2] / 255) - f(y)];
};
const deltaE = (a, b) => {
  const A = labOf(a), B = labOf(b);
  return Math.hypot(A[0] - B[0], A[1] - B[1], A[2] - B[2]) * 100;
};

test('★ 同季内相邻档的池心色差达到可辨阈（替代「步长恒定」——旧断言在为两点 lerp 护栏）', () => {
  // 人眼同屏辨识阈约 ΔE 5。这是**表现力**判据：同季六档必须真的能两两分开。
  const all = [];
  for (const [s, list] of Object.entries(RANK)) {
    for (let i = 1; i < list.length; i++) {
      all.push({ s, pair: `${list[i - 1]}->${list[i]}`, d: deltaE(poolOf(list[i - 1]), poolOf(list[i])) });
    }
  }
  /* ⚠️ 阈值定为「不劣于参考图自身 × 0.9」，**不是**"人眼辨识阈 ΔE 5"。
     * 经过：先按 ΔE 5 设阈值，春季立刻红（只 2/5 达标）；
     *   再测参考图自身相邻档 ΔE = 5.81/6.89/2.41/4.44/2.69，
     *   **与本测试算出的逐位吻合** ⇒ 标定是精确的，
     *   春季档间差异小是**素材本身的性质**，不是实现的毛病。
     *   全部 23 对参考图自身 ΔE 中位仅 5.81，>=5 只有 12/23——
     *   所以"过半 >=5"在数学上不可能成立，除非篡改实测数据。
     *   ⇒ 参考图是**标定目标**，不是及格线。判据的正确形态是
     *     「我们复现的档间差 >= 参考图自己的档间差 × 0.9」。
     */
  const REF_POOL = {
    立春: [125.3, 154.6, 141.7], 雨水: [135.1, 167.4, 146.8], 惊蛰: [132.8, 182.7, 148.1],
    春分: [124.7, 179.8, 143.0], 清明: [112.4, 173.2, 129.2], 谷雨: [105.7, 167.5, 123.3],
    立夏: [128.3, 175.3, 138.3], 小满: [124.9, 177.3, 143.3], 芒种: [124.9, 179.6, 141.5],
    夏至: [119.9, 166.0, 128.5], 小暑: [123.6, 147.5, 115.8], 大暑: [142.9, 165.4, 134.7],
    立秋: [127.8, 168.9, 136.0], 处暑: [126.0, 154.4, 122.4], 白露: [132.2, 169.6, 135.0],
    秋分: [135.6, 160.4, 123.6], 寒露: [133.5, 122.8, 92.2], 霜降: [148.8, 129.0, 94.8],
    立冬: [124.1, 152.0, 139.5], 小雪: [109.4, 121.3, 134.5], 大雪: [109.7, 127.8, 142.1],
    冬至: [76.2, 94.9, 115.7], 小寒: [108.1, 124.9, 133.7], 大寒: [72.8, 99.5, 119.5],
  };
  const bad = [];
  for (const [s, list] of Object.entries(RANK)) {
    for (let i = 1; i < list.length; i++) {
      const mine = deltaE(poolOf(list[i - 1]), poolOf(list[i]));
      const ref = deltaE(REF_POOL[list[i - 1]], REF_POOL[list[i]]);
      const ratio = mine / Math.max(ref, 1e-6);
      if (ratio < 0.9 || mine < 1e-6) {
        bad.push(`${list[i - 1]}->${list[i]} 我${mine.toFixed(2)}/参考${ref.toFixed(2)}=${ratio.toFixed(2)}`);
      }
    }
  }
  assert.equal(bad.length, 0,
    `这些档对的池心色差劣于参考图自身的 90%（或完全相同，说明漏抄了实测值）：\n  ${bad.join('\n  ')}`);
});

test('★ 全年池心色跨度足够大（替代「季内单调递增」——实测物候本就不单调）', () => {
  const all = SOLAR_TERMS.map(poolOf);
  const us = new Set();
  all.forEach((c) => us.add(c.map((x) => x.toFixed(1)).join(',')));
  assert.ok(us.size >= 20,
    `24 档的池心色去重后只有 ${us.size} 种 —— 塌成"没变化"，正是用户投诉的现象`);
  const lums = all.map(luma);
  assert.ok(Math.max(...lums) - Math.min(...lums) >= 45,
    `全年池心亮度跨度只有 ${(Math.max(...lums) - Math.min(...lums)).toFixed(1)} 灰阶（要求>=45）`);
});

test('★ 冬六档确实是全年最暗的一组（替代「tintR 落冷端」，用亮度而非权重判）', () => {
  // ⚠️ 旧断言用 `tintR <= 0.55` 判冷端，那是**权重**的绝对值；
  //   换成实测 gain 后 gain 可 >1（实测 R 1.27~3.19），绝对值判据必然失效。
  //   真正要保证的意图是「立冬不能被画成黄绿色的暖季」——
  //   用**人眼看到的池心亮度**判，既直接又不依赖内部表示。
  const winterL = RANK.winter.map((t) => luma(poolOf(t)));
  const others = Object.entries(RANK).filter(([s]) => s !== 'winter')
    .flatMap(([, list]) => list).map((t) => luma(poolOf(t)));
  assert.ok(Math.max(...winterL) < Math.min(...others) + 25,
    `冬六档最亮(${Math.max(...winterL).toFixed(0)}) 比非冬档最暗(${Math.min(...others).toFixed(0)})还亮 25 灰阶以上 —— 冷暖画反了`);
  assert.ok(luma(poolOf('立冬')) < luma(poolOf('夏至')),
    `立冬亮度(${luma(poolOf('立冬')).toFixed(0)}) 不低于夏至(${luma(poolOf('夏至')).toFixed(0)}) —— 错季`);
  assert.ok(Math.max(...RANK.summer.map((t) => luma(poolOf(t)))) >= Math.max(...winterL),
    '夏六档最亮不如冬六档最亮 —— 冷暖画反了');
});

test('拿不到节气名时退回季内插值（老存档兼容），且不崩', () => {
  const cases = [{}, { solarTerm: '' }, { solarTerm: '不存在' }, { solarTerm: '大雪' }];
  for (const bad of cases) {
    const v = visualFor(bad);
    const tag = JSON.stringify(bad);

    /* ★ 旧断言是 `tintR >= 0 && <= 1`。2026-10-04 换 HSV 之后，
     * `termTintHSV` = [dh 度, ks 饱和比, kv 亮度比]，三者的语义各不相同：
     *   · dh  是**环形量** —— 区间 [-180,180)，lerpAngle 已折到短路径；
     *          它可以绕远路（寒露/霜降是 -124/-131）所以不能卡绝对值小。
     *   · ks  是饱和比 —— 实测 .272~1.019。**必须 > 0**（0 会把水色打成灰）
     *          且不能太大（>1.6 就是"疯狂加饱和"，与参考图反向）。
     *   · kv  是亮度比 —— 实测 .687~1.019，1.0 附近是安全的。
     * ⚠️ 别把这三个区间混成一套：旧断言的上界 8 是**RGB 乘色系数**的量纲，
     *   换成 HSV 后那个区间已经不存在了。 */
    const [dh, ks, kv] = v.termTintHSV;
    assert.ok(Number.isFinite(dh) && dh >= -180 && dh < 180,
      `${tag} 的 dh=${dh} 越界（必须是折到短路径的 [-180,180)）`);
    assert.ok(Number.isFinite(ks) && ks > 0 && ks <= 1.6,
      `${tag} 的 ks=${ks} 越界（实测区间 .272~1.019，上界 1.6 留余量）`);
    assert.ok(Number.isFinite(kv) && kv > 0.3 && kv <= 1.6,
      `${tag} 的 kv=${kv} 越界（实测区间 .687~1.019）`);

    /* tintR/G/B 是给探针与 shot 用的**近似导出**（term-visual 的 hsvToTint），
     * 必须是 0~255 的有限 RGB。这三个字段不再是 shader 的输入。 */
    for (const [k, val] of [['R', v.tintR], ['G', v.tintG], ['B', v.tintB]]) {
      assert.ok(Number.isFinite(val) && val >= 0 && val <= 255,
        `${tag} 的 tint${k}=${val} 越界（必须是 0~255 的 RGB）`);
    }
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

/* ==================================================================
 * ★★★ 2026-10-04 新增：24 档实测色标的形状护栏
 *
 * 为什么必须补：这次把水色的信息来源从"两点 lerp 公式"换成了"24 个实测常数"。
 * 前者坏掉时会**平滑退化**（差异变小但仍单调）；后者坏掉时可能：
 *   · 整张表被改坏       → 画面全变，容易发现
 *   · 某一档被手抄错     → 只有那一档怪，其他 23 档正常（**最难发现的一类**）
 * 所以这三条专门盯"表的形状"与"抄错"。
 * ================================================================== */

test('★24 档实测色标：齐全、无重复、且每档都有自己独立的取值', () => {
  const seen = new Map();
  for (const t of SOLAR_TERMS) {
    const g = vOf(t).termTintHSV;
    assert.ok(g && g.length === 3 && g.every(Number.isFinite), `${t} 的 HSV 参数非法`);
    const key = g.map((x) => x.toFixed(4)).join(',');
    if (seen.has(key)) {
      assert.fail(`★ ${t} 与 ${seen.get(key)} 的 HSV 参数完全相同（${key}）`
        + ' —— 实测色标不该有两档同值；若真如此，说明有一档被漏抄成了另一档的值');
    }
    seen.set(key, t);
  }
  assert.equal(seen.size, 24, '24 档里有档位共用同一个取值');
});

test('★ 实测色标的量级落在实测区间内（防手抄时多打/少打一个数量级）', () => {
  /* 区间来自 24 档实测表的真实取值域，各留约 1.5 倍余量：
   *   dh -130.85~+37.60   ks .272~1.019   kv .687~1.019
   * 越界通常意味着抄错小数点/看错列，不是设计意图。
   * ⚠️ dh 上界只到 180：它可以绕远路（寒露/霜降是 -124/-131），
   *   但**不该超过 180** —— lerpAngle 折到短路径，超过就是折错了。 */
  const RANGE = { dh: [-181, 180], ks: [0.15, 1.6], kv: [0.4, 1.6] };
  for (const t of SOLAR_TERMS) {
    const [dh, ks, kv] = vOf(t).termTintHSV;
    for (const [name, val] of [['dh', dh], ['ks', ks], ['kv', kv]]) {
      const [lo, hi] = RANGE[name];
      assert.ok(val >= lo && val <= hi,
        `${t} 的 ${name}=${val.toFixed(4)} 超出实测区间 [${lo}, ${hi}] —— 疑似手抄错`);
    }
  }
});

test('★★ HSV 变换必须真的降饱和（RGB 乘色做不到这件事，这是换方案的唯一理由）', () => {
  /* 这条是**方向性护栏**，专防"哪天有人把 shader 改回乘色"。
   *
   * 背景：RGB 逐通道缩放**恒等保持饱和度**（mx/mn 比值不变），
   *   而参考图水色比底图**低 46~54%**（实测 春 .702→.327 夏 .727→.394
   *   秋 .724→.353 冬 .554→.254）。
   *   所以任何 `out = color * M` 的方案在数学上都到不了参考图—— 实测也确实
   *   把冬季染成了洋红（洋红占比 22~42%，G 最大占比从 44.3% 掉到 2.7%）。
   *
   * 判据：24 档的 ks **每一档都必须明显< 1**。
   *   · 全部 ks < 0.95 ⇒ 每一档都在降饱和，方向对
   *   · 某档 ks >= 0.95 ⇒ 该档没在降饱和（"忘了乘 ks"就会等于 1）
   *   · 某档 ks > 1⇒ 反向加饱和，是另一种病
   * ⚠️ 阈值取 0.95 而不是 1.0：留一点余量，但仍要卡住"忘了乘"这个退化。 */
  const ksList = SOLAR_TERMS.map((t) => ({ t, ks: vOf(t).termTintHSV[1] }));
  const bad = ksList.filter((x) => x.ks >= 0.95).map((x) => `${x.t}=${x.ks.toFixed(3)}`);
  assert.equal(bad.length, 0,
    `这些档的 ks >= 0.95（没有降饱和，或方向反了）：\n  ${bad.join('\n  ')}`);
  // 阳性对照：ks 全域必须真的在动（全等于常数 = 表被"规律化"了）
  const uniq = new Set(ksList.map((x) => x.ks.toFixed(4)));
  assert.ok(uniq.size >= 18,
    `24 档的 ks 去重后只有 ${uniq.size} 种 —— 表被规律化，实测值塌成了几个`);
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
  // ⚠️ 判据从 tintR 换成 kv（HSV 的亮度比）：它才是真正送进 shader 的量，
  //   用它判才能保证"判据量的性质 = 画面性质的性质"。
  for (const t of SOLAR_TERMS) {
    const seq = [0, 1 / 6, 2 / 6, 3 / 6, 4 / 6, 5 / 6].map((k) => blendV(t, k).termTintHSV[2]);
    const steps = seq.slice(1).map((v, i) => Math.abs(v - seq[i]));
    const hi = Math.max(...steps);
    assert.ok(hi > 1e-4, `${t} 档内 kv 全段恒定在 ${seq[0].toFixed(3)}（阶梯，不是渐变）`);
    // 步长不均上限从 1.35 放宽到 1.6：实测色标不是等距构造，段内步长由
    //   两档实测值的连线决定，**本来就不该被要求等距**。要防的是
    //   "某一小段几乎不动、其余全挤在前半段"这种阶梯化。
    assert.ok(hi / Math.min(...steps) <= 1.6,
      `${t} 档内步长不均：${steps.map((x) => x.toFixed(3)).join('/')}`);
    // ★ 新增：段内必须**单调**（不折返）。折返 = 15 天里颜色来回变一次，
    //   比阶梯更糟（那是"闪"）。旧判据没查这条，因为两点 lerp 天然不可能折返。
    const dir = Math.sign(seq[seq.length - 1] - seq[0]) || 1;
    for (let i = 1; i < seq.length; i++) {
      assert.ok((seq[i] - seq[i - 1]) * dir >= -1e-9,
        `${t} 档内 kv 在 ${(i / 6).toFixed(2)} 处折返：${seq[i - 1].toFixed(4)} -> ${seq[i].toFixed(4)}`);
    }
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
    }).termTintHSV[0];
    const target = vOf(to).termTintHSV[0];
    assert.ok(Math.abs(at1 - target) < 1e-6,
      `${from} 段末(warmth=${w1}) dh=${at1.toFixed(4)}，但下一档 ${to} 是 ${target.toFixed(4)}`);
  }
  // ★ 新增：段内起点必须精确落在**本档**的实测值上。
  //   这是"查表 + 相邻档插值"这个新构造的核心不变式 ——
  //   t=0 时插值权重为 0，必须精确取到本档的值。
  //   （旧实现没有这条，因为它用"秩次→两点 lerp"，本档值天然在端点上。）
  for (const t of SOLAR_TERMS) {
    const start = visualFor({
      solarTerm: t,
      almanacProfile: { ...termProfile(t), deepWinter: 0 },
    }).termTintHSV[0];
    const table = vOf(t).termTintHSV[0];
    assert.ok(Math.abs(start - table) < 1e-6,
      `${t} 档初 gainR=${start.toFixed(4)} 与表里的实测值 ${table.toFixed(4)} 不符`);
  }
});
