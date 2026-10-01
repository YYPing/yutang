/* 反证：新 ④c 的断言真的**抓得住**门控漏网吗？
 *
 * 断言全绿有两种可能：① 门控确实完备  ② 量具坏了，什么都量不到。
 * 这个脚本制造第 ① 种之外的情形 —— 把门控整个拆掉（`canReachFood` 恒真），
 * 然后跑同一份 `check-feedcircle.js`，要求它**变红**。
 *
 * 跑法：node tools/_probe-gate-negative.js
 *   期望看到：④c-1 / ④c-4 / ④c-5 与 ⑤ 里的"看不见"断言全部 ✘。
 *   ⚠️ 本脚本**故意**让测试失败，退出码非 0 是正常的。
 */
import { PondSimulation } from '../src/engine/simulation.js';

console.log('=== 反证：把 canReachFood 改成恒真（门控全拆）===');
PondSimulation.prototype.canReachFood = function () { return true; };

await import('./check-feedcircle.js');
