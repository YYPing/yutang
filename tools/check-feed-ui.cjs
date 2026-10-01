/* 投喂感应圈的真窗口验收（F-2.8）。单测能验行为，但验不了"虚线圈到底画没画出来"。
 *
 * 三件事：
 *   A. 虚线圈真的可见 —— 沿椭圆圆周逐点取亮度，投喂前后做差分。
 *      虚线 [9,7] ⇒ 约 56% 的采样点应由亮变亮、其余不变，所以差异分布呈"方波"，
 *      p90 明显高于 p50。这条能抓到：忘了接渲染序列、被 clip 裁掉、颜色 alpha 太低、
 *      画成正圆（椭圆采样会错位）等所有"行为对但看不见"的问题。
 *   B. 虚线圈 displaySeconds 后消失（渲染层真的回收了，不只是数据层）。
 *   C. 投到 200 粒上限时界面出「这一把够了」（F-2.6 提示真的接上了）。
 *
 * 前置：Vite dev server 已在 5188 监听 + Electron 已用 --remote-debugging-port=9223 起窗口。
 * 跑法：node tools/check-feed-ui.cjs [PORT]
 */
const PW = require('C:/Users/Y/.workbuddy/binaries/node/workspace/node_modules/playwright-core');
const PORT = process.argv[2] || '9223';

