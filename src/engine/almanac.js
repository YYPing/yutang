/**
 * 二十四节气物候档案 + 时令模式解析。
 *
 * 为什么单独一个模块：
 *   `getSolarTerm()`（lib/environment.js）已经用黄经每15° 一档算准了节气，
 *   但结果过去只进 HUD 文字。本模块把它接到渲染需要的**参数档案**上。
 *
 * 三条不变式（改动时务必保持）：
 *   ① **渐进插值**：节气不是跳变。真实节气每 15° 才换一档（约 15 天），
 *      而 15° 内的视觉应当是连续过渡的 —— 否则每半个月"啪"地变一次。
 *   ② **手写维度是 4 个季节**：所有 24 项都映射到既有 `season`（春夏秋冬），
 *      因为 `CAUSTIC.season` / `SEASON_LIGHT` / 背景贴图都只认这 4 个值。
 *      本模块只**加**精度，不改下游的枚举。
 *   ③ **外部不可信**：存档里的 `almanacMode` / `almanacTerm` 一律经`pick` 清洗，
 *      非法值退回`follow`。
 */

/** 与 `lib/environment.js` 的 `SOLAR_TERMS` 同序（以春分为首）。导出以便测试互查。 */
export const SOLAR_TERMS = Object.freeze([
  '春分', '清明', '谷雨', '立夏', '小满', '芒种',
  '夏至', '小暑', '大暑', '立秋', '处暑', '白露',
  '秋分', '寒露', '霜降', '立冬', '小雪', '大雪',
  '冬至', '小寒', '大寒', '立春', '雨水', '惊蛰',
]);

/** 季节分组：每 6 个节气一组，与 `SOLAR_TERMS` 的下标一一对应。 */
export const TERM_SEASON = Object.freeze([
  'spring', 'spring', 'spring', 'summer', 'summer', 'summer',
  'summer', 'summer', 'summer', 'autumn', 'autumn', 'autumn',
  'autumn', 'autumn', 'autumn', 'winter', 'winter', 'winter',
  'winter', 'winter', 'winter', 'spring', 'spring', 'spring',
]);

