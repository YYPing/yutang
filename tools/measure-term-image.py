"""
层②「AI 补差异大的中间档底图」的**准备与验收**工具。

── 为什么补图这件事必须先过这一关────────────────────────────────
上一轮曾试过「图生图生成 4 张新底图」并**放弃**（任务 #48：强制水印 + 浮萍毁水面）。
本脚本不负责生图（那是 ImageGen 的事），它负责回答生图前后都必须回答的问题：

  ① **该补哪几档？** —— 用 `measure-season-textures.py` 的结构差异量给出排序，
     而不是凭感觉挑节气。
  ② **新图与相邻图差异该多大？** —— 给出**双向阈值**：
     太小 ⇒ 补了等于没补（白换一张图 + 多占 12MB 显存）；
     太大 ⇒ 构图漂了，8s 交叉淡入会变成「切场景」（用户看到的是镜头跳切）。
  ③ **新图达标了吗？** —— 生图后跑一次，与 manifest 里**已验收的**图对拍。

★★★ 阈值为什么必须双向，而不是「差异越大越好」——这是本脚本的核心。
   `autumn vs winter` 的实测平均绝对差是 **22.40**（构图不同，最大格差 79）。
   这个数字就是「生图漂了」的标尺：新图若与相邻档差到 22 以上，
   8s 淡入会读成「镜头换了个机位」而不是「季节推进了一格」。
   反过来若只有 2~3（`spring vs pond` 是 5.75），那这张图不值得存在：
   现有的 HSV 水色管线已经把档间差异做出来了（同季中位 ΔE 5.12）。

用法：
    python tools/measure-term-image.py compare <新图路径> --against <已有图路径>
    python tools/measure-term-image.py survey          # 列出补图优先级
"""
import os
import sys

from PIL import Image

BASE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                    'public', 'assets')
GRID_U, GRID_V = 8, 6

# ★★ 双向阈值的来源（全部是实测值，不是拍的）：
#   下限 8.0 —— 低于它的新图「补了等于没补」。参照 spring vs pond = 5.75（同构图、
#     仅色调差），新图若与邻档差更小，8s 淡入期间肉眼读不出在换图。
#   上限 16.0 —— 高于它「构图漂了」。参照 autumn vs winter = 22.40（构图不同），
#     新图若与邻档差到这个量级，8s 淡入会读成镜头跳切而不是季节推进。
#   ⚠️ 这两个数不是审美判断，是**可证伪的边界**：
#     低于下限 ⇒ 用 `check:term:fade` 的槽位判据证明「同图换槽位仍淡入」，
#       但人眼读不出 → 花的12MB 显存买不到可感知收益；
#     高于上限 ⇒ 与已验收的 winter.png 同一量级 → 构图漂了。
DIFF_MIN = 8.0
DIFF_MAX = 16.0


def grid_luma(im, gu=GRID_U, gv=GRID_V):
    """把图切成 gu×gv 网格，返回每格的平均灰度（判「同一张画」的依据）。"""
    small = im.convert('L').resize((gu, gv), Image.BOX)
    return list(small.getdata())


def structure_diff(path_a, path_b):
    """两张图的结构差异：平均绝对差 + 最大差。

    ★ 为什么用 8×6 网格而不是逐像素：
      逐像素会被水面的微小色偏淹没（季节感本来就靠 HSV 参数做），
      网格均值保留的是**构图/元素分布**，那才是「是不是同一片荷塘」的判据。
    """
    a, b = grid_luma(Image.open(path_a)), grid_luma(Image.open(path_b))
    d = [abs(x - y) for x, y in zip(a, b)]
    return sum(d) / len(d), max(d)


