/* 在受限环境里把桌面版跑起来：同一个进程树里起「本地回环静态站点(dist) + Electron」。
 *
 * ★ 什么时候需要它：直接 `electron .`（或 `pnpm desktop`）在**受限沙箱**里会失败，
 *   而且失败得很像"程序坏了"，其实全是环境：
 *
 *   1. **页面加载 ERR_FAILED、窗口全黑** —— main.cjs 给 renderer 开了 `sandbox: true`，
 *      而本工具的进程本身也在沙箱里，渲染进程的内核沙箱起不来 ⇒ 导航直接失败，
 *      页面代码一行都没跑。加 `--no-sandbox` 即好。
 *      （症状极具误导性：进程活着、窗口标题正常、CDP 上也有 page target，就是全黑。）
 *   2. **`electron .` 的默认入口是 `file://<dist>/index.html`** —— 在本环境里文档加载会失败。
 *      main.cjs 允许用 `VITE_DEV_SERVER_URL` 指定回环 HTTP 原点，于是这里把 dist
 *      用一个小静态服务端出来。窗口 / 无边框 / 托盘 / 桥（window.pondDesktop）全都还是真的，
 *      只有页面原点从 file:// 换成 http://127.0.0.1:PORT —— 定位链路走的分支完全一致
 *      （桌面端看的是 `window.pondDesktop` 存在与否，不看原点）。
 *   3. **GPU 进程反复崩**（`GPU process exited unexpectedly: exit_code=-1073741819`
 *      → 最终 `FATAL: GPU process isn't usable. Goodbye.`）—— 加 `--disable-gpu-sandbox`。
 *      ⚠️ **不要**顺手加 `--use-angle=swiftshader`：那是强制 CPU 软件渲染，
 *         画面肉眼一模一样、帧率却从 120 掉到个位数（见 electron-desktop-e2e skill 坑 4）。
 *
 * 跑法：node tools/launch-desktop.cjs    （先 npm run build）
 * 顺带开 CDP 9224，方便用 playwright 连上去看页面（`connectOverCDP` 在本项目里可用；
 * 注意：页面若压根没加载成功，连它会直接超时 —— 这个超时本身就是"页面没起来"的信号）。
 *
 * ⚠️⚠️ **`electron 退出 4294967295`（= -1）时别一律当成"程序崩了"**，有两种情况：
 *
 *   ① **CDP 核对脚本收尾调了 `browser.close()`** —— CDP 拿到的是**附着**的 browser，
 *      `close()` 等价于发 `Browser.close` ⇒ 把 Electron 应用整个关掉。这是**真因**。
 *      跑完直接 `process.exit(0)` 让 WS 自己断。（实测：后台任务 52 秒后被报 failed。）
 *   ② **宿主/沙箱回收了 Agent 起的后台进程** —— 存活时长实测 52s / 1m41s / 12m6s / 1h51m，
 *      与代码、与有没有 `close()`、与下面那步管道隔离**都没有相关性**。
 *      ⇒ 这不是本脚本能修的。**正确的应对是不要把「启动测试」建在长驻进程上**：
 *        用 `tools/check-desktop-boot.cjs`（一个前台命令里 起窗口 → 8 项断言 → 收工）。
 *
 *   两种情况的日志长得一模一样（都只有 `DevTools listening` + `electron 退出 -1`），
 *   区分办法：**去看这个时间点附近有没有人跑过 CDP 脚本**。
 *   详见 electron-desktop-e2e skill 坑 11 / 坑 12。
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..');
const ROOT = path.join(APP, 'dist');
const PORT = Number(process.env.POND_DESKTOP_PORT || 4173);
const CDP_PORT = Number(process.env.POND_CDP_PORT || 9224);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2', '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4',
};

if (!fs.existsSync(path.join(ROOT, 'index.html'))) {
  console.error('dist/index.html 不存在，先跑 npm run build');
  process.exit(1);
}

const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.resolve(ROOT, `.${pathname === '/' ? '/index.html' : pathname}`);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); return res.end('not found');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

server.on('error', (error) => {
  console.error(error.code === 'EADDRINUSE'
    ? `端口 ${PORT} 已被占用（多半是上一次的实例没退干净）—— 换一个：POND_DESKTOP_PORT=4180 node tools/launch-desktop.cjs`
    : `静态站点启动失败：${error.message}`);
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  const env = { ...process.env, VITE_DEV_SERVER_URL: `http://127.0.0.1:${PORT}/` };
  // 这两个必须清掉，否则 electron.exe 会被当成 node 来跑（进程秒退、什么都不打印）。
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  // ★★ 子进程的输出**重定向到日志文件**，不要 `stdio: 'inherit'`。
  //    这是**加固**（不是长驻失败的解药 —— 那个是宿主回收，本脚本修不了）：
  //    ① 日志落到 out/desktop.log，可以事后用 `node -e fs.readFileSync` 查（终端里 cat 会给陈旧内容）；
  //    ② 不会因为终端关闭 / 后台任务停止采集这类宿主侧的管道变化而牵连到应用。
  fs.mkdirSync(path.join(APP, 'out'), { recursive: true });
  const LOG = path.join(APP, 'out', 'desktop.log');
  const logFd = fs.openSync(LOG, 'a');
  const child = spawn(path.join(APP, 'node_modules', 'electron', 'dist', 'electron.exe'), [
    '.',
    '--no-sandbox',            // ★ 见文件头 1：少了它窗口全黑，而且没有任何报错指向这里
    '--disable-gpu-sandbox',   // ★ 见文件头 3
    '--no-proxy-server',       // 别把 127.0.0.1 送去环境变量里的代理
    `--remote-debugging-port=${CDP_PORT}`,
    // 干净房间：换一个 userData 目录 ⇒ 没有存档、没有 localStorage、没有"归来摘要"面板。
    // 不设就沿用默认目录（看到的才是用户真实的那一池）。
    ...(process.env.POND_USER_DATA_DIR ? [`--user-data-dir=${process.env.POND_USER_DATA_DIR}`] : []),
  ], { cwd: APP, env, stdio: ['ignore', logFd, logFd] });
  console.log(`静态站点 http://127.0.0.1:${PORT}/ · Electron PID ${child.pid} · CDP ${CDP_PORT}`
    + ` · 日志 out/desktop.log`
    + (process.env.POND_USER_DATA_DIR ? ` · 干净房间 ${process.env.POND_USER_DATA_DIR}` : ''));
  child.on('exit', (code) => {
    try { fs.closeSync(logFd); } catch {}
    console.log('electron 退出', code);
    server.close();
    process.exit(code ?? 0);
  });
});

// 宿主管道断了也别把自己拖死：本进程只写几行状态，丢掉即可。
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});
