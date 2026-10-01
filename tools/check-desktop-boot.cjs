/* 桌面版「启动测试」—— 一次性自包含：起窗口 → 断言 → 收工。
 *
 * 为什么要有这个脚本：
 *   原来验收是「后台起 launch-desktop.cjs（挂在那儿不下线）→ 另开命令连 CDP / 抓窗口」。
 *   这套做法在受限沙箱里很脆 —— 后台进程会**在回合之间被回收**，退出码 `-1`，
 *   于是每条验收都伴随一次「后台任务失败」的假告警（实测存活 52s / 1m41s / 12m6s / 1h51m，
 *   与代码无关，与有没有做管道隔离也无关）。
 *   ⇒ 改成**一个前台命令里跑完全部**：自己起、自己断言、自己收，永远不会跨回合。
 *
 * 跑法：node tools/check-desktop-boot.cjs          （先 npm run build）
 *      npm run check:desktop
 * 可选环境变量：POND_DESKTOP_PORT(4173) POND_CDP_PORT(9224) PYTHON(<系统 Python 路径>)
 *
 * 断言（8 项）：
 *   ① 静态站点可访问   ② CDP 可连       ③ 窗口标题正确
 *   ④ 无页面异常       ⑤ canvas 在位    ⑥ root 有子节点（防 TDZ 白屏）
 *   ⑦ 非客户区 = 0×0（真无边框）        ⑧ 画面非黑非白（亮度标准差 > 6）
 */
const { spawn } = require('child_process');
const path = require('path');

const APP = path.join(__dirname, '..');
const PORT = Number(process.env.POND_DESKTOP_PORT || 4173);
const CDP_PORT = Number(process.env.POND_CDP_PORT || 9224);
const PYTHON = process.env.PYTHON || 'C:/Users/Y/AppData/Local/Programs/Python/Python311/python.exe';
const PW = require('C:/Users/Y/.workbuddy/binaries/node/workspace/node_modules/playwright-core');

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✔' : '✘'} ${name}${detail ? ' —— ' + detail : ''}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitHttp(url, tries = 30) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {}
    await sleep(1000);
  }
  return false;
}

// ⚠️ 本沙箱里 `child_process.spawnSync` 对**任何**可执行文件都返回 `EBUSY`
//    （连 `where.exe` 都是），而**异步 `spawn` 正常**。所以这里一律用异步版。
function run(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: APP });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (error) => resolve({ status: null, stdout, stderr, error }));
    child.on('exit', (status) => resolve({ status, stdout, stderr, error: null }));
  });
}

let launcher = null;
async function cleanup() {
  if (!launcher || launcher.killed) return;
  // /T 连子孙一起收：Electron 的主进程 + GPU + 渲染 + 工具进程
  await run('taskkill', ['/PID', String(launcher.pid), '/T', '/F']);
  try { launcher.kill(); } catch {}
}

(async () => {
  console.log(`桌面启动测试 · 站点 127.0.0.1:${PORT} · CDP ${CDP_PORT}\n`);

  // 0) 端口别被上一次的残留占着（launch-desktop 会 EADDRINUSE 直接退出）
  const pre = await fetch(`http://127.0.0.1:${PORT}/`).then(() => true).catch(() => false);
  if (pre) {
    console.log(`✘ 端口 ${PORT} 已有服务在跑 —— 先收掉旧实例，或换端口：`);
    console.log(`   POND_DESKTOP_PORT=4180 POND_CDP_PORT=9225 node tools/check-desktop-boot.cjs`);
    process.exit(1);
  }

  // 1) 起「静态站点 + Electron」
  launcher = spawn(process.execPath, [path.join(__dirname, 'launch-desktop.cjs')], {
    cwd: APP, stdio: ['ignore', 'pipe', 'pipe'],
  });
  launcher.stdout.on('data', () => {});
  launcher.stderr.on('data', () => {});
  launcher.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.log(`\n✘ Electron 提前退出（${code}）—— 常见于 dist 没构建、端口占用、缺 --no-sandbox`);
    }
  });

  try {
    // 2) 站点
    const up = await waitHttp(`http://127.0.0.1:${PORT}/`);
    check('① 静态站点可访问', up, up ? `http://127.0.0.1:${PORT}/` : '30s 内没起来');
    if (!up) throw new Error('站点未就绪');

    // 3) CDP
    const cdpUp = await waitHttp(`http://127.0.0.1:${CDP_PORT}/json/version`, 20);
    check('② CDP 可连', cdpUp, cdpUp ? `127.0.0.1:${CDP_PORT}` : '超时');
    if (!cdpUp) throw new Error('CDP 未就绪');

    // 4) 页面断言（⚠️ 只读，绝不调 browser.close() —— 那会把应用一起关掉）
    const browser = await PW.chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
    const ctx = browser.contexts()[0];
    const pages = ctx ? ctx.pages() : [];
    const page = pages.find((p) => /浮生|pond|127\.0\.0\.1/i.test(p.url())) || pages[0];
    if (!page) throw new Error('没有可用页面');

    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
    await page.waitForTimeout(2000);   // 等首帧 + 生态 tick

    const title = await page.title();
    check('③ 窗口标题', title === '浮生 · 摸鱼桌面', title);

    const dom = await page.evaluate(() => ({
      canvas: document.querySelectorAll('canvas').length,
      rootKids: document.getElementById('root')?.childElementCount ?? -1,
    }));
    check('④ 无页面异常', errors.length === 0, errors.length ? errors.slice(0, 3).join(' | ') : '0 条');
    check('⑤ canvas 在位', dom.canvas > 0, `${dom.canvas} 个`);
    check('⑥ root 有子节点（防 TDZ 白屏）', dom.rootKids > 0, `${dom.rootKids} 个子节点`);
    // 页面断言跑完就断，不 close

    // 5) 窗口位图 + 无边框几何（进程外抓，拿到客户区/非客户区）
    const grab = await run(PYTHON, [path.join(__dirname, 'grab-window.py')]);
    const out = (grab.stdout || '') + (grab.stderr || '');
    if (grab.status !== 0) {
      const why = grab.error ? `spawn 失败 ${grab.error.code || grab.error.message}`
        : grab.signal ? `被信号 ${grab.signal} 结束`
        : out.trim() ? out.trim().slice(0, 160)
        : `退出码 ${grab.status} 且无输出`;
      check('⑦ 非客户区 = 0×0（真无边框）', false, `抓图失败：${why}`);
      check('⑧ 画面非黑非白', false, '抓图失败');
    } else {
      const nc = out.match(/非客户区 = (\d+) × (\d+)/);
      const lum = out.match(/均亮度 ([\d.]+) · 标准差 ([\d.]+)/);
      check('⑦ 非客户区 = 0×0（真无边框）', !!nc && nc[1] === '0' && nc[2] === '0',
        nc ? `${nc[1]} × ${nc[2]} px` : '读不到');
      const std = lum ? Number(lum[2]) : 0;
      const mean = lum ? Number(lum[1]) : 0;
      check('⑧ 画面非黑非白', std > 6 && mean > 10,
        lum ? `均亮度 ${lum[1]} · 标准差 ${lum[2]}` : '读不到');
    }
  } catch (error) {
    console.log(`\n✘ 中断：${error.message}`);
  } finally {
    await cleanup();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} / ${results.length} 通过` +
    (failed.length ? ` —— 未过：${failed.map((f) => f.name).join('、')}` : ''));
  process.exit(failed.length ? 1 : 0);
})();
