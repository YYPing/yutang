'use strict';
const { app, BrowserWindow, Menu, Tray, nativeImage, screen, globalShortcut, ipcMain, systemPreferences } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { allowedEntry, requireBoolean, pointForBounds, parseHelperLine, displayMetrics } = require('./policy.cjs');

app.setName('浮生锦鲤池');
const SHORTCUT = 'CommandOrControl+Shift+K';
const FEED_SHORTCUT = 'CommandOrControl+Shift+F';
const isMac = process.platform === 'darwin';
const WINDOW_MIN = [560, 420];
let windowTransition = Promise.resolve();
let pondWindow, tray, nativeWindow, normalBounds, cursorTimer, permissionTimer, pointerProcess;
let quitting = false;
let globalGeneration = 0;
let lastCursor = '';
let nativeError = '';
// ★ 开发态（未打包）也允许「登录时启动」：用 Electron 运行时的 execPath + 应用目录
//   作为登录项（Windows 写注册表 Run 项、macOS 写 LaunchAgent）。
//   打包态用 app.getPath('exe')（用户装的那个 App）。两者都指回同一个 main.cjs。
const LAUNCH_AT_LOGIN_OK = ['darwin', 'win32'].includes(process.platform);
function launchItemSettings(enabled) {
  // openAsHidden 只对打包态有意义（用户装好的 App 有 --hidden 协议/参数处理）；
  // 开发态是裸 electron.exe，带 openAsHidden 会导致开机后窗口直接隐藏、
  // 没有 main.cjs 分支去还原 ⇒ 反而"开机找不到应用"。故开发态不带。
  if (app.isPackaged) return { openAtLogin: enabled, openAsHidden: false };
  // ★ 开发态：注册 electron.exe <项目根目录> + 与手动启动**同一组**运行参数。
  //   少了 --no-sandbox / --disable-gpu-sandbox / --no-proxy-server，
  //   开机自启时窗口会全黑或 ERR_FAILED（这些坑见 launch-desktop.cjs 文件头）。
  //   参数与 tools/launch-desktop.cjs、桌面快捷方式保持一致。
  const appDir = app.getAppPath();
  return {
    openAtLogin: enabled,
    path: process.execPath,
    args: [appDir, '--no-sandbox', '--disable-gpu-sandbox', '--no-proxy-server'],
  };
}
let state = {
  isDesktop: true, desktopMode: false, globalInteraction: false,
  globalInteractionStatus: 'disabled', launchAtLogin: false,
  launchAtLoginSupported: LAUNCH_AT_LOGIN_OK,
  platform: process.platform, desktopSupported: false,
  shortcut: SHORTCUT, feedShortcut: FEED_SHORTCUT,
  shortcutAvailable: false, feedShortcutAvailable: false,
  message: '窗口内点击即可与当前主题互动。桌面模式可从菜单栏锦鲤图标恢复。',
};

const nativeDir = app.isPackaged ? path.join(process.resourcesPath, 'native') : path.join(__dirname, 'native', 'bin');
const pointerPath = path.join(nativeDir, 'pond-pointer');
let entryURL = pathToFileURL(path.join(__dirname, '..', 'dist', 'index.html')).href;
if (!app.isPackaged && process.env.VITE_DEV_SERVER_URL) {
  const candidate = new URL(process.env.VITE_DEV_SERVER_URL);
  if (candidate.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(candidate.hostname) || candidate.username || candidate.password || candidate.pathname !== '/') {
    throw new Error('Development UI must use a loopback HTTP origin and root path.');
  }
  entryURL = candidate.href;
}

