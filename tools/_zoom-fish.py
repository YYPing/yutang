"""把截图里的「小鱼区」裁出来放大，肉眼核对是否成团。

用法：python tools/_zoom-fish.py <png> <x0> <y0> <x1> <y1> <scale> <out>
"""
import sys
from PIL import Image

src, x0, y0, x1, y1, scale, out = (
    sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4]),
    int(sys.argv[5]), float(sys.argv[6]), sys.argv[7],
)
img = Image.open(src).convert("RGB").crop((x0, y0, x1, y1))
img = img.resize((int(img.width * scale), int(img.height * scale)), Image.LANCZOS)
img.save(out)
print(f"{src} 裁 ({x0},{y0})-({x1},{y1}) ×{scale} → {out}  {img.size}")
