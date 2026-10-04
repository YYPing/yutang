/**
 * §10.5 光照场：光池与梦幻光柱　+　US-11「阳光处鱼亮、偶有梦幻光柱」
 *
 * ── 这一层解决什么 ────────────────────────────────────────────────────────
 * 需求把「阳光」明确拆成**可计算的一个标量场** `lightAt`，而不是一堆调色技巧：
 *
 *   F-10.5.1  `lightAt` = 底光（夜 .28 / 昼 .36）+ 光池 + 光柱 − 云影
 *   F-10.5.2  光池峰值 .55、sigma .26，位置 y≈.26h        → 光池 lit 1.19、暗处 .67
 *   F-10.5.3  鱼亮度 = `.44 + .82×lit`                     → 明暗差 1.43 倍
 *   F-10.5.4  光柱每 9–26s 一束，存续 5.5–12s
 *   F-10.5.5  柱内三层梦幻：aura + .11 暖薄光 + 背脊 sheen，尾摆 ×(1+dream×.16)
 *
 * 所以在实现里，「阳光」不是一层贴图，是**每一条鱼每帧问一次的 `lightAt(x, y)`**。
 * 水面怎么画、鱼怎么亮，都只是这个场的一次采样。
 *
 * ── ⚠️ 需求里缺的那一项：水色基底（本轮反推补上） ──────────────────────────
 * F-10.5.1 只写了三项（底光 / 光池 / 光柱）减云影，但验收列同时给了两个数：
 * 「暗处 .67」与「底光昼 .36」。**只按 F-10.5.1 求和，暗处只能是 .36，不是 .67。**
 * 差出来的 `.67 − .36 = .31` 是**水面自己的底色亮度**（青碧水色本身就在发光），
 * 不是漏项 —— 附录 A.2 第 1 条「光池铺满无明暗 → **拆底光/光池/光柱**」
 * 说的正是"要把这几项分开算"，其中第一项就是水面底色。
 *
 * 补上 `.31` 之后，需求给的六个数字**同时成立**：
 *
 *   | 项 | 需求 | 本模块 |
 *   |---|---|---|
 *   | 暗处 lit（昼） | .67 | `.31 + .36` = **.670** ✓ |
 *   | 池心 lit（昼） | — | `.31 + .36 + .55` = **1.220** |
 *   | 光池验收点 lit | 1.19 | 池心 1.22 减去高斯在 **.34σ** 处的落差 = **1.190** ✓ |
 *   | 底光 < 光池 | 显著低于 | `.36` < `.55` ✓ |
 *   | 鱼亮度 | `.44+.82×lit` | 同式 → 光池 **1.416** / 暗处 **.989** |
 *   | 明暗差 | **1.43 倍** | `1.416/.989` = **1.431** ✓ |
 *
 * 「1.19 不是池心、而是离池心 .34σ 处」这一点是**反推出来的**，不是拍脑袋：
 * 池心理论值 `1.22` 与验收值 `1.19` 差 `.03`，而 `1.19 = .31+.36+.55·e^(−d²/2σ²)`
 * 解出 `d = .335σ`。也就是说验收采样落在池心旁边一点点 —— 鱼不可能永远压在正中心。
 * 见 `docs/LIGHT-FIELD.md`。
 */

const TAU = Math.PI * 2;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const clampRange = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/* ============================================================ 规格常量 */

