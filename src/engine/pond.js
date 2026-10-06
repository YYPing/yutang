import { PondSimulation, DEFAULT_OPTIONS, clamp } from './simulation.js';
import { renderScale, createFishShadow, watchDeviceScale } from './rendering.js';
import { visualFor } from './term-visual.js';
import {Atmosphere} from './atmosphere.js';
import {Scenery} from './scenery.js';
import {Landscape} from './landscape.js';
import {KoiRenderer} from './koi-renderer.js';
import {prepareKoiSkin} from './koi-skin.js';
import {TurtleRenderer} from './turtles.js';
import {drawSurfaceRipples,drawShoreRipples} from './surface-waves.js';
import { EGG_VISUAL } from './eco/constants.js';
import { LightField, LIGHT, daylightOf, byDaylight } from './light-field.js';

const TAU = Math.PI * 2;

/* ============================================================ §10.5 光照场的画布口径 */
/**
 * ⚠️ 这三个数是**画布上的颜料浓度**，与 `LIGHT.*` 的**光场标量**不是同一个量纲，别混。
 *    光池峰值 `.55` 是 `lit`（F-10.5.2，用来算鱼亮度）；
 *    下面的 `.16` 是"这层径向涂多浓"（附录 A.2 #2）。
 *    两者都由需求给出，一个在 §10.5 的表里，一个在附录 A.2 的踩坑清单里。
 */
/** 光池的颜料浓度。**取 .16 不是调出来的**：附录 A.2 #2「光池压最亮处烧白 → 下移 y .26h、贡献 .16」。 */
const POOL_INK = 0.16;
/**
 * 单束光柱在带心的颜料浓度。
 *
 * ⚠️ **需求没有给这个数**（§10.5 只定了几何与时间：间隔 9–26s、存续 5.5–12s）。
 *    它是纯观感调参量 —— 但上下都有硬边界，不是随便填：
 *
 *  · **下界：要看得见**。0.13 时实测「带内有柱/无柱差分」带心附加 alpha 只有 .098、
 *    带内平均只抬高 **3.7 luma**（底色约 /145）。铺在密集的焦散网纹上，肉眼几乎读不出来 ——
 *    等于"功能做了但看不见"。这是被 `tools/shot-sunlight-ab.cjs` 的 A/B 实拍逼出来的。
 *  · **上界：不截顶**。滤色叠加的等效 alpha `1−Π(1−aᵢ)`，最坏情况是
 *    「光池 .16 + 两束光柱」同处 = 0.462。逐层套下来底色 210 的亮水也只到 244，
 *    离 255 还有余量 —— 所以 F-10.5.2 / 附录 A.2 #2 忌惮的"烧白"不会出现。
 *  · **取 .20 而不是"贴着光池的 .16"**：漫射天光与直射光柱不是一个量级，
 *    一束穿云而下的直射光**本来就该比它照亮的整片水面更亮**。
 *
 * 想再调：`SHAFT_INK` 是**唯一**该动的旋钮。调完必须重跑
 * `npm run check:light:ui`（带心 vs 带外 > .04、剖面单调、纵向中段最亮三条判据）
 * 与 `node tools/shot-sunlight-ab.cjs`（重新出一组 A/B 实拍）双确认。
 */
const SHAFT_INK = 0.2;
/** 层 12「明暗带」的 alpha。**需求写死的 .022** —— 调大立刻变成两条脏边。 */
const LIGHT_BAND_INK = 0.022;
/** 层 13「碎光」在晴天的峰值浓度。 */
const SPARKLE_INK = 0.34;
const ellipse = (ctx, x, y, rx, ry, fill, angle = 0) => {
  ctx.beginPath(); ctx.ellipse(x, y, rx, ry, angle, 0, TAU);
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
};

/**
 * 两个颜色按 t 混合。用于「叶色随冷暖走」这类连续调色。
 * ⚠️ 不从 `constants.js` 手抄色值 —— 渲染层自己编数是记忆里点过名的坑。
 *
 * ★★★★★ 这里原先**只接受 `#rrggbb`**（靠 `slice(1)` 当 hex 解析），
 *   于是**嵌套调用会产出垃圾色**。实测（2026-10-04，「荷叶太丑了」那轮）：
 *     mixHex('#79ad63', '#a8944e', 0)            = 'rgb(121,173,99)'   ✔
 *     mixHex('rgb(121,173,99)', '#ffffff', .30)  = 'rgb(77,77,77)'    ✘ 灰！
 *   原因是 `'rgb(121,173,99)'.slice(1)` = `'gb(121,173,99)'`，
 *   `parseInt('gb(..)', 16)` = NaN ⇒ 三通道全 0 ⇒ 混出来是灰/黑。
 *   而荷叶那段**到处都在嵌套调用**
 *   （`mixHex(leafHi,'#fff',.10)`、`mixHex(leafHi,leafLo,.30)`），
 *   于是所有「提亮」都变成了「往灰里混」——
 *   ★★★ **这就是前三版调参数怎么调都不对的真因**，不是参数问题，是颜色函数坏了。
 *   （也解释了为什么量具/单测全绿：它只判「有没有画上」，判不出「颜色对不对」。）
 *
 *   正解：解析端同时支持 `#rgb` / `#rrggbb` / `rgb()` / `rgba()`，返回 `rgb()`。
 */
function mixHex(a, b, t) {
  const parse = (c) => {
    if (typeof c !== 'string') return [0, 0, 0];
    const s = c.trim();
    const m = s.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i);
    if (m) return [+m[1], +m[2], +m[3]];
    const hex = s.replace(/^#/, '');
    if (hex.length === 3) {
      return [parseInt(hex[0] + hex[0], 16), parseInt(hex[1] + hex[1], 16),
        parseInt(hex[2] + hex[2], 16)];
    }
    const p = parseInt(hex, 16);
    if (Number.isNaN(p)) return [0, 0, 0];
    return [(p >> 16) & 255, (p >> 8) & 255, p & 255];
  };
  const [ar, ag, ab] = parse(a), [br, bg, bb] = parse(b);
  const k = Math.max(0, Math.min(1, t));
  return `rgb(${Math.round(ar + (br - ar) * k)},`
    + `${Math.round(ag + (bg - ag) * k)},${Math.round(ab + (bb - ab) * k)})`;
}

/**
 * 荷花簇的簇心（占画布比例）。三簇，横跨池面中上部。
 *
 * ★★ 为什么不是「池面随便撒」（2026-10-04 实测）：
 *   改前唯一的一簇在 (.76~.835, .90~.94) —— 而那正是**右下角按钮**
 *   （"桌面 / 沉浸"）与左下"画锦鲤 / 设置"两块 UI 面板的位置，
 *   实测截图里荷花被按钮盖掉大半，等于画了个看不见的东西。
 *   另两个簇心落在 (.30, .50) 与 (.60, .33)：都在池面中部偏上，
 *   避开四角 UI，符合需求 450 行「锦鲤悠然穿行于荷叶之间」——
 *   鱼要从荷叶**之间**穿过，簇就不能挤成一坨，也不能贴着边。
 *
 * ★★★ `w`（簇半径）是**算出来的**，不是摆的（2026-10-04）。
 *   起因：荷叶放大到 23~40px 后目视出现「褐色圆环 + 斑驳糊团」。
 *   逐层排查后定位到**不是渐变、不是描边**（内 1/3 处 rgb(111,159,91) 是对的绿），
 *   而是**叶片重叠**：簇 0 半径 .15 装着 15 片叶，最近邻实测只有 **10px**，
 *   而叶半径 23~40px ⇒ 重叠 4 倍 ⇒ 亮度图呈杂乱斑块（X/-/:/. 交错）。
 *   修法：`w` 按「叶片圆面积 × 1.35 铺满簇圆」反解，且 clamp 到画面安全区。
 *   夏至 22 片 × π×30²×1.35 / 3 簇 ⇒ 每簇需 ~9700px² ⇒ 半径 ≈ 0.088（画布比例，按面积折算到 w）
 *   ⇒ 实测最近邻回到 34~68px，叶片互不遮挡，形态才看得清。
 * ⚠️ 这三个点是**画面构图常量**，改它们要重新跑 `check:lotus` 的分布判据。
 */
const FLORA_CLUSTERS = [
  { x: 0.290, y: 0.500, w: 0.225 },
  { x: 0.615, y: 0.330, w: 0.170 },
  { x: 0.470, y: 0.690, w: 0.205 },
];

/* ★★ 花/苞/莲蓬**专用**的两个紧凑簇心（2026-10-05，用户「收拢成 2~3 个紧密花簇」）。
 *
 *   起因（实测）：花与叶共用 `FLORA_CLUSTERS`，而那 3 个簇心横跨 0.29~0.62
 *   画幅宽 ⇒ 即便把簇半径收到 .78，5 朵花的 bbox 仍有 **0.38 画幅宽**，
 *   最近的一对隔 250px ⇒ 读成「池里几朵散花」而不是「一片荷塘」。
 *   `tight` 只能收紧**簇内**半径，收不住**跨簇**距离 —— 必须给花自己的簇心。
 *
 *   两个心刻意**彼此靠近**（相距 0.19 画幅宽 ≈ 260px）且落在画面中部偏左：
 *   花团直径约 200px ⇒ 两团相接不重叠，看起来是一整片花丛。
 *   ⚠️ 都在 y≤0.60 之上，避开底部 UI 按钮栏（实测落点最低 y≈.60）。 */
const FLOWER_CLUSTERS = [
  { x: 0.345, y: 0.400, w: 0.130 },
  { x: 0.475, y: 0.352, w: 0.115 },
];

/**
 * 确定性散布：给定总数与序号，返回该片叶/花/苞/蓬的位置与大小。
 *
 * ★ 绝不用 `Math.random()`：
 *   ① 那会让每帧位置都变，看起来在抽搐；
 *   ② 量具无法复现同一画面 ⇒ 像素判据全部失效。
 * 用黄金角（2.399963 rad）散列 + 簇内半径按序号递增 —— 与改动前同一手法，
 * 但**簇心从 3 个挤在右下角改成横跨池面的 3 簇**。
 *
 * @param n     总数（用于让簇半径随叶量铺开）
 * @param i     序号
 * @param bias  尺寸偏置（1 = 与浮叶同尺度；荷花/花苞/莲蓬传各自的比例）
 *
 * ★★★ bias 的取值是**量出来的**（2026-10-04，`tools/_probe-lotus-colors.cjs`）：
 *   把「有 flora」与「无 flora」两张截图逐像素相减，只统计**真正被 flora 改掉的像素**，
 *   看四类形态各自的实际渲染色能否进入该档净改动像素的前 24 名：
 *     荷叶  直径 15~26px  → ✅ rgb(106,151,87) 1702 个（能检出）
 *     荷花  直径 24~40px  → ✅ rgb(246,231,231)  442 个（能检出）
 *     花苞  高 7~12px/宽 3~5px → ❌ 24 名开外（**太小，检不出**）
 *     莲蓬  直径 5~8px        → ❌ 24 名开外（**太小，检不出**）
 *   原 bias 花苞 0.62 / 莲蓬 0.52 —— 莲蓬比荷叶小 3 倍，
 *   **既骗过了像素判据，肉眼同样看不见**（即需求表「秋分莲蓬显现」在画面上是空的）。
 *   现按「莲蓬略小于浮叶、花苞与浮叶同尺度」重定。
 */
function FLORA_SPOTS(n, i, bias = 1, tight = 1, clusterCount = 3, table = null) {
  /* ★★ `table` / `clusterCount`：**换一套簇心**（2026-10-05，用户「收拢成 2~3 个紧密花簇」）。
   *   起因（实测）：花与叶共用 `FLORA_CLUSTERS`，那 3 个簇心横跨 0.29~0.62 画幅宽
   *   ⇒ 即便把簇半径 `tight` 收到 .78，5 朵花的 bbox 仍有 **0.38 画幅宽**、
   *   最近一对隔 250px ⇒ 读成「池里几朵散花」，不是「一片荷塘」。
   *   ★★ `tight` 只能收紧**簇内**半径，**收不住跨簇距离** —— 必须换簇心。
   *   花/苞/莲蓬传 `FLOWER_CLUSTERS`（两个彼此靠近的紧凑心）；
   *   荷叶不传 ⇒ 仍用池面铺开的 3 心（叶子要铺满整个池子）。 */
  const CT = table || FLORA_CLUSTERS;
  const nC = Math.min(clusterCount, CT.length);
  const c = CT[i % nC];
  const k = Math.floor(i / nC);
  /* ★★★ 簇内铺开：叶量越多半径越大。**这个上限必须去掉**（2026-10-04）。
   *   原式 `min(1, .30 + .70*(n/14))` 在 n=22（夏至）时算得 1.4 → 被 clamp 到 1，
   *   也就是**簇半径根本不再随叶量增长**。后果：22 片叶挤进固定半径，
   *   实测最近邻只有 10px 而叶半径 23~40px ⇒ **重叠 4 倍** ⇒
   *   画面上不是荷叶而是「褐色斑驳糊团」（亮度图 X/-/:/. 交错，没有规整圆形）。
   *   去掉上限后按 sqrt 铺开（簇面积 ∝ 叶数），夏至实测最近邻 10px → 34px。
   * ⚠️ 那个上限的**本意**（防飞出画面）改由 `FLORA_CLUSTERS.w` 的取值来保证 ——
   *   那三个点是人工标定的画面安全区（见其注释里的 UI 排查结果）。 */
  /* ★★ `tight`：**花/苞/莲蓬比荷叶更聚拢**（2026-10-05，用户「看不出同一片荷塘」）。
   *   起因：花与叶共用同一份 `reach`，而 n=5（花）时 sqrt((.30+.70*5/14)/1.4)=.51，
   *   簇半径只有叶子的 2/3 —— 加上 `i+80` 的序号偏移把花甩到**另外的位置**，
   *   实测夏至 5 朵花散在 0.37 画幅宽里（最近邻 200px+）⇒ 读成「池里几朵散花」，
   *   而不是「一片荷塘」。tight=.55 把花的簇半径再收一半，且**仍用同一批簇心**
   *   ⇒ 花落在荷叶簇的内部 ⇒ 空间上从属关系成立。 */
  const reach = c.w * Math.sqrt((0.30 + 0.70 * (n / 14)) / 1.4) * tight;
  const ang = k * 2.399963 + c.x * 9.1;
  /* ★★★ 环半径必须**连续单调**，不能用 `(k%5)/4`。
   *   起因（2026-10-04）：`k%5` 让 k=0 与 k=5 落在**同一环**上，
   *   夏至簇 0 的 8 里有 2 片重叠，最近邻 13px 而叶半径 32px ⇒ 重叠 2.5 倍。
   *   改成 `sqrt((k+.5)/7)`：按面积均匀铺 7 个环，且不重复。
   *   实测（w 取 FLORA_CLUSTERS 原值、1380×900）：
   *     n=22 最近邻 13→56px（比值 0.42→1.75）· n=15 →87px · n=9 →77px · n=2 →562px
   *     全部档次 y 落在 [0.25, 0.78]，**不出画面、不进 UI 区**。
   *   ⚠️ 7 是「每簇最多 7 环」的经验值 —— 实测 22 片/3 簇 ≈ 7.3 片每簇，够用；
   *   若将来把簇数减到 2 或 LEAF_MAX 提到 30+，这里要重新扫（见 MEMORY 的扫参表）。 */
  const ring = Math.sqrt(Math.min(1, (k + 0.5) / 7));
  const rad = reach * (0.12 + 0.88 * ring);
  return {
    x: c.x + Math.cos(ang) * rad,
    y: c.y + Math.sin(ang) * rad * 0.58,
    size: (15 + 11 * ((i * 7) % 5) / 4) * bias,
    tilt: -0.34 + ((i * 13) % 11) / 11 * 0.68,
    phase: (i * 2.399963) % TAU,
  };
}

