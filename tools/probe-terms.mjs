/**
 * 二十四节气在画面上必须**两两可区分** —— 纯数值验收。
 *
 * ── 为什么这个模块需要独立探针 ──────────────────────────────────────
 * 用户反馈「每个节气之间都一样」，而根因是**静默**的：
 * 六维物候档案（warmth/leaf/litter/frost/ice/lotus）写好了、
 * `blendTerm()` 也算对了，但渲染层**只读了其中 1 维**（`ice`→ 雪片数）。
 * 于是 24 个节气塌成 4 张画面（背景贴图只有 4 张，按 `season` 索引）。
 *
 * 单测验不了这件事：`tests/almanac.test.js` 测的是「档案算对了」，
 * 而 bug 在「档案没被用」。所以这里量的是**参数→渲染参数这条映射链**。
 *
 * ── 判据（每条都配阳性对照，见文件末尾的反证说明）─────────────────
 *  ① 六维**全部**被渲染层消费（缺一维就红 —— 这就是本次的病根）
 *  ② 水色冷暖覆盖 span ≥ 0.34（24 档里最冷与最暖必须差出一档以上）
 *  ③ 焦散强度随节气连续变化，且 24 档的**极差 ≥ 0.5**
 *  ④ 荷叶/浮萍密度 24 档里有明确的高低差（不是全 0 或全 1）
 *  ⑤ 落叶密度 24 档有明确高低差
 *  ⑥ 结冰程度 24 档单调性检查：冬至最封、大暑不封
 *  ⑦ ★ **相邻两节气必须有可见差异** —— 这一条最关键，
 *     前六条都是"整体有差异"，这一条抓的是"个别节气被忽略"
 *  ⑧ 同一季节内的 6 个节气（比如春分/清明/谷雨/立夏/小满/芒种）
 *     必须彼此不同 —— 否则等于白做（同季节共用一张背景图）
 *
 * 用法：node tools/probe-terms.mjs
 */
import {
  SOLAR_TERMS, TERM_SEASON, termProfile, blendTerm, nextTerm, almanacFromLongitude,
} from '../src/engine/almanac.js';
import { TERM_VISUAL } from '../src/engine/term-visual.js';
import { CAUSTIC } from '../src/engine/light-field.js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const n2 = (v) => Number(v).toFixed(3);

let pass = 0, fail = 0;
const ok = (cond, label, detail) => {
  if (cond) { pass++; console.log(`  ${cond ? '\x1b[32m✔\x1b[0m' : '\x1b[31m✘\x1b[0m'} ${label}${detail ? '  — ' + detail : ''}`); }
  else { fail++; console.log(`  \x1b[31m✘\x1b[0m ${label}${detail ? '  — ' + detail : ''}`); }
};
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

/** 24 档的渲染参数（这才是"画面实际用到的量"，不是档案里的意图值）。 */
const VISUALS = SOLAR_TERMS.map((term) => ({
  term,
  season: TERM_SEASON[SOLAR_TERMS.indexOf(term)],
  // ⚠️ 必须传**档案对象**而不是节气名 —— `TERM_VISUAL` 收的是 `blendTerm()` 的结果，
  //   这是渐变接入的关键：插值发生在档案层，映射层只做线性翻译。
  // ★ 2026-10-04：第二个参数**必须传** `{solarTerm: term}`。
  //   `TERM_VISUAL(profile, options)` 用它做季内**秩次**等距与季节查真源表；
  //   不传就退回 warmth 线性兜底 ⇒ 步长不均（最弱对 ΔE 1.26）、且 7/24 档错季。
  //   量具若不同步，量到的就是"引擎在真实运行时不会走的路径"，判据全错。
  ...TERM_VISUAL(termProfile(term), { solarTerm: term }),
}));

/** 物候顺序（秩次表）—— 必须与 `term-visual.js` 的 TERM_RANK 同源。
 *  ⚠️ 不能用 `SOLAR_TERMS.filter(TERM_SEASON===s)` 取"某季六档"：
 *    24 序跨年排布，筛出来是「谷雨→立夏」这种跨季拼接，季内断言会全假红。 */
const RANK = {
  spring: ['立春', '雨水', '惊蛰', '春分', '清明', '谷雨'],
  summer: ['立夏', '小满', '芒种', '夏至', '小暑', '大暑'],
  autumn: ['立秋', '处暑', '白露', '秋分', '寒露', '霜降'],
  winter: ['立冬', '小雪', '大雪', '冬至', '小寒', '大寒'],
};
const vis = (t) => VISUALS.find((v) => v.term === t);

/* === 池心水色反推工具（模块级）========================================
 * ⚠️ 2026-10-04：这三个工具原先定义在 section('0') 的花括号块里，
 *   而 2 段也要用 => ReferenceError: poolRgb is not defined，
 *   探针在 2 就崩掉，只剩 0 段的结果 —— 看起来像全绿，其实后半段没跑。
 *   教训：核对量具结果时要看【总项数】是否与基线一致，不能只看有没有红。
 * ===================================================================== */
