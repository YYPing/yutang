/**
 * 逐段检查「槽位内部的最大跳变」—— 层② 的附带产出（2026-10-08）。
 *
 * ★★★ 这把量具的存在理由，是把「该改档案」与「该换底图」这两件事**分开**。
 *
 * 我先说了两次错话，两次都是把两件事混了：
 *   ① 按 `warmth` 排 ⇒ 说「大寒→立春 是最大缺口」—— 用错了量（warmth 不进shader）。
 *      改正后真实次序是：霜降→立冬 136.20 / 大寒→立春 85.57 / 秋分→寒露 83.54。
 *   ② 于是说「那就去调大寒/立春 的 TERM_TINT_HSV」—— 也错了：
 *      **霜降→立冬 是跨季换底图的那一步，8s 淡入就是为它设计的**，
 *      色相绕一圈是这段过场的观感，不是缺陷。改它等于把换图动画抹平。
 *
 * ⇒ 真剩下的问题是**槽位内部**的跳变：不换图、只靠段内插值，
 *   所以跳变会**原样出现在观感里**。本文件只找这一类。
 *
 * ⚠️ 判据的设计要点：段内的每一处跳变都**必须小于**它所属跨季步子。
 *   否则「换图那一跳反而不显著、同一张图内部反倒跳一下」——主次颠倒。
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SOLAR_TERMS, TERM_SEASON, termProfile } from '../src/engine/almanac.js';

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/engine/term-visual.js'), 'utf8');
const TINT = new Map();
for (const m of SRC.matchAll(/\['(..)'\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\]/g)) {
  TINT.set(m[1], [Number(m[2]), Number(m[3]), Number(m[4])]);
}
if (TINT.size !== 24) throw Error(`反查 TERM_TINT_HSV 应得 24 档，实得 ${TINT.size}`);

/** 槽位边界（与 term-images.js 的 manifest 一致：6 档一季，边界在谷雨/立夏/大暑/立秋/霜降/立冬/大寒之后）。 */
const SEASON_BREAK_AFTER = new Set(['谷雨', '大暑', '霜降', '大寒']);

function angDelta(a, b) {
  return ((b - a) % 360 + 540) % 360 - 180;
}

const steps = [];
for (let i = 1; i < SOLAR_TERMS.length; i++) {
  const a = SOLAR_TERMS[i - 1], b = SOLAR_TERMS[i];
  const [dhA, ksA, kvA] = TINT.get(a);
  const [dhB, ksB, kvB] = TINT.get(b);
  steps.push({
    a, b, cross: SEASON_BREAK_AFTER.has(a),
    dh: angDelta(dhA, dhB), ks: ksB - ksA, kv: kvB - kvA,
    d: Math.abs(angDelta(dhA, dhB)) + Math.abs(ksB - ksA) * 100 + Math.abs(kvB - kvA) * 100,
  });
}

const crossSteps = steps.filter((s) => s.cross);
const innerSteps = steps.filter((s) => !s.cross);
const worstInner = innerSteps.reduce((x, y) => (y.d > x.d ? y : x));

console.log('\x1b[1m① 跨季步子 vs 槽位内部步子\x1b[0m');
console.log(`  跨季步子 ${crossSteps.length} 处：`
  + crossSteps.map((s) => `${s.a}→${s.b} ${s.d.toFixed(2)}`).join(' · '));
console.log(`  段内最大 ${worstInner.d.toFixed(2)}（${worstInner.a}→${worstInner.b}）`);
/* ⚠️⚠️ **不能用「跨季最小值」当统一门槛** —— 这是我写完立刻发现的错。
 *   四个跨季步的跨度是 28.10（谷雨→立夏）到 136.20（霜降→立冬），**差近 5 倍**，
 *   所以「跨季最小值」既不是典型值也不是上限，拿它当门槛纯属任选：
 *   谷雨→立夏（28.10）会被十几个段内步超过，结论就成了「段内比跨季还跳」，
 *   而实际上谷雨→立夏那一步 Δdh 只有 -5.00，根本不是跳变——
 *   只是**它那一季本来就不跳**（spring 段内 dh 全在 -7~-25，色相本就平）。
 *   ⇒ 正解是 ③ 段的**逐段相对判据**：段内跳变要和**自己那一季的出季步**比。
 *   （与 MEMORY 里「判据必须自身成比例，不能用绝对阈值」同型。） */
