/**
 * ★ 24 节气**整页**截图（不是 canvas 截图）。
 *
 * ── 为什么不用 tools/shot-terms-ui.cjs ────────────────────────────────
 * 那个脚本截的是 `canvas.pond-canvas`，即**只有水面**。用户要「把页面的
 * 24 节气进行完整截图」—— 完整页面包含 HUD（顶栏品牌/天气徽章、左侧
 * 诗句、底部状态条里的节气名与鱼数、投喂提示、工具栏 dock），
 * 而**状态条上的节气名正是验收「画面切换到哪一档」最直接的人证**：
 * 只截 canvas 时，画面与 UI 可能对不上（面板显示芒种、底图却是立秋）。
 * 所以这里截 `fullPage`，并额外断言 DOM 上的节气文本 == 请求的节气。
 *
 * ── ⚠️⚠️ 三个必须绕开的坑 ─────────────────────────────────────────────
 * ① **8s 交叉淡入会污染截图**（需求 §2.3 第 5 条新增机制）。
 *    切档后 `landscape.shownSeason` 变成新槽位前的 8 秒里，
 *    `uFade` 在两张底图之间插值 ⇒ 截出来是**半透明叠加**，
 *    既不像起点也不像终点。`options.paused` 会让 `instant` 为真而跳过淡入，
 *    但 paused 同时会停 rAF（sim 不推进）⇒ 生态时钟也冻住。
 *    正解：等 `landscape.fadeFrom === null && landscape.shownSeason === 期望槽位`
 *    才允许截图 —— **判据来自状态机本身，不是等固定毫秒数**。
 *    （固定 sleep 有实测依据：8s 淡入 + 约 0.5s 切换 ⇒ 每档等 9.5s；
 *      但我们仍读状态机做确认，因为 sleep 到点 ≠ 淡入真的结束。）
 * ② **纹理没就绪时底图是 `opacity:0`**（`landscape.js` 的 `if(!texture)` 分支）。
 *    首帧必然走这一支 ⇒ 一 reload 就立刻截会得到**空白水面**。
 *    ⇒ 必须等 `landscape.ready && bgCanvas.style.opacity !== '0'`。
 * ③ **定位会卡住首屏**：`useEnvironment` 走 ipwho.is 等网络源，
 *    网络慢时 `env.city.name` 长期是「还没有城市」，HUD 上看不到城市名。
 *    ⇒ 预置 `fusheng-city` 成本地城市，直接绕过网络。
 *
 * ── 24 档为什么要 reload 而不能只改设置 ──────────────────────────────
 * 改 localStorage 不 reload 不生效（React 读的是初始化 state），
 * 而 `update()` 走 React 状态 ⇒ 每档必须 reload 才落到引擎。
 * reload 的代价：鱼群初始位姿重新随机 ⇒ 24 张鱼的分布各不相同。
 * 这不是缺陷（用户看的是「每个节气长什么样」，不是「鱼的位姿」）；
 * 判定「相邻档是否真的不同」的量具另有 `shot-terms-ui.cjs`（冻结+清鱼）。
 *
 * 用法：node tools/shot-terms-page.cjs          （需 dev server 在 5188）
 *      URL=http://127.0.0.1:5188/ node tools/shot-terms-page.cjs
 *      ONLY=夏至 node tools/shot-terms-page.cjs   （只截某档，调试用）
 *      OPEN=1 顺带截一张打开「四时」面板的图
 */
const PW = require('C:/Users/Y/.workbuddy/binaries/node/workspace/node_modules/playwright-core');
const { join } = require('node:path');
const fs = require('node:fs');

const EXE = 'C:/Users/Y/AppData/Local/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-win64/chrome-headless-shell.exe';
const ROOT = join(__dirname, '..');
const OUT = join(ROOT, 'out', 'terms-page');
const URL = process.env.URL || process.env.TERM_URL || 'http://127.0.0.1:5188/';

/** 历法序（春分为首），与 `almanac.js` 的 `SOLAR_TERMS` 一致。 */
const TERMS = ['春分', '清明', '谷雨', '立夏', '小满', '芒种', '夏至', '小暑', '大暑',
  '立秋', '处暑', '白露', '秋分', '寒露', '霜降', '立冬', '小雪', '大雪', '冬至', '小寒', '大寒',
  '立春', '雨水', '惊蛰'];

/** 每档的淡入预算：8s（`TERM_FADE_SECONDS`）+ 纹理解码余量。 */
const FADE_BUDGET_MS = 9500;
const POLL_MS = 120;

let pass = 0, fail = 0;
const ok = (cond, label, detail) => {
  const mark = cond ? '\x1b[32m✔\x1b[0m' : '\x1b[31m✘\x1b[0m';
  if (cond) pass++; else fail++;
  console.log(`  ${mark} ${label}${detail ? '  — ' + detail : ''}`);
};
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

