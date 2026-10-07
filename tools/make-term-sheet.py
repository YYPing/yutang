"""把 24 档整页截图拼成一张总览图（6×4 网格 + 节气标注）。

为什么要有这一步：
  24 张散图看「差异」很费力，而用户的核心诉求是「24 个节气各是什么样子」。
  拼成一张才能一眼比对 —— 尤其是**相邻档**（如小满→芒种），
  单看两张看不出差别，排在同一行就一眼可见。

★ 格间不留缝、不加边框：24 格全用同一尺寸硬拼。
  试过留 6px 缝，视觉上会误读成「24 个独立的小图」而不是「一张连续的表」，
  且拼缝处的岸边景物会被看成画面内容。

用法：python make-term-sheet.py
"""
import json
import os
import sys

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'out', 'terms-page')
DST = os.path.join(SRC, '_sheet.png')

COLS, ROWS = 6, 4
#每格缩到 460 宽：24 格拼出 2760×(276*4)=2760×1104，1:1 打开能看清 HUD 文字。
CELL_W = 460

TERMS = ['春分', '清明', '谷雨', '立夏', '小满', '芒种', '夏至', '小暑', '大暑',
         '立秋', '处暑', '白露', '秋分', '寒露', '霜降', '立冬', '小雪', '大雪', '冬至', '小寒', '大寒',
         '立春', '雨水', '惊蛰']
SEASON = ['春'] * 6 + ['夏'] * 6 + ['秋'] * 6 + ['冬'] * 6 + ['春'] * 6

# ★ 必须显式给中文字体。PIL 的默认位图字体只有 Latin-1，
#   draw.text 遇到中文会**静默画成空心方框**（不报错、图照样出）——
#   第一版拼出来的总览图每格标注都是「□□」，而脚本 exit 0。
#   这与「判据自己假绿」同型：产出物存在 ≠ 产出物对。
FONT_CANDIDATES = [
    r'C:\Windows\Fonts\msyh.ttc',   # 微软雅黑
    r'C:\Windows\Fonts\simhei.ttf',  # 黑体
    r'C:\Windows\Fonts\simsun.ttc',  # 宋体
]


def load_font(size):
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    # 找不到字体就直接失败，不要退回默认字体 —— 默认字体只会画出方框，
    # 那样等于交付一张「看起来完成但每个字都是□」的图。
    sys.exit(f'✘ 找不到中文字体，试过：{FONT_CANDIDATES}')


def main():
    index = json.load(open(os.path.join(SRC, '_index.json'), encoding='utf-8'))
    by_term = {r['term']: r for r in index}

    missing = [t for t in TERMS if t not in by_term]
    if missing:
        # 不用「缺了就跳过」——拼一张缺格的表比报错更坏，它看起来是完整的。
        sys.exit(f'✘ 缺少 {len(missing)} 档截图：{missing}（先跑 tools/shot-terms-page.cjs）')

    first = Image.open(by_term[TERMS[0]]['file'])
    ratio = first.height / first.width
    cell_h = round(CELL_W * ratio)
    bar_h = 26# 每格顶部的节气标注条
    font = load_font(15)
    sheet = Image.new('RGB', (COLS * CELL_W, ROWS * (cell_h + bar_h)), (14, 18, 20))
    draw = ImageDraw.Draw(sheet)

    for i, term in enumerate(TERMS):
        row, col = divmod(i, COLS)
        x, y = col * CELL_W, row * (cell_h + bar_h)
        img = Image.open(by_term[term]['file']).convert('RGB').resize((CELL_W, cell_h), Image.LANCZOS)
        # 标注条：季节 + 节气 + 槽位（槽位同名时看不出差别，所以显式写出来）
        slot = by_term[term].get('slot', '?')
        draw.rectangle([x, y, x + CELL_W, y + bar_h], fill=(22, 28, 30))
        draw.text((x + 8, y + 6), f'{SEASON[i]}·{term}   [{slot}]', fill=(226, 232, 230), font=font)
        sheet.paste(img, (x, y + bar_h))

    sheet.save(DST)
    print(f'✔ 总览图：{DST}')
    print(f'  {COLS}×{ROWS} 格，每格 {CELL_W}×{cell_h}，共 {sheet.width}×{sheet.height}')


if __name__ == '__main__':
    main()