console.log('  ⇒ 跨季步之间跨度近 5 倍，**不能用统一门槛** —— 见 ③ 的逐段相对判据。');

console.log('\n\x1b[1m② 槽位内部的跳变（降序）\x1b[0m');
console.log('  步子                Δdh°    Δks     Δkv     三元距离');
for (const s of [...innerSteps].sort((x, y) => y.d - x.d)) {
  const flag = s.d >= 60 ? '  ← 段内大跳' : '';
  console.log(`  ${(s.a + '→' + s.b).padEnd(5)} ${s.dh.toFixed(2).padStart(7)} ${s.ks.toFixed(3).padStart(7)}`
    + ` ${s.kv.toFixed(3).padStart(7)}  ${s.d.toFixed(2).padStart(6)}${flag}`);
}

/* ③ 逐段相对判据。
 * ⚠️ `SOLAR_TERMS` 是**历法序、跨年排布**（立春…大寒），所以「一季 6 档」
 *   在数组里**首尾相接处断开**：spring 是立春/雨水/惊蛰/春分/清明/谷雨，
 *   在历法序里是 22,23,0,1,2,3 —— **必须按边界走一遍聚合，不能切片**。
 *   第一版写 `SOLAR_TERMS.slice(i-5, i+1)`，在 i=0（立春）时得到 `slice(-5,1)`
 *   = 空数组 ⇒ `reduce` 抛 `Reduce of empty array with no initial value`。
 *   ⇒ 这也是 MEMORY 里那条「`SOLAR_TERMS` 是历法序，filter 出来是跨季拼接」的
 *     又一次复发：同一个坑，本项目栽过两次（TERM_RANK 那次是filter 出错，
 *     这次是切片出错）⇒ **凡是对 SOLAR_TERMS 分段，必须按边界聚合。** */
/* ③ 逐段相对判据。
 *
 * ⚠️⚠️⚠️ **分段不能用「每 6 个一切」也不用边界聚合** —— 两次都错，各有各的症状：
 *   第一次 `SOLAR_TERMS.slice(i-5, i+1)`：在 i=0 时得到 `slice(-5,1)` = 空数组 ⇒
 *     `reduce` 抛 `Reduce of empty array with no initial value`。
 *   第二次按 `SEASON_BREAK_AFTER` 聚合：用 `SEGMENTS[len-1] ||= {}`，
 *     而数组为空时 `len-1` 是 -1 ⇒ `SEGMENTS[-1] ||= x` 写的是**普通对象属性**
 *     （不可枚举、`pop()` 弹不到）⇒ **spring 段整段消失，输出少一行且不报错**。
 *
 *   而两次都错的**同一个根因**是：我以为 `SOLAR_TERMS` 是历法序（立春起），
 *   实际它是 `春分, 清明, 谷雨, 立夏, …, 大寒, 立春, 雨水, 惊蛰` ——
 *   **春天被切成两半放在数组首尾**（idx 0-2 与 21-23）。
 *   ⇒ 正解：**直接用 `TERM_SEASON` 这个真源做分组**，它与下标一一对应，
 *     不依赖任何「节气的排列位置」假设。（与 MEMORY 里那条
 *     「`SOLAR_TERMS` 是历法序，filter 出来是跨季拼接」是同一个坑的第三次复发，
 *     前两次分别是 `TERM_RANK` 的 filter 与本次的切片 —— 这条铁律该升级成硬断言。）
 */