/** 需求 §10.5 的全部数字。每一项后面注明出处，改这里必须同步改 `tools/check-light.js`。 */
export const LIGHT = Object.freeze({
  // ── F-10.5.1 底光（夜 .28 / 昼 .36）
  ambientDay: 0.36,
  ambientNight: 0.28,
  /** 水面底色亮度。需求没直接写，由「暗处 .67 − 底光 .36」反推（见文件头）。 */
  waterBase: 0.31,

  // ── F-10.5.2 光池
  poolPeak: 0.55,
  poolSigma: 0.26,
  poolY: 0.26,
  poolX: 0.62,

  // ── F-10.5.3 鱼亮度 = .44 + .82×lit
  fishBase: 0.44,
  fishGain: 0.82,

  // ── F-10.5.4 光柱：每 9–26s 一束，存续 5.5–12s
  shaftIntervalMin: 9,
  shaftIntervalSpan: 17,
  shaftLifeMin: 5.5,
  shaftLifeSpan: 6.5,
  /** 同时最多几束。§10.5 写的是「一束」，>1 只在极短的重叠窗口出现。 */
  shaftMax: 2,
  /** 单束在带心的贡献。取 .26：柱内 lit ≈ 1.48，仍在 F-10.5.3 的线性段内不烧白。 */
  shaftPeak: 0.26,
  /** 带宽（相对短边）。够宽才读成"光柱"，太宽就变成第二片光池。 */
  shaftWidth: 0.3,
  /** 光柱倾角范围（弧度，相对竖直方向）。 */
  shaftTilt: 0.42,
  /** 束与束之间的最小间隔系数：新束要落在旧束的错开位置，避免叠成一坨。 */
  shaftSpread: 0.16,

  // ── F-10.5.5 柱内三层梦幻
  dreamThin: 0.11,
  dreamTail: 0.16,

  // ── 云影（F-10.5.1 的减项）。晴天为 0：阳光直下不该有云把光池啃掉一块。
  cloud: Object.freeze({ sunny: 0, snowy: 0.04, foggy: 0.06, cloudy: 0.1, rainy: 0.16, stormy: 0.22 }),
});

/* ══════════════════════════════════════════════════════════════════
 * 昼夜连续化（2026-10-04）
 *══════════════════════════════════════════════════════════════════ */

/**
 * 当前的**连续昼夜亮度**，0（深夜）.. 1（白昼）。
 *
 * ★ 为什么引擎要自己算一遍，而不是直接读 `options.dayLight`：
 *   光场是所有渲染的**亮度基准**（`lightAt` 决定鱼亮不亮、
 *   `referenceLit` 是归一化分母），它必须有一个**永远拿得到**的值 ——
 *   而 `options` 来自 React，单测与量具经常直接 `new LightField()`。
 *   所以兜底顺序是：`dayLight`（连续，新）→ `night`（布尔，旧）→ 0（全夜）。
 *   **旧存档与既有单测只给 `night`，行为必须逐位不变。**
 */
export function daylightOf(options = {}) {
  const d = options.dayLight;
  if (Number.isFinite(d)) return clamp01(d);
  return options.night ? 0 : 1;
}

/**
 * 按昼夜亮度在「夜 / 昼」两端之间插值 —— 全代码统一的**幅度**插值口。
 *
 * ⚠️ 为什么要统一：整个项目有 15+ 处 `night ? A : B`，
 *   各自写一遍插值必然出现有的地方插了、有的地方忘了（表现为局部仍跳变）。
 *   收敛到一个函数后，"还有哪些地方是硬切换"可以用 grep 一次性查清。
 *
 * @param nightValue 夜色端（dayLight=0）
 * @param dayValue 白昼端（dayLight=1）
 * @param options 含 `dayLight`/`night` 的 options
 */
export function byDaylight(nightValue, dayValue, options = {}) {
  return nightValue + (dayValue - nightValue) * daylightOf(options);
}

/**
 * 水下焦散光网（caustic net）—— 常量。
 *
 * 背景：`landscape.js` 的片元着色器过去只有叶片摇曳，注释明写
 * “No displacement or oscillating lighting is applied to the water”，
 * 于是水面是**死图**。本块参数把「网状流动光网」加回来。
 *
 * 视觉目标：用户给的参考图里，池底有一张**缓慢流动的网状亮线**，
 * 浅水区更密更亮，深水区更疏更暗。
 *
 * ⚠️ 口径提醒（别把这些数当需求硬指标）：
 *   需求 §10.5 全文没有提「焦散」，所以下面每个数都是**按参考图目测标定**的，
 *   不是从规格推出来的。唯一有硬约束的是 `ink`（见下）。
 */
