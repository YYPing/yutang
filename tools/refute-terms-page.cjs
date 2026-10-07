/**
 * ★ 反证脚本：验证 `shot-terms-page.cjs` 的三条头号判据**不是恒绿的**。
 *
 * ── 为什么必须单独反证 ────────────────────────────────────────────────
 * 全量跑出来 24/24 全绿、用时每档都只要 ~1.3s（远小于 9.5s 淡入预算）——
 * 这**不能**证明「淡入判据」有效，只能证明「每档都 reload ⇒ 首帧直接落定，
 * 淡入压根没启动」。两个数字背后是完全不同的机制，只看全绿会误判。
 *
 * ★★ 同型坑（本项目第 N 次）：「反证跑出与基线**完全相同**的结果 = 反证没生效」。
 *   铁律：反证必须产出一个**明确不同**的读数，否则就是没跑到。
 *
 * 三条反例各自独立：
 *   ① 淡入中途截图   —— 手动把 fadeFrom 置成上一张、shownSeason 保持旧槽位
 * ② 底图未就绪     —— 手动把 bgCanvas 的 opacity 设成 '0'
 *   ③ 画面/UI 错档  —— 请求「夏至」但 HUD 文本改成别的节气名
 */
const PW = require('C:/Users/Y/.workbuddy/binaries/node/workspace/node_modules/playwright-core');
const { join } = require('node:path');
const fs = require('node:fs');

const EXE = 'C:/Users/Y/AppData/Local/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-win64/chrome-headless-shell.exe';
const ROOT = join(__dirname, '..');
const OUT = join(ROOT, 'out', 'terms-page', '_refute');
const URL = process.env.URL || 'http://127.0.0.1:5188/';

/** 与主脚本**逐字相同**的探针 —— 判据必须用同一份代码，否则验的不是它。 */
const READY_PROBE = () => {
  const e = window.__pondEngine;
  const L = e && e.landscape;
  const bg = document.querySelector('canvas.pond-background') || document.querySelector('.pond-background');
  return {
    hasEngine: !!e, ready: !!(L && L.ready), uniforms: !!(L && L.uniforms),
    slot: L ? L.slot : null, shownSeason: L ? L.shownSeason : null,
    fadeFrom: L ? L.fadeFrom : null,
    bgOpacity: bg ? bg.style.opacity : null,
    uiTerm: (document.querySelector('.scene-status .solar-term') || {}).textContent || '',
  };
};

/** 逐条判据（与主脚本同形：条件为真 = 通过）。 */
function judge(p, expectedTerm) {
  return {
    notBlank: !(p.bgOpacity === '0' || p.bgOpacity === null),
    notMidFade: p.fadeFrom === null,
    landed: p.shownSeason === p.slot,
    uiMatches: p.uiTerm.includes(expectedTerm),
  };
}

