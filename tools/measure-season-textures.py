"""
量 4 张季节底图的差异 —— 决定「参数化底图」路线能不能成立。

★ 要回答的核心问题：**4 张底图的构图是同一张画，还是四张不同的画？**
  · 若是同一张画（只是整体色调不同）⇒ 参数化成立：1 张底图 + 24 档参数就够
  · 若构图不同（石组位置/水草分布都不一样）⇒ 参数化不够，得补中间档底图

输出三组数字：
  ① 亮度直方图差异（构图差异的粗指标）
  ② **结构差异**：把每张图按 u/v 分成 8×6 网格，逐格比灰度 —— 结构差异远小于
     色调差异就说明是同一张画
  ③ 主色相：每张图的 HSV 直方图峰值（确认季节色是否已到位）
"""
import os
from PIL import Image
import colorsys

BASE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                    'public', 'assets')
SEASONS = ['spring', 'pond', 'autumn', 'winter']   # pond = 夏
GRID_U, GRID_V = 8, 6
# 池心 ROI（与 landscape.js cacheWaterMask 口径一致：u .35-.65 / v .40-.62）
ROI = (0.35, 0.65, 0.40, 0.62)

def grid_luma(im, gu, gv):
    """把图切成 gu×gv 网格，返回每格的平均灰度"""
    w, h = im.size
    small = im.convert('L').resize((gu, gv), Image.BOX)
    px = list(small.getdata())
    return px

def pool_rgb(im):
    w, h = im.size
    box = (int(w * ROI[0]), int(h * ROI[2]), int(w * ROI[1]), int(h * ROI[3]))
    crop = im.convert('RGB').crop(box)
    px = list(crop.getdata())
    n = len(px)
    return (sum(p[0] for p in px) / n, sum(p[1] for p in px) / n, sum(p[2] for p in px) / n)

print('=' * 74)
print('① 池心主色 + 全图平均亮度')
print('=' * 74)
imgs = {}
for s in SEASONS:
    p = os.path.join(BASE, f'{s}.png')
    im = Image.open(p)
    imgs[s] = im
    r, g, b = pool_rgb(im)
    h_, s_, v_ = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
    small = im.convert('L').resize((64, 36), Image.BOX)
    luma = sum(small.getdata()) / (64 * 36)
    print(f'  {s:7s} {im.size[0]}x{im.size[1]}  池心 RGB({r:5.1f},{g:5.1f},{b:5.1f})'
          f'  H={h_*360:5.1f}° S={s_*100:4.1f}%  全图均亮 {luma:5.1f}')

print()
print('=' * 74)
print(f'② 结构差异：{GRID_U}×{GRID_V} 网格灰度逐格比（判「同一张画」的依据）')
print('=' * 74)
grids = {s: grid_luma(imgs[s], GRID_U, GRID_V) for s in SEASONS}

hdr1 = '比对'
hdr2 = '平均绝对差'
hdr3 = '最大差'
print('  ' + hdr1.ljust(20) + hdr2.rjust(12) + hdr3.rjust(10) + '   判读')
print('  ' + '-' * 62)
pairs = [('spring', 'pond'), ('pond', 'autumn'), ('autumn', 'winter'), ('spring', 'winter')]
for a, b in pairs:
    ga, gb = grids[a], grids[b]
    d = [abs(x - y) for x, y in zip(ga, gb)]
    mean_d = sum(d) / len(d)
    mx = max(d)
    tag = '同构图' if mean_d < 8 else ('大体同构图' if mean_d < 16 else '构图不同')
    print(f'  {a + " vs " + b:22s}{mean_d:10.2f}{mx:10.2f}   {tag}')

# 关键判据：结构差异 vs 色调差异
print()
print('★ 判读：若「平均绝对差」远小于「两季节的池心亮度/色相差」，')
print('  ⇒ 4 张是**同一张画**套了不同色 ⇒参数化成立（1 底图 + 24 档参数）')

print()
print('=' * 74)
print('③ 池心亮度跨季节跨度（量化「季节感」有多少来自贴图本身）')
print('=' * 74)
pool_l = []
for s in SEASONS:
    r, g, b = pool_rgb(imgs[s])
    pool_l.append(0.299 * r + 0.587 * g + 0.114 * b)
    print(f'  {s:7s} 池心亮度 {pool_l[-1]:5.1f}')
print(f'  ⇒ 跨季跨度 {max(pool_l) - min(pool_l):.1f}（0-255）')
print('  参考：HSV 管线里 dh 是色相旋转度、kv 是亮度比 —— 若跨度小，')
print('        说明季节感主要靠 shader 参数而非底图差异 ⇒ 参数化更划算')