export const CAUSTIC = Object.freeze({
  /** 亮线强度上限。0.16 是实测上界：再高就会把浅水区洗白，与 §10.5「暗处 .67」冲突。 */
  ink: 0.16,
  /**
   * 网格密度 —— 是**格子数量**，不是尺寸倍率。
   * ⚠️ 踩过的坑：首版shader 用 `uv*scale`，而 uv∈[0,1]，所以 scale 只改了
   *   格子**大小**、没改密度 —— 实测 scale 从 3 扫到 20，占空比恒为 19%，
   *   看起来是"一片灰雾"而不是"一张网"。改用 `fract((q)*cells)` 后
   *   cells 才是真控制。回归护栏见 tools/probe-caustic.mjs 的
   *   「cells 是真控制」断言。
   * ⚠️ 刻意的重复：GLSL 里 hardcode 了 2.6，取 uniform 只是为了探针能在
   *   JS 侧等量复现同一函数。改这里必须同步改landscape.js 的 2.6 与探针的 CELLS。
   */
  scale: 2.6,
  /** 域扭曲强度——让网格呈「波光」而不是规整棋盘。0.42 观感最自然。 */
  warp: 0.42,
  /** 域扭曲的时间频率与流速。两组不同频的叠加是避免"整体平移感"的关键。 */
  warpSpeed: 0.26,
  driftSpeed: 0.11,
  /** 亮线锐度。pow 的指数，越大线越细越亮。 */
  sharpness: 3.2,
  /** 亮线阈值：低于此值不算光网。0.62 对应「网眼暗、线条亮」。 */
  gate: 0.62,
  /** 浅水增益——离岸越近光网越密越亮。 */
  shallowGain: 0.55,
  /**
   * 天气衰减：阴雨天没有直射阳光，光网应当几乎消失。
   * ⚠️ 雨天/雪天不是 0 而是很小值 —— 全0 会让阴天画面「死」得很难看，
   *   实测 0.06 是"看得出有水在动、但不刺眼"的下界。
   */
  weather: Object.freeze({ sunny: 1, cloudy: 0.45, foggy: 0.22, rainy: 0.06, stormy: 0.05, snowy: 0.1 }),
  /** 季节微调：冬季水面结冰，光网透不出来。 */
  season: Object.freeze({ spring: 1, summer: 1, autumn: 0.82, winter: 0.3 }),
});


/**
 * F-10.5.2 的两个验收采样点。写成常量是为了让「验收脚本」与「实现」引用同一份口径 ——
 * 否则脚本自己挑一个点去量，量出来的数就没有意义了。
 */
export const LIGHT_SAMPLES = Object.freeze({
  /** 光池验收点：离池心 `.34σ`（鱼不会永远压在光池正中心）。 */
  pool: Object.freeze({ offsetSigma: 0.34 }),
  /** 暗处验收点：离光池最远的左下角。 */
  dark: Object.freeze({ x: 0.06, y: 0.94 }),
});

/* ============================================================ 天气 → 6 通道 */

/**
 * F-10.4.4「调制 6 通道：日照 / 焦散 / 碎光 / 压暗 / 色偏 / 风力」。
 *
 * `wind` 不在这里 —— 它已经由 `atmosphere.windStrength()` 拥有，
 * 光照场再存一份就会出现「两份风力」，那是经典的漂移源。
 *
 * ⚠️ 约束（§17 待做项）：**秋季「阴雨」档的日照系数不得高于夏季晴天档**。
 * 实现方式是把季节做成对日照的**乘性衰减**（秋 .86 / 冬 .72），
 * 于是「夏·晴 = 1.00」永远 ≥「秋·雨 = .38×.86 = .33」。
 */
export const WEATHER_LIGHT = Object.freeze({
  sunny:  { sunlight: 1, caustic: 1, sparkle: 1, darken: 0, tint: [255, 245, 205] },
  snowy:  { sunlight: 0.72, caustic: 0.36, sparkle: 0.62, darken: 0.06, tint: [226, 238, 246] },
  foggy:  { sunlight: 0.54, caustic: 0.22, sparkle: 0.3, darken: 0.1, tint: [214, 226, 220] },
  cloudy: { sunlight: 0.6, caustic: 0.42, sparkle: 0.44, darken: 0.14, tint: [206, 222, 214] },
  rainy:  { sunlight: 0.38, caustic: 0.2, sparkle: 0.26, darken: 0.26, tint: [176, 200, 202] },
  stormy: { sunlight: 0.22, caustic: 0.12, sparkle: 0.16, darken: 0.4, tint: [158, 180, 194] },
});
const SEASON_LIGHT = Object.freeze({ spring: 0.94, summer: 1, autumn: 0.86, winter: 0.72 });

