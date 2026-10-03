' 浮生锦鲤池 · 无控制台启动器
' 作用：启动桌面版但**不弹出 cmd 黑框**（任务栏那个「npm run desktop」图标就是它）。
' 原理：WScript.Shell.Run 的第2个参数 0 = 隐藏窗口；第3个 False = 不等待。
' 真正的启动逻辑在 tools\launch-desktop.cjs（静态伺服 dist + 拉起 Electron）。
Option Explicit
Dim shell, fso, appDir, cmd
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
appDir = fso.GetParentFolderName(WScript.ScriptFullName)
' 清掉 ELECTRON_RUN_AS_NODE / NODE_OPTIONS，否则 Electron 会退化成纯 Node 模式
cmd = "cmd /c set ELECTRON_RUN_AS_NODE=&& set NODE_OPTIONS=&& node """ & appDir & "\tools\launch-desktop.cjs"""
shell.CurrentDirectory = appDir
shell.Run cmd, 0, False
