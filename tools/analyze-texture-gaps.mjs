/**
 * 底图缺口的**定量定位**（层② 的前置，2026-10-08）。
 *
 * ★★★ 为什么不能靠肉眼判断「哪几档该补图」：
 *   `term-images.js` 的 manifest 把 24 档分给 4 张底图，每张管 6 档。
 *   肉眼看「夏至→小暑都在 summer 里，好像不用补」—— 但**真正决定观感的是
 *   跨季边界的两档之间差多少**，不是单档像不像。
 *   实测秋→冬结构差 22.40（构图不同），而 spring vs pond 只有 5.75（同构图）
 *   ⇒ 结论是明确的：**只有 4 个跨季边界是缺口**，其余 20 档不需要补图。
 *
 * ★ 这把量具输出的是「哪几个槽位该补」+「每个槽位的验收窗口」，
 *   供 AI 生图**定向补图**（而不是重画 4 张 —— 上一轮试过全量重画，
 *   强制水印 + 浮萍毁水面，已放弃）。
 *
 * 验收窗口 [8.0, 16.0] 的来历：`tools/measure-term-image.py` 实测——
 *   结构差 < 8 判「同构图」（观众看不出换图）、> 16 判「构图不同」（必须换）。
 *   ⇒ 中间段 8~16 是**最佳补图区间**：既能看出季节变化，又不至于构图大改。
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SOLAR_TERMS, termProfile, termSeason } from '../src/engine/almanac.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(ROOT, 'src/engine/term-images.js'), 'utf8');

/* 从 manifest 反查每档归属的槽位（**不手抄** —— manifest 是唯一真源） */
const slotOfTerm = {};
for (const m of src.matchAll(/terms:\s*\[([^\]]+)\]/g)) {
  const terms = m[1].match(/'([^']+)'/g).map((s) => s.replace(/'/g, ''));
  /* 槽位 id = 该 terms 数组**之前**最近的 `id: 'xxx'`（manifest 里是同一行对象） */
  const before = src.slice(Math.max(0, m.index - 200), m.index);
  const idm = [...before.matchAll(/id: '([\w-]+)'/g)].pop();
  if (!idm) continue;
  for (const t of terms) slotOfTerm[t] = idm[1];
}

console.log('\x1b[1m① 24 档的底图归属（从 manifest 反查）\x1b[0m');
const groups = {};
for (const t of SOLAR_TERMS) {
  const s = slotOfTerm[t] || '(未映射)';
  (groups[s] = groups[s] || []).push(t);
}
for (const [slot, terms] of Object.entries(groups)) {
  console.log(`  ${slot.padEnd(8)} ${terms.length} 档：${terms.join(' ')}`);
}

console.log('\n\x1b[1m② 跨季边界（manifest 槽位切换处 —— 只有这里是缺口）\x1b[0m');
const boundaries = [];
for (let i = 1; i < SOLAR_TERMS.length; i++) {
  const a = SOLAR_TERMS[i - 1], b = SOLAR_TERMS[i];
  if (slotOfTerm[a] !== slotOfTerm[b]) boundaries.push([a, b, slotOfTerm[a], slotOfTerm[b]]);
}
for (const [a, b, sa, sb] of boundaries) {
  console.log(`  ${a} → ${b}   ${sa} → ${sb}`);
}
const innerCount = SOLAR_TERMS.length - boundaries.length * 2;
console.log(`  ⇒ 共 ${boundaries.length} 处；${boundaries.length * 2} 档落在边界上（各占一个槽位端点），`
  + `其余 ${innerCount} 档在槽位内部，不需要补图。`);

console.log('\n\x1b[1m③ 每档的水色与霜/冰（补图时要对齐的物理量）\x1b[0m');
console.log('  节气   槽位     warmth frost  ice  露');
for (const t of SOLAR_TERMS) {
  const p = termProfile(t);
  console.log(`  ${t.padEnd(2)} ${String(slotOfTerm[t] || '?').padEnd(8)}`
    + ` ${p.warmth.toFixed(2)}  ${(p.frost ?? 0).toFixed(2)}  ${(p.ice ?? 0).toFixed(2)}  ${termSeason(t)}`);
}