async function connect(tries = 10) {
  for (let i = 0; i < tries; i++) {
    try { return await PW.chromium.connectOverCDP('http://127.0.0.1:' + PORT); }
    catch { await new Promise(r => setTimeout(r, 2000)); }
  }
  throw new Error('连不上 CDP ' + PORT);
}

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✔ ${label}${detail ? '  — ' + detail : ''}`); }
  else { fail++; console.log(`  ✘ ${label}${detail ? '  — ' + detail : ''}`); }
};

(async () => {
  const browser = await connect();
  const ctx = browser.contexts()[0];
  const page = (ctx && ctx.pages().find(p => /5188|浮生|pond/i.test(p.url()))) || ctx.pages()[0];
  if (!page) throw new Error('没有可用页面');
  await page.waitForTimeout(1500);

  // 照 performance-smoke.cjs 的先例：patch 原型上的 render，把引擎实例捞到 window。
  // 不在生产代码里开后门。
  await page.evaluate(async () => {
    if (window.feedEngine) return;
    const url = performance.getEntriesByType('resource').map(r => r.name).find(u => u.includes('/src/engine/pond.js'));
    const mod = await import(url || '/src/engine/pond.js');
    const proto = mod.PondEngine.prototype;
    if (!proto.__feedPatched) {
      const orig = proto.render;
      proto.render = function (...args) { window.feedEngine = this; return orig.apply(this, args); };
      proto.__feedPatched = true;
    }
  });
  await page.waitForFunction(() => window.feedEngine, null, { timeout: 20000 });
  console.log('已接管引擎实例');

  // 先按 Esc 收干净可能开着的面板，免得 backdrop 吃掉点击
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  /* -------------------------------------------------- A. 虚线圈真的可见 */
  console.log('\n=== A. 虚线圈的可见性（沿椭圆圆周像素差分）===');
  const A = await page.evaluate(() => {
    const e = window.feedEngine;
    const c = e.canvas, ctx2d = e.ctx2d || e.ctx;
    const scale = c.width / c.clientWidth;
    const cx = e.width * 0.5, cy = e.height * 0.5;
    const R = Math.min(e.width, e.height) * 0.30;
    const rx = R, ry = R * 0.64;              // 与 drawFeedCircles 的 ry = rx*0.64 对齐
    const N = 1440;
    // ★ 沿半径做 ±12px 的窗口取**峰值**，而不是钉死在 rx 上取单点。
    //   因为 drawFeedCircles 有呼吸：rx = radius * (1 + sin(age*6.2)*0.022) ——
    //   圈半径会在 ±2.2%（这里 ±5.9px）内浮动，而虚线只有 lineWidth 1.1（±0.55px）。
    //   钉死单点采样时，只要 age 不为 0 就整个采空（正弦一旦离开 0 点，半径就偏了），
    //   实测 p90 从 128 直接掉到 0 —— 完全是"量具"的问题，不是画没画出来。
    const WIN = 12, STEP = 2;
    const read = () => {
      const img = ctx2d.getImageData(0, 0, c.width, c.height);
      const out = new Float64Array(N);
      for (let i = 0; i < N; i++) {
        const t = i / N * Math.PI * 2;
        const ct = Math.cos(t), st = Math.sin(t);
        let best = -1;
        for (let dr = -WIN; dr <= WIN; dr += STEP) {
          const r = rx + dr;
          const x = Math.min(c.width - 1, Math.max(0, Math.round((cx + ct * r) * scale)));
          const y = Math.min(c.height - 1, Math.max(0, Math.round((cy + st * r * (ry / rx)) * scale)));
          const o = (y * c.width + x) * 4;
          const lum = 0.299 * img.data[o] + 0.587 * img.data[o + 1] + 0.114 * img.data[o + 2];
          if (lum > best) best = lum;
        }
        out[i] = best;
      }
      return out;
    };
    // 清掉可能残留的圈与饲料，保证 before 是"没有圈"的状态
    e.sim.feedCircles.length = 0;
    e.sim.food.length = 0;
    e.render(); read();          // warm-up：丢开首次 GPU 回读（见 B 段注释）
    e.render();
    const before = read();
    const fed = e.feed(cx, cy);
    e.render();
    const after = read();
    const circles = e.sim.feedCircles.length;
    const foodCount = e.sim.food.length;

    const diffs = new Float64Array(N);
    for (let i = 0; i < N; i++) diffs[i] = Math.abs(after[i] - before[i]);
    const sorted = Float64Array.from(diffs).sort();
    let sum = 0, hit = 0;
    for (let i = 0; i < N; i++) { sum += diffs[i]; if (diffs[i] > 4) hit++; }
    return {
      fed, circles, foodCount, mean: sum / N, p50: sorted[N >> 1],
      p90: sorted[Math.floor(N * 0.9)], max: sorted[N - 1],
      hitRatio: hit / N, radius: R, cssSize: [e.width, e.height], canvasSize: [c.width, c.height],
      dpr: scale,
    };
  });
  console.log(`     视口 ${A.cssSize.join('×')}（canvas ${A.canvasSize.join('×')}，dpr ${A.dpr.toFixed(2)}）⇒ 半径 ${A.radius}`);
  console.log(`     沿椭圆 1440 点差分：均值 ${A.mean.toFixed(2)} / p50 ${A.p50.toFixed(2)} / p90 ${A.p90.toFixed(2)} / max ${A.max.toFixed(2)}`);
  console.log(`     变亮(>4)占比 ${(A.hitRatio * 100).toFixed(1)}%`);
  ok('引擎侧确认投喂生效并挂上一圈', A.fed.ok === true && A.circles === 1 && A.foodCount > 0,
    `ok=${A.fed.ok} 圈=${A.circles} 饲料=${A.foodCount}`);
  // 虚线 [9,7] ⇒ 约 56% 的圆周上有线，差分应呈方波：p90 远高于 p50。
  ok('虚线圈在画面上真的出现了（p90 > 8）', A.p90 > 8, `p90 ${A.p90.toFixed(2)}`);
  ok('亮部落在圆周而非整片泛白（p50 明显低于 p90 ⇒ 是虚线不是实心）', A.p50 < A.p90 * 0.6,
    `p50 ${A.p50.toFixed(2)} vs p90 ${A.p90.toFixed(2)}`);
  ok('虚线覆盖率接近 9/(9+7) = 56%（30%–75%）', A.hitRatio > 0.30 && A.hitRatio < 0.75,
    `${(A.hitRatio * 100).toFixed(1)}%`);

  await page.screenshot({ path: 'out/feed-circle.png' });
  console.log('     已保存 out/feed-circle.png（投喂瞬间）');

  /* ------------------------------------------- B. 1.8s 后虚线在渲染层回收 */
  console.log('\n=== B. 虚线圈按 displaySeconds 消失 ===');
  // ⚠️ 不能靠 rAF 等它自己过期。无头 / 窗口不可见时 Chromium 把 rAF 节流到近乎停摆
  //    （实测 2.1s 真实时间只推进 0.10s 模拟时钟），等的那个“2.1s”根本不是模拟时间。
  //    这里手动驱动 sim.update，步数可控、结果确定。
  const B = await page.evaluate(() => {
    const e = window.feedEngine;
    const c = e.canvas, ctx2d = e.ctx2d || e.ctx;
    const scale = c.width / c.clientWidth;
    const cx = e.width * 0.5, cy = e.height * 0.5;
    const R = Math.min(e.width, e.height) * 0.30, rx = R, ry = R * 0.64;
    const N = 1440, WIN = 12, STEP = 2;
    // 与 A 段同一套带窗口的读法（原因见 A 段注释：圈的半径会呼吸）
    const read = () => {
      const img = ctx2d.getImageData(0, 0, c.width, c.height);
      const out = new Float64Array(N);
      for (let i = 0; i < N; i++) {
        const t = i / N * Math.PI * 2;
        const ct = Math.cos(t), st = Math.sin(t);
        let best = -1;
        for (let dr = -WIN; dr <= WIN; dr += STEP) {
          const r = rx + dr;
          const x = Math.min(c.width - 1, Math.max(0, Math.round((cx + ct * r) * scale)));
          const y = Math.min(c.height - 1, Math.max(0, Math.round((cy + st * r * (ry / rx)) * scale)));
          const o = (y * c.width + x) * 4;
          const lum = 0.299 * img.data[o] + 0.587 * img.data[o + 1] + 0.114 * img.data[o + 2];
          if (lum > best) best = lum;
        }
        out[i] = best;
      }
      return { out, img };
    };
    const maxAbs = (a, b) => { let m = 0; for (let i = 0; i < N; i++) m = Math.max(m, Math.abs(a[i] - b[i])); return m; };
    const p90Abs = (a, b) => {
      const d = []; for (let i = 0; i < N; i++) d.push(Math.abs(a[i] - b[i]));
      d.sort((x, y) => x - y); return d[Math.floor(N * 0.9)];
    };
    const ctxIsMain = ctx2d === e.canvas.getContext('2d', { alpha: true });

    const oldAge = e.sim.feedCircles.length ? e.sim.feedCircles[0].age : null;
    // ⚠️ warm-up：每次进入新的 evaluate，**首次** getImageData 会把待处理的合成 flush 掉，
    //    读到的画面与紧随其后的第二次读不一致（实测差 5 个灰度级）。丢掉这一读。
    e.render(); read();

    // 基线：确定"没有圈"时的画面
    e.sim.feedCircles.length = 0;
    e.render();
    const noCircle = read();

    // 阳性对照：投一个**全新**的圈（age=0 ⇒ breathe=1 ⇒ 半径正好贴合采样椭圆）
    const fed = e.feed(cx, cy);
    const freshRadius = e.sim.feedCircles.length ? e.sim.feedCircles[0].radius : null;
    const lifeSeconds = e.sim.feedCircles.length ? e.sim.feedCircles[0].life : null;
    e.render();
    const fresh = read();

    // 手动推进到过期 —— rAF 在不可见窗口里被节流到近乎停摆（实测 2.1s 真实时间只推进 0.10s），
    // 等的那个"2.1s"根本不是模拟时间。手动驱动，步数可控、结果确定。
    let steps = 0;
    while (e.sim.feedCircles.length && steps < 600) { e.sim.update(1 / 60); steps++; }
    const expired = e.sim.feedCircles.length === 0;
    e.render();
    const afterExpire = read();

    // 渲染层证据：过期后渲染 vs 手动清空后渲染。两者都应是"没有圈"的画面。
    e.sim.feedCircles.length = 0;
    e.render();
    const afterClear = read();

    return {
      expired, steps, oldAge, freshRadius, lifeSeconds, fed: fed.ok, radius: R, ctxIsMain,
      advanced: steps / 60,
      freshSig: p90Abs(noCircle.out, fresh.out),      // 有圈 ⇒ 应该很大
      expireSig: p90Abs(noCircle.out, afterExpire.out), // 过期后 ⇒ 应回落到噪声水平
      expireMax: maxAbs(noCircle.out, afterExpire.out),
      expireGap: maxAbs(afterExpire.out, afterClear.out),
    };
  });
  console.log(`     半径核对 ${B.radius}（应为 短边×0.30）｜ ctx 是主画布 ${B.ctxIsMain}｜ 上一帧残留圈 age=${B.oldAge === null ? '无' : B.oldAge.toFixed(2)}`);
  console.log(`     手动推进 ${B.steps} 帧 = ${B.advanced.toFixed(2)}s（新圈 life=${B.lifeSeconds}s，半径 ${B.freshRadius}）`);
  console.log(`     新圈信号 p90 ${B.freshSig.toFixed(2)}　过期后残余 p90 ${B.expireSig.toFixed(2)} / max ${B.expireMax.toFixed(2)}`);
  console.log(`     过期后 vs 强清后 max ${B.expireGap.toFixed(2)}`);
  ok('投喂当即画出一圈（阳性对照，p90 > 20）', B.freshSig > 20, `p90 ${B.freshSig.toFixed(2)}`);
  ok('推进到 displaySeconds 后虚线圈被回收', B.expired === true, `推进 ${B.advanced.toFixed(2)}s ≥ ${B.lifeSeconds}s`);
  ok('推进量恰好跨过 life（不是被别的东西提前清掉）',
    B.advanced >= B.lifeSeconds && B.advanced < B.lifeSeconds + 0.1,
    `${B.advanced.toFixed(2)}s ≥ ${B.lifeSeconds}s`);
  // 关键对照：过期后的画面应当回到"没有圈"的样子（只剩水面自然变化）
  ok('过期后画面回到无圈状态（残余 < 新圈信号的 15%）', B.expireSig < B.freshSig * 0.15,
    `残余 ${B.expireSig.toFixed(2)} vs 新圈 ${B.freshSig.toFixed(2)}`);
  ok('渲染层真的不再画了（过期后与强清后画面等同）', B.expireGap <= 2,
    `差 ${B.expireGap.toFixed(2)}`);
  await page.screenshot({ path: 'out/feed-circle-gone.png' });

  /* ---------------------------------------- C. 200 粒上限的界面提示（F-2.6）*/
  console.log('\n=== C. 到 200 粒上限时界面给提示 ===');
  const btn = page.locator('.dock button').filter({ hasText: '投食' }).first();
  if (!(await btn.count())) { ok('找得到 dock 的「投食」按钮', false); }
  else {
    ok('找得到 dock 的「投食」按钮', true);
    // 每次约 9 粒 ⇒ 24 次足够触顶（若提前触顶，后续点击都返回 capped，幂等）
    for (let i = 0; i < 26; i++) { await btn.click(); await page.waitForTimeout(70); }
    await page.waitForTimeout(200);
    const C = await page.evaluate(() => {
      const e = window.feedEngine;
      const el = document.querySelector('.toast');
      return { toast: el ? el.textContent.trim() : '', food: e.sim.food.length, cap: e.getStats().foodCap };
    });
    console.log(`     饲料 ${C.food}/${C.cap}，toast = ${JSON.stringify(C.toast)}`);
    ok('饲料停在 200 上限', C.food === C.cap, `${C.food}/${C.cap}`);
    ok('界面给出「这一把够了」提示', /这一把够了/.test(C.toast), C.toast || '（无 toast）');
  }

  await page.screenshot({ path: 'out/feed-circle-cap.png' });
  console.log(`\n${fail === 0 ? '✔' : '✘'} 通过 ${pass} 项，未通过 ${fail} 项\n`);
  await browser.close().catch(() => {});
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('✘ 异常：', e.message); process.exit(1); });
