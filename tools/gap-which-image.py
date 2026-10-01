# -*- coding: utf-8 -*-
"""① 判定「用户给的那张图」到底是哪张（与项目内设计稿/季节底图做对齐后逐点差）
   ② 裁出三张画面的「鱼群特写」并排，用于对比鱼的体量与形态。
"""
import os
from PIL import Image, ImageChops, ImageStat, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'out')
USER = r'C:\Users\Y\.workbuddy\clipboard-images\clipboard-2026-09-30T15-39-20-931Z-cc712d78.jpg'
REF = os.path.join(ROOT, 'docs', 'design-reference.png')


def prep(path, crop_taskbar=False, size=(544, 306)):
    im = Image.open(path).convert('RGB')
    if crop_taskbar:
        im = im.crop((0, 0, im.width, int(im.height * 0.955)))
    return im.resize(size, Image.LANCZOS)


def mad(a, b):
    d = ImageChops.difference(a, b)
    return sum(ImageStat.Stat(d).mean) / 3


user = prep(USER, True)
ref = prep(REF)
print('=== 对齐后逐点平均差（0=完全同图，>30 基本是两张不同画）===')
print(f'  用户图 vs 项目设计稿            : {mad(user, ref):6.1f}')
for name in ('autumn', 'spring', 'pond', 'winter'):
    p = os.path.join(ROOT, 'public', 'assets', f'{name}.png')
    if os.path.exists(p):
        print(f'  用户图 vs 季节底图 {name:7s}     : {mad(user, prep(p)):6.1f}')
print(f'  项目设计稿 vs 季节底图 autumn   : {mad(ref, prep(os.path.join(ROOT, "public", "assets", "autumn.png"))):6.1f}')

# ---- 鱼群特写：三张图各裁同一相对区域 ----
CROPS = [
    ('A 用户设计图', USER, True, (0.06, 0.16, 0.46, 0.60)),
    ('B 项目设计稿', REF, False, (0.06, 0.16, 0.46, 0.60)),
    ('C 当前实现(夏/沉浸)', os.path.join(OUT, 'compare-day-immersive.png'), False, (0.55, 0.28, 0.95, 0.72)),
]
CW, CH = 620, 380
font = None
for n in ('msyh.ttc', 'simhei.ttf'):
    p = os.path.join(r'C:\Windows\Fonts', n)
    if os.path.exists(p):
        font = ImageFont.truetype(p, 24)
        break

strip = Image.new('RGB', (16 + (CW + 16) * len(CROPS), 16 + CH + 46 + 16), (18, 22, 28))
d = ImageDraw.Draw(strip)
for i, (title, path, crop_tb, box) in enumerate(CROPS):
    im = Image.open(path).convert('RGB')
    if crop_tb:
        im = im.crop((0, 0, im.width, int(im.height * 0.955)))
    x0, y0, x1, y1 = (int(box[0] * im.width), int(box[1] * im.height),
                      int(box[2] * im.width), int(box[3] * im.height))
    tile = im.crop((x0, y0, x1, y1)).resize((CW, CH), Image.LANCZOS)
    x = 16 + i * (CW + 16)
    d.text((x + 4, 16), title, font=font, fill=(235, 240, 245))
    strip.paste(tile, (x, 46))
p = os.path.join(OUT, 'gap-fish-closeup.png')
strip.save(p)
print('\nsaved ->', p)
