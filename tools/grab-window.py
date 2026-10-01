# 抓一张**真实 Electron 窗口**的位图（不是网页截图），用来确认「窗口不是白屏」。
#
# ★ 为什么不能只看进程活着：dev server 的 transform 缓存滞后时，
#   窗口进程活着、标题也正常，但整片白屏（`TypeError: this.xxx is not a function`）。
#   唯一能定的判据是**把窗口内容抓下来看**。
#
# 用 PrintWindow + PW_RENDERFULLCONTENT(=2)：Chromium 的合成结果在 GPU 层，
# 普通的 BitBlt 抓不到（会得到全黑/全白），必须走 PrintWindow 的完整渲染内容路径。
#
# 用法：python tools/grab-window.py "浮生 · 摸鱼桌面" out/window.png
import ctypes
import sys
from ctypes import wintypes

try:
    ctypes.windll.shcore.SetProcessDpiAwareness(2)
except Exception:
    ctypes.windll.user32.SetProcessDPIAware()

u = ctypes.windll.user32
g = ctypes.windll.gdi32
u.FindWindowW.restype = wintypes.HWND

TITLE = sys.argv[1] if len(sys.argv) > 1 else '浮生 · 摸鱼桌面'
OUT = sys.argv[2] if len(sys.argv) > 2 else 'out/window.png'

hwnd = u.FindWindowW(None, TITLE)
if not hwnd:
    print(f'找不到窗口「{TITLE}」')
    sys.exit(2)

rect = wintypes.RECT()
u.GetWindowRect(hwnd, ctypes.byref(rect))
w, h = rect.right - rect.left, rect.bottom - rect.top

# 非客户区尺寸 —— 顺带复核「无边框」
crect = wintypes.RECT()
u.GetClientRect(hwnd, ctypes.byref(crect))
pt = wintypes.POINT(0, 0)
u.ClientToScreen(hwnd, ctypes.byref(pt))
print(f'窗口标题 = {TITLE!r}')
print(f'窗口矩形 {w}×{h} @({rect.left},{rect.top}) · 客户区 {crect.right}×{crect.bottom} @({pt.x},{pt.y})')
print(f'非客户区 = {w - crect.right} × {h - crect.bottom} px（真无边框应为 0 × 0）')

hdc = u.GetWindowDC(hwnd)
mem = g.CreateCompatibleDC(hdc)
bmp = g.CreateCompatibleBitmap(hdc, w, h)
g.SelectObject(mem, bmp)
ok = u.PrintWindow(hwnd, mem, 2)   # 2 = PW_RENDERFULLCONTENT

class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [('biSize', wintypes.DWORD), ('biWidth', wintypes.LONG), ('biHeight', wintypes.LONG),
                ('biPlanes', wintypes.WORD), ('biBitCount', wintypes.WORD), ('biCompression', wintypes.DWORD),
                ('biSizeImage', wintypes.DWORD), ('biXPelsPerMeter', wintypes.LONG),
                ('biYPelsPerMeter', wintypes.LONG), ('biClrUsed', wintypes.DWORD), ('biClrImportant', wintypes.DWORD)]

info = BITMAPINFOHEADER()
info.biSize = ctypes.sizeof(BITMAPINFOHEADER)
info.biWidth, info.biHeight = w, -h          # 负高度 = 自上而下
info.biPlanes, info.biBitCount, info.biCompression = 1, 32, 0

buf = ctypes.create_string_buffer(w * h * 4)
lines = g.GetDIBits(mem, bmp, 0, h, buf, ctypes.byref(info), 0)

g.DeleteObject(bmp); g.DeleteDC(mem); u.ReleaseDC(hwnd, hdc)
if not ok or lines == 0:
    print(f'PrintWindow 失败（ok={ok}, lines={lines}）—— 窗口可能被最小化')
    sys.exit(3)

from PIL import Image, ImageStat
img = Image.frombytes('RGBA', (w, h), buf.raw, 'raw', 'BGRA').convert('RGB')
img.save(OUT)
lum = ImageStat.Stat(img.convert('L'))
print(f'→ {OUT}  {img.size}')
print(f'均亮度 {lum.mean[0]:.1f} · 标准差 {lum.stddev[0]:.1f}'
      f'{"  ⚠️ 接近纯色，疑似白屏/黑屏" if lum.stddev[0] < 6 else "  ✔ 有画面内容"}')
