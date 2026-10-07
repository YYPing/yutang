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
/* ★★★★★ 2026-10-07 荷花物候重排（据用户提供的**江南荷花真实物候时间轴**）。
 *
 *━━━ 为什么整体推翻原档案 ━━━
 *   原档案的春组来自需求文档的参考图说明 `REF_POND`（「春分七八支花苞待放」、
 *   「春分七八支花苞尖」），我照抄了。**但那在物候上是错的**：
 *   江南春分是**钱叶初浮**期（2–3 枚极小圆浮叶），
 *   **谷雨才孕蕾、立夏才见尖苞**。把花苞放在春分等于**花期提前约 20 天**，
 *   后果是「春分/清明满池粉苞」——正好是用户指出的
 *   「春组水面上的粉色小荷苞全部去掉」。
 *   ⇒ 参考图与真实物候冲突时**以物候为准**（用户已明确裁决），
 *     差异在 `tests/almanac-pheno.test.js` 的 `REF_POND` 处留注释说明，
 *     免得下一轮又照参考图改回去。
 *
 *━━━ 三条物候主线（本轮重排的骨架）━━━
 *   ① **峰值在大暑**（原在夏至）。「小暑盛花期始 → 大暑盛花顶峰」，
 *      而大暑是三伏中最闷热的一档，荷叶盖水 80%、颜色最深 —— 高温与花量同向。
 *   ② **春组零花零苞**。春分/清明/谷雨只有钱叶→浮叶→立叶尖，**不开花**。
 *      谷雨的 `bud` 也必须为 0 —— 它是「准备孕蕾」，不是「已经孕蕾」。
 *   ③ **立秋起花要退坡、莲蓬要接管**。规范：「立秋出现绿莲蓬代替粉荷花、
 *      处暑花全谢只剩莲蓬、白露残瓣、寒露后枯梗」。
 *      原档案立秋还有 3 朵**全开**荷花 ⇒「满池夏荷」，就是用户说的串味根源。
 *
 * ⚠️ 本段与 `term-visual.js` 的 `OPEN_LO`/`OPEN_HI`、`LOTUS_MAX` 是**一组**，
 *   改任一侧必须同步另一侧（窗口上下沿挂在档案实际值上，不是魔数）。
 */
