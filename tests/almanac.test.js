/* 二十四节气物候档案 + 时令模式的纯逻辑验收。
 *
 * ── 为什么这些必须单测而不是靠看画面 ──────────────────────────────
 * 渐变是这个模块的全部价值所在，而「渐变」最容易出的错是**静默**的：
 *   · `almanacFromLongitude` 少写一次%360取模 ⇒ 跨 360° 的那几天全错，且只在一年里出现几次；
 *   · `blendTerm` 忘了夹 t ⇒ 交接那一瞬间画面会闪到下一个节气的终值；
 *   · `cycleOffset` 用 Math.round 而不是 Math.floor ⇒ 每档提前半格跳，
 *     肉眼看着"也差不多"，但和真实节气对不上。
 * 这些都不出异常、不变红，只是 quietly 地错。
 *
 * ── 为什么每条「没有X」的断言都要配阳性对照 ─────────────────────────
 * 只断言"某处不该出现"很容易恒真（尺子坏了也是绿的）。所以下面成对写：
 * 「t=0 必须是 A 的原值」+「t=1 必须是 B 的原值」+「t 必须真的动」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  SOLAR_TERMS, TERM_SEASON, ALMANAC_MODES, CYCLE_STEP_MS, CYCLE_HOLD,
  termProfile, termSeason, nextTerm, blendTerm, cycleOffset, cycleBlend, resolveAlmanac, almanacFromLongitude,
} from '../src/engine/almanac.js';
import { getSolarTerm, solarLongitude } from '../src/lib/environment.js';

test('二十四节气与季节分组：24 项齐全、四季各 6 项', () => {
  assert.equal(SOLAR_TERMS.length, 24);
  assert.equal(new Set(SOLAR_TERMS).size, 24, '节气名不能重复');
  assert.equal(TERM_SEASON.length, 24);
  for (const key of ['spring', 'summer', 'autumn', 'winter']) {
    assert.equal(TERM_SEASON.filter((s) => s === key).length, 6, `${key} 应有 6 个节气`);
  }
  // ★ 阳性对照：分组不是随便填的 —— 夏至必须夏天、大雪必须冬天。
  assert.equal(termSeason('夏至'), 'summer');
  assert.equal(termSeason('大雪'), 'winter');
  assert.equal(termSeason('立春'), 'spring');
  assert.equal(termSeason('霜降'), 'autumn');
});

test('SOLAR_TERMS 与 environment.js 的内部表严格同序（否则黄经索引会整体错位）', () => {
  // 判据：每个节气名在 getSolarTerm() 里都能被黄经反查回自己。
  // 若两个表顺序不一致，同一个 index 会指向不同名字，这行立刻红。
  for (let i = 0; i < 24; i++) {
    const name = SOLAR_TERMS[i];
    const longitude = i * 15 + 7.5;
    assert.equal(getSolarTerm(dateAtLongitude(longitude)), name,
      `${name}(index ${i}) 与 environment.js 的表对不上`);
  }
});

/** 造一个"太阳黄经正好等于 longitude"的日期：黄经≈ 随日期线性递增，直接反解逼近。 */
function dateAtLongitude(longitude, guessYear = 2026) {
  // 黄经每天约 +0.9856°。用两次牛顿迭代足够收敛到 0.05°（远小于 15° 档宽）。
  let days = longitude / 0.9856;
  for (let i = 0; i < 6; i++) {
    const value = solarLongitude(new Date(Date.UTC(guessYear, 0, 1) + days * 86_400_000));
    days += (longitude - value) / 0.9856;
  }
  return new Date(Date.UTC(guessYear, 0, 1) + days * 86_400_000);
}

