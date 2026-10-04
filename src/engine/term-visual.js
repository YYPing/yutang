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
import { SOLAR_TERMS, TERM_SEASON, termProfile } from './almanac.js';

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
 * 节气 → 季内**秩次**（0..1），六档等距。
 *
 * ★★★ 为什么必须用秩次而不是 warmth 线性归一化（2026-10-04 实测）：
 *   线性归一化后各档的**步长极不均匀**，实测相邻步长比高达 **40~60 倍**：
 *     春 .08/.12/.08/[.04]/.06  → 清明谷雨之间只有 .04（最弱对 ΔE 1.26）
 *     夏 .06/.06/[.13]/(-.06)/+.03 → 夏至后反向，小暑大暑只有 .03
 *     冬 .08/.08/.04/.03/.03
 *   根因：`warmth` 是「气温」，而**物候与气温并不同步**（夏至之后还热、小暑反而更热；
 *     清明谷雨之间升温也慢）。拿它当进度，等于让"最该看出差别的那两档"被压掉。
 *
 *   正解：季内按**物候顺序**（立春→雨水→惊蛰→春分→清明→谷雨）取秩次，
 *     六档固定占 0/.2/.4/.6/.8/1.0 ⇒ **步长恒定**，没有任何一对被压扁。
 *     跨季的冷暖基色由 `seasonOf(warmth)` 决定（冬=青蓝、夏=黄绿），
 *     所以夏至仍是"最暖的那一档"（秩次 .6 + summer 基色），物候与观感都对。
 *
 * ⚠️ 这张表是**物候序**（季内真实顺序），不能从 `SOLAR_TERMS` filter 出来：
 *   24 序是**历法序、跨年排布**（立春/雨水/惊蛰在末尾，春分/清明/谷雨在开头），
 *   filter 出来是「谷雨→立夏」这种跨季拼接，会让季内断言全部误判。
 *   下方 SEG 的段序则必须用历法序 —— **两个序各司其职，别混用**。
 */
const TERM_RANK = {
  spring: ['立春', '雨水', '惊蛰', '春分', '清明', '谷雨'],
  summer: ['立夏', '小满', '芒种', '夏至', '小暑', '大暑'],
  autumn: ['立秋', '处暑', '白露', '秋分', '寒露', '霜降'],
  winter: ['立冬', '小雪', '大雪', '冬至', '小寒', '大寒'],
};
/** warmth 的季内 min/max（实测 24 档真值）—— **只用于没有节气名时的线性兜底**。
 *  ⚠️ 若改了 almanac.js 的 warmth 须复核这张表；正常路径走 RANK，不依赖它。 */
const SEASON_WARMTH = { spring: [.30, .68], summer: [.74, .99], autumn: [.38, .80], winter: [.02, .28] };

/**
 * 秩次 0/.2/.4/.6/.8/1.0（每季六档）。
 * ⚠️ 跨年排布：夏天的第 6 档（大暑）之后接的是**下一季的第 1 档**（立秋，秩次 0）。
 */
const RANK = (() => {
  const m = new Map();
  for (const list of Object.values(TERM_RANK)) list.forEach((t, k) => m.set(t, k / (list.length - 1)));
  return m;
})();

