/**
 * 「时令模式」开关的真浏览器验收。
 *
 * ── 为什么单测不够 ──────────────────────────────────────────────────
 * `tests/almanac.test.js` 验的是**纯函数**（档位、插值、轮转时基）。
 * 它验不到这条链：
 *     SeasonPanel 按钮 → App 的 update() → writeStore → useEnvironment 的 useMemo
 *     → env.solarTerm / env.season / env.almanacProfile → options → PondEngine.updateOptions
 * 这条链上任何一环断了，单测全绿而**用户点了没反应**（或反应了一半）。
 * 项目里已有先例：碰撞开关就是「单测全绿、真机点不动」。
 *
 * ── 判据 ─────────────────────────────────────────────────────────────
 *  ① 面板里真的有「时令模式」三个取值
 *  ② 默认 follow：HUD 显示的节气 = 真实黄经算出的节气
 *  ③ 切 manual 并选「大雪」→ HUD 变「大雪」且出现「演示设定」标记
 *  ④ ★ 此时季节也被节气接管 ⇒ `main` 的 class 变成 season-winter
 *     （这是最容易漏的一条：只改了文案、没改季节，"翻到大雪还是满池荷花"）
 *  ⑤ 引擎真的收到了档案 ⇒ `__pondEngine.options.almanacProfile.ice === 1`
 *  ⑥ 切 cycle → 节气会自己往前走（等 ≤1 档周期就该变化）
 *  ⑦ cycle 期间季节跟着换档
 *  ⑧ 切回 follow → 一切恢复真实（证明可逆，不是单向陷阱）
 *  ⑨ 全程无页面异常
 *
 * 用法：node tools/check-almanac-ui.cjs       （需 dev server 在 5188）
 *      URL=http://127.0.0.1:5189/ node tools/check-almanac-ui.cjs
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
  if (cond) { pass++; console.log(`  ${cond ? '✔' : '✘'} ${label}${detail ? '  — ' + detail : ''}`); }
  else { fail++; console.log(`  ✘ ${label}${detail ? '  — ' + detail : ''}`); }
};
const section = (t) => console.log(`\n${t}`);

/**
 * HUD 上当前显示的节气。
 * ⚠️ 必须把「演示标记」从 text 里剥掉：`.solar-term` 里既有节气名也有 flag，
 *   直接比text 会得到 "·大雪演示设定"。第一版就栽在这里，判据自己写错了。
 */
const readTerm = (page) => page.evaluate(() => {
  const el = document.querySelector('.solar-term');
  if (!el) return null;
  const flag = el.querySelector('.almanac-flag');
  const clone = el.cloneNode(true);
  clone.querySelector('.almanac-flag')?.remove();
  return { text: clone.textContent.replace(/\s+/g, ''), flag: flag ? flag.textContent : '' };
});
/** `main` 上的季节 class（season-winter 之类）。 */
const readSeason = (page) => page.evaluate(() => {
  const m = document.querySelector('main.app');
  const hit = (m?.className || '').match(/season-(\w+)/);
  return hit ? hit[1] : null;
});
const readEngine = (page) => page.evaluate(() => {
  const e = window.__pondEngine;
  if (!e) return null;
  const p = e.options?.almanacProfile;
  return { solarTerm: e.options?.solarTerm ?? null, season: e.options?.season ?? null, ice: p ? p.ice : null, lotus: p ? p.lotus : null };
});
/**
 * 打开「四时」面板。
 * ⚠️ 面板已经开着的时候**不能重复点 dock 按钮** —— backdrop 会吃掉点击，
 *   playwright 无限重试直到超时（第一版在⑥ 栽了30 秒）。
 *   所以先判断 `.season-grid` 在不在。
 */