test('almanacFromLongitude：每 15° 一档，t 从 0 单调走到接近 1，且跨 360° 回绕', () => {
  // ① 档位正确 + t 的边界
  for (let i = 0; i < 24; i++) {
    const atStart = almanacFromLongitude(i * 15);
    assert.equal(atStart.term, SOLAR_TERMS[i]);
    assert.equal(atStart.index, i);
    assert.equal(atStart.t, 0, '刚交节时 t 必须是 0');
    const mid = almanacFromLongitude(i * 15 + 7.5);
    assert.equal(mid.term, SOLAR_TERMS[i], '半档处仍属当前节气');
    assert.ok(Math.abs(mid.t - 0.5) < 1e-9, `半档处 t 应为 0.5，实为 ${mid.t}`);
  }
  // ② t 在**档内**单调递增。
  //   ⚠️ 判据必须限定在档内：`t` 是"本档内的进度"，跨档时它**必然**从 ~1 跳回 0
  //   （15° 处归零）—— 那是设计，不是回退。第一版没限定档内，这条永远红。
  //   ★ 而"档内单调"仍然能抓住真bug：只要实现写成`t = 角度/15` 之类，档内也会抖。
  for (let index = 0; index < 24; index++) {
    let previous = -1;
    for (let offset = 0; offset < 15; offset += 0.5) {
      const { t } = almanacFromLongitude(index * 15 + offset);
      assert.ok(t >= previous - 1e-12, `${index} 档内 ${offset}° 处 t 回退：${previous} → ${t}`);
      assert.ok(t >= 0 && t < 1, `t 越界：${t}`);
      previous = t;
    }
    // 每档末尾必须真的接近 1（否则"渐变"在档尾断了，最后一档永远是半个节气）
    assert.ok(almanacFromLongitude(index * 15 + 14.99).t > 0.999,
      `${index} 档末尾 t 应 >0.999，实为 ${almanacFromLongitude(index * 15 + 14.99).t}`);
  }
  // ③ 跨 360° 回绕：370° 应等同 10°，负角度也照常
  assert.deepEqual(almanacFromLongitude(370), almanacFromLongitude(10));
  assert.deepEqual(almanacFromLongitude(-10), almanacFromLongitude(350));
  assert.equal(almanacFromLongitude(360).term, SOLAR_TERMS[0], '正好 360° 应回到第 0 档');
});

test('blendTerm：t=0 原值、t=1 变成下一档，中间单调，且离散维度不过半程不抢跑', () => {
  const from = '立夏', to = nextTerm(from);
  assert.equal(to, '小满');
  // ① 两端必须**精确**等于两端档案 —— 不能有插值残留
  assert.deepEqual(blendTerm(from, 0), termProfile(from));
  assert.deepEqual(blendTerm(from, 1), termProfile(to));
  // ② 中间必须真的动（★ 阳性对照：不然"blendTerm 永远返回 a"也能过上面两条）
  const middle = blendTerm(from, 0.5);
  assert.ok(middle.warmth > termProfile(from).warmth && middle.warmth < termProfile(to).warmth,
    `warmth 应在两档之间，实为 ${middle.warmth}`);
  // ③ t 要被夹住：越界输入不能产生"反向渐变"或过冲
  assert.deepEqual(blendTerm(from, -5), termProfile(from));
  assert.deepEqual(blendTerm(from, 5), termProfile(to));
  // ④ 离散维度：过了半程才整块切过去，绝不出现"半朵荷花"
  // ★ 用真实相邻的一对（小满 .55 → 芒种 .75），并先断言两端确实不同 ——
  //   否则挑一对 lotus 相同的节气，下两条断言就是恒真。
  assert.equal(nextTerm('小满'), '芒种', '★ 对照：下一档必须是芒种，顺序变了请同步改本测试');
  const lotusFrom = termProfile('小满').lotus, lotusTo = termProfile('芒种').lotus;
  assert.notEqual(lotusFrom, lotusTo, '★ 小满与芒种的 lotus 必须不同，否则下面两条恒真');
  assert.equal(blendTerm('小满', 0.4).lotus, lotusFrom, '未过半程应保持原侧');
  assert.equal(blendTerm('小满', 0.6).lotus, lotusTo, '过半程应整块切到下一侧');
  // ⑤ 反向也要成立：大雪（lotus 0）→ 冬至（0）恒定，而处暑（.3）→ 白露（.08）是"渐暗"
  assert.equal(blendTerm('秋分', 0.9).lotus, termProfile('寒露').lotus);
});