/* --- 内置静态服务（让 electron.exe 能直接当启动入口，无需 node + 控制台）--------
 * 动机：此前桌面版必须靠 `node tools/launch-desktop.cjs` 起一个 node 静态服务，
 * 于是快捷方式目标是 `cmd /c "... npm run desktop:local"`，**任务栏常驻一个
 * 「npm run desktop」的控制台黑框图标**——用户要求「只留系统托盘图标」。
 * 现在把 dist 静态服务直接搬进 Electron 主进程：快捷方式可以指向
 * `electron.exe .`（GUI 子系统程序，**不弹控制台、不占任务栏**），一步到位。
 *
 * 启用条件：未打包 **且** 没有外部 VITE_DEV_SERVER_URL（即没有别的静态服务
 * 在管这件事）⇒ 自动启用。所以「双击 electron.exe .」和
 * 「npm run desktop:hidden」都能直接跑，不依赖任何环境变量或额外包装脚本。
 * 口径与 tools/launch-desktop.cjs 一致：同样的 MIME 表、同样的目录逃逸防护
 * （解析后必须仍在 dist 内）、同样只读。若已设 VITE_DEV_SERVER_URL
 * （Vite dev / launch-desktop.cjs 老路），行为与之前完全一致，零影响。
 * ------------------------------------------------------------------------ */
const EMBED_STATIC = !app.isPackaged && !process.env.VITE_DEV_SERVER_URL;
const STATIC_PORT = Number(process.env.POND_DESKTOP_PORT || 4173);
const STATIC_MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2', '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.wav': 'audio/wav',
};
function startEmbeddedStatic() {
  const ROOT = path.join(__dirname, '..', 'dist');
  if (!fs.existsSync(path.join(ROOT, 'index.html'))) {
    throw new Error('dist/index.html 不存在，先跑 npm run build');
  }
  const server = http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = path.resolve(ROOT, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); return res.end('not found');
    }
    res.writeHead(200, { 'Content-Type': STATIC_MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => {
    server.on('error', (error) => {
      console.error(error.code === 'EADDRINUSE'
        ? `端口 ${STATIC_PORT} 已被占用 —— 换一个：POND_DESKTOP_PORT=4180`
        : `内置静态服务启动失败：${error.message}`);
      app.quit();
    });
    server.listen(STATIC_PORT, '127.0.0.1', () => {
      entryURL = `http://127.0.0.1:${STATIC_PORT}/`;
      console.log(`内置静态服务 ${entryURL}（dist）`);
      resolve();
    });
  });
}

function currentState() {
  const display = state.desktopMode || !pondWindow || pondWindow.isDestroyed()
    ? screen.getPrimaryDisplay() : screen.getDisplayMatching(pondWindow.getBounds());
  return { ...state, fullScreen: !!pondWindow?.isFullScreen(), visible: !!pondWindow?.isVisible(), minimized: !!pondWindow?.isMinimized(), display: displayMetrics(display) };
}
function publish() {
  if (pondWindow && !pondWindow.isDestroyed()) pondWindow.webContents.send('pond:state', currentState());
  updateTray();
  return currentState();
}
function describeInteraction() {
  if (state.globalInteractionStatus === 'active') return '全局点击互动已开启，仅监听鼠标左键；不读取键盘内容。';
  if (state.globalInteractionStatus === 'awaiting-permission') return '请在系统设置 → 隐私与安全性 → 辅助功能中允许本应用，然后返回；也可继续使用窗口内互动。';
  if (state.globalInteractionStatus === 'error') return '系统未允许鼠标监听。可在系统设置检查辅助功能／输入监控，或使用窗口内互动。';
  if (state.globalInteractionStatus === 'unavailable') return '此版本无法监听全局点击。桌面中可恢复控制窗口互动。';
  return state.desktopMode ? '桌面已开启鼠标穿透。移动鼠标到池塘，按 ⌘/Ctrl+Shift+F 撒食；⌘/Ctrl+Shift+K 恢复控制。' : '窗口内点击即可与当前主题互动。桌面模式可从菜单栏锦鲤图标恢复。';
}

