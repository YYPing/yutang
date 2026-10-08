/**
 * 荷花物候**抛物线**验收（江南荷花真实物候时间轴，2026-10-07）。
 *
 * ★★★ 为什么必须单独建一把量具，而不是并进 `check:lotus`：
 *   `check:lotus` 验的是「**某个落点上真的有 flora**」（像素级、需浏览器）。
 *   本轮重排要验的是完全不同的另一件事 ——
 *   **形状**：① 峰值在不在大暑 ② 三伏是否单调递增 ③ 秋组是否单调退坡
 *   ④ 春组是否零花零苞 ⑤ 花苞形态是否跟着阶段走。
 *   这五件事**全部是档案层的函数**，不需要一个像素。
 *   ⚠️ 而且用浏览器验形状是**错配**：像素量具的噪声（±1 朵就能翻转差分）
 *   比要测的梯度还大 ⇒ 形状判据必须读**档案值本身**。
 *
 * ★ 判据表直接**从物候时间轴抄**，不从档案反推 ——
 *   从档案反推等于「用实现验证实现」，恒绿。
 *   这也是本项目反复踩的坑：判据表必须来自**独立的第二信源**。
 *
 * ★ 这把量具是**纯 Node**（无浏览器），跑一次 <1s ——
 *   所以它可以进 `npm test` 之外的日常快查，改完档案立刻能知道有没有破坏抛物线。
 *
 * ┌───────────── 双向验证记录（`node tools/_pheno-falsify.py`）─────────────┐
 * 判据全绿**不能**证明判据有效（skill `canvas-visual-acceptance`：
 * 「判据自己假绿」）。本量具的反证结果，四条全部产出明确不同读数：
 *   基线（未改）.................................. 14/14   0红
 *   A `LOTUS_MAX` 9→5（旧物理天花板）............. 10/14   4红
 *     ② 夏至/小暑/大暑 三档数量全错 · ④b 实为 4 朵 · ⑤ MAX=5 · ⑤b round=4
 *   B `OPEN_HI` .88→.92（旧窗口）................ 13/14   1红
 *     ④h **「撞顶档：(无)」** —— 峰值永远撞不到顶，正是本轮修的那个 bug
 *   C `budKindOf` 改用 `litter>=0.30` 判枯瓣....... 13/14   1红
 *     ③ **「立秋: 实际 tight ≠ 物候 withered」** —— 处暑 .30 踩门槛上
 *   D 大暑 `lotus` .88→.55（峰值塌腰）............  9/14   5红
 *     ④a **「峰值 6 朵，出现在 小暑」** ← 就是用户说的「大暑塌腰」
 *     ④c 夏至 4 → 小暑 6 → 大暑 5（非递增）· ④h 无撞顶档 · ② 数量错
 * ⚠️ A 和 D 都报「② 数量对不上」，说明**两层兜底**：绝对量与形状任一被破坏都会红。
 * ⚠️ 反证脚本必须做 `node --check` 语法预检 + 二进制读 stdout，
 *   否则 Windows GBK 控制台会把 `✘` 吞成 `?`（红项明细整行筛不出来）。
 */
