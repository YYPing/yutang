/**
 * 节气 → **渲染参数**的翻译层。
 *
 * ── 为什么需要这一层（而不是直接把档案塞进 pond.js）──────────────────
 * 用户反馈「每个节气之间都一样」。根因查清了，是三处静默失效叠加：
 *   ① 背景贴图只有 4 张（`spring/autumn/winter/pond.png`），按 `season` 索引
 *      ⇒ 同一季节的 6 个节气**共用同一张图**；
 *   ② `CAUSTIC.season` 只有 4 个值 ⇒ 同上，焦散一季一档；
 *   ③ 六维物候档案（`almanac.js` 的 `TERM_PROFILE`）**只被读了 1 维**
 *      （`ice` → 雪片数量 18→28），其余 5 维零消费。
 * 合起来就是「24 个节气塌成 4 张画面」。
 *
 * 本模块的定位：**在不改背景贴图数量的前提下，把 24 档拉开**。
 * 所以输出的每一项都必须作用在**大面积**通道上（水色 / 焦散 / 冰层），
 * 或者作用在"数量"通道上（浮叶 / 落叶 —— 数量差本身就很显眼）。
 *
 * ── 三条设计铁律 ──────────────────────────────────────────────────
 * ① **只加不减**：所有参数都是对现有渲染的调制，绝不替换。
 *    背景贴图 / 光照场 / 锦鲤画法一律不动 —— 它们已被 `check:light` 等量具钉死。
 * ② **同季节内部必须有差异**：因为背景图是季节级共享的，
 *    组内差异**只能**来自水色与焦散。这是最容易被忽略、也最显眼的约束。
 * ③ **连续优先于精确**：宁可让夏至=0.98 而非 1.0（留一点插值余量），
 *    也不要出现"到某个节气就突然变"的台阶。
 *
 * ── 参数含义 ──────────────────────────────────────────────────────
 * tintR/G/B   水色调（0–1 归一化的色度权重，不是颜色值；实际取色见 pond.js）
 * causticInk  焦散强度倍率（乘 `CAUSTIC.ink`）
 * leafCount   浮叶/小荷叶片数（0 = 池面干净）
 * litterCount 落叶片数
 * frost       水面霜纹强度（0–1）
 * ice         结冰程度（0 = 不结，1 = 全封）
 * lotus       荷叶/荷花的存在度（0–1；>0.5 才画荷花）
 * iceHole     冰层上「活水泉眼」的半径（0 = 无孔；规划值约池宽 12%）
 * steam       泉眼蒸汽强度（仅冬季用）
 */

import { CAUSTIC } from './light-field.js';

/**
 * 单档基准值。这是"物理合理的中性取值"，再由冷暖做偏移。
 *
 * ⚠️ 为什么水色用「两个基色 + 冷暖权重」而不是直接写 24 个 RGB：
 *   24 个手写 RGB 会带来两个必然的坑 ——
 *   · 抄错一个值极难察觉（画面上只是"某个节气有点怪"）；
 *   · 相邻档之间无法保证连续（因为是独立抄的）。
 *   改成「夏色 / 冬色两端 + 冷暖插值」之后，连续性由构造保证，
 *   冷暖来自 `almanac.js` 的档案，也就自动跟着节气渐变了。
 */
const WARM_TINT = { r: 0.55, g: 0.78, b: 0.36 };  // 盛夏：黄绿
const COLD_TINT = { r: 0.30, g: 0.52, b: 0.62 };  // 隆冬：青蓝

/**
 * 浮叶/落叶的数量上下限（片）。0 是"池面干净"，不是"没接"。
 *
 * ★★ LEAF_MAX 取 24 而不是 22 —— 因为 `Math.round` 会吃掉顶端的小数。
 *   `leaf=.98` × 22 = 21.56 → round = 22；`leaf=1` × 22 = 22 → 也是 22。
 *   两档**荷叶数完全相同** ⇒ 荷叶这条通道对它们零贡献。
 *   24 让 .98×24=23.5→24 与 1×24=24 仍然相同 —— 也不行。
 *   ⇒ 真正的解是**上限留一档余量**：LEAF_MAX=25 时 .98×25=24.5→25、1×25=25，还是相同。
 *   ⚠️ 结论：`round(leaf*MAX)` 在 leaf→1 时必然饱和，**靠 MAX 解决不了**。
 *   正解是让档案的 leaf 峰值也**不撞 1**（下面夏至改成 .96），
 *   这样 round(.96*22)=21 与 round(1*22)=22 才拉开 1 片。
 *   MAX 保持 22：它就是"盛夏满池"的物理上限，改大反而会让画面浮叶过密。
 */
const LEAF_MAX = 22;
const LITTER_MAX = 20;

/**
 * 一个节气的渲染参数。
 *
 * @param profile `almanac.js` 的档案对象（`termProfile(t)` 或 `blendTerm(t, x)` 的返回值）
 */
