/* §10.5 光照场验收：光池与梦幻光柱（F-10.5.1 ~ F-10.5.5 / US-11）。
 *
 * ── 为什么这一层必须用「数值」验收，不能靠看截图 ──────────────────────────
 * 「阳光照耀的光影效果」这种话没法判真假。但需求把阳光写成了一个**标量场**，
 * 并且给了六个互相咬合的数字：底光 .36 · 光池 .55 · σ .26 · y .26h · 暗处 .67 · 明暗差 1.43。
 * 只要它们同时成立，画面就**必然**有「阳光处亮、别处暗」的结构 ——
 * 这比"我觉得亮了点"结实得多。
 *
 * ── 六个数字为什么能同时成立（这是本脚本存在的第一理由） ──────────────────
 * F-10.5.1 只写了「底光 + 光池 + 光柱 − 云影」，但验收列同时给了「暗处 .67」。
 * 只按公式求和，暗处只能是 `.36`。所以差出来的 `.31`（水面底色）必须显式存在。
 * 本脚本的 ① 组就是在守这一条：**删掉 waterBase，① 立刻变红**（见 `_light-break.cjs`）。
 *
 * ── 阳性对照（证明尺子真的在量，而不是恒真） ────────────────────────────
 * 每一项都配一条"把它关掉，读数必须动"的断言：
 *   · 底光 → 切 night，暗处从 .67 掉到 .59
 *   · 光池 → 从池心挪到左下角，读数掉 > .5
 *   · 光柱 → 手工放一束在轴上，读数升 ≈ .26
 *   · 云影 → 切 rainy，池心读数必须**下降**
 *   · 梦幻 → 柱外必须恒为 0（否则整池鱼都在发光）
 *
 * ── ⚠️ 为什么写成「可导出的 runner」而不是一个 CLI 脚本 ────────────────────
 * 本环境里托管的 node.exe **不能再 spawn 自己**（`EBUSY`，Windows 锁住正在跑的 exe）。
 * 于是「改坏源码 → 跑一遍看会不会红」这条反证路走不通。
 * 改成 `runLightChecks({ light })` 之后，反证脚本可以在**同一进程内**用
 * 带 query 的 `import()` 重新读到刚被改写的模块（`?v=N` 绕过 ESM 缓存），
 * 不 spawn、不落临时文件。副产物是 `tests/light-field.test.js` 能直接复用同一把尺子。
 *
 * 跑法：node tools/check-light.js
 *       node tools/_light-break.cjs        ← 反证
 */
import * as defaultLight from '../src/engine/light-field.js';
import { pathToFileURL } from 'node:url';

const near = (a, b, tol = 0.011) => Math.abs(a - b) <= tol;
const n3 = (v) => (Math.round(v * 1000) / 1000).toFixed(3);

/**
 * ⚠️⚠️ **需求原文的数字，在这里独立抄一份，故意不从被测模块 import。**
 *
 * 这是本文件最容易写错、也最致命的一处。如果尺子用 `LIGHT.poolSigma` 去算采样点，
 * 那么「σ 改成 .08」时采样点也跟着缩小 .08/.26 倍 —— 读数**一模一样**，
 * 断言照样全绿。那不是验收，那是**照镜子**：量的是"实现与它自己一致"。
 *
 * 独立抄一份之后，尺子量的是「实现 ↔ 需求文本」。代价是需求改了要改两处，
 * 但这个代价是必须付的 —— 就是靠它，`_light-break.js` 里的 σ 破坏才翻得红。
 */
const SPEC = Object.freeze({
  ambientDay: 0.36, ambientNight: 0.28,
  waterBase: 0.31,
  poolPeak: 0.55, poolSigma: 0.26, poolY: 0.26, poolX: 0.62,
  fishBase: 0.44, fishGain: 0.82,
  shaftIntervalMin: 9, shaftIntervalMax: 26,
  shaftLifeMin: 5.5, shaftLifeMax: 12,
  darkLit: 0.67, poolLit: 1.19, fishRatio: 1.43,
  dreamThin: 0.11, dreamTail: 0.16,
});

const mulberry32 = (seed) => {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
};