import { SOLAR_TERMS, termProfile, TERM_SEASON } from '../src/engine/almanac.js';
import { TERM_VISUAL, BUD_KIND } from '../src/engine/term-visual.js';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const tvSrc = readFileSync(join(ROOT, 'src/engine/term-visual.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (c, label, detail) => {
  const mark = c ? '\x1b[32m✔\x1b[0m' : '\x1b[31m✘\x1b[0m';
  if (c) pass++; else fail++;
  console.log(`  ${mark} ${label}${detail ? '  — ' + detail : ''}`);
};
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

/* ── 物候时间轴（用户提供的第二信源，**判据的唯一依据**）────────────
 * 格式：[节气, 浮叶数区间, 立叶数区间, 盛开花数, 花苞数, 莲蓬数, 花苞形态]
 * `null` = 该项物候表未规定（只约束方向，不约束绝对值）。
 * ⚠️ 这张表是**独立于 `almanac.js` 的第二信源** ——
 *   改档案不会改它，所以它才有判据能力。
 *
 * ★★2026-10-08（层③）新增 `standLeaf`（立叶）一维：
 *   规范里「谷雨 冒 1–2 支尖尖**立叶**」「立夏 **立叶 4–5 片**仍稀疏」
 *   ——**立叶与浮叶是两种叶**（贴水vs 挺水），物候曲线也不同步
 *   （浮叶早、立叶晚）。上一轮档案只有一个 `leaf` 通道，
 *   于是这两句话**不可能同时成立**，只能回避掉其中一句。
 *   ⚠️ 加这一维的另一个理由：**不加判据 = 新通道完全裸奔**。
 *     本项目已栽过「加了量但没人量」（雨势那次指标一位没动才发现量错了量），
 *     这次档案加了通道就立刻配套判据，不留「看起来能用但没人在看」的形态。 */
const PHENOLOGY = {
  // 春：钱叶期，**零花零苞**；立叶也要到谷雨才冒尖
  立春: { leaf: 0, standLeaf: 0, lotus: 0, bud: 0, pod: 0, kind: null },
  雨水: { leaf: 0, standLeaf: 0, lotus: 0, bud: 0, pod: 0, kind: null },
  惊蛰: { leaf: 0, standLeaf: 0, lotus: 0, bud: 0, pod: 0, kind: null },
  // ⚠️ 物候给的是**区间**（「2–3 枚极小圆钱叶」「5–6 枚小圆浮叶」）⇒ 必须写成区间。
  //   第一版写成精确值 `2`/`5` ⇒ 判据报「春分 3≠2」——**是判据把区间当点值了**，
  //   与「大暑 7~8 朵」那几行同一性质。`null` 表示该档此项只约束方向。
  春分: { leaf: [2, 3], standLeaf: 0, lotus: 0, bud: 0, pod: 0, kind: null },
  清明: { leaf: [5, 6], standLeaf: 0, lotus: 0, bud: 0, pod: 0, kind: null },
  // 谷雨「浮叶增多 + **冒 1–2 支尖尖立叶**，准备孕蕾」⇒ bud 仍为 0（花期未到）
  谷雨: { leaf: null, standLeaf: [1, 2], lotus: 0, bud: 0, pod: 0, kind: null },
  // 夏：立叶→尖苞→初开→盛开→顶峰
  立夏: { leaf: null, standLeaf: [4, 5], lotus: 0, bud: [1, 2], pod: 0, kind: BUD_KIND.TIGHT },
  小满: { leaf: null, standLeaf: [7, 8], lotus: 1, bud: [3, 4], pod: 0, kind: BUD_KIND.OPENING },
  芒种: { leaf: null, standLeaf: null, lotus: [2, 3], bud: [4, 5], pod: 0, kind: BUD_KIND.OPENING },
  夏至: { leaf: null, standLeaf: null, lotus: [3, 4], bud: [5, 6], pod: 0, kind: BUD_KIND.OPENING },
  小暑: { leaf: null, standLeaf: null, lotus: [5, 6], bud: null, pod: null, kind: BUD_KIND.OPENING },
  大暑: { leaf: null, standLeaf: null, lotus: [7, 8], bud: null, pod: null, kind: BUD_KIND.OPENING },
  // 秋：花退坡、莲蓬接管
  立秋: { leaf: null, standLeaf: null, lotus: [2, 3], bud: null, pod: [2, 3], kind: BUD_KIND.WITHERED },
  处暑: { leaf: null, standLeaf: null, lotus: [1, 2], bud: null, pod: [4, 5], kind: BUD_KIND.WITHERED },
  白露: { leaf: null, standLeaf: null, lotus: 0, bud: null, pod: null, kind: BUD_KIND.WITHERED },
  秋分: { leaf: null, standLeaf: null, lotus: 0, bud: null, pod: null, kind: null },
  寒露: { leaf: null, standLeaf: null, lotus: 0, bud: null, pod: null, kind: null },
  霜降: { leaf: null, standLeaf: null, lotus: 0, bud: null, pod: null, kind: null },
  // 冬：水面无叶（立叶也归零—— 地上部分已枯，地下茎休眠）
  立冬: { leaf: null, standLeaf: 0, lotus: 0, bud: 0, pod: null, kind: null },
  // 物候「小雪–大寒：**水面无叶**」⇒ 小雪也是 0片。
  // 第一版写 `null`（不判）⇒ 量具对「小雪还飘 1 片叶」完全无感，
  // 而那正是用户清单里「冬组水面的褐色残荷枯叶应清掉」那一类问题。
  小雪: { leaf: 0, standLeaf: 0, lotus: 0, bud: 0, pod: null, kind: null },
  大雪: { leaf: 0, standLeaf: 0, lotus: 0, bud: 0, pod: 0, kind: null },
  冬至: { leaf: 0, standLeaf: 0, lotus: 0, bud: 0, pod: 0, kind: null },
  小寒: { leaf: 0, standLeaf: 0, lotus: 0, bud: 0, pod: 0, kind: null },
  大寒: { leaf: 0, standLeaf: 0, lotus: 0, bud: 0, pod: 0, kind: null },
};

const V = {};
for (const t of SOLAR_TERMS) {
  V[t] = TERM_VISUAL(termProfile(t), { solarTerm: t });
}
const n = (v) => (Array.isArray(v) ? `${v[0]}~${v[1]}` : String(v));
const hit = (actual, want) => (Array.isArray(want) ? actual >= want[0] && actual <= want[1] : actual === want);

section('① 逐档对表（档案实况 vs 江南物候时间轴）');
console.log('  节气   浮叶 立叶 花 苞 蓬  形态        物候要求（浮叶/立叶/花/苞/蓬/形态）');
for (const t of SOLAR_TERMS) {
  const v = V[t], p = PHENOLOGY[t];
  const req = p ? `${n(p.leaf)}/${n(p.standLeaf)}/${n(p.lotus)}/${n(p.bud)}/${n(p.pod)}/${p.kind || '-'}` : '—';
  console.log(`  ${t.padEnd(2)} ${String(v.leafCount).padStart(4)} ${String(v.standLeafCount).padStart(4)}`
    + ` ${String(v.lotusCount).padStart(2)}`
    + ` ${String(v.budCount).padStart(2)} ${String(v.podCount).padStart(2)}  `
    + `${(v.budKind || '-').padEnd(12)} ${req}`);
}

section('② 绝对数量判据（逐档对表）');
const bad = [];
for (const t of SOLAR_TERMS) {
  const p = PHENOLOGY[t];
  if (!p) continue;
  const v = V[t];
  /* ★ 2026-10-08：`leaf` 与 `standLeaf` 是**两个键**（两种叶），
   *   不能合在一起判 —— 否则量具对「立叶被当成浮叶重复计数」完全无感。 */
  for (const k of ['leaf', 'standLeaf', 'lotus', 'bud', 'pod']) {
    if (p[k] === null || p[k] === undefined) continue;
    if (!hit(v[`${k}Count`], p[k])) {
      bad.push(`${t}.${k}: 实际 ${v[`${k}Count`]} ≠ 物候 ${n(p[k])}`);
    }
  }
}
ok(bad.length === 0, '所有档位的浮叶/立叶/花/苞/蓬数量都符合物候表',
  bad.length ? bad.join('; ') : `${SOLAR_TERMS.length} 档全对`);

section('③ 花苞形态判据（形态必须随发育阶段走）');
const kindBad = [];
for (const t of SOLAR_TERMS) {
  const p = PHENOLOGY[t];
  if (!p || !p.kind) continue;
  if (V[t].budKind !== p.kind) {
    kindBad.push(`${t}: 实际 ${V[t].budKind || 'null'} ≠ 物候 ${p.kind}`);
  }
}
ok(kindBad.length === 0, '形态与物候表一致（尖苞只在立夏 / 枯瓣从立秋起）',
  kindBad.length ? kindBad.join('; ') : '立夏 tight · 小满~大暑 opening · 立秋~寒露 withered');

/* ★★ 形态判据的**自检**：断言「三种形态都真的出现过」。
 *   否则「所有档都判成 null ⇒ 全部匹配 kind:null」也会全绿 ——
 *   这就是「判据自己假绿」的一种。 */
const kindsSeen = new Set(SOLAR_TERMS.map((t) => V[t].budKind).filter(Boolean));
ok(kindsSeen.size === 3, '★ 三种形态都必须实际出现（否则形态判据是恒绿假判）',
  `实际出现：${[...kindsSeen].join(' / ') || '(一个都没有)'}`);

section('④ 抛物线形状判据（这一把量具的核心）');
/* ④a 峰值必须落在**大暑**，且是全年唯一最大值。 */
const peak = Math.max(...SOLAR_TERMS.map((t) => V[t].lotusCount));
const peakTerms = SOLAR_TERMS.filter((t) => V[t].lotusCount === peak);
ok(peakTerms.length === 1 && peakTerms[0] === '大暑',
  '④a 荷量峰值必须**唯一落在大暑**（物候「盛花顶峰」）',
  `峰值 ${peak} 朵，出现在 ${peakTerms.join('+') || '(无)'}`);
ok(peak >= 7, '④b 大暑应有 7–8 朵（物候「盛开 7–8 朵」）', `实为 ${peak}`);

/* ④c 三伏单调递增：夏至 < 小暑 < 大暑。 */
const sanfu = ['夏至', '小暑', '大暑'].map((t) => [t, V[t].lotusCount]);
ok(sanfu[0][1] < sanfu[1][1] && sanfu[1][1] < sanfu[2][1],
  '④c 盛花期必须逐档递增（夏至→小暑→大暑）',
  sanfu.map(([t, c]) => `${t} ${c}`).join(' → '));

/* ④d 秋组单调退坡：大暑 > 立秋 > 处暑 > 白露，且白露=0。 */
const autumn = ['大暑', '立秋', '处暑', '白露'].map((t) => [t, V[t].lotusCount]);
ok(autumn[0][1] > autumn[1][1] && autumn[1][1] >= autumn[2][1] && autumn[3][1] === 0,
  '④d 秋组必须单调退坡，且白露花全谢（不是硬切）',
  autumn.map(([t, c]) => `${t} ${c}`).join(' → '));

/* ④e ★ 「退坡」与「硬切」的区别：**花退下去的同时莲蓬必须上来**。
 *   只查花会漏掉「花没了但莲蓬也没了」这种空档。 */
const podRise = ['大暑', '立秋', '处暑'].map((t) => [t, V[t].podCount]);
ok(podRise[0][1] <= podRise[1][1] && podRise[1][1] < podRise[2][1],
  '④e 花退坡时莲蓬必须**接力上升**（否则中间档是空档）',
  podRise.map(([t, c]) => `${t} ${c}蓬`).join(' → '));

/* ④f 春组必须是**空水面**：立春→惊蛰 三档零荷零花零苞。 */
const springEmpty = ['立春', '雨水', '惊蛰'].map((t) => V[t]);
ok(springEmpty.every((v) => v.leafCount === 0 && v.lotusCount === 0 && v.budCount === 0),
  '④f 立春/雨水/惊蛰必须是**空水面**（钱叶要到春分才初浮）',
  springEmpty.map((v) => `叶${v.leafCount}/花${v.lotusCount}/苞${v.budCount}`).join(' '));

/* ④g 冬六档水面无叶（规范「小雪–大寒 水面无叶」）。 */
const winter = ['大雪', '冬至', '小寒', '大寒'].map((t) => V[t]);
ok(winter.every((v) => v.leafCount === 0),
  '④g 大雪~大寒水面必须无叶', winter.map((v) => v.leafCount).join('/'));

/* ═══ ④i / ④j 立叶专属判据（2026-10-08 层③新增）═══
 *
 * ★ 这两条是**层③存在的全部理由**。上一轮之所以只能用「立夏 `leaf` 压回谷雨同档」
 *   来回避矛盾，正是因为**没有任何判据在管「立叶何时出现、有多少」**——
 *   一个没人量的通道，等于没有通道。
 *
 * ④i「立叶必须晚于浮叶出现」验证的是**物候顺序**：
 *   浮叶（钱叶）在春分就浮出水面了，立叶要等谷雨才冒尖 ——
 *   真实荷塘正是这样：**先铺满浮叶，再从其中冒出错落的立叶**。
 *   ⚠️ 若这条报红，说明有人把 `standLeaf` 随手写成了 `leaf` 的复制
 *   （那两句话又合并回去了，本轮的改动等于没做）。
 */
const floatFirst = ['春分', '清明'].every((t) => V[t].leafCount > 0 && V[t].standLeafCount === 0)
  && V['谷雨'].leafCount > 0 && V['谷雨'].standLeafCount > 0;
ok(floatFirst,
  '④i 立叶必须晚于浮叶出现（春分/清明只有浮叶，谷雨才冒立叶）',
  `春分 浮${V['春分'].leafCount}/立${V['春分'].standLeafCount}`
  + `  清明 浮${V['清明'].leafCount}/立${V['清明'].standLeafCount}`
  + `  谷雨 浮${V['谷雨'].leafCount}/立${V['谷雨'].standLeafCount}`);

/* ④j 立叶数量必须**逐档递增到盛夏再退坡**，且**峰值不超过浮叶**。
 *   ⚠️ 后半句不是形式检查：立叶与浮叶若是同一个数量级，
 *   1× 下会读成「满池都是同一种叶」—— 层③就白做了。
 *   （大暑浮叶 22 / 立叶 14，比值 0.64。） */
const standSeries = ['谷雨', '立夏', '小满', '芒种', '夏至', '小暑', '大暑'].map((t) => [t, V[t].standLeafCount]);
const standRise = standSeries.every(([, c], i) => i === 0 || c >= standSeries[i - 1][1]);
const standPeak = Math.max(...standSeries.map(([, c]) => c));
const floatPeak = Math.max(...SOLAR_TERMS.map((t) => V[t].leafCount));
ok(standRise, '④j-1 立叶必须逐档递增到盛夏',
  standSeries.map(([t, c]) => `${t}=${c}`).join(' '));
ok(standPeak < floatPeak && standPeak / floatPeak >= 0.4 && standPeak / floatPeak <= 0.8,
  '④j-2 立叶峰值必须**明显少于**浮叶峰值（否则读成同一种叶）',
  `立叶峰值 ${standPeak} / 浮叶峰值 ${floatPeak} = ${(standPeak / floatPeak).toFixed(2)}`
  + `（合格区间 0.40~0.80）`);

/* ④h ★ 归一化窗口必须跟着档案峰值走（`rawOpenness` 的老坑复发检查）。
 *   峰值档的 rawOpenness 必须是 1.000，而**不能有第二档也撞 1.000** ——
 *   撞顶会让「盛极」与「余花」在画面上无区别。 */
const raws = SOLAR_TERMS.map((t) => [t, V[t].rawOpenness]);
const saturated = raws.filter(([, r]) => r >= 0.999).map(([t]) => t);
ok(saturated.length === 1 && saturated[0] === '大暑',
  '④h rawOpenness 只能有**一个档**撞顶，且必须是大暑（防撞顶导致形态无差异）',
  `撞顶档：${saturated.join('+') || '(无)'}`);

section('⑤ 换算式自检（防「判据被旧值绑死」）');
/* 这一段是本量具与 `tests/almanac-pheno.test.js` 呼应的那条铁律：
 * 判据里所有「数」都必须从渲染层常量反查，不能写死。 */
const mLotus = tvSrc.match(/const LOTUS_MAX = (\d+)/);
const mPod = tvSrc.match(/const POD_MAX = (\d+)/);
ok(!!mLotus && Number(mLotus[1]) === 9, 'LOTUS_MAX 必须是 9（大暑要 7–8 朵，5 是物理天花板）',
  `实际 ${mLotus ? mLotus[1] : '(找不到)'}`);
ok(!!mPod && Number(mPod[1]) === 6, 'POD_MAX 必须是 6（处暑要 4–5 个）',
  `实际 ${mPod ? mPod[1] : '(找不到)'}`);

/* ★★ 2026-10-08（层③）新增 ⑤c：`STAND_LEAF_MAX` 也要反查。
 *   写死会怎样：若有人把 MAX 改成 22（复用浮叶的），立叶会与浮叶同数，
 *   而画面上两种叶是不同的东西 ⇒ 判据恒绿、问题被埋到肉眼那一层才发现。 */
const mStand = tvSrc.match(/const STAND_LEAF_MAX = (\d+)/);
ok(!!mStand && Number(mStand[1]) === 20, '⑤c STAND_LEAF_MAX 必须是 20（立叶比浮叶少，不能复用 LEAF_MAX）',
  `实际 ${mStand ? mStand[1] : '(找不到)'}`);

/* ④b 的反向自检：若MAX 被改小，7–8 朵就不可达 ⇒ 必须报红。 */
const maxAsNum = Number(mLotus[1]);
ok(Math.round(0.88 * maxAsNum) >= 7,
  '⑤b 峰值档档案值(大暑 lotus=.88)在当前 MAX 下能 round 出 ≥7 朵',
  `round(.88×${maxAsNum})=${Math.round(0.88 * maxAsNum)}`);

console.log(`\n通过 ${pass} 项，未通过 ${fail} 项`);
process.exit(fail ? 1 : 0);