/**
 * ★ 读回「底图这一层是否真的落稳」—— 判据全部来自 `landscape` 的状态机字段，
 * 不是「等了多久」。理由：任何一个 sleep 时长都是猜的，而这三个字段是确定的。
 *   ready         — WebGL 初始化成功
 *   opacity !== 0 — 纹理就绪（否则 `render()` 在 `if(!texture)` 处早退，水面透明）
 *   fadeFrom===null&&shownSeason===slot — 淡入已走完（否则是两张底图的叠加）
 */
const READY_PROBE = () => {
  const e = window.__pondEngine;
  const L = e && e.landscape;
  const bg = document.querySelector('canvas.pond-background') || document.querySelector('.pond-background');
  return {
    hasEngine: !!e,
    ready: !!(L && L.ready),
    uniforms: !!(L && L.uniforms),
    slot: L ? L.slot : null,
    shownSeason: L ? L.shownSeason : null,
    fadeFrom: L ? L.fadeFrom : null,
    bgOpacity: bg ? bg.style.opacity : null,
    // HUD 上的节气文本 —— 画面与 UI 是否指向同一档
    uiTerm: (document.querySelector('.scene-status .solar-term') || {}).textContent || '',
  };
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const list = process.env.ONLY ? [process.env.ONLY] : TERMS;

  const browser = await PW.chromium.launch({ executablePath: EXE, args: ['--no-sandbox', '--use-gl=swiftshader'] });
  /* ★ 视口按真实桌面窗口取（`win=1380×900`），且 `deviceScaleFactor: 1`。
     * 用 2 会得到 2760×1800 的图 —— 24 张共约 100MB，且用户看的是页面不是像素。 */
  const page = await browser.newPage({ viewport: { width: 1380, height: 900 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE ' + m.text()); });

  const shots = [];
  for (let i = 0; i < list.length; i++) {
    const term = list[i];
    const idx = TERMS.indexOf(term);
    await page.goto(URL, { waitUntil: 'load', timeout: 60000 });
    /* ★ 必须在 goto **之后**写 localStorage：React 已在 load 时读过一遍，
     * 但 `update()` 是后续交互才用的；而我们下一轮会 reload ⇒ 顺序是
     * 「load → 写 → reload」，所以这一轮写完要等下一轮才生效。
     * 简化：每次循环都写成「goto → 写 → reload → 等引擎」，见下。 */
    await page.evaluate((t) => {
      localStorage.setItem('fusheng-settings', JSON.stringify({
        season: 'summer', weather: 'sunny', day: 'day',
        fishCount: 8, fishSize: 1, turtleCount: 0, quality: 'high',
        reducedMotion: false, sound: false, volume: 0, ecoMode: false,
        almanacMode: 'manual', almanacTerm: t,
      }));
      /* ★ 预置城市，绕过 ipwho.is 网络请求（见坑③）。`manualPick` 置 true 时
       * 三不变式要求「非网络定位」，正好让 HUD 直接显示这个城市名。 */
      localStorage.setItem('fusheng-city', JSON.stringify({
        name: '杭州', latitude: 30.29, longitude: 120.16, manualPick: true,
      }));
    }, term);
    await page.reload({ waitUntil: 'load', timeout: 60000 });
    await page.waitForSelector('canvas.pond-canvas', { timeout: 25000 });
    await page.waitForFunction(() => !!window.__pondEngine, null, { timeout: 25000 });

    /* ★★ 等「淡入走完 + 纹理就绪」，最长 FADE_BUDGET_MS。
     * 每一轮重新读状态机：跨档时 `shownSeason` 是新槽位，但 `fadeFrom` 非空
     * ⇒ 正在 8s 插值中 ⇒ 此时截图就是叠加图。 */
    let probe = null;
    const t0 = Date.now();
    while (Date.now() - t0 < FADE_BUDGET_MS) {
      probe = await page.evaluate(READY_PROBE);
      if (probe.ready && probe.uniforms && probe.bgOpacity !== '0'
        && probe.fadeFrom === null && probe.shownSeason === probe.slot) break;
      await page.waitForTimeout(POLL_MS);
    }
    /* 再多给一帧让 React 把 HUD 文本刷出来 */
    await page.waitForTimeout(350);

    const file = join(OUT, `${String(idx).padStart(2, '0')}-${term}.png`);
    /* ★ `fullPage: true` —— 页面高度由 CSS 固定为 100vh，fullPage 与 viewport
     * 同尺寸；但显式写出来是为了「若将来页面真的变高，截图不会悄悄截半截」。 */
    await page.screenshot({ path: file, fullPage: true, animations: 'disabled' });
    const final = await page.evaluate(READY_PROBE);
    shots.push({ term, file, probe: final, waited: Date.now() - t0, index: idx });
    console.log(`  ${String(idx).padStart(2, '0')} ${term}  slot=${final.slot} 淡入已走=${final.fadeFrom === null} HUD="${final.uiTerm.replace(/\s+/g, ' ').trim()}" 用时 ${Date.now() - t0}ms`);
  }

  /* 可选：再截一张打开「四时」面板的（证明选图 UI 的选中态也跟着走）。 */
  if (process.env.OPEN) {
    await page.goto(URL, { waitUntil: 'load', timeout: 60000 });
    await page.evaluate(() => {
      localStorage.setItem('fusheng-settings', JSON.stringify({
        season: 'summer', weather: 'sunny', day: 'day',
        fishCount: 8, fishSize: 1, turtleCount: 0, quality: 'high',
        reducedMotion: false, sound: false, volume: 0, ecoMode: false,
        almanacMode: 'manual', almanacTerm: '芒种',
      }));
      localStorage.setItem('fusheng-city', JSON.stringify({ name: '杭州', latitude: 30.29, longitude: 120.16, manualPick: true }));
    });
    await page.reload({ waitUntil: 'load', timeout: 60000 });
    await page.waitForSelector('canvas.pond-canvas', { timeout: 25000 });
    await page.waitForFunction(() => !!window.__pondEngine, null, { timeout: 25000 });
    await page.waitForTimeout(FADE_BUDGET_MS);
    /* ★ 用真实点击而不是直接设 state：面板的 `selected` 由 React state 决定，
     *   绕过点击就绕过了「按钮 onClick → update() → 面板重渲染」这条链。 */
    await page.locator('nav.dock button', { hasText: '四时' }).click();
    await page.waitForSelector('.term-grid', { timeout: 10000 });
    await page.waitForTimeout(600);
    await page.screenshot({ path: join(OUT, '_panel-season.png'), fullPage: true });
    console.log('  附：_panel-season.png（打开「四时」面板）');
  }

  section('验收');
  ok(shots.length === list.length, `全部档位都截到`, `${shots.length} / ${list.length}`);
  const noEngine = shots.filter((s) => !s.probe.hasEngine);
  ok(noEngine.length === 0, '每档都拿到了引擎（`__pondEngine`）', noEngine.map((s) => s.term).join(' '));
  const notReady = shots.filter((s) => !s.probe.ready || !s.probe.uniforms);
  ok(notReady.length === 0, 'GPU 底图在跑（`landscape.ready` + `uniforms` 存在）',
    notReady.map((s) => `${s.term}(ready=${s.probe.ready},u=${s.probe.uniforms})`).join(' '));
  /* ★★★ 这条是本脚本存在的头号理由：opacity==='0' 时截到的是空白水面，
   * 而「截图看起来是空��」很容易被当成「底图没差别」。 */
  const blank = shots.filter((s) => s.probe.bgOpacity === '0' || s.probe.bgOpacity === null);
  ok(blank.length === 0, '底图 canvas 不透明（否则截到的是空水面，不是底图没差别）',
    blank.map((s) => `${s.term}(opacity=${s.probe.bgOpacity})`).join(' '));
  /* ★★★ 第二条头号理由：淡入中被截 = 两张底图叠加，24 张全部偏色且糊。 */
  const midFade = shots.filter((s) => s.probe.fadeFrom !== null);
  ok(midFade.length === 0, '★ 截图时不在 8s 淡入中途（`fadeFrom` 已清空）',
    midFade.map((s) => `${s.term}(fadeFrom=${s.probe.fadeFrom},shown=${s.probe.shownSeason},slot=${s.probe.slot})`).join(' '));
  const wrongSlot = shots.filter((s) => s.probe.shownSeason !== s.probe.slot);
  ok(wrongSlot.length === 0, '`shownSeason` 已等于当前槽位（淡入确实落到终点）',
    wrongSlot.map((s) => `${s.term}(${s.probe.shownSeason}≠${s.probe.slot})`).join(' '));
  /* ★ 画面与 UI 必须指向同一档 —— 只截 canvas 时这条查不出来。 */
  const uiMismatch = shots.filter((s) => !s.probe.uiTerm.includes(s.term));
  ok(uiMismatch.length === 0, 'HUD 上的节气名与所截档位一致（画面与 UI 同一档）',
    uiMismatch.map((s) => `${s.term}→HUD"${s.probe.uiTerm.trim()}"`).join(' '));
  const slow = shots.filter((s) => s.waited >= FADE_BUDGET_MS);
  ok(slow.length === 0, `没有档位等满淡入预算（说明状态机能真正判定「已落稳」）`,
    slow.map((s) => `${s.term}=${s.waited}ms`).join(' '));
  ok(errors.length === 0, '全程无页面异常', errors.slice(0, 3).join(' | '));

  /* 索引清单，方便后续脚本按节气找图。 */
  fs.writeFileSync(join(OUT, '_index.json'), JSON.stringify(
    shots.map((s) => ({ index: s.index, term: s.term, file: s.file, slot: s.probe.slot, uiTerm: s.probe.uiTerm.trim() })),
    null, 2));

  console.log(`\n通过 ${pass} 项，未通过 ${fail} 项`);
  console.log(`截图目录：${OUT}`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})();