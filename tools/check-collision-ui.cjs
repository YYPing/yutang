/**
 * 碰撞体积（含开关）的**真窗口**验收。
 *
 * ── 为什么非要真窗口 ─────────────────────────────────────────────────
 * `tests/collision.test.js` 验的是**几何与求解器**（直接 new PondSimulation）。
 * 它**验不到**这条链：
 *     设置面板的 Toggle → App 的 update() → writeStore → Pond 的 options →
 *     PondEngine.updateOptions → PondSimulation.updateOptions → `this.options.collision`
 * 这条链上任何一环断了，单测全绿而**用户点开关没反应**。
 * 项目里已有先例：CSP 白名单那条 bug 就是「单测全绿、真机空转」。
 *
 * ── 判据 ─────────────────────────────────────────────────────────────
 *  ① 默认开（老存档缺这个键时升级即生效）
 *  ② 开着时：两条重叠的鱼会被推开
 *  ③ 面板里**真的有**这个开关，且初始是勾上的
 *  ④ 点掉它 → 引擎的 `options.collision` 真的变成 false（接线通）
 *  ⑤ 关掉后：同样重叠的两条鱼**不再被推开**（证明开关有效，不是装饰）
 *  ⑥ 再点开 → 重新生效（可逆）
 *  ⑦ 全程无页面异常
 *
 * 用法：node tools/check-collision-ui.cjs        （需 dev server 在 5188）
 *      URL=http://127.0.0.1:5189/ node tools/check-collision-ui.cjs
 */

const PW = require('C:/Users/Y/.workbuddy/binaries/node/workspace/node_modules/playwright-core');
const { join } = require('node:path');
const fs = require('node:fs');

const EXE = 'C:/Users/Y/AppData/Local/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-win64/chrome-headless-shell.exe';
const ROOT = join(__dirname, '..');
const OUT = join(ROOT, 'out');
const URL = process.env.URL || 'http://127.0.0.1:5188/';