function sendPointer(type, point, source, fallbackCenter = false) {
  if (!pondWindow || pondWindow.isDestroyed()) return;
  const bounds = pondWindow.getContentBounds();
  let mapped = pointForBounds(point, bounds);
  if (!mapped && fallbackCenter) mapped = { x: bounds.width / 2, y: bounds.height / 2, normalizedX: 0.5, normalizedY: 0.5 };
  if (mapped) pondWindow.webContents.send('pond:pointer', { type, ...mapped, source, timestamp: Date.now() });
}
function cursorPoint() {
  try { return screen.getCursorScreenPoint(); } catch { return { x: Number.NaN, y: Number.NaN }; }
}
function feed(source = 'tray') { sendPointer('feed', cursorPoint(), source, true); }

function applyDesktopMode(enabled) {
  requireBoolean(enabled);
  if (!pondWindow || pondWindow.isDestroyed()) return currentState();
  if (enabled && !state.desktopSupported) {
    state.message = nativeError || '此平台暂不支持原生桌面层；可以继续使用窗口或全屏预览。';
    return publish();
  }
  if (state.desktopMode === enabled) return currentState();
  let placementError = '';
  if (enabled) {
    normalBounds = pondWindow.getNormalBounds();
    pondWindow.setMinimumSize(1, 1);
    pondWindow.setResizable(false);
    pondWindow.setMovable(false);
    pondWindow.setFullScreenable(false);
    pondWindow.setAlwaysOnTop(false);
    pondWindow.setHasShadow(false);
    pondWindow.setSkipTaskbar(true);
    if (isMac) {
      pondWindow.setWindowButtonVisibility(false);
      pondWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
      pondWindow.setHiddenInMissionControl(true);
    }
    pondWindow.setBounds(screen.getPrimaryDisplay().bounds, false);
    pondWindow.setIgnoreMouseEvents(true, { forward: true });
    pondWindow.setFocusable(false);
    pondWindow.blur();
    pondWindow.showInactive();
    try {
      // Windows 版在拿不到桌面容器时会返回 0（未公开消息 0x052C 可能失效）。
      // 统一按失败处理，交给下方的 placementError 分支降级回普通窗口。
      const level = nativeWindow.setDesktopLevel(pondWindow.getNativeWindowHandle(), true);
      // ★ 用 <= 0，不能用 !level：失败码是负数，而 -1 在 JS 里是 truthy
      if (level <= 0) {
        placementError = level === -1 ? '未找到 Windows 桌面窗口（Progman）。'
          : level === -2 ? '未拿到桌面容器（WorkerW），0x052C 消息未生效。'
          : '未能把窗口挂进桌面层。';
      }
    }
    catch (error) { placementError = `桌面层切换失败：${error.message}`; }
    if (isMac) app.dock.hide();
  } else {
    // 退出桌面层：macOS 与 Windows 都要还原（Windows 要还原父窗口和窗口样式）
    try { nativeWindow?.setDesktopLevel(pondWindow.getNativeWindowHandle(), false); } catch { /* Restore the ordinary window controls even if the addon failed. */ }
    if (isMac) {
      pondWindow.setVisibleOnAllWorkspaces(false);
      pondWindow.setHiddenInMissionControl(false);
      pondWindow.setWindowButtonVisibility(true);
      app.dock.show();
    }
    pondWindow.setIgnoreMouseEvents(false);
    pondWindow.setFocusable(true);
    pondWindow.setSkipTaskbar(false);
    pondWindow.setResizable(true);
    pondWindow.setMovable(true);
    pondWindow.setFullScreenable(true);
    pondWindow.setHasShadow(true);
    if (normalBounds) pondWindow.setBounds(normalBounds);
    pondWindow.setMinimumSize(...WINDOW_MIN);
    pondWindow.show();
    pondWindow.focus();
  }
  state.desktopMode = enabled;
  if (placementError) {
    applyDesktopMode(false);
    state.desktopSupported = false;
    nativeError = placementError;
    state.message = `${placementError}，已恢复窗口。`;
    return publish();
  }
  lastCursor = '';
  state.message = describeInteraction();
  return publish();
}

