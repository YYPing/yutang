/* 存档（§14.1 快照）往返验证。
 *
 * ★ 核心断言是「读档不改变未来」：
 *     同一个世界 W，存档后分成两支 —— 一支继续跑，一支读档后跑同样时长，
 *     两支的统计必须**逐字段相同**。
 *   这条能一次性抓住三类最隐蔽的错误：
 *     ① rng 状态没存 ⇒ 读档后随机序列从头开始，突变/性别/花纹会跳变
 *     ② id 计数器没接上 ⇒ 新生鱼与旧鱼 id 撞车，parents 亲缘指向错的鱼
 *     ③ 某个生态字段漏存 ⇒ 那一项在两条支线上演化出不同结果
 *
 * 跑法：node tools/smoke-save.js
 */
import { createWorld, advanceDays, serialize, restoreWorld, stats as ecoStats, SAVE_SCHEMA_VERSION } from '../src/engine/eco/world.js';
import { makeRng } from '../src/engine/eco/rng.js';
import { PondSimulation } from '../src/engine/simulation.js';
import { SAVE_ENVELOPE_VERSION, loadPondSave, writePondSave, clearPondSave } from '../src/lib/save-store.js';

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✔ ${label}${detail ? '  — ' + detail : ''}`); }
  else { fail++; console.log(`  ✘ ${label}${detail ? '  — ' + detail : ''}`); }
};

// 可复现随机源（mulberry32），与 smoke-eco-bridge.js 同一套
function makeRandom(seed = 12345) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

console.log('\n=== ① rng 状态必须能存取 ===');
{
  const a = makeRng(12345);
  for (let i = 0; i < 10; i++) a.next();
  const state = a.state();
  const expect = [a.next(), a.next(), a.next()];

  const b = makeRng(999);        // 故意用不同的 seed 起手
  b.restore(state);              // 恢复到 a 的中间状态
  const got = [b.next(), b.next(), b.next()];
  ok('restore(state()) 后序列完全一致', expect.every((v, i) => v === got[i]), `${expect[0].toFixed(6)} vs ${got[0].toFixed(6)}`);
}

console.log('\n=== ② 序列化往返：状态一致 ===');
let snap;
{
  const world = createWorld({ seed: 20260930, viewportShortPx: 900 });
  advanceDays(world, 20, { feedPerDay: 3, stepDays: 0.25 });
  for (const fish of world.fishes) { fish.x = 100; fish.y = 200; fish.heading = 1.5; fish.variant = 3; }
  snap = serialize(world);
  ok('schemaVersion 就位', snap.schemaVersion === SAVE_SCHEMA_VERSION, `v${snap.schemaVersion}`);
  ok('是纯 JSON（可 round-trip）', (() => {
    try { return JSON.stringify(JSON.parse(JSON.stringify(snap))) === JSON.stringify(snap); }
    catch { return false; }
  })());

  const back = restoreWorld(JSON.parse(JSON.stringify(snap)));
  ok('重建成功', !!back);
  const a = ecoStats(world), b = ecoStats(back);
  ok('pondDays 一致', Math.abs(a.pondDays - b.pondDays) < 0.2, `${a.pondDays} vs ${b.pondDays}`);
  ok('存活数一致', a.alive === b.alive, `${a.alive} vs ${b.alive}`);
  ok('出生/死亡累计一致', a.born === b.born && a.died === b.died, `${a.born}/${a.died}`);
  ok('最高世代一致', a.maxGeneration === b.maxGeneration, `第 ${a.maxGeneration} 代`);
  ok('平均体长一致', Math.abs(a.avgLengthCm - b.avgLengthCm) < 1e-6, `${a.avgLengthCm}cm`);
  // ⚠️ 比对基准要排除 dead —— serialize() 不存已死的鱼（它们只是还没被回收的残骸）。
  //    拿 world.fishes 直接比会假失败：那边还留着播完死亡动画的记录。
  const aliveInWorld = world.fishes.filter((f) => !f.dead);
  const idsOf = (list) => JSON.stringify(list.map((f) => f.id).sort((x, y) => x - y));
  ok('id 集合一致', idsOf(aliveInWorld) === idsOf(back.fishes), `${aliveInWorld.length} vs ${back.fishes.length}`);
  ok('基因逐条一致', aliveInWorld.every((f) => {
    const twin = back.fishes.find((g) => g.id === f.id);
    return twin && JSON.stringify(twin.genes) === JSON.stringify(f.genes);
  }));
  ok('运动字段被保留', back.fishes.every((f) => f.x === 100 && f.y === 200 && f.variant === 3));
  ok('行为标记已置位（不会再随机位置）', back.fishes.every((f) => f.behaviorReady === true && f.eco === true));
}

console.log('\n=== ③ ★ 读档不改变未来（最强断言）===');
{
  const world = createWorld({ seed: 4242, viewportShortPx: 900 });
  advanceDays(world, 10, { feedPerDay: 2, stepDays: 0.25 });
  const saved = JSON.parse(JSON.stringify(serialize(world)));

  const live = world;                                   // 支线 A：一路跑下去
  const revived = restoreWorld(saved);                  // 支线 B：读档后跑

  for (const step of [5, 15]) {
    advanceDays(live, step, { feedPerDay: 2, stepDays: 0.25 });
    advanceDays(revived, step, { feedPerDay: 2, stepDays: 0.25 });
    const a = ecoStats(live), b = ecoStats(revived);
    const fields = ['alive', 'eggs', 'born', 'died', 'maxGeneration', 'avgAgeDays', 'avgLengthCm', 'avgCondition'];
    const diff = fields.filter((key) => a[key] !== b[key]);
    ok(`累计推进 ${step} 天后两支完全一致`, diff.length === 0,
      diff.length ? diff.map((k) => `${k}: ${a[k]} vs ${b[k]}`).join(' | ')
        : `存活 ${a.alive} · 出生 ${a.born} · 世代 ${a.maxGeneration}`);
  }
}

console.log('\n=== ④ 防御性校验（存档是不可信输入）===');
{
  const bad = [
    ['null', null],
    ['不是对象', 'oops'],
    ['数组', []],
    ['schemaVersion 不匹配', { schemaVersion: 999, fishes: [] }],
    ['fishes 不是数组', { schemaVersion: SAVE_SCHEMA_VERSION, fishes: 'nope' }],
    ['fishes 超长', { schemaVersion: SAVE_SCHEMA_VERSION, fishes: new Array(3000).fill({}) }],
  ];
  for (const [label, value] of bad) ok(`拒绝：${label}`, restoreWorld(value) === null);

  // 字段被手改成垃圾 ⇒ 不能抛异常，要退回默认值
  const world = createWorld({ seed: 7 });
  advanceDays(world, 3, { feedPerDay: 1, stepDays: 0.5 });
  const tampered = JSON.parse(JSON.stringify(serialize(world)));
  const victim = tampered.fishes[0];
  victim.ageDays = 'NaN'; victim.lengthCm = Infinity; victim.satiety = -999;
  victim.genes = { palette: '不存在的品系', sizeLinf: 999, growthK: 'x' };
  victim.motion = { x: null, y: 'oops' };
  tampered.pondDays = -5; tampered.stats = 'broken';
  let salvaged = null;
  try { salvaged = restoreWorld(tampered); } catch (error) { console.log('    抛异常了：', error.message); }
  ok('脏字段不抛异常', !!salvaged);
  if (salvaged) {
    const f = salvaged.fishes.find((z) => z.ageDays >= 0) || salvaged.fishes[0];
    ok('体长被夹回合法区间', salvaged.fishes.every((z) => Number.isFinite(z.lengthCm) && z.lengthCm > 0 && z.lengthCm <= z.lCapCm));
    ok('饱食退回地板以上', salvaged.fishes.every((z) => z.satiety >= 15));
    ok('品系退回红白', salvaged.fishes.some((z) => z.genes.palette === 'kohaku'));
    ok('坏基因位被夹紧', salvaged.fishes.every((z) => z.genes.sizeLinf >= 0.8 && z.genes.sizeLinf <= 1.2));
    ok('pondDays 被夹到 0', salvaged.pondDays === 0);
    ok('stats 退回骨架', salvaged.stats && typeof salvaged.stats.born === 'number');
    ok('世界仍可继续推进', (() => {
      try { advanceDays(salvaged, 2, { feedPerDay: 1 }); return Number.isFinite(ecoStats(salvaged).alive); }
      catch { return false; }
    })());
  }
}

console.log('\n=== ⑤ 离线补算（F-14.2）===');
{
  const world = createWorld({ seed: 55, viewportShortPx: 900 });
  advanceDays(world, 5, { feedPerDay: 3, stepDays: 0.25 });
  const before = ecoStats(world);
  // F-14.2.4 离线无投喂 ⇒ feedPerDay 0
  advanceDays(world, 3, { feedPerDay: 0, stepDays: 0.25 });
  const after = ecoStats(world);
  ok('离线仍推进池塘日', after.pondDays > before.pondDays, `+${(after.pondDays - before.pondDays).toFixed(2)} 池塘日`);
  ok('离线不喂仍不断代', after.alive > 0, `存活 ${after.alive}`);
  ok('离线期间有死亡结算', after.died >= before.died, `死亡 ${before.died} → ${after.died}`);

  // F-14.2.3 补算上限 30 天
  const capped = createWorld({ seed: 56 });
  const t0 = capped.pondDays;
  advanceDays(capped, 365, { feedPerDay: 0, stepDays: 0.25 });
  const advanced = capped.realDays;
  ok('超过 30 天被截断', advanced <= 30.001, `请求 365 天，实际补算 ${advanced.toFixed(2)} 天`);
}

console.log('\n=== ⑥ 存档接进引擎：ecoSnapshot / 离线补算 / 归来摘要 / 全量重置 ===');
{
  const sim = new PondSimulation(1380, 900, { ecoMode: true }, makeRandom(31337));
  for (let i = 0; i < 600; i++) sim.update(1 / 60);      // 先游 10 真实秒
  const pond = sim.getSnapshot();
  ok('getSnapshot() 给出可序列化快照', !!pond && pond.schemaVersion === SAVE_SCHEMA_VERSION, `v${pond?.schemaVersion}`);
  ok('快照不带 lastSeenWallClock（那是信封的事）', pond.lastSeenWallClock === undefined);

  // App.jsx 就是这么喂的：把信封里的墙钟时间合并进快照
  const lastSeenWallClock = Date.now() - 8 * 3600 * 1000;   // 8 小时前离开
  const restored = new PondSimulation(1380, 900, {
    ecoMode: true,
    ecoSnapshot: { ...pond, lastSeenWallClock },
  }, makeRandom(31337));

  const report = restored.takeAwayReport();
  ok('读档后产出归来摘要', !!report, report ? `离开 ${report.awayDays} 天` : '');
  ok('摘要时长 ≈ 8 小时', !!report && Math.abs(report.awayDays - 8 / 24) < 0.01, `${report?.awayDays} 天`);
  ok('摘要含出生/离世/世代/存活', !!report && ['born', 'died', 'maxGeneration', 'alive'].every((k) => Number.isFinite(report[k])));
  ok('摘要的池日增量为正', !!report && report.pondDays > 0, `+${report?.pondDays} 池塘日`);
  ok('未超 30 天 ⇒ 不标 capped', report?.capped === false);
  ok('摘要只播一次（第二次为 null）', restored.takeAwayReport() === null);
  ok('读档后池塘日 ≥ 存档时', restored.eco.pondDays >= pond.pondDays, `${pond.pondDays.toFixed(2)} → ${restored.eco.pondDays.toFixed(2)}`);
  ok('读档后行为字段全部有限', restored.fish.every((f) => Number.isFinite(f.x) && Number.isFinite(f.y) && Number.isFinite(f.length)));
  ok('读档后能继续跑 60 帧', (() => { try { for (let i = 0; i < 60; i++) restored.update(1 / 60); return true; } catch { return false; } })());

  // F-14.2.3：离开 400 天 ⇒ 只补算 30 天，并且摘要必须如实标注
  const long = new PondSimulation(1380, 900, {
    ecoMode: true,
    ecoSnapshot: { ...pond, lastSeenWallClock: Date.now() - 400 * 86400000 },
  }, makeRandom(31337));
  const longReport = long.takeAwayReport();
  ok('离开 400 天 ⇒ 标 capped', longReport?.capped === true);
  ok('离开 400 天 ⇒ 实际只补 30 天', longReport?.awayDays === 400 && long.eco.realDays <= 30.001, `realDays=${long.eco.realDays.toFixed(2)}`);

  // F-14.1.4 全量重置：池龄归零 + 指定条数
  const before = restored.eco.pondDays;
  restored.resetEcoFully(12);
  ok('resetEcoFully(12) ⇒ 12 尾', restored.ecoFish.length === 12, `实际 ${restored.ecoFish.length}`);
  ok('resetEcoFully ⇒ 池龄归零', restored.eco.pondDays === 0 && before > 0, `${before.toFixed(2)} → ${restored.eco.pondDays}`);
  ok('resetEcoFully ⇒ 世代归 1', ecoStats(restored.eco).maxGeneration === 1);
  ok('resetEcoFully ⇒ 摘要被清掉', restored.lastAwayReport === null);
  ok('重置后体长仍有限', restored.ecoFish.every((f) => Number.isFinite(f.length) && f.length > 0));
}

console.log('\n=== ⑦ save-store：两条通道互为备份，读档取较新 ===');
{
  const memory = new Map();
  globalThis.localStorage = {
    getItem: (key) => (memory.has(key) ? memory.get(key) : null),
    setItem: (key, value) => { memory.set(key, String(value)); },
    removeItem: (key) => { memory.delete(key); },
  };
  let fileBox = null;                                     // 模拟磁盘上的 userData/save.json
  globalThis.window = {
    pondDesktop: {
      loadSave: async () => (fileBox ? JSON.parse(JSON.stringify(fileBox)) : null),
      writeSave: async (data) => { fileBox = data === null ? null : JSON.parse(JSON.stringify(data)); return true; },
    },
  };

  const envelope = (clock) => ({ schemaVersion: SAVE_ENVELOPE_VERSION, lastSeenWallClock: clock, pond: { schemaVersion: SAVE_SCHEMA_VERSION, fishes: [] }, preferences: {} });

  ok('两边都没档 ⇒ null', (await loadPondSave()).source === null);
  await writePondSave(envelope(1000));
  const both = await loadPondSave();
  ok('写档后两条通道都有', both.envelope?.lastSeenWallClock === 1000 && !!fileBox, `source=${both.source}`);

  fileBox = envelope(2000);                               // 模拟「文件更新，localStorage 落后」
  const newer = await loadPondSave();
  ok('取较新的那份（文件）', newer.envelope?.lastSeenWallClock === 2000 && newer.source === 'file');

  // ⚠️ 这里只改了 fileBox，兜底通道还停在 1000（上一次 writePondSave 写的），
  //    所以「较新的那份」是兜底。这正是要测的分支：文件落后 ⇒ 不能被它顶掉。
  fileBox = envelope(500);
  const newerLocal = await loadPondSave();
  ok('取较新的那份（兜底）', newerLocal.envelope?.lastSeenWallClock === 1000 && newerLocal.source === 'fallback',
    `clock=${newerLocal.envelope?.lastSeenWallClock} · source=${newerLocal.source}`);

  fileBox = { schemaVersion: 1, pond: 'oops' };            // 文件被写坏
  const salvaged = await loadPondSave();
  ok('文件坏掉时退回兜底', salvaged.source === 'fallback', `source=${salvaged.source}`);

  memory.set('fusheng-pond-save', '{ 不是 JSON');
  fileBox = envelope(3000);
  const brokenLocal = await loadPondSave();
  ok('兜底坏掉时退回文件', brokenLocal.source === 'file', `source=${brokenLocal.source}`);

  await clearPondSave();
  const cleared = await loadPondSave();
  ok('clearPondSave 清掉两条通道', cleared.source === null && fileBox === null, `source=${cleared.source}`);

  delete globalThis.window;
  delete globalThis.localStorage;
}

console.log(`\n${fail === 0 ? '✔' : '✘'} 通过 ${pass} 项，未通过 ${fail} 项\n`);
process.exit(fail === 0 ? 0 : 1);
