/* 对「已经在跑的桌面实例」做实机体检—— 不起进程、不关进程，只连CDP 看画面。
 *
 * 为什么不用 check-desktop-boot.cjs：
 *   那个是自包含的一次性脚本（自己起 / 自己断言 / 自己收），
 *   端口固定 4173 + 9224，会和用户已经开着的实例抢端口。
 *   本脚本只**附着**到已有实例：读POND_DESKTOP_PORT / POND_CDP_PORT，
 *   断言当前这一帧到底画没画。
 *
 * 跑法：POND_DESKTOP_PORT=4173 POND_CDP_PORT=9242 node tools/diag-running.cjs
 *
 * ⚠️ 本项目沙箱里三个曾经把诊断带偏的假象（都不是应用的问题）：
 *   ① `tasklist` / Bash 里的 `curl` 都会骗人 —— 前者在沙箱里回空，
 *      后者带代理时连本机端口返 502。要用 **Python subprocess + netstat -ano** 才拿得到真状态。
 *   ② `rm -f out/desktop.log` 会静默失败，于是读到的是上一次窗口的旧日志，
 *      误以为「启动文案不对」。看日志前先确认时间戳。
 *   ③ 在页面里 `drawImage(canvas)` 取像素统计亮度 **恒为 0**（2D 画布绘制缓冲帧末
 *      已被合成器换走）。亮度必须走进程外 `tools/grab-window.py`。
 */
