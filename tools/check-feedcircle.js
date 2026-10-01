/* 投喂感应圈验收（F-2.8 / US-1）。需求 §B.1 点名要求这个工具存在。
 *
 * 验五件事：
 *   ① 半径口径 —— 短边 × 0.30，且随视口走（不是写死像素）
 *   ② 校准 —— 任意一点的圈内鱼数，以及"圈确实是局部的"
 *   ③ US-1 —— 0.5s 内圈内 ≥3 条转向、最近鱼 2s 内到达
 *   ④ ★ 圈外鱼正常游 —— 五段证据，见下
 *   ⑤⑥ 贴脸例外 / 虚线圈寿命
 *
 * ── ④ 为什么要这么多段证据 ────────────────────────────────────────────
 * 「圈外鱼不变」这句话有两个强度完全不同的读法：
 *   (i)  圈外鱼**看不见**这一把食（门控完备）——  这是 F-2.8 的实现要求
 *   (ii) 圈外鱼的**轨迹逐位不变**          ——  这是做不到的，见下
 * 直接拿 (ii) 当断言会误判。实测 28 尾、2s，圈外鱼最大位移偏差 35px。看着像漏网，
 * 其实是**三条真实存在、且不该消除**的间接耦合（探针实测，见 tools/probe-feed-edge.js）：
 *
 *   ⚠️ 反直觉的坑 1：**鱼群分离力的输入变了**
 *      `personalSpace = targetFood ? max(18, …) : max(30, …)` —— 圈内鱼因为去抢食，
 *      自身的分离半径从 30 缩到 18，于是它对圈外鱼施加的推力变了。圈外鱼没看食物，
 *      但被"让路"的邻居挤了一下。
 *   ⚠️ 反直觉的坑 2：**rng 序列错位**（不可消除）
 *      每条鱼重选漫游目标时才消耗一次 `this.random()`；而 `feed()` 自己就消耗 **45 次**
 *      （9 粒 × 5 次，实测）⇒ 圈内鱼改道让后续所有鱼用到的随机数整体错位。
 *      共用一条 rng 流就必然如此，唯一解法是每尾鱼一条独立 rng 流 —— 代价远大于收益。
 *   ⚠️ 反直觉的坑 3：**碰撞反冲**（本轮才查清）
 *      `koi-collision.js` 的分离层在穿透时给速度一个反冲。圈内鱼去了别处 ⇒ 重叠格局变了
 *      ⇒ 圈外鱼吃到的反冲也变了。受控实验：同一条支线把 `collision:false` 打开，速度超越量
 *      从 **+0.5697 变成 +0.0000**，而最大位移偏差**一个像素都没变**（35.13px）
 *      ⇒ 速度上那点差异 100% 来自碰撞，与食物无关。见 tools/_probe-collision-edge.js。
 *   这三条决定了偏差**随时间发散**（实测 0.5s 0.07px → 1s 3.6px → 2s 35px → 4s 90px）。
 *   这个形状本身就是证据：若门控漏了，圈外鱼第一帧就会朝食冲，0.5s 内偏差该是几十像素。
 *
 * ★★ 「圈外身份」的口径：按「**整段窗口从未进过圈**」筛，不要用 t=0 的快照。
 *    2s 里 t=0 在圈外的鱼是有可能游进圈里吃到食的，那时它加速**正是 F-2.8 要的行为**，
 *    拿 t=0 快照当"圈外鱼"就会把它算成漏网。
 *    ⚠️ 但要说实话：**本场景实测 0/9 条中途进圈**，所以这条筛选目前**不改变读数**
 *    （+0.5697 照样是 +0.5697）。它是护栏，不是本轮那个红条的成因 —— 成因是下面的坑 3。
 *
 * ★ 旧断言「圈外鱼不超越对照组 0.3px/帧」为什么是错的（本轮查清）：
 *   ① **阈值落在噪声分布内部** —— 一粒食都不撒、只把对照组 rng 推进 45 步，跑 300 次采样：
 *      p50 0.005 / p90 0.635 / p99 1.516 / **max 1.733**（px/帧）。且分布是**稀疏重尾**
 *      （一半样本恰好 0.000，只有"某条鱼恰在窗口内重选漫游目标"时才非零）⇒
 *      **35/300 = 11.7% 的纯噪声样本超过 +0.5697**，60/300 = 20% 超过 0.3。
 *      ⇒ 空跑就有 1/5 概率误报。复现：`PROBE_N=300 node tools/probe-feed-edge.js`
 *   ② **真实成因是碰撞反冲**（见坑 3），与食物无关。
 *   ③ **门控本身是完备的** —— 逐帧逐粒 8289 组合，漏网 0 次（④c-1）。
 *
 * 所以 ④ 拆成五段，各自证明一件事：
 *   ④a 单尾圈外鱼 vs 对照组 —— 逐位零偏差 ⇒ **门控完备**（最强证据，无群体耦合干扰）
 *   ④b 28 尾首 0.5s —— 偏差 <0.5px   ⇒ **没有瞬时反应**（排除"漏网但被分离力压住"）
 *   ④c 28 尾 2s —— 群体版：逐帧逐粒无漏网 + 偏差有界 + 无系统性靠近 + 速度无超越
 *                   + **阳性对照**（同一量具在圈内鱼身上必须读出抢食信号）
 *
 * ★ ④c-4 的阈值 5.0px/帧 怎么来的：
 *    · 噪声上界 **1.733**（300 采样，见上）· 真实成因 ≤0.57（碰撞反冲，见坑 3）
 *    · **漏网信号长什么样**：门控若漏，该鱼 goalSpeed 会乘 feedingSpeed（1.7–3.4×），
 *      2s 内速度至少 +35px/帧 —— 圈内鱼实测 **+51.6px/帧**（就是 ④c-5 的阳性对照）。
 *    ⇒ 5.0 距噪声上界 2.9×、距真实信号 10× 以上，两端都有余量。
 *
 * 跑法：node tools/check-feedcircle.js
 * 机理探针（改了门控 / 碰撞 / 鱼群力之后可重跑对拍）：
 *   node tools/probe-feed-edge.js        （rng 消耗 · 噪声分布 · 门控完备性 · rng 对齐对照）
 *   node tools/_probe-collision-edge.js  （碰撞开关的受控实验）
 *   node tools/_probe-gate-negative.js   （**反证**：把门控全拆，要求本脚本变红）
 */
