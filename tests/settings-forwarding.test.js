/* 「设置项忘了转发给引擎」的源码不变量守卫。
 *
 * ── 为什么需要这条 ────────────────────────────────────────────────────
 * 加「鱼的碰撞体积」开关时踩了一个**静默失败**：
 *   `storage.js` 加了 `collision` 默认值 ✓
 *   `SettingsPanel` 加了 Toggle ✓
 *   `simulation.js` 认 `options.collision` ✓
 *   —— 但 `App.jsx` 那个 `options` useMemo **既没带 `collision` 字段、
 *      依赖数组里也没有 `settings.collision`**。
 * 后果：用户点开关，**界面会变、存档会写**，而引擎读到的永远是 `true`。
 * 单测全绿（它们直接 new PondSimulation），只有真窗口点击才抓得到
 * （`tools/check-collision-ui.cjs` ④ 就是这么抓出来的）。
 *
 * 真窗口检查要 dev server，进不了 `npm test`。所以这里补一条源码级的便宜守卫：
 * 遍历 `DEFAULT_SETTINGS` 的每个键，凡是**该送进引擎**的，
 * 就要求 `App.jsx` 的 options useMemo 里出现 `settings.<key>`，
 * **并且**依赖数组里也出现 `settings.<key>`。
 *
 * ⚠️ 两条都要查，缺一不可：
 *   · 只在对象里写、不在依赖里写 ⇒ memo 不重算，改了设置没反应（同样静默）
 *   · 只在依赖里写、不在对象里写 ⇒ 重算了但没传给引擎（更隐蔽）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SETTINGS } from '../src/lib/storage.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP = readFileSync(join(ROOT, 'src', 'App.jsx'), 'utf8');

/** 必须原样转发给引擎的设置键。 */
const MUST_REACH_ENGINE = ['fishCount', 'fishSize', 'turtleCount', 'quality', 'reducedMotion', 'ecoMode', 'ecoSpeed', 'collision'];

/**
 * 不走 `settings.<key>` 直通的键，附理由（新增设置时必须来这里表态）。
 */
const FORWARDED_ELSEWHERE = {
  season: '由 useEnvironment 合成 env.season 后转发',
  weather: '由 useEnvironment 合成 env.weather 后转发',
  day: '由 useEnvironment 合成 env.night 后转发',
  sound: '音频层，不进引擎 options',
  volume: '音频层，不进引擎 options',
};

/** 取出 `const options=useMemo(()=>{...},[...]);` 的整段源码。 */
function optionsMemoSource() {
  const start = APP.indexOf('const options=useMemo(');
  assert.ok(start >= 0, 'App.jsx 里找不到 `const options=useMemo(`');
  const end = APP.indexOf(']);', start);
  assert.ok(end > start, 'options useMemo 的收尾 `]);` 没找到 —— 结构变了，请同步更新本测试');
  return APP.slice(start, end + 3);
}

/** 只取 `return o` 之前的部分（= 对象构造段，不含依赖数组）。 */
function optionsObjectSource() {
  const src = optionsMemoSource();
  const depStart = src.lastIndexOf('},[');
  assert.ok(depStart > 0, 'options useMemo 的 `},[` 没找到 —— 结构变了，请同步更新本测试');
  return src.slice(0, depStart);
}

test('MUST_REACH_ENGINE 与 FORWARDED_ELSEWHERE 必须覆盖 DEFAULT_SETTINGS 的每个键', () => {
  const covered = new Set([...MUST_REACH_ENGINE, ...Object.keys(FORWARDED_ELSEWHERE)]);
  const missing = Object.keys(DEFAULT_SETTINGS).filter((k) => !covered.has(k));
  assert.deepEqual(missing, [],
    `这些设置键既不在 MUST_REACH_ENGINE 也不在 FORWARDED_ELSEWHERE：${missing.join(', ')}`
    + ' —— 新增设置项时必须在两者之一里表态，否则它可能根本没送进引擎。');
});

test('★ 每个必须进引擎的设置键，都要出现在 options 对象的**构造段**里', () => {
  // ⚠️ 必须只看构造段（`return o` 之前），不能看整段 memo 源码。
  //   踩过：第一版检查整段，而依赖数组里也写着 `settings.collision`，
  //   于是"只放进依赖、忘了放进对象"这种情况**漏检**了
  //   —— 反证时才发现（把对象里的 collision 删掉，测试仍然是绿的）。
  //   "两个位置都写了同一个字符串"正是最容易骗过朴素文本匹配的情形。
  const src = optionsObjectSource();
  const missing = MUST_REACH_ENGINE.filter((k) => !src.includes(`settings.${k}`));
  assert.deepEqual(missing, [],
    `options 对象的构造段里没转发：${missing.join(', ')}`
    + ' —— 症状是「界面能改、存档会写、引擎收不到」，且完全静默。');
});

test('★ 每个必须进引擎的设置键，都要出现在 options useMemo 的依赖数组里', () => {
  const src = optionsMemoSource();
  // 结构是 `...;return o},[dep1,dep2,...]);` ⇒ 用 `},[` 定位依赖数组
  const depStart = src.lastIndexOf('},[');
  assert.ok(depStart > 0, 'options useMemo 的依赖数组没找到（`},[` 不在源码里）—— 结构变了，请同步更新本测试');
  const deps = src.slice(depStart);
  const missing = MUST_REACH_ENGINE.filter((k) => !deps.includes(`settings.${k}`));
  assert.deepEqual(missing, [],
    `依赖数组里缺：${missing.join(', ')}`
    + ' —— 缺依赖会让 useMemo 不重算，改了设置界面不动（同样是静默失败）。');
});