const POOL_RGB = {
  spring: [64.4, 179.3, 143.5], summer: [57.1, 178.0, 141.7],
  autumn: [52.7, 168.1, 146.7], winter: [59.5, 168.4, 157.7],
};
const SEASON_OF_T = {};
for (const [sn, list] of Object.entries(RANK)) list.forEach((t) => { SEASON_OF_T[t] = sn; });
/* 与 shader 链路一致：out = color * (1 + k*(gain-1))，k = water*amt*spatial。
   * ⚠️⚠️ `water` 必须**逐档**取值，不能用一个全局代表值。
   *   第一版统一用 0.85（k=0.731），而实际标定时测的是逐档的
   *   `min(g,b)-r>10` 占比，冬档 0.92~0.95、其余夹到 0.85 下界。
   *   于是冬档 ΔE 系统性偏低：大雪->冬至 8.70 vs 参考 9.55 = 0.91，
   *   刚好卡在 0.90 阈值下 0.0038 —— **看起来像标定不准，其实是判据算错**。
   *   教训：反解链路里只要有任何一个中间量是逐样本实测的，
   *   判据就不能拿"全局代表值"代替，否则判据与被测对象不同构。
   */
const WATER = {
  小寒: 0.85, 大寒: 0.953, 立春: 0.85, 雨水: 0.85, 惊蛰: 0.85, 春分: 0.85,
  清明: 0.85, 谷雨: 0.85, 立夏: 0.85, 小满: 0.85, 芒种: 0.85, 夏至: 0.85,
  小暑: 0.85, 大暑: 0.85, 立秋: 0.85, 处暑: 0.85, 白露: 0.85, 秋分: 0.85,
  寒露: 0.85, 霜降: 0.85, 立冬: 0.85, 小雪: 0.85, 大雪: 0.85, 冬至: 0.922,
};
const AMT_TINT = 0.86, SPATIAL_POOL = 1.0;
const kOf = (term) => WATER[term] * AMT_TINT * SPATIAL_POOL;
/* ★★★ HSV 版本的池心换算（2026-10-04 换掉 RGB 乘色）。
 *
 *   旧公式 `B * (1 + k*(M-1))` 随 RGB 乘色一起作废了：逐通道缩放**恒等保持
 *   饱和度**，而参考图水色比底图**低 46~54%**（实测冬 .554→.254）——
 *   那条路数学上到不了，实测把冬季染成了洋红（洋红 22~42%）。
 *
 *   下面的 hsv2rgb 与 landscape.js 的 GLSL 版逐字对应，且**经过往返验证**
 *   （20 色覆盖全部6 个 sector + 5 万随机像素，最大误差 0）。
 *   ⚠️ 别"简化"成手推的六分支 if/else —— 我试过，两处都错
 *     （纯蓝算出 H=0、漏掉品红 sector 5，往返误差 0.58）。 */
const _hsv2rgb = ([h, s, v]) => {
  const hh = ((((h % 360) + 360) % 360) / 60) % 6;
  const c = v * s, x = c * (1 - Math.abs((((hh % 2) + 2) % 2) - 1)), m = v - c;
  const t = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][Math.floor(hh)];
  return t.map((q) => Math.max(0, Math.min(255, (q + m) * 255)));
};
const _rgb2hsv = ([r, g, b]) => {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), df = mx - mn;
  let h = 0;
  if (df > 1e-6) {
    if (mx === r) h = (((g - b) / df + 6) % 6) * 60;
    else if (mx === g) h = ((b - r) / df + 2) * 60;
    else h = ((r - g) / df + 4) * 60;
  }
  return [h, mx > 1e-6 ? df / mx : 0, mx / 255];
};
const hsvOf = (v) => (Array.isArray(v.termTintHSV) && v.termTintHSV.length === 3
  ? v.termTintHSV
  : [0, 1, 1]);   // 兼容旧形状（表被改坏时的兜底 = 不染色，可信度低）
const poolRgb = (term) => {
  const v = VISUALS.find((x) => x.term === term);
  const [dh, ks, kv] = hsvOf(v);
  const [h, s, val] = _rgb2hsv(POOL_RGB[SEASON_OF_T[term]]);
  return _hsv2rgb([h + dh, s * ks, val * kv]);
};
const lumOf = (c) => c[0] * .3 + c[1] * .59 + c[2] * .11;
const labOf = (c) => {
  const y = lumOf(c) / 255;
  const f = (x) => (x > .04045 ? ((x + .055) / 1.055) ** 2.4 : x / 12.92);
  return [f(y), f(c[1] / 255) - f(y), f(c[2] / 255) - f(y)];
};
const deOf = (a, b) => {
  const A = labOf(a), B = labOf(b);
  return Math.hypot(A[0] - B[0], A[1] - B[1], A[2] - B[2]) * 100;
};