const TERM_PROFILE = Object.freeze({
  // ── 春：钱叶期。**零花零苞**，只有浮叶逐档变大 ──
  //春分「2–3 枚极小圆钱叶」⇒ leaf .14×22=3。
  春分: { warmth: .58, lotus: 0, bud: 0.00,  pod: 0.00,   leaf: .14, litter: 0,   frost: 0,   ice: 0 },
  //  清明「5–6 枚小圆浮叶」⇒ leaf .25×22=6。
  清明: { warmth: .62, lotus: 0, bud: 0.00,  pod: 0.00,   leaf: .25, litter: 0,   frost: 0,   ice: 0 },
  //  谷雨「浮叶增多 + 冒 1–2 支尖尖立叶，**准备孕蕾**」⇒ bud 仍为 0。
  //  ⚠️ 原值 bud:.85（8 个苞）是把花期提前了 20 天，本轮归零。
  谷雨: { warmth: .68, lotus: 0, bud: 0.00,  pod: 0.00,   leaf: .70, litter: 0,   frost: 0,   ice: 0 },
  //  立夏「立叶 4–5 片仍稀疏 + **1–2 个尖尖花苞**」⇒ bud .22×9=2、lotus 0（**只有苞，没有花**）。
  //  ⚠️ 原值 lotus:.3（2 朵全开）⇒ 立夏就开花，比规范早一档。
  //  ⚠️⚠️ **规范内部的一处张力，本轮按可实现的方式处理并留记录**：
  //  规范说立夏「立叶 4–5 片仍稀疏」，但同一张表说谷雨「浮叶增多」——
  //  **「立叶」（挺出水面的叶柄叶）与「浮叶」（贴水钱叶/圆浮叶）是两种叶**，
  //  而档案只有一个 `leaf` 通道把它们合并了，所以「4–5 片立叶」无法与
  //  「谷雨已有十几片浮叶」同时成立。
  //  ⇒ 本轮的处理：立夏 `leaf` 保持与谷雨同档（.68/.70 ≈ 15 片），
  //    **「立叶」的挺水形态留给渲染层**（`drawLotus` 里叶柄高度随物候递进）。
  //  ★ 若将来要严格还原，需要给档案**新增 `standLeaf`（立叶数）通道** ——
  //    那是独立改动，不该顺手塞进本轮。
  立夏: { warmth: .74, lotus: 0, bud: 0.22,  pod: 0.00,   leaf: .68, litter: 0,   frost: 0,   ice: 0 },
  //  小满「立叶 7–8 片 + 花苞 3–4 + **初开 1 朵**」⇒ lotus .21×9=2 档、round 得 2；
  //  取 .12×9=1.08→1 朵（更贴合「初开 1 朵」），苞 .39×9=4。
  小满: { warmth: .80, lotus: .12, bud: 0.39,  pod: 0.00,   leaf: .84, litter: 0,   frost: 0,   ice: 0 },
  //  芒种「初开 2–3 朵，花苞 4–5」⇒ 3 朵 / 5 苞。
  芒种: { warmth: .86, lotus: .34, bud: 0.55,  pod: 0.00,   leaf: .93, litter: 0,   frost: 0,   ice: 0 },
  // ★★★ 峰值档：**大暑**（2026-10-07 物候重排，原在夏至）。
  //   夏至「盛花前夜 · 盛开 3–4 朵，花苞 5–6」⇒ 4 朵 / 6 苞。
  //   ⚠️ 绝不能撞1：夏至与小暑/大暑若都是 .95 以上，round 后会与邻档同朵数
  //     ⇒ 零贡献（`LEAF_MAX` 撞顶是同一类饱和，**靠改 MAX 解决不了**，
  //     只能让档案峰值不撞 1，给邻档留出余量）。
  夏至: { warmth: .99,  lotus: .45, bud: 0.62,  pod: 0.00,   leaf: .95, litter: 0,   frost: 0,   ice: 0 },
  /* ★ 小暑「**盛花期始**」：盛开 5–6 朵、花苞多、荷叶茂密盖水 60%。
   *   lotus .62×9=5.58→**6 朵**；leaf .97×22=21片（盖水约 60%）。 */
  小暑: { warmth: .93,  lotus: .62, bud: 0.40,  pod: 0.05,  leaf: .97, litter: 0,   frost: 0,   ice: 0 },
  /* ★★ 大暑「**盛花顶峰**」：盛开 7–8 朵、荷叶盖水 80%、最深绿。
   *   lotus .88×9=7.92→**8 朵**（全 24 档最多）· leaf 1.00×22=**22 片**（满池）。
   *   ⚠️ `leaf` 撞 1.0 ⇒ 22 片，与小暑 21 只差 1 片。**这是允许的**：
   *     规范明确说大暑「荷叶盖水 80%」本就是满池，
   *     小暑与之的区分靠**花数**（6 vs 8）与**花苞数**（4 vs 3）。
   *   ⚠️ 莲蓬：大暑「开始零星出现」⇒ pod .12×6=1（`POD_MAX` 已从 5 提到 6）。 */
  大暑: { warmth: .90,  lotus: .88, bud: 0.30,  pod: 0.12,  leaf: 1.0, litter: 0,   frost: 0,   ice: 0 },
  /* ★ 立秋「**花始谢**」：盛开 2–3 朵 + **2–3 个绿莲蓬**，荷叶仍密、边缘微焦。
   *   ⇒ 花从 8 朵**退到 3 朵**、莲蓬从 1**升到 3**（花让位给蓬）。
   *   ⚠️ 原值 lotus:.6 ⇒ round 后仍有 5 朵**全开**荷花 =「满池夏荷」，
   //     这正是用户说的「立秋/处暑还留完整夏荷粉花，就是串味根源」。
  //   莲蓬要**绿**（未褐变）—— 视觉由渲染层 `drawLotus` 的 pod 形态承担。 */
  立秋: { warmth: .82,  lotus: .34, bud: 0.18,  pod: 0.50,  leaf: .90, litter: .10, frost: 0,   ice: 0 },
  /* ★ 处暑「**花稀**」：残花 1–2 朵、莲蓬 4–5、荷叶开始泛黄边。
   *   pod .75×6=4.5→**4–5 个**（`POD_MAX` 提到 6 才够表达）。 */
  处暑: { warmth: .76,  lotus: .12, bud: 0.10,  pod: 0.75,  leaf: .75, litter: .30, frost: 0,   ice: 0 },
  /* ★ 白露「**残花**」：荷叶半黄、残花枯瓣、莲蓬褐。
   *   lotus .05⇒1 朵残花；bud .22⇒2 个**残花枯瓣**
   *   （`budKind` 判成 WITHERED，因为 litter=.60 ≥ .30）。 */
  白露: { warmth: .66,  lotus: .05, bud: 0.22,  pod: 0.60,  leaf: .50, litter: .60, frost: 0,   ice: 0 },
  /* ★ 秋分「残荷」：荷叶大半枯黄、莲蓬褐黑、**花全谢**（lotus 归零）。 */
  秋分: { warmth: .58,  lotus: 0, bud: 0.14,  pod: 0.78,   leaf: .32, litter: 1,   frost: 0,   ice: 0 },
  /* ★ 寒露「枯荷」：荷叶卷边褐败、**只剩枯莲蓬梗**。 */
  寒露: { warmth: .48,  lotus: 0, bud: 0.06,  pod: 0.85,   leaf: .20, litter: .9,  frost: .2,  ice: 0 },
  /* ★ 霜降「**霜打枯荷**」：残梗挺立 + 白霜（白霜由 `frost` 通道承担）。 */
  霜降: { warmth: .38,  lotus: 0, bud: 0.00,  pod: 0.72,   leaf: .12, litter: .7,  frost: .8,  ice: .15 },
  //★ `litter`（水面落叶）2026-10-07 修订（用户评审清单 P0-1「擦干净冬季水面残留的橙黄枫叶」）。
  //
  //   原值：立冬 .5 / 小雪 .3 / 大雪 .15 / 冬至 .12 / 小寒 .1 / 大寒 .08
  //   ⇒ **整个冬季水面都在飘橙红秋叶**，大寒最违和（冷蓝水面 + 橙红叶）。
  //
  //   ⚠️ 但不能一刀清零 —— 清单 P2-2 同时要求「立冬补足初冬过程的残荷枯梗」，
  //     两者在立冬这档**直接对立**。裁决依据是参考图 `REF_POND`（第二信源）：
  //       立冬「荷叶大部分枯萎成**褐色**残叶 · 黑褐残茎 · 初霜」← 有残叶，但是褐色
  //       小雪「荷叶**全枯萎成黑褐残茎** · 薄霜 · 无荷花」      ← 残叶已归零
  //   ⇒ 正解是「**立冬留少量枯叶 + 小雪起清零**」，而不是「全冬归零」：
  //     违和感的真正来源是**橙红**（暖色高饱和压在冷蓝/雪白背景上），
  //     数量只是表象。颜色那一刀在 `scenery.js` 的 `leafSprite`（冬季枯叶色）。
  立冬: { warmth: .28, lotus: 0, bud: 0.00,  pod: 0.40,   leaf: .1,  litter: .18, frost: 1,   ice: .4,  deepWinter: .20 },
  //★★ 2026-10-07 荷花物候重排：小雪 `leaf` .05 → **0**（规范「小雪–大寒 水面无叶」）。
  //   原值 .05 ⇒ `Math.round(.05*22)=1` —— 水面还飘着**一片枯荷叶**，
  //   而用户清单明写「现在冬组水面的褐色残荷枯叶应清掉」。
  //   ⚠️ 这条**不是**量具过严：`leaf: .05` 在旧档案里是「小雪刚开始落叶」的连续写法，
  //     但本项目的叶通道画的是**浮在水面上的叶**（不是落叶 `litter`，那个已在小雪归零），
  //     ⇒ 「小雪还有 1 片叶」= **枯荷还浮在水上**，与规范直接冲突。
  //   ★ 同理 `pod`（莲蓬）小雪 .22 ⇒ 1 个，是「水下休眠·冰下不可见」的滞后残留，
  //     但莲蓬是**挺水的枯梗**（霜降/寒露都在画），保留；量具对它 `pod:null` 不判。
  小雪: { warmth: .20, lotus: 0, bud: 0.00,  pod: 0.22,   leaf: 0,   litter: 0,   frost: 1,   ice: .7,  deepWinter: .48 },
  大雪: { warmth: .12, lotus: 0, bud: 0.00,  pod: 0.08,   leaf: 0,   litter: 0,   frost: 1,   ice: 1,   deepWinter: .74 },
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
  冬至: { warmth: .10, lotus: 0, bud: 0.00,  pod: 0.05,   leaf: 0,   litter: 0,   frost: 1,   ice: 1,   deepWinter: .90 },
  小寒: { warmth: .05, lotus: 0, bud: 0.00,  pod: 0.03,   leaf: 0,   litter: 0,   frost: 1,   ice: 1,   deepWinter: 1.0 },
  大寒: { warmth: .02, lotus: 0, bud: 0.00,  pod: 0.02,   leaf: 0,   litter: 0,   frost: 1,   ice: .95, deepWinter: .97 },
  // ★★ 2026-10-07 新增 `rain`（雨势）维（P2-2「雨水不下雨」）。
  //   ★ 为什么雨势必须挂在**节气档案**上，而不能挂在 `weather` 上：
  //     `drawWeather` 里雨是**天气门控**（`weather==='rainy'`），而天气来自
  //     城市天气 API 或用户设置 ⇒「这一档该下雨」这件事被交给了天气。
  //     于是「演示轮转到雨水却没下雨」—— 正是清单点出的问题。
  //   ⇒ 正解与降雪同构（`pond.js` 已有先例）：**天气决定「要不要更猛」，
  //     节气决定「有没有」**。雪片数在非 snowy 天气也按 `ice` 连续插值，
  //     雨同理：雨天在此基础上加量，非雨天只要 `rain>0` 就画。
  //   取值依据（参考图 `REF_POND`）：雨水「残雪初融·水底新芽」= 湿冷有雨，
  //   而惊蛰「嫩绿新叶展开」= 雨季未至、只有零星细雨 ⇒ 显著低于雨水。
  立春: { warmth: .30, lotus: 0, bud: 0.00,  pod: 0.00,   leaf: 0,    litter: .15, frost: .6,  ice: .45 , deepWinter: .45, rain: .25 },
  // ★★ 2026-10-07 物候重排：雨水/惊蛰的 `bud` 与 `leaf` **双双归零**。
  //   江南物候：立春「藕根萌动·**无叶无花**」→ 雨水「萌动·无叶无花·水面有雨痕」
  //   → 惊蛰「出芽前夜·无叶无花·泥面隐约小绿点」。
  //   ⇒ 这三档的可见物象应该是**空水面**（惊蛰连泥面绿点都还没浮上来），
  //     画面信息全部交给 `rain`（雨水=1 的雨丝）与 `frost`（残雪）。
  //   ⚠️ 旧值 bud .12/.45 + leaf .2/.17 来自参考图「嫩绿新叶展开·零星花苞」，
  //     **与真实物候冲突**（钱叶要到春分才初浮）—— 已按用户裁决归零。
  雨水: { warmth: .40, lotus: 0, bud: 0.00,  pod: 0.00,   leaf: 0,    litter: .1,  frost: .2,  ice: .12 , deepWinter: .12, rain: 1   },
  // ★ leaf 归零（2026-10-07）。此前 .35→.17 的两次调整都是在**错误前提**下做的 ——
  //   当时以为「惊蛰只有芽、到谷雨才铺满」，实际上惊蛰连芽都还没浮出水面。
  惊蛰: { warmth: .50, lotus: 0, bud: 0.00,  pod: 0.00,   leaf: 0,    litter: 0,   frost: 0,   ice: 0, rain: .35 },
});

