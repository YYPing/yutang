/**
 * 相邻档**真正送进 shader 的量**的三元距离（2026-10-08，层② 附带发现）。
 *
 * ★★★ 为什么这个文件存在 —— 它推翻了我自己上一句话。
 *
 * 我在 `analyze-texture-gaps.mjs` 里说「大寒→立春 的 warmth 台阶 0.28 是四组边界里
 * 最大 ⇒ 该调 TERM_TINT_HSV」。**那个结论用的是代理量。**
 *
 * ⚠️ `warmth` 是「气温」，它只用于**选底图与决定浮叶/立叶数量**；
 *   真正送进 shader 决定水色的是 `TERM_TINT_HSV` 的三元组 `(dh, ks, kv)`
 *   （`landscape.js` 的 `uTermHSV`）。所以「warmth 台阶大」**推不出**
 *   「水色跳变大」。这与 MEMORY 里 `tintR`（非线性代理量）那条是同一型，
 *   本项目已栽过：判据量选错 ⇒ 排序精细但无意义。
 *
 *   ★ 而且更可能出错的方向是**反的**：霜降(-130.85) → 立冬(-20.85)
 *     的 dh 跨度是 +110（沿短路径），远大于大寒(31.63) → 立春(-7.74) 的 -39.37。
 *     若只看 warmth，这两处的次序**完全被排错了**。
 *
 * 距离怎么算：
 *   · `dh` 必须走 `lerpAngle` 的**环形短路径**（与 shader 同一函数）——
 *     直接相减会在跨±180 处把 +235 的旋转算成 -125，方向就反了。
 *   · 三项加权：ks（饱和压缩）与 kv（明度缩放）各自决定「压得多狠」，
 *     实测同季中位 ΔE 0.06→5.12，主要就是这两项 ⇒ 权重相同。
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SOLAR_TERMS } from '../src/engine/almanac.js';

/* ⚠️ `TERM_TINT_HSV` 与 `TERM_TINT_BY_NAME` **都没有export** —— 它们是模块私有。
 *   这里**不**为了量具去加导出（那会让工具反向依赖渲染层的导出面，
 *   将来有人重构改内部结构就得同步改量具）。改为从源码**反查**——
 *   与 `analyze-texture-gaps.mjs` 读 manifest 是同一个做法：**真源只认一处**。
 * ⚠️ 反查的代价：如果有人把表格改成别的写法（比如换行插中间注释），这里会读成空。
 *   所以下面断言必须**读满 24 档**才算通过，宁可报错也不许静默少读。 */
const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/engine/term-visual.js'), 'utf8');
const TERM_TINT_BY_NAME = new Map();
/* ⚠️ 数字前必须留 `\s*`：表里为了对齐写的是 `'立春',   -7.74, 0.295, 0.862`
 *   （逗号后有 3 个空格）。
 *
 * ⚠️⚠️ 节气名是**两个字**（立春/雨水/小满…），所以节气名这一段必须写 `(.+?)`
 *   而不是 `(.)`。第一版写的`(.)` 只吃**一个**字符 ⇒ 要求`['立`后面紧跟一个 `'`
 *   ⇒ 整表 0 匹配。而**它当时没有报红**，因为我把断言写在了读表**之后**、
 *   而报错信息只提到"表格写法变了"—— 那句提示把我引向了「正则写法变了」，
 *   而不是「正则写错了」。⇒ **报错文案会引导排查方向**，文案写偏了比不写更贵。
 *   第��版还用了 `(.)` 又写成 `(.{1,4}?)`，两处都先量了「到底几个字符」
 *   才敢写：节气名恒为 2 字，用 `{2}` 而不是 `+`（`+` 会把后面带空格注释的行也吃进来）。
 */
for (const m of SRC.matchAll(/\['(..)'\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\]/g)) {
  TERM_TINT_BY_NAME.set(m[1], [Number(m[2]), Number(m[3]), Number(m[4])]);
}
if (TERM_TINT_BY_NAME.size !== 24) {
  throw Error(`从 term-visual.js 反查 TERM_TINT_HSV 应得 24 档，实得 ${TERM_TINT_BY_NAME.size} `
    + `—— 表格写法变了，本探针失效（这是**故意的报错**，不是静默少读）`);
}

/** 与 shader 里 `lerpAngle` 同一套环形短路径。 */
function angDelta(a, b) {
  let d = ((b - a) % 360 + 540) % 360 - 180;
  return d;
}

const rows = [];
for (let i = 1; i < SOLAR_TERMS.length; i++) {
  const a = SOLAR_TERMS[i - 1], b = SOLAR_TERMS[i];
  const [dhA, ksA, kvA] = TERM_TINT_BY_NAME.get(a);
  const [dhB, ksB, kvB] = TERM_TINT_BY_NAME.get(b);
  const dH = angDelta(dhA, dhB);
  rows.push({ a, b, dh: dH, ks: ksB - ksA, kv: kvB - kvA,
    d: Math.abs(dH) + Math.abs(ksB - ksA) * 100 + Math.abs(kvB - kvA) * 100 });
}

console.log('\x1b[1m① 24 档逐档的 (dh, ks, kv) —— 送进 shader 的真实三元组\x1b[0m');
console.log('  节气    dh       ks     kv');
for (const t of SOLAR_TERMS) {
  const [dh, ks, kv] = TERM_TINT_BY_NAME.get(t);
  console.log(`  ${t.padEnd(2)} ${dh.toFixed(2).padStart(8)}  ${ks.toFixed(3)}  ${kv.toFixed(3)}`);
}

console.log('\n\x1b[1m② 相邻档的跳变量（全部 23 步，按三元距离降序）\x1b[0m');
console.log('  步子Δdh°   Δks    Δkv     三元距离');
for (const r of [...rows].sort((x, y) => y.d - x.d)) {
  const cross = (r.a === '霜降' || r.a === '大暑' || r.a === '谷雨' || r.a === '大寒') ? ' ← 跨季边界' : '';
  console.log(`  ${(r.a + '→' + r.b).padEnd(5)} ${r.dh.toFixed(2).padStart(7)} ${r.ks.toFixed(3).padStart(6)}`
    + ` ${r.kv.toFixed(3).padStart(6)}  ${r.d.toFixed(2).padStart(6)}${cross}`);
}
const worst = rows.reduce((x, y) => (y.d > x.d ? y : x));
console.log(`\n★ 三元距离最大的一步：${worst.a} → ${worst.b}（${worst.d.toFixed(2)}）`);