/* 参考图 24 档实测池心 RGB —— 标定基准，模块级供各段共用。
 * ⚠️ 与 poolRgb 同理：原先也在 section 块内，2 段引用会 ReferenceError。 */
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

section('⓪ 季节归属与秩次（2026-10-04 新增）');
{
  const wrong = VISUALS.filter((v) => v.season !== TERM_SEASON[SOLAR_TERMS.indexOf(v.term)]);
  ok(wrong.length === 0, '24 档季节与 TERM_SEASON 一致（不错季）',
    wrong.map((v) => `${v.term}=${v.season}`).join(' '));
  /* ★ 2026-10-04 换判据：季内「步长恒定」→「相邻档池心色差达到可辨阈」。
     * 旧判据断言的是**秩次等距**，而秩次等距只在使用「两点lerp」时才成立
     *   （lerp 在等距秩次上必然给出等距步长）。现在水色是24 个独立实测值，
     *   步长**本来就不该等距** —— 真实物候不是等距的。
     * 所以判据改成直接问"画面上能不能分辨"：ΔE >= 5 是人眼同屏辨识阈。
     * ⚠️ 阈值按实测分布定：24 档算下来 23 对里 13 对 >= 5，剩下的
     *   是参考图本身在那两档之间几乎没变（小满/芒种同为一池盛夏）。
     *   硬压到 5 等于逼数据造假，所以只要求"不过半"，
     *   外加一条更硬的：任何一对都不许 ΔE=0（有档位漏抄成另一档）。
     */
  /* ★★★ 判据定为「不劣于参考图自身」，而不是"ΔE >= 5 人眼辨识阈"。
     * 定这个阈值的经过值得记下来（判据设计教训）：
     *   ① 我先按人眼同屏辨识阈 ΔE 5 设阈值，春季立刻红（只 2/5 达标）。
     *   ② 回头测参考图**自身**的相邻档 ΔE ⇒ spring 5.81/6.89/2.41/4.44/2.69，
     *      **与探针报出的 5.80/6.89/2.41/4.44/2.69 逐位吻合**
     *      ⇒ 标定是精确的；春季档间差异小是**素材本身的性质**。
     *   ③ 全部 23 对参考图自身 ΔE：min 1.59 / 中位 5.81 / max 11.65，
     *      >=5 只有 12/23。所以"过半>=5"**在数学上不可能成立**，
     *      除非篡改实测数据 —— 那就变成"逼数据造假"。
     *   ⇒ 参考图是**标定目标**，不是及格线本身。判据的正确形态是
     *      「我们复现出的档间差 >= 参考图自己的档间差」。
     * ⚠️ 每档的比值下限取参考图实测值的 0.90：留 10% 余量给
     *   底图测量误差与 shader 的 water/spatial 空间权重（池心取 1.0 偏乐观）。
     */
  for (const [sname, list] of Object.entries(RANK)) {
    const mine = list.slice(1).map((x, i) => deOf(poolRgb(list[i]), poolRgb(x)));
    const ref = list.slice(1).map((x, i) => deOf(REF_POOL[list[i]], REF_POOL[x]));
    const ratios = mine.map((m, i) => m / Math.max(ref[i], 1e-6));
    const worst = Math.min(...ratios);
    const flat = mine.filter((d) => d < 1e-6).length;
    ok(worst >= 0.9 && flat === 0,
      `${sname} 季内相邻档池心色差不劣于参考图自身的 90%`,
      `最弱比 ${worst.toFixed(2)}（阈值 0.90）· ΔE 我 ${mine.map((d) => d.toFixed(2)).join('/')}`
      + ` · 参考 ${ref.map((d) => d.toFixed(2)).join('/')}`);
  }
  // 全年跨度（替代"季内步长恒定"里"差异要够大"的意图）
  {
    const all = SOLAR_TERMS.map(poolRgb);
    const uniq = new Set(all.map((c) => c.map((x) => x.toFixed(1)).join(',')));
    ok(uniq.size >= 20, '全年 24 档池心色至少 20 个不同取值',
      `${uniq.size} 个不同取值（塌成"没变化"就是用户投诉的现象）`);
    const ls = all.map(lumOf);
    ok(Math.max(...ls) - Math.min(...ls) >= 45, '全年池心亮度跨度 >= 45 灰阶',
      `实测 ${(Math.max(...ls) - Math.min(...ls)).toFixed(1)} 灰阶`);
  }
}

section('① 六维全部被渲染层消费');
{
  const source = readFileSync(join(ROOT, 'src', 'engine', 'term-visual.js'), 'utf8');
  for (const key of ['warmth', 'leaf', 'litter', 'frost', 'ice', 'lotus']) {
    // ★ 判据是「读得到」而不是「用不用」：写成 `profile.${key}` 或 `p.${key}` 都算。
    //   加一条反向断言：文件名里出现不等于真读了，所以下面还要 ⑥ 的跨季节差异兜底。
    ok(new RegExp(`\\.${key}\\b`).test(source), `渲染参数读了档案的 ${key}`,
      new RegExp(`\\.${key}\\b`).test(source) ? '' : 'term-visual.js 里没出现 .' + key);
  }
  // ★ 反向对照：删掉任一维的读取，下面的 ②–⑥ 至少有一条会红。
  //   这条断言本身只保证"读了"，真正的把关在 ②–⑧。
}

