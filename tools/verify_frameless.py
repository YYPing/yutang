# 客观验证「无边框」。
#
# ★ 踩过的坑：不能靠 WS_CAPTION 样式位判断！
#   Electron 的 frame:false 在 Windows 上**保留** WS_CAPTION | WS_THICKFRAME 样式位，
#   改用 WM_NCCALCSIZE 把非客户区裁成 0。所以按样式位判断会把无边框窗口误判成有边框。
#   （实测：窗口 style=0x14C70000 含 WS_CAPTION，但非客户区高度 = 0，实际无标题栏。）
#
# ✔ 正确判据：比较「窗口矩形」与「客户区矩形」的差值 —— 即非客户区尺寸。
#     有标题栏/边框 → 非客户区高度 ≈ 30–40px（DPI 相关）、宽度 > 0
#     真无边框     → 高度差 = 0 且宽度差 = 0，且客户区屏幕原点 == 窗口左上角
import ctypes
import sys
from ctypes import wintypes

try:
    ctypes.windll.shcore.SetProcessDpiAwareness(2)   # 必须最先做，否则拿到逻辑坐标
except Exception:
    ctypes.windll.user32.SetProcessDPIAware()

u = ctypes.windll.user32
u.FindWindowW.restype = wintypes.HWND

TITLE = sys.argv[1] if len(sys.argv) > 1 else '锦鲤池塘'
hwnd = u.FindWindowW(None, TITLE)
if not hwnd:
    print('✘ 找不到窗口「%s」—— 程序没起来？' % TITLE)
    sys.exit(2)

wr = wintypes.RECT(); u.GetWindowRect(hwnd, ctypes.byref(wr))
cr = wintypes.RECT(); u.GetClientRect(hwnd, ctypes.byref(cr))
origin = wintypes.POINT(0, 0); u.ClientToScreen(hwnd, ctypes.byref(origin))

winW, winH = wr.right - wr.left, wr.bottom - wr.top
cliW, cliH = cr.right - cr.left, cr.bottom - cr.top
ncH, ncW = winH - cliH, winW - cliW

style = u.GetWindowLongW(hwnd, -16)
sw, sh = u.GetSystemMetrics(0), u.GetSystemMetrics(1)
wa = wintypes.RECT(); u.SystemParametersInfoW(0x0030, 0, ctypes.byref(wa), 0)   # SPI_GETWORKAREA

print('窗口      : %s (hwnd=%d)' % (TITLE, hwnd))
print('style     : 0x%08X   （★ 仅供参考，不可用作无边框判据）' % (style & 0xFFFFFFFF))
print('窗口矩形  : %dx%d @ (%d,%d)' % (winW, winH, wr.left, wr.top))
print('客户区    : %dx%d @ (%d,%d)' % (cliW, cliH, origin.x, origin.y))
print('非客户区  : 高 %d px / 宽 %d px' % (ncH, ncW))
print('屏幕      : %dx%d   工作区: %dx%d' % (sw, sh, wa.right - wa.left, wa.bottom - wa.top))
print()

ok = True
if ncH != 0 or ncW != 0:
    print('✘ 存在非客户区（高 %d / 宽 %d）—— 仍有标题栏或边框' % (ncH, ncW)); ok = False
if origin.x != wr.left or origin.y != wr.top:
    print('✘ 客户区原点与窗口左上角不重合 —— 有边框偏移'); ok = False

covered = winW >= sw and winH >= sh
if not covered:
    note = '工作区高度（未盖住任务栏）' if winH == wa.bottom - wa.top else '自定义尺寸'
    print('· 未铺满全屏：%dx%d，等于%s' % (winW, winH, note))
    print('  （有意保留任务栏可点；壁纸模式下由桌面层承载，不覆盖任务栏）')

print()
print('结论：', '✔ 无边框' if ok else '✘ 有边框')
sys.exit(0 if ok else 1)
