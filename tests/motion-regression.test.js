/* 逐位回归守卫在 `npm test` 里的入口。
 *
 * ── 它守的是什么 ─────────────────────────────────────────────────────
 * C 方案把「阶段 → 外观 / 阶段群游」写进了 `simulation.js` 那个 **O(n²) 邻居循环**
 * —— 而那个循环同时也是**手绘鱼**（非生态）唯一的避让逻辑。
 * 改动如果碰到手绘鱼的浮点路径，`npm test` 里的 251 个断言**发现不了**：
 * 它们断言的是范围（速度变异 .15–.45 之类），不是逐位相等。
 *
 * `tools/trace-motion.js` 用固定种子跑一遍非生态池子，把每帧每条鱼的
 * x/y/heading/velocity/phase/angularVelocity 量化后取 sha256，与 fixture 比。
 * 差一位就红。这里起子进程跑它，让这条守卫进不了"忘了跑"的盲区。
 *
 * ⚠️ 基线更新只能走 `npm run check:motion:record` —— 也就是"先确认改动**确实**
 *    动了手绘鱼、且新行为是对的"，再录。**不要**因为测试红了就直接重录。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = join(ROOT, 'tools', 'fixtures', 'motion-baseline.json');

test('手绘鱼运动逐位不变（sha256 基线）', () => {
  assert.ok(existsSync(FIXTURE), '缺少 tools/fixtures/motion-baseline.json —— 先跑 npm run check:motion:record');
  let output = '';
  try {
    output = execFileSync(process.execPath, [join(ROOT, 'tools', 'trace-motion.js')], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000,
    });
  } catch (error) {
    const text = `${error.stdout ?? ''}${error.stderr ?? ''}`;
    assert.fail(`tools/trace-motion.js 未通过：\n${text.slice(-2000)}`);
  }
  assert.match(output, /\d+\/\d+ 场景逐位一致/);
});
