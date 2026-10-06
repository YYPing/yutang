/**
 * 节气 → 底图素材的**显式映射表**（需求 §2.3 第 5 条的第二个选项）。
 *
 * ── 为什么要有这个模块，而不是继续用 `TERM_SEASON` ────────────────
 * 需求原文：素材若按月旬命名（`01-early-jan` …），而切换按节气 ——
 * 「这是两套逻辑，边界日会给出不同的图」，定稿是**一律以节气区间为口径**，
 * 实现方式二选一：① 素材按节气重新编号（1=立春 … 24=大寒）；
 *              ② **在 manifest 内补 `solarTerm` 字段做显式映射**。← 本模块
 *
 * ① 号方案要求把 4 张图改名成 `01.png`…`24.png`（或补 20 张新图），
 * 而 `almanac.js` 的 `TERM_SEASON` 已经承担了「节气 → 四季」的语义；
 * 再叠一层编号等于**第三套命名**。② 号方案把「哪个节气用哪张图」
 * 收到一个数据表里，`TERM_SEASON` 退化为它的兜底，两者不会各说各话。
 *
 * ── 三条不变式（改动前务必读完）──────────────────────────────────
 * ① **声明顺序即优先级，且必须无重叠**。
 *    `BY_TERM` 用 Map.set 逐条写入 ⇒ **后声明的覆盖先声明的**。
 *    这正是补中间档图要的能力（把 `清明` 从 spring 手里接过来），
 *    但它也是**无声覆盖**的来源 —— 所以 `tests/term-images.test.js`
 *    断言「24 档每档恰好被一个条目声明」，重叠即红。
 * ② **`id` 是语义名，`file` 是真实文件名**。
 *    夏天的文件历史上叫 `pond.png`（不是 `summer.png`），
 *    旧代码靠 `season==='summer'?'pond':season` 这个三元硬编码兜住。
 *    本表把这个历史包袱吸收成数据 ⇒ 那个三元可以删掉。
 * ③ **掩膜与纹理都按 `id` 缓存，不按 `season`**。
 *    掩膜是**图**的属性（同一张图的水陆形状与季节无关），
 *    加了中间档图之后同一季节会有两张图 ⇒ 用季节做 key 会串。
 *
 * ── 补中间档图的完整流程（层② 生图落地时只改本表，别碰渲染层）──
 *   ① 把新图存成 `public/assets/term-<节气拼音>.png`（同 3840×2160）；
 *   ② 在下面**追加**一条 `{id:'term-qingming', file:'term-qingming',
 *      v:1, terms:['清明']}`（放在季节条目**之后**才算生效）；
 *   ③ `v` 与旧值不同 ⇒ 浏览器不会命中旧缓存。
 *   渲染层、shader、量具**一行都不用改** —— 这就是本模块存在的意义。
 */

/** 素材版本号。改动文件内容就必须 bump，否则浏览器/CDN 会拿旧图。 */
export const TERM_IMAGE_MANIFEST = Object.freeze([
  { id: 'spring', file: 'spring', v: '1.5', terms: ['春分', '清明', '谷雨', '立春', '雨水', '惊蛰'] },
  { id: 'summer', file: 'pond', v: '1.5', terms: ['立夏', '小满', '芒种', '夏至', '小暑', '大暑'] },
  { id: 'autumn', file: 'autumn', v: '1.5', terms: ['立秋', '处暑', '白露', '秋分', '寒露', '霜降'] },
  { id: 'winter', file: 'winter', v: '1.5', terms: ['立冬', '小雪', '大雪', '冬至', '小寒', '大寒'] },
]);

/* ⚠️ `SOLAR_TERMS` 从 almanac.js 导入会造成循环依赖？
 *   不会 —— almanac.js 不 import 本模块。但为了不让「表错了」这件事
 *   在运行时才暴露，`tests/term-images.test.js` 会交叉核对两者的档位集合。 */