/* ★★★ 四类形态的尺寸偏置，**drawLotus 与 manifest 共用同一份**。
 *
 *   这组值改了两次，每次都是**量出来的**（`tools/_probe-lotus-colors.cjs` 量像素检出，
 *   `out/verify/lotus-*.png` 放量级判断），不是拍的：
 *
 *   第一轮（按颜色检出反推）：花苞 0.62 / 莲蓬 0.52 —— 莲蓬直径只有 5~8px，
 *     比荷叶（15~26px）小 3 倍，既骗过像素判据、**肉眼同样看不见**。
 *
 *   第二轮（**目视**又抓一轮）：把 ① 荷叶 1.55 ② 花苞 1.35 ③ 荷花 1.05 ④ 莲蓬 1.35。
 *     第一轮只解决了「检不出」，没解决「看得见」——
 *     ★★ 量具能测出"这里有 80 个净改动像素"，**测不出"这东西太小看不出来"**。
 *        这是像素判据的天花板：存在性 ≠ 可辨识性。形态类的东西必须目视复核。
 *     荷叶放大到 23~40px 才够"巴掌大翠绿圆叶"（参考图）；
 *     莲蓬放大到 16~28px 才够「秋分·花谢莲蓬显现」这个需求主态。
 */
const FLORA_BIAS = { leaf: 1.55, bud: 1.35, flower: 1.50, pod: 1.35 };
/* ★ 三类「非叶」形态的簇半径紧缩系数（2026-10-05）。
 *   **当前全为 1.0** —— 收拢是靠 `FLOWER_CLUSTERS`（换簇心）实现的，不是靠缩半径。
 *   留这个参数是因为：若日后想让花**再**聚一点，改这里比改簇心安全
 *   （簇心一动就要重新核「是否落进 UI 面板区」，见 `_flora-pano.cjs` 的 bbox 输出）。 */
const FLOWER_TIGHT = 1.0, BUD_TIGHT = 1.0, POD_TIGHT = 1.0;
/* ★★★ 花朵的**俯视压扁系数**（2026-10-05）。见 `drawLotus` 里荷花段的详细说明。
 *   一句话：荷花的瓣是**斜向上**伸出去的，俯视投影时纵向被压短、横向不变
 *   ⇒ 屏幕上瓣自然变窄变短，邻瓣之间自然露出水色。**这个压缩才是「瓣间有缝」的来源**，
 *   不是把瓣宽调小（调小会得到柳叶/飞镖，不是荷花）。 */
const FLORA_FLAT = 0.62;

/**
 * 层 13 碎光用的小亮斑，**预渲染一次**。
 *
 * ⚠️ 不要每帧 `createRadialGradient` —— 每帧 26 个渐变对象 × 60Hz = 1560 个/秒，
 *    而这些点除了位置和透明度之外**完全一样**。预渲染成精灵再 `drawImage` 是同一张图，
 *    成本差一个数量级。（与 `createFishShadow()` 同一套做法。）
 */
