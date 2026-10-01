# 分析 `tools/shot-sunlight-ab.cjs` 拍出来的 A/B 组，回答一个**观感问题**：
# 「这束光柱，在真实合成画面上到底看得见吗？」
#
# ── 判据的设计（每一步都有理由，不要简化掉）──────────────────────────
# ① **必须用噪声地板做分母**。A 与 A2 是"同一条件拍两次"，WebGL 焦散在动、UI 有微动，
#    它们之间的差就是这台量具的噪声。没有这个分母，"信号 3.7 luma"是多是少无从判断。
# ② **按光柱自己的几何分带内/带外**。带外应该≈0（甚至为负 —— 层 12 的暗带会压暗两侧）；
#    如果带外也很大，说明信号是"整屏变亮"，那不是光柱。
# ③ **分通道看**。光柱是暖色，R 的抬升应当明显大于 G/B。
#    只报 luma 会把"偏暖"误判成"没效果" —— 人眼对色相远比对亮度敏感。
# ④ **报分位数，不报均值**。光柱是软边大渐变，均值被边缘稀释；P90/P99 才是"核心有多亮"。
#
# 用法：python tools/analyze-sunlight-ab.py [--u 0.42] [--tilt 0.42] [--shot 5]
import argparse
import os
import sys

import numpy as np
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(os.path.dirname(HERE), 'out')

ap = argparse.ArgumentParser()
ap.add_argument('--u', type=float, default=0.42, help='光柱横向落点（与拍照脚本一致）')
ap.add_argument('--tilt', type=float, default=0.42)
ap.add_argument('--width', type=float, default=0.3, help='LIGHT.shaftWidth')
ap.add_argument('--shot', type=float, default=5.0, help='差分图的放大倍数')
ap.add_argument('--crop', default='600,1140,60,780', help='三联图裁剪 x0,x1,y0,y1')
args = ap.parse_args()

LUM = np.array([0.299, 0.587, 0.114], dtype=np.float32)


def load(name):
    p = os.path.join(OUT, f'sun-ab-{name}.png')
    if not os.path.exists(p):
        print(f'缺文件 {p} —— 先跑 node tools/shot-sunlight-ab.cjs')
        sys.exit(2)
    return np.asarray(Image.open(p).convert('RGB'), dtype=np.float32)


def luma(x):
    return (x * LUM).sum(axis=-1)


A, A2, B = load('A'), load('A2'), load('B')
base = (A + A2) / 2
noise = np.abs(luma(A) - luma(A2))
sig = luma(B) - luma(base)
H, W = A.shape[:2]

hw = args.width * 0.5 * min(W, H)
yy = np.arange(H)[:, None]
axis = args.u * W + np.tan(args.tilt) * (yy + 0.12 * H)
band = np.abs(np.arange(W)[None, :] - axis) < hw

# 四周是 UI（标题栏 / 左上题字 / 底部工具条 / 右上天气卡），不参与统计
ui = np.zeros((H, W), bool)
ui[:int(H * 0.135), :200] = True
ui[-int(H * 0.22):, :] = True
ui[:int(H * 0.115), int(W * 0.74):] = True
m, o = band & ~ui, ~band & ~ui

print(f'画布 {W}×{H}　带内 {m.sum()} px（占画面 {m.mean()*100:.1f}%）　半宽 {hw:.0f}px')
print()
print('                     R        G        B      luma    （带内逐通道净变化）')
d = (B - base)[m].mean(axis=0)
print('  光柱信号 Δ   %8.3f %8.3f %8.3f %8.3f' % (d[0], d[1], d[2], sig[m].mean()))
dn = (A - A2)[m].mean(axis=0)
print('  噪声地板 Δ   %8.3f %8.3f %8.3f %8.3f' % (abs(dn[0]), abs(dn[1]), abs(dn[2]), noise[m].mean()))
print()
print('           带内      带外')
print('  噪声    %6.3f    %6.3f' % (noise[m].mean(), noise[o].mean()))
print('  信号    %6.3f    %6.3f   ← 带外应≈0（负值 = 层 12 暗带在压暗两侧）'
      % (sig[m].mean(), sig[o].mean()))
snr = sig[m].mean() / max(noise[m].mean(), 1e-6)
print('  信噪比  %6.1f×   （带外 %.2f×，应≈1）' % (snr, sig[o].mean() / max(noise[o].mean(), 1e-6)))
print('  信号 >2 luma 的像素占比：带内 %.1f%%　带外 %.2f%%'
      % ((sig[m] > 2).mean() * 100, (sig[o] > 2).mean() * 100))
print()
p50, p90, p99 = (float(np.percentile(sig[m], q)) for q in (50, 90, 99))
print('  带内信号分位：P50 %.2f　P90 %.2f　P99 %.2f　峰值 %.2f'
      % (p50, p90, p99, float(sig[m].max())))
print('  暖偏比 R/G = %.2f　R/B = %.2f（>1.5 才算"暖色光"而不是"整体提亮"）'
      % (d[0] / max(abs(d[1]), 1e-6), d[0] / max(abs(d[2]), 1e-6)))

# ── 三联图：无柱 / 有柱 / 差分放大
x0, x1, y0, y1 = (int(v) for v in args.crop.split(','))
diff = np.clip((B - base) * args.shot, 0, 255).astype(np.uint8)
panels = [('无光柱 (A+A2)/2', base[y0:y1, x0:x1]), ('有光柱 (B)', B[y0:y1, x0:x1]),
          (f'差分 ×{args.shot:g}', diff[y0:y1, x0:x1].astype(np.float32))]
pw, ph = x1 - x0, y1 - y0
sheet = Image.new('RGB', (pw * 3 + 16, ph + 30), (16, 16, 16))
dr = ImageDraw.Draw(sheet)
for k, (t, p) in enumerate(panels):
    sheet.paste(Image.fromarray(p.astype(np.uint8)), (k * (pw + 8), 30))
    dr.text((k * (pw + 8) + 8, 9), t, fill=(255, 220, 130))
dst = os.path.join(OUT, '_sun-ab-compare.png')
sheet.save(dst)
print(f'\n三联图 → {dst}')
