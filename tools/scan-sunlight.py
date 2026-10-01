# 连拍**真实 Electron 窗口**，再把「含光柱的那几帧」自动挑出来。
#
# ★ 为什么不能只抓一张：光柱是随机事件（F-10.5.4 间隔 9–26s、存续 5.5–12s），
#   任一时刻**只有约一半时间水面里正好有柱子**。单张抓拍一半概率扑空，
#   而且扑空时看起来和"功能没做"一模一样 —— 这正是最容易得出错误结论的地方。
#
# ★ 为什么不用"固定区域亮度"当判据：光柱的横向落点 `shaft.u` 每束都不同，
#   固定窗口会时灵时不灵。改用**整段序列的逐像素中位数**做背景：
#     · 水面焦散在动、鱼在游 → 中位数把它们抹平
#     · 光柱是**偶发**的 → 中位数里几乎没有它，于是它在一帧里表现为大块正残差
#   再看"最大局部残差块"，就能把有柱的帧排到前面。
#
# 用法：
#   python tools/scan-sunlight.py                      # 连拍 22 帧（约 66s）
#   python tools/scan-sunlight.py --frames 40 --interval 2
#   python tools/scan-sunlight.py --title "浮生 · 摸鱼桌面" --out out/sun
import argparse
import ctypes
import os
import subprocess
import sys
import time
from ctypes import wintypes

import numpy as np
from PIL import Image, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.dirname(HERE)

ap = argparse.ArgumentParser()
ap.add_argument('--title', default='浮生 · 摸鱼桌面')
ap.add_argument('--out', default='out/sun')
ap.add_argument('--frames', type=int, default=22)
ap.add_argument('--interval', type=float, default=3.0)
ap.add_argument('--settle', type=float, default=2.0, help='开局等多久再开始拍')
ap.add_argument('--restore', type=int, default=1, help='先还原/置前窗口（1 开 0 关）')
ap.add_argument('--keep', type=int, default=3, help='挑出前 N 帧另存为 sun-top*.png')
args = ap.parse_args()

OUT = os.path.join(APP, args.out)
os.makedirs(OUT, exist_ok=True)

try:
    ctypes.windll.shcore.SetProcessDpiAwareness(2)
except Exception:
    ctypes.windll.user32.SetProcessDPIAware()

u = ctypes.windll.user32
g = ctypes.windll.gdi32
u.FindWindowW.restype = wintypes.HWND


class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [('biSize', wintypes.DWORD), ('biWidth', wintypes.LONG), ('biHeight', wintypes.LONG),
                ('biPlanes', wintypes.WORD), ('biBitCount', wintypes.WORD), ('biCompression', wintypes.DWORD),
                ('biSizeImage', wintypes.DWORD), ('biXPelsPerMeter', wintypes.LONG),
                ('biYPelsPerMeter', wintypes.LONG), ('biClrUsed', wintypes.DWORD),
                ('biClrImportant', wintypes.DWORD)]


def grab(hwnd):
    """PrintWindow + PW_RENDERFULLCONTENT：Chromium 的合成结果在 GPU 层，普通 BitBlt 只能抓到全黑。"""
    rect = wintypes.RECT()
    u.GetWindowRect(hwnd, ctypes.byref(rect))
    w, h = rect.right - rect.left, rect.bottom - rect.top
    hdc = u.GetWindowDC(hwnd)
    mem = g.CreateCompatibleDC(hdc)
    bmp = g.CreateCompatibleBitmap(hdc, w, h)
    g.SelectObject(mem, bmp)
    ok = u.PrintWindow(hwnd, mem, 2)
    info = BITMAPINFOHEADER()
    info.biSize = ctypes.sizeof(BITMAPINFOHEADER)
    info.biWidth, info.biHeight = w, -h
    info.biPlanes, info.biBitCount, info.biCompression = 1, 32, 0
    buf = ctypes.create_string_buffer(w * h * 4)
    lines = g.GetDIBits(mem, bmp, 0, h, buf, ctypes.byref(info), 0)
    g.DeleteObject(bmp)
    g.DeleteDC(mem)
    u.ReleaseDC(hwnd, hdc)
    if not ok or lines == 0:
        return None
    return Image.frombytes('RGBA', (w, h), buf.raw, 'raw', 'BGRA').convert('RGB')


hwnd = u.FindWindowW(None, args.title)
if not hwnd:
    print(f'找不到窗口「{args.title}」—— 用 tools/launch-desktop.cjs 起一个，或先用枚举窗口的脚本确认标题')
    sys.exit(2)

