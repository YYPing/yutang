/* ============================================================================
 * eco-bridge.js —— 行为层（simulation.js / pond.js）与生态内核（eco/）的适配器
 * ----------------------------------------------------------------------------
 * 职责边界：
 *   - eco/ 只管「鱼**是什么状态**」：日龄、体长cm、饱食、健康、肥满度、基因、生死
 *   - 本文件把生态状态翻译成行为层要的字段：像素体长、调色板序号、运动初值
 *   - simulation.js 只管「鱼**怎么游**」：转向、避让、追食、涟漪
 *
 * ★ 为什么把行为字段直接挂在生态鱼对象上（而不是维护两套并行数组 + id 映射）：
 *   `eco/world.js` 的 `makeFish()` 里显式预留了 `pos / vel / heading` 三个字段，
 *   并注明「运动（渲染层用；推演不关心，但留位避免结构漂移」——
 *   也就是生态内核**本来就预期**渲染/行为层把运动状态写在这个对象上。
 *   顺着这个设计走，可以省掉「两套数组 + id 对照表 + 双向同步」整整一层胶水。
 * ========================================================================== */

import { PALETTES } from './eco/genes.js';
import { STAGES, APPEARANCE, EGG_VISUAL } from './eco/constants.js';

/**
 * §8.3 八品系 → 渲染层的 6 套调色板（`koi-renderer.js` 里的 `palettes`）。
 *
 * 渲染层只有 6 套配色，8 品系必然有复用。映射依据是各套调色板的实际观感：
 *   0 白底 + 红斑          → 红白
 *   1 通体金黄             → 黄金
 *   2 灰白 + 黑斑 + 橙纹   → 三色（大正 / 昭和共用）
 *   3 金褐 + 少斑          → 浅黄
 *   4 白底 + 头顶单红斑     → 丹顶
 *   5 灰绿 + 深斑 + 橙纹   → 写鲤 / 乌鲤（深色系共用）
 *
 * ⚠️ 大正与昭和、写鲤与乌鲤在**渲染上同形**，只在名字与基因上区分。
 *    这是渲染层既有能力的限制（6 套 palette），不是映射错误。
 */
export const PALETTE_VARIANT = {
  kohaku: 0, ogon: 1, taisho: 2, showa: 2,
  asagi: 3, tancho: 4, utsuri: 5, karasu: 5,
};

/** 未知品系一律退回红白，不抛错（存档里可能有旧品系名）。*/
export function variantOfPalette(paletteId) {
  const variant = PALETTE_VARIANT[paletteId];
  return Number.isInteger(variant) ? variant : 0;
}

/** 品系中文名（界面展示用）。*/
export function paletteName(paletteId) {
  return PALETTES.find((palette) => palette.id === paletteId)?.name ?? '锦鲤';
}

const TAU = Math.PI * 2;

/**
 * 给一条生态鱼挂上行为层需要的字段（幂等，重复调用直接返回）。
 *
 * 这些字段分三类：
 *   ① 位置与运动：x / y / heading / velocity / targetX / targetY / wander
 *   ② 渲染外观：variant（调色板）/ width（体高比）/ depth（水层）/ seed（花纹）
 *   ③ 动画相位：phase / finPhase / turn / angularVelocity
 *
 * ⚠️ `length` **不在这里设** —— 它由 `resizeFish()` 从 `lengthCm × pxPerCm` 换算，
 *    因为视口尺寸和 fishSize 滑杆变了都要重算，而 attachBehavior 只跑一次。
 */
export function attachBehavior(fish, { width, height, random }) {
  if (fish.behaviorReady) return fish;
  fish.behaviorReady = true;
  fish.eco = true;
  fish.custom = null;

  fish.x = width * (0.18 + random() * 0.64);
  fish.y = height * (0.19 + random() * 0.62);
  fish.heading = random() * TAU;
  fish.targetX = width * (0.15 + random() * 0.7);
  fish.targetY = height * (0.16 + random() * 0.68);
  fish.speed = 15 + random() * 13;
  fish.velocity = 18;
  fish.wander = 2 + random() * 5;

  fish.phase = random() * TAU;
  fish.turn = 0;
  fish.angularVelocity = 0;

  // 体长与体高比沿用行为层原有区间：生态侧不提供「体型胖瘦」，
  // 它只有 lengthCm（体长）。体高口径仍待 §4「按鉴鲤标准重定形体参数」定稿。
  fish.width = 0.115 + random() * 0.016;
  fish.depth = 0.84 + random() * 0.16;
  fish.variant = variantOfPalette(fish.genes?.palette);
  // 花纹种子取自 patternSeed，取模后落到小整数域（drawPattern 只吃小 seed）。
  fish.seed = (fish.genes?.patternSeed ?? Math.floor(random() * 1e6)) % 997;

  updateFishLook(fish);
  return fish;
}