// macOS fullscreen changes Spaces asynchronously. Queue transitions so entering
// desktop mode cannot race a pending fullscreen animation or a second click.
function transitionWindow(action) {
  const result = windowTransition.then(action);
  windowTransition = result.catch(() => {});
  return result;
}
function changeFullScreen(enabled) {
  if (!pondWindow || pondWindow.isDestroyed() || pondWindow.isFullScreen() === enabled) return Promise.resolve();
  const win = pondWindow;
  return new Promise((resolve, reject) => {
    const event = enabled ? 'enter-full-screen' : 'leave-full-screen';
    const cleanup = () => { clearTimeout(timer); win.removeListener(event, done); win.removeListener('closed', closed); };
    const done = () => { cleanup(); resolve(); };
    const closed = () => { cleanup(); reject(new Error('Window closed during fullscreen transition.')); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('Fullscreen transition timed out.')); }, 6000);
    win.once(event, done); win.once('closed', closed);
    win.setFullScreen(enabled);
  });
}
function setDesktopMode(enabled) {
  requireBoolean(enabled);
  return transitionWindow(async () => {
    if (enabled) await changeFullScreen(false);
    return applyDesktopMode(enabled);
  });
}
function setFullScreen(enabled) {
  requireBoolean(enabled);
  return transitionWindow(async () => {
    if (state.desktopMode) applyDesktopMode(false);
    if (pondWindow?.isMinimized()) pondWindow.restore();
    pondWindow?.show();
    await changeFullScreen(enabled);
    return publish();
  });
}
function hideWindow() {
  pondWindow?.hide();
  return publish();
}

function showControls() {
  if (!pondWindow || pondWindow.isDestroyed()) createWindow();
  applyDesktopMode(false);
  if (pondWindow.isMinimized()) pondWindow.restore();
  pondWindow.show();
  pondWindow.focus();
  return currentState();
}

function stopPointerHelper() {
  globalGeneration += 1;
  clearInterval(permissionTimer);
  permissionTimer = undefined;
  if (pointerProcess) { pointerProcess.kill('SIGTERM'); pointerProcess = undefined; }
}
function startPointerHelper() {
  if (pointerProcess || !state.globalInteraction) return;
  clearInterval(permissionTimer);
  permissionTimer = undefined;
  const generation = globalGeneration;
  let pending = '';
  pointerProcess = spawn(pointerPath, [], { stdio: ['ignore', 'pipe', 'ignore'], shell: false, windowsHide: true });
  pointerProcess.stdout.setEncoding('utf8');
  pointerProcess.stdout.on('data', (chunk) => {
    if (generation !== globalGeneration) return;
    pending += chunk;
    if (pending.length > 16384) { pending = ''; return; }
    let newline;
    while ((newline = pending.indexOf('\n')) >= 0) {
      const data = parseHelperLine(pending.slice(0, newline));
      pending = pending.slice(newline + 1);
      if (!data) continue;
      if (data.event === 'ready' || data.event === 'denied') {
        state.globalInteractionStatus = data.event === 'ready' ? 'active' : 'error';
        state.message = describeInteraction();
        publish();
      } else if (state.desktopMode && state.globalInteractionStatus === 'active') {
        sendPointer('feed', data, 'global-click');
      }
    }
  });
  const failed = () => {
    if (generation !== globalGeneration || !state.globalInteraction) return;
    pointerProcess = undefined;
    state.globalInteractionStatus = 'error';
    state.message = describeInteraction();
    publish();
  };
  pointerProcess.on('error', failed);
  pointerProcess.on('exit', failed);
}
function setGlobalInteraction(enabled) {
  requireBoolean(enabled);
  stopPointerHelper();
  state.globalInteraction = enabled;
  if (!enabled) state.globalInteractionStatus = 'disabled';
  else if (!isMac || !fs.existsSync(pointerPath)) state.globalInteractionStatus = 'unavailable';
  else if (systemPreferences.isTrustedAccessibilityClient(true)) {
    state.globalInteractionStatus = 'awaiting-permission';
    startPointerHelper();
  } else {
    state.globalInteractionStatus = 'awaiting-permission';
    permissionTimer = setInterval(() => {
      if (state.globalInteraction && systemPreferences.isTrustedAccessibilityClient(false)) startPointerHelper();
    }, 1500);
  }
  state.message = describeInteraction();
  return publish();
}
function setLaunchAtLogin(enabled) {
  requireBoolean(enabled);
  if (!state.launchAtLoginSupported) {
    state.message = '登录时启动仅在 macOS／Windows 上可用。';
    return publish();
  }
  try {
    app.setLoginItemSettings(launchItemSettings(enabled));
    state.launchAtLogin = app.getLoginItemSettings().openAtLogin;
    state.message = state.launchAtLogin === enabled ? (enabled ? '已设为登录时启动。' : '已关闭登录时启动。') : '系统没有接受登录启动设置；可在系统设置 → 通用 → 登录项中手动管理。';
  } catch { state.message = '系统未能更新登录项；可在系统设置中手动管理。'; }
  return publish();
}