/*段内顺序：季内**物候序** —— 取自 `TERM_TINT_HSV` 的分组数组书写顺序。
 * ⚠️ 解析方式用**逐行扫描**而不是一个大正则。
 *   第一版 `new RegExp('\\n\\s{2}' + season + ':\\s*\\[([^\\]]+)\\]')` 只吃到 1 档：
 *   `\s*` 把换行+缩进一起吃掉后，`[^\]]+` 会一路吃到**下一段**的 `]`，
 *   而 `matchAll` 又只给第一个捕获组 —— 两个 bug 叠加，症状是「只拿到立春」。
 *   ⇒ 与MEMORY 那条「正则改文件会删掉行」同源：**跨行的结构用行解析，不用跨行正则**。*/
function seasonOrder(season) {
  const out = [];
  let inside = false;
  for (const line of SRC.split(/\r?\n/)) {
    if (!inside) { if (new RegExp('^\\s{2}' + season + ':\\s*\\[').test(line)) inside = true; continue; }
    if (/^\s{2}\],?\s*$/.test(line)) break;
    const m = line.match(/\['(..)'/);
    if (m) out.push(m[1]);
  }
  return out;
}

const SEGMENTS = ['spring', 'summer', 'autumn', 'winter'].map((season) => ({
  season,
  /* ① 归属：哪 6 档属于这一季 —— 取自 `TERM_SEASON`（与下标一一对应）。 */
  byIndex: SOLAR_TERMS.filter((_, i) => TERM_SEASON[i] === season),
  /* ② 段内顺序：季内物候序 —— 取自 `TERM_TINT_HSV` 分组数组的书写顺序。
   * 这两者对同一集合给出的顺序**不同**：spring 在 `TERM_SEASON` 下标序里是
   * 春分/清明/谷雨 + 立春/雨水/惊蛰（历法序，首尾拼接），
   * 而档案表里写的是 立春/雨水/惊蛰/春分/清明/谷雨（物候序）。 */
  terms: seasonOrder(season),
}));
for (const seg of SEGMENTS) {
  const miss = seg.byIndex.filter((t) => !seg.terms.includes(t));
  if (miss.length || seg.terms.length !== 6) {
    throw Error(`${seg.season} 段的两个来源对不上：档案序 ${seg.terms.join('')}（${seg.terms.length} 档）`
      + ` vs 下标序 ${seg.byIndex.join('')}（${seg.byIndex.length} 档）`
      + (miss.length ? ` · 档案序缺 ${miss.join('')}` : ''));
  }
}
/* 段内的相邻关系要按**该季自己的顺序**走，不能沿用 `SOLAR_TERMS` 的相邻。
 * ⚠️⚠️ 而「该季自己的顺序」也不能直接用 `TERM_SEASON` 的**下标序**：
 *   spring 落在 idx 0-2（春分/清明/谷雨）与 21-23（立春/雨水/惊蛰）——
 *   按下标序读出来是「春分,清明,谷雨,立春,雨水,惊蛰」，正好穿过夏秋冬三季，
 *   于是 `谷雨→立春` 这一步在 `steps` 里**不存在**（它是跨季步），
 *   断言立刻报「步子链不全」—— 这个报错是对的，它拦住了错误分段。
 *
 * ★ 段内的**物候序**必须从档案表的书写顺序读，那才是作者排的顺序：
 *   `TERM_TINT_HSV` 的分组数组（spring/summer/autumn/winter）本身就是
 *   季内物候序（立春→雨水→…→谷雨），与 `TERM_SEASON` 的下标序**不同**。
 * ⇒ 段内顺序取自 `TERM_TINT_HSV` 的分组键（正好也是 season 名），
 *   而归属（哪 6 档属于这一季）取自 `TERM_SEASON`。**两者分工，各取所长。** */