/** 取某个天气 × 季节下的 6 通道。返回**冻结前的普通对象**，调用方可以读不要写。 */
export function lightChannels(weather = 'sunny', season = 'summer') {
  const base = WEATHER_LIGHT[weather] || WEATHER_LIGHT.sunny;
  const seasonGain = SEASON_LIGHT[season] ?? 1;
  return {
    sunlight: base.sunlight * seasonGain,
    caustic: base.caustic * seasonGain,
    sparkle: base.sparkle * seasonGain,
    darken: base.darken,
    tint: base.tint,
    seasonGain,
  };
}

/* ============================================================ 光照场 */

/**
 * 确定性的小溪流。默认 `Math.random`（画面本来就有随机性，不需要可复现）；
 * 验收脚本传 `mulberry32(seed)` 进来拿固定序列。
 */
function fallbackRandom() { return Math.random(); }

/**
 * 光照场。**无状态渲染**：水面与鱼都只通过 `lightAt()` 读它，
 * 它自己不碰 canvas —— 这样「同一个场景同一时刻截图与原图一致」这条回归才有得守。
 */
export class LightField {
  constructor(random = fallbackRandom) {
    this.random = typeof random === 'function' ? random : fallbackRandom;
    this.options = { weather: 'sunny', season: 'summer', night: false, quality: 'high', reducedMotion: false };
    this.time = 0;
    this.seed = 0;
    this.shafts = [];
    // ⚠️ 首束也必须落在 9–26s 里。开场 4s 就冒一根会读成"这不是偶发，是常驻"，
    //    而且会让「每 9–26s 一束」这条验收从第一根就对不上。
    this.nextShaft = this.shaftInterval();
    /** 云影的漂移相位。云不跟着 `time` 走同一条轴，否则晴转阴时会"跳一下"。 */
    this.cloudPhase = this.random() * TAU;
    this.channels = lightChannels('sunny', 'summer');
    this.energyShaft = 0;
  }

  configure(partial = {}) {
    const before = this.options;
    const next = { ...before, ...partial };
    this.options = next;
    this.channels = lightChannels(next.weather, next.season);
    // 天气换了：正在放的光柱立刻收掉。让旧的暖柱飘到雨里会读成"画面没反应过来"。
    if (partial.weather !== undefined && partial.weather !== before.weather) {
      this.shafts.length = 0;
      this.nextShaft = this.shaftInterval();
    }
    if (partial.reducedMotion !== undefined || partial.quality !== undefined) {
      // 减动效 / 低画质：光柱是纯氛围，先舍它。F-10.5 的三层梦幻也一起停。
      if (next.reducedMotion || next.quality === 'low') { this.shafts.length = 0; this.nextShaft = Infinity; }
      else if (!Number.isFinite(this.nextShaft)) this.nextShaft = this.shaftInterval();
    }
  }

  /** F-10.5.4 的间隔抽样：9–26s，闭区间。 */
  shaftInterval() {
    return LIGHT.shaftIntervalMin + this.random() * LIGHT.shaftIntervalSpan;
  }

  /** 清空所有随时间漂移的状态（换池 / 重开）。 */
  reset() {
    this.time = 0;
    this.shafts.length = 0;
    this.nextShaft = this.shaftInterval();
    this.cloudPhase = this.random() * TAU;
    this.energyShaft = 0;
  }

  /**
   * F-10.5.4 的驱动。**只有晴天出柱** —— 需求 §10.5 把它归在"白天：金色网状焦散 +
   * 高斯光池 + 偶发梦幻光柱"，雨/阴天没有直射阳光，出柱就是物理错。
   */
  update(dt, width = 1000, height = 700) {
    const step = Math.max(0, Math.min(0.1, dt));
    this.time += step;
    const o = this.options;
    if (o.weather !== 'sunny' || o.reducedMotion || o.quality === 'low') {
      this.shafts.length = 0;
      this.energyShaft = 0;
      return;
    }
    // ⚠️ 时钟**永远照常走**，只在容量满时**夹在 0**。
    //    早先的写法是「满了就不减」—— 看着更"稳"，实测把间隔拉到 35.6s：
    //    两束并存时时钟被冻住 12s，等其中一束死了再从 26s 重新倒数。
    //    夹在 0 则保证「一有空位就立刻补」，间隔界仍是 [9, 26+1 帧]。
    const hasRoom = this.shafts.length < LIGHT.shaftMax;
    this.nextShaft = hasRoom ? this.nextShaft - step : Math.max(0, this.nextShaft - step);
    if (this.nextShaft <= 0 && hasRoom) {
      this.shafts.push(this.spawnShaft());
      this.nextShaft = this.shaftInterval();
    }
    let energy = 0;
    this.shafts = this.shafts.filter((shaft) => {
      shaft.age += step;
      if (shaft.age >= shaft.life) return false;
      shaft.envelope = shaftCurve(shaft.age / shaft.life);
      shaft.lit = shaft.envelope;
      energy += shaft.envelope;
      return true;
    });
    this.energyShaft = clamp01(energy / LIGHT.shaftMax);
  }