function makeTrayIcon() {
  const size = 22;
  const bitmap = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const body = ((x - 9) / 6) ** 2 + ((y - 11) / 3.4) ** 2 <= 1;
    const tail = x >= 14 && x <= 19 && Math.abs(y - 11) <= (x - 13) * 0.65;
    const eye = (x - 6) ** 2 + (y - 10) ** 2 < 1.6;
    if ((body || tail) && !eye) bitmap[(y * size + x) * 4 + 3] = 255;
  }
  const icon = nativeImage.createFromBitmap(bitmap, { width: size, height: size });
  if (isMac) icon.setTemplateImage(true);
  return icon;
}
function updateTray() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '浮生锦鲤池', enabled: false },
    { type: 'separator' },
    { label: '打开风景控制台', accelerator: SHORTCUT, click: showControls },
    { label: '融入桌面', type: 'checkbox', checked: state.desktopMode, enabled: state.desktopSupported, click: (item) => setDesktopMode(item.checked) },
    { label: '隐藏风景窗口', click: hideWindow },
    { label: '撒一把鱼食', accelerator: FEED_SHORTCUT, click: () => sendPointer('feed', null, 'menu', true) },
    { type: 'separator' },
    { label: '全局点击互动（需系统授权）', type: 'checkbox', checked: state.globalInteraction, enabled: isMac && fs.existsSync(pointerPath), click: (item) => setGlobalInteraction(item.checked) },
    { label: '登录时启动', type: 'checkbox', checked: state.launchAtLogin, enabled: state.launchAtLoginSupported, click: (item) => setLaunchAtLogin(item.checked) },
    { type: 'separator' },
    { label: '退出摸鱼桌面', click: () => app.quit() },
  ]));
}

/* --- 池塘存档（§14.1 快照）-------------------------------------------------
 * 位置：Electron 的 userData 目录 = %APPDATA%\浮生锦鲤池\save.json
 *
 * ⚠️ 与需求 F-14.1.1 的字面差异：需求写的是 %APPDATA%\koi-pond\save.json。
 *    那份文档是为 Tauri 版写的；本体是 Electron，强行把 userData 改成 koi-pond
 *    会**丢掉用户已有的 localStorage**（设置、手绘锦鲤都存在那里）。
 *    实质要求（放在用户数据目录、不进安装目录、用户可自行备份）二者等价。
 * -------------------------------------------------------------------------- */
const SAVE_MAX_BYTES = 8 * 1024 * 1024;
const saveFile = () => path.join(app.getPath('userData'), 'save.json');

function readSaveFile() {
  try {
    const file = saveFile();
    const info = fs.statSync(file);
    // 超限的存档不当存档读：宁可从头开始，也不把几百 MB 的垃圾塞进内存
    if (!info.isFile() || info.size > SAVE_MAX_BYTES) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;   // 不存在 / 损坏 / 权限不足 —— 一律当作「没有存档」
  }
}

