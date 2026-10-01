/* 用「常量引用率」反推需求落地缺口。
 *
 * ★ 为什么这个方法有效：
 *   `src/engine/eco/constants.js` 是照 v4 §17「核心数值参数总表」**逐条抄下来**的
 *   （每条都标了来源条款 §x.y / F-x.y.z）。所以 ——
 *   **一个常量如果从来没有任何模块读过它，它对应的那条需求就大概率没落地。**
 *   这比翻代码找功能快得多，而且**不会漏**：漏掉的功能通常就是"常量抄了、代码没写"。
 *
 * 已知的误报（本工具会主动排除）：
 *   - constants.js 自己内部用的键（如 pxPerCm() 读 MOTION.screenFraction）
 *   - 仅作文档锚点的键（如 MOTION.refPxPerCm = 5.76 只是把 1080p 的算例写下来）
 *
 * 跑法：node tools/dead-constants.js
 */
import { readFileSync, readdirSync } from 'node:fs';

const CONSTANTS = 'src/engine/eco/constants.js';
/** 只在 constants.js 内部使用的键（不是"没人读"，而是"不需要别人读"）*/
const INTERNAL_ONLY = new Set(['screenFraction']);
/** 纯文档锚点：不是可读参数，只是把算例写下来供对照 */
const DOC_ONLY = new Set(['refViewportShort', 'refPxPerCm']);

/** 去掉注释再匹配 —— 否则「注释里提过这个名字」会被误判成「代码读过」*/
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');

const files = [];
(function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) walk(path);
    else if (/\.(js|jsx)$/.test(entry.name)) files.push(path);
  }
})('src');

const sources = new Map(files.map((path) => [path, stripComments(readFileSync(path, 'utf8'))]));
const raw = readFileSync(CONSTANTS, 'utf8');

const groups = [...raw.matchAll(/export const ([A-Z_]+) = \{([\s\S]*?)\n\};/g)];

let deadTotal = 0;
let liveTotal = 0;
const deadByGroup = [];

console.log('\n═══ 常量引用率体检（未读 = 对应需求大概率未落地）═══\n');

for (const [, name, body] of groups) {
  const keys = [...body.matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]);
  const rows = keys.map((key) => {
    // 两种读法都算读：
    //   ① 点访问   CONST_GROUP.key
    //   ② 解构     const { key } = CONST_GROUP   ← ⚠️ 漏了这条会大量假阳性
    //      （实测：growth.js 写 `const { lBirthCm, d0 } = GROWTH;`，
    //        只匹配点访问时会误判成「lBirthCm / d0 从未被读」）
    const pattern = new RegExp(`\\.${key}\\b|[{,]\\s*${key}\\s*[,}]`);
    const readers = [...sources.entries()]
      .filter(([path, text]) => path !== CONSTANTS && pattern.test(text))
      .map(([path]) => path.replace('src/', ''));
    return { key, readers };
  });

  const dead = rows.filter((row) => !row.readers.length
    && !INTERNAL_ONLY.has(row.key) && !DOC_ONLY.has(row.key));
  liveTotal += rows.length - dead.length;
  deadTotal += dead.length;
  if (dead.length) deadByGroup.push({ name, dead });

  const flag = dead.length === keys.length ? '整组未落地' : dead.length ? `${dead.length} 项未读` : '全部被读';
  const mark = dead.length === 0 ? '✔' : dead.length === keys.length ? '✘✘' : '✘';
  console.log(`${mark} ${name.padEnd(12)} ${String(keys.length).padStart(2)} 键  ${flag}`);
  if (dead.length) console.log(`     ${dead.map((row) => row.key).join(', ')}`);
}

console.log(`\n小计：被读 ${liveTotal} 项 / 未被读 ${deadTotal} 项`);
console.log('\n── 按「整组未落地」推断的缺失功能 ──');
for (const { name } of deadByGroup) {
  const hint = {
    MOTION: '§12 运动模型（三条铁律 / 体波 / 冲刺）—— 本体沿用了自己原有的运动代码',
    FEED_CIRCLE: 'F-2.8 投喂感应圈（P0）—— 撒食后全池鱼都会来抢，违背「圈外鱼不变」',
  }[name];
  if (hint) console.log(`  · ${name}：${hint}`);
}
console.log('\n（MOTION 的 drive 相关键确实未读，但 sprint* 三项指向 §10.7 随机冲刺，属于独立缺失。）\n');