/** 找不到时的中性档案（比"报错"好：画面照常，只是少了物候细节）。 */
const NEUTRAL = Object.freeze({ warmth: .6, lotus: 0, leaf: .3, litter: .2, frost: 0, ice: 0, rain: 0 });

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
    // ★★ 2026-10-07（P0-2）：`bud` / `pod` 原来**根本没被返回**（用户清单：
    //   「立秋/处暑水面仍残留夏天的粉色荷花和**花苞**」）。
    //   根因就在这里 —— `lotus` 走插值所以荷花会过渡，
    //   而花苞读的是**当前档的原始值**、`bud` 键压根不存在 ⇒ `?? 0` ⇒ 过渡中途凭空消失。
    //   两维都走与 `lotus` 相同的 `mixProfile`（离散切换，过半程整块切）
    //   —— 花苞与莲蓬本来就是「整块显隐」的东西，不该做连续插值
    //   （插一半的花苞/莲蓬在画面上读成「半朵」，是 MEMORY 里记过的反面教训）。
    bud: mixProfile(a.bud, b.bud, t),
    pod: mixProfile(a.pod, b.pod, t),
    leaf: mix(a.leaf, b.leaf, t),
    litter: mix(a.litter, b.litter, t),
    frost: mix(a.frost, b.frost, t),
    ice: mix(a.ice, b.ice, t),
    // ★ `deepWinter` 必须一起插值。它是"冰层序号"（0–1），
    //   漏掉它 ⇒ 从「大雪」渐变到「小雪」时冰的形态会**跳变**而不是过渡，
    //   而这正好是 §八「节气切换用渐变」要避免的东西。
    //   非冬季档位没有这个键 ⇒ 用 0 兜底（`?? 0`），中性档案同理。
    deepWinter: mix(a.deepWinter ?? 0, b.deepWinter ?? 0, t),
    // ★ `rain`（雨势）也必须插值，否则又会重演本轮修掉的 `bud`/`pod` 那个病：
    //   键缺失 ⇒ 读档方 `?? 0` ⇒ **过渡途中雨突然消失**，而不是渐变停。
    //   （MEMORY 的老教训：漏一个键 = 上游算了、下游没人读。）
    rain: mix(a.rain ?? 0, b.rain ?? 0, t),
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
