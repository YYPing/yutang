/**
 * 验收：#10 APPETITE 参与抢食 · #11 池塘档案字段 · largestId 修复。
 *
 * 为什么不开窗口：这三项都是**纯逻辑/纯数据**层，开窗口反而引入
 * "vite 产物里没有源码路径"和 rAF 节流等噪声。真窗口渲染另有
 * `npm run check:desktop`（8 项）守着。
 *
 * 跑法：node tools/check-eco-detail.mjs
 */
import { pathToFileURL } from 'url';
import path from 'path';

const APP = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..');
const eco = await import(pathToFileURL(path.join(APP, 'src/engine/eco/feeding.js')).href);
const worldMod = await import(pathToFileURL(path.join(APP, 'src/engine/eco/world.js')).href);

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✔' : '✘'} ${name}${detail ? ' —— ' + detail : ''}`);
  ok ? pass++ : fail++;
};

console.log('--- #10 APPETITE 参与抢食 ---');
const mk = (appetite, satiety) => ({ satiety, genes: { appetite } });
const cGreedy = eco.forageSatietyCeilingFor(mk(1.2, 0));
const cPicky = eco.forageSatietyCeilingFor(mk(0.8, 0));
const cNeutral = eco.forageSatietyCeilingFor(mk(1.0, 0));
const cNoGenes = eco.forageSatietyCeilingFor({ satiety: 0 });
check('无 genes ⇒ 上限 = 85（与旧行为逐位一致）', cNoGenes === 85, String(cNoGenes));
// ⚠️ 判定是 `satiety < 有效上限`，所以**上限越高 = 越晚退出抢食 = 越贪**。
//    贪吃(1.2) 上限 86.7 ⇒ 86 还在抢、87 已停；挑食(0.8) 上限 83.3 ⇒ 84 就不抢了。
check('贪吃(1.2) 上限 > 中性 > 挑食(0.8)（方向正确）',
  cGreedy > cNeutral && cNeutral > cPicky, `${cGreedy} > ${cNeutral} > ${cPicky}`);
check('同一饱食 86：贪吃仍参与、挑食已退出（体现抢食意愿差异）',
  eco.wantsFood(mk(1.2, 86)) === true && eco.wantsFood(mk(0.8, 86)) === false,
  `greedy(86)=${eco.wantsFood(mk(1.2, 86))} picky(86)=${eco.wantsFood(mk(0.8, 86))}`);
check('分界点：贪吃 86.6 参与 / 86.8 退出（阈值 86.7）',
  eco.wantsFood(mk(1.2, 86.6)) === true && eco.wantsFood(mk(1.2, 86.8)) === false);
check('无 genes 鱼在 83 仍参与（不回归）', eco.wantsFood({ satiety: 83 }) === true);
check('饱食 99 时任何 appetite 都不参与（上限不越界）',
  eco.wantsFood(mk(1.2, 99)) === false && eco.wantsFood(mk(0.8, 99)) === false);

console.log('\n--- #11 池塘档案字段 ---');
const world = worldMod.createWorld(12345);
worldMod.resetPopulation(world, 8);
for (let i = 0; i < 60; i++) worldMod.advanceDays(world, 1);
const s = worldMod.stats(world);
for (const k of ['byStage', 'avgAgeDays', 'longestLivedDays', 'born', 'died', 'largestId']) {
  check(`stats.${k} 存在`, Object.keys(s).includes(k), JSON.stringify(s[k]));
}
check('largestId 已透出（修「最大一尾」永不显示）', s.largestId != null, String(s.largestId));
check('byStage 非空且有中文名可映射', Object.keys(s.byStage).length > 0, JSON.stringify(s.byStage));

console.log(`\n${pass} / ${pass + fail} 通过${fail ? ' —— 未过：' + fail : ''}`);
process.exit(fail ? 1 : 0);
