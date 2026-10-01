/* 在真实 Electron 窗口里走完「存档 → 回拨时钟 → 冷启动还原 → 归来摘要」全链路。
 *
 * 为什么必须走真实窗口：这条链路的每一环都只在 Electron 里才成立 ——
 *   IPC 文件通道、beforeunload 同步兜底、冷启动先读档再建世界。
 *   Node 侧冒烟（tools/smoke-save.js）只能验算法，验不了「谁来调、什么时候调」。
 *
 * ★ 为什么必须**真的重启进程**，而不是 page.reload()：
 *   reload 会触发 beforeunload，那个处理器拿 Date.now() 把墙钟时间重写一遍 ——
 *   刚回拨的「3 天前」当场被冲掉，归来摘要永远测不出来。
 * ★ 为什么必须**优雅退出**（app.quit()），不能 taskkill /F：
 *   Chromium 的 localStorage 是异步刷盘的，强杀会丢掉最近一次写入（回拨的值根本没落盘）。
 *   优雅退出前再把存档键冻结（见 phaseSeed 的注释），双保险。
 *
 * 三个阶段（由 tools/check-save-full.sh 串起来，因为阶段之间要重启进程）：
 *   node tools/check-save-ui.cjs <PORT> seed         ← 开生态/设倍速/等落盘/回拨两条通道/优雅退出
 *   （外部：等进程退出 → node ... rewind-file → 重启 Electron）
 *   node tools/check-save-ui.cjs <PORT> rewind-file  ← 退出之后再压磁盘那份（此时没人会覆盖它）
 *   node tools/check-save-ui.cjs <PORT> restore      ← 断言归来摘要 + 重置二次确认
 */
const PW = require('C:/Users/Y/.workbuddy/binaries/node/workspace/node_modules/playwright-core');
const fs = require('fs');
const path = require('path');
const PORT = process.argv[2] || '9223';
const PHASE = process.argv[3] || 'seed';
const THREE_DAYS = 3 * 86400000;
const TWO_DAYS = 2 * 86400000;

// userData 目录由 app.setName('浮生锦鲤池') 决定（不是 package.json 的 name）
function findSaveFile() {
  const roaming = process.env.APPDATA || '';
  for (const dir of ['浮生锦鲤池', 'fusheng-koi-pond']) {
    const file = path.join(roaming, dir, 'save.json');
    if (fs.existsSync(file)) return file;
  }
  return path.join(roaming, '浮生锦鲤池', 'save.json');   // 还没写过时用预期路径
}
const SAVE_FILE = findSaveFile();