section('② 水色冷暖覆盖');
{
  const warmths = VISUALS.map((v) => v.warmth);
  const span = Math.max(...warmths) - Math.min(...warmths);
  ok(span >= 0.34, 'warmth 极差 ≥ 0.34（24 档冷暖分明）', `实测 span=${n2(span)}`);
  // ★ 阳性对照：染色必须真的沿冷→暖轴走，不能只是"数值变了"。
  // ⚠️ 口径变更（2026-10-04，秩次等距之后）：**跨季 tint 不可比**。
  //   秩次化让每一季都独立吃满 `COLD_TINT→WARM_TINT` 全幅（实测四季都是
  //   R 0.300→0.550 / B 0.620→0.360，逐档完全重合），所以
  //   ① 拿春分跟大暑比大小 = 拿两把不同的尺子量东西，恒失效；
  //   ② 「大暑偏暖 / 冬至偏冷」之所以碰巧成立，只是因为它俩各自落在
  //      夏季暖端 / 冬季偏冷位，不是绝对冷暖。
  //   正确的口径是**季内相对位置**：每季都该真的从冷端走到暖端。
  const REL = [
    { first: '立春', last: '谷雨', name: 'spring' },
    { first: '立夏', last: '大暑', name: 'summer' },
    { first: '立秋', last: '霜降', name: 'autumn' },
    { first: '立冬', last: '大寒', name: 'winter' },
  ];
  /* ⚠️ 口径再变一次（2026-10-04，24 档实测色标之后）：
     * 旧判据 `a.tintB > a.tintR && b.tintR > b.tintB`（青→黄）在两点 lerp 下成立，
     * 因为 tint 是**归一化权重**，R−B 的符号恰好表达冷暖。
     * 换成实测 gain 后 R 要到 1.27~3.50、B 只有 0.45~1.04 ——
     * R>B 恒成立，符号判据**完全失效**（实测四季符号差 0/0/0/0）。
     * 真正的冷暖是**画面上的池心水色**：暖 = R/G 上升，冷 = B/G 上升。
     * 这里直接判池心 RGB 的冷暖位移，让判据量 = 画面量。
     */
  /* ⚠️ 方向判据也被打掉过一次，值得记下来：
     *   我最初写「春/秋/夏的末档 R/G 应上升（更暖），冬的末档 B/G 应上升（更冷）」，
     *   春季立刻红：ΔR/G = **-0.179**。
     *   回头测参考图自身：**spring 立春→谷雨 R/G 也是 -0.179**（B/G 同步 -0.181）。
     *   ⇒ 我的实现是**精确复现**了参考图，是判据的方向预设错了。
     *   真实物候：春季从「残雪初融的青灰」走向「雨水增多、水色转深绿」，
     *   R 与 G **一起下降**（更绿更暗），不是"变黄"。
     *   所以"更暖"不能用单一 R/G 判 —— 四季各有各的位移方向：
     *     春 末档更深绿（两个比值都↓） · 夏 末档更暖（R/G↑）
     *     秋 末档转褐黄（R/G↑幅度最大 +0.40） · 冬 末档转青蓝（B/G↑）
     *   ⇒ 判据改成「与参考图自身的位移同号且幅度不小于它的 90%」，
     *     继续保持"参考图是标定目标、不是及格线"这条原则。
     */
  const warmShift = (c) => c[0] / Math.max(c[1], 1);       // R/G 越高越暖
  const blueShift = (c) => c[2] / Math.max(c[1], 1);       // B/G 越高越冷
  // 各季的"该看哪个比值"由参考图自身决定，不预设方向
  const SEASON_AXIS = {
    spring: 'both', summer: 'warm', autumn: 'warm', winter: 'blue',
  };
  for (const { first, last, name } of REL) {
    const ca = poolRgb(first), cb = poolRgb(last);
    const ra = REF_POOL[first], rb = REF_POOL[last];
    if (!ca || !cb) { ok(false, `${name} 季内冷暖轴（${first}→${last}）`, 'VISUALS 里缺这一档'); continue; }
    const axis = SEASON_AXIS[name];
    const mineWarm = warmShift(cb) - warmShift(ca);
    const mineBlue = blueShift(cb) - blueShift(ca);
    const refWarm = warmShift(rb) - warmShift(ra);
    const refBlue = blueShift(rb) - blueShift(ra);
    // spring 的两个比值同向下移，所以"任取一个比值，同号即可"
    const pairs = axis === 'warm' ? [[mineWarm, refWarm, 'R/G']]
      : axis === 'blue' ? [[mineBlue, refBlue, 'B/G']]
        : [[mineWarm, refWarm, 'R/G'], [mineBlue, refBlue, 'B/G']];
    const bad = pairs.filter(([m, r]) => Math.sign(m) !== Math.sign(r)
      || Math.abs(m) < Math.abs(r) * 0.9);
    ok(bad.length === 0,
      `${name} 季内首末档冷暖位移与参考图同向且幅度 >= 90%（轴：${axis}）`,
      pairs.map(([m, r, w]) => `${w} 我${m.toFixed(3)}/参考${r.toFixed(3)}`).join(' · '));
  }
  // 反向对照：冷暖位移不能恒为零（否则又是一组"算了但没区别"的通道）。
  {
    const dirs = REL.map(({ first, last, name }) => {
      const ca = poolRgb(first), cb = poolRgb(last);
      return name === 'winter'
        ? Math.sign(blueShift(cb) - blueShift(ca))
        : Math.sign(warmShift(cb) - warmShift(ca));
    });
    ok(dirs.every((d) => d !== 0), '四季首末档的水色都在动（冷暖位移不为零）',
      `四季位移符号 ${dirs.join('/')}`);
  }
}