/**
 * 段内连续插值表：`SEG.get(term)` = 从这一档走到**日历上的下一档**时，warmth 与 rank 的两端。
 *
 * ★★★ 为什么必须有这张表（2026-10-04，`probe-terms.mjs` ⑨ 段抓到的真缺陷）：
 *   真实运行路径是 `blendTerm(almanac.term, t)` —— **`almanac.term` 恒为离散的
 *   "from 档"，而 `t` 是这一档之内已走过的比例（0→1，约 15 天）**。
 *   第一版 `seasonalWarmth()` 只看 `RANK.get(term)`，等于把整个 15 天压成同一个值：
 *   水色在**交节那一帧跳一下，然后 15 天不动** —— 是阶梯函数，不是渐变。
 *   这直接违反本模块铁律③（连续优先于精确），而且旧探针会假绿：
 *   只在 t=0 取样的话，24 档全对，看不出 t 的问题。
 *
 *   正解：段内用 warmth **反解**出 t，再线性插值 rank。
 *   · t=0 时 warmth 恰为 w0 ⇒ rank 精确等于 r0 ⇒ **24 档的秩次一步不变**，
 *     季内步长仍然恒定 0.050（这是本方案的全部收益，不能丢）；
 *   · 0<t<1 时 rank 落在 r0..r1 之间 ⇒ tint 严格落在两端之间，插值断言成立；
 *   · 顺带修好**跨季那一帧的硬跳**：谷雨(r=1)→立夏(r=0) 现在是 15 天的连续过渡，
 *     而不是"啪"地一下从黄绿跳到青蓝 —— 这正好是用户投诉的"季节切换太明显"。
 *
 * ⚠️⚠️ 必须按 **SOLAR_TERMS 的日历序**建，不能按 TERM_RANK 的分组顺序。
 *   第一版按季节分组 + `(i+1)%n` 绕回，谷雨那一段因此指向了「立春」——
 *   **日历上谷雨之后是立夏，中间隔着整个夏天**。后果：谷雨/霜降/大寒三段
 *   全用错了 warmth 区间（探针立刻报「全段恒定」与「步长不均」）。
 *   教训：**"季内相邻"和"日历相邻"是两个不同的序**，
 *   秩次表可以按季分组（只管组内等距），但**段**必须按日历序连。
 *
 * ⚠️ warmth 在季内**并非单调**（夏至 .99 → 小暑 .93），但这不构成问题：
 *   反解用的是"这一段自己的两端"，w0/w1 谁大谁小都成立（除法带符号）。
 *   唯一要求是 w0 ≠ w1，而 24 档 warmth 两两不等（实测 .02~.99 共 24 个不同值）。
 */
const SEG = new Map(SOLAR_TERMS.map((term, i) => {
  const next = SOLAR_TERMS[(i + 1) % SOLAR_TERMS.length];
  return [term, {
    w0: termProfile(term).warmth,
    r0: RANK.get(term),
    w1: termProfile(next).warmth,
    // ★ 跨季时 r1 是**下一季的第 1 档 = 0**：立秋 r0=1.0 → r1=0.0，
    //   于是「霜降→立冬」是 15 天的连续过渡，正是我们要的（不硬跳）。
    r1: RANK.get(next),
  }];
}));

