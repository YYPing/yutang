"""两帧位图的逐像素差分 —— 判断「画面到底动没动」。

为什么不能用聚合亮度（均亮度/标准差）判运动：
    聚合统计量对**局部**运动天然不敏感。锦鲤池满屏1725×1125，
    28 尾鱼 + 涟漪 + 雨纹加起来也改不动全画面均值 —— 实测两帧
    均亮度 46.8→46.8、标准差 19.5→19.5，Δ 恒为 0.00，看着像死了，
    其实鱼在游。必须落到逐像素。

⚠️⚠️ 报「0.00% 变化」时，先看打印出来的**采样点数**，别急着判应用挂了。
   本脚本按 1/4 降采样，1725×1125 正常应得到 431×281 = 121111 点。
   若打印的是几十×几十（实测踩到过 49×8=392），那说明**输入帧是废图** ——
   通常来自窗口最小化：Electron 最小化后客户区缩到 199×34，
   `grab-window.py` 照样成功返回，于是把 199×34 写进了 frame-a/b，
   两帧自然一模一样。
   ⇒ 这是**数据源坏了，不是量具坏了**。修法：恢复窗口后重新抓帧配对。
   通用教训：判据失效时，先确认「它拿到的是不是它以为的东西」。

用法：python tools/diff-frames.py a.png b.png [阈值通道差]
输出：stdout 一行 "3.71% 像素变化（阈值 >6，共 121111 采样点）"
"""
import sys
from PIL import Image

A = sys.argv[1] if len(sys.argv) > 1 else 'out/frame-a.png'
B = sys.argv[2] if len(sys.argv) > 2 else 'out/frame-b.png'
# 单通道差值超过这个数才算「变了」—— 6 灰阶足够滤掉雨丝抗锯齿的抖动，
# 又不会漏掉鱼体边缘（锦鲤白腹与深水对比远大于 6）。
TH = int(sys.argv[3]) if len(sys.argv) > 3 else 6

a = Image.open(A).convert('RGB')
b = Image.open(B).convert('RGB')
if a.size != b.size:
    print(f'尺寸不一致：{a.size} vs {b.size}')
    sys.exit(3)

# 缩小到 1/4 再比：锦鲤池的运动是低频的（鱼在游、雨在下），
# 全分辨率逐像素比对慢且没意义；1/4 尺寸下鱼仍是几十像素的块。
w, h = a.size
sw, sh = w // 4, h // 4
a2 = a.resize((sw, sh), Image.BILINEAR)
b2 = b.resize((sw, sh), Image.BILINEAR)
da, db = a2.tobytes(), b2.tobytes()

n = sw * sh
changed = 0
for i in range(0, len(da), 3):
    if (abs(da[i] - db[i]) > TH or
            abs(da[i + 1] - db[i + 1]) > TH or
            abs(da[i + 2] - db[i + 2]) > TH):
        changed += 1

pct = changed * 100.0 / n
print(f'{pct:.2f}% 像素变化（阈值 >{TH}，{sw}×{sh} = {n} 采样点，变了 {changed} 个）')
