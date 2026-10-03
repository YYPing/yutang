"""桌面实例的托盘 / 任务栏验收。

为什么不能只看进程：
    进程活着 ≠ 托盘有图标 ≠ 任务栏干净。这三件事在 Windows 上是分开的：
      · 托盘图标由 `Tray` 创建，进程死了才消失 —— 中途失败会静默。
      · 任务栏图标由 `skipTaskbar` 决定，和`frame:false` 是两码事
        （`frame:false` 只去掉标题栏/边框，**照样**占任务栏格）。
    所以只能查Shell 的托盘注册表项 + 窗口的 WS_EX_TOOLWINDOW 标志。

查什么：
    ① 托盘图标：读 `HKCU\\Control Panel\\NotifyIconSettings` 子键里
       有没有指向 electron.exe 且「已可见」的项。
       ⚠️ 已知局限：Win10/11 新通知系统把图标挪进了 `\\Classes\\Local Settings\\...`，
       旧子键不一定有数据 —— 读不到**不能**断言「没有托盘」，只能报告「查不到证据」。
    ② 任务栏：列出本进程所有顶层窗口，看有没有带WS_EX_APPWINDOW(0x40000) 的可见窗口。
       有 ⇒ 占任务栏；只有 WS_EX_TOOLWINDOW(0x80) ⇒ 不占。

用法：python tools/check-tray.py [窗口标题子串]
"""
import ctypes
import ctypes.wintypes as wt
import subprocess
import sys

TITLE_HINT = sys.argv[1] if len(sys.argv) > 1 else '浮生'

user32 = ctypes.windll.user32
WS_EX_APPWINDOW = 0x00040000
WS_EX_TOOLWINDOW = 0x00000080
WS_VISIBLE = 0x10000000

# 找 PID：标题里带关键字的窗口
def find_pid():
    hits = []
    @ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)
    def cb(hwnd, _):
        if not user32.IsWindowVisible(hwnd):
            return True
        n = user32.GetWindowTextLengthW(hwnd)
        if n <= 0:
            return True
        buf = ctypes.create_unicode_buffer(n + 1)
        user32.GetWindowTextW(hwnd, buf, n + 1)
        if TITLE_HINT in buf.value:
            pid = wt.DWORD()
            user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
            hits.append((hwnd, buf.value, pid.value))
        return True
    user32.EnumWindows(cb, 0)
    return hits

hits = find_pid()
print(f'=== 窗口（标题含「{TITLE_HINT}」） ===')
if not hits:
    print('未找到可见窗口')
    sys.exit(3)
taskbar_clean = True
for hwnd, title, pid in hits:
    ex = user32.GetWindowLongW(hwnd, -20)  # GWL_EXSTYLE
    flags = []
    if ex & WS_EX_APPWINDOW:
        flags.append('WS_EX_APPWINDOW(占任务栏)')
        taskbar_clean = False
    if ex & WS_EX_TOOLWINDOW:
        flags.append('WS_EX_TOOLWINDOW(不占任务栏)')
    if ex & WS_VISIBLE:
        flags.append('VISIBLE')
    print(f'  hwnd=0x{hwnd:X} pid={pid} exstyle=0x{ex:08X} [{", ".join(flags) or "无标志"}]')
    print(f'    标题：{title}')

# ⚠️ 判据：占任务栏的**充分条件**是 WS_EX_APPWINDOW。
#    没有它，Shell 就不会给这个窗口分配任务栏格子（`skipTaskbar: true` 走的就是这条路）。
#    其余位（如 WS_EX_WINDOWEDGE=0x100，窗口描边）无害，不代表占位。
#    ⚠️ 反直觉的坑：不能靠「看到某个 exstyle 位」判无边框 —— `frame:false` 是
#    GWL_STYLE 的事（WS_CAPTION/WS_THICKFRAME），与 exstyle 无关。
if taskbar_clean:
    print('\n判定：✔ 任务栏干净（无 WS_EX_APPWINDOW，不占任务栏格子）')
else:
    print('\n判定：✘ 窗口带 WS_EX_APPWINDOW，会在任务栏占一个格子')

# 托盘：列出 NotifyIconSettings 子键 + 找 electron
# ⚠️ 这里的 PowerShell 片段必须用普通字符串（%拼），不能用 f-string ——
#    PowerShell 的属性访问器写作 `.@{[byte]3}`，里面的大括号会被 Python 当成占位符。
print('\n=== 托盘图标注册表 ===')
ps = (
    "$k = 'HKCU:\\Control Panel\\NotifyIconSettings'\n"
    "if (Test-Path $k) {\n"
    "  Get-ChildItem $k | ForEach-Object {\n"
    "    $p = Join-Path $_.PSPath 'IconStreams'\n"
    "    $cls = (Get-ItemProperty -Path $_.PSPath -ErrorAction SilentlyContinue).ExecutablePath\n"
    "    if (-not $cls -and (Test-Path $p)) {\n"
    "      $cls = (Get-ItemProperty -Path $p -ErrorAction SilentlyContinue).ExecutablePath\n"
    "    }\n"
    "    if ($cls) {\n"
    "      $props = Get-ItemProperty -Path $p -ErrorAction SilentlyContinue\n"
    "      $vis = ($props | Select-Object -Property * -ExcludeProperty PS*).PSObject.Properties | ForEach-Object { $_.Value }\n"
    "      Write-Output ($_.PSChildName + \"`t\" + $cls)\n"
    "    }\n"
    "  }\n"
    "} else { Write-Output 'NO_NOTIFYICON_SETTINGS' }\n"
)
r = subprocess.run(['powershell', '-NoProfile', '-Command', ps],
                   capture_output=True, text=True, errors='replace')
out = (r.stdout or '').strip()
if not out or out == 'NO_NOTIFYICON_SETTINGS':
    print('查不到旧版 NotifyIconSettings 数据（Win10/11 新通知系统会挪位置）')
    print('⇒ 读不到证据，不等于「没有托盘图标」；请以肉眼看到的托盘图标为准')
else:
    print(out)
    hit = [l for l in out.splitlines() if 'electron' in l.lower()]
    print('\n判定：' + ('找到 electron 托盘注册项' if hit else '旧表里没有 electron（可能由新通知系统托管）'))