let ok = true;
const check = (label, cond, detail = '') => {
  console.log(`  ${cond ? '✔' : '✘'} ${label}${detail ? '  — ' + detail : ''}`);
  ok = ok && cond;
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function connect(tries = 12) {
  for (let i = 0; i < tries; i++) {
    try { return await PW.chromium.connectOverCDP('http://127.0.0.1:' + PORT); }
    catch { await sleep(2000); }
  }
  throw new Error('连不上 CDP ' + PORT);
}

async function openPage(browser) {
  const ctx = browser.contexts()[0];
  const page = (ctx ? ctx.pages() : []).find(p => /5188|浮生|pond/i.test(p.url())) || ctx.pages()[0];
  if (!page) throw new Error('没有可用页面');
  await page.waitForTimeout(1500);
  return page;
}

/**
 * 打开设置面板。★ 不能直接点「设置」——上一次跑可能把面板留在打开状态，
 * 黑色 backdrop 会拦住点击（Playwright 报 "intercepts pointer events"）。
 * 先按 Esc 收干净（应用里 Esc 关面板），再按需点开。
 */
async function openSettings(page) {
  for (let i = 0; i < 3; i++) {
    const open = await page.evaluate(() => !!document.querySelector('.panel-backdrop'));
    if (!open) break;
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
  }
  const stillOpen = await page.evaluate(() => !!document.querySelector('.panel-backdrop'));
  if (!stillOpen) {
    await page.locator('button').filter({ hasText: /^设置$/ }).first().click({ timeout: 5000 });
  }
  await page.waitForTimeout(800);
}

/* ------------------------------------------------------------------ seed */
async function phaseSeed(browser) {
  const page = await openPage(browser);

  console.log('\n=== ① 启动门控没有弄坏渲染 ===');
  const boot = await page.evaluate(() => ({
    canvas: !!document.querySelector('canvas.pond-canvas'),
    status: document.querySelector('.scene-status')?.textContent.replace(/\s+/g, ' ').trim() || '',
  }));
  check('锦鲤画布已挂载（读档门控已放行）', boot.canvas, boot.status);

  console.log('\n=== ② 生态模式 + 演化倍速档位 ===');
  await openSettings(page);
  await page.evaluate(() => {
    const row = [...document.querySelectorAll('.toggle-row')].find(r => (r.querySelector('strong')?.textContent || '').trim() === '生态模式');
    const input = row?.querySelector('input');
    if (input && !input.checked) input.click();
  });
  await page.waitForTimeout(2000);

  const speeds = await page.evaluate(() =>
    [...document.querySelectorAll('.speed-choices button')].map(b => b.textContent.trim()));
  check('倍速档位 = 0.5/1/2/5/20', JSON.stringify(speeds) === JSON.stringify(['0.5×', '1×', '2×', '5×', '20×']), JSON.stringify(speeds));

  await page.evaluate(() => {
    [...document.querySelectorAll('.speed-choices button')].find(b => b.textContent.trim() === '20×')?.click();
  });
  await page.waitForTimeout(600);
  const speedState = await page.evaluate(() => ({
    selected: document.querySelector('.speed-choices .selected')?.textContent.trim() || null,
    stored: JSON.parse(localStorage.getItem('fusheng-settings') || '{}').ecoSpeed,
    label: document.querySelector('.speed-row > span')?.textContent.trim() || '',
  }));
  check('点了 20× ⇒ 选中态跟着走', speedState.selected === '20×', `${speedState.label}`);
  check('倍速已持久化（刷新后还在）', speedState.stored === 20, `localStorage.ecoSpeed=${speedState.stored}`);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(1200);

  console.log('\n=== ③ 快照落盘（两条通道）===');
  // beforeunload 的处理函数就挂在 window 上，手动派发一次等价于「用户关窗口」。
  const syncWritten = await page.evaluate(() => {
    window.dispatchEvent(new Event('beforeunload'));
    const raw = localStorage.getItem('fusheng-pond-save');
    if (!raw) return null;
    const envelope = JSON.parse(raw);
    return {
      schemaVersion: envelope.schemaVersion,
      lastSeenWallClock: envelope.lastSeenWallClock,
      fishes: envelope.pond?.fishes?.length ?? 0,
      pondDays: envelope.pond?.pondDays,
      rngIsNumber: typeof envelope.pond?.rngState === 'number',
      wallClockInPondPayload: 'lastSeenWallClock' in (envelope.pond || {}),
    };
  });
  check('beforeunload 同步兜底写入了 localStorage', !!syncWritten);
  check('信封带 schemaVersion + 墙钟时间', syncWritten?.schemaVersion === 1 && syncWritten?.lastSeenWallClock > 0,
    `v${syncWritten?.schemaVersion} · clock=${syncWritten?.lastSeenWallClock}`);
  check('快照含鱼且含 rng 状态', syncWritten?.fishes > 0 && syncWritten?.rngIsNumber,
    `${syncWritten?.fishes} 尾 · pondDays=${syncWritten?.pondDays}`);
  check('墙钟只在信封层，没混进池塘快照', syncWritten?.wallClockInPondPayload === false);

  console.log('     等待自动保存周期写文件（最多 40s）…');
  // ★ 不能只判断「文件存在」—— 上一次跑留下的旧档也在那里。
  //   必须要求 mtime 变新，才证明是**这一次**的自动保存写进去的。
  const baseline = fs.existsSync(SAVE_FILE) ? fs.statSync(SAVE_FILE).mtimeMs : 0;
  let written = null;
  for (let i = 0; i < 20 && !written; i++) {
    await sleep(2000);
    try { const info = fs.statSync(SAVE_FILE); if (info.size > 0 && info.mtimeMs > baseline) written = info; } catch { /* 还没写 */ }
  }
  check('save.json 落到 userData', !!written, written ? `${SAVE_FILE} · ${written.size} 字节` : '40s 内未出现');
  if (written) {
    const onDisk = JSON.parse(fs.readFileSync(SAVE_FILE, 'utf8'));
    check('文件里是同一套信封', onDisk.schemaVersion === 1 && Array.isArray(onDisk.pond?.fishes),
      `${onDisk.pond?.fishes?.length} 尾 · clock=${onDisk.lastSeenWallClock}`);
  }

  console.log('\n=== ④ 回拨两条通道的时钟，然后优雅退出 ===');
  // ★ 这里有两个坑，都踩过：
  //   ① **不能强杀**（taskkill /F）。Chromium 的 localStorage 是异步刷盘的，
  //      强杀会丢掉最近一次写入 —— 回拨的值根本没落盘。必须走应用自己的 quit（优雅退出）。
  //   ② **不能就这么退出**。优雅退出会触发 beforeunload，App 的处理器拿 Date.now()
  //      把墙钟重写一遍，刚回拨的「3 天前」当场被冲掉（实测：重启后摘要显示「你离开了 2 分钟」）。
  //      ⇒ 退出前把 `fusheng-pond-save` 这个键在 Storage.prototype 上冻结，
  //        让 beforeunload 那句 setItem 变成空操作。只冻这一个键，settings 照常写。
  const rewound = await page.evaluate(async (delta) => {
    const KEY = 'fusheng-pond-save';
    const envelope = JSON.parse(localStorage.getItem(KEY));
    envelope.lastSeenWallClock -= delta;
    localStorage.setItem(KEY, JSON.stringify(envelope));

    const realSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === KEY) return;                  // 冻结存档键
      return realSetItem.call(this, key, value);
    };

    localStorage.setItem('fusheng-settings', JSON.stringify({
      ...JSON.parse(localStorage.getItem('fusheng-settings') || '{}'), ecoMode: true,
    }));
    // 磁盘那份也一起回拨（退出后 Bash 还会再强制回拨一次，双保险）
    await window.pondDesktop.writeSave(envelope);
    return envelope.lastSeenWallClock;
  }, THREE_DAYS);
  console.log('     两条通道的时钟已回拨到 ' + rewound);
  check('回拨后比「现在 − 2 天」还早', rewound < Date.now() - TWO_DAYS, new Date(rewound).toISOString());
  // ★★ 为什么必须干等 6 秒再退出：Chromium 的 localStorage 有 ~5 秒的**提交定时器**。
  //    只调 quit() 的话，刚写进去的「3 天前」可能还没落盘 —— 磁盘上留着上一个（新鲜的）值，
  //    重启后被 readPondSave() 判为「较新的那份」而胜出，归来摘要就永远不出现。
  //    这是实测出来的：不等待时好时坏（上一轮过了、这一轮挂），纯粹是提交时机撞运气。
  console.log('     等 6s 让 localStorage 提交落盘，再优雅退出…');
  await page.waitForTimeout(6000);
  await page.evaluate(() => window.pondDesktop.quit()).catch(() => { /* 关闭时连接会断，正常 */ });
  console.log('SEEDED ' + rewound);
}