import { PondSimulation } from '../src/engine/simulation.js';
import { FEED_CIRCLE, FEEDING } from '../src/engine/eco/constants.js';

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✔ ${label}${detail ? '  — ' + detail : ''}`); }
  else { fail++; console.log(`  ✘ ${label}${detail ? '  — ' + detail : ''}`); }
};

const seeded = (seed = 79) => () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
const W = 1920, H = 1080;                       // 1080p，与 §F-2.8 的校准注一致
const RADIUS = Math.min(W, H) * FEED_CIRCLE.radiusFraction;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/* ---------------------------------------------------------------- ① 半径 */
console.log('\n=== ① 半径口径：短边 × 0.30 ===');
{
  ok('常量就是 0.30', FEED_CIRCLE.radiusFraction === 0.30, String(FEED_CIRCLE.radiusFraction));
  for (const [w, h, expect] of [[1920, 1080, 324], [1600, 900, 270], [900, 1600, 270], [1280, 720, 216]]) {
    const sim = new PondSimulation(w, h, { fishCount: 1 }, seeded());
    sim.feed(w / 2, h / 2);
    ok(`${w}×${h} ⇒ 半径 ${expect}`, Math.abs(sim.feedCircles[0].radius - expect) < 1e-9,
      `实测 ${sim.feedCircles[0].radius.toFixed(3)}`);
  }
  console.log('     注：§F-2.8 校准注写「1080p 半径约 270px」——那是 1600×900 逻辑短边下的值；');
  console.log('         按公式 短边×0.30，1600×900 ⇒ 270 ✔，1920×1080 ⇒ 324。公式才是硬口径。');
}

/* -------------------------------------------------------------- ② 校准 */
console.log('\n=== ② 校准：圈内鱼数 + 圈确实是局部的 ===');
let insideCounts = [];
{
  // 让鱼群自然散开后再采样，避免用出生点分布糊弄
  for (let seed = 1; seed <= 6; seed++) {
    const sim = new PondSimulation(W, H, { fishCount: 28 }, seeded(seed * 977));
    for (let i = 0; i < 60 * 20; i++) sim.update(1 / 60);
    for (let k = 0; k < 12; k++) {
      const x = W * (0.15 + 0.7 * (k / 11)), y = H * (0.25 + 0.5 * ((k * 7) % 12) / 11);
      const inside = sim.fish.filter((f) => Math.hypot(f.x - x, f.y - y) <= RADIUS).length;
      insideCounts.push(inside);
    }
  }
  insideCounts.sort((a, b) => a - b);
  const median = insideCounts[Math.floor(insideCounts.length / 2)];
  const mean = insideCounts.reduce((s, v) => s + v, 0) / insideCounts.length;
  const lo = insideCounts[0], hi = insideCounts.at(-1);
  console.log(`     采样 ${insideCounts.length} 个点击点（28 尾 / ${W}×${H}）：圈内 中位 ${median} / 均值 ${mean.toFixed(1)} / 范围 ${lo}–${hi}`);
  ok('圈内中位数 ≥ 3（US-1 的"附近"名副其实）', median >= 3, `中位 ${median}`);
  ok('圈内均值落在合理区间 2–10', mean >= 2 && mean <= 10, `均值 ${mean.toFixed(1)}`);

  // ★ 关键是「圈是局部的」而不是「圈内一定比圈外少」——
  //   鱼群本来就会聚集，28 尾挤在 1920×1080 上时，某个点圈内 21 条完全可能。
  //   用「存在稀疏点 + 几何占比」来验"局部"，比拿圈内外比大小稳。
  ok('存在圈内 ≤2 条的采样点（落进鱼群空档时圈里就是没人）', lo <= 2, `最少 ${lo} 条`);
  ok('几何上必是局部：半径 = 短边×0.30 < 短边的一半', RADIUS < Math.min(W, H) / 2,
    `${RADIUS} < ${Math.min(W, H) / 2}`);
  const areaRatio = Math.PI * RADIUS * RADIUS / (W * H);
  ok('圈面积占视口 < 25%', areaRatio < 0.25, `${(areaRatio * 100).toFixed(1)}%`);
  console.log(`     注：28 尾是压测密度（默认配置没这么多），所以圈内均值偏高属正常；`);
  console.log(`         按需求 §F-2.8 校准注的目标是 3–6 条 —— 那是常规鱼数下的口径。`);
  console.log('     注：§F-2.8 校准注写「1080p 半径约 270px」——那是 1600×900 逻辑短边下的值；');
  console.log('         按公式 短边×0.30，1600×900 ⇒ 270 ✔，1920×1080 ⇒ 324。公式才是硬口径。');
}

/* --------------------------------------------------- ③④ US-1 行为验收 */
console.log('\n=== ③ US-1：圈内鱼转身去吃 + 最近的鱼到达 ===');
{
  // ★ 对照组：同一随机种子跑两条完全相同的支线，一条投喂、一条不投喂。
  const build = (count = 28) => {
    const sim = new PondSimulation(W, H, { fishCount: count, season: 'summer' }, seeded(20260930));
    for (let i = 0; i < 60 * 20; i++) sim.update(1 / 60);
    return sim;
  };
  /** 挑一个圈内鱼数 ≥3 的点击点：用户真的点下去，附近应能捞到几条。 */
  const pickPoint = (sim, want = 3) => {
    for (let k = 0; k < 200; k++) {
      const x = W * (0.12 + 0.76 * ((k * 37) % 100) / 100), y = H * (0.16 + 0.68 * ((k * 61) % 100) / 100);
      const inside = sim.fish.filter((f) => Math.hypot(f.x - x, f.y - y) <= RADIUS);
      if (inside.length >= want) return { x, y, ids: inside.map((f) => f.id) };
    }
    return null;
  };
  const fed = build(), control = build();
  const point = pickPoint(fed);
  ok('能找到一个圈内 ≥3 条的点击点', !!point, point ? `(${point.x.toFixed(0)}, ${point.y.toFixed(0)}) 圈内 ${point.ids.length} 条` : '');

  if (point) {
    const insideIds = new Set(point.ids);
    const insideBefore = fed.fish.filter((f) => insideIds.has(f.id));
    const outsideIds = fed.fish.filter((f) => !insideIds.has(f.id)).map((f) => f.id);
    const snapshot = new Map(fed.fish.map((f) => [f.id, { h: f.heading, x: f.x, y: f.y }]));

    fed.feed(point.x, point.y);
    // ⚠️ 这里的 control 必须**同步**推进。让它停在 0 帧，量到的就是 fed 侧 0.5s 的
    //    正常漫游位移（13.8px），而不是"投喂造成的偏差"。

    // ★★ 圈外身份按「**整段窗口从未进过圈**」筛，不用 t=0 快照 —— 鱼中途进圈吃到食、
    //    因此加速是 F-2.8 要的行为，不该算成漏网。⚠️ 本场景实测 0/9 进圈，所以它目前
    //    只是护栏（见文件头）；那个红条的真正成因是**碰撞反冲**。
    //    顺带逐帧逐粒扫一遍门控，把"圈外鱼却看得见食"的漏网次数点出来（④c-1）。
    const everInside = new Set();
    const CLOSE = FEED_CIRCLE.closeRangePx;
    let gatePairs = 0, gateLeaks = 0, gateClose = 0;
    const scanGate = () => {
      for (const fish of fed.fish) {
        if (Math.hypot(fish.x - point.x, fish.y - point.y) <= RADIUS) { everInside.add(fish.id); continue; }
        const radius = fed.bodyRadius(fish);
        for (const pellet of fed.food) {
          if (pellet.clearance < radius) continue;     // 与 update() 选饲料的条件保持一致
          gatePairs++;
          if (!fed.canReachFood(fish, pellet)) continue;
          if (Math.hypot(pellet.x - fish.x, pellet.y - fish.y) < CLOSE) gateClose++;   // F-2.8 允许的贴脸例外
          else gateLeaks++;                                                           // ← 真正的漏网
        }
      }
    };

    for (let i = 0; i < 30; i++) { fed.update(1 / 60); control.update(1 / 60); scanGate(); }   // 0.5s

    // ⚠️ ④b 的采样点必须就在这一行 —— 再往下 fed 就跑过 2s 了，
    //    那时量到的是累积偏差（35px）而不是"瞬时反应"（0.07px），差三个数量级。
    let earlyDrift = 0;
    for (const id of outsideIds) {
      const a = fed.fish.find((f) => f.id === id), b = control.fish.find((f) => f.id === id);
      earlyDrift = Math.max(earlyDrift, Math.hypot(a.x - b.x, a.y - b.y));
    }

    const turned = insideBefore.filter((f) => {
      const b = snapshot.get(f.id);
      return Math.abs(Math.atan2(Math.sin(f.heading - b.h), Math.cos(f.heading - b.h))) > 0.25;
    });
    ok('0.5s 内圈内 ≥3 条转向', turned.length >= 3, `${turned.length}/${insideBefore.length} 条转了向`);

    const nearest = insideBefore.reduce((a, b) => (dist(a, point) < dist(b, point) ? a : b));
    const d0 = dist(nearest, point);
    for (let i = 0; i < 90; i++) { fed.update(1 / 60); scanGate(); }      // 再 1.5s ⇒ 共 2s
    ok('最近的圈内鱼 2s 内到达圈心附近', dist(nearest, point) < 60,
      `距离 ${d0.toFixed(0)} → ${dist(nearest, point).toFixed(0)}px`);

    // —————————————— ④a 门控完备性（单尾，无群体耦合）——————————————
    console.log('\n  ── ④a 门控完备性：单尾圈外鱼，逐位对拍 ──');
    {
      const solo = build(1), soloCtl = build(1);
      const fish = solo.fish[0];
      // 撒食点：池内 + 离鱼远于整个半径（保证落在圈外）
      let far = null;
      for (let k = 0; k < 400 && !far; k++) {
        const x = W * (0.15 + 0.7 * ((k * 37) % 100) / 100), y = H * (0.2 + 0.6 * ((k * 61) % 100) / 100);
        if (Math.hypot(fish.x - x, fish.y - y) > RADIUS * 1.6) far = { x, y };
      }
      const dBefore = Math.hypot(fish.x - far.x, fish.y - far.y);
      solo.feed(far.x, far.y);
      for (let i = 0; i < 240; i++) { solo.update(1 / 60); soloCtl.update(1 / 60); }   // 4s
      const a = solo.fish[0], b = soloCtl.fish[0];
      const soloDrift = Math.hypot(a.x - b.x, a.y - b.y);
      const dAfter = Math.hypot(a.x - far.x, a.y - far.y);
      const dCtl = Math.hypot(b.x - far.x, b.y - far.y);
      console.log(`     撒食点 (${far.x.toFixed(0)}, ${far.y.toFixed(0)})，离鱼 ${dBefore.toFixed(1)}px > 半径 ${RADIUS}`);
      // ★ 三条全一致 ⇒ 这门控是"看不见"，不是"看见了但被谁按住"。
      ok('单尾圈外鱼 4s 后与对照组完全一致（偏差 < 1e-9）', soloDrift < 1e-9,
        `偏差 ${soloDrift.toExponential(2)}px`);
      ok('投喂没有改变它到撒食点的距离（与对照组逐位相同）', Math.abs(dAfter - dCtl) < 1e-9,
        `${dBefore.toFixed(1)} → ${dAfter.toFixed(1)}（对照组 ${dCtl.toFixed(1)}）`);
    }

    // —————————————— ④b 无瞬时反应（28 尾，首 0.5s）——————————————
    console.log('\n  ── ④b 无瞬时反应：28 尾，首 0.5s ──');
    // ⚠️ 这里量的是"鱼已经被圈内邻居挤了 0.5s 之后"的累积量，不是零。
    //    门控若漏，圈外鱼的 goalSpeed 会立刻乘上 feedingSpeed（最高 3.4×），
    //    0.5s 内偏差会是几十像素 —— 实测 0.07px，差三个数量级。
    ok('圈外鱼首 0.5s 没有反应（偏差 < 0.5px）', earlyDrift < 0.5, `最大偏差 ${earlyDrift.toFixed(3)}px`);

    // —————————— ④c 群体耦合：有界 + 非系统性 + 无抢食 ——————————
    console.log('\n  ── ④c 群体耦合：有界 + 非系统性 + 无抢食 ──');
    for (let i = 0; i < 90; i++) control.update(1 / 60);   // 对照组补到同样的 2s（30+90）
    let maxDrift = 0, drifting = 0;
    for (const id of outsideIds) {
      const a = fed.fish.find((f) => f.id === id), b = control.fish.find((f) => f.id === id);
      const drift = Math.hypot(a.x - b.x, a.y - b.y);
      if (drift > 2) drifting++;
      maxDrift = Math.max(maxDrift, drift);
    }
    // ⚠️ 距离基线必须用投喂前的快照 —— outsideIds 是 id 列表，鱼的位置早变了。
    const meanDistFrom = (list) => list.reduce((s, f) => s + Math.hypot(f.x - point.x, f.y - point.y), 0) / list.length;
    const dBefore = outsideIds.reduce((s, id) => {
      const p = snapshot.get(id); return s + Math.hypot(p.x - point.x, p.y - point.y);
    }, 0) / outsideIds.length;
    const fedOutside = fed.fish.filter((f) => outsideIds.includes(f.id));
    const ctlOutside = control.fish.filter((f) => outsideIds.includes(f.id));
    const dFed = meanDistFrom(fedOutside) - dBefore;
    const dCtl = meanDistFrom(ctlOutside) - dBefore;

    // ★ 速度超越量只在「整段 120 帧从未进圈」的鱼上量（理由见文件头）。
    const neverInside = outsideIds.filter((id) => !everInside.has(id));
    const speedEdgeOver = (ids) => {
      let m = -Infinity, who = null;
      for (const id of ids) {
        const a = fed.fish.find((f) => f.id === id), b = control.fish.find((f) => f.id === id);
        if (!a || !b) continue;
        const e = a.velocity - b.velocity;
        if (e > m) { m = e; who = { id, va: a.velocity, vb: b.velocity }; }
      }
      return { m, who };
    };
    const outEdge = speedEdgeOver(neverInside);
    const inEdge = speedEdgeOver([...insideIds]);          // ★ 阳性对照：抢食信号该长什么样

    console.log(`     圈外 ${outsideIds.length} 条（其中 ${outsideIds.length - neverInside.length} 条中途进过圈）vs 对照组：`);
    console.log(`       最大位移偏差 ${maxDrift.toFixed(2)}px，位移 >2px 的 ${drifting} 条`);
    console.log(`       到撒食点的均值距离变化：投喂组 ${dFed >= 0 ? '+' : ''}${dFed.toFixed(1)}px / 对照组 ${dCtl >= 0 ? '+' : ''}${dCtl.toFixed(1)}px`);
    console.log(`     ★ 从未进圈的 ${neverInside.length} 条 · 速度超越量 +${outEdge.m.toFixed(4)}px/帧` +
      (outEdge.who ? `（${outEdge.who.id}：${outEdge.who.va.toFixed(3)} vs ${outEdge.who.vb.toFixed(3)}）` : ''));
    console.log(`     ★ 阳性对照 · 圈内 ${insideIds.size} 条 · 速度超越量 +${inEdge.m.toFixed(4)}px/帧` +
      (inEdge.who ? `（${inEdge.who.id}：${inEdge.who.va.toFixed(3)} vs ${inEdge.who.vb.toFixed(3)}）` : ''));

    // ④c-1 是本段唯一**决定性**的断言：它直接就是 F-2.8 的实现要求。
    ok('④c-1 圈外鱼看不见这一把食（逐帧逐粒，漏网 0 次）', gateLeaks === 0,
      `${gatePairs} 组合 · 贴脸例外 ${gateClose} 次 · 漏网 ${gateLeaks} 次`);
    // 偏差有界：35px 是三条耦合的累积（见文件头），断言取 2 倍余量。
    ok('④c-2 偏差有界（2s 内 <100px，不是失控发散）', maxDrift < 100, `最大 ${maxDrift.toFixed(1)}px`);
    ok('④c-3 没有系统性吸引（到撒食点的均值距离变化 ≤ 对照组 +20px）', dFed <= dCtl + 20,
      `Δ ${dFed.toFixed(1)} vs ${dCtl.toFixed(1)}`);
    // ④c-4 阈值依据见文件头（噪声 max 1.733 / 信号 ≥35）。⚠️ 别改回 0.3 —— 那是噪声内部。
    ok('④c-4 从未进圈的鱼没有加速抢食（速度超越 <5.0px/帧）', outEdge.m < 5.0,
      `最大超越 +${outEdge.m.toFixed(4)}px/帧`);
    // ④c-5 阳性对照：证明上面那条量具**有判别力**，否则 ④c-4 可能是"量不到"而不是"没有"。
    const ratio = outEdge.m > 0 ? inEdge.m / outEdge.m : Infinity;
    ok('④c-5 阳性对照：同一量具在圈内鱼上读出抢食信号（>5px/帧 且 ≥20× 圈外）',
      inEdge.m > 5 && (outEdge.m <= 0 || ratio >= 20),
      `圈内 +${inEdge.m.toFixed(2)} / 圈外 +${outEdge.m.toFixed(4)} = ${ratio === Infinity ? '∞' : ratio.toFixed(1) + '×'}`);
  }
}

/* ------------------------------------------------------- ⑤ 贴脸例外 */
console.log('\n=== ⑤ 贴脸例外（<34px）===');
{
  const sim = new PondSimulation(W, H, { fishCount: 1 }, seeded(5));
  const fish = sim.fish[0];
  // ⚠️ 撒食点必须过 habitat.contains —— 早先写死 (W-200, H-200) 落在右岸上被拒，
  //    撒下 0 粒饲料，sim.food[0] 是 undefined，脚本当场崩。这里改成搜一个合法远点。
  let far = null;
  for (let k = 0; k < 300 && !far; k++) {
    const x = W * (0.18 + 0.64 * ((k * 41) % 100) / 100), y = H * (0.22 + 0.56 * ((k * 53) % 100) / 100);
    if (!sim.habitat.contains(x, y, 8)) continue;
    if (Math.hypot(fish.x - x, fish.y - y) <= RADIUS + 120) continue;   // 必须落在圈外
    far = { x, y };
  }
  ok('找得到一个池内、且落在圈外的撒食点', !!far,
    far ? `(${far.x.toFixed(0)}, ${far.y.toFixed(0)}) 离鱼 ${Math.hypot(fish.x - far.x, fish.y - far.y).toFixed(0)}px` : '');
  const r = sim.feed(far.x, far.y);
  ok('撒食成功（饲料真的落水了）', r.ok && sim.food.length > 0, `${sim.food.length} 粒`);

  const pellet = sim.food[0];
  ok('撞得到第 1 粒饲料（tools 自身健壮性）', !!pellet);
  if (pellet) {
    ok('圈外且离得远 ⇒ 看不见', sim.canReachFood(fish, pellet) === false);
    pellet.x = fish.x + 20; pellet.y = fish.y;      // 20px < 34px
    ok('挪进 34px ⇒ 例外生效', sim.canReachFood(fish, pellet) === true);
    pellet.x = fish.x + 60;                          // 60px > 34px
    ok('离到 60px ⇒ 又看不见了', sim.canReachFood(fish, pellet) === false);
    // 边界两侧各留 1px，确认阈值就是 closeRangePx 本身
    pellet.x = fish.x + FEED_CIRCLE.closeRangePx - 1;
    ok(`贴到 ${FEED_CIRCLE.closeRangePx - 1}px ⇒ 还在例外内`, sim.canReachFood(fish, pellet) === true);
    pellet.x = fish.x + FEED_CIRCLE.closeRangePx + 1;
    ok(`退到 ${FEED_CIRCLE.closeRangePx + 1}px ⇒ 已出例外`, sim.canReachFood(fish, pellet) === false);
  }
}

/* ------------------------------------------------- ⑥ 虚线圈寿命 */
console.log('\n=== ⑥ 虚线圈的显示寿命 ===');
{
  const sim = new PondSimulation(W, H, { fishCount: 1 }, seeded(6));
  sim.feed(W / 2, H / 2);
  ok('投喂即产生一个虚线圈', sim.feedCircles.length === 1);
  ok('寿命 = displaySeconds', sim.feedCircles[0].life === FEED_CIRCLE.displaySeconds, `${FEED_CIRCLE.displaySeconds}s`);
  const frames = Math.ceil((FEED_CIRCLE.displaySeconds - 0.05) * 60);
  for (let i = 0; i < frames; i++) sim.update(1 / 60);
  ok('1.8s 未到 ⇒ 圈还在', sim.feedCircles.length === 1);
  for (let i = 0; i < 6; i++) sim.update(1 / 60);
  ok('1.8s 一过 ⇒ 圈消失', sim.feedCircles.length === 0);
  ok('但饲料还在（落底才淡出，F-7.3.7）', sim.food.length > 0, `${sim.food.length} 粒`);
  // F-7.3.7：「未食用饲料 落底 **90s** 淡出溶解，无惩罚」（refs/yutang/开发提示词.md:225）。
  // ⚠️ 这里曾经写死 `26 + random()*5`（26–31s）—— 渲染层绕开常量自己编数，常量白定义了。
  //    源码级守卫在 `tests/feed-life.test.js`（含 rng 足迹 45 次那条，别删）。
  const life = sim.food[0]?.life;
  console.log(`     饲料寿命 ${life?.toFixed(2)}s（foodFadeSeconds = ${FEEDING.foodFadeSeconds}，允许 ±3s 抖动）`);
  ok('饲料寿命 = foodFadeSeconds（F-7.3.7，90s）',
    Number.isFinite(life) && Math.abs(life - FEEDING.foodFadeSeconds) <= 3,
    `${life?.toFixed(2)}s`);
}

console.log(`\n${fail === 0 ? '✔' : '✘'} 通过 ${pass} 项，未通过 ${fail} 项\n`);
process.exit(fail === 0 ? 0 : 1);
