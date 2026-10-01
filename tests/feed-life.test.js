/* 饲料寿命 = `FEEDING.foodFadeSeconds` 的守卫（F-7.3.7）。
 *
 * ── 为什么需要这条 ────────────────────────────────────────────────────
 * 需求（`refs/yutang/开发提示词.md:225`，加粗）写的是：
 *   「未食用饲料 → 落底 **90s** 淡出溶解，无惩罚」
 * `eco/constants.js` 也一直有 `foodFadeSeconds: 90`，生态层（`eco/world.js`）也按它走。
 *
 * 但**渲染层自己编了一个数**：`simulation.js` 的 `feed()` 里写的是
 *   `life: 26 + this.random() * 5`   // 26–31s
 * ⇒ 常量白定义了，同一个需求条目在两处给两个数（项目自己的
 *   `docs/ECO-DESIGN-NOTES.md` 也跟着写成了 26–31s，错传了一层）。
 *
 * 这类"**渲染层绕开常量自己写魔数**"的失败是静默的：没有报错、单测全绿、
 * 只有拿需求和代码逐条对表才发现。所以补一条便宜守卫。
 *
 * ⚠️ 本文件同时钉死 `feed()` 的 **rng 足迹**，理由见第 3 条断言 ——
 *    那次 `random()` 不是"没用就删掉"的，它是逐位基线的一部分。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PondSimulation } from '../src/engine/simulation.js';
import { FEEDING } from '../src/engine/eco/constants.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = readFileSync(join(ROOT, 'src', 'engine', 'simulation.js'), 'utf8');
const W = 1920, H = 1080;
const seeded = (seed = 79) => () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };

/** 取出 `feed(x, y) {…}` 的方法体（到下一个方法 `canReachFood` 为止）。 */
function feedBody() {
  const a = SRC.indexOf('feed(x, y) {');
  assert.ok(a >= 0, 'simulation.js 里找不到 `feed(x, y) {` —— 结构变了，请同步更新本测试');
  const b = SRC.indexOf('canReachFood(fish, pellet) {', a);
  assert.ok(b > a, '`feed()` 之后找不到 `canReachFood` —— 结构变了，请同步更新本测试');
  return SRC.slice(a, b);
}

test('① 常量本身：foodFadeSeconds 就是需求给的 90', () => {
  assert.equal(FEEDING.foodFadeSeconds, 90,
    'F-7.3.7 写的是「落底 90s 淡出溶解」（refs/yutang/开发提示词.md:225）。改这个数必须同时改需求引用。');
});

test('★ ② 源码不变量：feed() 的 life 必须引用常量，不许是数字字面量', () => {
  const body = feedBody();
  assert.ok(/life:\s*FEEDING\.foodFadeSeconds/.test(body),
    '`feed()` 里没看到 `life: FEEDING.foodFadeSeconds` —— 渲染层又绕开常量自己编数了。'
    + '症状是「需求写 90s、画面上 30s 就没了」，且没有任何报错。');
  const m = body.match(/life:\s*([^,\n]+)/);
  assert.ok(m, '`feed()` 里找不到 `life:` 字段');
  assert.ok(!/^\d/.test(m[1].trim()),
    `life 的取值以字面量开头（${m[1].trim().slice(0, 40)}）—— 必须由 FEEDING.foodFadeSeconds 派生。`);
});

test('③ 行为：落下的每粒饲料寿命都≈90s（均值贴近，范围 ±10%）', () => {
  const sim = new PondSimulation(W, H, { fishCount: 1 }, seeded());
  const lives = [];
  for (let k = 0; k < 5; k++) {
    assert.ok(sim.feed(W / 2, H / 2).ok, '池心撒食不该被拒');
    for (const p of sim.food) lives.push(p.life);
    sim.food = [];                       // 清掉，避免撞上 200 粒上限
    sim.feedCircles = [];
  }
  assert.ok(lives.length >= 40, `样本太少（${lives.length}）—— 撒食没落够粒`);
  const lo = Math.min(...lives), hi = Math.max(...lives);
  const mean = lives.reduce((s, v) => s + v, 0) / lives.length;
  assert.ok(lo >= 81 && hi <= 99, `寿命范围 ${lo.toFixed(2)}–${hi.toFixed(2)}s 超出 90s 的 ±10%`);
  assert.ok(Math.abs(mean - 90) < 0.5, `寿命均值 ${mean.toFixed(3)}s 偏离 90s 过多`);
});

test('★★★ ④ rng 足迹：feed() 必须恰好消耗 45 次 random()', () => {
  //     9 粒 × 5 次（角度 / 半径 / 寿命抖动 / 相位 / 大小）。
  //
  // ⚠️ 为什么把次数钉死在这儿：`tools/trace-motion.js` 会在 120/300/500 帧各投喂一次，
  //    它守的是**鱼的运动逐位不变**。少抽一次 random() ⇒ 随机流整体错位 ⇒
  //    全池鱼的漫游目标改变 ⇒ 三个场景的 sha256 全变。
  //    实测：把寿命写死成常量（去掉这次抽样）后，trace-motion 3/3 场景全部"轨迹已变"。
  //    ⇒ 改 feed() 时**保住抽样次数**，爆炸半径就只剩"饲料寿命"这一个可观测差异。
  const sim = new PondSimulation(W, H, { fishCount: 1 }, seeded());
  const outer = sim.random;
  let n = 0;
  sim.random = () => { n++; return outer(); };
  sim.feed(W / 2, H / 2);
  sim.random = outer;
  assert.equal(n, 45,
    `feed() 消耗了 ${n} 次 random()（期望 45）—— 这会让 tools/trace-motion.js 的逐位基线整体漂移。`
    + '若确实需要改抽样次数，请连同 trace-motion 基线一起重新评估，别只改一边。');
});
