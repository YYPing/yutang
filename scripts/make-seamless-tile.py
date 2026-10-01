#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
把「不无缝」的瓦片做成真无缝瓦片（half-offset 融合法）。

为什么需要：scene/pond_bottom-9vD2ISIF.png 实测是「1024 瓦片 × 2×2」的预览图，
且缝是断的 —— 内部竖缝 22.03 / 横缝 59.05，外环绕缝 24.09 / 67.42，
而正常相邻像素差只有 8~14。直接平铺必然出现横向条带。

原理（业界标准做法，Photoshop「位移+仿制图章」的自动化版本）：
    取原图 T，再取它自身**平移半幅并环绕**的副本 B（此时 B 的四条边落在 T 的内部，必然连续）。
    S = M·T + (1−M)·B，其中 M 是中心 1、四边 0 的平滑窗。
  · 在四条边上 M=0 ⇒ S 取 B ⇒ 连续（无缝）✓
  · 在中心 M=1 ⇒ S 取 T ⇒ 保留原图细节（不糊）✓

★ 窗形选择（实测，别想当然）—— 两种窗各有各的漏，不可能同时消掉：
    prod（M = wx·wy，乘积窗）
        环绕缝完美 7.11/8.11（≈自然起伏）；但 M 只在中心**点**为 1，
        B 的缝落在中心**十字线**上 ⇒ 整条线泄漏，实测中心行漏 65.19。
    max （M = max(wx,wy)）
        中心十字线完美 8.12/7.03；但边中点处 M = max(0, wy) = 1 ⇒ 漏用 T 的边界
        ⇒ 环绕缝漏 14.66/36.00。
  结论：单次半幅偏移无法做到「处处无缝」（T 坏在边界、B 坏在中心线，两者交叠处无解）。
  取舍办法见 koi-pond/README.md「池底贴图」一节：
    · 平铺(tile)用 prod —— 环绕必须无缝；
    · 裁切铺满(cover)用 max + 避开中心行的取景 —— 内部必须无缝，边界不进画面。

输出 1024² 无缝瓦片，可直接用 CanvasPattern('repeat') 平铺。

用法: python tools/make-seamless.py [源图] [输出] [--tile 1024] [--window max|prod] [--band 0.5]
"""
import sys, os
import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)


def smoothstep(t):
    t = np.clip(t, 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def seam_metric(a, b):
    return float(np.abs(a.astype(np.float32) - b.astype(np.float32)).mean())


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'scene', 'pond_bottom-9vD2ISIF.png')
    dst = sys.argv[2] if len(sys.argv) > 2 else os.path.join(ROOT, 'scene', 'pond_tile_seamless.png')
    tile = 1024
    if '--tile' in sys.argv:
        tile = int(sys.argv[sys.argv.index('--tile') + 1])
    win = 'prod'
    if '--window' in sys.argv:
        win = sys.argv[sys.argv.index('--window') + 1]
    band = 0.5
    if '--band' in sys.argv:
        band = float(sys.argv[sys.argv.index('--band') + 1])

    im = Image.open(src).convert('RGB')
    n = tile
    T = np.asarray(im).astype(np.float32)[:n, :n]          # 取左上单块瓦片

    # B = T 平移半幅并环绕
    h = n // 2
    B = np.roll(np.roll(T, -h, axis=0), -h, axis=1)

    # 一维窗 w：0 在两端、1 在中间；band 控制升到 1 的位置
    idx = np.arange(n, dtype=np.float32) / (n - 1.0)
    w = smoothstep(idx / band) * smoothstep((1.0 - idx) / band)
    M = (w[None, :] * w[:, None]) if win == 'prod' else np.maximum(w[None, :], w[:, None])
    M3 = M[:, :, None]

    S = np.clip(M3 * T + (1.0 - M3) * B, 0, 255).astype(np.uint8)

    # 输出前与输入前各自量一遍缝（含中心十字线，两处都要看）
    ref_v = seam_metric(T[:, 1:-1], T[:, :-2])
    ref_h = seam_metric(T[1:-1, :], T[:-2, :])
    def line_report(name, A):
        return ('%s 环绕竖 %.2f 环绕横 %.2f | 中心列(512) %.2f 中心行(512) %.2f'
                % (name, seam_metric(A[:, -1], A[:, 0]), seam_metric(A[-1, :], A[0, :]),
                   seam_metric(A[:, n // 2], A[:, n // 2 - 1]),
                   seam_metric(A[n // 2, :], A[n // 2 - 1, :])))
    print('局部参照（正常相邻像素差） 竖 %.2f / 横 %.2f' % (ref_v, ref_h))
    print(line_report('输入瓦片', T))
    print(line_report('输出瓦片', S) + '   ← window=%s band=%.2f' % (win, band))

    Image.fromarray(S).save(dst, optimize=True)
    print('已写出', dst, '尺寸', S.shape[1], 'x', S.shape[0])


if __name__ == '__main__':
    main()
