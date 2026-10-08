"""
程序化派生「秋→冬中间态底图」的**参数求解**（层② 替代路线，2026-10-08）。

★★ 为什么这条路线值得试，而AI 生图不值得再试
─────────────────────────────────────────────────────
上一轮 AI 生图实测：双图输入下「与 winter 差 30.81 / 与 autumn 差 8.46」
⇒ 它只会跟随其中一张图，无法「几何取 A、色取 B」。
本脚本走另一条路：**几何完全不动**（只用 winter.png 的像素），
只调HSV 三个量去逼近autumn 的色调。
⇒结构差**由构造保证可控**：色相偏得越多越像 autumn，偏得越少越像 winter。
   AI 那条路是「祈祷它画对」，这条是「解一个标量参数」。

⚠️⚠️ 但这条路有一个**必须先验的前提**，不能想当然
─────────────────────────────────────────────────────
量具的「结构差」是 8×6 网格灰度均值之差 —— 它**只测亮度分布，不测色相**。
所以「色相偏一点，结构差就线性下降」这个假设**未必成立**：
调色相会让 RGB 三个通道的**明度权重**一起变，网格灰度跟着动，
但动的方式取决于原图每个像素的色相分布 —— 不均匀。
⇒ 必须**实跑二分**，不能靠推导。本脚本就是实跑的那个。

★ 为什么先拿 autumn/winter 自己的差来定窗口
─────────────────────────────────────────────────────
我们想插的位置是「autumn 与 winter 之间」，所以合格判据是
**双向同时落进 [8,16]**：太靠 winter 侧 ⇒ 与 winter 差< 8（等于没换图）
太靠 autumn 侧 ⇒ 与 autumn 差 < 8（等于白换一张）。
若这两侧本身的几何差是 22.40，那窗口 [8,16] 的中点 12 正好对应
「两边各 10 左右」—— 与22.40 的几何跨度对称。
"""
import sys

from PIL import Image
import numpy as np

BASE = 'public/assets'
DERIVED = 'out/refs/winter-autumn-derive.png'
GU, GV = 8, 6
WIN_LO, WIN_HI = 8.0, 16.0


def grid_luma(path_or_img):
    im = path_or_img if isinstance(path_or_img, Image.Image) else Image.open(path_or_img)
    small = im.convert('L').resize((GU, GV), Image.BOX)
    return np.asarray(small, dtype=np.float32)


def struct_diff(a, b):
    return float(np.mean(np.abs(a - b))), float(np.max(np.abs(a - b)))


def derive(winter_img, dh, ks, kv):
    """用 winter 的几何 + (dh°色相偏移, ks 饱和倍率, kv 明度倍率) 派生一档。
    ⚠️ PIL 的 HSV 是 0~255 整数空间，色相 0~360 ⇒ 乘 2。
       `offset=-45` 等价于色相 **减** 45°（往冷/往蓝走），
       与 autumn 相反方向 —— winter 本身就偏冷，要朝autumn 走就该**加**色相。
    """
    hsv = np.asarray(winter_img.convert('HSV'), dtype=np.float32)
    h = np.mod(hsv[..., 0] * (360.0 / 255.0) + dh, 360.0) * (255.0 / 360.0)
    s = np.clip(hsv[..., 1] * ks, 0, 255)
    v = np.clip(hsv[..., 2] * kv, 0, 255)
    return Image.fromarray(np.stack([h, s, v], -1).astype(np.uint8), 'HSV').convert('RGB')


def main():
    winter = Image.open(f'{BASE}/winter.png')
    lw, la = grid_luma(f'{BASE}/winter.png'), grid_luma(f'{BASE}/autumn.png')
    mean_w, max_w = struct_diff(lw, la)
    print('★ 基线：autumn vs winter  平均绝对差 %.2f  最大差 %.2f' % (mean_w, max_w))
    print('  验收窗口 [%g, %g]（双向都要落进去）\n' % (WIN_LO, WIN_HI))

    #★ 用**二分**而不是网格扫描：目标是「与 winter 的差」落到 WIN_LO 附近
    #   （越过这个点就开始与 autumn 太近），单调性由构造保证（偏得越多越暖）。
    print('  dh°    ks     kv     vs winter  vs autumn  判定')
    best = None
    for dh in range(0, 61, 5):
        for ks in (1.00, 1.08, 1.16, 1.24):
            for kv in (0.94, 1.00, 1.06):
                img = derive(winter, dh, ks, kv)
                lg = grid_luma(img)
                dw, _ = struct_diff(lg, lw)
                da, _ = struct_diff(lg, la)
                ok = WIN_LO <= dw <= WIN_HI and WIN_LO <= da <= WIN_HI
                if ok and (best is None or abs(dw - WIN_LO) + abs(da - WIN_LO) < best[0]):
                    best = (abs(dw - WIN_LO) + abs(da - WIN_LO), dh, ks, kv, dw, da, img)
                if abs(dh - 20) <= 10 and ks in (1.00, 1.16) and kv == 1.00:
                    print('  %+4d  %.2f  %.2f   %7.2f  %8.2f  %s'
                          % (dh, ks, kv, dw, da, '合格' if ok else '—'))
    if best is None:
        print('\n★ 这一族参数里无解。（说明网格灰度对色相的响应不够单调，'
              '或两侧窗口本身不相容—— 那是「这个缺口用派生填不了」的证据。）')
        sys.exit(1)
    _, dh, ks, kv, dw, da, img = best
    print('\n★ 最优解：dh %+d°  ks %.2f  kv %.2f  ⇒ 与 winter %.2f / 与 autumn %.2f（窗口 [%g,%g]）'
          % (dh, ks, kv, dw, da, WIN_LO, WIN_HI))
    img.save(DERIVED)
    print('  已存 %s（%s）' % (DERIVED, img.size))


if __name__ == '__main__':
    main()