# ★ 先还原窗口。踩过：进程活着、`FindWindowW` 也找得到，但窗口停在**最小化**状态
#   （矩形是 159×27 这种典型值），`PrintWindow` 直接返回 0 ⇒ 看起来像"抓不到画面"。
#   本项目在干净 userData 下启动时就会是最小化的。
SW_RESTORE, SW_SHOW = 9, 5
if args.restore:
    if u.IsIconic(hwnd):
        print('窗口处于最小化 —— 先还原')
        u.ShowWindow(hwnd, SW_RESTORE)
    else:
        u.ShowWindow(hwnd, SW_SHOW)
    u.SetForegroundWindow(hwnd)
    time.sleep(0.6)

rect = wintypes.RECT()
u.GetWindowRect(hwnd, ctypes.byref(rect))
print(f'窗口「{args.title}」{(rect.right-rect.left)}×{(rect.bottom-rect.top)} @({rect.left},{rect.top})')
print(f'连拍 {args.frames} 帧 · 间隔 {args.interval}s · 共约 {args.frames * args.interval:.0f}s')

time.sleep(args.settle)
frames = []
paths = []
for i in range(args.frames):
    t0 = time.time()
    img = grab(hwnd)
    if img is None:
        print(f'f{i:02d}  PrintWindow 失败（窗口被最小化？）')
    else:
        p = os.path.join(OUT, f'f{i:02d}.png')
        img.save(p)
        frames.append(np.asarray(img, dtype=np.float32))
        paths.append(p)
        lum = frames[-1].mean()
        print(f'f{i:02d}  {img.size[0]}×{img.size[1]}  均亮度 {lum:.1f}')
    dt = args.interval - (time.time() - t0)
    if dt > 0 and i < args.frames - 1:
        time.sleep(dt)

if len(frames) < 4:
    print('有效帧太少，无法估计背景')
    sys.exit(3)

stack = np.stack(frames)                      # (N, H, W, 3)
median = np.median(stack, axis=0)             # 逐像素中位数 = 背景（动的都抹平，偶发的不参与）

# ── 挑帧的判据：**暖偏残差**，不是亮度残差 ──────────────────────────
# ⚠️ 用亮度残差找不准（试过，失败）。水面焦散本身是又亮又动的，
#    它的漂移在"亮度"上和光柱一个量级 —— 实测挑出来的前三帧是连号的，
#    形状是高宽比 0.18~0.96 的散斑，根本不是一条带。
#    换成 **ΔR − ΔB** 就干净了：光柱是暖色，实测带内 ΔR 是 ΔB 的 **2.6 倍**；
#    而焦散/水色是青绿的，漂移时 R 与 B 大致同增 ⇒ 在 R−B 上互相抵消。
#    大半径 BoxBlur 再把"光柱是大块缓变、焦散是小颗粒"这点差异放大。
BOX = 45
score = []
for i in range(len(frames)):
    res = stack[i].astype(np.float32) - median.astype(np.float32)
    warm = np.clip(res[:, :, 0] - res[:, :, 2], 0, None)     # 暖偏
    blurred = np.asarray(Image.fromarray(warm.astype(np.uint8)).filter(ImageFilter.BoxBlur(BOX)),
                         dtype=np.float32)
    # 抹掉四周 UI（标题栏 / 左上题字 / 底部工具条 / 右上天气卡）
    h, w = blurred.shape
    blurred[:int(h * 0.10), :] = 0
    blurred[int(h * 0.72):, :] = 0
    blurred[:, :int(w * 0.14)] = 0
    blurred[:, int(w * 0.86):] = 0
    # 大块均值才是"一条带"的证据；取 1/8 画面大小的方块，并直接报出它的位置
    bh, bw = h // 8, w // 8
    best, bx, by = 0.0, 0, 0
    for y0 in range(0, h - bh, bh // 2):
        for x0 in range(0, w - bw, bw // 2):
            v = float(blurred[y0:y0 + bh, x0:x0 + bw].mean())
            if v > best:
                best, bx, by = v, x0, y0
    score.append((best, i, bx, by))

score.sort(reverse=True)
print('\n暖偏残差排名（越大越可能有光柱；峰值块大小 = 1/8 画面）：')
for s, i, bx, by in score[:max(args.keep, 6)]:
    print(f'  第 {i:02d} 帧  暖偏峰 {s:6.2f}  位置 ({bx},{by})')

print(f'\n挑出前 {args.keep} 帧：')
for rank, (s, i, bx, by) in enumerate(score[:args.keep]):
    dst = os.path.join(APP, 'out', f'sun-top{rank + 1}.png')
    Image.open(paths[i]).save(dst)
    print(f'  sun-top{rank + 1}.png  ← 第 {i:02d} 帧（暖偏 {s:.2f}＠({bx},{by})）')