function seasonalWarmth(warmth, term) {
  // 有节气名 ⇒ 走秩次，并在段内按 warmth 反解连续插值（见 SEG 的说明）。
  // 拿不到（如老存档只有档案没有 term）⇒ 退回季内 warmth 的线性归一化。
  const seg = term ? SEG.get(term) : null;
  if (seg) {
    const dw = seg.w1 - seg.w0;
    const t = Math.abs(dw) < 1e-6 ? 0 : clamp01((warmth - seg.w0) / dw);
    return clamp01(seg.r0 + (seg.r1 - seg.r0) * t);
  }
  const s = seasonOf(warmth, term);
  const [lo, hi] = SEASON_WARMTH[s] || SEASON_WARMTH.spring;
  return clamp01((warmth - lo) / Math.max(1e-6, hi - lo));
}

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
export function TERM_VISUAL(profile, options) {
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
  //
  // ★★★ 2026-10-04：这里的定义域从 [COLD,WARM] 的**局部 lerp** 改成
  //   **按季节归一化后再映到全幅**。这是"档间差被吃掉"的第四例，与前三次同源：
  //     ① 荷叶 leaf→1 时 round() 饱和 ② 夏至 warmth=1 撞上界
  //     ③ 雪厚 0.35+0.65×deepWinter 撞上界 ④ **就是这里**
  //   实测（改动前）：春分 tint=(.723,.868,.713) vs 清明 (.728,.872,.708)
  //     ⇒ 档间差只有 **0.005~0.010**，再乘 amt(.33~.39) 与 water，
  //     最终画面差 0.4 灰阶、感知 ΔE 仅 **1.19**（阈值 5，差 4 倍）。
  //   根因：`warmth` 全域只有 .02~.99，而 `lerp` 的两端差 0.25 ⇒ 单档步长被
  //   除以 0.25，**同季相邻档（warmth 步长 0.04~0.13）只吃掉 16%~52%**，
  //   再经 TINT_BASE 二次压缩，几乎归零。
  //   正解：先在**本季内**把 warmth 归一化到 0..1，让六档**吃满 tint 全幅**，
  //   再映到 COLD->WARM 的全段。跨季靠 TINT_BASE 兜底（那里本来就该有强差异）。
  // 秩次优先（步长恒定）；拿不到节气名时退回线性归一化。
  // ⚠️ 用 solarTerm（引擎 options 里的字段），不是 almanacTerm（只在 UI settings 里）。
  //   读错字段的后果是静默的：termName=null ⇒ seasonOf 退回 warmth 阈值 ⇒ 又错 7 档。
  const termName = options?.solarTerm || null;
  const norm = seasonalWarmth(warmth, termName);
  const tint = {
    r: lerp(COLD_TINT.r, WARM_TINT.r, norm),
    g: lerp(COLD_TINT.g, WARM_TINT.g, norm),
    b: lerp(COLD_TINT.b, WARM_TINT.b, norm),
  };

  // ── 焦散：档案 `warmth` × 现有 CAUSTIC 门控 ──────────────────────
  // ★ 不再只用 `CAUSTIC.season[termSeason]`（4 档），而是让 `warmth`
  //   连续调幅。这样谷雨(0.68) 与立夏(0.74) 的焦散量明显不同，
  //   而它们**同属 spring、共用同一张背景图** —— 差异只能来自这里。
  const seasonGain = CAUSTIC.season[seasonOf(warmth, options?.solarTerm)] ?? 1;
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
    season: seasonOf(warmth, termName),   // ★ 补出：岸边花木要用它选当季物候
    deepWinter: deep0,          // ★ 补出：积雪压枝的厚度（原本只是内部中间量）
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

/**
 * 季节判定 —— **优先查 TERM_SEASON 真源表**，拿不到才按 warmth 阈值兜底。
 *
 * ★★★ 2026-10-04 修掉一个**一直存在但从未被发现**的老 bug。
 *   旧实现是纯阈值反推（warmth ≥.72 夏 / ≥.52 春 / ≥.34 秋 / 其余冬），
 *   实测与 `almanac.js` 的 TERM_SEASON **7/24 档不一致**：
 *     立秋 .82→summer  处暑 .76→summer   （明明是秋，画成了夏）
 *     白露 .66→spring  秋分 .58→spring   （明明是秋，画成了春）
 *     立春 .30→winter  雨水 .40→autumn  惊蛰 .50→autumn（明明是春，画成了冬/秋）
 *   为什么一直没被发现：它在下游只影响 `CAUSTIC.season[season]` 这个**焦散倍率**，
 *   偏差只有 ±20~30% 的强度，**画面依然"正常渲染"，只是秋天的焦散偏强、
 *   春天的偏弱** —— 没有任何报错，也没有任何量具报警。
 *   本次做 tint 秩次时被 tint 放大成"立冬是黄绿色"才暴露。
 *
 *   ⚠️ 教训：**当一个派生量被下游放大时，它的小偏差会变成大问题**。
 *     所以派生量必须与真源对齐，而不是自己编一套阈值。
 */
export function seasonOf(warmth, term) {
  if (term) {
    const i = SOLAR_TERMS.indexOf(term);
    if (i >= 0 && TERM_SEASON[i]) return TERM_SEASON[i];
  }
  if (warmth >= 0.72) return 'summer';
  if (warmth >= 0.52) return 'spring';
  if (warmth >= 0.34) return 'autumn';
  return 'winter';
}

const clamp01 = (v) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);
const lerp = (a, b, t) => a + (b - a) * t;

/** 供 pond.js 用：拿当前 options 直接算出渲染参数（无档案时回中性春）。 */
export function visualFor(options) {
  return TERM_VISUAL(options?.almanacProfile, options);
}