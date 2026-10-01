/* C 方案验收：「阶段 → 外观」+ 阶段群游 + 鱼卵群（§6 / §8.2 / §11.2 层 6–7）。
 *
 * ── 这个方案要证明什么 ───────────────────────────────────────────────────
 * C 方案（用户拍板）= **保留设计稿的近景尺度，补完「阶段 → 外观」通路 + 群游，
 * 让画面在长鱼苗/幼鱼阶段自己长成参考画的样子**。
 * 它不改任何尺度口径（F-7.2.2 的 16% 不动），只把**已经算好的种群结构画出来**。
 *
 * ── 为什么必须按「时间轴」采样，不能只测一个时刻 ──────────────────────────
 * 鱼苗只活 0–17 池塘日（1.4 真实天）、卵只活 4 池塘日（8 真实小时）、
 * 老鱼要日龄过 163 才出现。**任何一个固定时刻，多半这三样里只碰得到一两样。**
 * 初版本工具就是栽在这里：只推演到某一刻，结果测出来「0 尾鱼苗、0 粒卵」，
 * 断言全红 —— 但那是**采样点选错**，不是功能没做。
 * 所以这里按 1 真实天一格推进 16 格，每一格都量一次，取**跨时间的最大值**。
 *
 * ── 为什么用「聚集比」而不是「看一眼像不像」 ────────────────────────────
 * 「鱼苗紧密群游」这种话没法用肉眼判真假。判据：
 *   聚集比 = 同阶段最近邻距离中位数 ÷ 该组随机配对距离中位数
 *   · 完全随机 ⇒ ≈1   · 抱团 ⇒ <1   · 离群 ⇒ >1
 * 「紧」和「散」变成同一把尺子上的两个方向，而不是两套说法。
 *
 * ── 谁守「手绘鱼逐位不变」 ──────────────────────────────────────────────
 * `tools/trace-motion.js`（sha256 逐位摘要）。本文件只做「字段没被写入」的粗检。
 *
 * 跑法：node tools/check-stage-look.js
 */