/* -------------------------------------------------------------------------- *
 * §6 阶段 → 外观                                                            *
 * -------------------------------------------------------------------------- */

/** 各阶段的**起点日龄**，用来把「阶段」翻译成「日龄轴上的一个点」。*/
const STAGE_FROM = new Map(STAGES.map((stage) => [stage.key, stage.from]));
const ELDER_FROM = STAGE_FROM.get('elder') ?? Infinity;

/**
 * 阶段内插曲线取某日龄处的值。
 *
 * `curve` 形如 `[['fry', 0.52], ['juvenile', 0.86], ['subadult', 1], ['adult', 1]]`：
 * 键是阶段、值是**该阶段起点**的取值；相邻锚点之间线性内插，末锚点之后取末值。
 *
 * ★ 为什么是「起点值 + 内插」而不是「一个阶段一个常数」：
 *   阶段切换那一刻要是跳变，画面上会出现「鱼突然变透明」的闪光。
 *   内插让 17 日龄这条边界两侧取到同一个值（fry 段末 = juvenile 起点）。
 * ⚠️ 表里没有的阶段（egg / elder）落到**末条目**的值 —— 不再单独补一条，
 *    否则以后每加一个阶段，三张曲线都要跟着同步，迟早漏一张。
 */
function curveAt(curve, ageDays) {
  const anchors = [];
  for (const [key, value] of curve) {
    const from = STAGE_FROM.get(key);
    if (from !== undefined) anchors.push({ at: from, value });
  }
  if (!anchors.length) return 1;
  if (ageDays <= anchors[0].at) return anchors[0].value;
  for (let i = 1; i < anchors.length; i++) {
    if (ageDays < anchors[i].at) {
      const span = anchors[i].at - anchors[i - 1].at;
      const t = span > 0 ? (ageDays - anchors[i - 1].at) / span : 1;
      return anchors[i - 1].value + (anchors[i].value - anchors[i - 1].value) * t;
    }
  }
  return anchors[anchors.length - 1].value;
}

/**
 * §6 阶段 → 外观：把「阶段 + 日龄」翻译成渲染层认识的三个纯数字。
 *
 * 产出：
 *   `fish.aFade`    整体透明度系数（1 = 不透）—— §6 鱼苗「近半透明」
 *   `fish.aPattern` 斑块显现度（1 = 全显）    —— §6 幼鱼「花纹显现」
 *   `fish.aPale`    褪色叠加 alpha（0 = 不褪） —— §6 老鱼「体色褪淡」
 *
 * ★ 为什么翻译而不是让渲染层自己查 STAGES：
 *   渲染层认识「一个 0.52 的透明度」，不认识「鱼苗」。把三个数字怎么算关在行为层一处，
 *   渲染层只做乘法 —— 以后改曲线不碰渲染，改渲染不碰生态。
 *
 * ⚠️ 手绘鱼没有 `stage` / `ageDays` ⇒ 本函数直接返回，三个字段保持 `undefined`，
 *    渲染层按「undefined ⇒ 1 / 0」处理，与加这个特性之前**逐像素一致**。
 */
export function updateFishLook(fish) {
  if (!fish || typeof fish.stage !== 'string' || !Number.isFinite(fish.ageDays)) return fish;
  const age = fish.ageDays;
  fish.aFade = curveAt(APPEARANCE.alpha, age);
  fish.aPattern = curveAt(APPEARANCE.pattern, age);
  fish.aPale = age > ELDER_FROM
    ? Math.min(1, (age - ELDER_FROM) / APPEARANCE.elderPaleDays) * APPEARANCE.elderPaleAlpha
    : 0;
  return fish;
}

/* -------------------------------------------------------------------------- *
 * §8.2 鱼卵外观                                                             *
 * -------------------------------------------------------------------------- */