test('nextTerm 环形：立冬→小雪，驚蛰→春分，未知名字退回春分', () => {
  assert.equal(nextTerm('立冬'), '小雪');
  assert.equal(nextTerm('惊蛰'), '春分');
  assert.equal(nextTerm('不存在的节气'), '春分');
  // 环长必须是 24（否则 nextTerm 会绕不到原点）
  let term = '春分';
  for (let i = 0; i < 24; i++) term = nextTerm(term);
  assert.equal(term, '春分', '绕 24 圈必须回到起点');
});

test('termProfile/termSeason 对未知名字一律退回中性值，永不抛错', () => {
  for (const bad of ['', '不存在', null, undefined, 42, {}]) {
    const profile = termProfile(bad);
    assert.equal(typeof profile.warmth, 'number', `termProfile(${bad}) 必须给出数字档案`);
    assert.ok(profile.warmth >= 0 && profile.warmth <= 1);
    assert.equal(termSeason(bad), 'summer');
    assert.equal(nextTerm(bad), '春分');
  }
});

test('★ 物候档案必须自洽：大雪比立冬冷、霜降比白露凉', () => {
  // 这条是"手写 24 组数"最便宜的护栏 —— 抄错顺序时它不会变红，
  // 但整条冷暖曲线会反过来，而画面上只表现为"冬天有点暖"，极难察觉。
  const pairs = [['大雪', '立冬'], ['霜降', '白露'], ['冬至', '大暑'], ['小寒', '芒种'], ['大寒', '雨水']];
  for (const [cold, warm] of pairs) {
    assert.ok(termProfile(cold).warmth < termProfile(warm).warmth,
      `${cold}(${termProfile(cold).warmth}) 应比 ${warm}(${termProfile(warm).warmth}) 冷`);
  }
  // ★ 阳性对照：夏至必须是最热的那个（否则上面全绿也没有意义）
  const warmest = SOLAR_TERMS.reduce((a, b) => (termProfile(a).warmth >= termProfile(b).warmth ? a : b));
  assert.equal(warmest, '夏至');
  // ★ 最冷的是**大寒**（"三九、四九"里四九最冷），不是冬至。
  //   原断言写的是冬至 —— 那是因为档案把顺序搞反了（冬至 .06 < 小寒 .09），
  //   断言顺着错数据写，于是"错"和"护栏"互相加固。
  //   这就是"用实现值反推期望值"的典型后果：护栏变成了同谋。
  const coldest = SOLAR_TERMS.reduce((a, b) => (termProfile(a).warmth <= termProfile(b).warmth ? a : b));
  assert.equal(coldest, '大寒');
  // ★ 冬三档必须是**持续降温**（冬至 → 小寒 → 大寒），不能来回摆。
  assert.ok(termProfile('冬至').warmth > termProfile('小寒').warmth, '冬至应比小寒暖');
  assert.ok(termProfile('小寒').warmth > termProfile('大寒').warmth, '小寒应比大寒暖');
});

test('cycleOffset：每 stepMs 整档、phase∈[0,1)，且处理负数与非法 stepMs', () => {
  const step = CYCLE_STEP_MS;
  // ① 整档边界：t=0 必须是 phase 0（★ 用 floor 不是 round）
  assert.equal(cycleOffset(0).step, 0);
  assert.equal(cycleOffset(0).phase, 0);
  assert.equal(cycleOffset(step - 1).step, 0, '差 1ms 不该提前进档');
  assert.equal(cycleOffset(step).step, 1);
  assert.equal(cycleOffset(step).phase, 0);
  // ② phase 恒在 [0,1)
  for (let i = 0; i < 500; i++) {
    const { phase } = cycleOffset(i * 137);
    assert.ok(phase >= 0 && phase < 1, `phase 越界：${phase}`);
  }
  // ③ 退化输入：非法 stepMs 退回默认，非法 stamp 退回 0（不产生 NaN）
  assert.deepEqual(cycleOffset(1000, 0).phase, cycleOffset(1000).phase);
  assert.deepEqual(cycleOffset(NaN).phase, 0);
  assert.ok(Number.isFinite(cycleOffset(Infinity).phase));
});