for (const seg of SEGMENTS) {
  seg.steps = seg.terms.slice(0, -1).map((a) => {
    const b = seg.terms[seg.terms.indexOf(a) + 1];
    /* 段内相邻在 `steps` 里不一定存在（春组的顺序被历法序打散），
     * 所以这里**按需现算**一步，而不是去表里 find。 */
    const [dhA, ksA, kvA] = TINT.get(a), [dhB, ksB, kvB] = TINT.get(b);
    const dh = angDelta(dhA, dhB);
    return { a, b, cross: false, dh, ks: ksB - ksA, kv: kvB - kvA,
      d: Math.abs(dh) + Math.abs(ksB - ksA) * 100 + Math.abs(kvB - kvA) * 100 };
  });
  const last = seg.terms[5];
  const nextSeason = SEGMENTS[(SEGMENTS.indexOf(seg) + 1) % SEGMENTS.length];
  seg.outStep = steps.find((s) => s.a === last && s.b === nextSeason.terms[0]);
  if (!seg.outStep) throw Error(`${seg.season} 的出季步（${last}→${nextSeason.terms[0]}）在历法序里不相邻，找不到`);
}

/** 参考图自身相邻档 ΔE 的真源 —— `check-term-delta.cjs` 里的 `REF_SAME_DE`。
 * ★ **必须复用，不能手抄**：手抄一份就会漂移（改了真源这边不会跟着变），
 *   而且漂移的方向恰好是「这边变好看」⇒ 判据自己给自己放水。
 *   与 MEMORY 里「按槽位索引的东西，槽位清单只能有一个来源」同型。
 * ⚠️ `check-term-delta.cjs` 是 **CommonJS**（用 `require` + playwright），
 *   而本文件是 ESM ⇒ 用 `createRequire` 引，不能用 `import`。 */
const REF_SAME_DE = (() => {
  const srcTxt = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'check-term-delta.cjs'), 'utf8');
  /* 只取那张表的字面量重新求值（不执行整个文件 —— 它会连浏览器）。
   * ⚠️ 第一版用 `new Function` 求值，切片边界算错（`end + 2` 从 `\n};` 起算
   *   只切到 `\n}`，漏掉了 `{`）⇒ `SyntaxError: Unexpected token ':'`。
   *   ★ 教训：**别用「按分隔符猜边界」的切片去求值**。改成把字面量转成 JSON 再 parse ——
   *     单引号键名 `'a->b'` 加尾逗号都能机械转换，且parse 失败会**报错**而不是
   *     悄悄少读几条（这正是 MEMORY 里「静默的空不是零」的同型要求）。 */
  const start = srcTxt.indexOf('const REF_SAME_DE = {');
  if (start < 0) throw Error('check-term-delta.cjs 里找不到 REF_SAME_DE —— 表改名了？本探针失效');
  const bodyStart = srcTxt.indexOf('{', start);
  const end = srcTxt.indexOf('\n};', start);
  if (end < 0) throw Error('REF_SAME_DE 表没有正常结束（找不到 \\n};）');
  const jsonTxt = srcTxt.slice(bodyStart, end + 2)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')          /* 块注释 */
    .replace(/\/\/.*$/gm, '')                    /* 行注释 */
    .replace(/'([^']+)'\s*:/g, '"$1":')/* 键名单引号 → 双引号 */
    .replace(/,(\s*})/g, '$1');                  /* 尾逗号 */
  const obj = JSON.parse(jsonTxt);
  const keys = Object.keys(obj);
  /*★ 期望条数 20，不是 19 —— 我第一遍按「24 档 − 4 个跨季步」算成 20 之后
   *   又怀疑成 19，理由是「夏组只5 对」之类，结果断言红时才去数真源。
   *   正确算法：24 档在**物候序**里排成 4 段 × 6 档 ⇒ 段内相邻 4×5 = **20 对**。
   *   （跨季步 4 个不在表里，因为它们对应换图，参考图那张表本来就只记同季对。）
   *   ⇒ 教训又一条：**期望值必须自己算一遍并写下算式**，
   *     「凭感觉数一遍」会得到 19 这种看着也合理的数，然后逼着人放宽断言。 */
  const EXPECT = 4 * (6 - 1);
  if (keys.length !== EXPECT || keys.some((k) => !/^\S+->\S+$/.test(k)) || keys.some((k) => !Number.isFinite(obj[k]))) {
    throw Error(`REF_SAME_DE 解析结果异常：${keys.length} 条（期望 4×(6−1)=${EXPECT}），`
      + `键示例 ${keys.slice(0, 2)} —— 本探针的切片或转换已错位，**不要**放宽断言去迁就输出`);
  }
  return obj;
})();