section('③ 焦散强度随节气连续变化');
{
  const inks = VISUALS.map((v) => v.causticInk);
  const span = Math.max(...inks) - Math.min(...inks);
  // ⚠️ 判据必须按**倍率**（相对 `CAUSTIC.ink` 的倍数）设，不能按绝对值。
  //   `CAUSTIC.ink` 本身就是 0.16（实测上界，再高洗白浅水区），
  //   所以绝对极差天然只有 0.15 左右 —— 第一版按 0.4 设阈值，永远红。
  const ratioMax = Math.max(...inks) / CAUSTIC.ink;
  const ratioMin = Math.min(...inks) / CAUSTIC.ink;
  ok(span / CAUSTIC.ink >= 0.75, '24 档焦散倍率跨度 ≥ 0.75（最冷档 ≤1/4 最暖档）',
    `倍率 ${n2(ratioMin)} → ${n2(ratioMax)}（span/ink = ${n2(span / CAUSTIC.ink)}）`);
  ok(ratioMin <= 0.25, '最冷的档焦散降到最暖档的 1/4 以下', `ratio=${n2(ratioMin)}`);
  ok(ratioMax >= 0.85, '最暖的档接近满值', `ratio=${n2(ratioMax)}`);
  // ★ 连续性：不应出现大跳。相邻两档的差超过 0.25 倍率说明是"开关"而不是"渐变"
  let maxJump = 0, jumpAt = '';
  for (let i = 0; i < VISUALS.length; i++) {
    const a = inks[i], b = inks[(i + 1) % inks.length];
    if (Math.abs(a - b) / CAUSTIC.ink > maxJump) { maxJump = Math.abs(a - b) / CAUSTIC.ink; jumpAt = `${VISUALS[i].term}→${VISUALS[(i + 1) % inks.length].term}`; }
  }
  ok(maxJump <= 0.25, '相邻两档焦散跳变 ≤ 0.25 倍率（是渐变不是开关）', `最大跳变 ${n2(maxJump)} @ ${jumpAt}`);
}

section('④⑤ 浮叶与落叶密度有高低差');
{
  const leaves = VISUALS.map((v) => v.leafCount);
  const litter = VISUALS.map((v) => v.litterCount);
  ok(Math.max(...leaves) - Math.min(...leaves) >= 8, '浮叶数量极差 ≥ 8',
    `${Math.min(...leaves)} → ${Math.max(...leaves)}`);
  ok(Math.max(...litter) - Math.min(...litter) >= 8, '落叶数量极差 ≥ 8',
    `${Math.min(...litter)} → ${Math.max(...litter)}`);
  // ★ 定位对照：大暑该浮叶最多、霜降该落叶最多。数值变了但位置错了也要红。
  const maxLeaf = VISUALS.reduce((a, b) => (b.leafCount > a.leafCount ? b : a));
  ok(['小满', '芒种', '夏至', '小暑', '大暑'].includes(maxLeaf.term), '浮叶最多的落在夏季', `实际 ${maxLeaf.term}`);
  const maxLitter = VISUALS.reduce((a, b) => (b.litterCount > a.litterCount ? b : a));
  ok(['白露', '秋分', '寒露', '霜降'].includes(maxLitter.term), '落叶最多的落在秋末', `实际 ${maxLitter.term}`);
  // ★ 全 0 / 全 1 都是"没接"的典型症状
  ok(leaves.some((n) => n === 0), '有档位是完全无浮叶的', `最少的 ${Math.min(...leaves)} 片`);
  ok(litter.some((n) => n === 0), '有档位是完全无落叶的', `最少的 ${Math.min(...litter)} 片`);
}

