"""在桌面新建（而非覆盖）一个指向 electron.exe 的快捷方式。

原「浮生锦鲤池.lnk」正被系统占用无法覆盖（Permission denied），所以先写成
新名字「浮生锦鲤池(无控制台).lnk」，验证可用后再由用户自行替换。
"""
import os

import win32com.client as win32

APP = r"C:\Users\Y\WorkBuddy\2026-09-27-22-16-06\refs\yutang-app"
ELECTRON = APP + r"\node_modules\electron\dist\electron.exe"
ICON = APP + r"\electron\assets\app-icon.ico"
LNK = r"C:\Users\Y\Desktop\浮生锦鲤池(无控制台).lnk"

shell = win32.Dispatch("WScript.Shell")
s = shell.CreateShortcut(LNK)
s.TargetPath = ELECTRON
s.Arguments = ". --no-sandbox --disable-gpu-sandbox --no-proxy-server"
s.WorkingDirectory = APP
s.WindowStyle = 1
s.IconLocation = ICON + ",0"
s.Description = "浮生锦鲤池 · 桌面版（无控制台窗口，只驻留系统托盘）"
s.save()

v = shell.CreateShortcut(LNK)
print("created:", LNK)
print("  Target     :", v.TargetPath)
print("  Arguments  :", v.Arguments)
print("  WorkingDir :", v.WorkingDirectory)
print("  size       :", os.path.getsize(LNK), "bytes")