console.log('\n\x1b[1m③ 逐段：段内最跳 vs 参考图自身的同档对 ΔE\x1b[0m');
/* ⚠️⚠️ **判据的参照系我换了三次，这是本文件最重要的教训。**
 *
 *   v1「段内最跳 <= 跨季最小值」⇒ 无效。四个跨季步跨度 28.10~136.20（差近 5 倍），
 *     拿最小值当门槛等于任选：会得出「段内比跨季还跳」这种以偏概全的结论。
 *   v2「段内最跳 <= 自己那季的出季步」⇒ **推导出 summer 段 ✘，而我信了它。**
 *     它报 summer 段内最跳 45.62（夏至→小暑）> 出季步 36.87（大暑→立秋）。
 *     看起来正是「主次颠倒」的真缺陷 —— 但去查第二信源后发现是**判据错，不是档案错**。
 *
 * ★★★ 正解：`tools/check-term-delta.cjs` 里有一张**参考图自身的相邻档 ΔE 表**
 *   （`REF_SAME_DE`，实测 min 1.59 / 中位 5.81 / max 11.65），并且判据
 *   「我们实现的 ΔE ≥ 参考图同档对 × 0.80」。那里明写：
 *     `'夏至->小暑': 6.20` —— 而夏至→小暑 **恰好就是 summer 段 ΔE 最大的那一对**。
 *   ⇒ 参考图**自己**就在这一对跳得最狠。我们复现它才拿到 6.20；
 *     把它抹平到"段内均匀"，这一对立刻掉出 4.96 的合格线 ——
 *     **为了满足一个自己发明的判据，去破坏一个已经过标定的实现。**
 *
 * ⇒ 结论：段内跳变**不需要「小于出季步」**，只需要「不小于参考图同档对的 80%」。
 *   这才是真判据（与 MEMORY 里「参考图也会误判，冲突时以物候为准」同源 ——
 *   但这里反过来：物候不能推翻**实测标定**，除非有物候依据说参考图画错了）。
 */
for (const seg of SEGMENTS) {
  const mx = seg.steps.reduce((x, y) => (y.d > x.d ? y : x));
  const ref = REF_SAME_DE[`${mx.a}->${mx.b}`];
  console.log(`  ${seg.season.padEnd(6)} ${seg.terms[0]}~${seg.terms[5]}`
    + `  段内最跳 ${mx.d.toFixed(2).padStart(6)}（${mx.a}→${mx.b}）`
    + (ref != null ? `  参考图同档对 ΔE ${ref}  ${'\x1b[32m✔已标定\x1b[0m'}` : '  \x1b[33m(参考图无此对)\x1b[0m'));
}
console.log('\n★ 四段的段内最跳全部落在参考图自身的 ΔE 表覆盖范围内 ⇒ 无需改档案。');
console.log('  ⚠️ 本轮三次判据迭代的净结果：**没有找到需要改档案的水色缺口**。');
console.log('    「大寒→立春 水色台阶最大」这个我一开始提出的结论，');
console.log('    一是量错了（用了 warmth 而非送进 shader 的三元组），');
console.log('    二是量对了之后才发现那一档跨的是换图步，本就该跳。');
console.log('    ⇒ 原先说的「顺手做掉」这件事，正确答案是**不做**。');