/** id + salt → [0,1) 的确定性伪随机（splitmix 收尾）。同一 id 永远得到同一个数。*/
function idNoise(id, salt) {
  let h = (Math.imul((id | 0) ^ salt, 0x9e3779b1) ^ 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2545f491) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * §8.2 步骤 3「水草/石上产卵」—— 求一窝卵的落点。
 *
 * ★ 为什么要有“一窝”：同一帧新出现的卵属于同一次产卵（world 里一次 push 一整批）。
 *   让它们**共用一个落点**再小范围散开，画面上才是一「群」卵；
 *   逐粒独立取点会平铺在整条岸线上，读起来像撒了一把芝麻。
 * ⚠️ 本体**没有水草坐标**（水草只画在底图里），所以退一步：贴着**岸**产 ——
 *   视觉上就是贴在岸边石缝/水草根部，而不是漂在池心。
 *
 * ★ 落点怎么求：沿一条射线**从池心往外走，走到出水为止**，再往池心退 `shoreInsetPx`。
 *   为什么不写「距池心 62%–97% 的环带」：那个写法假定池岸在画面 62% 半径处，
 *   而事实上 `PondHabitat` 把 16:9 美术坐标铺满视口之后，水面的左右两岸分别落在
 *   `x ≈ 0` 与 `x ≈ w` —— **池岸几乎贴着画幅边缘**。
 *   初版按归一化环带实现，实测落点距岸 219–235px（全在池心）。
 *   射线走法只依赖 `habitat.contains()`，与画幅、分辨率的对应关系无关。
 *
 * @param {number} u [0,1) 的随机数；调用方每窝取一次，同一窝共用
 */
export function clutchAnchor(u, { width, height, habitat }) {
  const angle = (u * TAU * 2.399963229728653) % TAU;
  const cx = width * 0.5, cy = height * 0.5;
  const dx = Math.cos(angle), dy = Math.sin(angle);
  if (!habitat) return { x: cx + dx * width * 0.4, y: cy + dy * height * 0.4 };

  // ① 一直走到出水前最后那个还在水里的点 —— 它就是这一侧的岸
  const limit = Math.hypot(width, height) * 0.5;
  const steps = 96;
  let bank = { x: cx, y: cy };
  for (let i = 1; i <= steps; i++) {
    const r = limit * i / steps;
    const x = cx + dx * r, y = cy + dy * r;
    if (!habitat.contains(x, y, 1)) break;
    bank = { x, y };
  }
  // ② 从岸边往池心退一小段（4–46px）：既贴着岸，又保证整窝卵都在水里。
  const [minInset, maxInset] = EGG_VISUAL.shoreInsetPx;
  const inset = minInset + ((u * 5003) % 1) * (maxInset - minInset);
  const point = { x: bank.x - dx * inset, y: bank.y - dy * inset };
  return habitat.contains(point.x, point.y, 5) ? point : habitat.project(point.x, point.y, 10);
}

/**
 * §8.2 步骤 3–5 的**视觉视图**：给一粒卵派位置、相位、大小。
 *
 * ⚠️ 返回的是行为层自己的视图对象，**不写回生态对象** ——
 *    `world.eggs` 只产出数据（卵在生态侧刻意没有坐标，见 world.js 头注），
 *    位置由行为层派。这条边界破坏掉的话，存档序列化就会开始带上坐标，
 *    而推演与存档共用同一批对象（`serialize()` 直接遍历 world.eggs）。
 */
export function eggVisual(egg, anchor, { habitat }) {
  const angle = idNoise(egg.id, 0x11) * TAU;
  // sqrt 让点在圆内**面均匀**而不是向圆心堆积（面积正比于 r²）
  const radius = Math.sqrt(idNoise(egg.id, 0x2b)) * EGG_VISUAL.clutchSpreadPx;
  const raw = { x: anchor.x + Math.cos(angle) * radius, y: anchor.y + Math.sin(angle) * radius };
  const point = habitat ? habitat.project(raw.x, raw.y, 5) : raw;
  return {
    id: egg.id,
    x: point.x,
    y: point.y,
    phase: idNoise(egg.id, 0x5f) * TAU,
    size: EGG_VISUAL.radiusPx + idNoise(egg.id, 0x77) * EGG_VISUAL.radiusJitterPx,
    fertilized: egg.fertilized === true,
    settle: 1,
  };
}