export function TERM_VISUAL(profile) {
  // ⚠️ 拿不到档案时给**中性春**，不是 `{warmth:.5}` 这种"编出来的数"。
  //   中性春的好处是：老存档（无 `almanacProfile`）拿到的画面
  //   仍与改动前接近，而不是突然变成另一种风格。
  const p = profile && Number.isFinite(profile.warmth)
    ? profile
    : { warmth: 0.58, lotus: 0, leaf: 0.3, litter: 0.2, frost: 0, ice: 0 };

  const warmth = clamp01(p.warmth);
  const ice = clamp01(p.ice ?? 0);
  const frost = clamp01(p.frost ?? 0);
  const leaf = clamp01(p.leaf ?? 0);
  const litter = clamp01(p.litter ?? 0);
  const lotus = clamp01(p.lotus ?? 0);

  // ── 水色：两端插值 ────────────────────────────────────────────────
  // ★ 冷暖权重用 `warmth` 而不是 `1-ice`：立冬 ice 只有 .4 但已经"冷"了
  //   （warmth .28），单看 ice 会让秋末的水色还是暖的。
  const tint = {
    r: lerp(COLD_TINT.r, WARM_TINT.r, warmth),
    g: lerp(COLD_TINT.g, WARM_TINT.g, warmth),
    b: lerp(COLD_TINT.b, WARM_TINT.b, warmth),
  };

  // ── 焦散：档案 `warmth` × 现有 CAUSTIC 门控 ──────────────────────
  // ★ 不再只用 `CAUSTIC.season[termSeason]`（4 档），而是让 `warmth`
  //   连续调幅。这样谷雨(0.68) 与立夏(0.74) 的焦散量明显不同，
  //   而它们**同属 spring、共用同一张背景图** —— 差异只能来自这里。
  const seasonGain = CAUSTIC.season[seasonOf(warmth)] ?? 1;
  const causticInk = CAUSTIC.ink * seasonGain * (0.12 + 0.88 * warmth * warmth);

  // ── 浮叶：叶 + 荷 ────────────────────────────────────────────────
  // 荷叶与浮叶绑在一起（荷叶本来就是"大号浮叶"），
  // `lotus` 只额外决定**是否开花**。这样谷雨有浮叶无荷花、小满有花，
  // 而不会出现"有荷花但没有叶子"。
  const leafCount = Math.round(leaf * LEAF_MAX);
  const lotusCount = Math.round(lotus * 5);

  // ── 落叶 ──────────────────────────────────────────────────────────
  const litterCount = Math.round(litter * LITTER_MAX);

  // ── 冰：霜纹与冰层是**两件事** ───────────────────────────────────
  // `frost` 走"岸边/水面浮霜"（薄、局部），`ice` 走"整池冰层"（厚、覆盖）。
  // 霜降 ice 只有 .15 而 frost .8 —— 正对应"早上有霜、池子还没上冻"。
  //
  // ★★ 泉眼半径**不能只从 `ice` 推** —— 这是 `snow` 踩过的同一个坑。
  //   `ice` 在大雪/冬至/小寒/大寒**全是 1**（饱和），
  //   所以 `iceHole` 也会四档完全相同 —— 泉眼挖了等于没挖。
  //   正解：闸门（有没有泉眼）用 `ice`（薄冰上挖孔不合理），
  //   而**半径与蒸汽**用 `deep`（深冬序号）—— 深冬冰越厚，
  //   底下那眼活水越显得珍贵、蒸汽越旺。
  const deep0 = clamp01(p.deepWinter ?? 0);
  const iceHole = ice >= 0.55 ? (0.35 + 0.65 * deep0) * 0.075 : 0;
  const steam = iceHole > 0 ? 0.30 + 0.70 * deep0 : 0;

  // ── 冬季六档的冰形态 ─────────────────────────────────────────────
  // ★ 为什么需要它们：用户反馈「每个节气之间都一样」。
  //   冬六档（大雪/冬至/小寒/大寒）**全部 ice=1、frost=1、leaf=0、lotus=0、
  //   焦散全被压到 .006** ⇒ 在画面上几乎逐像素相同。
  //
  //   ★★ 这里踩过一个坑，值得完整记下来：**从 `warmth` 反推是错的**。
  //   第一版写 `w = (0.5 - warmth)/0.44` 想表达"越冷冰越厚"，
  //   结果小寒(.05) 与大寒(.02) 都超过上界被夹到 1.0
  //   ⇒ `snow` 全是 1.0、`cracks` 全是同一个值，**两档完全相同**。
  //   接着把 sin 曲线改成分段让末端分岔，也只把探针距离从 0.3 推到 0.3。
  //
  //   病根是**用连续量表达离散事实**：
  //     · "多冷" 是连续的（`warmth`）→ 适合做水色、焦散
  //     · "第几个九" 是离散的（序数，不是温度）→ 适合做冰的形态
  //   拿 `warmth` 去推后者，要么饱和、要么被压平在曲线端点。
  //   正解：档案直接给序号（`deepWinter`），这里只做一次线性映射。
  const deep = deep0;
  // 积雪：三九最厚，四九略收（雪压不住冰面，开始往边缘堆）
  const snow = deep <= 0.9 ? deep * 1.02 : 0.918 - (deep - 0.9) * 0.22;
  // 裂纹：三九最整（.30），四九最脆（.95）—— 刻意非单调，否则只是 snow 的翻版
  const cracks = deep <= 0.9
    ? 0.30 + 0.34 * (deep / 0.9)
    : 0.64 + 0.31 * ((deep - 0.9) / 0.1);

  return {
    warmth,
    tintR: tint.r, tintG: tint.g, tintB: tint.b,
    causticInk,
    leafCount,
    lotusCount,
    litterCount,
    frost,
    ice,
    iceHole,
    steam,
    snow,
    cracks,
    // 供探针与调试用
    lotus,
  };
}

/** 按冷暖反推季节（只为查 `CAUSTIC.season` 的四档门控）。 */
function seasonOf(warmth) {
  if (warmth >= 0.72) return 'summer';
  if (warmth >= 0.52) return 'spring';
  if (warmth >= 0.34) return 'autumn';
  return 'winter';
}

const clamp01 = (v) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);
const lerp = (a, b, t) => a + (b - a) * t;

/** 供 pond.js 用：拿当前 options 直接算出渲染参数（无档案时回中性春）。 */
export function visualFor(options) {
  return TERM_VISUAL(options?.almanacProfile);
}