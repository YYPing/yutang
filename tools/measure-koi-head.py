"""从**纯轮廓图**（黑鱼白底，只 fill(bodyPath)，无眼睛/花纹/鳞片）里量吻部剖面。

⚠️⚠️ 为什么要单独拍一张"纯轮廓"（这是本脚本存在的前提，踩过才知道）：
   起初我拍的是带标注的图（白线 bodyPath + 红脊线 + 青剖面线 + 黄采样点），
   量具按亮度取轮廓 ⇒ 黄点(≈213)、青线(≈193)、白线(≈236) 全部超过阈值
   ⇒ 量到的是"最亮的那个"，不是 bodyPath。
   结果改前改后读数**一模一样（Δ 全 0）**，而同时 diff 显示吻部有 191px 差异。
   **尺子坏了，不是东西没改。** 教训：量具的输入必须先验成"只有被测物"。

判据（尖吻 vs 钝吻）：
  · 末 1% 宽度保持率 `keep1 = W(1%) / W(0%)`
      尖吻：宽度在最后 1% 塌向 0 ⇒ keep1 ≈ 0
      钝吻：宽度停在一个有限值上 ⇒ keep1 ≈ 0.9+
  · 末段收口斜率 `slope1 = (W(0) − W(1%)) / 0.01`
      原式在这个区间的斜率是 −21 px/u 量级（陡降 ⇒ 尖），钝吻应显著变小。

用法：
  python tools/measure-koi-head.py out/koi-head-silhouette-before.png \
                                  out/koi-head-silhouette-after.png --tag=吻部改钝
"""

import sys
import numpy as np
from PIL import Image


def profile(path):
    """返回 (半宽数组, 峰值)。数组从**吻端**(右) 排到**尾端**(左)。"""
    lum = np.asarray(Image.open(path).convert("RGB"), dtype=np.float64) @ np.array(
        [0.299, 0.587, 0.114])
    # 白底黑鱼 ⇒ 鱼体是暗的。阈值取"比背景暗 60 以上"。
    bg = np.median(lum[0:12, 0:12])
    fish = lum < (bg - 60)
    cols = np.where(fish.any(axis=0))[0]
    if not len(cols):
        raise SystemExit(f"{path}: 没取到鱼身（阈值不匹配，背景亮度 {bg:.0f}）")

    half = []
    for x in range(cols.min(), cols.max() + 1):
        ys = np.where(fish[:, x])[0]
        half.append(np.nan if ys.size == 0 else (ys.max() - ys.min()) / 2.0)
    half = np.asarray(half, dtype=np.float64)
    # 丢掉尾部可能残留的 1 列噪点
    half = half[~np.isnan(half)]
    if half.size < 8:
        raise SystemExit(f"{path}: 轮廓只取到 {half.size} 列，取图失败")
    return half[::-1], float(np.nanmax(half))   # 反转 ⇒ index 0 = 吻端


def report(path, label):
    h, peak = profile(path)
    n = h.size
    print(f"\n=== {label} · {path.rsplit('/', 1)[-1]} ===")
    print(f"轮廓 {n} 列　体半宽峰值 {peak:.2f}px（设备像素，×2 ⇒ 逻辑 {peak/2:.2f}px）"
          f"　全长 {n/2:.0f}px")

    def at(f):
        return h[min(int(f * (n - 1)), n - 1)] / max(peak, 1e-9)

    print("\n  距吻端     半宽     占峰值")
    for f, nm in [(0.0, "吻端 0%"), (0.005, "0.5%"), (0.01, "1%"), (0.02, "2%"),
                  (0.04, "4%"), (0.08, "8%"), (0.12, "12%"), (0.20, "20%")]:
        print(f"  {f*100:5.1f}%   {at(f)*peak:7.2f}px  {at(f)*100:6.1f}%  {nm}")

    keep1, keep2 = at(0.01) / max(at(0.0), 1e-9), at(0.02) / max(at(0.0), 1e-9)
    slope1 = (h[0] - h[int(0.01 * (n - 1))]) / 0.01
    slope2 = (h[0] - h[int(0.02 * (n - 1))]) / 0.02
    print(f"\n  ★ 末1% 宽度保持率 {keep1*100:5.1f}%   （尖吻 ≈ 0%，钝吻 ≈ 90%+）")
    print(f"    末2% 宽度保持率 {keep2*100:5.1f}%")
    print(f"    末1% 收口斜率   {slope1:7.2f} px/u")
    print(f"    末2% 收口斜率   {slope2:7.2f} px/u")
    v = "钝吻 ✓" if keep1 > 0.85 else ("偏钝" if keep1 > 0.6 else "仍偏尖 ✗")
    print(f"    ⇒ 判定：{v}")
    return dict(nose=at(0.0), keep1=keep1, keep2=keep2, slope1=slope1, slope2=slope2,
                at01=at(0.01), at02=at(0.02), at04=at(0.04), at08=at(0.08), at12=at(0.12))


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    tag = next((a.split("=", 1)[1] for a in sys.argv[1:] if a.startswith("--tag=")), "吻部轮廓")
    rs = [report(p, tag if len(args) == 1 else f"{tag} · {chr(65+i)}") for i, p in enumerate(args)]

    if len(rs) == 2:
        a, b = rs
        print("\n" + "=" * 62)
        print("A(改前) → B(改后)")
        rows = [("nose", "吻端半宽", "%峰值", True), ("keep1", "末1%宽度保持率", "%", True),
                ("keep2", "末2%宽度保持率", "%", True), ("slope1", "末1%收口斜率", "px/u", False),
                ("slope2", "末2%收口斜率", "px/u", False), ("at01", "距吻端1%处半宽", "%峰值", True),
                ("at02", "距吻端2%处半宽", "%峰值", True), ("at04", "距吻端4%处半宽", "%峰值", True),
                ("at08", "距吻端8%处半宽", "%峰值", True), ("at12", "距吻端12%处半宽", "%峰值", True)]
        for key, name, unit, pct in rows:
            va, vb = a[key], b[key]
            if pct:
                va, vb = va * 100, vb * 100
            print(f"  {name:20s} {va:8.2f} → {vb:8.2f} {unit:8s}  Δ{vb-va:+8.2f}")