/** 温度：0=严寒 1=酷暑。用来调焦散强度与水色冷暖。 */
const TERM_PROFILE = Object.freeze({
  春分: { warmth: .58, lotus: 0, bud: 0.62,  pod: 0.00,   leaf: .25, litter: 0,   frost: 0,   ice: 0 },
  清明: { warmth: .62, lotus: 0, bud: 0.78,  pod: 0.00,   leaf: .45, litter: 0,   frost: 0,   ice: 0 },
  谷雨: { warmth: .68, lotus: .1, bud: 0.85,  pod: 0.00, leaf: .7,  litter: 0,   frost: 0,   ice: 0 },
  立夏: { warmth: .74, lotus: .3, bud: 0.55,  pod: 0.00, leaf: .85, litter: 0,   frost: 0,   ice: 0 },
  小满: { warmth: .80, lotus: .55, bud: 0.34,  pod: 0.00,leaf: .90, litter: 0,   frost: 0,   ice: 0 },
  芒种: { warmth: .86, lotus: .78, bud: 0.18,  pod: 0.00,leaf: .96, litter: 0,   frost: 0,   ice: 0 },
  // ★ warmth/leaf 留一点余量（.99 而非 1）：铁律③「连续优先于精确」——
  //   撞上界会让 `warmth==1` 的档与邻档在**色调与荷叶**上同时饱和。
  //   夏至(1.00)与小暑(.93) 的 warmth 差 .07 已够，但 leaf 都是 1（22 片），
  //   于是两档之间只剩"荷花 5 vs 4"这一项，量具实测只剩 0.20% 像素差。
  //   留 .01 的余量让小暑能拉开，物理上也对：夏至前后是一年最热，
  //   但并非"此后每天都在变冷"——峰值之后有一个平台期。
  夏至: { warmth: .99,  lotus: 1, bud: 0.12,  pod: 0.00,   leaf: 1,   litter: 0,   frost: 0,   ice: 0 },
  // ★ 小暑 / 大暑 不再与夏至同值。
  //   起因：接入渲染参数后 `probe-terms` 报「夏至→小暑 距离 = 0.0」——
  //   这两档档案**逐字段完全相同**，于是画面上根本无法区分（用户反馈「都一样」）。
  //   按真实物候差异拉开：夏至荷花最盛、叶片最密、暑热顶点；
  //   小暑入伏、午后雷雨 ⇒ 暑热略减、荷花开始收（lotus↓）而荷叶仍最盛（leaf 保持 1）；
  //   大暑一年最闷热、多雷暴，荷叶开始枯边（leaf↓）并偶有落叶（litter 从0 起）。
  小暑: { warmth: .93,  lotus: .82, bud: 0.10,  pod: 0.00, leaf: .96, litter: 0,   frost: 0,   ice: 0 },
  大暑: { warmth: .90,  lotus: .62, bud: 0.14,  pod: 0.00, leaf: .98, litter: .04, frost: 0,   ice: 0 },
  立秋: { warmth: .82, lotus: .6, bud: 0.22,  pod: 0.10,  leaf: .88, litter: .1,  frost: 0,   ice: 0 },
  处暑: { warmth: .76, lotus: .3, bud: 0.34,  pod: 0.22,  leaf: .75, litter: .3,  frost: 0,   ice: 0 },
  白露: { warmth: .66, lotus: .08, bud: 0.30,  pod: 0.55, leaf: .55, litter: .6,  frost: 0,   ice: 0 },
  秋分: { warmth: .58, lotus: 0, bud: 0.22,  pod: 0.72,   leaf: .4,  litter: 1,   frost: 0,   ice: 0 },
  寒露: { warmth: .48, lotus: 0, bud: 0.12,  pod: 0.78,   leaf: .3,  litter: .9,  frost: .2,  ice: 0 },
  霜降: { warmth: .38, lotus: 0, bud: 0.08,  pod: 0.68,   leaf: .2,  litter: .7,  frost: .8,  ice: .15 },
  立冬: { warmth: .28, lotus: 0, bud: 0.00,  pod: 0.40,   leaf: .1,  litter: .5,  frost: 1,   ice: .4,  deepWinter: .20 },
  小雪: { warmth: .20, lotus: 0, bud: 0.00,  pod: 0.22,   leaf: .05, litter: .3,  frost: 1,   ice: .7,  deepWinter: .48 },
  大雪: { warmth: .12, lotus: 0, bud: 0.00,  pod: 0.08,   leaf: 0,   litter: .15, frost: 1,   ice: 1,   deepWinter: .74 },
// ★★★ 冬六档：这里是"用连续量表达离散事实"的反面教材，完整记录以免重犯。
//
//   起因：用户反馈「每个节气之间都一样」。冬六档（大雪/冬至/小寒/大寒）
//   **全部 ice=1、frost=1、leaf=0、lotus=0、焦散全压到 .006**
//   ⇒ 在画面上几乎逐像素相同。
//
//   修的过程走了三轮弯路，每轮只把探针的「最接近相邻档距离」从 0.1 推到 0.3：
//     ① 调档案数值（把冬至 warmth 从 .06 改到 .10）
//     ② 加 snow/cracks 两维并从 warmth 反推 ⇒ **饱和**（小寒/大寒都夹到 1.0）
//     ③ 把 sin 曲线改成分段、让末端分岔
//   每轮只涨 0.1，因为**方向本身错了**：
//   连续量（温度）表达不了离散的事实 ——「三九 / 四九」是"第几个九"，不是"多少度"。
//
//   正解：档案直接给出**冰形态序号** `deepWinter`
//   （立冬起冰 → 小雪加厚 → 大雪冰封 → 三九最整 → 四九最脆），
//   渲染层只做一次线性映射，不再二次加工。
//   ★ 同一教训也写在 term-visual.js 的文件头。
  冬至: { warmth: .10, lotus: 0, bud: 0.00,  pod: 0.05,   leaf: 0,   litter: .12, frost: 1,   ice: 1,   deepWinter: .90 },
  小寒: { warmth: .05, lotus: 0, bud: 0.00,  pod: 0.03,   leaf: 0,   litter: .1,  frost: 1,   ice: 1,   deepWinter: 1.0 },
  大寒: { warmth: .02, lotus: 0, bud: 0.00,  pod: 0.02,   leaf: 0,   litter: .08, frost: 1,   ice: .95, deepWinter: .97 },
  立春: { warmth: .30, lotus: 0, bud: 0.00,  pod: 0.00,   leaf: .1,  litter: .15, frost: .6,  ice: .45 , deepWinter: .45 },
  雨水: { warmth: .40, lotus: 0, bud: 0.12,  pod: 0.00,   leaf: .2,  litter: .1,  frost: .2,  ice: .12 , deepWinter: .12 },
  // ★ leaf 从 .35 降到 .17（2026-10-04，`tests/almanac-pheno.test.js` 抓到的真缺陷）。
  //   原值让春/夏的浮叶量走出「雨水 .20 → 惊蛰 .35 → 春分 .25」的**先升后降**，
  //   而需求 104–105 行写的是 惊蛰·春分「新芽、小花苞尖 / 新叶初铺」→
  //   清明·谷雨「新叶满铺」，即惊蛰只有芽（浮叶很少）、到谷雨才铺满。
  //   参考图也明确「春分的叶已比惊蛰大」。.35 让惊蛰凭空多出 4 片大浮叶，
  //   与春分只差 2 片 —— 画面上「惊蛰」和「春分」几乎一样，正是用户说的"都一样"。
  惊蛰: { warmth: .50, lotus: .05, bud: 0.45,  pod: 0.00,leaf: .17, litter: 0,   frost: 0,   ice: 0 },
});