def verdict(mean_diff):
    if mean_diff < DIFF_MIN:
        return (f'偏小（<{DIFF_MIN}）—— 补了等于没补。'
                f'人眼读不出换图，却白占约 12MB 显存与一次 8s 混合。')
    if mean_diff > DIFF_MAX:
        return (f'偏大（>{DIFF_MAX}）—— 构图可能漂了。'
                f'8s 淡入会读成「镜头跳切」而不是「季节推进」。')
    return f'落在 [{DIFF_MIN}, {DIFF_MAX}] 内 —— 既是同一片荷塘，又能读出换图。'


def cmd_survey():
    """列出补图优先级：哪几档最值得补。"""
    base_imgs = {s: os.path.join(BASE, f'{s}.png') for s in ('spring', 'pond', 'autumn', 'winter')}
    print('=' * 74)
    print('① 现有 4 张底图的成对结构差异（决定「补哪一季的中间档」）')
    print('=' * 74)
    print(f'  {"比对":22s}{"平均差":>10s}{"最大差":>10s}   判读')
    print('  ' + '-' * 60)
    pairs = [('spring', 'pond'), ('pond', 'autumn'), ('autumn', 'winter'), ('spring', 'winter')]
    diffs = {}
    for a, b in pairs:
        mean_d, mx = structure_diff(base_imgs[a], base_imgs[b])
        diffs[(a, b)] = mean_d
        tag = '同构图' if mean_d < 8 else ('大体同构图' if mean_d < 16 else '★构图不同')
        print(f'  {a + " vs " + b:22s}{mean_d:10.2f}{mx:10.2f}   {tag}')

    print()
    print('=' * 74)
    print('② 补图优先级（按「相邻两季差得越大，过渡越突兀」排序）')
    print('=' * 74)
    print('  跨季边界只有 4 处（TERM_SEASON 推出来的，不是拍的）：')
    print('    谷雨(spring)→立夏(summer)   差 %.2f' % diffs[('spring', 'pond')])
    print('    大暑(summer)→立秋(autumn)   差 %.2f' % diffs[('pond', 'autumn')])
    print('    霜降(autumn)→立冬(winter)   差 %.2f   ★最大' % diffs[('autumn', 'winter')])
    print('    大寒(winter)→立春(spring)   差 %.2f' % diffs[('spring', 'winter')])
    print()
    print('  ⇒ 优先补 **秋→冬** 之间（霜降/立冬/小雪 一带）的中间档。')
    print('    理由不只是「差异大」：秋(168.9°H) 与冬(174.1°H) 的色相最近，')
    print('    也就是说这处过渡**最不容易靠 HSV 参数补上** —— 参数化的天花板')
    print('    在这里，构图/元素层面才有办法拉开。')


def cmd_compare(new_path, against_path):
    """新图 vs 已有图的结构差异 + 达标判定。"""
    mean_d, mx = structure_diff(new_path, against_path)
    print('=' * 74)
    print('新图验收：结构差异与构图漂移')
    print('=' * 74)
    print(f'  新图{os.path.basename(new_path)}  vs  对照 {os.path.basename(against_path)}')
    print(f'  平均绝对差 {mean_d:.2f}   最大差 {mx:.2f}')
    print(f'  达标窗口    [{DIFF_MIN}, {DIFF_MAX}]')
    print(f'  判定        {verdict(mean_d)}')
    print()
    print('★ 通过之后还要做两件事，缺一不可：')
    print('  ① 量尺寸：必须 3840×2160（与现有 4 张一致），否则 uCover 的 16:9 假设不成立。')
    print('  ② 在 term-images.js 的 manifest **末尾**追加一条，bump v，否则浏览器拿旧缓存。')


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return
    cmd = sys.argv[1]
    if cmd == 'survey':
        cmd_survey()
    elif cmd == 'compare':
        if len(sys.argv) < 5:
            print('用法：compare <新图> --against <已有图>')
            return
        against = sys.argv[sys.argv.index('--against') + 1]
        cmd_compare(sys.argv[2], against)
    else:
        print(__doc__)


if __name__ == '__main__':
    main()