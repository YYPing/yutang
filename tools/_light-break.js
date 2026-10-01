/* 反证脚本：故意把光照场的某一项弄坏，验证 check-light.js 真的会变红。
 *
 * ── 为什么必须有这个脚本 ──────────────────────────────────────────────────
 * 一把"永远绿"的尺子比没有尺子更坏 —— 它会给你虚假的安心。
 * 「阳光照耀的效果」这种主观目标尤其危险：验收全绿、画面没变，你还以为自己成了。
 * 所以每加一条验收，都要能证明「把它破坏掉，这条会响」。
 *
 * ── ⚠️ 为什么是「同进程重新 import」而不是「子进程再跑一遍」 ────────────────
 * 本环境里托管的 node.exe **不能再 spawn 自己**：`spawnSync ... EBUSY`
 * （Windows 上正在运行的 exe 被锁住）。所以走不通"改文件 → 子进程跑 → 看退出码"。
 * 改成带 query 的动态 `import('...?v=N')`：
 *   · ESM 的模块键是「URL 字符串」，加上 `?v=N` 就是另一个模块 ⇒ 会**重新读盘**
 *   · 于是刚被改写的源码立刻生效，不需要子进程、不需要落临时文件
 * 代价是 `check-light.js` 必须写成可导出的 runner（它本来就是了）。
 *
 * 跑法：node tools/_light-break.js
 * 结束时会自动还原源码（异常路径也还原，走 try/finally）。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const MODULE_PATH = join(ROOT, 'src', 'engine', 'light-field.js');
const CHECK_PATH = join(HERE, 'check-light.js');
const original = readFileSync(MODULE_PATH, 'utf8');

const CASES = [
  {
    label: '删掉水面底色 .31',
    why: '需求「暗处 .67」与「底光 .36」立刻互斥 —— 这是六个数字能否同时成立的守门人',
    from: 'waterBase: 0.31,',
    to: 'waterBase: 0,',
    expect: /暗处 lit = \.67/,
  },
  {
    label: '把 σ 从 .26 改成 .08',
    why: '光池缩成一个小亮点，验收点直接塌掉',
    from: 'poolSigma: 0.26,',
    to: 'poolSigma: 0.08,',
    // ⚠️ 不能拿「光池验收点 lit = 1.19」当判据 —— 那个采样点离池心 `.34σ`，
    //    σ 一改采样点跟着缩，读数纹丝不动（这就是"照镜子"式断言）。
    //    必须钉在**固定像素**上问衰减率。
    expect: /σ 绝对值：池心外 260px/,
  },
  {
    label: '把鱼亮度增益从 .82 改成 1',
    why: '明暗差不再是 1.43 倍',
    from: 'fishGain: 0.82,',
    to: 'fishGain: 1,',
    expect: /明暗差 = 1\.43 倍/,
  },
  {
    label: '把光柱间隔上限从 17 改成 3',
    why: '间隔掉到 9–12s，覆盖不了需求的 26s 上界',
    from: 'shaftIntervalSpan: 17,',
    to: 'shaftIntervalSpan: 3,',
    // ⚠️ 也不能拿「间隔全部落在 9–26s」当判据：把区间**变窄**成 9–12s
    //    仍然满足"都在 9–26 内"。偏窄的区间永远落在更宽的区间里。
    //    判据必须是「两头都够得着」。
    expect: /间隔真的铺满 9–26s：上界够得着 26s/,
  },
  {
    label: '让光柱在雨里也出',
    why: '物理错：阴雨天没有直射阳光，出柱就是错的',
    from: "if (o.weather !== 'sunny' || o.reducedMotion || o.quality === 'low') {",
    to: "if (o.reducedMotion || o.quality === 'low') {",
    expect: /rainy 不出光柱/,
  },
  {
    label: '把梦幻系数改回「update() 里缓存的字段」',
    why: '柱内梦幻在 update() 之外读会拿到陈旧值（手工放柱 / 单帧渲染 / 快照回放）',
    from: `  dreamAt(x, y, width, height) {
    const shaft = this.shaftAt(x, y, width, height);`,
    to: `  dreamAt(x, y, width, height) {
    if (!Number.isFinite(this._staleDream)) this._staleDream = 0;
    if (this._staleDream <= 0.001) return 0;
    const shaft = this.shaftAt(x, y, width, height);`,
    expect: /柱内梦幻系数 > 0/,
  },
];

let allGood = true;
let revision = 0;

try {
  for (const testCase of CASES) {
    if (!original.includes(testCase.from)) {
      console.log(`  ⚠ 跳过「${testCase.label}」：源码里找不到锚点（改过源码要同步改这里）`);
      allGood = false;
      continue;
    }
    writeFileSync(MODULE_PATH, original.replace(testCase.from, testCase.to), 'utf8');
    revision += 1;

    // `?v=N` 让 ESM 把这次改写当成**另一个模块**，从而重新读盘。
    const [broken, checker] = await Promise.all([
      import(`${pathToFileURL(MODULE_PATH).href}?v=${revision}`),
      import(`${pathToFileURL(CHECK_PATH).href}?v=${revision}`),
    ]);

    const captured = [];
    const result = checker.runLightChecks({ light: broken, log: (line) => captured.push(line) });
    const hit = captured.find((l) => l.trim().startsWith('✘') && testCase.expect.test(l));
    const reddened = result.fail > 0 && Boolean(hit);

    console.log(`  ${reddened ? '✔' : '✘'} ${testCase.label}　→　${testCase.why}`);
    console.log(`      ${hit ? hit.trim() : `（预期的那条红项没出现，fail=${result.fail}）`}`);
    if (!reddened) allGood = false;
  }
} finally {
  writeFileSync(MODULE_PATH, original, 'utf8');
  console.log('\n源码已还原。');
}

console.log(allGood
  ? '\n✔ 反证通过：每一项都真的被尺子盯着，没有恒真断言。'
  : '\n✘ 反证失败：有断言是"恒真"的，等于没量。');
process.exit(allGood ? 0 : 1);