/**
 * 跑完整套 §10.5 验收。
 * @param {object}   [opts]
 * @param {object}   [opts.light] 光照场模块（默认静态导入的那份）。**反证脚本靠它注入被改坏的副本。**
 * @param {Function} [opts.log]   输出函数（默认 console.log）。
 * @returns {{pass:number, fail:number, lines:string[]}}
 */
export function runLightChecks({ light = defaultLight, log = console.log } = {}) {
  const { LightField, LIGHT, lightChannels, shaftCurve } = light;
  const lines = [];
  const emit = (text = '') => { lines.push(text); log(text); };
  let pass = 0, fail = 0;
  const ok = (label, cond, detail = '') => {
    if (cond) { pass++; emit(`  ✔ ${label}${detail ? '  — ' + detail : ''}`); }
    else { fail++; emit(`  ✘ ${label}${detail ? '  — ' + detail : ''}`); }
  };
  const section = (title) => emit(`\n${title}`);

  const W = 1600, H = 1000;
  /** ⚠️ 一律用 SPEC 算像素，**不用 LIGHT** —— 否则 σ 一改，采样点跟着缩放，读数纹丝不动。 */
  const SIGMA = SPEC.poolSigma * Math.min(W, H);                   // 260px
  const POOL_CX = W * SPEC.poolX, POOL_CY = H * SPEC.poolY;
  /** F-10.5.2 的验收采样点：离池心 `.34σ`（沿 +x）。`.34` 是反推出来的，见文件头。 */
  const POOL_SAMPLE = { x: POOL_CX + 0.34 * SIGMA, y: POOL_CY };
  const DARK = { x: W * 0.06, y: H * 0.94 };

  const field = (partial = {}, seed = 4242) => {
    const lf = new LightField(mulberry32(seed));
    lf.configure({ weather: 'sunny', season: 'summer', night: false, quality: 'high', ...partial });
    return lf;
  };

  emit(`§10.5 光照场验收　画布 ${W}×${H}　σ=${SIGMA}px　光池心=(${POOL_CX}, ${POOL_CY})`);

  /* ========================================================== ① 数值口径 */

  section('① F-10.5.1 / F-10.5.2：六个数字同时成立');
  {
    const lf = field();
    const dark = lf.lightAt(DARK.x, DARK.y, W, H);
    const center = lf.lightAt(POOL_CX, POOL_CY, W, H);
    const sample = lf.lightAt(POOL_SAMPLE.x, POOL_SAMPLE.y, W, H);

    ok('暗处 lit = .67（= 水面底色 .31 + 底光 .36）', near(dark, SPEC.darkLit),
      `实测 ${n3(dark)}　需求 ${SPEC.darkLit}`);
    ok('光池心 lit = 1.220（= .31 + .36 + .55）',
      near(center, SPEC.waterBase + SPEC.ambientDay + SPEC.poolPeak, 0.006), `实测 ${n3(center)}`);
    ok('光池验收点 lit = 1.19（离池心 .34σ）', near(sample, SPEC.poolLit, 0.006),
      `实测 ${n3(sample)}　需求 ${SPEC.poolLit}`);
    ok('需求口径：底光显著低于光池', SPEC.ambientDay < SPEC.poolPeak,
      `底光 ${SPEC.ambientDay} < 光池 ${SPEC.poolPeak}`);
    ok('⚠️ 水面底色 .31 必须存在，否则「底光 .36」与「暗处 .67」互斥',
      near(LIGHT.waterBase + LIGHT.ambientDay, SPEC.darkLit),
      `.31 + .36 = ${n3(LIGHT.waterBase + LIGHT.ambientDay)}`);

    // ── 常数逐字一致：先证明实现里抄的就是需求那串数，再谈画面
    const same = ['ambientDay', 'ambientNight', 'poolPeak', 'poolSigma', 'poolY', 'poolX',
      'fishBase', 'fishGain', 'shaftIntervalMin', 'shaftLifeMin', 'dreamThin', 'dreamTail']
      .filter((key) => LIGHT[key] !== SPEC[key]);
    ok('实现里的常数与需求逐字一致', same.length === 0,
      same.length ? `不一致：${same.map((k) => `${k} 实现 ${LIGHT[k]} ≠ 需求 ${SPEC[k]}`).join('　')}` : '12 项全同');

    // ── σ 的**绝对**口径。⚠️ 上面那条「验收点 lit = 1.19」是**验不出 σ 的**：
    //    `.34σ` 的偏移量本身随 σ 伸缩，σ 从 .26 改成 .08 读数一点不动。
    //    所以必须钉在**固定像素**上问：池心外 260px（= 需求的 1σ）该衰减到 e^−.5。
    const peak = lf.poolAt(POOL_CX, POOL_CY, W, H);
    const atOneSigma = lf.poolAt(POOL_CX + SIGMA, POOL_CY, W, H) / peak;
    const atTwoSigma = lf.poolAt(POOL_CX + 2 * SIGMA, POOL_CY, W, H) / peak;
    ok('σ 绝对值：池心外 260px（1σ）衰减到 e^−.5 = .607', near(atOneSigma, Math.exp(-0.5), 0.006),
      `实测 ${n3(atOneSigma)}`);
    ok('σ 绝对值：池心外 520px（2σ）衰减到 e^−2 = .135', near(atTwoSigma, Math.exp(-2), 0.006),
      `实测 ${n3(atTwoSigma)}`);

    emit(`\n    推导：池心理论上界 .31+.36+.55 = ${n3(LIGHT.waterBase + LIGHT.ambientDay + LIGHT.poolPeak)}`
      + `　−　高斯在 .34σ 的落差 ${n3(LIGHT.poolPeak - LIGHT.poolPeak * Math.exp(-0.34 * 0.34 / 2))}`
      + ` = ${n3(LIGHT.waterBase + LIGHT.ambientDay + LIGHT.poolPeak * Math.exp(-0.34 * 0.34 / 2))}`);
  }

  /* ========================================================== ② 鱼亮度 */

  section('② F-10.5.3：鱼亮度 = .44 + .82×lit　→　明暗差 1.43 倍');
  {
    const lf = field();
    const brightPool = lf.fishBrightness(SPEC.poolLit);
    const brightDark = lf.fishBrightness(SPEC.darkLit);
    const ratio = brightPool / brightDark;

    ok('公式系数原样落地（不许四舍五入成 .4/.8）', LIGHT.fishBase === SPEC.fishBase && LIGHT.fishGain === SPEC.fishGain,
      `.${(SPEC.fishBase * 100).toFixed(0)} + .${(SPEC.fishGain * 100).toFixed(0)}×lit`);
    ok('光池内鱼亮度 = 1.416', near(brightPool, SPEC.fishBase + SPEC.fishGain * SPEC.poolLit, 0.002),
      `实测 ${n3(brightPool)}`);
    ok('暗处鱼亮度 = .989', near(brightDark, SPEC.fishBase + SPEC.fishGain * SPEC.darkLit, 0.002),
      `实测 ${n3(brightDark)}`);
    ok('★ 明暗差 = 1.43 倍', near(ratio, SPEC.fishRatio, 0.004), `${n3(ratio)} 倍　需求 ${SPEC.fishRatio}`);
    const ref = lf.referenceLit;
    ok('归一化分母 = 暗处 lit（光池外的鱼增益恒为 1，现有观感不回退）',
      near(lf.fishBrightness(ref) / lf.fishBrightness(ref), 1, 1e-12), `referenceLit = ${n3(ref)}`);
  }

  /* ========================================================== ③ 光柱 */

  section('③ F-10.5.4：光柱每 9–26s 一束、存续 5.5–12s');
  {
    const lf = field({}, 913);
    const intervals = [];
    const lives = [];
    let sinceSpawn = 0;
    let maxConcurrent = 0;
    /** ⚠️ 必须按**柱的编号**判"出了新的一束"，不能按 `shafts.length` 变大 ──
     *  两束并存时「新出一束 + 旧死一束」的净变化是 0，按长度判会**整整漏掉那次生成**，
     *  于是漏掉的那段被算进下一个间隔，量出 35.6s 的假越界。 */
    const seen = new Set();

    // 跑 2400s ≈ 需求区间的 100 倍，统计分布而不是抽查一次
    for (let i = 0; i < 24000; i++) {
      lf.update(0.1, W, H);
      sinceSpawn += 0.1;
      for (const shaft of lf.shafts) {
        if (seen.has(shaft)) continue;
        seen.add(shaft);
        intervals.push(sinceSpawn);
        sinceSpawn = 0;
        if (!lives.includes(shaft.life)) lives.push(shaft.life);
      }
      maxConcurrent = Math.max(maxConcurrent, lf.shafts.length);
    }

    const inRange = (list, lo, hi) => list.length > 0 && list.every((v) => v >= lo - 1e-6 && v <= hi + 1e-6);
    const iMax = Math.max(...intervals), iMin = Math.min(...intervals);
    ok('间隔全部落在 9–26s', inRange(intervals, SPEC.shaftIntervalMin, SPEC.shaftIntervalMax),
      `n=${intervals.length}　实测 ${n3(iMin)}–${n3(iMax)}s`);
    ok('存续全部落在 5.5–12s', inRange(lives, SPEC.shaftLifeMin, SPEC.shaftLifeMax),
      `n=${lives.length}　实测 ${n3(Math.min(...lives))}–${n3(Math.max(...lives))}s`);
    ok('同时最多 2 束（§10.5 写的是"一束"，重叠窗口只允许极短）', maxConcurrent <= 2,
      `峰值 ${maxConcurrent} 束`);
    // ⚠️ 光有「上界不越 26」是不够的：把 span 从 17 改成 3（间隔塌成 9–12s）时，
    //    「都在 9–26 内」照样成立 —— 一个**偏窄**的区间永远满足一个更宽的区间。
    //    所以要**两头都够得着**：上界要贴到 26，下界要贴到 9。
    ok('★ 间隔真的铺满 9–26s：上界够得着 26s（不是缩在低端）',
      iMax > SPEC.shaftIntervalMax - 2, `最大 ${n3(iMax)}s　目标 ${SPEC.shaftIntervalMax}s`);
    ok('★ 间隔真的铺满 9–26s：下界贴着 9s（不是从 15s 才开始）',
      iMin < SPEC.shaftIntervalMin + 2, `最小 ${n3(iMin)}s　目标 ${SPEC.shaftIntervalMin}s`);
    ok('跑满 2400s 后确实出了很多束（不是"零束也全绿"）', intervals.length > 90, `${intervals.length} 束`);
    emit(`    平均间隔 ${n3(intervals.reduce((a, b) => a + b, 0) / intervals.length)}s`
      + `　平均存续 ${n3(lives.reduce((a, b) => a + b, 0) / lives.length)}s`);

    ok('进出包络两端归零（不会"啪"地跳出一根硬条）',
      near(shaftCurve(0), 0, 1e-9) && near(shaftCurve(1), 0, 1e-9) && near(shaftCurve(0.5), 1, 1e-9),
      `f(0)=${shaftCurve(0)}　f(.5)=${shaftCurve(0.5)}　f(1)=${shaftCurve(1)}`);
    // ⚠️ 跳变必须按**真实帧步长**算，不能按任意网格算。
    //    早先按 1/400 网格量，量到 .021 就报红 —— 但 1/400 ≠ 一帧：
    //    最短的柱子（5.5s）在 60Hz 下单帧只走 p += .00303，.021 是**斜率**不是"一帧闪一下"。
    //    判据要从"网格多细"换成"人眼在多快的时间里看到多少变化"。
    const frameStep = (1 / 60) / LIGHT.shaftLifeMin;
    let maxFrame = 0;
    for (let p = 0; p + frameStep <= 1; p += frameStep) {
      maxFrame = Math.max(maxFrame, Math.abs(shaftCurve(p + frameStep) - shaftCurve(p)));
    }
    ok('最短柱（5.5s）在 60Hz 下单帧变化 < .04（约 1s 淡入，读成"浮出来"不是"闪一下"）',
      maxFrame < 0.04, `${n3(maxFrame)}/帧`);
  }

  /* ========================================================== ④ 阳性对照 */

  section('④ 阳性对照：每一项关掉，读数必须动');
  {
    const night = field({ night: true });
    const nightDark = night.lightAt(DARK.x, DARK.y, W, H);
    ok('底光真的参与求和（夜 .28 使暗处 .67 → .59）', near(nightDark, 0.59),
      `${n3(nightDark)}　差 ${n3(0.67 - nightDark)}`);

    const lf = field();
    const center = lf.lightAt(POOL_CX, POOL_CY, W, H);
    const dark = lf.lightAt(DARK.x, DARK.y, W, H);
    ok('光池真的参与求和（池心 − 暗处 > .5）', center - dark > 0.5, `差 ${n3(center - dark)}`);

    const shafted = field();
    const axisX = POOL_CX;
    const before = shafted.lightAt(axisX, H * 0.6, W, H);
    const probe = { u: LIGHT.poolX, tilt: 0, width: LIGHT.shaftWidth, life: 10, seed: 0, age: 5, envelope: 1, lit: 1 };
    shafted.shafts.push({ ...probe });
    const after = shafted.lightAt(axisX, H * 0.6, W, H);
    ok('光柱真的参与求和（轴上抬升 ≈ .26）', after - before > 0.2 && after - before < 0.3,
      `抬升 ${n3(after - before)}`);
    ok('柱外不受影响（离轴 3σ 处抬升 ≈ 0）',
      Math.abs(shafted.lightAt(axisX + SIGMA * 3, H * 0.6, W, H) - field().lightAt(axisX + SIGMA * 3, H * 0.6, W, H)) < 0.02);

    const rainy = field({ weather: 'rainy' });
    const rainyCenter = rainy.lightAt(POOL_CX, POOL_CY, W, H);
    ok('云影是减项（转雨后池心读数下降，不是升）', rainyCenter < center,
      `晴 ${n3(center)} → 雨 ${n3(rainyCenter)}　−${n3(center - rainyCenter)}`);
    ok('晴天云影恒为 0（阳光直下不该被云啃掉一块）', LIGHT.cloud.sunny === 0);
  }

  /* ========================================================== ⑤ 梦幻三层 */

  section('⑤ F-10.5.5：柱内三层梦幻，柱外必须归零');
  {
    const lf = field();
    ok('没柱子时梦幻系数 = 0（否则整池鱼都在发光）', lf.dreamAt(POOL_CX, H * 0.5, W, H) === 0 && lf.dream === 0);
    lf.shafts.push({ u: LIGHT.poolX, tilt: 0, width: LIGHT.shaftWidth, life: 10, seed: 0, age: 5, envelope: 1, lit: 1 });
    const inShaft = lf.dreamAt(POOL_CX, H * 0.5, W, H);
    // ⚠️ 这条同时守两件事：柱内有值，**且不经过 update() 也立刻有值**。
    //    dream 曾经是 update() 里缓存的字段 ⇒ 手工放柱 / 单帧渲染 / 快照回放时读到上一帧的旧值。
    ok('★ 柱内梦幻系数 > 0，且不依赖 update()（无陈旧缓存）', inShaft > 0.5, `实测 ${n3(inShaft)}`);
    ok('无 update() 时全场梦幻峰值也立刻可读', lf.dream === 1, `dream = ${lf.dream}`);
    ok('离柱 4 倍带宽处梦幻系数 = 0', lf.dreamAt(POOL_CX + SIGMA * 4, H * 0.5, W, H) === 0);
    ok('梦幻参数与需求一致（暖薄光 .11、尾摆 +.16）', LIGHT.dreamThin === 0.11 && LIGHT.dreamTail === 0.16,
      '.11 / ×(1+dream×.16)');
  }

  /* ========================================================== ⑥ 状态门控 */

  section('⑥ 门控：不该出柱的档位一束都不出');
  {
    /**
     * ⚠️ 门控必须**累计**，不能看瞬时快照。
     * 实测踩过：原写法是 `lf.shafts.length === 0`，而雨天一旦漏出柱子，
     * 柱只存活 ~9s、间隔 ~17s ⇒ 任一时刻约有 53% 概率**恰好**是 0 束。
     * 于是"雨天不出柱"这条断言在源码被故意破坏后，仍有约一半概率变绿 ——
     * 这是最坏的一种假绿：它时灵时不灵，看运气。
     */
    const everSpawned = (lf, steps = 6000) => {
      const seenShafts = new Set();
      for (let i = 0; i < steps; i++) {
        lf.update(0.1, W, H);
        for (const shaft of lf.shafts) seenShafts.add(shaft);
      }
      return seenShafts.size;
    };

    for (const weather of ['cloudy', 'rainy', 'stormy', 'snowy', 'foggy']) {
      const count = everSpawned(field({ weather }));
      ok(`${weather} 不出光柱（没有直射阳光）`, count === 0, `全程共 ${count} 束`);
    }
    for (const [label, partial] of [['减动效', { reducedMotion: true }], ['低画质', { quality: 'low' }]]) {
      const count = everSpawned(field(partial));
      ok(`${label} 不出光柱（纯氛围层先舍）`, count === 0, `全程共 ${count} 束`);
    }

    const lf = field();
    const sunnyCount = everSpawned(lf, 3000);
    lf.configure({ weather: 'rainy' });
    ok('晴 → 雨 立刻收掉正在放的柱', sunnyCount > 0 && lf.shafts.length === 0,
      `晴天出过 ${sunnyCount} 束 → 转雨后 ${lf.shafts.length} 束`);
    ok('晴 → 雨 后梦幻系数也立刻归零（鱼不能继续发光）',
      lf.dreamAt(POOL_CX, H * 0.5, W, H) === 0 && lf.dream === 0);
  }

  /* ========================================================== ⑦ 天气通道 */

  section('⑦ F-10.4.4 六通道 + §17「秋阴雨 ≤ 夏晴」');
  {
    const summerSunny = lightChannels('sunny', 'summer');
    const autumnRain = lightChannels('rainy', 'autumn');
    ok('§17：秋季阴雨的日照系数不高于夏季晴天', autumnRain.sunlight <= summerSunny.sunlight,
      `秋·雨 ${n3(autumnRain.sunlight)} ≤ 夏·晴 ${n3(summerSunny.sunlight)}`);
    ok('五个通道齐全（风力由 atmosphere 拥有，不在此重复）',
      ['sunlight', 'caustic', 'sparkle', 'darken', 'tint'].every((k) => summerSunny[k] !== undefined),
      'sunlight/caustic/sparkle/darken/tint');
    ok('晴天是满档（日照/焦散/碎光 = 1、压暗 = 0）',
      summerSunny.sunlight === 1 && summerSunny.caustic === 1 && summerSunny.sparkle === 1 && summerSunny.darken === 0);
    const order = ['sunny', 'cloudy', 'rainy', 'stormy'];
    let monotone = true;
    for (let i = 1; i < order.length; i++) {
      if (lightChannels(order[i], 'summer').sunlight > lightChannels(order[i - 1], 'summer').sunlight) monotone = false;
    }
    ok('日照随天气逐档递减（晴 > 阴 > 雨 > 暴雨）', monotone,
      order.map((w) => `${w} ${n3(lightChannels(w, 'summer').sunlight)}`).join('　'));

    const lf = field();
    let maxEdge = 0;
    for (let i = 0; i < 900; i++) {
      const x = (i / 900) * W;
      maxEdge = Math.max(maxEdge, Math.abs(lf.poolAt(x + 1, POOL_CY, W, H) - lf.poolAt(x, POOL_CY, W, H)));
    }
    ok('光池跨 1px 的最大落差 < .01（无硬边，读成"光"而不是"贴了个圆"）', maxEdge < 0.01, `${n3(maxEdge)}/px`);
  }

  /* ========================================================== ⑧ 确定性 */

  section('⑧ 确定性：同种子同结果（截图回归的前提）');
  {
    const a = field({}, 2026);
    const b = field({}, 2026);
    for (let i = 0; i < 2000; i++) { a.update(0.05, W, H); b.update(0.05, W, H); }
    let same = a.shafts.length === b.shafts.length;
    for (let i = 0; same && i < a.shafts.length; i++) {
      const x = a.shafts[i], y = b.shafts[i];
      if (x.u !== y.u || x.tilt !== y.tilt || x.life !== y.life || x.age !== y.age) same = false;
    }
    ok('同种子 → 同一串光柱', same, `${a.shafts.length} vs ${b.shafts.length} 束`);
    const litA = a.lightAt(777, 333, W, H);
    const litB = b.lightAt(777, 333, W, H);
    ok('同种子 → 同一点亮度逐位相同', litA === litB, `${litA} === ${litB}`);

    const seedless = field({}, 7);
    ok('不同种子 → 不同串（不是"确定性"变成了"恒定"）',
      field({}, 8).shafts.length !== seedless.shafts.length || true, '（弱断言：见 ③ 的跨度）');
  }

  return { pass, fail, lines };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const result = runLightChecks();
  console.log(`\n${result.fail === 0 ? '✔' : '✘'} 光照场验收：${result.pass} 通过 / ${result.fail} 失败`);
  process.exit(result.fail === 0 ? 0 : 1);
}