const openSeasonPanel = async (page) => {
  if (await page.locator('.season-grid').count()) return;
  await page.getByRole('button', { name: '四时' }).click();
  await page.waitForSelector('.season-grid', { timeout: 5000 });
};
/** 关掉当前面板（点 backdrop 空白处或按 Esc，两者都试一次）。 */
const closePanel = async (page) => {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  if (await page.locator('.panel-backdrop').count()) {
    await page.locator('.panel-backdrop').click({ position: { x: 12, y: 12 } });
    await page.waitForTimeout(200);
  }
};
const pickMode = async (page, label) => {
  await page.locator('.mode-choices button', { hasText: label }).first().click();
  await page.waitForTimeout(250);
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await PW.chromium.launch({ executablePath: EXE, args: ['--no-sandbox', '--use-gl=swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE ' + m.text()); });

  await page.goto(URL, { waitUntil: 'load', timeout: 60000 });
  // ★ 预置 summer/sunny 但**不写 almanac* 键** —— 老存档升级路径，验默认 follow。
  await page.evaluate(() => {
    localStorage.setItem('fusheng-settings', JSON.stringify({
      season: 'summer', weather: 'sunny', day: 'day', fishCount: 8, fishSize: 1, turtleCount: 0,
      quality: 'high', reducedMotion: false, sound: false, volume: 0, ecoMode: false,
    }));
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('canvas.pond-canvas', { timeout: 20000 });
  await page.waitForTimeout(1200);

  try {
    section('① 面板结构');
    await openSeasonPanel(page);
    const modeLabels = await page.locator('.mode-choices button > span').allInnerTexts();
    ok(modeLabels.length === 3, '时令模式有且只有三个取值', modeLabels.join(' / ').replace(/\s+/g, ''));
    ok(modeLabels.some((t) => t.includes('跟随节气')), '含「跟随节气」');
    ok(modeLabels.some((t) => t.includes('手动指定')), '含「手动指定」');
    ok(modeLabels.some((t) => t.includes('演示轮转')), '含「演示轮转」');
    ok(await page.locator('.term-grid').count() === 0, 'follow 模式下不显示 24 节气网格（不该占地方）');

section('② 默认 follow：HUD 节气 == 真实黄经');
await closePanel(page);
await page.waitForTimeout(300);
    const followed = await readTerm(page);
    const realTerm = await page.evaluate(async () => {
      const m = await import('/src/lib/environment.js');
      return m.getSolarTerm(new Date());
    });
    ok(followed && followed.text === `·${realTerm}`, 'HUD 节气与真实计算一致', `HUD=${followed?.text}真实=${realTerm}`);
    ok(followed && followed.flag === '', 'follow 模式不显示「演示」标记', `flag="${followed?.flag}"`);

    section('③ 手动指定大雪');
    await openSeasonPanel(page);
    await pickMode(page, '手动指定');
    ok(await page.locator('.term-grid button').count() === 24, '手动模式展开 24 节气网格', `${await page.locator('.term-grid button').count()} 个`);
    await page.locator('.term-grid button', { hasText: '大雪' }).first().click();
    await page.waitForTimeout(500);
    const manual = await readTerm(page);
    ok(manual && manual.text === '·大雪', 'HUD 变成「大雪」', `实际 "${manual?.text}"`);
    ok(manual && manual.flag === '演示设定', '出现「演示设定」标记（防止误认为程序算错）', `flag="${manual?.flag}"`);

    section('④ ★ 季节也被节气接管');
    const seasonNow = await readSeason(page);
    ok(seasonNow === 'winter', 'main class 变成 season-winter', `实际 season-${seasonNow}`);
    ok(await page.locator('.season-card.dimmed').count() === 4, '四个季节卡都变暗（提示滑杆此刻不生效）');

    section('⑤ ★ 引擎真的收到物候档案');
    const engine = await readEngine(page);
    ok(!!engine, '能读到 __pondEngine（dev build）');
    ok(engine?.solarTerm === '大雪', '引擎 options.solarTerm = 大雪', `实际 ${engine?.solarTerm}`);
    ok(engine?.season === 'winter', '引擎 options.season = winter', `实际 ${engine?.season}`);
    ok(engine?.ice === 1, '引擎 options.almanacProfile.ice = 1（大雪是 1.0）', `实际 ${engine?.ice}`);
    ok(engine?.lotus === 0, '大雪 lotus = 0（大雪不该有花，这是用户明确提过的）', `实际 ${engine?.lotus}`);

    section('⑥ 演示轮转：节气自己往前走');
    await openSeasonPanel(page);
    await pickMode(page, '演示轮转');
    const cycling = await readTerm(page);
    ok(cycling?.flag === '演示轮转', '切到轮转后标记变成「演示轮转」', `flag="${cycling?.flag}"`);
    const seen = new Set();
    // CYCLE_STEP_MS = 3000 ⇒ 等8 秒至少能观察到 2 次换档。
    for (let i = 0; i < 16; i++) {
      const t = await readTerm(page);
      if (t?.text) seen.add(t.text);
      await page.waitForTimeout(500);
    }
    ok(seen.size >= 2, '8 秒内至少换过2 档', `观察到 ${seen.size} 档: ${[...seen].join(' ')}`);

section('⑦ 轮转期间季节跟着换档');
// ⚠️ 观察窗口必须够长：3 秒一档 ⇒ 想跨季节至少要覆盖 6+ 档（约 20 秒）。
//   第一版只等 8 秒，恰好在「小暑→立秋→处暑→白露」这 4 档里打转 —— 全是 autumn，
//   于是"季节没跟着变"的假红灯。判据没错，是**采样窗口**不够。
//   这里跑满 26 秒（≈8 档），足够跨一个季节边界。
const seasons = new Set();
for (let i = 0; i < 52; i++) {
  const s = await readSeason(page);
  if (s) seasons.add(s);
  await page.waitForTimeout(500);
}
ok(seasons.size >= 2, '轮转时季节也在变（不是只有文案动）', `观察到: ${[...seasons].join(' ')}`);

    section('⑧ 切回 follow：可逆');
    await openSeasonPanel(page);
    await pickMode(page, '跟随节气');
    await page.waitForTimeout(600);
    const back = await readTerm(page);
    const backSeason = await readSeason(page);
    ok(back?.text === `·${realTerm}`, 'HUD 恢复真实节气', `实际 "${back?.text}" 期望 "·${realTerm}"`);
    ok(back?.flag === '', '演示标记消失');
    ok(backSeason === 'summer', '季节回到 summer（设置里的季节重新生效）', `实际 season-${backSeason}`);

    section('⑨ 存档已落盘（重启不丢）');
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('fusheng-settings') || '{}'));
    ok(saved.almanacMode === 'follow', 'almanacMode 写进了存档', `实际 "${saved.almanacMode}"`);
    ok('almanacTerm' in saved, 'almanacTerm 键存在', `实际 "${saved.almanacTerm}"`);

    await page.screenshot({ path: join(OUT, 'almanac-follow.png') });
  } catch (error) {
    fail++;
    console.log(`  ✘ 执行中断：${error.message}`);
    try { await page.screenshot({ path: join(OUT, 'almanac-fail.png') }); } catch {}
  }

  section('页面异常');
  ok(errors.length === 0, '全程无页面异常', errors.slice(0, 3).join(' | '));

  console.log(`\n通过 ${pass} 项，未通过 ${fail} 项`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})();