function writeSaveFile(data) {
  const file = saveFile();
  // null = 清除存档（「重置池塘」用）。删文件，而不是写个 "null" 进去 ——
  // 免得用户打开 save.json 看到一坨看不懂的东西。
  if (data === null) {
    try { fs.unlinkSync(file); } catch { /* 本来就不存在 */ }
    return true;
  }
  const text = JSON.stringify(data);
  if (typeof text !== 'string' || text.length > SAVE_MAX_BYTES) throw new Error('Save payload is too large.');
  const temp = `${file}.tmp`;
  // ★ 原子写：先落 .tmp 再 rename。直接覆写时若中途断电，会留下半个 JSON，
  //   下次启动读不出来 —— 等于把上一个完好的存档也毁掉了。
  fs.writeFileSync(temp, text, 'utf8');
  fs.renameSync(temp, file);
  return true;
}

function registerIPC() {
  const handle = (channel, action) => ipcMain.handle(channel, (event, ...args) => {
    if (!pondWindow || event.sender !== pondWindow.webContents || event.senderFrame !== pondWindow.webContents.mainFrame || !allowedEntry(event.senderFrame.url, entryURL)) {
      throw new Error('Untrusted IPC sender.');
    }
    return action(...args);
  });
  handle('pond:get-state', currentState);
  handle('pond:set-desktop-mode', setDesktopMode);
  handle('pond:set-global-interaction', setGlobalInteraction);
  handle('pond:set-launch-at-login', setLaunchAtLogin);
  handle('pond:feed', () => feed('tray'));
  handle('pond:show-controls', showControls);
  handle('pond:set-full-screen', setFullScreen);
  handle('pond:hide', hideWindow);
  handle('pond:minimize', () => { pondWindow.minimize(); return publish(); });
  handle('pond:quit', () => { setImmediate(() => app.quit()); });
  handle('pond:load-save', readSaveFile);
  handle('pond:save-save', (data) => { writeSaveFile(data); return true; });
}

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  pondWindow = new BrowserWindow({
    width: Math.min(1380, workArea.width - 60), height: Math.min(900, workArea.height - 70),
    minWidth: WINDOW_MIN[0], minHeight: WINDOW_MIN[1], show: false,
    resizable: true, movable: true, fullscreenable: true, minimizable: true, closable: true,
    // 无边框：自绘窗口条（App.jsx 的 .window-bar：拖动区 + 全屏/最小化/隐藏/关闭）已经就位。
    // macOS 用 hiddenInset —— 保留红绿灯；Windows/Linux 用 frame:false。
    // ⚠️ 不要给 macOS 也设 frame:false，那会把红绿灯一并去掉。
    // Windows 侧 thickFrame 保持默认 true：窗口仍有阴影、仍能拖边缘调整大小。
    // ★ skipTaskbar：窗口不占任务栏按钮，只保留系统托盘图标（用户要求）。
    //   隐藏后靠托盘「打开风景控制台」/ 双击托盘把窗口唤回，不会丢窗口。
    //   只对 Windows/Linux 生效，macOS 保持原有 Dock 行为不变。
    ...(isMac ? {} : {}),
    ...(isMac
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 20 } }
      : { frame: false, thickFrame: true }),
    title: '浮生 · 摸鱼桌面', backgroundColor: '#1d302e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true,
      nodeIntegration: false, webSecurity: true, allowRunningInsecureContent: false,
      webviewTag: false, navigateOnDragDrop: false, backgroundThrottling: false,
    },
  });
  pondWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  pondWindow.webContents.on('will-navigate', (event, url) => { if (!allowedEntry(url, entryURL)) event.preventDefault(); });
  pondWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());
  pondWindow.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  pondWindow.webContents.session.setPermissionCheckHandler(() => false);
  pondWindow.webContents.on('did-finish-load', publish);
  pondWindow.on('moved', publish);
  for (const event of ['enter-full-screen', 'leave-full-screen', 'show', 'hide', 'minimize', 'restore']) pondWindow.on(event, publish);
  pondWindow.once('ready-to-show', () => pondWindow.show());
  pondWindow.on('close', (event) => {
    // Defer quit until this cancellable close event finishes. Calling quit
    // inside it re-enters the same native close and can leave the app running.
    if (!quitting) { event.preventDefault(); setImmediate(() => app.quit()); }
  });
  pondWindow.on('closed', () => { pondWindow = undefined; });
  pondWindow.on('leave-full-screen', () => {
    if (state.desktopMode) {
      pondWindow.setBounds(screen.getPrimaryDisplay().bounds, false);
      nativeWindow?.setDesktopLevel(pondWindow.getNativeWindowHandle(), true);
    }
  });
  pondWindow.loadURL(entryURL).catch((error) => console.error('Could not load the pond UI:', error.message));
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', showControls);
  // 若启用内置静态服务，先把 dist 伺服起来（entryURL 会在 listen 回调里改写），
  // 再建窗口 —— 否则窗口会先用 file:// 加载再被拒。
  const ready = EMBED_STATIC ? app.whenReady().then(startEmbeddedStatic) : app.whenReady();
  ready.then(() => {
    // macOS 走 Cocoa 窗口层级，Windows 走 Progman/WorkerW，两者共用同一份 pond-window.node 接口。
    // ⚠️ 原来这里只有 isMac 分支，Windows 上编出模块也不会被加载。
    if (isMac || process.platform === 'win32') {
      try { nativeWindow = require(path.join(nativeDir, 'pond-window.node')); state.desktopSupported = true; }
      catch (error) { nativeError = `原生桌面模块加载失败（请先运行 pnpm build:native）：${error.message}`; }
    }
    if (state.launchAtLoginSupported) state.launchAtLogin = app.getLoginItemSettings().openAtLogin;
    tray = new Tray(makeTrayIcon());
    tray.setToolTip('浮生锦鲤池 · 按 Ctrl+Shift+F 在光标处撒食，鱼会游向你');
    tray.on('double-click', showControls);
    Menu.setApplicationMenu(Menu.buildFromTemplate(isMac ? [
      { label: '浮生锦鲤池', submenu: [{ label: '关于浮生锦鲤池', role: 'about' }, { type: 'separator' }, { label: '打开风景控制台', click: showControls }, { type: 'separator' }, { role: 'quit', label: '退出摸鱼桌面' }] },
      { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
      { label: '窗口', submenu: [{ role: 'minimize', label: '最小化窗口' }, { role: 'togglefullscreen', label: '切换全屏' }, { label: '隐藏风景窗口', click: hideWindow }, { label: '打开风景控制台', click: showControls }] },
    ] : []));
    registerIPC();
    createWindow();
    state.shortcutAvailable = globalShortcut.register(SHORTCUT, showControls);
    state.feedShortcutAvailable = globalShortcut.register(FEED_SHORTCUT, () => feed('shortcut'));
    updateTray();
    cursorTimer = setInterval(() => {
      if (!state.desktopMode || !pondWindow?.isVisible()) return;
      const point = cursorPoint();
      const key = `${point.x},${point.y}`;
      if (key !== lastCursor) { lastCursor = key; sendPointer('move', point, 'cursor'); }
    }, 33);
    const fitDesktopDisplay = () => {
      if (state.desktopMode && pondWindow) {
        pondWindow.setBounds(screen.getPrimaryDisplay().bounds, false);
        nativeWindow?.setDesktopLevel(pondWindow.getNativeWindowHandle(), true);
      }
      publish();
    };
    screen.on('display-metrics-changed', fitDesktopDisplay);
    screen.on('display-added', fitDesktopDisplay);
    screen.on('display-removed', fitDesktopDisplay);
  });
  app.on('activate', showControls);
  app.on('window-all-closed', () => { /* A menu bar app stays available until explicitly quit. */ });
  app.on('before-quit', () => {
    quitting = true;
    stopPointerHelper();
    clearInterval(cursorTimer);
    globalShortcut.unregisterAll();
    tray?.destroy();
    tray = undefined;
  });
}