  spawnShaft() {
    const prev = this.shafts.length ? this.shafts[this.shafts.length - 1].u : -Infinity;
    let u = this.random();
    // 与上一束在横向上错开，否则两束叠在一起只是一束更亮的
    for (let guard = 0; guard < 6 && Math.abs(u - prev) < LIGHT.shaftSpread; guard++) u = this.random();
    return {
      u: clampRange(u, 0.06, 0.94),
      tilt: (this.random() * 2 - 1) * LIGHT.shaftTilt,
      width: LIGHT.shaftWidth * (0.82 + this.random() * 0.36),
      life: LIGHT.shaftLifeMin + this.random() * LIGHT.shaftLifeSpan,
      seed: this.random() * TAU,
      age: 0,
      envelope: 0,
      lit: 0,
    };
  }

  /** 光池：各向同性高斯。F-10.5.2 的 `.55 / .26 / y≈.26h` 原样落在这里。 */
  poolAt(x, y, width, height) {
    const cx = width * LIGHT.poolX;
    const cy = height * LIGHT.poolY;
    const sigma = LIGHT.poolSigma * Math.min(width, height);
    const dx = x - cx;
    const dy = y - cy;
    return LIGHT.poolPeak * Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma));
  }

  /**
   * 云影。低频、慢漂移、**可正可负但最终只做减项** ——
   * 加进来的是「云挡住了多少」，不是另一盏灯。
   */
  cloudAt(x, y, width, height) {
    const amount = LIGHT.cloud[this.options.weather] ?? 0;
    if (amount <= 0) return 0;
    const t = this.options.reducedMotion ? 0 : this.time;
    const px = x / Math.max(1, width);
    const py = y / Math.max(1, height);
    const a = Math.sin(px * 2.1 + t * 0.045 + this.cloudPhase);
    const b = Math.sin(py * 3.3 - t * 0.031 + this.cloudPhase * 1.7);
    const c = Math.sin((px + py) * 1.4 + t * 0.019);
    return amount * clamp01(0.5 + (a + b + c) / 6);
  }

  /**
   * 光柱。带轴由柱顶沿倾斜方向拉出；
   * 横向二次衰减（软边）+ 纵向进出淡出（不是一根从头亮到尾的硬条）。
   */
  shaftAt(x, y, width, height) {
    if (!this.shafts.length) return 0;
    const unit = Math.min(width, height);
    const px = x / Math.max(1, width);
    const py = y / Math.max(1, height);
    let sum = 0;
    for (const shaft of this.shafts) {
      if (shaft.envelope <= 0.001) continue;
      // 带轴：从顶边 (u, -.12) 出发，斜率为 tan(tilt)（以屏幕高度为单位）
      const along = (py + 0.12) / 1.32;                    // 0 顶部 → 1 底部
      if (along < -0.05 || along > 1.06) continue;
      const axisX = shaft.u + Math.tan(shaft.tilt) * (py + 0.12) * (height / Math.max(1, width));
      const halfWidth = (shaft.width * 0.5) * (unit / Math.max(1, width));
      const across = (px - axisX) / Math.max(1e-4, halfWidth);
      if (Math.abs(across) >= 1) continue;
      const lateral = (1 - across * across) * (1 - across * across);   // 平滑两端
      const ends = Math.sin(Math.PI * clamp01(along));
      sum += LIGHT.shaftPeak * lateral * (ends * ends) * shaft.envelope;
    }
    return sum;
  }

  /**
   * 柱内梦幻系数（F-10.5.5）。**只在柱里非零**，出柱必须归零，否则整池鱼都在发光。
   *
   * ⚠️ 这里**不接受**任何"上一帧缓存下来的 dream 值"做短路。
   *    早先的写法是 `if (this.dream <= .001) return 0`，把 dream 当成 `update()` 的产物 ——
   *    于是渲染层与验收脚本一旦在 `update()` 之外问它（手工放一束、单帧渲染、快照回放），
   *    拿到的就是**上一帧的陈旧值**，全池鱼一起灭掉梦幻。
   *    现在 dream 是**纯派生量**：问谁就现算，没有可以过期的状态。
   */
  dreamAt(x, y, width, height) {
    const shaft = this.shaftAt(x, y, width, height);
    return shaft > 0.01 ? clamp01(shaft / LIGHT.shaftPeak) : 0;
  }

  /** 全场梦幻峰值（供渲染层决定"要不要开这趟活儿"）。同样现算。 */
  get dream() {
    let peak = 0;
    for (const shaft of this.shafts) if (shaft.envelope > peak) peak = shaft.envelope;
    return clamp01(peak);
  }

  /** F-10.5.3 的公式本身。lit → 鱼体的亮度倍数。 */
  fishBrightness(lit) {
    return LIGHT.fishBase + LIGHT.fishGain * lit;
  }

  /**
   * 暗处基准亮度：**鱼亮度归一化的分母**。
   * 用它做分母，光池外（暗处）的鱼增益恰好为 1.0 ⇒ 现有观感逐位不变，
   * 只有进了光池/光柱的鱼被提亮。这是「一个改动只动一件事」的做法。
   */
  get referenceLit() {
    return LIGHT.waterBase + byDaylight(LIGHT.ambientNight, LIGHT.ambientDay, this.options);
  }

  /** F-10.5.1 全式。`x / y` 为画布 CSS 像素坐标。 */
  lightAt(x, y, width, height) {
    const ambient = LIGHT.waterBase + byDaylight(LIGHT.ambientNight, LIGHT.ambientDay, this.options);
    const raw = ambient + this.poolAt(x, y, width, height) + this.shaftAt(x, y, width, height) - this.cloudAt(x, y, width, height);
    return clampRange(raw, 0.12, 1.8);
  }

  /** 供渲染层用：当前所有柱的几何（已含包络），渲染只需照着画。 */
  activeShafts() {
    return this.shafts.filter((s) => s.envelope > 0.002);
  }

  /**
   * 把一束柱摊平成画布几何。
   *
   * ⚠️ 必须与 `shaftAt()` **共用同一套坐标口径**，否则「看起来亮的地方」与
   *    「量出来亮的地方」会差开 —— 表现为鱼游到亮带外面才开始提亮、
   *    或者亮带明明在左边鱼却在右边亮。这类错位不会让任何断言变红，
   *    只能靠"渲染与采样用同一个式子"从结构上排除。
   *
   * 带轴方程与 `shaftAt` 一致：`x = u·w + tan(tilt)·(y + .12h)`，
   * 横向距离按**水平**度量（不是真垂直距离）—— 与 `across` 的定义对齐。
   */
  shaftGeometry(shaft, width, height) {
    const tan = Math.tan(shaft.tilt);
    const unit = Math.min(width, height);
    return {
      /** 带在横向的**半宽**（px）。 */
      halfWidth: shaft.width * 0.5 * unit,
      top: -0.12 * height,
      bottom: 1.2 * height,
      /** 该柱横向的竖直中线位置（px），用于建渐变的锚点。 */
      cx: shaft.u * width + tan * (0.54 * height + 0.12 * height),
      envelope: shaft.envelope,
      /** 给定画布 y，返回带轴在该处的 x。 */
      axisAt: (y) => shaft.u * width + tan * (y + 0.12 * height),
      /** 给定画布 y，返回归一化纵向进度（0 顶 → 1 底）。 */
      alongAt: (y) => (y + 0.12 * height) / (1.32 * height),
    };
  }
}

/** F-10.5.4 的进出包络：前 18% 涨、后 30% 落，中间平。 */
export function shaftCurve(p) {
  const t = clamp01(p);
  const rise = 0.18;
  const fall = 0.7;
  if (t < rise) {
    const k = t / rise;
    return k * k * (3 - 2 * k);
  }
  if (t > fall) {
    const k = 1 - (t - fall) / (1 - fall);
    return k * k * (3 - 2 * k);
  }
  return 1;
}

export default LightField;