/** 找不到时的中性档案（比"报错"好：画面照常，只是少了物候细节）。 */
const NEUTRAL = Object.freeze({ warmth: .6, lotus: 0, leaf: .3, litter: .2, frost: 0, ice: 0 });

/** 线性插值。`t` 会被夹到 [0,1]，所以调用方不必自己保证。 */
const mix = (a, b, t) => a + (b - a) * Math.max(0, Math.min(1, t));
/** 数字档案插值；其他字段（lotus/leaf 这类离散显隐）取权重更大的一侧。 */
function mixProfile(a, b, t) {
  if (t < .5) return a;
  return b;
}

/** 某个节气的档案。未知名称退回中性档案，永不抛错。 */
export function termProfile(term) {
  return TERM_PROFILE[term] ?? NEUTRAL;
}

/** 节气 → 四季（供 `CAUSTIC.season` / `SEASON_LIGHT` / 背景贴图复用）。 */
export function termSeason(term) {
  const index = SOLAR_TERMS.indexOf(term);
  return index < 0 ? 'summer' : TERM_SEASON[index];
}

/** 下一个节气的名字（用于渐变的另一半）。立春之后回到春分。 */
export function nextTerm(term) {
  const index = SOLAR_TERMS.indexOf(term);
  if (index < 0) return SOLAR_TERMS[0];
  return SOLAR_TERMS[(index + 1) % SOLAR_TERMS.length];
}

/**
 * 两个节气之间做渐变。
 *
 * @param term 当前节气
 * @param t   过渡进度 0（完全当前）→ 1（完全下一个）
 */
export function blendTerm(term, t = 0) {
  const a = termProfile(term);
  if (t <= 0) return a;
  const b = termProfile(nextTerm(term));
  if (t >= 1) return b;
  return {
    warmth: mix(a.warmth, b.warmth, t),
    // 离散显隐：过了半程就整块切过去，避免"半朵荷花"
    lotus: mixProfile(a.lotus, b.lotus, t),
    leaf: mix(a.leaf, b.leaf, t),
    litter: mix(a.litter, b.litter, t),
    frost: mix(a.frost, b.frost, t),
    ice: mix(a.ice, b.ice, t),
    // ★ `deepWinter` 必须一起插值。它是"冰层序号"（0–1），
    //   漏掉它 ⇒ 从「大雪」渐变到「小雪」时冰的形态会**跳变**而不是过渡，
    //   而这正好是 §八「节气切换用渐变」要避免的东西。
    //   非冬季档位没有这个键 ⇒ 用 0 兜底（`?? 0`），中性档案同理。
    deepWinter: mix(a.deepWinter ?? 0, b.deepWinter ?? 0, t),
  };
}