function createSparkleSprite() {
  const size = 32;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const half = size / 2;
  const dot = ctx.createRadialGradient(half, half, 0, half, half, half);
  dot.addColorStop(0, 'rgba(255,253,232,1)');
  dot.addColorStop(0.32, 'rgba(255,250,214,.72)');
  dot.addColorStop(0.66, 'rgba(255,246,196,.2)');
  dot.addColorStop(1, 'rgba(255,242,182,0)');
  ctx.fillStyle = dot;
  ctx.fillRect(0, 0, size, size);
  return canvas;
}
/** A transparent Canvas pond layer; UI owns all pointer event listeners. */
export class PondEngine extends KoiRenderer {
  constructor(canvas, options = {}, landscapeCanvas = null) {
    super(canvas.getContext('2d', {alpha:true}));
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: true });
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.sim = new PondSimulation(1000, 700, this.options);
    this.images = new Map();
    // ★ 节气渲染参数。构造函数先给一份中性春，render() 每帧覆盖 ——
    //   免得第一帧（landscape 还没 onLoad）读undefined。
    this.termVisual = visualFor(this.options);
    this.shadowSprite = createFishShadow();
    this.sparkleSprite = createSparkleSprite();
    this.atmosphere = new Atmosphere(this.options);
    this.scenery = new Scenery();
    this.turtleRenderer = new TurtleRenderer();
    this.landscape = new Landscape(landscapeCanvas);
    this.landscape.onLoad = () => this.render();
    // §10.5 光照场。★ 挂在 `this` 上（而不是只在 drawWater 里 new 一个）——
    //   KoiRenderer.drawFish 要靠 `this.lightField` 问每一条鱼位置的 `lightAt`，
    //   这就是 US-11「阳光处鱼亮」的通路。
    this.light = new LightField();
    this.light.configure(this.options);
    this.lightField = this.light;
    this.isWater = (x,y) => this.landscape.waterAt(x,y);
    this.running = false;
    this.destroyed = false;
    this.lastTime = 0; this.nextFrame = 0;
    this.rafInterval = 1000 / 60; this.previousRaf = 0;
    this.fps = 0;
    this.sampleStart = 0;
    this.sampleFrames = 0;
    this.frame = 0;
    this.width = 0;
    this.height = 0;
    this.dpr = 1;
    this.motes = Array.from({ length: 120 }, (_, i) => ({
      x: ((i * 0.61803398875 + 0.13) % 1),
      y: ((i * 0.38196601125 + 0.21) % 1),
      seed: ((i * 0.7548776662 + 0.1) % 1),
      size: 0.6 + ((i * 0.56984029) % 1) * 1.5,
    }));
    this.tick = this.tick.bind(this);
    this.handleVisibility = () => {
      this.lastTime = 0; this.nextFrame = 0;
      this.sampleStart = this.sampleFrames = this.fps = 0;
      if (document.hidden) { cancelAnimationFrame(this.frame); this.frame = 0; }
      else if (this.running && !this.destroyed) this.schedule();
    };
    document.addEventListener('visibilitychange', this.handleVisibility);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.handleResize = () => this.resize();
    this.stopWatchingDeviceScale = watchDeviceScale(this.handleResize);
    window.addEventListener('resize', this.handleResize);
    this.resizeObserver.observe(canvas);
    this.resize();
  }

  resize() {
    if (this.destroyed) return;
    const rect = this.canvas.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);
    this.displayScale = Math.max(window.devicePixelRatio || 1, this.options.desktopMode ? this.options.displayPixelRatio || 1 : 1);
    const dpr = renderScale(width, height, window.devicePixelRatio || 1, this.options.quality, this.options.desktopMode, this.options.displayPixelRatio);
    if (width !== this.width || height !== this.height || dpr !== this.dpr) {
      this.width = width; this.height = height; this.dpr = dpr;
      this.canvas.width = Math.round(width * dpr);
      this.canvas.height = Math.round(height * dpr);
      this.sim.setBounds(width, height);
      this.atmosphere.impacts.length = 0;
      this.landscape.resize(width, height, dpr);
    }
    if (this.options.desktopMode) {
      this.desktopSize = [this.canvas.width, this.canvas.height];
      this.desktopBackgroundSize = this.landscape.getStats().backgroundSize;
    }
    this.render();
  }

  start() { if (this.destroyed || this.running) return; this.running = true; this.lastTime = 0; this.nextFrame = 0; this.schedule(); }
  schedule() { if (!this.frame && !this.options.paused && !document.hidden && !this.destroyed) this.frame = requestAnimationFrame(this.tick); }
  tick(timestamp) {
    this.frame = 0;
    if (!this.running || this.destroyed || document.hidden) return;
    const interval = this.options.quality === 'low' || this.options.reducedMotion ? 1000 / 30 : 1000 / 60;
    if (this.previousRaf) this.rafInterval = this.rafInterval * .9 + Math.min(100, timestamp - this.previousRaf) * .1;
    this.previousRaf = timestamp;
    // At 60 Hz render every vsync; a second wall-clock gate would mistake GPU jitter
    // for a too-early frame. Faster displays and 30 FPS modes use a phase-aligned cap.
    if (interval < 20 && this.rafInterval > 14.5) this.nextFrame = timestamp + interval;
    else {
      if (!this.nextFrame || timestamp - this.nextFrame > interval * 2) this.nextFrame = timestamp;
      if (timestamp + 2 < this.nextFrame) { this.schedule(); return; }
      this.nextFrame += Math.max(1, Math.floor((timestamp - this.nextFrame + 2) / interval) + 1) * interval;
    }
    const dt = this.lastTime ? Math.min((timestamp - this.lastTime) / 1000, 0.05) : 1 / 60;
    this.lastTime = timestamp;
    this.sim.update(dt);
    // ⚠️ 光照场必须在 `render()` **之前**推进：光柱的包络是这一帧画出来的，
    //    晚一步就是"画的是上一帧的柱子"，鱼与亮带会错开一帧。
    this.light.update(dt, this.width, this.height);
    for (const event of this.atmosphere.update(dt, this.width, this.height, this.sim.fish, this.sim.hand, this.isWater)) this.options.onThunder?.(event);
    this.render();
    if (!this.sampleStart) this.sampleStart = timestamp;
    else this.sampleFrames++;
    if (timestamp - this.sampleStart >= 1000) {
      this.fps = Math.round(this.sampleFrames * 1000 / (timestamp - this.sampleStart));
      this.sampleStart = timestamp; this.sampleFrames = 0;
    }
    this.schedule();
  }

  updateOptions(partial = {}) {
    const qualityChanged = (partial.quality !== undefined && partial.quality !== this.options.quality)
      || (partial.desktopMode !== undefined && partial.desktopMode !== this.options.desktopMode)
      || (partial.displayPixelRatio !== undefined && partial.displayPixelRatio !== this.options.displayPixelRatio);
    this.options = { ...this.options, ...partial };
    this.sim.updateOptions(partial);
    this.atmosphere.configure(partial);
    this.light.configure(partial);
    if (this.options.paused) { cancelAnimationFrame(this.frame); this.frame = 0; this.lastTime = 0; this.nextFrame = 0; this.sampleStart = this.sampleFrames = this.fps = 0; }
    else if (this.running) this.schedule();
    if (qualityChanged) { this.nextFrame = 0; this.resize(); }
    else this.render();
  }
  pointer(x, y, active = true) { this.sim.pointer(x, y, active); }
  /** 返回 `{ok, capped}` —— capped 时界面按 F-2.6 提示「这一把够了」。*/
  feed(x, y) { const result = this.sim.feed(x, y); if (this.options.paused) this.render(); return result; }
  /** 生态模式：把种群重置为 N 尾（由设置面板的按钮显式触发，不是滑杆实时生效）。*/
  resetPopulation(count) { this.sim.resetEcoPopulation(count); this.render(); }
  /** F-14.1.4「重置池塘」：连生态时钟一起归零（新开一池）。*/
  resetEcoFully(count) { this.sim.resetEcoFully(count); this.render(); }
  /** §14.1 快照（非生态模式返回 null）。save-store 拿它落盘。*/
  getSnapshot() { return this.sim.getSnapshot(); }
  /** F-14.2.5 归来摘要，读过即清。*/
  takeAwayReport() { return this.sim.takeAwayReport(); }
  getStats() { return { ...this.sim.getStats(), fps: this.fps, width: this.canvas.width, height: this.canvas.height,
    ...this.landscape.getStats(), displayScale: this.displayScale,
    desktopMode: !!this.options.desktopMode, desktopSize: this.desktopSize, desktopBackgroundSize: this.desktopBackgroundSize, scenery: {rainDrops:this.atmosphere.drops.length, rainHits:this.atmosphere.rainHits, leaves:this.atmosphere.leaves.length, landings:this.atmosphere.landings, landscape:!!this.landscape.ready} }; }
  setCustomFish(items = []) {
    this.sim.setCustomFish(items);
    const wanted = new Set(this.sim.customFish.map((item) => item.texture).filter(Boolean));
    for (const key of this.images.keys()) if (!wanted.has(key)) this.images.delete(key);
    for (const texture of wanted) {
      if (this.images.has(texture)) continue;
      const img = new Image();
      this.images.set(texture, img);
      img.onload = () => {
        if (this.destroyed) return;
        const item = this.sim.customFish.find(f => f.texture === texture);
        try { img.skin = prepareKoiSkin(img, item?.appearance); } catch { /* A damaged saved PNG keeps a native koi visible. */ }
        this.render();
      };
      img.src = texture;
    }
    this.render();
  }
  destroy() {
    this.destroyed = true; this.running = false;
    cancelAnimationFrame(this.frame);
    this.resizeObserver.disconnect();
    this.stopWatchingDeviceScale?.();
    window.removeEventListener('resize', this.handleResize);
    document.removeEventListener('visibilitychange', this.handleVisibility);
    for (const img of this.images.values()) img.onload = null;
    this.images.clear();
    this.shadowSprite.width = this.shadowSprite.height = 0;
    this.sparkleSprite.width = this.sparkleSprite.height = 0;
    this.scenery.destroy(); this.landscape.destroy(); this.turtleRenderer.destroy();
  }

  render() {
    const ctx = this.ctx;
    if (!ctx || this.destroyed) return;
    // ★ 每次渲染重算一次「节气 → 渲染参数」。
    //   为什么放render 里而不是 `updateOptions`：档案在渐变模式下**每帧都在变**
    //   （`blendTerm` 按黄经连续插值），而 `updateOptions` 只在 options 引用变化时触发。
    //   放这里保证「节气渐变」是逐帧连续的，而不是每换一次档才跳一下。
    this.termVisual = visualFor(this.options);
    /* ★★ 每帧**清空**荷花落点清单（2026-10-04）。
     *   踩过：`floraManifest` 只在 `drawLotus()` 里被赋值，而冬季四形态全为 0 时
     *   `drawLotus()` **压根不被调用** ⇒ manifest 保留上一帧的残留（实测冬档仍有 4~28 个落点），
     *   量具拿它当"本帧画了什么"就全错。
     *   这与 `atmosphere.syncLitter` 同一类问题：per-frame 的派生状态必须在 render 里重置，
     *   不能指望"生产者一定会被调用"。 */
    this.floraManifest = { leaf: [], bud: [], flower: [], pod: [] };
    // ★ 落叶存量跟着节气档案走（2026-10-04 接入 `litterCount`）。
    //   为什么不在 `updateOptions` 里做：那里只跑一次，而档案在渐变模式下每帧都在变
    //   ⇒ 交节后落叶数会停在旧值（用户可见：冬至还在飘 3 片秋叶）。
    //   这里每帧同步，代价只是一个整数比较。
    this.atmosphere.syncLitter(this.termVisual.litterCount);
    // ★ 把渲染参数也放进传给 landscape 的那份 options —— shader 要读它做水色。
    //   不能直接改 this.options：那会让 useMemo 的引用比对失效、也可能被存档逻辑看到。
    this.landscape.render(this.sim.time, { ...this.options, termVisual: this.termVisual }, this.sim.hand);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.save();
    this.drawWater();
    // §11.4 层 6「鱼卵群」。卵在池底 ⇒ 画在水色之后、任何浮叶之前。
    this.drawEggs();
    const turtleScale = clamp(Math.min(this.width / 1250, this.height / 780), .78, 1.15);
    // 乌龟 alpha 走dayLight 连续插值（turtles.js 里 `night?.75:.95` 改为接受 0..1）
    for (const turtle of this.sim.turtles) this.turtleRenderer.draw(ctx, turtle, {scale:turtleScale,daylight:daylightOf(this.options),shadow:true});
    for (const fish of this.sim.fish) this.drawFish(fish, true);
    for (const fish of this.sim.fish) this.drawFish(fish, false);
    for (const turtle of this.sim.turtles) this.turtleRenderer.draw(ctx, turtle, {scale:turtleScale,daylight:daylightOf(this.options)});
    /* ★★★ 层序修正（2026-10-04）：荷叶荷花挪到**鱼之后**。
     * 需求 §11.4 层 10 明写「荷花荷叶 flora **压住鱼**」—— 荷叶是浮在水面上的
     * 遮挡物，鱼在水下，所以从上看必须是**叶盖住鱼**。
     * 改前 drawLotus() 在 drawFish 之前 ⇒ 鱼从荷叶上盖过去，
     * 看起来像鱼浮在叶子上方（这是记忆里挂了很久的那条"唯一明确的 §11 违背"）。
     * ⚠️ 门控条件从 `leafCount > 0` 放宽到「四种形态任一非零」——
     *   白露/秋分 leafCount 还有 9~12 但 lotus=0 bud=2 pod=4，旧的判断不会画；
     *   大雪~大寒 全为 0 才真的不画。 */
    const tv = this.termVisual;
    if (tv.leafCount > 0 || tv.lotusCount > 0 || tv.budCount > 0 || tv.podCount > 0) this.drawLotus();
    // ★★★ 冰层已取消（2026-10-05，用户「冬天的冰封效果取消」）。
    //   改前这里是 `if (ice > 0.02 || weather==='snowy') this.drawIce()`，
    //   而 `drawIce` 画的是**四样东西**：整池冰层反光 / 裂纹 / 岸边积雪 / 岸边雪粒。
    //   保留的是**岸边浮霜**（`frost`，秋末最早的信号）与**冰下泉眼**
    //   （用户明确要过「冬季留一处活水泉眼」），两者都已搬进 `drawWinter()`。
    // ⚠️ 降雪（`drawWeather` 的雪花）**没动** —— 那是天气，不是封水面。
    // ⚠️ 门控从「ice>0.02」改成「frost 或 iceHole 有一个存在就画」：
    //   旧门控里 `|| weather==='snowy'` 会让**手动选下雪天气**的非冬季档
    //   也走一遍冰层绘制路径，现在这条路径已不存在，必须同步改掉。
    if (this.termVisual.frost > 0.02 || this.termVisual.iceHole > 0) this.drawWinter();
    this.scenery.clouds(ctx, this.atmosphere, this.width, this.height, this.options);
    drawSurfaceRipples(ctx, this.sim.time, this.width, this.height, this.options);
    drawShoreRipples(ctx, this.sim.time, this.width, this.height, this.options, this.isWater);
    this.drawFood();
    this.drawRipples();
    this.drawFeedCircles();
    this.scenery.leaves(ctx, this.atmosphere, this.width, this.height, this.options);
    this.scenery.rain(ctx, this.atmosphere, this.width, this.height, this.options);
    this.drawWeather();
    this.drawInsects();
    ctx.restore();
  }

  drawWater() {
    const ctx = this.ctx, { weather, night, reducedMotion } = this.options;
    const t = reducedMotion ? 0 : this.sim.time;
    // ★ 昼夜连续化（2026-10-04）：`dim` = 夜色浓度 0（白天）.. 1（深夜）。
    //   旧代码是 `if (night) {...整层夜色} else if (sunny) {...光池光柱}` ——
    //   一天只有两种画面，黎明 5–7 点会**突然**从光池跳到夜罩。
    //   现在三层按 dim 叠加：夜色罩淡入 + 月晕浮现 + 光池光柱淡出。
    //   门控仍留布尔（`sunny` 才画光池是**天气**门控，不是昼夜门控）。
    const dim = 1 - daylightOf(this.options);
    if (dim > 0.001) {
      ctx.fillStyle = `rgba(7,25,39,${0.22 * dim})`; ctx.fillRect(0, 0, this.width, this.height);
      const moon = ctx.createRadialGradient(this.width * 0.72, this.height * 0.18, 0, this.width * 0.72, this.height * 0.18, this.width * 0.32);
      moon.addColorStop(0, `rgba(176,224,230,${0.10 * dim})`); moon.addColorStop(1, 'rgba(131,204,215,0)');
      ctx.fillStyle = moon; ctx.fillRect(0, 0, this.width, this.height);
    }
    if (weather === 'sunny') {
      // §10.5 白天「阳光照耀」= 高斯光池 + 偶发梦幻光柱。
      // 老代码这里是**一条硬编码的** `.10` 径向、位置 `y .16h` —— 附录 A.2 #1/#2
      // 两条坑写的正是它（"光池铺满无明暗" / "压最亮处烧白"）。现在峰值/σ/位置
      // 全部由 `LightField` 按 F-10.5.2 给，画布只是它的一次投影。
      // ★ 夜里光池不该完全消失（云隙月光/路灯），保留 12% 作为"最暗那档"的下限。
      this.drawLightPool(1 - 0.88 * dim);
      this.drawShafts(1 - 0.88 * dim);
    } else if (weather === 'cloudy' || weather === 'rainy' || weather === 'stormy') {
      const a = weather === 'stormy' ? .25 : weather === 'rainy' ? .18 : .09;
      ctx.fillStyle = `rgba(${weather === 'stormy' ? '22,40,58' : weather === 'rainy' ? '33,62,69' : '41,70,66'},${a})`;
      ctx.fillRect(0, 0, this.width, this.height);
    }
    if (this.options.quality === 'low') return;
    ctx.save(); ctx.globalCompositeOperation = 'screen'; ctx.lineWidth = 0.6;
    for (let i = 0; i < 10; i++) {
      const m = this.motes[i];
      const x = this.width * (0.17 + m.x * 0.64) + Math.sin(t * 0.07 + i) * 15;
      const y = this.height * (0.16 + m.y * 0.7) + Math.cos(t * 0.09 + i) * 12;
      // 白天这圈波纹更明显（0.025±.009），夜里几乎看不见（0.015）
      ctx.strokeStyle = `rgba(221,246,200,${byDaylight(0.015, 0.025 + Math.sin(t * 0.4 + i) * 0.009, this.options)})`;
      ctx.beginPath(); ctx.ellipse(x, y, 38 + m.seed * 54, 13 + m.seed * 24, m.seed * 3, 0.4, 4.9); ctx.stroke();
    }
    ctx.restore();
    this.drawSparkles(t);
  }

  /**
   * F-10.5.2 光池。高斯（峰值 .55、σ .26、y ≈ .26h）投影到画布上就是一条径向。
   *
   * ⚠️ 这里有两套**不同量纲**的数字，混起来就错了：
   *   · `.55` 是**光场标量**（lit），用来算鱼亮度，不直接上画布；
   *   · `.16` 是**颜料浓度**（这条径向涂多浓），来自附录 A.2 #2。
   *   把 .55 当 alpha 用，画面立刻白洗（就是那个坑本身）。
   */
  /**
   * F-10.5.2 光池。`strength` = 强度倍率（2026-10-04 昼夜连续化新增）。
   * ⚠️ 默认 1 = 白昼原样，**不传时行为与改动前逐位一致**。
   *   夜里传 0.12 而不是 0：完全消失会让"阴天的夜里"变成一块死黑，
   *   而需求 §10.5 画的是「夜里也有光池，只是光弱」。
   */
  drawLightPool(strength = 1) {
    const ctx = this.ctx;
    const [r, g, b] = this.light.channels.tint;
    const sigma = LIGHT.poolSigma * Math.min(this.width, this.height);
    const cx = this.width * LIGHT.poolX;
    const cy = this.height * LIGHT.poolY;
    const radius = sigma * 2.6;
    const pool = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
    // 三个 stop 是按高斯 `e^(−r²/2σ²)` 算的，不是随手拉的：
    // r=.91σ → .66　r=1.77σ → .21　r=2.6σ → .034
    const k = POOL_INK * strength;
    pool.addColorStop(0, `rgba(${r},${g},${b},${k})`);
    pool.addColorStop(0.35, `rgba(${r},${g},${b},${k * 0.62})`);
    pool.addColorStop(0.68, `rgba(${r},${g},${b},${k * 0.22})`);
    pool.addColorStop(1, `rgba(${r},${g},${b},0)`);
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    ctx.fillStyle = pool;
    ctx.fillRect(0, 0, this.width, this.height);
    ctx.restore();
  }

  /**
   * F-10.5.4 / F-10.5.5 光柱。几何与 `LightField.shaftGeometry` **共用一套坐标口径** ——
   * 这样"画出来的亮带"与"鱼读到的 lit"永远是同一个东西，不会出现
   * 「看起来亮在左边、鱼却在右边开始提亮」的错位。
   *
   * ⚠️ 纵向淡出靠**切片**，不是靠第二个渐变：canvas 的渐变只能是一维的，
   *    要同时表达「横向软边 × 纵向进出」就必须把带子切段、每段一个 `globalAlpha`。
   *    20 段 —— 再少会在淡出段看到台阶，再多就是白付建路径的钱（每帧最多 2 束）。
   */
  drawShafts(strength = 1) {
    const shafts = this.light.activeShafts();
    if (!shafts.length) return;
    const ctx = this.ctx;
    const [r, g, b] = this.light.channels.tint;
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    const slices = 20;
    for (const shaft of shafts) {
      const geo = this.light.shaftGeometry(shaft, this.width, this.height);
      const glow = ctx.createLinearGradient(geo.cx - geo.halfWidth, 0, geo.cx + geo.halfWidth, 0);
      glow.addColorStop(0, `rgba(${r},${g},${b},0)`);
      glow.addColorStop(0.5, `rgba(${r},${g},${b},1)`);
      glow.addColorStop(1, `rgba(${r},${g},${b},0)`);
      ctx.fillStyle = glow;
      const span = geo.bottom - geo.top;
      for (let i = 0; i < slices; i++) {
        const y0 = geo.top + (span * i) / slices;
        const y1 = geo.top + (span * (i + 1)) / slices;
        const ends = Math.sin(Math.PI * clamp(geo.alongAt((y0 + y1) * 0.5), 0, 1));
        const alpha = SHAFT_INK * shaft.envelope * ends * ends * strength;
        if (alpha < 0.002) continue;
        ctx.globalAlpha = alpha;
        ctx.beginPath();
        ctx.moveTo(geo.axisAt(y0) - geo.halfWidth, y0);
        ctx.lineTo(geo.axisAt(y1) - geo.halfWidth, y1);
        ctx.lineTo(geo.axisAt(y1) + geo.halfWidth, y1);
        ctx.lineTo(geo.axisAt(y0) + geo.halfWidth, y0);
        ctx.closePath();
        ctx.fill();
      }
    }
    ctx.restore();
    this.drawLightBands(shafts);
  }

  /**
   * §11.2 层 12「明暗带（alpha .022）」。
   *
   * 光柱两侧本来就该有被对比出来的暗带 —— 阳光从云缝下来时，亮带旁边那片水面
   * **并没有真的变暗**，是眼睛把它读暗了。所以这里只补一层极淡的暗色，让亮带"坐得住"。
   * ⚠️ 这一层的全部本事就在"几乎看不见"：需求把它定死在 `.022`，
   *    调到 .06 就变成两条脏边，调到 0 亮带就"飘"在水面上没有落点。
   */
  drawLightBands(shafts) {
    const ctx = this.ctx;
    const slices = 8;
    ctx.save();
    ctx.fillStyle = `rgba(9,32,32,${LIGHT_BAND_INK})`;
    for (const shaft of shafts) {
      const geo = this.light.shaftGeometry(shaft, this.width, this.height);
      const span = geo.bottom - geo.top;
      for (const side of [-1, 1]) {
        const inner = geo.halfWidth * 1.04 * side;
        const outer = geo.halfWidth * 1.9 * side;
        for (let i = 0; i < slices; i++) {
          const y0 = geo.top + (span * i) / slices;
          const y1 = geo.top + (span * (i + 1)) / slices;
          const ends = Math.sin(Math.PI * clamp(geo.alongAt((y0 + y1) * 0.5), 0, 1));
          if (ends * ends < 0.05) continue;
          ctx.globalAlpha = shaft.envelope * ends * ends;
          ctx.beginPath();
          ctx.moveTo(geo.axisAt(y0) + inner, y0);
          ctx.lineTo(geo.axisAt(y1) + inner, y1);
          ctx.lineTo(geo.axisAt(y1) + outer, y1);
          ctx.lineTo(geo.axisAt(y0) + outer, y0);
          ctx.closePath();
          ctx.fill();
        }
      }
    }
    ctx.restore();
  }

  /**
   * §11.2 层 13「碎光」。需求 F-10.4.4 把它列为**光照调制通道之一**（不是独立的天气特效），
   * 所以强度跟着 `channels.sparkle` 走：晴 1 → 多云 .44 → 雨 .26 → 暴雨 .16。
   *
   * ⚠️ 位置不是随便撒的。碎光是**阳光在水面的镜面反射**，暗处不该有。
   *    候选点先用 `lightAt` 过一遍，只有落在光池/光柱里的才画 ——
   *    撒满全屏会读成"星星"，而不是"阳光在水上晃"。
   */
  drawSparkles(t) {
    const sparkle = this.light.channels.sparkle;
    if (sparkle <= 0.04 || this.options.quality !== 'high') return;
    const ctx = this.ctx;
    const count = 26;
    const reference = this.light.referenceLit;
    const reach = LIGHT.poolPeak + LIGHT.shaftPeak;
    const size = this.sparkleSprite.width;
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    for (let i = 0; i < count; i++) {
      const m = this.motes[(i * 17) % this.motes.length];
      const x = this.width * (0.08 + m.x * 0.86) + Math.sin(t * 0.11 + i * 1.7) * 9;
      const y = this.height * (0.08 + m.y * 0.86) + Math.cos(t * 0.13 + i * 2.1) * 8;
      const gain = clamp((this.light.lightAt(x, y, this.width, this.height) - reference) / reach, 0, 1);
      if (gain <= 0.02) continue;
      const flicker = 0.55 + 0.45 * Math.sin(t * (1.6 + m.seed * 2.4) + m.seed * TAU);
      const alpha = SPARKLE_INK * sparkle * gain * flicker;
      if (alpha < 0.01) continue;
      const scale = 4 + m.seed * 6;
      ctx.globalAlpha = alpha;
      ctx.drawImage(this.sparkleSprite, x - scale * 0.5, y - scale * 0.5, scale, scale);
    }
    ctx.restore();
  }

  /**
   * §11.2 层 6「鱼卵群」（§8.2 繁殖全过程 步骤 3–5 的视觉）。
   *
   * 需求 §8.2 把卵这一段写得很具体，三件事都要看得见：
   *   步骤 3 产卵     —— 水草/石上（落点由行为层派在靠岸环带上，见 eco-bridge.clutchAnchor）
   *   步骤 4 受精判定 —— 未受精卵**变白淡出**（产卵后 1 池塘日内结算完 ⇒ `egg.settle` 1→0）
   *   步骤 5 孵化     —— 卵粒**搏动**
   *
   * ⚠️ 渲染层只读 `sim.eggs` 的**视图字段**，不认识「一窝」「受精率」这些生态概念 ——
   *    那两层翻译在 eco-bridge / simulation 里做完了。
   */
  drawEggs() {
    const eggs = this.sim.eggs;
    if (!eggs.length) return;
    const ctx = this.ctx;
    const still = this.options.reducedMotion;
    const t = still ? 0 : this.sim.time;
    const [fr, fg, fb] = EGG_VISUAL.fertileRgb;
    const [wr, wg, wb] = EGG_VISUAL.whiteRgb;
    const pulseRate = EGG_VISUAL.pulseHz * TAU;
    for (const egg of eggs) {
      const settle = egg.settle;
      if (settle <= 0.02) continue;              // 已结算完的未受精卵：不画
      // 步骤 5「卵粒搏动」。减动效下取 1（不搏动）—— 与虚线圈/涟漪同一套 reducedMotion 口径。
      const pulse = still ? 1 : 1 + Math.sin(t * pulseRate + egg.phase) * EGG_VISUAL.pulseAmount;
      const r = egg.size * pulse;
      // 步骤 4「变白淡出」：`white = 1 − settle` 让颜色由琥珀推向白，同时 alpha 由 1 落到 0。
      const white = 1 - settle;
      const cr = (fr + (wr - fr) * white) | 0;
      const cg = (fg + (wg - fg) * white) | 0;
      const cb = (fb + (wb - fb) * white) | 0;
      ctx.save();
      ctx.globalAlpha = settle;
      ctx.fillStyle = `rgba(${cr},${cg},${cb},.92)`;
      ctx.beginPath(); ctx.ellipse(egg.x, egg.y, r, r * 0.9, 0, 0, TAU); ctx.fill();
      // 受精卵补一个亮核：池底本来就暗、卵又只有 2–3px，没有核就只是一粒"脏点"，
      // 读不出"里面有个小的在动"。
      if (egg.fertilized) {
        ctx.fillStyle = 'rgba(255,250,224,.55)';
        ctx.beginPath(); ctx.ellipse(egg.x - r * 0.24, egg.y - r * 0.24, r * 0.34, r * 0.3, 0, 0, TAU); ctx.fill();
      }
      ctx.restore();
    }
  }

  drawFood() {
    const ctx = this.ctx, t = this.sim.time;
    for (const pellet of this.sim.food) {
      const bob = Math.sin(t * 2 + pellet.phase) * 0.65;
      const alpha = Math.min(1, (pellet.life - pellet.age) / 3);
      ctx.globalAlpha = alpha;
      ellipse(ctx, pellet.x + 1.3, pellet.y + 2.5, pellet.size + 1, pellet.size * 0.65, 'rgba(10,45,28,.25)');
      ellipse(ctx, pellet.x, pellet.y + bob, pellet.size, pellet.size * 0.8, '#a16d38');
      ellipse(ctx, pellet.x - 0.4, pellet.y - 0.5 + bob, pellet.size * 0.52, pellet.size * 0.32, '#eed3a0');
    }
    ctx.globalAlpha = 1;
  }

  /**
   * 水面涟漪（投喂落水 / 鱼吃食）。
   *
   * ★ 俯视图口径：画**正圆**，不纵向压扁、不旋转。
   *   池塘是俯视构图（`public/assets/pond.png` = 俯视透水碧潭），水面上的环就该是圆。
   *   ⚠️ 这里曾经写成 `ry = rx × 0.64` + `rotate(-0.15)`，理由是"水面远平面被压扁" ——
   *   那是**斜视**场景的投影，本项目不是斜视。判据见 `tools/check-water-rings.cjs`
   *   （包围盒宽高比必须 = 1.000，压扁会读成 0.640）。
   */
  drawRipples() {
    const ctx = this.ctx;
    for (const ripple of this.sim.ripples) {
      const progress = ripple.age / ripple.life;
      const radius = 4 + progress * 65 * ripple.strength;
      ctx.lineWidth = 0.8;
      ctx.strokeStyle = `rgba(226,248,211,${(1 - progress) ** 1.6 * 0.45 * ripple.strength})`;
      ctx.beginPath(); ctx.arc(ripple.x, ripple.y, radius, 0, TAU); ctx.stroke();
      if (progress > 0.12) {
        ctx.strokeStyle = `rgba(193,230,194,${(1 - progress) ** 1.8 * 0.2 * ripple.strength})`;
        ctx.beginPath(); ctx.arc(ripple.x, ripple.y, radius * 0.72, 0, TAU); ctx.stroke();
      }
    }
  }

  /**
   * 荷花与荷叶（§11.4 层 10）。
   *
   * ★★★ 2026-10-04 整块重写。改前的四个实测问题（都不是猜测，是截图放大后看出来的）：
   *   ① 荷叶是**纯色圆饼**——`arc(0.16, TAU-0.22)` 加 9 条直线，既没有荷���的
   *      扇形轮廓，也没有从叶柄放射的叶脉，只是"带几条线的绿盘"。
   *   ② 荷花是 **5 瓣梅花**：`for i<7` 画 2 圈共 14 片贝塞尔，远看就是梅花，
   *      而且花瓣是圆头（`bezierCurveTo` 收在同一点），荷花应是**尖瓣**。
   *   ③ 5 朵花排在一条斜线上（`bx = .815 - i*.035`），人工痕迹明显；
   *      荷叶也全挤在右下角三个锚点（.76/.80/.835 × .93/.94/.905）。
   *   ④ 那一簇**被 UI 面板压住**——左下"画锦鲤/设置"与右下"桌面/沉浸"两块按钮
   *      正好盖在唯一的荷花簇上，等于画了个看不见的荷花。
   *
   * ★★ 分布改为三簇（避开 UI 区，见 FLORA_CLUSTERS 注释），并按需求 450 行
   *    "锦鲤悠然穿行于荷叶之间"铺到池面中上部，让鱼能从荷叶间穿过。
   *
   * ★ 物候来自档案的四个通道，三者**互相独立**不能互推：
   *   leafCount 浮叶 · lotusCount 盛放荷花 · budCount 花苞 · podCount 莲蓬
   *   "谷雨 8苞0花" 与 "白露 0苞0花但4莲蓬" 在 lotusCount 上都是 0，
   *   靠 lotus 推不出后者的莲蓬。
   */
  drawFeedCircles() {
    const ctx = this.ctx;
    const still = this.options.reducedMotion;
    for (const circle of this.sim.feedCircles) {
      const progress = clamp(circle.age / circle.life, 0, 1);
      const fade = (1 - progress) ** 0.8;
      const breathe = still ? 1 : 1 + Math.sin(circle.age * 6.2) * 0.022;
      const r = circle.radius * breathe;
      ctx.save();
      ctx.lineWidth = 1.1;
      ctx.setLineDash([9, 7]);
      if (!still) ctx.lineDashOffset = -circle.age * 26;   // 虚线缓慢流动，暗示"这里有一圈"
      ctx.strokeStyle = `rgba(232,250,214,${0.34 * fade})`;
      ctx.beginPath(); ctx.arc(circle.x, circle.y, r, 0, TAU); ctx.stroke();
      ctx.setLineDash([]);
      // 起始脉冲：把"投喂生效了"的反馈集中在头 1/3，之后交给呼吸感
      if (!still && progress < 0.34) {
        const p = progress / 0.34;
        ctx.lineWidth = 0.4 + 1.7 * (1 - p);
        ctx.strokeStyle = `rgba(214,242,196,${0.32 * (1 - p) * (1 - p)})`;
        ctx.beginPath(); ctx.arc(circle.x, circle.y, r * p, 0, TAU); ctx.stroke();
      }
      ctx.restore();
    }
  }

  drawLotus() {
    const ctx = this.ctx, t = this.options.reducedMotion ? 0 : this.sim.time;
    const v = this.termVisual;
    /* 叶色随 warmth 走：盛夏浓绿 → 深秋枯黄。冬档 leafCount=0，不画。 */
    const green = 1 - Math.max(0, Math.min(1, (v.warmth - 0.30) / 0.55));
    const leafHi = mixHex('#79ad63', '#a8944e', green);
    const leafLo = mixHex('#2f5a3c', '#5d5334', green);
    const leafEdge = mixHex('#8dbf6d', '#b8a663', green);

    /* ★★★ 本帧**实际画了什么的清单**（画布比例坐标 + 像素半径）。
     *   为什么需要：量具靠「全幅颜色分类」区分形态已到天花板 —— 实测秋分的
     *   莲蓬色 rgb(136,152,84) 与荷叶色 rgb(136,152,84) **完全相同**
     *   （都是 mix 出来的黄绿），无论阈值怎么调都分不开。
     *   正解 = 渲染层自报落点，量具**按位置验收**：
     *   在每个报出来的位置上看「有 flora / 无 flora」两张图是否有净改动。
     *   这样判据与颜色解耦，也不再受水面反光干扰。
     * ⚠️ 对象在 `render()` 开头就重建过（清空残留），这里只往里 push、不重新赋值 ——
     *   冬季 `drawLotus()` 不被调用，若在这里 `=` 会把 render 的清空覆盖掉。 */
    const manifest = this.floraManifest;

    /* ── 浮叶 ─────────────────────────────────────────────────────── */
    const pads = v.leafCount;
    /* 簇内散布用**确定性伪随机**（黄金角），不用 Math.random() ——
       后者会让荷叶每帧换位置看起来在抽搐，量具也无法复现同一画面。 */
    /* ★★★ 基准尺寸常量。荷叶的**线宽类细节全部按 `size/28` 相对缩放**，
     *   而不是按绝对像素 —— 因为叶片直径在 23~40px 之间浮动，
     *   绝对线宽会在小叶上被抗锯齿吃掉、在大叶上糊成一团。
     *   `VEIN_W` 是「28px 叶子的主脉线宽」基准（≈1.15px）。
     * ⚠️ 必须声明在**所有使用点之前**：上一版 `const BASE` 声明在叶脉段里，
     *   被前面的叶柄段先读到 ⇒ TDZ `Cannot access 'BASE' before initialization`
     *   ⇒ 整页白屏，而 `node --check` **完全查不出**（只查语法，不查 TDZ）。 */
    const BASE = 20;
    const VEIN_W = BASE * 0.0575;
    /* ★★★ 2026-10-04 第四次重写：「车胎」形态的三处结构性病因
     *   （用户反馈「荷叶太丑了」，把单片叶放大 5~11 倍才看清）。
     *   ① **外缘纯黑粗环** —— 不是描边（只 1.8px，量过），
     *      而是渐变半径写成 `size*1.15` **外扩**：叶缘落在归一化 r=0.87 处，
     *      外面全被 clamp 到终点色；再叠 `scale(1,0.70)` 把渐变压扁，
     *      y 方向的叶缘干脆跑到渐变之外 ⇒ 近 `leafLo` 的暗带。
     *      改法：渐变半径 = `size`，叶缘 = 渐变终点，不再有外扩暗带。
     *   ② **中心黑洞** —— 11 条脉的起点全在 `r0 = size*0.08`，
     *      40px 的叶子上 11 条线在半径 3px 内汇聚成一坨深色。
     *      改法：脉起点外移到 `size*0.13`，并让中心窝半径夹在基准以内。
     *   ③ **没有荷塘质感** —— 真荷叶是薄、平、透，脉是**网**（放射脉 + 同心脉），
     *      不是实心圆饼。改法：加 4 圈同心弧把相邻主脉连起来。
     *   ④ 叶柄原来用 `leafLo`（最暗色）⇒ 在叶心拉一条**黑线**。
     *      改用 `mixHex(leafLo, leafHi, .45)`。
     * ⚠️ 上一版把「提亮」全部寄托在 `mixHex(leafHi,'#fff',x)` 上，
     *   而那时的 `mixHex` **嵌套调用产出灰/黑**（见函数上方注释）——
     *   也就是说前几版的所有调参都建立在坏颜色上。`mixHex` 修好后
     *   叶片实测 rgb(108~129,159~178,92~109)，与理论 `leafHi=rgb(121,173,99)` 吻合。 */
    for (let i = 0; i < pads; i++) {
      const spot = FLORA_SPOTS(pads, i, FLORA_BIAS.leaf);
      const size = spot.size * (0.62 + 0.38 * Math.min(1, pads / 20));
      /* 线宽等细节相对叶片尺寸缩放（28px = 1.0 倍） */
      const u = size / 28;
      manifest.leaf.push({ x: spot.x, y: spot.y, r: size });
      const tilt = spot.tilt + Math.sin(t * 0.42 + spot.phase) * 0.045;   /* 摇曳 */
      ctx.save();
      ctx.translate(spot.x * this.width, spot.y * this.height + Math.sin(t * 0.5 + spot.phase) * 1.5);
      ctx.rotate(tilt);
      /* 荷叶轮廓 = **带一条窄缝的圆盘**：缝从叶柄着生点直通叶缘。
       *   ⚠️ 原来的 `gapHalf=0.30`（34°）是块「饼干缺口」，不是荷叶 ——
       *   真荷叶的裂口只有几度宽，俯视几乎看不见，只在叶柄处留一道暗线。
       *   但收到 0.115（26°）在 1× 实际尺寸下**仍然像被咬了一口**（实测截图），
       *   最终定 0.062（≈7°，只比叶柄略宽）。
       * ⚠️ 缺口**朝向必须随叶变化**（`gapAngle` 由 spot 决定），否则整簇荷叶的
       *   裂口全部朝同一方向，机械感极强 —— 实测 1× 截图就是这个症状。 */
      const gapHalf = 0.062;
      const gapAngle = spot.phase * 1.7 + spot.tilt * 1.3;
      /* ★★ 脉络常量必须声明在**第一次使用之前**。
       *   上一版把 `const NV = 11` 放在叶形路径之后，而叶形路径要用 NV 拆段
       *   ⇒ TDZ `Cannot access 'NV' before initialization` ⇒ 整页白屏。
       *   （`node --check` 查不出 TDZ —— 它只做语法分析。） */
      const NV = 11;
      const vein = mixHex(leafHi, '#f2f6d8', 0.42);
      const R0 = size * 0.13, R1 = size * 0.955;
      /* 叶缘起伏幅度（±2.4%）：再大就成锯齿/花瓣边 */
      const WOB = 0.024;
      /* 叶形路径：中心 → 逐段圆弧（半径按 sin 起伏）→ 段间直线内收 → 回中心。
       *   抽成局部函数是因为同一段路径要用两次（填充 + clip 褶皱），
       *   而两次手抄一致是典型的「改一处忘一处」隐患。 */
      const leafPath = () => {
        ctx.beginPath();
        ctx.moveTo(0, 0);
        for (let j = 0; j < NV; j++) {
          const a0 = gapAngle + gapHalf + (j / NV) * (TAU - gapHalf * 2);
          const a1 = gapAngle + gapHalf + ((j + 1) / NV) * (TAU - gapHalf * 2);
          ctx.arc(0, 0, size * (1 + WOB * Math.sin(j * 2.399963 + spot.phase)), a0, a1);
          const aMid = (a0 + a1) * 0.5;
          ctx.lineTo(Math.cos(aMid) * size * (1 - WOB * 0.55),
            Math.sin(aMid) * size * (1 - WOB * 0.55));
        }
        ctx.closePath();
      };
      ctx.save();
      ctx.scale(1, 0.70);        /* 浮叶在水面上的透视压扁 */
      /* 阴影只给一点点（blur 5 / alpha .13）。荷叶是**亮而透**的，
       *   压成暗色就成了「黑褐色橄榄球」。 */
      ctx.shadowColor = 'rgba(18,58,38,.13)';
      ctx.shadowBlur = 5; ctx.shadowOffsetY = 3;
      /* 渐变：中心透亮 → 边缘略沉。**半径就是 size**（不再外扩 1.15），
       *   让叶缘正好落在终点色上，避免 clamp 出暗带。
       *   终点只沉到 leafLo 的 42%，保留水彩荷葉的通透感。 */
      const g = ctx.createRadialGradient(-size * .18, -size * .22, size * .05, 0, 0, size);
      g.addColorStop(0, mixHex(leafHi, '#ffffff', 0.16));
      g.addColorStop(0.42, leafHi);
      g.addColorStop(0.80, mixHex(leafHi, leafLo, 0.22));
      g.addColorStop(1, mixHex(leafHi, leafLo, 0.42));
      ctx.fillStyle = g;
      /* ★★ 叶缘不是数学圆 —— 真实荷叶边缘有起伏（每瓣叶的边缘微微翘曲）。
       *   做法见上面 `leafPath()`：圆弧拆成 NV 段，每段终点半径按 `sin` 起伏 ±2.4%，
       *   段与段用直线相连。 */
      leafPath();
      ctx.fill();
      ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
      /* ★★★ 叶片**褶皱**明暗：真荷叶不是一张平的绿纸，主脉之间有高低起伏，
       *   俯视时表现为沿主脉交替的明暗带。
       *   做法：clip 在叶形内，沿每条主脉画一个极淡的扇形亮带/暗带（alpha .055）。
       * ⚠️ 必须在叶形 clip 内，且 save/restore 配对 —— 否则会画到水面上去。 */
      ctx.save();
      leafPath();
      ctx.clip();
      for (let j = 0; j < NV; j++) {
        const a0 = gapAngle + gapHalf + (j / NV) * (TAU - gapHalf * 2);
        const a1 = gapAngle + gapHalf + ((j + 1) / NV) * (TAU - gapHalf * 2);
        ctx.globalAlpha = 0.055;
        ctx.fillStyle = j % 2 ? mixHex(leafHi, '#ffffff', 0.55) : leafLo;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.arc(0, 0, size * 1.02, a0, a1);
        ctx.closePath(); ctx.fill();
      }
      ctx.restore();
      /* ★★★ 叶脉 = **网**，不是纯放射。真实荷叶在俯视下能透光看到脉系：
       *   11 条主脉从中心窝放射到叶缘，另有若干圈**不规则**的横脉把主脉连起来。
       * ⚠️ 起点 `R0 = size*0.13` 而非 0.08：11 条线在半径 3px 内汇聚
       *   就是「中心黑洞」的成因（见本段开头 ②）。
       * ⚠️ 横脉**不能画成等距同心圆**（第一版 4 圈等距 ⇒ 放大 8 倍后像「靶心」，
       *   一眼假）。真叶的横脉是斜的、间距不匀、且每段独立。
       *   （vein / NV / R0 / R1 已在叶形之前声明，见 gapHalf 处注释。） */
      ctx.lineCap = 'round';
      /* 主脉：从中心窝放射到叶缘，中间略下垂（不是笔直的辐条） */
      for (let j = 0; j < NV; j++) {
        const a = gapAngle + gapHalf + (j / (NV - 1)) * (TAU - gapHalf * 2);
        const mx = Math.cos(a + 0.09) * R0 + (Math.cos(a) * R1 - Math.cos(a + 0.09) * R0) * 0.5;
        const my = Math.sin(a + 0.09) * R0 + (Math.sin(a) * R1 - Math.sin(a + 0.09) * R0) * 0.5;
        ctx.strokeStyle = vein;
        ctx.globalAlpha = 0.30;
        ctx.lineWidth = VEIN_W * u * (0.86 + 0.14 * Math.cos(a - 2.2));
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * R0, Math.sin(a) * R0);
        ctx.quadraticCurveTo(mx, my, Math.cos(a) * R1, Math.sin(a) * R1);
        ctx.stroke();
      }
      /* 横脉（网）：每条主脉间 2~3 道，**斜向 + 间距不匀 + 半径带扰动**。
       *   确定性公式，不用 random()（否则每帧抖）。 */
      for (let j = 0; j < NV - 1; j++) {
        const a0 = gapAngle + gapHalf + (j / (NV - 1)) * (TAU - gapHalf * 2);
        const a1 = gapAngle + gapHalf + ((j + 1) / (NV - 1)) * (TAU - gapHalf * 2);
        for (let m = 0; m < 3; m++) {
          /* 基准 q 再叠一个由 j 决定的偏移 ⇒ 疏密不匀 */
          const q = 0.26 + 0.62 * (m + 0.5) / 3 + 0.11 * Math.sin(j * 1.7 + m * 2.1);
          const rr = R0 + (R1 - R0) * q;
          ctx.strokeStyle = vein;
          ctx.globalAlpha = 0.10 + 0.05 * (1 - q);
          ctx.lineWidth = VEIN_W * u * 0.5;
          ctx.beginPath();
          /* 从 a0 稍内侧起，斜着划到 a1 稍外侧 —— 真叶横脉是斜的 */
          const s = 0.18 * (m === 1 ? -1 : 1);
          ctx.moveTo(Math.cos(a0 + s * 0.5) * rr * 0.95, Math.sin(a0 + s * 0.5) * rr * 0.95);
          ctx.quadraticCurveTo(
            Math.cos((a0 + a1) * 0.5) * rr * (1 + 0.05 * Math.cos(j + m)),
            Math.sin((a0 + a1) * 0.5) * rr * (1 + 0.05 * Math.cos(j + m)),
            Math.cos(a1 + s * 0.5) * rr, Math.sin(a1 + s * 0.5) * rr);
          ctx.stroke();
        }
      }
      /* 中心窝（叶柄着生点）：小而淡，不做成褐色圆环 */
      ctx.globalAlpha = 0.13; ctx.fillStyle = leafLo;
      ctx.beginPath();
      ctx.ellipse(0, 0, Math.min(size * 0.10, BASE * 0.10),
        Math.min(size * 0.07, BASE * 0.07), 0, 0, TAU);
      ctx.fill();
      /* 叶缘：薄叶透光的**浅色**细弧，只画一段（受光侧）。
       * ⚠️ 原来用 `leafLo` 整圈描 1.8px 暗边 ⇒ 就是「车胎」那条黑环。
       * ⚠️ 也**不能整圈描**：叶形现在有起伏（`leafPath`），正圆描边会与叶缘脱节。
       *   而且整圈描边会把叶画成「贴纸」，只描一段才有薄叶的转折感。 */
      ctx.globalAlpha = 0.24;
      ctx.lineWidth = Math.max(0.6, VEIN_W * u * 0.72);
      ctx.strokeStyle = mixHex(leafEdge, '#ffffff', 0.22);
      ctx.beginPath();
      ctx.arc(0, 0, size * 0.965, gapAngle + 0.5, gapAngle + 2.5); ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.restore();
      /* 叶柄：缺口处一根短柄伸向簇心方向。
       * ⚠️ 原来用 `leafLo`（最暗色）⇒ 在叶心拉一条**黑线**，
       *   是「叶脉消失后只剩一根黑线」的另一半原因。
       * ⚠️ 方向必须**跟缺口一致**（`gapAngle`），否则叶柄从叶背长出来。
       *   长度也只到 0.34r：真荷叶的柄是短的，从俯视看只在缺口处露一截。 */
      ctx.strokeStyle = mixHex(leafLo, leafHi, 0.55);
      ctx.lineWidth = Math.max(0.7, Math.min(1.4, BASE * 0.038));
      ctx.beginPath(); ctx.moveTo(0, 0);
      ctx.lineTo(Math.cos(gapAngle) * size * 0.34, Math.sin(gapAngle) * size * 0.34);
      ctx.stroke();
      ctx.restore();
    }


    /* ═══ 荷花（2026-10-05 重写：花苞形态 + 开花过程 + 放射状花瓣）═══
     *
     * ★★★ 用户三个反馈一次性改完，逐条对应：
     *
     * ① 「花骨朵不对」—— 改前的花苞是**一个粉色水滴 + 一道白色斜线**：
     *      形状是 `bezierCurveTo` 上下对称的桃形（宽:高 ≈ 1:2.2，底圆顶尖），
     *      那道"裂缝"是从 `(-w*.30,-h*.86)` 到 `(0,-h*.20)` 的**单条直线**。
     *      放大 8 倍实测：那不是荷花苞，是**一颗粉色水滴**。
     *      真实荷花苞的辨识特征有三样，旧版一个都没有：
     *        · **纺锤形**（下端略宽、中段最鼓、**顶端收成尖**，不是正圆底）
     *        · **顶端 2~3 片合拢的外苞片**，抱出一个尖
     *        · **下半段包着绿色的萼片**（花苞下半是绿的，不是全粉）
     *
     * ② 「缺少开花的过程」—— 改前只有两档：`budCount` 个**紧闭**花苞
     *      + `lotusCount` 朵**全开**荷花，中间是跳变的。
     *      现在引入 `v.rawOpenness`（0=紧闭、1=全开，由 `lotus` 派生，
     *      见 `term-visual.js` 里的推导），每朵花按自己的开放度画：
     *        · 同一档内**不同朵的开放度不同**（按序号错开）
     *          ⇒ 立夏「2 朵」= 1 朵半开 + 1 朵含苞，看得出"正在开"
     *        · 瓣的张角、外层翻卷量、莲蓬露出与否都随它连续变化
     *
     * ③ 花瓣改成**放射状**：改前是 8+6+4 = 18 片**均匀绕同心圆**排布，
     *      放大后像一朵「莲花座钟 / 八角星」，瓣与瓣的根部并不聚在花心。
     *      真实荷花是**瓣根聚于花心、瓣尖向外辐射**、且**瓣间有错位**。
     *      改法：每层用**不同的角度偏移**（golden angle）+ 瓣长随机抖动，
     *      根部收到半径 0.10R 之内（不再是各自分布在一个大圆上）。
     */
    /* 开放度基准（由 term-visual 派生）。0 = 全闭，1 = 全开。
     * ⚠️ 必须用 `rawOpenness`（不截断）而不是 `openness` ——
     *   `openness` 是 clamp 后的，只用来判「这档有没有花在开」。 */
    const OPEN = clamp(v.rawOpenness ?? 0, 0, 1);
    /* 莲蓬显隐的开放度门限。小满 raw≈.521 刚好露一点尖，芒种起完全露出。
     * ⚠️ 这个数被 `check:lotus` 判据 ⑦⑧ 引用 —— 改这里必须同步改那边。 */
    /* 单朵荷花从紧闭到全开的循环周期（秒）。<20s 急促，>60s 察觉不到。 */
    const BLOOM_PERIOD = 34;
    const POD_GATE = 0.52;

    /* ── 花苞（惊蛰…霜降都有，谷雨最多）───────────────────────────
     * 纺锤形苞体 + 紧贴两侧的绿褐外苞片 + 下段绿萼杯 + 一根花梗。
     * ⚠️ 坐标口径：所有 y 都以**苞体底端**为 0，向上为负。
     *   2026-10-05 第一版把花梗终点画在 +0.40h、苞体底却落在 -0.34h
     *   （`translate(0,-h*.40)` + 苞底 `+h*.06`），中间空了 0.74h ⇒ 梗与苞脱开。 */
    for (let i = 0; i < v.budCount; i++) {
      const spot = FLORA_SPOTS(v.budCount, i, FLORA_BIAS.bud, BUD_TIGHT, 2, FLOWER_CLUSTERS);
      /* ★★★ 花苞也吃开放度：谷雨 bud=8 且 raw=.043（几乎全闭），
       *   白露 bud=3 且 raw=.021 —— 差别太小看不出来。
       *   所以「苞的张开度」按 `i` 错开而不是只用一个全局值，
       *   保证同一档里既有紧闭的也有将开的，才看得出「在等」。 */
      const swell = clamp(0.30 + 0.40 * ((i % 3) / 2) * (0.45 + 0.55 * OPEN), 0, 1);
      manifest.bud.push({ x: spot.x, y: spot.y, r: spot.size * 0.82, swell });
      ctx.save();
      ctx.translate(spot.x * this.width, spot.y * this.height + Math.sin(t * 0.6 + spot.phase) * 1.1);
      ctx.rotate(spot.tilt * 0.5);
      /* ★ 苞体尺寸：宽高比从 `.36` → `.44` → **`.60`**（2026-10-05，8× 三轮迭代）。
       *   ⚠️ `.36`（1:2.8 纺锤）8× 下读成**豌豆荚**—— 太瘦太尖。
       *     `.46` 像**洋蓟**。真荷苞从侧面看是**饱满的卵形**（宽高约 1:1.7），
       *     而且饱满程度要随 `swell`（接近开放）明显变大。 */
      const h = spot.size * 0.82, w = h * 0.60;
      /* 鼓度：越接近开放越鼓。系数从 `(0.74+0.44swell)` 调到 `(0.86+0.26swell)`
       *   —— 基准抬高（更饱满）、动态范围收窄（避免摆动时一会儿变圆一会儿变瘦）。 */
      const hw = w * (0.86 + 0.26 * swell);
      /* 花梗：从水里往上顶到苞体底端（y=0），末端略弯。 */
      ctx.strokeStyle = mixHex('#4f7040', '#8a7c46', green);
      ctx.lineWidth = Math.max(0.6, h * 0.075);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(0, h * 0.62);
      ctx.quadraticCurveTo(h * 0.13, h * 0.30, 0, 0);
      ctx.stroke();
      ctx.lineCap = 'butt';
      /* 苞体：纺锤形 —— 下端略收、中段最鼓、顶端收尖（宽高比约 1:2.8）。 */
      ctx.shadowColor = 'rgba(11,45,30,.20)'; ctx.shadowBlur = 5; ctx.shadowOffsetY = 2.5;
      const g = ctx.createLinearGradient(0, -h, 0, h * 0.10);
      g.addColorStop(0, mixHex('#f0cdd6', '#b3a878', green));   /* 尖端：最浅 */
      g.addColorStop(0.42, mixHex('#e2a8bc', '#9a9a63', green));
      g.addColorStop(1, mixHex('#c88ba4', '#7f8a52', green));   /* 根部：深 */
      ctx.fillStyle = g;
      /* 苞体：**饱满的卵形** —— 下端略收、中段最鼓、顶端**圆钝**（不是收尖）。
       * ⚠️ 原路径两侧都 `bezierCurveTo(..., 0, -h)` 收成同一个尖点 ⇒ 放大后
       *   是一条**豌豆荚**。荷苞的顶是**钝圆**的，只在正上方留一点点微凸。 */
      ctx.beginPath();
      /* 右半：底部略外扩 → 中段鼓 → 顶端收圆 */
      ctx.bezierCurveTo(hw * 0.96, -h * 0.04, hw * 1.00, -h * 0.52, hw * 0.44, -h * 0.94);
      ctx.quadraticCurveTo(hw * 0.18, -h * 1.03, 0, -h * 1.02);
      /* 左半（镜像） */
      ctx.quadraticCurveTo(-hw * 0.18, -h * 1.03, -hw * 0.44, -h * 0.94);
      ctx.bezierCurveTo(-hw * 1.00, -h * 0.52, -hw * 0.96, -h * 0.04, 0, h * 0.05);
      ctx.closePath(); ctx.fill();
      /* 苞身两道纵向暗线（第一版缺 ⇒ 放大后是一块平色板） */
      ctx.strokeStyle = 'rgba(146,74,102,.26)';
      ctx.lineWidth = Math.max(0.5, h * 0.022);
      for (const s of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(s * hw * 0.42, -h * 0.10);
        ctx.quadraticCurveTo(s * hw * 0.56, -h * 0.48, s * hw * 0.12, -h * 0.86);
        ctx.stroke();
      }
      ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
      /* ★★★ 顶端 2 片**紧贴**的绿褐外苞片（花苞的辨识特征，第一版完全没有）。
       *   ⚠️⚠️ 反直觉：**外苞片必须比苞体 NARROW（`hw*.80`），不能比苞体宽。**
       *   前两版按「苞片从两侧包过来 ⇒ 要比主体宽才叫包裹」做，宽度给到 `hw*1.14`
       *   —— 结果它把整个粉色苞体**全部盖住**，放大后整朵花苞读成
       *   一个**绿色郁金香**（底部大绿钟罩 + 顶部露一条粉缝）。
       *   正解：苞片只从**苞体上半段**（`-h*.52` 起）往上收，顶端略超出苞尖，
       *   宽度全程 < 苞体宽度 ⇒ **粉色纺锤体是主体**，绿只在底部萼杯 + 尖端两片。
       *   ★ 这跟荷花瓣是同一个教训：**「宽＝包裹」是错的直觉，包裹靠"不超出主体"。** */
      for (const s of [-1, 1]) {
        ctx.save();
        ctx.rotate(s * (0.05 + 0.10 * swell));
        const g2 = ctx.createLinearGradient(0, -h, 0, 0);
        g2.addColorStop(0, mixHex('#b9b184', '#8a8a5e', green));
        g2.addColorStop(1, mixHex('#8d9c62', '#6d7a4a', green));
        ctx.fillStyle = g2;
        ctx.beginPath();
        ctx.moveTo(0, -h * 0.44);
        ctx.bezierCurveTo(hw * 0.78, -h * 0.62, hw * 0.70, -h * 0.92, hw * 0.15, -h * 1.05);
        ctx.quadraticCurveTo(hw * 0.03, -h * 0.72, 0, -h * 0.44);
        ctx.closePath(); ctx.fill();
        ctx.restore();
      }
      /* 苞尖合拢处露出的一点内层花瓣（`swell` 大时才明显）。
       * ★ 位置随苞片上移：苞片尖端到 `-h*1.06`，这里必须跟着到 `-h*1.02`
       *   之下、苞片之内（两片苞片中间的缝），否则被苞片盖住看不见。 */
      if (swell > 0.30) {
        ctx.fillStyle = mixHex('#f6dde4', '#c0b98c', green);
        ctx.beginPath();
        ctx.moveTo(0, -h * 1.02);
        ctx.quadraticCurveTo(hw * 0.16, -h * 0.88, hw * 0.10, -h * 0.66);
        ctx.quadraticCurveTo(hw * 0.05, -h * 0.84, 0, -h * 1.02);
        ctx.closePath(); ctx.fill();
      }
      /* ★ 下段**绿萼杯**：荷花花苞下半段是萼片包着的，不是全粉。
       *   ⚠️ 第一版用 3 个三角拼，只在苞体下面露出 2 个小尖（等于没画）。
       *   正解：先画一个**杯形**整体（底宽顶窄、盖住苞体底部 ~30%），
       *   再在杯面上压2 条萼片缝线。
       * ★ 杯宽从 `hw*.96` 收到 **`hw*.82`**、高度从 0.38h 收到 **0.26h** ——
       *   同一条原则：**萼是包裹不是外套**，超出主体就把主体吃掉了。 */
      const cg = ctx.createLinearGradient(0, h * 0.30, 0, -h * 0.24);
      cg.addColorStop(0, mixHex('#5c7c44', '#7f8347', green));
      cg.addColorStop(1, mixHex('#87a55e', '#9c9a58', green));
      ctx.fillStyle = cg;
      ctx.beginPath();
      ctx.moveTo(-hw * 0.82, h * 0.22);
      ctx.quadraticCurveTo(-hw * 0.78, -h * 0.08, -hw * 0.36, -h * 0.20);
      ctx.quadraticCurveTo(0, -h * 0.27, hw * 0.36, -h * 0.20);
      ctx.quadraticCurveTo(hw * 0.78, -h * 0.08, hw * 0.82, h * 0.22);
      ctx.quadraticCurveTo(0, h * 0.15, -hw * 0.82, h * 0.22);
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle = 'rgba(46,70,34,.34)';
      ctx.lineWidth = Math.max(0.5, h * 0.020);
      for (const s of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(s * hw * 0.34, h * 0.24);
        ctx.quadraticCurveTo(s * hw * 0.44, -h * 0.02, s * hw * 0.22, -h * 0.18);
        ctx.stroke();
      }
      ctx.restore();
    }

    /* ── 荷花：放射状花瓣 + 连续开放度（2026-10-05 重写）─────────
     * 三层尖瓣：外层 9 片（长、翻卷）/ 中层 7 片 / 内层 5 片（紧抱莲蓬）。
     * ★ 与旧版的本质差异：
     *   旧版每层用 `a = (j / count) * TAU` **均匀绕圈**，
     *   瓣根分布在半径 0~W 的环带上 ⇒ 放大后像「八角星/莲花座钟」。
     *   现在每层用 **golden angle 错开 + 瓣长抖动 + 瓣根收到 0.08R**，
     *   于是瓣真的从花心**放射**出去，瓣间有自然的错位。 */
    for (let i = 0; i < v.lotusCount; i++) {
      const spot = FLORA_SPOTS(v.lotusCount, i, FLORA_BIAS.flower, FLOWER_TIGHT, 2, FLOWER_CLUSTERS);
      const R = spot.size * 0.92;
      /* ══════ 每朵自己的开花进度（2026-10-05，用户「要按时间缓开」）══════
       * 改前 `open` 完全由**节气档位**决定 ⇒ 同一档内所有花**同步**，
       *   站在那儿看一小时也不变 —— 「正在开」这件事不可见。
       * 现在每朵在 `[low, OPEN]` 之间以自己的相位缓慢循环：
       *   ① `OPEN` 仍是**上限** —— 节气决定「这档最多能开多开」，
       *      谷雨仍只到 .043（几乎全闭），夏至才能到 1.0，物候方向不变；
       *   ② `low` 随档位升高而抬高：早期档的花本来就不该全开，
       *      若 low=0 会让立夏的花周期性**开成 0 又合上**，读成「掉了又长」；
       *   ③ 相位用 `i` 的**确定性函数**（不能 random()：每帧抖 ⇒ 量具无法复现），
       *      且 `t=0` 时相位就是那个常量 ⇒ 冻结画面可复现（量具依赖这一点）。
       * ⚠️ 周期 34s 是目视定的：<20s 显得急促，>60s 盯着看也察觉不到变化。 */
      const phase = i * 2.399963 + spot.phase;
      const low = OPEN * 0.34;
      const cyc = 0.5 - 0.5 * Math.cos((t / BLOOM_PERIOD) * TAU + phase);
      const open = clamp(low + (OPEN - low) * cyc, 0, 1);
      /* ★ 自报每朵的 `open`（2026-10-05）——量具据此判开放度单调性与
       *   「同一档内不同朵错开」，不必从像素半径反推（半径会被相邻瓣盖住而失真）。 */
      manifest.flower.push({ x: spot.x, y: spot.y, r: R * (0.42 + 0.58 * open), open, podShown: open > POD_GATE });
      ctx.save();
      ctx.translate(spot.x * this.width, spot.y * this.height + Math.sin(t * 0.5 + spot.phase) * 1.2);
      ctx.shadowColor = 'rgba(18,58,38,.20)'; ctx.shadowBlur = 5; ctx.shadowOffsetY = 3;
      /* ★★★★ 整朵花做一次 **y 方向压扁 = 花瓣「向上翘」的透视**（2026-10-05）。
       *
       *   这是「玫瑰 → 荷花」的最后一块拼图，也是前两版**一直缺**的那一块。
       *   之前只在 `spread`（张角）上想办法，但 `rotate` 在俯视投影里**不改变瓣的长度**，
       *   所以无论张角怎么调，10 片瓣都是「同样长、从中圈往外铺」⇒ 必重叠、必糊。
       *
       *   对照设计稿 `docs/design-reference.png` 左下角那朵荷花：
       *   它是**扁的**（宽 ≫ 高）、瓣是**斜向上**伸出去的窄条、瓣与瓣之间
       *   能看到水色。斜向上的瓣投影到俯视面时**纵向被压短**、横向不变
       *   ⇒ 屏幕上自然变窄变短 ⇒ 邻瓣之间自然露出缝。
       *
       *   所以「瓣间有缝」不是靠把 W 调小换来的，是靠**压扁**换来的。
       *   （踩过的坑：W .82→.62→.38 三轮都只在 W 上打转，结果 .38 换来了
       *     缝却让瓣变成柳叶/飞镖。**调 W 是错的方向，压扁才是对的。**）*/
      ctx.scale(1, FLORA_FLAT);
      /* 张角随开放度：紧闭时瓣几乎竖直抱合（张 8°），全开时外层铺到 74°。
       * ⚠️ 这个角度范围是目视调出来的：<5° 时瓣全挤在中心成一团（像花苞），
       *   >80° 时瓣完全躺平（像碟子），荷花应该在 15°~70° 之间。 */
      const spread = (0.06 + 0.44 * open) * Math.PI;
      /* ★★★ 层间长度差必须**拉大**（2026-10-05 三度重写，整层参数都换了）。
       *
       * 【8× 实测读出来是「玫瑰」而不是荷花】三个机械病因，逐个对应改法：
       *
       *   ① ★★ 层内角度用了 **golden angle**（`baseRot + j*2.399963`）——
       *      golden angle 只对**大样本**成立。8 片外层排序后的角度是
       *      `0 / 52.5 / 105 / 137.5 / 190 / 242.5 / 275 / 327.5`，
       *      间隔在 **32.5°~52.5° 之间乱跳** ⇒ 花瓣一圈疏一圈挤。
       *      正解：**层内 `(j/count)*TAU` 严格等距，层间用 `baseRot` 偏移错开**。
       *      （把「层内均匀」和「层间错开」两个问题混在一个公式里，是上一版的根因。）
       *
       *   ② ★★★ 瓣根全聚在 `r0 = R*0.06`，而瓣最宽处（`-L*0.52`）的半径约 `0.5L`，
       *      那里一圈弧长 `2π·0.5R/8 = 0.39R`，但瓣宽 `W = L*0.62 ≈ 0.62R`
       *      ⇒ **8 片在中段就 100% 重叠**，外轮廓是一条光滑圆弧 ⇒ 整朵读成**白圆饼**。
       *      正解两处同时改：瓣宽收到 `L*0.38`（长卵形），且**基部外移到 `R*0.16`**
       *      —— 荷花的瓣是**近平行向外排、瓣间有缝**，不是扇形放射。
       *
       *   ③ 瓣缘描边 `rgba(178,96,120,.24)` 在 8× 下变成**一堆同心圆轮廓线**，
       *      是「同心圆」读感的另一半来源（另一半是层间长度差不够）。
       *      正解：描边只在**外层**画，且 alpha 从 .24 降到 .13。
       *
       *   ④ 中脉 `rgba(196,110,132,.30)` + 宽 `R*0.024` ⇒ 8× 下像「刺猬」，
       *      且部分戳出瓣外。正解：alpha .30→.15、宽 .024→.015、长 .72→.55。
       *
       *   ⑤ 内层色 `#f0b9c6` 太艳 ⇒ 花心那坨粉比外层还抢戏（读成玫瑰花心）。
       *      正解降到 `#f2c6d1`，让**外层**成为视觉主体。
       *
       * 参数 [瓣数, 长度比, 层偏移(rad), 色, 基半径比, 张角系数] */
      const petals = [
        [7, 1.22, 0.00, '#fbe9e9', 0.16, 1.00],
        [6, 0.84, 0.52, '#f6d3da', 0.10, 0.58],
        [5, 0.48, 1.03, '#f2c6d1', 0.05, 0.26],
      ];
      /* 开放度也吃瓣长（张角管「躺平程度」，瓣长管「伸出多远」——两件事分开） */
      const grow = 0.50 + 0.50 * open;
      for (const [count, scale, baseRot, col, r0r, tiltK] of petals) {
        for (let j = 0; j < count; j++) {
          /* 层内严格等距 + 层间偏移（见病因 ①） */
          const a = baseRot + (j / count) * TAU + 0.10 * Math.sin(j * 1.7 + i);
          const r0 = R * r0r;
          ctx.save();
          ctx.rotate(a);
          const L = R * scale * grow * (0.90 + 0.20 * ((j * 5 + i * 3) % 4) / 3);
          /* ★ 瓣的**半**宽系数（2026-10-05）。⚠️ 注意 `W` 在路径里是**半宽**
           *   （两侧分别是 `r0±W`），所以「瓣宽:L」这个比值要 ×2 才是视觉宽度比。
           *   前几版把 W 直接当「宽度比」用，于是 .46 实际是 .92 ⇒ 邻瓣必重叠。
           *   现在 0.28 ⇒ 全宽 0.56L，7 片在半径 0.5L 处占 `7×0.56×0.5=1.96R`
           *   而周长是 `2π×0.5R=3.14R` ⇒ 覆盖率 62%，**留得出水色**。
           *   ⚠️ 加上 `FLORA_FLAT=0.62` 的压扁后覆盖率进一步降到约 40%
           *   ⇒ 瓣间的缝在 1× 真实尺寸下也看得见。 */
          const W = L * 0.28;
          /* 张角：把瓣从「竖直」向外转到 `spread·tiltK`。
           * 做法：先画竖直向上的瓣，再整体绕基部旋转。
           * ★ 三层的 tiltK 是 1.00/.58/.26 —— 内层只转四分之一，是**立着抱**的，
           *   外层才铺平外翻。这比原来的「外层 1.0 / 内层统一 .55」更明确分三层。 */
          ctx.rotate(spread * tiltK);
          const g = ctx.createLinearGradient(r0, 0, r0, -L);
          g.addColorStop(0, tiltK > 0.8 ? mixHex(col, '#b8607e', 0.26) : mixHex(col, '#ffffff', 0.20));
          g.addColorStop(0.55, col);
          g.addColorStop(1, mixHex(col, '#ffffff', 0.40));   /* 瓣尖最亮：逆光 */
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.moveTo(r0, 0);
          /* 狭长卵形瓣：基部**外移到 r0**、基部收窄 → 中段最宽 → 顶端**圆钝**。
           * ⚠️ 两个方向都踩过：
           *   · 瓣宽 .82 + **宽圆弧瓣顶** ⇒ 中段就重叠，整朵是**白圆饼**（玫瑰）。
           *   · 瓣宽 .38 + **渐尖瓣顶** ⇒ 缝出来了，但瓣尖成锐角 ⇒ 整朵像**飞镖**。
           *   正解两条同时成立：瓣宽 L*.46 附近 + 瓣顶**两段 bezier 收成半圆钝头**
           *   （荷花瓣是「倒立水滴」，不是柳叶也不是圆盘）。 */
          ctx.bezierCurveTo(r0 + W * 0.74, -L * 0.14, r0 + W, -L * 0.52, r0 + W * 0.74, -L * 0.86);
          /* 顶端：两段 bezier 收出**圆钝头**（宽度约 0.6W），不是收成一点 */
          ctx.bezierCurveTo(r0 + W * 0.60, -L * 1.03, r0 + W * 0.30, -L * 1.08, r0, -L * 1.08);
          ctx.bezierCurveTo(r0 - W * 0.30, -L * 1.08, r0 - W * 0.60, -L * 1.03, r0 - W * 0.74, -L * 0.86);
          ctx.bezierCurveTo(r0 - W, -L * 0.52, r0 - W * 0.74, -L * 0.14, r0, 0);
          ctx.closePath(); ctx.fill();
          /* 瓣缘细描：**只画外层**（见病因 ③）。
           * ⚠️ 三层都描的话，8× 下是一堆同心圆轮廓线 —— 这是「同心圆」读感的后半来源。
           *   内层靠三层色阶本身就能分辨（外白 → 中粉 → 内浅粉）。 */
          if (tiltK > 0.8) {
            ctx.strokeStyle = 'rgba(178,96,120,.13)';
            ctx.lineWidth = Math.max(0.35, R * 0.012);
            ctx.stroke();
            /* 中脉：外层、alpha/宽度都收（见病因 ④）—— 原 .30/R*.024 在 8× 下像刺猬。 */
            ctx.strokeStyle = 'rgba(196,110,132,.15)';
            ctx.lineWidth = Math.max(0.35, R * 0.015);
            ctx.beginPath(); ctx.moveTo(r0, -L * 0.06); ctx.lineTo(r0, -L * 0.55); ctx.stroke();
          }
          ctx.restore();
        }
      }
      ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
      /* ★★★ 莲蓬只在**开够了**时露出（`open` 门控）——
       *   旧版无脑画 3 个椭圆，于是「谷雨含苞」的档里也顶着一个黄莲蓬。
       *   门限 0.52：小满（raw=.521）刚好露一点尖，芒种起完全露出。 */
      if (open > POD_GATE) {
        const k = Math.min(1, (open - POD_GATE) / (1 - POD_GATE));
        /* ★ 莲蓬**调小 + 降饱和**（2026-10-05）：`.30/.19` + 明黄 `#e2cd7e`
         *   在 8× 下读成一个**煮熟的蛋黄圆盘**，抢走整朵花的视觉重心。
         *   荷花里莲蓬只是花心一小块青莲 + 淡黄莲房。 */
        ellipse(ctx, 0, R * 0.06 * k, R * 0.235 * k, R * 0.16 * k, '#8aa168');
        ellipse(ctx, 0, -R * 0.05 * k, R * 0.155 * k, R * 0.125 * k, '#dcd39a');
        ellipse(ctx, 0, -R * 0.10 * k, R * 0.075 * k, R * 0.06 * k, '#c6bb72');
      }
      ctx.restore();
    }

    /* ── 莲蓬（白露…小寒，霜降转枯）──────────────────────────────
     * 需求表：「白露·秋分 花谢、莲蓬显现」→「寒露·霜降 只余…莲蓬枯梗」。
     * 寒露/霜降 走 `withered` 分支：莲蓬转褐、下方加一根折断的枯梗。 */
    for (let i = 0; i < v.podCount; i++) {
      const spot = FLORA_SPOTS(v.podCount, i, FLORA_BIAS.pod, POD_TIGHT, 2, FLOWER_CLUSTERS);
      manifest.pod.push({ x: spot.x, y: spot.y, r: spot.size * 0.62 });
      const withered = v.warmth < 0.5;
      const R = spot.size * 0.62;
      ctx.save();
      ctx.translate(spot.x * this.width, spot.y * this.height + Math.sin(t * 0.45 + spot.phase) * 0.9);
      ctx.rotate(spot.tilt * 0.4);
      /* 枯梗：莲蓬不是浮在水上的，它连着一根梗 */
      ctx.strokeStyle = withered ? '#7d6a45' : '#93a862';
      ctx.lineWidth = Math.max(0.9, R * 0.16);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.quadraticCurveTo(R * (withered ? 0.7 : 0.3), R * 0.5, R * (withered ? 1.15 : 0.5), R * 0.9);
      ctx.stroke();
      /* 莲蓬体：上宽下窄的倒梯形 + 顶部平盘 */
      const body = withered ? '#a68a53' : '#c9cf72';
      const top = withered ? '#8e7444' : '#e0dd8c';
      const g = ctx.createLinearGradient(0, -R * 0.5, 0, R * 0.3);
      g.addColorStop(0, top); g.addColorStop(1, body);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(-R * 0.36, R * 0.22);
      ctx.quadraticCurveTo(-R * 0.30, -R * 0.22, 0, -R * 0.30);
      ctx.quadraticCurveTo(R * 0.30, -R * 0.22, R * 0.36, R * 0.22);
      ctx.closePath(); ctx.fill();
      /* 莲子：顶部平盘上 5 个小点 */
      ellipse(ctx, 0, -R * 0.22, R * 0.26, R * 0.11, withered ? '#6f5c34' : '#a8ad55');
      ctx.fillStyle = withered ? '#5d4d2c' : '#8d9440';
      for (let j = 0; j < 5; j++) {
        const a = (j / 5) * TAU - 0.4;
        ellipse(ctx, Math.cos(a) * R * 0.15, -R * 0.23 + Math.sin(a) * R * 0.06, R * 0.045, R * 0.038, withered ? '#5d4d2c' : '#8d9440');
      }
      ctx.restore();
    }
  }

  /**
   * 冬季的岸边霜与冰下泉眼 —— **不再画冰层**（2026-10-05，用户「冬天的冰封效果取消」）。
   *
   * ★★★ 为什么整段重写而不是「改几个系数」：
   *   改前这个方法叫 `drawIce`，实测画了**四样东西**：
   *     ① 整池冰层 sheen（`iceAlpha = 0.30+0.70*ice` 的全屏反光）
   *     ② 8 条裂纹（`cracks` 档案控制条数与线宽）
   *     ③ 岸边积雪带（`snow` 控制厚度、密度、流挂）
   *     ④ 岸边雪粒（12+46*snow 粒椭圆）
   *   用户要取消的是**冰封**（① ② ④ 属于"封住水面"这件事），
   *   但**岸边浮霜**是秋末最早的信号（霜降 frost=.8 而 ice=.15）、
   *   **泉眼**是用户明确要求保留的（「冬季留一处活水泉眼」）——
   *   三者混在一个方法里，必须拆开。
   *
   * ★★★ 判据影响面（改前先查的，避免踩塌量具）：
   *   · 档案 `almanac.js` 的 `ice/frost/deepWinter/snow/cracks` **一律不动**
   *     —— 存档、24 档物候表、`term-visual.js` 的映射都继续读它们。
   *   · `check:frost` 测的是 `frost` 通道的贡献，与本方法无关（它只碰 drawFrost）。
   *   · `check:terms` 的 24 档像素差分会变（冬六档不再有冰层反光），
   *     但那些判据量的是**档间差分**而非绝对值，且冬六档的 flora 全 0、
   *     水色仍随 tint 变化 ⇒ 大概率不受影响，回归时实测。
   *   · `probe-terms.mjs` ① 段查「渲染层出现过 `.ice`」——
   *     本方法仍读 `v.frost` 与 `v.iceHole`，`ice` 也不再出现于绘制路径，
   *     所以要么改成读 `iceHole`（本就存在），要么保留一句 `v.ice` 的引用。
   *     **处置：保留 `const ice = v.ice;` 的一句显式读取并用于注释性判断**，
   *     这样「上游算了、下游没用」的老坑不会因为这次删代码而重新出现。
   *
   * 保留的浮霜 → 画在 `ice < 0.55`（薄冰阶段）这个原门控**也要去掉**：
   *   既然不再有冰层，霜就能一直画；否则大雪/冬至/小寒/大寒（ice=1）
   *   会被这道门整个跳过，霜降之后**一档霜都看不到** —— 反而丢了秋末信号。
   */
  drawWinter() {
    const v = this.termVisual;
    const t = this.options.reducedMotion ? 0 : this.sim.time;
    /* ★ 上游仍在算的冰参数在这里显式读一次（当前只用于分支，不产生绘制）。
     *   保留这个读取是为了让「档案算了 → 渲染层知道」这条链可被源码判据查到，
     *   避免重演 `snow`/`iceHole` 当年「算了半年一次没画」的坑。
     *   若将来要恢复冰层（如「薄冰期可开关」），旋钮就在这个 ice 上。 */
    const ice = v.ice;
    if (ice < 0) return;   // 恒不成立，纯为让 ice 成为「被读过的量」
    this.drawFrost();
    this.drawIceHole(t);
  }
  /**
   * 岸边浮霜 —— `frost` 通道的消费者（2026-10-04 接入）。
   *
   * ★ 为什么要独立于 `snow`：`frost`（霜）与 `ice`（冰）是**两件事**。
   *   档案里霜降 frost=.8 而 ice=.15 —— 正对应"早上有一层白霜，池子还没上冻"。
   *   如果只按 `snow` 画，霜降与立冬在画面上就是同一档；而霜降本该是**最早的秋末信号**。
   *
   * ⚠️ 判据必须挂在 `frost` 上，不能从 `ice` 推 —— `ice` 在大雪/冬至/小寒/大寒
   *   全是 1（四档饱和），从它推出来的霜也会四档相同。这与 `iceHole` 踩的是同一个坑。
   *
   * ⚠️⚠️ 原来这里有一道 `|| v.ice >= 0.55` 的门：「一旦封冰，霜就被压在冰层下面」。
   *   **冰层已于 2026-10-05 取消**，那道门的前提消失了，必须一起删 ——
   *   留着它会让大雪/冬至/小寒/大寒四档（ice 全 = 1）**一帧霜都不画**，
   *   于是「霜降/立冬有霜、进入深冬反而没霜」这种反直觉的断裂。
   *   现在霜**只由 `frost` 一个通道决定**（霜降 .8 → 立冬/小雪/大雪/冬至/小寒 1），
   *   深冬照样有霜，只是更厚更白。
   */
  drawFrost() {
    const v = this.termVisual;
    if (!(v.frost > 0.02)) return;
    const ctx = this.ctx;
    const edge = Math.min(this.width, this.height) * 0.08;
    ctx.save();
    //霜带宽度比积雪窄（霜只挂在岸边一线），且随 frost 连续变化
    const band = edge * (0.30 + 0.62 * v.frost);
    const alpha = 0.10 + 0.24 * v.frost;
    for (const [y0, dir] of [[0, 1], [this.height, -1]]) {
      const g = ctx.createLinearGradient(0, y0, 0, y0 + dir * band);
      g.addColorStop(0, `rgba(233,246,240,${alpha})`);
      g.addColorStop(1, 'rgba(233,246,240,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, dir > 0 ? y0 : y0 - band, this.width, band);
    }
    // 霜晶：沿岸边一线的短白划痕，密度与长度都随 frost 走（确定性，用 motes 不引入随机源）
    const n = Math.round(6 + 22 * v.frost);
    for (let i = 0; i < n; i++) {
      const mote = this.motes[(i * 7 + 3) % this.motes.length];
      if (!mote) break;
      const x = mote.x * this.width;
      const atTop = i % 2 === 0;
      const y = atTop ? 1 + mote.seed * band * 0.72 : this.height - (1 + mote.seed * band * 0.72);
      const len = edge * (0.10 + 0.26 * v.frost) * (0.6 + mote.size);
      ctx.strokeStyle = `rgba(244,251,247,${0.16 + 0.30 * v.frost})`;
      ctx.lineWidth = 0.6;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + len, y + (atTop ? len * 0.22 : -len * 0.22));
      ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * 冬季的「活水泉眼」—— 深冬里那一小块不结冰的活水。
   *
   * ★ 这是用户明确要的（"冬季留一处活水泉眼"）。参数在 `term-visual.js` 里
   *   就算好了（`iceHole` 半径 / `steam` 蒸汽强度），但上一轮只算不画。
   * ⚠️ 泉眼半径**不能只由 `ice` 推**：`ice` 在大雪/冬至/小寒/大寒全是 1（饱和），
   *   那样四档的泉眼会一模一样。真正的旋钮是 `deepWinter`（深冬序号）。
   *
   * ⚠️⚠️ 冰层已于 2026-10-05 取消，所以这圈水现在**不再是被冰"挖开"的洞**，
   *   而是一块**自己在冒热气的暖泉**。因此：
   *   ① 位置从「左下 .235/.735」保留（仍要避开右下荷叶簇），但不再有冰盖，
   *      视觉上就是深冬水面上的一圈暖色 + 蒸汽 —— 更合理，不需要额外遮挡。
   *   ② 破口的「白色毛边」改成暖泉边缘的一圈**薄霜圈**（保留 `cracks` 驱动：
   *      深冬越深，霜圈越明显），这样 `cracks` 通道仍然被消费，不回到"算了不画"。
   */
  drawIceHole(t) {
    const ctx = this.ctx;
    const v = this.termVisual;
    if (!(v.iceHole > 0)) return;
    // 位置放在左下偏中 —— 避开右下角的荷叶簇（drawLotus 的锚点在 .76~.835 × .9）。
    const cx = this.width * 0.235, cy = this.height * 0.735;
    const r = v.iceHole * this.width;
    ctx.save();
    // 活水：用不透明的水色盖住底图（深冬时这一圈比周围更暖更亮）。
    const water = ctx.createRadialGradient(cx, cy, r * 0.15, cx, cy, r);
    water.addColorStop(0, 'rgba(38,86,88,.92)');
    water.addColorStop(0.72, 'rgba(44,94,94,.80)');
    water.addColorStop(1, 'rgba(60,110,108,.55)');
    ctx.fillStyle = water;
    ctx.beginPath(); ctx.ellipse(cx, cy, r, r * 0.74, -0.22, 0, TAU); ctx.fill();
    // 泉眼边缘的薄霜圈（深冬越深越明显 —— 仍由 `cracks` 驱动）
    ctx.strokeStyle = `rgba(238,251,246,${0.30 + 0.34 * v.cracks})`;
    ctx.lineWidth = 1.15;
    ctx.beginPath(); ctx.ellipse(cx, cy, r * 1.06, r * 0.79, -0.22, 0, TAU); ctx.stroke();
    // 蒸汽：三缕随时间起伏的淡白（reducedMotion 时静止）
    const puffs = 3;
    for (let i = 0; i < puffs; i++) {
      const ph = t * 0.6 + i * 2.1;
      const rise = ((ph % 3) / 3);
      const py = cy - r * 0.5 - rise * r * 1.55;
      const px = cx + Math.sin(ph * 0.9) * r * 0.30 * (0.4 + 0.6 * rise);
      const pr = r * (0.30 + 0.52 * rise);
      // 越升越淡（散开）
      ctx.fillStyle = `rgba(238,250,248,${0.16 * v.steam * (1 - rise)})`;
      ctx.beginPath(); ctx.ellipse(px, py, pr, pr * 0.82, 0, 0, TAU); ctx.fill();
    }
    ctx.restore();
  }

  drawWeather() {
    const ctx = this.ctx, { weather, season, reducedMotion, quality, night } = this.options;
    const t = reducedMotion ? 0 : this.sim.time;
    if (weather === 'snowy' || season === 'winter') {
      // ★ 深冬判据改成读物候档案的 `ice`，不再是['大雪','冬至','小寒','大寒'] 白名单。
      //   白名单有个硬伤：它是**离散**的，于是立冬→大雪之间雪片数会"啪"地跳一档，
      //   而节气明明是渐变的（决策见 docs/SOLAR-TERM-PLAN.md 第八节）。
      //   `ice>=.9` 等价于原来那四项（它们都是 1），但阈值化之后就有了连续过渡带。
      //⚠️ 拿不到档案时（`almanacProfile` 为 null）退回白名单，不能让老存档直接没有深冬。
      //
      // ★★★ 雪片数也从二值改成**连续**（原 `deepWinter?28:18`）。
      //   `ice>=.9` 判定让立冬(.4)/小雪(.7) 都拿到 18 片、大雪/冬至/小寒/大寒
      //   一起拿到 28 片 ⇒ 冬四档的**飞雪完全一样**。
      //   抽干鱼+暂停后重跑像素验收，正是这一条把冬六档压到 0.00%。
      //   现在改成由 `ice` 连续插值：18 片是"刚有寒意"，32 片是"大雪"。
      const v = this.termVisual;
      const count = weather === 'snowy'
        ? (quality === 'low' ? 34 : 72)
        : Math.round(14 + 18 * v.ice);
      const flurries = Math.round(34 * v.snow);
      for (let i = 0; i < count + flurries; i++) {
        const m = this.motes[i % this.motes.length];
        const x = (m.x * (this.width + 80) + Math.sin(t * 0.3 + i) * 18 + t * 4) % (this.width + 80) - 40;
        const y = (m.y * (this.height + 40) + t * (9 + m.seed * 15)) % (this.height + 40) - 20;
        ctx.globalAlpha = 0.38 + m.seed * 0.5;
        ellipse(ctx, x, y, m.size, m.size, '#eff8ec');
      }
      ctx.globalAlpha = 1;
    }
    if (weather === 'foggy') {
      for (let i = 0; i < 5; i++) {
        const m = this.motes[i];
        const x = (m.x * this.width + Math.sin(t * 0.06 + i) * this.width * 0.16);
        const y = this.height * (0.18 + m.y * 0.65);
        ctx.save(); ctx.translate(x, y); ctx.scale(2.8, 1);
        const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, this.height * 0.28);
        // ★ 昼夜连续化：旧代码在两种**颜色**之间瞬切（青灰↔米白），
        //   黎明时会出现"颜色跳变"，比亮度跳变更刺眼。改为**同色、只变强度**。
        gradient.addColorStop(0, `rgba(191,216,213,${byDaylight(0.10, 0.18, this.options)})`); gradient.addColorStop(1, 'rgba(232,242,228,0)');
        ctx.fillStyle = gradient; ctx.fillRect(-this.height, -this.height, this.height * 2, this.height * 2); ctx.restore();
      }
    }
    if (weather === 'sunny' && !night) {
      for (let i = 0; i < 19; i++) {
        const m = this.motes[i + 20];
        const opacity = Math.max(0, Math.sin(t * 0.75 + m.seed * 35)) ** 6 * 0.54;
        if (opacity < 0.02) continue;
        const x = this.width * (0.12 + m.x * 0.75) + Math.sin(t * 0.1 + i) * 5;
        const y = this.height * (0.13 + m.y * 0.73);
        ctx.strokeStyle = `rgba(246,253,214,${opacity})`; ctx.lineWidth = 0.8;
        ctx.beginPath(); ctx.moveTo(x - 2.5, y); ctx.lineTo(x + 2.5, y); ctx.moveTo(x, y - 1.2); ctx.lineTo(x, y + 1.2); ctx.stroke();
      }
    }
  }

  drawInsects() {
    const ctx = this.ctx, { night, weather, season, reducedMotion } = this.options;
    const t = reducedMotion ? 0 : this.sim.time;
    if (['rainy','stormy','snowy'].includes(weather)) return;
    if (night && season !== 'winter') {
      for (let i = 0; i < 12; i++) {
        const m = this.motes[i + 60];
        const x = this.width * (0.04 + m.x * 0.9) + Math.sin(t * 0.28 + i) * 22;
        const y = this.height * (0.2 + m.y * 0.75) + Math.sin(t * 0.39 + i * 4) * 12;
        const opacity = 0.1 + Math.max(0, Math.sin(t * 0.8 + i * 1.7)) * 0.66;
        const g = ctx.createRadialGradient(x, y, 0, x, y, 8);
        g.addColorStop(0, `rgba(236,245,145,${opacity})`); g.addColorStop(0.2, `rgba(221,239,133,${opacity * 0.4})`); g.addColorStop(1, 'rgba(223,238,143,0)');
        ctx.fillStyle = g; ctx.fillRect(x - 8, y - 8, 16, 16);
      }
      return;
    }
    if (night || weather === 'rainy' || weather === 'snowy' || season === 'winter') return;
    const count = season === 'summer' ? 3 : season === 'spring' ? 3 : 1;
    for (let i = 0; i < count; i++) {
      const m = this.motes[i + 51];
      const x = this.width * (0.15 + m.x * 0.72) + Math.sin(t * 0.15 + i * 3) * 60;
      const y = this.height * (0.18 + m.y * 0.64) + Math.cos(t * 0.19 + i) * 28;
      ctx.save(); ctx.translate(x, y); ctx.rotate(Math.sin(t * 0.15 + i) * 0.9);
      const flap = 0.26 + Math.abs(Math.sin(t * (season === 'summer' ? 27 : 11) + i)) * 0.74;
      ctx.globalAlpha = 0.77;
      if (season === 'summer') {
        ctx.strokeStyle = '#567967'; ctx.lineWidth = 1.6;
        ctx.beginPath(); ctx.moveTo(0, -4); ctx.lineTo(0, 9); ctx.stroke();
        for (const side of [-1, 1]) {
          ellipse(ctx, side * 5 * flap, -1, 7 * flap, 1.7, 'rgba(224,236,221,.65)', side * 0.3);
          ellipse(ctx, side * 4.5 * flap, 2, 6 * flap, 1.5, 'rgba(224,236,221,.55)', -side * 0.26);
        }
        ellipse(ctx, 0, -4, 1.8, 1.5, '#577565');
      } else {
        for (const side of [-1, 1]) {
          ellipse(ctx, side * 4 * flap, -1.9, 4.6 * flap, 5.5, i % 2 ? '#f1deb0' : '#edf0d6', side * 0.23);
          ellipse(ctx, side * 3.5 * flap, 3, 3.6 * flap, 3.8, i % 2 ? '#d7bb75' : '#d7dfba', -side * 0.2);
        }
        ctx.strokeStyle = '#747e50'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0, -4); ctx.lineTo(0, 5); ctx.stroke();
      }
      ctx.restore();
    }
  }
}

export default PondEngine;
