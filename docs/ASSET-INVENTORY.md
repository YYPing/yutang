# 资产入库清单（2026-10-08）

## 为什么有这份清单

2026-10-08 之前，`.gitignore` 里有一句：

```
# Binary assets excluded from the text-only source repo
# (images / audio / native libs are restored locally or via LFS)
*.png
*.wav
```

那句话在**上游仓库**（`cyberdaddyleo/yutang`）成立，但在这个 fork 里**两项都不成立**：

| 它承诺的恢复方式 | 本 fork 的实际情况 |
|---|---|
| 走 Git LFS |❌ 仓库里**没有 `.gitattributes`**，LFS 从未配置 |
| 本地恢复 | ❌ 唯一能取回资产的东西在工作区**外**（`refs/fetch-assets.mjs`），而且它指向**上游的** raw 地址，不是本仓库 |

⇒ 实际后果：`git clone` 下来**跑不起来**。
`src/engine/term-images.js` 硬引用 4 张底图、`src/audio/ambient.js` 硬引用 5 个音效、
`src/themes/coast/` 硬引用 30+ 张生物图 —— 全都不在仓库里。页面能打开但**没有水面、没有声音**。

⇒ 本次改为**资产入库**，换取「clone 即跑」。

## 已入库（81 个文件，约 190 MB）

| 类别 | 路径 | 体积 | 被谁引用 |
|---|---|---|---|
| 四季底图 | `public/assets/{spring,pond,autumn,winter}.png` | 46 MB · 4×3840×2160 | `term-images.js` 的 manifest |
| 底图 webp | `public/assets/term/*.webp` | 2.6 MB | 同上的轻量版 |
| 环境音 | `public/assets/*.wav`（stream/ocean/rain/wind/thunder） | 59 MB | `audio/ambient.js` 的 `AUDIO_TRACKS` |
| 海岸主题 | `public/assets/coast/*.png`·`*.webp`（24 个生物 + 底图） | 53 MB | `themes/coast/catalog.js` |
| 海岸字牌 | `public/assets/coast/letters/*`（29 个） | 5.1 MB | `themes/coast/letter-catalog.js` |
| 应用图标 | `electron/assets/app-icon.{icns,ico,png,svg}` | 1.8 MB | `package.json` 的 `build.icon` |
| 节气参考图 | `docs/solar-terms/**`（13 张） | 29 MB | 文档与量具对照（`measure-season-textures.py` 等） |

## 刻意不入库的东西

| 类别 | 路径 | 理由 |
|---|---|---|
| 本机编译的原生模块 | `electron/native/bin/`·`electron/native/include/` | 换平台/换 Node 版本即失效，可由 `electron-rebuild` 重建 |
| 构建与量具产物 | `out/`·`dist/`·`work/`·`release/`·`.dist-old-*/` | 可完全重新生成 |
| 一次性截图脚本 | `fps.cjs`·`shot-*.cjs`·`wallpaper-test.cjs` 等 | `gitignore` 里已逐个列名并注明覆盖关系 |
| 历史备份 | `.git-bundles/` | 本机保险，每个开发者自己有一份 |

## 两条要记住的

1. **占仓库体积的大头是音频（59 MB）与底图（46 MB）**，不是代码。
   如果哪天要瘦身，优先方向是把 wav 降成 mp3/ogg（**不是**删掉——`AUDIO_TRACKS` 硬引用）。
2. **`docs/solar-terms/` 里的参考图是「第二信源」**，不是装饰。
   `tools/check-term-delta.cjs` 的 `REF_SAME_DE`（参考图自身相邻档 ΔE，20 对）就是从它们实测出来的，
   它是水色判据的**标定上限**。删掉这批图 ⇒ 那套判据失去依据。
