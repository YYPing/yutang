'use strict';
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

async function build() {
  const root = path.join(__dirname, 'native');
  const include = path.join(root, 'include');
  const output = path.join(root, 'bin');
  fs.mkdirSync(include, { recursive: true });
  fs.mkdirSync(output, { recursive: true });

  const run = (command, args, cwd) => {
    const result = spawnSync(command, args, { stdio: 'inherit', shell: false, cwd });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${command} failed (${result.status})`);
  };
  // cmd 的引号解析很挑剔：spawnSync 传数组会转义内部引号，导致带空格的 vcvarsall.bat 找不到。
  // 用 shell:true 整条命令交出去，并把命令整体再包一层引号（cmd /s /c 会剥掉外层那对）。
  const runCmd = (command, cwd) => {
    const result = spawnSync(`"${command}"`, { stdio: 'inherit', shell: true, cwd });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`命令失败 (${result.status}): ${command.slice(0, 140)}`);
  };

  /* ---------------- macOS：Cocoa 窗口层级 ---------------- */
  if (process.platform === 'darwin') {
    const headers = ['node_api.h', 'node_api_types.h', 'js_native_api.h', 'js_native_api_types.h'];
    await Promise.all(headers.map(async (name) => {
      const target = path.join(include, name);
      if (fs.existsSync(target)) return;
      const response = await fetch(`https://raw.githubusercontent.com/nodejs/node/v22.19.0/src/${name}`);
      if (!response.ok) throw new Error(`Node-API header download failed: ${response.status}`);
      fs.writeFileSync(target, await response.text());
    }));
    const license = path.join(include, 'LICENSE.node');
    if (!fs.existsSync(license)) {
      const response = await fetch('https://raw.githubusercontent.com/nodejs/node/v22.19.0/LICENSE');
      if (!response.ok) throw new Error('Could not fetch the Node.js header license.');
      fs.writeFileSync(license, await response.text());
    }
    const arch = process.env.POND_BUILD_ARCH || process.arch;
    if (!['arm64', 'x64'].includes(arch)) throw new Error('Only arm64 and x64 macOS builds are supported.');
    run('xcrun', ['clang++', '-std=c++17', '-fobjc-arc', '-shared', '-undefined', 'dynamic_lookup',
      '-DNAPI_VERSION=8', '-DNODE_GYP_MODULE_NAME=pond_window', '-arch', arch === 'x64' ? 'x86_64' : 'arm64',
      '-mmacosx-version-min=12.0', '-I', include, '-framework', 'Cocoa', '-framework', 'CoreGraphics',
      path.join(root, 'window-level.mm'), '-o', path.join(output, 'pond-window.node')]);
    run('xcrun', ['swiftc', '-O', '-target', `${arch === 'x64' ? 'x86_64' : 'arm64'}-apple-macosx12.0`,
      path.join(root, 'pointer-helper.swift'), '-o', path.join(output, 'pond-pointer')]);
    fs.chmodSync(path.join(output, 'pond-pointer'), 0o755);
    console.log(`Built native desktop layer and optional mouse listener for macOS ${arch}.`);
    return;
  }

  /* ---------------- Windows：Progman / WorkerW 桌面层 ---------------- */
  if (process.platform === 'win32') {
    const src = path.join(root, 'window-level-win.cc');
    // ★ 必须链接「electron 版」的导入库。Electron 进程里不存在 node.exe：
    //   若链接 Node 官方的 node.lib，导入表会指向 node.exe，加载 .node 时进程直接崩，
    //   而报错只有一行 "crashpad_client_win.cc: not connected"，极难定位。
    const libPath = path.join(include, 'node-electron.lib');
    // ★ 不用 vcvarsall.bat：本机 Build Tools 的清单不全，它会报
    //   "The specified configuration type is missing"。直接探测路径、手动搭环境更可靠。
    const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const numeric = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true });

    const msvcRoot = path.join(programFilesX86, 'Microsoft Visual Studio', '2022', 'BuildTools',
      'VC', 'Tools', 'MSVC');
    if (!fs.existsSync(msvcRoot)) throw new Error('找不到 MSVC 工具链，请先安装 VS 2022 Build Tools（C++ 桌面开发）。');
    const msvcVer = fs.readdirSync(msvcRoot).filter(v => /^\d+\.\d+/.test(v)).sort(numeric).pop();
    const msvc = path.join(msvcRoot, msvcVer);
    const clExe = path.join(msvc, 'bin', 'Hostx64', 'x64', 'cl.exe');
    if (!fs.existsSync(clExe)) throw new Error(`找不到 cl.exe：${clExe}`);

    const kitsRoot = path.join(programFilesX86, 'Windows Kits', '10');
    const sdkVer = fs.readdirSync(path.join(kitsRoot, 'Include'))
      .filter(v => /^\d+\.\d+\.\d+\.\d+$/.test(v)).sort(numeric).pop();
    const sdkInc = path.join(kitsRoot, 'Include', sdkVer);
    const sdkLib = path.join(kitsRoot, 'Lib', sdkVer);

    const env = {
      ...process.env,
      INCLUDE: [path.join(msvc, 'include'), path.join(sdkInc, 'ucrt'), path.join(sdkInc, 'um'),
        path.join(sdkInc, 'shared'), path.join(sdkInc, 'winrt')].join(';'),
      LIB: [path.join(msvc, 'lib', 'x64'), path.join(sdkLib, 'ucrt', 'x64'),
        path.join(sdkLib, 'um', 'x64')].join(';'),
      PATH: [path.join(msvc, 'bin', 'Hostx64', 'x64'), process.env.PATH].join(';')
    };

    // 缺失时才生成。升级 Electron 后若桌面层加载异常，删掉 node-electron.lib 重新生成即可。
    if (!fs.existsSync(libPath)) {
      const electronExe = path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'electron.exe');
      if (!fs.existsSync(electronExe)) throw new Error(`找不到 electron.exe：${electronExe}`);
      // ★ spawnSync 直接把含空格/括号的 exe 路径当 argv[0] 传，Windows 上会静默起不来
      //   （status=null、stdout 全空）。必须 shell:true + 双引号包路径。
      const dumpbinExe = path.join(msvc, 'bin', 'Hostx64', 'x64', 'dumpbin.exe');
      const dump = spawnSync(`"${dumpbinExe}" /exports "${electronExe}"`,
        { shell: true, encoding: 'utf8', maxBuffer: 1024 * 1024 * 64 });
      // 正则必须带 0-9：napi_create_int32 / napi_get_value_int64 这类符号含数字，
      // 漏掉它们会在链接时报 "无法解析的外部符号 napi_create_int32"。
      const names = [...new Set((dump.stdout || '').match(/\bnapi_[A-Za-z0-9_]+\b/g) || [])].sort();
      if (!names.length) throw new Error('electron.exe 未导出 napi_* 符号，无法生成导入库');
      const defPath = path.join(include, 'node-electron.def');
      fs.writeFileSync(defPath, ['LIBRARY electron.exe', 'EXPORTS', ...names].join('\n'));
      const libExe = path.join(msvc, 'bin', 'Hostx64', 'x64', 'lib.exe');
      const libResult = spawnSync(`"${libExe}" /def:"${defPath}" /machine:x64 /out:"${libPath}"`,
        { shell: true, encoding: 'utf8' });
      if (libResult.status !== 0) throw new Error('生成 node-electron.lib 失败');
      console.log(`  已从 electron.exe 生成导入库（${names.length} 个 napi 符号）`);
    }

    const out = path.join(output, 'pond-window.node');
    // shell:false + 数组参数，避开 cmd 那套引号转义坑
    // /utf-8 必须加：源文件带中文注释，MSVC 默认按系统代码页(GBK)解析 UTF-8，
    // 会把 lambda 的 [] 之类解析错，报出一堆看似无关的语法错误。
    const result = spawnSync(clExe, ['/nologo', '/O2', '/std:c++17', '/EHsc', '/LD', '/utf-8',
      '/DNAPI_VERSION=8', '/DNODE_GYP_MODULE_NAME=pond_window', '/I', include,
      src, libPath, 'user32.lib', '/Fe:' + out],
      { stdio: 'inherit', shell: false, cwd: output, env });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`cl.exe 编译失败 (${result.status})`);
    console.log(`  MSVC ${msvcVer} / SDK ${sdkVer}`);
    console.log('Built native desktop layer for Windows (Progman -> WorkerW).');
    return;
  }

  console.log('Native desktop integration is macOS/Windows-only; window preview remains available.');
}

build().catch((error) => { console.error(error.message); process.exitCode = 1; });