/* ── 时令模式 ──────────────────────────────────────────────── */

/** 存档里 `almanacMode` 的合法取值。`follow`=跟随真实，`manual`=手动指定，`cycle`=演示轮转。 */
export const ALMANAC_MODES = Object.freeze(['follow', 'manual', 'cycle']);

/** `cycle` 模式每档停留时长（毫秒）。3 秒足够看清一档，又不至于等太久。 */
export const CYCLE_STEP_MS = 3000;

/**
 * 解析出"当前该显示哪个节气"，以及要不要做演示轮转。
 *
 * @param mode         'follow' | 'manual' | 'cycle'
 * @param manualTerm   mode==='manual' 时用户指定的节气
 * @param cycleIndex   mode==='cycle' 时第几档（由调用方按真实时间推导，0–23）
 */
export function resolveAlmanac(mode, manualTerm, cycleIndex = 0) {
  if (mode === 'manual' && SOLAR_TERMS.includes(manualTerm)) {
    return { term: manualTerm, profile: termProfile(manualTerm), index: SOLAR_TERMS.indexOf(manualTerm) };
  }
  if (mode === 'cycle') {
    const index = ((Math.floor(cycleIndex) % SOLAR_TERMS.length) + SOLAR_TERMS.length) % SOLAR_TERMS.length;
    const term = SOLAR_TERMS[index];
    return { term, profile: termProfile(term), index };
  }
  return null;
}

/**
 * 演示轮转的时基：把「墙上时钟」换成「第几档 + 这一档走到哪」。
 *
 * ★ 为什么要单独抽出来：轮转的档位与过渡量都必须是**纯函数**，
 *   否则就没法单测（"3 秒后画面变了"这种断言没法在 `node --test` 里写）。
 *   同时它天生处理了负数时间戳与 stepMs≤0 的退化输入。
 *
 * @param stamp  墙上时钟（毫秒）
 * @param stepMs 每档停留时长
 * @returns {{step: number, phase: number}} step 可为任意整数· phase∈[0,1)
 */
export function cycleOffset(stamp = 0, stepMs = CYCLE_STEP_MS) {
  const step = Number.isFinite(stepMs) && stepMs > 0 ? stepMs : CYCLE_STEP_MS;
  const at = Number.isFinite(stamp) ? stamp : 0;
  return { step: Math.floor(at / step), phase: (at - Math.floor(at / step) * step) / step };
}

/**
 * 轮转时的过渡进度：前 `CYCLE_HOLD` 段稳停本档，之后才渐变到下一档。
 *
 * ⚠️ 上界夹到 **1**（不是 0.999）：`phase` 本身恒 <1，所以只有显式传 1 才到得了顶。
 *   第一版夹在 0.999，于是 `cycleBlend(1)` 返回 .9978 —— 永远差一点，
 *   意味着「本档已完全过渡」这个状态不可达（视觉上：刚换档时还带着上一档 0.2% 的残留）。
 */
export const CYCLE_HOLD = 0.55;
export function cycleBlend(phase) {
  const p = Math.max(0, Math.min(1, Number.isFinite(phase) ? phase : 0));
  return p < CYCLE_HOLD ? 0 : (p - CYCLE_HOLD) / (1 - CYCLE_HOLD);
}

/**
 * 从真实黄经角度算出"当前是第几档 + 过渡进度"。
 *
 * 为什么需要它：24 个节气是**离散档位**，但视觉应该连续。
 * 用「距下一个交节的角度」当进度，就得到了自然的插值。
 *
 * @param longitude 太阳黄经（0–360 度），可带小数；超范围按360 取模
 * @returns {{term: string, index: number, t: number, season: string}} t∈[0,1)，0=刚交节
 */
export function almanacFromLongitude(longitude) {
  const span = 360 / SOLAR_TERMS.length;
  const wrapped = ((longitude % 360) + 360) % 360;
  const index = Math.floor(wrapped / span);
  const t = (wrapped - index * span) / span;
  const term = SOLAR_TERMS[index];
  return { term, index, t, season: TERM_SEASON[index] };
}