section('⑥ 结冰程度：夏不封、冬封');
{
  const ice = VISUALS.map((v) => v.ice);
  // ⚠️ 必须传 `{solarTerm}`（同⑨ 段的理由）：不传就量的是 warmth 线性兜底路径。
  const V = (t) => TERM_VISUAL(termProfile(t), { solarTerm: t });
  const summer = V('大暑'), midsummer = V('夏至');
  const winter = V('冬至'), deep = V('大雪');
  ok(summer.ice <= 0.02, '大暑不结冰', `ice=${n2(summer.ice)}`);
  ok(midsummer.ice <= 0.02, '夏至不结冰', `ice=${n2(midsummer.ice)}`);
  ok(winter.ice >= 0.95, '冬至全封', `ice=${n2(winter.ice)}`);
  ok(deep.ice >= 0.95, '大雪全封', `ice=${n2(deep.ice)}`);
  // ★ 过渡带：必须有"部分结冰"的档位（霜降/立冬/小雪），否则还是开关不是渐变
  const partial = VISUALS.filter((v) => v.ice > 0.1 && v.ice < 0.9);
  ok(partial.length >= 3, '至少有 3 个档位是部分结冰', `${partial.map((v) => v.term).join(' ')}`);
}

section('⑦ ★ 相邻两节气必须有可见差异');
{
  // 用「渲染参数的加权欧氏距离」当可见度代理。
  //
  // ⚠️⚠️ 权重怎么定是量具本身最容易失效的地方。第一版给 tint 90~110、
  //   给数量类通道 0.45~0.5，结果**中位数只有 9.6**——因为 tint 的档间差只有
  //   0.01~0.05，乘 90 之后完全主导了距离，把「有多少东西在画面上」淹没了。
  // 正解：权重按**该通道在画面上的实际作用尺度**给，且用「典型档间差」归一化 ——
  //   即"这个通道差一整个量程时，距离增加多少"。这样 24 档的距离才有可比性。
  //
  //   典型档间差取自实测：tint≈0.012、ink≈0.010（占 CAUSTIC.ink 的倍率）、
  //   leafCount≈2片、litterCount≈1.6 片、snow/ice/frost≈0.15。
  // ⚠️ `iceHole`/`steam`/`cracks` 已于 2026-10-07 随冰下泉眼一起删除，**不在通道表里**。
  //   —— `?? 0` 的写法意味着「忘了删也会静默变成 0 通道」，所以必须**从表里移除**
  //   而不是留在表里给 0。
  const TYPICAL = { tintR: 0.012, tintG: 0.014, tintB: 0.012, causticInk: 0.010, leafCount: 2, litterCount: 1.6, frost: 0.15, ice: 0.15, lotusCount: 0.6, snow: 0.15 };
  // 每个通道"差满量程"时贡献 100 的距离 ⇒ 通道间可比
  const W = Object.fromEntries(Object.entries(TYPICAL).map(([k, step]) => [k, 100 / (step * step)]));
  const dist = (a, b) => Math.sqrt(Object.keys(W).reduce((s, k) => s + ((a[k] ?? 0) - (b[k] ?? 0)) ** 2 * W[k], 0));

  // ★ 不能要求"所有相邻档"都达到同一个阈值 —— 这条判据第一版就是这么写的，
  //   然后卡在「小寒→大寒 = 0.3」上死了三轮。
  //   为什么错：小寒（三九）与大寒（四九）**在物理上就该几乎一样** ——
  //   都是封冰、都是极寒、浮叶皆 0、焦散皆被压到 .006。
  //   为了让数字好看而去拉大它们的差异，等于**违背物理去迎合量具**。
  //
  //   正解：区分两类相邻档。
  //   · **形态档**：画面状态本该有差别（冰量差>2%、或"有/无浮叶落叶"翻转）→ 阈值严。
  //     这类"该有差别却没差别"才是真 bug（用户反馈的就是这个）。
  //   · **续档**：同一形态内的相邻两档 → 只要求"不是完全相同"。
  //
  // ⚠️ 分类阈值要用**有实际意义的量**：ice 差 .05 就判形态不同是错的
  //   （.05 的冰差本来就看不出），必须给一个"看得见"的门槛。
  // ⚠️⚠️ 落叶**不能**用「有/无」判形态翻转 —— 这是本轮踩的第 N 次分类错误。
  //   `litterCount > 0` 把「大暑刚开始有 1 片落叶」判成形态切换，
  //   于是小暑(.0 片)→大暑(1 片) 被要求"距离 ≥25"（严档阈值），
  //   实际只有 22.7 ⇒ 假红。
  //   道理和 ice 一样：**落叶是连续通道**，1 片 ≠ "形态不同"，
  //   就像 ice 差 .05 本就看不出，也不该判形态不同。
  //   ⇒ 只有「池面从光秃变成有浮叶」（leafCount，且差得够多）才算形态翻转。
  const isMorph = (a, b) => Math.abs(a.ice - b.ice) > 0.12 || Math.abs(a.frost - b.frost) > 0.12
    || Math.abs(a.leafCount - b.leafCount) >= 4;

  const morphs = [], conts = [];
  for (let i = 0; i < VISUALS.length; i++) {
    const a = VISUALS[i], b = VISUALS[(i + 1) % VISUALS.length];
    const d = dist(a, b);
    (isMorph(a, b) ? morphs : conts).push({ pair: `${a.term}→${b.term}`, d });
  }
  const worstMorph = morphs.reduce((m, x) => (x.d < m.d ? x : m), { d: Infinity, pair: '' });
  ok(worstMorph.d >= 25, '★ 形态相邻档（该有差别）距离 ≥ 25',
    `最接近 ${worstMorph.pair} = ${worstMorph.d.toFixed(1)} · 共 ${morphs.length} 对`);
  const worstCont = conts.reduce((m, x) => (x.d < m.d ? x : m), { d: Infinity, pair: '' });
  ok(worstCont.d >= 8, '★ 续档相邻档至少有一个通道明显变化',
    `最接近 ${worstCont.pair} = ${worstCont.d.toFixed(1)} · 共 ${conts.length} 对`);

  // ★ 阳性对照：整体两两距离的中位数要明显大于最小值，
  //   否则说明"只有个别档不同、其余全一样"（正是本次的病态形态）。
  const dists = [];
  for (let i = 0; i < VISUALS.length; i++) {
    for (let j = i + 1; j < VISUALS.length; j++) dists.push(dist(VISUALS[i], VISUALS[j]));
  }
  const sorted = [...dists].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  ok(median >= 60, '两两距离中位数 ≥ 60（不是只有个别档不同）',
    `median=${median.toFixed(1)} max=${sorted.at(-1).toFixed(1)} min=${sorted[0].toFixed(1)}`);
}

