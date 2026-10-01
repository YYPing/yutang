# -*- coding: utf-8 -*-
"""用户那张图的底到底是哪来的？对每张候选底图做「尺度+平移」粗配准，取最小逐点差。
若某张图存在明显更小的最小值，说明用户图就是它（的某个裁切/缩放版本）。"""
import os
from PIL import Image, ImageChops, ImageStat

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
USER = r'C:\Users\Y\.workbuddy\clipboard-images\clipboard-2026-09-30T15-39-20-931Z-cc712d78.jpg'

u = Image.open(USER).convert('RGB')
u = u.crop((0, 0, u.width, int(u.height * 0.955)))
UA = u.width / u.height
# 把用户图缩到宽 240 作为探针
UW = 240
u_small = u.resize((UW, int(UW / UA)), Image.LANCZOS)

CANDS = [('docs/design-reference.png', os.path.join(ROOT, 'docs', 'design-reference.png'))]
for n in ('pond', 'spring', 'autumn', 'winter'):
    CANDS.append((f'public/assets/{n}.png', os.path.join(ROOT, 'public', 'assets', f'{n}.png')))

print(f'用户图（裁任务栏后）{u.width}x{u.height}  宽高比 {UA:.3f}\n')
print(f'{"候选":32}{"原尺寸":>14}{"最小逐点差":>12}{"最佳缩放":>10}')
print('-' * 70)
for name, path in CANDS:
    im = Image.open(path).convert('RGB')
    best = (1e9, 0)
    for s in [x / 100 for x in range(60, 221, 5)]:          # 缩放 0.60~2.20
        w = int(im.width * s)
        h = int(im.height * s)
        if w < UW or h < u_small.height:
            # 需要放大才能覆盖，允许先放大
            pass
        # 以「与用户图同宽高比的裁切窗口」在候选图上滑动
        cw, ch = min(w, int(h * UA)), min(h, int(w / UA))
        if cw < 32 or ch < 32:
            continue
        sc = im.resize((w, h), Image.LANCZOS)
        step = max(12, cw // 8)
        for oy in range(0, max(1, h - ch) + 1, step):
            for ox in range(0, max(1, w - cw) + 1, step):
                tile = sc.crop((ox, oy, ox + cw, oy + ch)).resize(u_small.size, Image.LANCZOS)
                d = sum(ImageStat.Stat(ImageChops.difference(tile, u_small)).mean) / 3
                if d < best[0]:
                    best = (d, s)
    print(f'{name:32}{im.size[0]}x{im.size[1]:<8}{best[0]:>12.1f}{best[1]:>10.2f}')

print('\n判读：最小逐点差若显著低于其它候选（一般 <25 才算「同一张画」），说明用户图即该底图。')
