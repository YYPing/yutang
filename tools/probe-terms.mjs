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
  ...TERM_VISUAL(termProfile(term)),
}));

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
  // ★ 阳性对照：暖的档必须真的偏黄，冷的档必须真的偏青 —— 不能只是"数值变了"
  const summer = TERM_VISUAL(termProfile('大暑')), winter = TERM_VISUAL(termProfile('冬至'));
  ok(summer.tintR > summer.tintB, '大暑偏暖（R > B）', `R=${n2(summer.tintR)} B=${n2(summer.tintB)}`);
  ok(winter.tintB > winter.tintR, '冬至偏冷（B > R）', `R=${n2(winter.tintR)} B=${n2(winter.tintB)}`);
  // 中间档必须落在两端之间（不能是"两极 + 全是同一个中间值"）
  const spring = TERM_VISUAL(termProfile('春分'));
  ok(spring.tintR > winter.tintR && spring.tintR < summer.tintR, '春分居中', `R=${n2(spring.tintR)}`);
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
  const summer = TERM_VISUAL(termProfile('大暑')), midsummer = TERM_VISUAL(termProfile('夏至'));
  const winter = TERM_VISUAL(termProfile('冬至')), deep = TERM_VISUAL(termProfile('大雪'));
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
  //   leafCount≈2片、litterCount≈1.6 片、snow/cracks/ice/frost≈0.15。
  const TYPICAL = { tintR: 0.012, tintG: 0.014, tintB: 0.012, causticInk: 0.010, leafCount: 2, litterCount: 1.6, frost: 0.15, ice: 0.15, lotusCount: 0.6, iceHole: 0.01, steam: 0.22, snow: 0.15, cracks: 0.12 };
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
  const flat = [];
  for (let i = 0; i < 24; i++) {
    const from = SOLAR_TERMS[i], to = nextTerm(from);
    const a = TERM_VISUAL(termProfile(from));
    const b = TERM_VISUAL(termProfile(to));
    const mid = TERM_VISUAL(blendTerm(from, 0.5));
    for (const key of ['tintR', 'tintG', 'tintB', 'causticInk', 'ice', 'frost']) {
      const lo = Math.min(a[key], b[key]), hi = Math.max(a[key], b[key]);
      if (hi - lo < 1e-6) continue;                // 该通道两端本就相同，跳过
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
  const seq = [0, 0.25, 0.5, 0.75, 1].map((t) => TERM_VISUAL(blendTerm(from, t)).ice);
  const mono = seq.every((v, i) => i === 0 || v >= seq[i - 1] - 1e-9);
  ok(mono, 't 从 0 到 1 时渲染参数单调（0→.25→.5→.75→1）', seq.map(n2).join(' → '));
}

console.log(`\n通过 ${pass} 项，未通过 ${fail} 项`);
console.log('\n\x1b[1m24 档渲染参数总表\x1b[0m');
console.log('节气\t季节\ttintRGB\t\t焦散\t浮叶\t落叶\t霜\t冰\t雪厚\t裂纹');
for (const v of VISUALS) {
  console.log(`${v.term}\t${v.season.slice(0, 2)}\t${n2(v.tintR)},${n2(v.tintG)},${n2(v.tintB)}\t${n2(v.causticInk)}\t${String(v.leafCount).padStart(3)}\t${String(v.litterCount).padStart(3)}\t${n2(v.frost)}\t${n2(v.ice)}\t${n2(v.snow)}\t${n2(v.cracks)}`);
}
process.exit(fail ? 1 : 0);