test('cycleBlend：前 55% 为 0（稳停本档），后段单调升到 1', () => {
  // ★ 这是"演示轮转看得清当前是哪一档"的根本：不能全程都在渐变。
  assert.equal(cycleBlend(0), 0);
  assert.equal(cycleBlend(CYCLE_HOLD - 1e-9), 0);
  assert.equal(cycleBlend(CYCLE_HOLD), 0);
  let previous = -1;
  for (let p = CYCLE_HOLD; p < 1; p += 0.01) {
    const t = cycleBlend(p);
    assert.ok(t >= previous - 1e-9, `过渡量回退了：${previous} → ${t}`);
    assert.ok(t >= 0 && t <= 1);
    previous = t;
  }
  assert.ok(Math.abs(cycleBlend(1) - 1) < 1e-9, '档末必须完全过渡到下一档');
  assert.equal(cycleBlend(-3), 0, '越界输入夹到 0');
  assert.equal(cycleBlend(NaN), 0);
});

test('resolveAlmanac：三种模式各走各的路，非法输入一律不解析（返回 null）', () => {
  // follow 不该在这里解析 —— 它由黄经推导，不是档位索引
  assert.equal(resolveAlmanac('follow', '夏至'), null);
  // manual 认合法节气
  const manual = resolveAlmanac('manual', '大雪');
  assert.equal(manual.term, '大雪');
  assert.equal(manual.index, 17);
  assert.equal(manual.profile, termProfile('大雪'));
  // ★ 手动模式给非法节气必须返回 null（而不是默默回落到第一个节气）
  assert.equal(resolveAlmanac('manual', ''), null);
  assert.equal(resolveAlmanac('manual', '小雪怪'), null);
  assert.equal(resolveAlmanac('manual', null), null);
  // cycle 按索引轮转，且负数 / 超界都能回绕
  assert.equal(resolveAlmanac('cycle', null, 0).term, '春分');
  assert.equal(resolveAlmanac('cycle', null, 6).term, '夏至');
  assert.equal(resolveAlmanac('cycle', null, 17).term, '大雪');
  assert.equal(resolveAlmanac('cycle', null, 24).term, '春分');
  // ★ -1 回绕到 index 23 = 惊蛰（列表最后一个），不是"倒数第二个"。
  assert.equal(resolveAlmanac('cycle', null, -1).term, '惊蛰');
  assert.equal(resolveAlmanac('cycle', null, -25).term, '惊蛰', '负数超出 24 也要正确回绕');
  // 未知模式一律不解析
  assert.equal(resolveAlmanac('乱写', '夏至'), null);
});

test('★ 时令模式合法取值只有三个，且必须覆盖 useEnvironment 的分支', () => {
  assert.deepEqual([...ALMANAC_MODES], ['follow', 'manual', 'cycle']);
  // useEnvironment 里的分支必须正好是这三个 —— 多一个模式而忘了接线，
  // 就会静默走follow 分支，用户点了没反应。这里用源码文本当护栏。
  const source = readFileSync(new URL('../src/hooks/useEnvironment.js', import.meta.url), 'utf8');
  for (const mode of ALMANAC_MODES) assert.ok(source.includes(`'${mode}'`), `useEnvironment 里没有 ${mode} 分支`);
});

test('storage 清洗：非法 almanacMode/almanacTerm 退回 follow，不许污染下游', async () => {
  const { loadSettings, DEFAULT_SETTINGS } = await import('../src/lib/storage.js');
  const store = new Map([['fusheng-settings', JSON.stringify({ almanacMode: '乱写', almanacTerm: '小雪怪'.repeat(9) })]]);
  const previous = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, v),
    removeItem: (k) => store.delete(k),
  };
  try {
    const loaded = loadSettings();
    assert.equal(loaded.almanacMode, 'follow');
    assert.equal(loaded.almanacTerm, '');
    assert.deepEqual(
      [loaded.almanacMode, loaded.almanacTerm],
      [DEFAULT_SETTINGS.almanacMode, DEFAULT_SETTINGS.almanacTerm],
    );
  } finally {
    globalThis.localStorage = previous;
  }
});
