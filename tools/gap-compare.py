# -*- coding: utf-8 -*-
"""把「用户设计图 / 项目设计稿 / 当前实现」并排成一张对照图，并给出可量化指标。

为什么需要它：肉眼看「像不像」会各说各话，所以除了拼图，还测三组客观量——
① 平均色（画面整体色调偏了多少）② 高频细节能量（Laplacian 方差，量化「焦散网清不清晰」）
③ 暖色像素占比（鱼体/秋叶在画面里占多少，量化「鱼多不多、显不显眼」）。
"""
import os
from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageStat

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'out')

PANELS = [
    ('A', '用户给的设计图', r'C:\Users\Y\.workbuddy\clipboard-images\clipboard-2026-09-30T15-39-20-931Z-cc712d78.jpg', True),
    ('B', '项目内设计稿 docs/design-reference.png', os.path.join(ROOT, 'docs', 'design-reference.png'), False),
    ('C', '当前实现 · 夏/白昼/沉浸', os.path.join(OUT, 'compare-day-immersive.png'), False),
    ('D', '当前实现 · 秋/白昼/带UI', os.path.join(OUT, 'season-autumn.png'), False),
]

W, H = 900, 506          # 每个面板的尺寸
PAD, LABEL_H = 16, 40


def cjk_font(size):
    for name in ('msyh.ttc', 'msyhl.ttc', 'simhei.ttf'):
        p = os.path.join(r'C:\Windows\Fonts', name)
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                pass
    return ImageFont.load_default()


def load(path, crop_taskbar):
    im = Image.open(path).convert('RGB')
    if crop_taskbar:                       # 用户那张是整屏截图，底部有 Windows 任务栏
        im = im.crop((0, 0, im.width, int(im.height * 0.955)))
    return im


def metrics(im):
    small = im.copy()
    lum = small.convert('L')
    lum_mean = ImageStat.Stat(lum).mean[0]        # ⚠️ 不能用上面那张 Laplacian 图去求亮度：
    #   Kernel 的 offset=128 会把直方图整体抬到 128 附近，读出来永远是「128.0」，看着很整齐但是假的。
    # Laplacian 方差：边缘/细节能量。焦散网越细密清晰，值越大。
    lap = lum.filter(ImageFilter.Kernel((3, 3), [0, 1, 0, 1, -4, 1, 0, 1, 0], scale=1, offset=128))
    h = lap.histogram()
    n = sum(h) or 1
    mean = sum(i * c for i, c in enumerate(h)) / n
    var = sum((i - mean) ** 2 * c for i, c in enumerate(h)) / n
    # 暖色占比：R 明显大于 B 的像素（鱼、秋叶、暖光）
    px = small.resize((256, 144)).load()
    warm = tot = 0
    for y in range(144):
        for x in range(256):
            r, g, b = px[x, y]
            tot += 1
            if r - b > 26 and r > 90:
                warm += 1
    rgb = ImageStat.Stat(small.resize((64, 36))).mean
    return dict(lum=lum_mean, detail=var ** 0.5, warm=warm / tot * 100, rgb=tuple(rgb))


def main():
    font = cjk_font(26)
    small = cjk_font(22)
    canvas = Image.new('RGB', (PAD + (W + PAD) * 2, PAD + (H + LABEL_H + PAD) * 2), (18, 22, 28))
    d = ImageDraw.Draw(canvas)
    stats = {}
    for idx, (tag, title, path, crop) in enumerate(PANELS):
        col, row = idx % 2, idx // 2
        x = PAD + col * (W + PAD)
        y = PAD + row * (H + LABEL_H + PAD)
        im = load(path, crop)
        m = metrics(im)
        stats[tag] = (title, im.size, m)
        d.text((x + 4, y + 6), f'{tag}  {title}  {im.width}x{im.height}', font=font, fill=(235, 240, 245))
        canvas.paste(im.resize((W, H), Image.LANCZOS), (x, y + LABEL_H))
        d.text((x + 4, y + LABEL_H + H + 4),
               f'均亮度 {m["lum"]:.0f} · 细节能量 {m["detail"]:.1f} · 暖色占比 {m["warm"]:.1f}%'
               f' · RGB({m["rgb"][0]:.0f},{m["rgb"][1]:.0f},{m["rgb"][2]:.0f})',
               font=small, fill=(168, 182, 196))
    out = os.path.join(OUT, 'gap-compare.png')
    canvas.save(out)
    print('saved ->', out)
    print()
    print(f'{"":4}{"画面":34}{"均亮度":>8}{"细节能量":>10}{"暖色占比":>10}{"平均RGB":>18}')
    for tag, (title, size, m) in stats.items():
        print(f'{tag:4}{title[:32]:34}{m["lum"]:>8.1f}{m["detail"]:>10.1f}{m["warm"]:>9.1f}%'
              f'{str(tuple(round(v) for v in m["rgb"])):>18}')


main()