console.log('\n\x1b[1m④ 补图优先级 —— 只按 warmth 排（★ 不含 frost/ice）\x1b[0m');
/* ⚠️⚠️ **判据量必须选真正由底图承载的那个量** —— 这是本项目的第 N 次同型陷阱。
 *   我第一版把距离写成三维：`warmth×1 + frost×2 + ice×2`，
 *   理由听起来很硬（「霜/冰是二值化的强视觉信号」）—— 结果把
 *   **`立春`（frost .60 / ice .45）顶到了第一**，看起来像个重大发现。
 *
 *   ★★★ 但它**根本不是底图的缺口**：`frost` 与 `ice` 都不进底图。
 *     · `frost` 的唯一消费者是 `pond.js` 的 `if (termVisual.frost > 0.02) drawFrost()`
 *       —— 程序化叠在岸边的一层浮霜，与底图文件无关。
 *     · `ice` 的唯一消费者是降雪强度 `Math.round(14+18*ice)`（ICE→雪量），
 *       也是程序化的（`drawWeather`）。
 *     而 `landscape.js` 的 `resolveTermImage()` 只按季节/节气挑**文件**，
 *     底图承载的只有两样：**水色（由 shader 的HSV 按 warmth 调制）
 *     与构图/岸边结构（固定的静态图）**。
 *   ⇒ 把 frost/ice 计进「底图缺不缺」= **指标与被测对象错配**，
 *     排序结果看起来精细、实则无意义（这与 MEMORY 里
 *     「判据量必须选真正送进 shader 的那个量，`tintR` 是非线性代理量」同型）。
 *
 *   ⚠️ 这次的诱惑比以往更强：因为它给出的结论**更刺眼**（"原来立春才是最大缺口"），
 *     而刺眼的结论最容易免于复核。⇒ 判据一旦变复杂，先问「这个量是谁消费的」。
 */
for (const [slot, terms] of Object.entries(groups)) {
  if (!terms.length) continue;
  const ws = terms.map((t) => termProfile(t).warmth);
  const lo = Math.min(...ws), hi = Math.max(...ws);
  const loT = terms[ws.indexOf(lo)], hiT = terms[terms.length - 1 - ws.slice().reverse().indexOf(hi)];
  const span = hi - lo;
  console.log(`  ${slot.padEnd(8)} warmth ${lo.toFixed(2)}（${loT}）→ ${hi.toFixed(2)}（${hiT}）   跨度 ${span.toFixed(2)}`
    + (span >= 0.40 ? '  ← 最大' : ''));
}
/* 另一条独立信号：跨季边界处的 **waterth 台阶**。
 *   边界相邻两档若warmth 也接近，则那张新图要承担的水色跨度最小
 *   ⇒ 最容易画对、性价比最高。反之台阶大 ⇒ 必须补图，且补了也不够
 *   （因为 shader 的HSV 拉伸本身就会把水色推到很远）。 */
console.log('\n  跨季边界的 warmth 台阶（相邻两档之差，步子越小越好画）：');
for (const [a, b, sa, sb] of boundaries) {
  const d = Math.abs(termProfile(a).warmth - termProfile(b).warmth);
  console.log(`  ${a}→${b}   Δwarmth ${d.toFixed(2)}  ${sa}→${sb}  ${d <= 0.12 ? '← 台阶小' : ''}`);
}
console.log('\n★ 结论：补图要针对**槽位两端的档**，不是全部 24 档。');
console.log('  实测结构差（tools/measure-season-textures.py）：');
console.log('    spring vs pond 5.75（同构图）· pond vs autumn 8.56（大体同构图）');
console.log('    autumn vs winter 22.40（构图不同）· spring vs winter 15.00');
console.log('  ⇒ 优先补**秋→冬**那一档（霜降/立冬之间），验收窗口 [8.0, 16.0]。');
console.log('  ⇒ 而「立春该有自己的霜池底图」是**伪结论**：立春的霜与雪都由程序化图层画。');