/* -------------------------------------------------------- rewind-file */
// 应用已经退干净了，此刻磁盘上的 save.json 说什么就是什么 —— 直接压成「3 天前」。
// 幂等：跑几次结果都一样（不依赖上一次的值，避免「回拨了 6 天」）。
function phaseRewindFile() {
  const disk = JSON.parse(fs.readFileSync(SAVE_FILE, 'utf8'));
  const before = disk.lastSeenWallClock;
  disk.lastSeenWallClock = Date.now() - THREE_DAYS;
  fs.writeFileSync(SAVE_FILE, JSON.stringify(disk));
  console.log(`  磁盘存档时钟 ${before} → ${disk.lastSeenWallClock}（${new Date(disk.lastSeenWallClock).toISOString()}）`);
  check('磁盘存档已回拨到 3 天前', disk.lastSeenWallClock < Date.now() - TWO_DAYS);
}

/* -------------------------------------------------------------- restore */
async function phaseRestore(browser) {
  const page = await openPage(browser);
  await page.waitForTimeout(3000);

  console.log('\n=== ⑤ 冷启动：离线补算 + 归来摘要 ===');
  // 先自报家底：哪条通道赢了、时钟是多少。不弹摘要时一眼能看出是「存档没读到」
  // 还是「读到了但没补算」——否则只能对着一个 null 猜。
  const diag = await page.evaluate(async () => {
    const local = JSON.parse(localStorage.getItem('fusheng-pond-save') || 'null');
    let file = null;
    try { file = await window.pondDesktop.loadSave(); } catch { /* 忽略 */ }
    return {
      now: Date.now(),
      localClock: local?.lastSeenWallClock ?? null,
      localFishes: local?.pond?.fishes?.length ?? null,
      fileClock: file?.lastSeenWallClock ?? null,
      fileFishes: file?.pond?.fishes?.length ?? null,
    };
  });
  const asDays = (clock) => (clock ? ((diag.now - clock) / 86400000).toFixed(2) + ' 天前' : '（无）');
  console.log(`    兜底通道：${asDays(diag.localClock)} · ${diag.localFishes} 尾`);
  console.log(`    文件通道：${asDays(diag.fileClock)} · ${diag.fileFishes} 尾`);
  check('至少有一条通道读到了「3 天前」的存档',
    Math.abs((diag.now - (diag.localClock ?? 0)) / 86400000 - 3) < 0.1
    || Math.abs((diag.now - (diag.fileClock ?? 0)) / 86400000 - 3) < 0.1);

  const away = await page.evaluate(() => ({
    title: document.querySelector('.panel h2')?.textContent.trim() || null,
    lead: document.querySelector('.away-lead')?.textContent.replace(/\s+/g, ' ').trim() || null,
    stats: document.querySelector('.panel .eco-status')?.textContent.replace(/\s+/g, ' ').trim() || null,
  }));
  console.log('    面板标题：' + JSON.stringify(away.title));
  console.log('    摘要正文：' + JSON.stringify(away.lead));
  console.log('    数字摘要：' + JSON.stringify(away.stats));
  check('冷启动弹出归来摘要（读档链路走通）', away.title === '池塘里的这些日子');
  check('时长按真实墙钟算（≈3 天）', /3 天/.test(away.lead || ''), away.lead || '');
  // ⚠️ 面板文案是「最高第 N 代」不是「世代」—— 断言要贴真实文案，别按自己脑补的写
  check('摘要带新生/离世/最高世代/池塘日',
    /新生/.test(away.stats || '') && /离世/.test(away.stats || '') && /最高第 \d+ 代/.test(away.stats || '') && /池塘日/.test(away.stats || ''));
  check('未超 30 天 ⇒ 不出现截断提示', !/没有补算/.test(await page.evaluate(() => document.querySelector('.panel .inline-note')?.textContent || '')));

  // ★ 先截图再关面板 —— 顺序反了就只剩一张池塘照，没有摘要本身的证据
  await page.screenshot({ path: 'out/save-away-report.png' });
  console.log('    已保存 out/save-away-report.png（归来摘要面板）');

  await page.evaluate(() => [...document.querySelectorAll('.panel button')].find(b => b.textContent.trim() === '知道了')?.click());
  await page.waitForTimeout(800);
  const alive = await page.evaluate(() => document.querySelector('.scene-status')?.textContent.replace(/\s+/g, ' ').trim() || '');
  check('读档后池塘照常渲染', /尾锦鲤/.test(alive), alive);
  await page.screenshot({ path: 'out/save-away-pond.png' });
  console.log('    已保存 out/save-away-pond.png（补算后的池塘）');

  console.log('\n=== ⑥ 「重置池塘」二次确认（F-14.1.4）===');
  await openSettings(page);
  const reset = () => page.locator('button.row-button').filter({ hasText: /重置池塘|确认重置/ }).first();
  const resetText = () => page.evaluate(() => {
    const btn = [...document.querySelectorAll('button.row-button')].find(b => /重置池塘|确认重置/.test(b.textContent));
    return btn?.textContent.replace(/\s+/g, ' ').trim() || '';
  });

  await reset().click({ timeout: 5000 });
  await page.waitForTimeout(400);
  check('第一次点击只是「上膛」，不执行', /确认重置/.test(await resetText()), await resetText());

  await page.waitForTimeout(5500);
  const defused = await resetText();
  check('5 秒不点 ⇒ 自动撤销（防误触）', /重置池塘/.test(defused) && !/确认重置/.test(defused), defused);

  await reset().click({ timeout: 5000 });
  await page.waitForTimeout(300);
  await reset().click({ timeout: 5000 });
  await page.waitForTimeout(1500);
  const afterReset = await page.evaluate(() => ({
    toast: document.querySelector('.toast')?.textContent.replace(/\s+/g, ' ').trim() || '',
    status: document.querySelector('.eco-status')?.textContent.replace(/\s+/g, ' ').trim() || '',
  }));
  check('第二次点击才真的重置', /已重置/.test(afterReset.toast), afterReset.toast);
  check('重置后池龄归零 · 世代归 1', /第 1 代/.test(afterReset.status) && /池塘日 0/.test(afterReset.status), afterReset.status);

  await page.screenshot({ path: 'out/save-settings.png' });
  console.log('    已保存 out/save-settings.png');
}

(async () => {
  if (PHASE === 'rewind-file') { phaseRewindFile(); }
  else {
    const browser = await connect();
    if (PHASE === 'seed') await phaseSeed(browser);
    else if (PHASE === 'restore') await phaseRestore(browser);
    else throw new Error('未知阶段：' + PHASE);
    // seed 阶段最后会调 app.quit()，此刻连接已经断了 —— close() 抛错属正常
    try { await browser.close(); } catch { /* 已退出 */ }
  }
  console.log(`\n[${PHASE}] 结果:`, ok ? '✔ 通过' : '✘ 有项目未通过');
  setTimeout(() => process.reallyExit(ok ? 0 : 1), 200);
})().catch(e => { console.log('FAILED: ' + e.message); process.reallyExit(2); });
