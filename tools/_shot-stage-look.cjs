/* 拍一张「生态模式 · 鱼苗成群」的画面，用来肉眼确认 C 方案的视觉结果。
 *
 * ── 为什么不能靠"开着 App 等" ─────────────────────────────────────────
 * 生态时钟是 `1 真实秒 = 1/7200 池塘日`，就算开到 20x，等一天池塘日也要 6 分钟；
 * 要等到"鱼苗成群"那一格（第 24 真实天）得等好几天。
 * 所以这里反过来做：先在本进程里把世界推到目标格，`serialize()` 成快照，
 * 把快照塞进 localStorage 的存档通道 —— App 启动时会 `restoreWorld(snapshot)`，
 * 一开就是那一格。这条路径**就是** §14 的真实读档路径，不是作弊开关。
 *
 * 用法（需 `npm run dev` 在 5188 跑着）：
 *   node tools/_shot-stage-look.cjs [天数=24] [URL]
 */
const PW = require('C:/Users/Y/.workbuddy/binaries/node/workspace/node_modules/playwright-core');
const { pathToFileURL } = require('node:url');
const { join } = require('node:path');
const fs = require('node:fs');

const DAYS = Number(process.argv[2] || 24);
const URL = process.argv[3] || 'http://127.0.0.1:5188/';
const OUT = join(__dirname, '..', 'out');
const EXE = 'C:/Users/Y/AppData/Local/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-win64/chrome-headless-shell.exe';
const src = (p) => pathToFileURL(join(__dirname, '..', 'src', p)).href;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  const { PondSimulation } = await import(src('engine/simulation.js'));
  const { advanceDays } = await import(src('engine/eco/world.js'));
  const mul = (s) => { let a = s >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };

  const sim = new PondSimulation(1600, 1000, { ecoMode: true, ecoSeed: 20260930 }, mul(777));
  for (let day = 1; day <= DAYS; day++) advanceDays(sim.eco, 1, { feedPerDay: 2, stepDays: 0.05 });
  sim.syncEcoFish();
  const pond = sim.getSnapshot();
  const counts = {};
  for (const f of sim.fish) counts[f.stage] = (counts[f.stage] || 0) + 1;
  console.log(`推演到第 ${DAYS} 真实天：`, JSON.stringify(counts));

  const envelope = { schemaVersion: 1, lastSeenWallClock: Date.now(), pond, preferences: { ecoMode: true, ecoSpeed: 1 } };
  const settings = { season: 'summer', weather: 'sunny', day: 'day', fishCount: 12, fishSize: 1, turtleCount: 0, quality: 'high', reducedMotion: false, sound: false, volume: 0.18, ecoMode: true, ecoSpeed: 1 };

  const browser = await PW.chromium.launch({ executablePath: EXE, args: ['--no-sandbox', '--use-gl=swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE ' + m.text()); });

  await page.goto(URL, { waitUntil: 'load', timeout: 60000 });
  await page.evaluate(([s, e]) => {
    localStorage.setItem('fusheng-settings', JSON.stringify(s));
    localStorage.setItem('fusheng-pond-save', JSON.stringify(e));
  }, [settings, envelope]);
  await page.reload({ waitUntil: 'load', timeout: 60000 });

  // 队形要时间成型：出生位置是随机撒的，聚合力的正反馈要跑一会儿才长成群。
  // ⚠️ headless 下 rAF 可能被节流，wall clock 60s 未必等于 60s 的模拟时间，
  //    所以这里多拍几档，用"位置有没有继续收敛"来判断模拟到底跑了多久。
  for (const [label, wait] of [['t9s', 9000], ['t30s', 21000], ['t60s', 30000]]) {
    await page.waitForTimeout(wait);
    await page.screenshot({ path: join(OUT, `stage-look-${label}.png`) });
  }

  const state = await page.evaluate(() => ({
    status: [...document.querySelectorAll('.scene-status span')].map((n) => n.textContent.replace(/\s+/g, ' ').trim()).join(' | '),
    season: document.querySelector('.scene-status p')?.textContent?.replace(/\s+/g, ' ').trim(),
  }));
  console.log('页面状态：', JSON.stringify(state));
  console.log(errors.length ? '控制台错误（去重前 ' + errors.length + ' 条）：\n' + [...new Set(errors)].join('\n') : '控制台无错误 ✔');
  await browser.close();
  console.log('截图：out/stage-look-t9s.png · out/stage-look-t30s.png · out/stage-look-t60s.png');
})();
