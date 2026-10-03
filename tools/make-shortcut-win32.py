"""重建桌面快捷方式：指向 electron.exe，不再经过 cmd / npm run。

为什么不用 cmd：原来的快捷方式目标是 `cmd.exe /c "... npm run desktop:local"`，
会在任务栏常驻一个「npm run desktop」的控制台黑框。electron.exe 是 GUI 子系统
程序，直接启动不弹控制台，配合 main.cjs 的 skipTaskbar，任务栏只剩托盘图标。

用 pywin32 的 WScript.Shell（比手写 ShellLink 二进制可靠）。
"""
import sys

import win32com.client as win32

APP = r"C:\Users\Y\WorkBuddy\2026-09-27-22-16-06\refs\yutang-app"
ELECTRON = APP + r"\node_modules\electron\dist\electron.exe"
LNK = r"C:\Users\Y\Desktop\浮生锦鲤池.lnk"
ICON = APP + r"\electron\assets\app-icon.ico"


def main():
    shell = win32.Dispatch("WScript.Shell")
    link = shell.CreateShortcut(LNK)
    link.TargetPath = ELECTRON
    link.Arguments = ". --no-sandbox --disable-gpu-sandbox --no-proxy-server"
    link.WorkingDirectory = APP
    link.WindowStyle = 1  # SW_SHOWNORMAL
    link.IconLocation = ICON + ",0"
    link.Description = "浮生锦鲤池 · 桌面版（无控制台窗口，只驻留系统托盘）"
    link.save()

    check = shell.CreateShortcut(LNK)
    print("OK  shortcut rebuilt")
    print("    Target     :", check.TargetPath)
    print("    Arguments  :", check.Arguments)
    print("    WorkingDir :", check.WorkingDirectory)
    print("    WindowStyle:", check.WindowStyle)
    print("    Icon       :", check.IconLocation)
    return 0


if __name__ == "__main__":
    sys.exit(main())