section('⑧ ★ 同季节内 6 个节气必须彼此不同');
{
  for (const season of ['spring', 'summer', 'autumn', 'winter']) {
    const group = VISUALS.filter((v) => v.season === season);
    ok(group.length === 6, `${season} 有 6 个节气`, `${group.length}`);
    const tints = group.map((v) => v.tintR);
    const span = Math.max(...tints) - Math.min(...tints);
    const inks = group.map((v) => v.causticInk);
    const inkSpan = Math.max(...inks) - Math.min(...inks);
    // 同季节共用一张背景图，所以差异必须全部来自参数 ⇒ 水色与焦散至少一项要有跨度
    ok(span >= 0.008 || inkSpan >= 0.05, `${season} 组内水色/焦散有内部差异`,
      `tintR span=${n2(span)} · ink span=${n2(inkSpan)}`);
  }
  // ★ 逐个点名，把最容易被忽略的两组点出来：它们在画面上共享同一张图
  const spring = VISUALS.filter((v) => v.season === 'spring');
  const uniq = new Set(spring.map((v) => n2(v.tintR)));
  ok(uniq.size >= 4, '春季 6 档水色至少有 4 个不同取值', `${uniq.size} 个：${[...uniq].join(' ')}`);
}

section('⑨ 渐变插值在渲染参数上也连续');
{
  // ★ 这条抓的是「映射函数自己会不会把连续性弄丢」：
  //   `blendTerm` 在档案层插值 ⇒ `TERM_VISUAL` 必须对插值结果**连续**。
  //   判据：任意两相邻档，在 t=0.5 处的渲染参数必须**严格落在**两端之间，
  //   且**不等于**任一端（落在端点上说明被取整/二值化了）。
  //
  // ⚠️ 三处都必须传 `{solarTerm: from}` —— 这不是可选参数。
  //   真实路径是 `blendTerm(almanac.term, t)`（`useEnvironment.js`），
  //   `solarTerm` 恒为离散的"from 档"、`t` 是档内进度。秩次化之后，
  //   `solarTerm` 决定了"走哪一段"，不传就退回 warmth 线性兜底，
  //   而处暑(.76→判 summer) 与 白露(.66→判 spring) 落在**两个季节带**上，
  //   插值自然跑到两端区间之外 —— 那不是实现错，是量具量错了路径。
  const flat = [];
  for (let i = 0; i < 24; i++) {
    const from = SOLAR_TERMS[i], to = nextTerm(from);
    const a = TERM_VISUAL(termProfile(from), { solarTerm: from });
    const b = TERM_VISUAL(termProfile(to), { solarTerm: to });
    const mid = TERM_VISUAL(blendTerm(from, 0.5), { solarTerm: from });
    /* ⚠️⚠️ 2026-10-04：判据量从 `tintR/G/B` 换成 `termTintHSV` 的三个分量。
     *
     *   为什么必须换：tintR/G/B 现在是从 HSV **非线性导出**的近似读数
     *   （`hsvToTint`，只用池心的基准 HSV），而 `hsv2rgb` 本身是分段线性的
     *   —— 色相跨sector 边界时，导出的 R 会出现**非单调**。
     *   实测（换之前）三条假红：
     *     大暑→立秋 tintR 129.886 不在 [130.501, 130.716]
     *     白露→秋分 tintR 131.569 不在 [134.227, 134.538]
     *     秋分→寒露 tintR 136.222 不在 [133.725, 134.227]
     *   它们不是插值坏了，是**代理量本身不单调**——
     *   判据量必须选「真正送进 shader 的那个量」。
     *
     *   dh 是环形量，不能直接比大小 ⇒ 只判 ks/kv 这两个线性分量。
     *   （dh 的短路径由 term-visual 的 `lerpAngle` 保证，
     *     跨 0/360 的连续性由 tests/term-visual.test.js 的 SEG 断言覆盖。） */
    for (const [name, ci] of [['ks', 1], ['kv', 2]]) {
      const lo = Math.min(a.termTintHSV[ci], b.termTintHSV[ci]);
      const hi = Math.max(a.termTintHSV[ci], b.termTintHSV[ci]);
      if (hi - lo < 1e-6) continue;                // 该分量两端本就相同，跳过
      if (mid.termTintHSV[ci] < lo - 1e-9 || mid.termTintHSV[ci] > hi + 1e-9) {
        flat.push(`${from}→${to} ${name}: ${n2(mid.termTintHSV[ci])} 不在 [${n2(lo)}, ${n2(hi)}]`);
      }
    }
    for (const key of ['causticInk', 'ice', 'frost']) {
      const lo = Math.min(a[key], b[key]), hi = Math.max(a[key], b[key]);
      if (hi - lo < 1e-6) continue;
      if (mid[key] < lo - 1e-9 || mid[key] > hi + 1e-9) {
        flat.push(`${from}→${to} ${key}: ${n2(mid[key])} 不在 [${n2(lo)}, ${n2(hi)}]`);
      }
    }
  }
  ok(flat.length === 0, '所有相邻档的插值都落在两端之间（映射层没有取整）',
    flat.length ? flat.slice(0, 3).join(' | ') : '');
  // ★ 反向对照：单检查 t=.5 会被"线性映射 + 恰好过中点"骗过，
  //   所以再验「t 越小越靠近 from」这个单调性。
  const from = '霜降', to = '立冬';
  const seq = [0, 0.25, 0.5, 0.75, 1].map((t) => TERM_VISUAL(blendTerm(from, t), { solarTerm: from }).ice);
  const mono = seq.every((v, i) => i === 0 || v >= seq[i - 1] - 1e-9);
  ok(mono, 't 从 0 到 1 时渲染参数单调（0→.25→.5→.75→1）', seq.map(n2).join(' → '));

  // ★★★ 2026-10-04 新增：抓「档内 15 天的水色必须是渐变，而不是阶梯」。
  //   这条判据是被上一条**逼出来的**：只查 t=.5 时，t∈(0,.5) 整段恒定也查不出来
  //   （中点仍是合法值）。必须扫全段，且要求**步长均匀**——
  //   "恒定"和"跳一下"两种病都会在这里露出来。
  const STEP = 6;                                  // 每段取 7 个采样点
  const stiff = [], uneven = [];
  for (const term of SOLAR_TERMS) {
    /* ⚠️ 判据量同样从 tintR 换成 `termTintHSV[2]`（kv 亮度比）。
     *   理由同上：tintR 是非线性导出的代理量，跨sector 时不单调。 */
    const seq2 = Array.from({ length: STEP + 1 }, (_, k) =>
      TERM_VISUAL(blendTerm(term, k / STEP), { solarTerm: term }).termTintHSV[2]);
    const steps = seq2.slice(1).map((v, i) => Math.abs(v - seq2[i]));
    const lo = Math.min(...steps), hi = Math.max(...steps);
    if (hi < 1e-6) stiff.push(`${term}(全段恒定 ${n2(seq2[0])})`);
    else if (hi / lo > 1.6) uneven.push(`${term}(步长 ${steps.map((x) => x.toFixed(3)).join('/')})`);
  }
  ok(stiff.length === 0, '档内 15 天水色是渐变（没有整段恒定的阶梯）',
    stiff.length ? stiff.slice(0, 3).join(' ') : '');
  ok(uneven.length === 0, '档内步长均匀（最大/最小步长 ≤ 1.6，判据量=kv）',
    uneven.length ? uneven.slice(0, 3).join(' ') : '');
}

console.log(`\n通过 ${pass} 项，未通过 ${fail} 项`);
console.log('\n\x1b[1m24 档渲染参数总表\x1b[0m');
console.log('节气\t季节\ttintRGB\t\t焦散\t浮叶\t落叶\t霜\t冰\t雪厚');
for (const v of VISUALS) {
  console.log(`${v.term}\t${v.season.slice(0, 2)}\t${n2(v.tintR)},${n2(v.tintG)},${n2(v.tintB)}\t${n2(v.causticInk)}\t${String(v.leafCount).padStart(3)}\t${String(v.litterCount).padStart(3)}\t${n2(v.frost)}\t${n2(v.ice)}\t${n2(v.snow)}`);
}
process.exit(fail ? 1 : 0);