let pass = 0, fail = 0;
const ok = (c, label, detail) => {
  const mark = c ? '\x1b[32m✔\x1b[0m' : '\x1b[31m✘\x1b[0m';
  if (c) pass++; else fail++;
  console.log(`  ${mark} ${label}${detail ? '  — ' + detail : ''}`);
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await PW.chromium.launch({ executablePath: EXE, args: ['--no-sandbox', '--use-gl=swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1380, height: 900 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));

  const term = '夏至';
  await page.goto(URL, { waitUntil: 'load', timeout: 60000 });
  await page.evaluate((t) => {
    localStorage.setItem('fusheng-settings', JSON.stringify({
      season: 'summer', weather: 'sunny', day: 'day', fishCount: 8, fishSize: 1,
      turtleCount: 0, quality: 'high', reducedMotion: false, sound: false, volume: 0,
      ecoMode: false, almanacMode: 'manual', almanacTerm: t,
    }));
    localStorage.setItem('fusheng-city', JSON.stringify({ name: '杭州', latitude: 30.29, longitude: 120.16, manualPick: true }));
  }, term);
  await page.reload({ waitUntil: 'load', timeout: 60000 });
  await page.waitForSelector('canvas.pond-canvas', { timeout: 25000 });
  await page.waitForFunction(() => !!window.__pondEngine, null, { timeout: 25000 });
  await page.waitForTimeout(2500);

  console.log('\n\x1b[1m基线（未注入反例）\x1b[0m');
  const base = await page.evaluate(READY_PROBE);
  const jb = judge(base, term);
  console.log(`  读数：slot=${base.slot} shown=${base.shownSeason} fadeFrom=${base.fadeFrom} bgOpacity=${base.bgOpacity} HUD="${base.uiTerm.trim()}"`);
  ok(jb.notBlank && jb.notMidFade && jb.landed && jb.uiMatches,
    '★ 基线四条判据全绿（否则反例无从谈起）', '');

  /* ① 反例：把引擎推进到「8s 淡入进行中」的状态。
   * 做法：让 landscape 认为「正在从 spring 淡入到 summer，且刚起算」。
   * 关键：`fadeStart` 设成当前 time（= 进度 0），`fadeFrom` 填一个别的槽位 id，
   * 而 `shownSeason` 保持为**旧槽位**（源码里淡入中它就是起点那张）。
   * 这正是 `landscape.js` 第 377 行那三行做的同一件事。 */
  console.log('\n\x1b[1m① 注入反例：淡入中途（进度 0.5）\x1b[0m');
  const injected = await page.evaluate(() => {
    const e = window.__pondEngine, L = e.landscape;
    L.fadeFrom = 'spring';          // 起点是 spring 图
    L.shownSeason = 'spring';       // 淡入中它一直是起点槽位
    L.fadeStart = (e.sim.time || 0) - 4;   // 已走 8s 的一半
    L.lastDraw = null;
    e.render();
    return { slot: L.slot, shownSeason: L.shownSeason, fadeFrom: L.fadeFrom, fadeStart: L.fadeStart };
  });
  console.log(`  注入：fadeFrom=${injected.fadeFrom} shownSeason=${injected.shownSeason}（slot 仍是 ${injected.slot}）`);
  await page.waitForTimeout(200);
  const p1 = await page.evaluate(READY_PROBE);
  const j1 = judge(p1, term);
  console.log(`  读数：fadeFrom=${p1.fadeFrom} shown=${p1.shownSeason} slot=${p1.slot}`);
  ok(p1.fadeFrom === 'spring', '★ 反例注入生效：fadeFrom 确实非空（说明探针读的是真状态）', '');
  ok(!j1.notMidFade, '★ 判据「不在淡入中途」翻红', `notMidFade=${j1.notMidFade}`);
  ok(!j1.landed, '★ 判据「已落到终点」翻红（shownSeason≠slot）', `landed=${j1.landed}`);
  await page.screenshot({ path: join(OUT, 'refute-1-midfade.png') });

  /* ② 反例：底图 opacity 置 0（模拟纹理未就绪的首帧）。
   * 注意：这必须在 ① 之后做，因为 ① 已经把状态机搞乱了，
   * 而 reload 会把两个反例都清掉 —— 分开跑才能各自归因。 */
  console.log('\n\x1b[1m② 注入反例：底图未就绪（opacity=0）\x1b[0m');
  await page.evaluate(() => {
    const bg = document.querySelector('canvas.pond-background') || document.querySelector('.pond-background');
    if (bg) bg.style.opacity = '0';
  });
  const p2 = await page.evaluate(READY_PROBE);
  const j2 = judge(p2, term);
  console.log(`  读数：bgOpacity=${p2.bgOpacity}`);
  ok(p2.bgOpacity === '0', '★ 反例注入生效（opacity 读到 0）', '');
  ok(!j2.notBlank, '★ 判据「底图不透明」翻红', `notBlank=${j2.notBlank}`);
  await page.screenshot({ path: join(OUT, 'refute-2-blank.png') });

  /* ③ 反例：HUD 文本与所截档位不符（模拟「画面切了但 UI 没切」）。
   * 这条只能靠**改 DOM** 造 —— 因为它是真实用户能看到的错档
   * （面板说芒种、底图是立夏），而只截 canvas 的旧工具查不出来。 */
  console.log('\n\x1b[1m③ 注入反例：HUD 显示别的节气（画面/UI 错档）\x1b[0m');
  await page.reload({ waitUntil: 'load', timeout: 60000 });
  await page.waitForSelector('.scene-status .solar-term', { timeout: 25000 });
  await page.waitForFunction(() => !!window.__pondEngine, null, { timeout: 25000 });
  await page.waitForTimeout(2500);
  await page.evaluate(() => {
    const el = document.querySelector('.scene-status .solar-term');
    if (el) el.textContent = '· 大寒演示设定';
  });
  const p3 = await page.evaluate(READY_PROBE);
  const j3 = judge(p3, term);
  console.log(`  读数：HUD="${p3.uiTerm.trim()}"（请求的是 ${term}）`);
  ok(!p3.uiTerm.includes(term), '★ 反例注入生效（HUD 已不是夏至）', '');
  ok(!j3.uiMatches, '★ 判据「HUD 与所截档位一致」翻红', `uiMatches=${j3.uiMatches}`);
  await page.screenshot({ path: join(OUT, 'refute-3-uidrift.png') });

  console.log('\n\x1b[33m结论：三条头号判据在反例下全部翻红 ⇒ 它们不是恒绿的。\x1b[0m');
  console.log(`\x1b[90m同时确认：全量基线 24/24 全绿且每档只用 ~1.3s，是因为每档都 reload`);
  console.log(`⇒底图在首帧直接落定（shownSeason 从 null 起算），8s 淡入压根没启动。`);
  console.log(`所以「淡入判据」在全量跑里**未被考验**，它的有效性来自本反例而非 24/24。\x1b[0m`);

  ok(errors.length === 0, '反例注入过程无页面异常', errors.slice(0, 2).join(' | '));
  console.log(`\n通过 ${pass} 项，未通过 ${fail} 项`);
  console.log(`反例截图目录：${OUT}`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})();