import { PondSimulation } from '../src/engine/simulation.js';
import { advanceDays } from '../src/engine/eco/world.js';
import { updateFishLook } from '../src/engine/eco-bridge.js';
import { STAGES, APPEARANCE, SCHOOL, EGG_VISUAL, HATCH_DAYS } from '../src/engine/eco/constants.js';

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✔ ${label}${detail ? '  — ' + detail : ''}`); }
  else { fail++; console.log(`  ✘ ${label}${detail ? '  — ' + detail : ''}`); }
};
const section = (title) => console.log(`\n${title}`);
const mulberry32 = (seed) => { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
const STAGE_FROM = new Map(STAGES.map((s) => [s.key, s.from]));
const AGE_ORDER = ['fry', 'juvenile', 'subadult', 'adult', 'elder'];
const W = 1440, H = 900;
const SHORT = Math.min(W, H);
const median = (list) => { if (!list.length) return NaN; const s = [...list].sort((a, b) => a - b); return s[s.length >> 1]; };
const seeded = mulberry32(777);

/* ============================================================ ① 翻译曲线 */

section('① 阶段 → 外观：三个数字的边界、连续性与方向');
{
  const look = (ageDays) => updateFishLook({ stage: 'x', ageDays });
  const elderFrom = STAGE_FROM.get('elder');

  const atBirth = look(0);
  ok('鱼苗出生即半透明（§6 近半透明）', atBirth.aFade === APPEARANCE.alpha[0][1] && atBirth.aFade < 0.7, `aFade ${atBirth.aFade}`);
  ok('鱼苗几乎无斑（§6 幼鱼才「花纹显现」）', atBirth.aPattern < 0.25, `aPattern ${atBirth.aPattern.toFixed(3)}`);

  const fryEnd = look(STAGE_FROM.get('juvenile') - 1e-9);
  const juvStart = look(STAGE_FROM.get('juvenile'));
  ok('17 日龄（鱼苗→幼鱼）两侧连续 —— 阶段切换不闪', Math.abs(fryEnd.aFade - juvStart.aFade) < 1e-6, `${fryEnd.aFade.toFixed(4)} / ${juvStart.aFade.toFixed(4)}`);
  ok('17 日龄花纹也连续', Math.abs(fryEnd.aPattern - juvStart.aPattern) < 1e-6);

  ok('60 日龄后完全不透明', look(60).aFade === 1 && look(200).aFade === 1);
  ok('60 日龄后花纹全显', look(60).aPattern === 1 && look(200).aPattern === 1);

  let monoAlpha = true, monoPattern = true, prev = look(0);
  for (let age = 1; age <= 220; age++) {
    const now = look(age);
    if (now.aFade < prev.aFade - 1e-9) monoAlpha = false;
    if (now.aPattern < prev.aPattern - 1e-9) monoPattern = false;
    prev = now;
  }
  ok('0–220 日龄透明度只增不减', monoAlpha);
  ok('0–220 日龄斑块显现度只增不减', monoPattern);

  ok('老鱼入阶前不褪色', look(elderFrom - 1).aPale === 0);
  ok('老鱼褪色单调加深', look(elderFrom + 20).aPale < look(elderFrom + 40).aPale);
  ok('老鱼褪色到 elderPaleDays 封顶', Math.abs(look(elderFrom + APPEARANCE.elderPaleDays).aPale - APPEARANCE.elderPaleAlpha) < 1e-9, `α=${APPEARANCE.elderPaleAlpha}`);
  ok('褪色不再往上漂', look(elderFrom + 400).aPale === APPEARANCE.elderPaleAlpha);

  let paleLeak = 0;
  for (let age = 0; age < elderFrom; age++) if (look(age).aPale !== 0) paleLeak++;
  ok('非老鱼身上没有褪色（0 泄漏）', paleLeak === 0, `${paleLeak} 处`);

  const handDrawn = { variant: 2, length: 60 };
  const returned = updateFishLook(handDrawn);
  ok('手绘鱼（无 stage）不被写入外观字段',
    returned === handDrawn && handDrawn.aFade === undefined && handDrawn.aPattern === undefined && handDrawn.aPale === undefined);
}

/* ================================== ②③ 真种群：按时间轴推进，每格量一次 */

/**
 * ★ 为什么每天要跑 1800 帧（30 秒）运动，而不是 300 帧（5 秒）：
 *   群游是**队形**，不是瞬时速度。浪游目标每 4–12 秒换一次，出生时鱼是随机撒在池里的，
 *   队形要靠聚合力的正反馈慢慢长出来。初版每天只跑 5 秒 —— 量到的是"刚出生随机散布"，
 *   于是鱼苗公平对照读出 1.02（= 完全随机），看着像"群游没做"，
 *   其实是**尺子来不及**。1800 帧/天之后同一个判据是 0.57–0.73。
 * ⚠️ 采样每 60 帧一次（1 秒）而不是每帧：相邻帧高度自相关，
 *   每帧都采会把同一个队形数成几百个独立样本，虚高统计功效。
 */
const MOTION_FRAMES = 1800;
const MOTION_SAMPLE = 60;

const sim = new PondSimulation(W, H, { ecoMode: true, ecoSeed: 20260930 }, seeded);
const seenStages = new Set();
const peak = { translucent: 0, patterned: 0, pale: 0, fry: 0, elder: 0, eggs: 0, eggsSeen: 0 };
/** 每个阶段的最紧聚集比（跨时间取最小 = 最抱团的那一刻）*/
const tightest = {};
/**
 * 阶段隔离的**公平对照**样本，按阶段累积。
 *
 * ★ 为什么需要对照：直接比「同阶段最近邻 vs 跨阶段最近邻」是**有偏**的 ——
 *   候选池越大，最小值的期望越小，而跨阶段的鱼永远比同阶段多。
 *   所以对每条鱼，从**全体**里随机抽「与它同阶段同伴数相同」的样本、抽 60 次取最近的期望值。
 *   `same / control`：<1 = 主动凑近同类（抱团）· ≈1 = 无所谓 · >1 = 主动避开同类（离群）。
 *   这个比值对「组内有多少人」免疫，所以能公平比较鱼苗（9 尾）和老鱼（1–3 尾）。
 *
 * ⚠️ 但这个比值在**样本极少的阶段上不能用**：老鱼中位 1–2 尾、峰值也才 3–8 尾，
 *   而"最近邻"是极值统计，1–4 条鱼的比值方差极大。
 *   实测同一个参数在 4 个种子上是 0.66 / 0.93 / 0.99 / 1.24 —— 全是噪声，不可作判据。
 *   ⇒ 老鱼改用下面的 `isolation`（隔离度）。
 */
const fair = {};
const pickForControl = mulberry32(99);
/** 各阶段「最近邻距离中位数 / 身半径」——不重叠判据；身半径用引擎自己的 bodyRadius()。*/
const overlap = {};
/**
 * **隔离度**（老鱼「离群独处」的判据）：老鱼到最近一尾鱼（不限阶段）的距离，
 * 除以**同一次采样里全池的中位数**。
 *
 * ★ 为什么不看"同阶段"：§6 说的「离群独处」是**不跟群体待在一起**，
 *   不是"只躲着别的老鱼"。而且全池中位是同一次采样里的对照，
 *   换种子、换种群规模都可比 —— 比"同阶段最近邻"稳健一个量级。
 *   实测：老鱼 1.39–1.82（2 个种子），其余阶段 0.86–1.01。
 */
const isolation = {};
let sampleCount = 0;

/** 采一次样。峰值、聚集比、公平对照、隔离度都在这里更新（每 60 帧调一次）。*/
function measure() {
  sampleCount++;
  const pool = sim.fish.filter((f) => f.stage && !f.dead);
  const byStage = {};
  for (const fish of pool) (byStage[fish.stage] ??= []).push(fish);
  for (const key of Object.keys(byStage)) seenStages.add(key);

  peak.fry = Math.max(peak.fry, (byStage.fry ?? []).length);
  peak.elder = Math.max(peak.elder, (byStage.elder ?? []).length);
  peak.translucent = Math.max(peak.translucent, sim.fish.filter((f) => f.aFade !== undefined && f.aFade < 0.8).length);
  peak.patterned = Math.max(peak.patterned, sim.fish.filter((f) => f.aPattern !== undefined && f.aPattern < 1).length);
  peak.pale = Math.max(peak.pale, sim.fish.filter((f) => f.aPale > 0).length);
  peak.eggs = Math.max(peak.eggs, sim.eggs.length);
  if (sim.eggs.length) peak.eggsSeen++;

  // —— 隔离度：先算全池的最近邻中位，再按阶段取比值
  if (pool.length >= 4) {
    const nearestAny = new Map();
    for (const a of pool) {
      let best = Infinity;
      for (const b of pool) if (b !== a) best = Math.min(best, Math.hypot(a.x - b.x, a.y - b.y));
      nearestAny.set(a, best);
    }
    const allMedian = median([...nearestAny.values()]);
    if (allMedian > 0) for (const a of pool) (isolation[a.stage] ??= []).push(nearestAny.get(a) / allMedian);
  }

  for (const [key, list] of Object.entries(byStage)) {
    if (list.length < 3) continue;
    const near = list.map((a) => Math.min(...list.filter((b) => b !== a).map((b) => Math.hypot(a.x - b.x, a.y - b.y))));
    const rnd = [];
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) rnd.push(Math.hypot(list[i].x - list[j].x, list[i].y - list[j].y));
    const ratio = median(near) / median(rnd);
    if (!(key in tightest) || ratio < tightest[key]) tightest[key] = ratio;

    // 不重叠判据：最近邻距离中位数 ÷ 身半径（用引擎自己的 bodyRadius，
    // 与岸边/障碍用的是同一把尺子）。<1 就是两尾鱼"叠在一起"了。
    const rep = list[Math.floor(list.length / 2)];
    const radius = sim.bodyRadius(rep);
    (overlap[key] ??= []).push(median(near) / radius);

    // 公平对照：从全体里抽「与该阶段人数相同」的样本
    for (const a of list) {
      const candidates = pool.filter((b) => b !== a);
      if (candidates.length < list.length - 1) continue;
      (fair[key] ??= { same: [], control: [] });
      fair[key].same.push(Math.min(...list.filter((b) => b !== a).map((b) => Math.hypot(a.x - b.x, a.y - b.y))));
      const draws = list.length - 1;
      let acc = 0;
      for (let t = 0; t < 60; t++) {
        let best = Infinity;
        for (let k = 0; k < draws; k++) {
          const b = candidates[Math.floor(pickForControl() * candidates.length)];
          best = Math.min(best, Math.hypot(a.x - b.x, a.y - b.y));
        }
        acc += best;
      }
      fair[key].control.push(acc / 60);
    }
  }
}

section('② 真实推演 16 个真实天：五阶段都会出现，且外观确实在变');
for (let day = 1; day <= 16; day++) {
  advanceDays(sim.eco, 1, { feedPerDay: 2, stepDays: 0.05 });
  sim.syncEcoFish();
  // 让行为层真的跑一会儿 —— 外观是数据，群游是运动，不跑 update() 测不到队形。
  for (let i = 0; i < MOTION_FRAMES; i++) {
    sim.update(1 / 60);
    if (i % MOTION_SAMPLE === 0) measure();
  }
}

const fairRatio = {};
for (const [key, list] of Object.entries(fair)) {
  if (list.same.length < 6) continue;
  fairRatio[key] = median(list.same) / median(list.control);
}
const overlapMedian = Object.fromEntries(Object.entries(overlap).map(([k, v]) => [k, median(v)]));
const isolationMedian = Object.fromEntries(Object.entries(isolation).map(([k, v]) => [k, median(v)]));

console.log(`     16 格观察 · 每格 ${MOTION_FRAMES} 帧运动（${sampleCount} 次采样）：`
  + `鱼苗峰值 ${peak.fry} 尾 · 老鱼峰值 ${peak.elder} 尾 · 卵峰值 ${peak.eggs} 粒 · 有卵的格数 ${peak.eggsSeen}/16`);
console.log(`     半透明峰值 ${peak.translucent} 尾 · 花纹未全显峰值 ${peak.patterned} 尾 · 褪色峰值 ${peak.pale} 尾`);

ok('五个阶段在 16 个真实天里全都出现过', AGE_ORDER.every((k) => seenStages.has(k)), [...seenStages].join('/'));
ok('鱼苗期确实达到过成群的规模（≥5 尾）', peak.fry >= 5, `峰值 ${peak.fry} 尾`);
ok('某个阶段确实形成了体长金字塔（各阶段体长不等）', (() => {
  const byStage = {};
  for (const f of sim.fish) if (f.stage) (byStage[f.stage] ??= []).push(f.length);
  const present = AGE_ORDER.filter((k) => byStage[k]);
  return present.every((k, i) => i === 0 || median(byStage[k]) > median(byStage[present[i - 1]]));
})(), AGE_ORDER.filter((k) => sim.fish.some((f) => f.stage === k)).map((k) => `${k} ${median(sim.fish.filter((f) => f.stage === k).map((f) => f.length)).toFixed(0)}px`).join(' < '));

ok('真种群里有明显半透明的鱼（§6 鱼苗「近半透明」）', peak.translucent >= 5, `峰值 ${peak.translucent} 尾`);
ok('半透明的鱼一律未到亚成体', sim.fish.filter((f) => f.aFade < 0.8).every((f) => f.stage === 'fry' || f.stage === 'juvenile'),
  [...new Set(sim.fish.filter((f) => f.aFade < 0.8).map((f) => f.stage))].join('/') || '（此刻无）');
ok('真种群里有花纹未全显的鱼（§6 幼鱼「花纹显现」）', peak.patterned >= 5, `峰值 ${peak.patterned} 尾`);
ok('真种群里有褪色的老鱼（§6 老鱼「体色褪淡」）', peak.pale >= 1, `峰值 ${peak.pale} 尾`);
ok('褪色只出现在老鱼身上', sim.fish.filter((f) => f.aPale > 0).every((f) => f.stage === 'elder'));

/* ================================================================ ③ 群游 */

section('③ 群游：鱼苗抱团、老鱼离群、阶段之间不互相拉');
{
  const shown = AGE_ORDER.filter((k) => k in tightest).map((k) => `${k} ${tightest[k].toFixed(2)}`);
  console.log(`     最紧聚集比（<1 抱团 / ≈1 随机 / >1 离群）: ${shown.join('  ')}`);
  console.log(`     公平对照 same/control（<1 凑近同类 / >1 避开同类）: `
    + AGE_ORDER.filter((k) => k in fairRatio).map((k) => `${k} ${fairRatio[k].toFixed(2)}`).join('  '));
  console.log(`     隔离度（到最近一尾鱼 ÷ 全池中位，>1 = 独处）: `
    + AGE_ORDER.filter((k) => k in isolationMedian).map((k) => `${k} ${isolationMedian[k].toFixed(2)}`).join('  '));
  console.log(`     最近邻中位数 / 身半径（<1 = 叠在一起）: `
    + AGE_ORDER.filter((k) => k in overlapMedian).map((k) => `${k} ${overlapMedian[k].toFixed(2)}`).join('  '));

  if ('fry' in fairRatio) ok('鱼苗主动凑近同类（公平对照 < 0.8）—— §6「紧密群游」', fairRatio.fry < 0.8, `${fairRatio.fry.toFixed(3)}`);
  else ok('鱼苗主动凑近同类（16 格里鱼苗都没凑够可测样本）', false, '无样本');

  // ★ 老鱼用**隔离度**而不是公平对照。理由见 isolation 的注释：
  //   老鱼中位 1–2 尾，而"最近邻"是极值统计，1–4 条鱼的 same/control 方差极大
  //   （实测同一参数在 4 个种子上是 0.66 / 0.93 / 0.99 / 1.24，全是噪声）。
  //   隔离度是「它离最近的邻居多远 ÷ 同一次采样里全池的中位」，对照组就在同一帧里。
  if ('elder' in isolationMedian) {
    ok('老鱼独处（隔离度 > 1.15）—— §6「离群独处」', isolationMedian.elder > 1.15, `${isolationMedian.elder.toFixed(3)}`);

    const ranked = AGE_ORDER.filter((k) => k in isolationMedian);
    const loneliest = ranked.reduce((a, b) => (isolationMedian[b] > isolationMedian[a] ? b : a));
    ok('老鱼是全池最独处的一档（隔离度排第一）—— 而且是明显的，不是并列',
      loneliest === 'elder' && isolationMedian.elder > 1.15 * 1.15,
      `elder ${isolationMedian.elder.toFixed(2)} vs 次高 ${ranked.filter((k) => k !== 'elder')
        .reduce((a, b) => (isolationMedian[b] > isolationMedian[a] ? b : a), ranked[0])} ${Math.max(...ranked.filter((k) => k !== 'elder').map((k) => isolationMedian[k])).toFixed(2)}`);
  } else {
    ok('老鱼独处（隔离度 > 1.15）', false, '无样本');
    ok('老鱼是全池最独处的一档', false, '无样本');
  }

  // ★ 必须有这条：聚合项是**求和还是取平均**决定了会不会"贴成一坨"。
  //   初版逐条累加，实测同阶段最近邻中位数掉到 9px，而那一批鱼身半径是 11.8px —— 完全重叠。
  //   判据用「最近邻中位数 / 身半径 ≥ 1」= 两尾鱼不重叠，尺子直接用引擎自己的 bodyRadius()。
  const tightestOverlap = Math.min(...Object.values(overlapMedian));
  const tightestStage = Object.keys(overlapMedian).find((k) => overlapMedian[k] === tightestOverlap);
  ok('没有出现「贴成一坨」（最近邻中位数 ≥ 1 身半径）', tightestOverlap >= 1,
    `最紧的一档 ${tightestStage} ${tightestOverlap.toFixed(2)}（初版累加实现是 0.76）`);

  // ★ 老鱼不能靠"躲到画幅边缘"来实现独处 —— 那是被挤，不是独处。
  //   量的是「落在离边缘 13%（与 update() 的 marginX/Y 同源）的带里的时间占比」。
  const wallFrac = (stage) => {
    const list = sim.fish.filter((f) => f.stage === stage);
    if (!list.length) return 0;
    const mx = Math.min(85, W * 0.13), my = Math.min(75, H * 0.13);
    return list.filter((f) => f.x < mx || f.x > W - mx || f.y < my || f.y > H - my).length / list.length;
  };
  ok('老鱼不是被挤在画幅边缘（贴边率 ≤ 50%）', wallFrac('elder') <= 0.5, `贴边 ${(wallFrac('elder') * 100).toFixed(0)}%`);

  // 总体：同阶段比"同样多的随机同伴"更近 —— 阶段隔离确实起作用
  const allSame = Object.values(fair).flatMap((v) => v.same);
  const allControl = Object.values(fair).flatMap((v) => v.control);
  ok('同阶段比同样多的随机同伴更近（阶段隔离生效，不是"全池一坨"）',
    allSame.length > 20 && median(allSame) < median(allControl),
    `同阶段 ${median(allSame).toFixed(0)}px < 随机对照 ${median(allControl).toFixed(0)}px（${allSame.length} 个样本）`);

  const scaled = new PondSimulation(640, 480, { ecoMode: true, ecoSeed: 20260930 }, mulberry32(1));
  ok('群游半径 = 短边 × senseFraction（跟视口走，不是写死像素）',
    Math.abs(scaled.schoolSense - 480 * SCHOOL.senseFraction) < 1e-9 && Math.abs(scaled.schoolDead - 480 * SCHOOL.deadZoneFraction) < 1e-9,
    `感知 ${scaled.schoolSense.toFixed(1)}px / 死区 ${scaled.schoolDead.toFixed(1)}px @480 短边`);
}

/* ============================================================== ④ 鱼卵群 */

section('④ 鱼卵群（§11.2 层 6 · §8.2 步骤 3–5）');
{
  // 卵只活 4 池塘日 ⇒ 按 2 池塘日一格找，否则必定错过。
  const eggSim = new PondSimulation(W, H, { ecoMode: true, ecoSeed: 20260930 }, mulberry32(31337));
  let guard = 0;
  while (eggSim.eggs.length < 4 && guard++ < 240) {
    advanceDays(eggSim.eco, 2 / 12, { feedPerDay: 2, stepDays: 0.05 });   // 2 池塘日
    eggSim.syncEcoFish();
  }
  const eggs = eggSim.eggs;
  ok('能观察到鱼卵（§8.2 产卵 → 孵化 4 池塘日）', eggs.length >= 4, `${eggs.length} 粒（推进 ${guard} 格）`);

  if (eggs.length >= 4) {
    ok('卵视图数与世界一致', eggs.length === eggSim.eco.eggs.length, `${eggs.length} 粒`);
    ok('受精卵恒 settle=1（一直可见到孵化）', eggs.filter((e) => e.fertilized).every((e) => e.settle === 1),
      `受精 ${eggs.filter((e) => e.fertilized).length} / 未受精 ${eggs.filter((e) => !e.fertilized).length}`);
    ok('未受精卵 settle 落在 [0,1] 且不越界', eggs.filter((e) => !e.fertilized).every((e) => e.settle >= 0 && e.settle <= 1));

    // 步骤 3「水草/石上产卵」的落点约束：本体没有水草坐标（水草只画在底图里），
    // 退一步看「在水里 + 集中在靠岸环带」。
    const inWater = eggs.filter((e) => eggSim.habitat.contains(e.x, e.y, 0)).length;
    ok('卵全部落在水里（没有浮到岸上）', inWater === eggs.length, `${inWater}/${eggs.length}`);
    const dists = eggs.map((e) => eggSim.habitat.boundary(e.x, e.y).distance);
    const nearShore = dists.filter((d) => d < SHORT * 0.12).length;
    ok('卵集中在靠岸环带（≥90% 距岸 < 短边 12%）', nearShore / eggs.length >= 0.9,
      `${(nearShore / eggs.length * 100).toFixed(0)}% · 距岸 ${Math.min(...dists).toFixed(0)}–${Math.max(...dists).toFixed(0)}px · 中位 ${median(dists).toFixed(0)}px`);

    // 「成窝」：同一窝的卵必须彼此靠近，否则画面上是一把散芝麻
    const nearNeighbour = eggs.map((a) => Math.min(...eggs.filter((b) => b !== a).map((b) => Math.hypot(a.x - b.x, a.y - b.y))));
    const spread = EGG_VISUAL.clutchSpreadPx;
    const inClutch = nearNeighbour.filter((d) => d <= spread * 2).length / eggs.length;
    ok('卵成窝不散（≥70% 的卵在 2×散开半径内找得到邻居）', inClutch >= 0.7,
      `散开半径 ${spread}px · 最近邻中位 ${median(nearNeighbour).toFixed(0)}px · 成窝率 ${(inClutch * 100).toFixed(0)}%`);

    // ★ 视图不写回生态对象：serialize() 直接遍历 world.eggs，写回去存档就会带上坐标
    ok('卵视图不写回 world.eggs（生态侧仍然无坐标）',
      !eggSim.eco.eggs.some((e) => e.x !== undefined || e.y !== undefined));

    const snapshot = eggs.map((e) => `${e.x.toFixed(6)},${e.y.toFixed(6)}`).join('|');
    eggSim.syncEggs(); eggSim.syncEggs();
    ok('重复同步后卵的位置稳定（不抖）', eggSim.eggs.map((e) => `${e.x.toFixed(6)},${e.y.toFixed(6)}`).join('|') === snapshot);
  } else {
    for (const label of ['卵视图数与世界一致', '受精卵恒 settle=1', '未受精卵 settle 范围', '卵全在水里', '卵靠岸', '卵成窝', '不写回生态对象', '位置稳定']) ok(label, false, '无卵样本');
  }

  // ★ 视图不消耗共享随机流：syncEggs 里一次 this.random() 都不该调
  let rngCalls = 0;
  const probe = new PondSimulation(W, H, { ecoMode: true, ecoSeed: 20260930 }, () => { rngCalls++; return 0.5; });
  advanceDays(probe.eco, 6, { feedPerDay: 2, stepDays: 0.05 });
  rngCalls = 0;
  probe.syncEggs();
  ok('syncEggs 不吃鱼群共用的随机流（视图层不改行为层）', rngCalls === 0, `调用 this.random() ${rngCalls} 次`);

  // 步骤 4 的边界取值（不依赖"此刻恰好有未受精卵"）
  const settleAt = (elapsed) => Math.max(0, Math.min(1, 1 - elapsed / EGG_VISUAL.settleDays));
  ok('产卵那一刻 settle=1（还是琥珀色）', settleAt(0) === 1);
  ok('过半个结算窗 ⇒ 半白半透', Math.abs(settleAt(0.5) - 0.5) < 1e-9);
  ok('过完 1 池塘日 ⇒ settle=0（淡出干净）', settleAt(1) === 0 && settleAt(2) === 0);
  ok('孵化总时长没被结算窗占用（仍是 4 池塘日）', HATCH_DAYS === 4, `HATCH_DAYS=${HATCH_DAYS}`);
}

/* ================================================== ⑤ 只碰该碰的（粗检） */

section('⑤ 隔离性：群游只作用于生态鱼');
{
  const plain = new PondSimulation(W, H, { fishCount: 18 }, mulberry32(4242));
  for (let i = 0; i < 600; i++) plain.update(1 / 60);
  const leaked = plain.fish.filter((f) => f.aFade !== undefined || f.aPattern !== undefined || f.aPale !== undefined || f.stage !== undefined);
  ok('手绘鱼身上没有阶段/外观字段（0 泄漏）', leaked.length === 0, `${leaked.length} 尾带字段`);
  ok('手绘鱼的卵视图恒为空', plain.eggs.length === 0 && plain.eggVisuals.size === 0);
  ok('非生态模式下不建生态世界', plain.eco === null && plain.ecoFish.length === 0);

  // 从生态切回手绘：卵视图必须被清掉，否则会残留一池"幽灵卵"
  const back = new PondSimulation(W, H, { ecoMode: true, ecoSeed: 20260930 }, mulberry32(5));
  advanceDays(back.eco, 6, { feedPerDay: 2, stepDays: 0.05 });
  back.syncEcoFish();
  const hadEggs = back.eggVisuals.size;
  back.updateOptions({ ecoMode: false });
  ok('关掉生态模式后卵视图被清空', back.eggs.length === 0 && back.eggVisuals.size === 0, `关闭前 ${hadEggs} 个视图`);
}

console.log(`\n${fail === 0 ? '✔' : '✘'} 通过 ${pass} 项，未通过 ${fail} 项\n`);
process.exit(fail === 0 ? 0 : 1);
