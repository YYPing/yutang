/* C 方案验收在 `npm test` 里的入口。
 *
 * ── 为什么要把它挂进 `npm test`，而不是只留一个 npm script ──────────────
 * `tools/check-stage-look.js` 是这次改动（§6 阶段 → 外观 / 阶段群游 / 鱼卵群）
 * 唯一的总验收。它跑 16 个真实天 × 每天 1800 帧运动的真种群推演，约 2 秒。
 * 只挂在 `npm run check:stage-look` 上的话，它会在某次重构里悄悄失效 ——
 * 而它守的恰好是"看上去对不对"这类断言（半透明、褪色、抱团、离群），
 * 普通的单元测试覆盖不到。所以在这里起一个子进程跑它，把退回成本压到最小。
 *
 * ⚠️ 这里刻意**不复用** check-stage-look 的内部函数：它是脚本（模块级有副作用、
 *    直接 console.log + process.exit）。要抽成可 import 的纯函数得大改，
 *    而验收脚本自己就是"可执行的真实动作"，起子进程反而更忠实。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('C 方案验收（阶段→外观 / 群游 / 卵群）：全项通过', () => {
  let output = '';
  try {
    output = execFileSync(process.execPath, [join(ROOT, 'tools', 'check-stage-look.js')], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000,
    });
  } catch (error) {
    const text = `${error.stdout ?? ''}${error.stderr ?? ''}`;
    const failed = text.split('\n').filter((line) => line.includes('✘')).join('\n');
    assert.fail(`tools/check-stage-look.js 未全项通过：\n${failed || text.slice(-2000)}`);
  }
  assert.match(output, /通过 \d+ 项，未通过 0 项/);
});