const PW = require('C:/Users/Y/.workbuddy/binaries/node/workspace/node_modules/playwright-core');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = Number(process.env.POND_DESKTOP_PORT || 4173);
const CDP_PORT = Number(process.env.POND_CDP_PORT || 9224);
const OUT = path.join(__dirname, '..', 'out', 'live.png');

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✔' : '✘'} ${name}${detail ? ' —— ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // ① 站点可访问
  let httpOk = false;
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/`);
    httpOk = res.ok;
    check('静态站点可访问', res.ok, `HTTP ${res.status}`);
  } catch (e) {
    check('静态站点可访问', false, e.message);
  }

  // ② CDP 可连
  let browser = null;
  try {
    browser = await PW.chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
    check('CDP 可连', true, `${CDP_PORT}`);
  } catch (e) {
    check('CDP 可连', false, e.message);
  }
  if (!browser) {
    console.log(`\n通过 ${results.filter((r) => r.ok).length}/${results.length}`);
    process.exit(1);
  }

  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0];
  // 真实窗口 rAF 会被节流，这里主动多等几拍让画面跑起来
  await sleep(2500);

  // ③ 窗口标题
  const title = await page.title();
  check('窗口标题正确', title.includes('浮生'), title);

  // ④ 无页面异常
  const errs = await page.evaluate(() => (window.__ERRS__ || []).slice(0, 5));
  check('无页面异常', errs.length === 0, errs.length ? JSON.stringify(errs) : '0 条');

  // ⑤ canvas 在位
  const cv = await page.evaluate(() => {
    const c = document.querySelector('canvas');
    if (!c) return null;
    const r = c.getBoundingClientRect();
    return { w: c.width, h: c.height, cssW: Math.round(r.width), cssH: Math.round(r.height) };
  });
  check('canvas 在位', !!cv, cv ? `${cv.w}×${cv.h}（CSS ${cv.cssW}×${cv.cssH}）` : '未找到');

  // ⑥ root 有子节点（防 TDZ 白屏）
  const kids = await page.evaluate(() => document.getElementById('root')?.childElementCount ?? -1);
  check('root 有子节点', kids > 0, `${kids} 个`);

  // ⑦⑧ 画面非黑非白 + 在动：**进程外**抓窗口位图算亮度
  //   ⚠️ 反直觉的坑：一开始在页面里 `drawImage(canvas)` 取像素，结果恒为 0/0 ——全黑。
  //   原因是 2D canvas 的绘制缓冲在帧末就被合成器换走了，帧外读回拿到的是空缓冲。
  //   `page.screenshot()` 走的是合成器，能拍到；但亮度统计必须与 check-desktop-boot 同口径，
  //   所以直接复用 tools/grab-window.py（win32 PrintWindow + PIL），判据也照抄：std > 6 且 mean > 10。
  const PY = process.env.PYTHON || 'C:/Users/Y/.workbuddy/binaries/python/envs/default/Scripts/python.exe';
  const shot = (out) => new Promise((resolve) => {
    const args = [path.join(__dirname, 'grab-window.py')];
    if (out) args.push('浮生 · 摸鱼桌面', out);
    const child = spawn(PY, args, { cwd: path.join(__dirname, '..') });
    let so = '', se = '';
    child.stdout.on('data', (d) => { so += d; });
    child.stderr.on('data', (d) => { se += d; });
    child.on('error', (e) => resolve({ ok: false, out: e.message }));
    child.on('exit', () => resolve({ ok: true, out: so + se }));
  });
  const g1 = await shot('out/frame-a.png');
  const mean1 = Number((g1.out.match(/均亮度 ([\d.]+)/) || [])[1] || 0);
  const std1 = Number((g1.out.match(/标准差 ([\d.]+)/) || [])[1] || 0);
  check('画面非黑非白', std1 > 6 && mean1 > 10, `均亮度 ${mean1} · 标准差 ${std1}`);

  // 无边框
  const nc = g1.out.match(/非客户区 = (\d+) × (\d+)/);
  check('非客户区 = 0×0（真无边框）', !!nc && nc[1] === '0' && nc[2] === '0', nc ? `${nc[1]} × ${nc[2]} px` : g1.out.trim().slice(0, 120));

  // 画面在动：抓两帧做**逐像素**差分
  //   ⚠️ 又一个判据设计的坑：一开始比「两帧的聚合亮度均值/标准差」，Δ 恒为 0.00。
  //   原因是聚合统计量对**局部**运动天然不敏感 —— 28 尾鱼在 1725×1125 里占比太小，
  //   游动改不动全画面均值。必须落到逐像素（tools/diff-frames.py）。
  //   阈值 0.30%：只需能分辨「真在动」与「完全静止」，不与 check:feedcircle 的
  //   ④c 门控抖动阈值（5.0px/帧）混用，两套量具各自独立标定。
  await sleep(1500);
  await shot('out/frame-b.png');
  // ⚠️ 本沙箱里 `spawnSync` 对任何可执行文件都返回 EBUSY（项目已记录），
  //    异步 spawn 才正常 —— 差分也走异步。
  const diffOut = await new Promise((resolve) => {
    const c = spawn(PY, [path.join(__dirname, 'diff-frames.py'), 'out/frame-a.png', 'out/frame-b.png'],
      { cwd: path.join(__dirname, '..') });
    let so = '', se = '';
    c.stdout.on('data', (d) => { so += d; });
    c.stderr.on('data', (d) => { se += d; });
    c.on('error', (e) => resolve({ ok: false, out: e.message }));
    c.on('exit', () => resolve({ ok: true, out: so + se }));
  });
  const pct = Number((diffOut.out || '').match(/([\d.]+)%/)?.[1] || NaN);
  check('画面在动', pct > 0.30,
    isNaN(pct) ? `差分失败：${(diffOut.out || '').trim().slice(0, 140)}` : `${pct}% 像素变化`);

  // 存图
  const buf = await page.screenshot({ type: 'png' });
  fs.writeFileSync(OUT, buf);
  console.log(`\n截图：${OUT}`);

  const pass = results.filter((r) => r.ok).length;
  console.log(`通过 ${pass}/${results.length}`);
  // ★注意：只断开 CDP 附着，不 close() —— 见 check-desktop-boot.cjs 文件头
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch((e) => {
  console.error('ERR', e.stack || e.message);
  process.exit(1);
});