import { SOLAR_TERMS } from './almanac.js';

/** term → 条目。后声明覆盖先声明（见不变式①）。 */
const BY_TERM = (() => {
  const m = new Map();
  for (const entry of TERM_IMAGE_MANIFEST) for (const t of entry.terms) m.set(t, entry);
  return m;
})();

/** season → 条目（兜底用：老存档没有节气名时仍按四季选图）。 */
const BY_SEASON = (() => {
  const m = new Map();
  for (const entry of TERM_IMAGE_MANIFEST) {
    if (entry.terms.length === 6) m.set(entry.id, entry);
  }
  return m;
})();

/** 兜底链的最后一级：manifest 的第一条。它必须是 6 档的季节图。 */
const FALLBACK = TERM_IMAGE_MANIFEST[0];

/**
 * 按节气解析底图素材条目。
 *
 * ★ 降级链（每一步都必须真的可达 —— 见下面「兜底失效」注释）：
 *   节气名命中 manifest → 按 season 兜底（weather==='snowy' 优先 winter）
 *   → manifest 第一条。
 *
 * ⚠️⚠️ 反直觉的坑（与 `Landscape.bgSeason` 同型，已踩过一次）：
 *   **绝不能**写成 `termSeason(solarTerm) || 老逻辑`。
 *   `termSeason()` 在名字找不到时 `return index<0 ? 'summer' : ...`
 *   ——它自己已经兜底成夏天了，于是 `||` 右边永远不执行，
 *   降级路径成了死代码，老存档（无节气）被静默按夏天选图。
 *   正解：**先查表判命中**（`BY_TERM.get` 返回 undefined 就是没命中），
 *   再走降级链。这样每一级都真的可达。
 *
 * @param {{solarTerm?:string, season?:string, weather?:string}} options
 * @returns {{id:string,file:string,v:string,terms:readonly string[],source:string}}
 *   `source` 便于量具/排障确认这张图是**怎么**被选中的：
 *   `'term'` = 精确命中节气 · `'weather'` = 天气兜底 · `'season'` = 季节兜底
 *   · `'fallback'` = manifest 首条兜底。
 */
export function resolveTermImage(options) {
  const term = options?.solarTerm;
  if (term) {
    const hit = BY_TERM.get(term);
    if (hit) return withSource(hit, 'term');
  }
  const season = options?.weather === 'snowy' ? 'winter' : options?.season;
  if (season) {
    const hit = BY_SEASON.get(season);
    if (hit) return withSource(hit, options?.weather === 'snowy' ? 'weather' : 'season');
  }
  return withSource(FALLBACK, 'fallback');
}

/** 附上解析来源。用浅拷贝，不污染冻结的 manifest。 */
function withSource(entry, source) {
  return { id: entry.id, file: entry.file, v: entry.v, terms: entry.terms, source };
}

/** manifest 里全部条目（构造时预热底图用 —— 别处不能用 TERM_IMAGE_MANIFEST 之外的清单）。 */
export function allTermImages() {
  return TERM_IMAGE_MANIFEST;
}

/** 素材 URL。与旧代码的 `?v=1.5` 缓存破坏机制一致，只是版本搬进了数据。 */
export function termImageURL(base, entry) {
  return `${base}assets/${entry.file}.png?v=${entry.v}`;
}

/**
 * 编译期/测试期的自检：manifest 的节气覆盖是否与 `SOLAR_TERMS` 一致。
 * 运行时**不调用**（抛错会让老存档直接白屏）；只在护栏里断言。
 * @returns {{missing:string[], unknown:string[]}} 都为空才健康
 */
export function auditTermImages() {
  const declared = new Set();
  for (const entry of TERM_IMAGE_MANIFEST) for (const t of entry.terms) declared.add(t);
  return {
    missing: SOLAR_TERMS.filter((t) => !declared.has(t)),
    unknown: [...declared].filter((t) => !SOLAR_TERMS.includes(t)),
  };
}