let pass = 0, fail = 0;
const ok = (cond, label, detail) => {
  if (cond) { pass++; console.log(`  ✔ ${label}${detail ? '  — ' + detail : ''}`); }
  else { fail++; console.log(`  ✘ ${label}${detail ? '  — ' + detail : ''}`); }
};
const section = (t) => console.log(`\n${t}`);

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await PW.chromium.launch({ executablePath: EXE, args: ['--no-sandbox', '--use-gl=swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE ' + m.text()); });

  await page.goto(URL, { waitUntil: 'load', timeout: 60000 });
  // ★ 关键：**不写 collision 键** —— 这正是老存档升级的情形，用来验「默认开」。
  await page.evaluate(() => {
    localStorage.setItem('fusheng-settings', JSON.stringify({
      season: 'summer', weather: 'sunny', day: 'day', fishCount: 12, fishSize: 1, turtleCount: 0,
      quality: 'high', reducedMotion: false, sound: false, volume: 0, ecoMode: false,
    }));
  });
  await page.reload({ waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => Boolean(window.__pondEngine), null, { timeout: 20000 });
  await page.waitForTimeout(800);

  /**
   * 造一对完全重叠的鱼，量「最小胶囊间距」与「实际位移」在 N 帧后的变化。
   * ⚠️ 必须**手动驱动 sim.update**，不能等真实时间：
   *    无头/不可见时 rAF 会被节流到近乎停摆（实测 2.1s 真实时间只推进 0.10s 模拟时钟）。
   * 速度置 0 ⇒ goalSpeed 也是 0 ⇒ 位置只可能被碰撞层推动。
   *
   * ⚠️⚠️ 判据必须看**位置位移**，不能只看胶囊间距。
   *    踩过：胶囊间距会随**朝向旋转**变化 —— 鱼在原地转向时，线段端点绕中心转，
   *    最近点距离跟着变（实测关掉碰撞后间距仍从 −13.74 变到 −12.09，位移却是 0）。
   *    那不是"被推开了"，只是转了个身。**用间距当判据会把旋转误读成分离。**
   */
  const separation = (frames) => page.evaluate((n) => {
    const sim = window.__pondEngine.sim;
    const a = sim.fish[0], b = sim.fish[1];
    sim.fish = [a, b];                       // 排除第三条鱼的干扰
    a.x = 600; a.y = 450; a.heading = 0; a.velocity = 0; a.speed = 0; a.targetX = 600; a.targetY = 450;
    b.x = 604; b.y = 450; b.heading = 0; b.velocity = 0; b.speed = 0; b.targetX = 604; b.targetY = 450;
    const scale = Math.min(Math.max(Math.min(sim.width / 1250, sim.height / 780), .78), 1.15);
    const gap = () => {
      const A = window.__koiBody(a, scale), B = window.__koiBody(b, scale);
      const hit = window.__capsuleOverlap(A, B);
      return hit ? -hit.depth : Math.hypot(a.x - b.x, a.y - b.y);
    };
    const before = gap();
    for (let i = 0; i < n; i++) sim.update(1 / 60);
    return {
      before, after: gap(),
      moveA: Math.hypot(a.x - 600, a.y - 450),
      moveB: Math.hypot(b.x - 604, b.y - 450),
      finite: Number.isFinite(a.x) && Number.isFinite(b.x) && Number.isFinite(a.velocity),
    };
  }, frames);

  // 把碰撞几何挂到 window 上供页面内调用（与 engine 用的是同一份模块实例）
  const inject = async () => {
    const mod = await page.evaluate(() => {
      // 用引擎已经加载过的模块：dev server 下可直接动态 import 同一份源码
      return import('/src/engine/koi-collision.js').then((m) => {
        window.__koiBody = m.koiBody;
        window.__capsuleOverlap = m.capsuleOverlap;
        return true;
      }).catch(() => false);
    });
    return mod;
  };
  const injected = await inject();
  ok(injected, '碰撞几何模块可在页面内加载（量具前提）');

  /* ------------------------------------------------------- ① 默认开 */
  section('① 默认开：老存档（没有 collision 键）升级后应自动生效');
  const def = await page.evaluate(() => window.__pondEngine.sim.options.collision);
  ok(def !== false, `引擎读到 collision = ${JSON.stringify(def)}`, '缺省即视为开');
  const savedDefault = await page.evaluate(() => JSON.parse(localStorage.getItem('fusheng-settings') || '{}').collision);
  ok(savedDefault !== false, `存档里的 collision = ${JSON.stringify(savedDefault)}`);

  /* ------------------------------------------------------- ② 开着 → 分离 */
  section('② 开着：两条完全重叠的鱼应被推开');
  const on = await separation(60);
  ok(on.finite, '位置全程有限（无 NaN）');
  ok(on.after > on.before + 2, `胶囊间距 ${on.before.toFixed(2)} → ${on.after.toFixed(2)} px`);
  ok(on.moveA + on.moveB > 5, `两条鱼实际位移合计 ${(on.moveA + on.moveB).toFixed(2)} px`,
    `左 ${on.moveA.toFixed(2)} / 右 ${on.moveB.toFixed(2)}`);

  /* ------------------------------------------------------- ③ 开关存在 */
  section('③ 设置面板里真的有这个开关，且初始勾上');
  await page.click('button:has-text("设置")');
  await page.waitForTimeout(400);
  const toggleInfo = await page.evaluate(() => {
    const row = [...document.querySelectorAll('label.toggle-row')]
      .find((el) => el.querySelector('strong')?.textContent?.trim() === '鱼的碰撞体积');
    if (!row) return null;
    return {
      label: row.querySelector('strong').textContent.trim(),
      desc: row.querySelector('small')?.textContent?.trim() || '',
      checked: row.querySelector('input[type=checkbox]')?.checked,
    };
  });
  ok(!!toggleInfo, '找到「鱼的碰撞体积」开关', toggleInfo ? `说明文案：${toggleInfo.desc}` : 'DOM 里没有这个 label');
  ok(!!toggleInfo && toggleInfo.checked === true, `初始勾选状态 = ${toggleInfo ? toggleInfo.checked : '?'}`);
  await page.screenshot({ path: join(OUT, 'collision-01-panel.png') });

  const clickToggle = async () => {
    await page.evaluate(() => {
      const row = [...document.querySelectorAll('label.toggle-row')]
        .find((el) => el.querySelector('strong')?.textContent?.trim() === '鱼的碰撞体积');
      row.querySelector('input[type=checkbox]').click();
    });
    await page.waitForTimeout(400);
    return page.evaluate(() => window.__pondEngine.sim.options.collision);
  };

  /* ------------------------------------------------------- ④ 关 → 接线通 */
  section('④ 点掉开关 → 引擎的 options.collision 必须真的变成 false');
  const afterOff = await clickToggle();
  ok(afterOff === false, `引擎读到 collision = ${JSON.stringify(afterOff)}`, 'React → settings → engine 这条链通了');
  const storedOff = await page.evaluate(() => JSON.parse(localStorage.getItem('fusheng-settings') || '{}').collision);
  ok(storedOff === false, `存档里也写成了 ${JSON.stringify(storedOff)}`, '刷新后应当保持关闭');

  /* ------------------------------------------------------- ⑤ 关掉 → 不分离 */
  section('⑤ 关掉后：同样重叠的两条鱼**不再**被推开（证明开关有效，不是装饰）');
  const off = await separation(60);
  ok(off.finite, '位置全程有限（无 NaN）');
  // ★ 判据是**位移**而不是间距：间距会随朝向旋转变化，位移不会（速度为 0 时只有碰撞层的位移修正）。
  ok(off.moveA + off.moveB < 0.05, `两条鱼位移合计仅 ${(off.moveA + off.moveB).toFixed(4)} px`,
    `对比开着时是 ${(on.moveA + on.moveB).toFixed(2)} px`);
  ok(off.moveA + off.moveB < (on.moveA + on.moveB) * 0.01, '关掉后的位移不足开着时的 1%');

  /* ------------------------------------------------------- ⑥ 再开 → 恢复 */
  section('⑥ 再点开 → 重新生效（开关可逆）');
  const afterOn = await clickToggle();
  ok(afterOn !== false, `引擎读到 collision = ${JSON.stringify(afterOn)}`);
  const backOn = await separation(60);
  ok(backOn.moveA + backOn.moveB > 5, `位移合计 ${(backOn.moveA + backOn.moveB).toFixed(2)} px`, '恢复分离');

  /* ------------------------------------------------------- ⑦ 无异常 */
  section('⑦ 页面异常');
  const blocking = errors.filter((e) => !/favicon|ERR_/i.test(e));
  ok(blocking.length === 0, `无页面异常（共捕获 ${errors.length} 条，过滤资源类后 ${blocking.length} 条）`,
    blocking.length ? blocking.slice(0, 3).join(' | ') : '');

  await page.screenshot({ path: join(OUT, 'collision-02-final.png') });
  console.log(`\n${'═'.repeat(66)}`);
  console.log(`  碰撞体积 UI 验收：${pass} 通过 / ${fail} 失败`);
  console.log(`${'═'.repeat(66)}\n`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('运行失败：', e.message || e); process.exit(1); });
