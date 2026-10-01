# 生态内核（v4）设计记录

> 来源：`REQUIREMENTS_v4.md`（v4.0）§17 参数总表 + §6~§9 机制。
> 代码位置：`src/engine/eco/`。验证：`pnpm test:eco` → `docs/ECO-M2-REPORT.md`。
>
> **收敛说明**：这部分最初写在一个独立的 `koi-pond/` 试验目录里（自带 Canvas 2D 渲染器、
> Electron 壳、素材副本）。后来确认那些都是与本体重复的，已整体废弃，只把
> **生态内核**与**推演工具**并入本体。本文件即那次收敛保留的决策记录。

## 1. 这一层解决什么问题

本体的 `src/engine/simulation.js` 原本只有**行为级**模拟 —— 转向、避让、追食、涟漪、
分离力、岸边力。鱼的体长来自滑杆（`baseLength × fishSize`），**不会老、不会长、不会生、不会死**。

v4 要的是**生态闭环**：世代演化、生长曲线、饱食代谢、遗传变异、种群治理。
两者是叠加关系而不是替代关系 —— 行为逻辑一行不改，生态只负责"鱼是什么状态"。

| 层 | 文件 | 职责 | 本次是否改动 |
|---|---|---|---|
| 行为 | `src/engine/simulation.js`、`koi-motion.js`、`habitat.js` | 怎么游、怎么避、怎么追 | 仅增加接入点 |
| 渲染 | `koi-renderer.js`、`koi-skin.js`、`pond.js` | 怎么画 | 不改 |
| **生态** | **`src/engine/eco/`** | **生长 / 摄食 / 繁殖 / 遗传 / 种群 / 死亡** | **新增** |

## 2. 模块清单

| 文件 | 行数 | 职责 |
|---|---:|---|
| `constants.js` | 218 | **v4 §17 参数总表 —— 唯一数值来源**，`pxPerCm()` 换算 |
| `rng.js` | 56 | mulberry32 可复现随机（离线补算需要）+ `hash32` |
| `genes.js` | 86 | §8.3 八基因位、`PALETTES` 八品系、`randomGenes` / `inheritGenes`（5% ±10% 突变） |
| `growth.js` | 120 | §7.1 逻辑斯蒂生长曲线、§7.2 三重钳制、`grow()`（含 nutrition 消耗） |
| `feeding.js` | 105 | §7.3–7.5 代谢、摄食、肥满度、`nutrition` 闭环（C31） |
| `breed.js` | 69 | §8.1–8.2 繁殖闸门、冷却、孵化率、`ageAtLengthFraction`（二分反解） |
| `population.js` | 63 | §9 拥挤度、密度胁迫、硬上限、淘汰候选 |
| `lifecycle.js` | 70 | §6 状态机（鱼苗→幼鱼→亚成→成体→长老）、§7.6 死亡、淡出 |
| `world.js` | 381 | tick 编排中枢（World State） |

依赖图是**单向同目录**的，无外部依赖、无 DOM，Node 可直接跑。

## 3. 参数基线

`k = 0.039`、`d₀ = 82`（C25 校准）、`L_global = 30cm`、软上限 30、
半月刻度（一世 = 15 天 = 一个节气）、1 池塘日 = 2 真实小时、基准寿命 180 池塘日。

`C28`：`pxPerCm = 短边 × 0.16 / L_global`（1080p ≈ 5.76）。

> ⚠️ **该定义使「屏幕占比 ≤16%」恒等于「L_global 钳制」** —— `viewportMax`
> 化简后恰好等于 `globalCap`。所以三重钳制实际退化成两重，且 `lCapCm` 与视口无关、
> **不需要在 resize 时重算**。（这一点曾在试验目录里被误当成 bug 并写过一行无效的
> `lCapCm = Math.min(lCapCm, 30)`，已删除。）

## 4. 口径漂移（代码与 v4 不一致处，已按 v4 定稿）

**品系** —— v4 §8.3 / §11.3 定为 8 品系：红白 / 大正三色 / 昭和三色 / 黄金 / 浅黄 / 乌鲤 / 丹顶 / 写鲤。

| 对照 | 差异 |
|---|---|
| 试验目录里那份 PixiJS 单文件 demo | 多出「白金 / 绯鲤 / 白写」，缺「浅黄 / 丹顶 / 写鲤」 |
| `fish-poc`（早期程序化鱼试验） | 只有 7 个，多出「纯红 / 金橙 / 纯白」，缺「大正三色 / 浅黄 / 丹顶 / 写鲤」 |

⇒ `eco/genes.js` 按 v4 定稿。**本体渲染侧的品系另行映射**（见 §7）。

**生长曲线** —— 那份 PixiJS demo 内嵌 `growthK: .08`、`growthD0: 80`（v3.3 笔误值）。
v4 C25 已校准为 `k = .039`、`d₀ = 82`。用 `k = .08` 时 111 日龄会到 91.3%（§3 表应为 76%，偏差 +15.3pt）——
这就是 §7.1 所称的「行为级错误」。本目录按 v4 定稿。

## 5. ★★ 两处偏离文档字面（实测论证）

| 参数 | 文档字面 | 本目录取值 | 为什么 |
|---|---|---|---|
| `CONDITION.dailyDecay` | −2 / **池塘日**（§7.5.2「日衰减 −2」） | −2 / **真实天**（= 0.1667/池塘日） | 按池塘日则是 −24/真实天，漂移项补不上 ⇒ 平均肥满度掉到 18，繁殖门槛（≥40）长期不满足，种群萎缩 |
| `FEEDING.forageRatioFn` | 恒定 **0.93**（F-7.4.1） | 随饱食反向调节（0.93→1.08） | 恒定 0.93 ⇒ 饱食单调降到地板 15 ⇒ 长期低于繁殖门槛 ⇒ **不投喂必然灭绝**，与 §2 US-5「长期无人干预数量稳定」直接冲突 |

两处都在 `eco/constants.js` 内注明了**如何回退到文档字面值**（字段设为 `undefined` / 改回 `2`）。
回退后按 `tools/tune.js` 扫描，两个场景都会退化为种群萎缩或灭绝。

## 6. M2 推演结论

`pnpm test:eco`（完整报告见 `docs/ECO-M2-REPORT.md`）。

**已通过 8 项**：生长曲线回代 §3 表最大偏差 1.5pt（≤2pt 要求）；性成熟 6.29 真实天（≈C26 的 6.4）；
初始梯队体长 21.03/17.93/14.22/10.22cm 对上 §3 的 21.00/17.88/14.15/10.14；开局 3 条可繁殖；
常态数量稳定 23/30/28/26；无 NaN；体长不越界；365 天不断代。

**未通过 1 项（机制性冲突，非实现 bug）**：一年最高世代实测 **26**，§17 口径 **50–60**。
根因是 `nutrition` 闭环 + 幼鱼抢不过大鱼 + 鱼苗密度胁迫 ×3 把「一代」从理想的 6.4 天拉到 11–14 天。
实测**放宽软上限（30→60）与提高繁殖触发率（0.5→3.0）均无效**。

**待需求方拍板**（四个候选解法）：
- **A** 接受实测值，把 §17「50–60」改注为「理想上限，实测 26–32」
- **B** 降低 `nutritionPerCm`（1.2→0.3）削弱营养瓶颈 —— 但会削弱 US-2 的投喂收益梯度
- **C** 放宽 F-7.4.1，让自然饵料补**少量** `nutrition`（当前明确不补）
- **D** 降低鱼苗胁迫倍率（×3→×1）—— 实测无效，不推荐

## 7. 与原体的接口约定

- **数量**：由 `options.ecoMode` 决定。开 ⇒ 条数由繁殖/死亡决定，`fishCount` 滑杆语义变为
  「重置到 N 条」；关 ⇒ 完全回到改动前行为（滑杆强制同步、不繁殖不死）。
- **体长**：生态侧给 `lengthCm`，渲染侧的 `fish.length`（px）由 `lengthCm × pxPerCm` 驱动，
  `fishSize` 滑杆保留为全局倍率。
- **摄食**：行为侧原本在嘴部命中食品时直接 `food.splice()`。生态侧在同一点补一次
  `eatPellet(fish)`（+饱食、+nutrition），不改变食物的生成与寿命规则。
- **品系映射**：`eco/genes.js` 的 8 品系需映射到 `koi-renderer.js` 既有的 `palettes`；
  手绘鱼（`KoiStudio`）保持走 `koi-skin.js`，不参与遗传。

### 7.1 实装记录（本次落地）

新增 `src/engine/eco-bridge.js` 作为两层之间的适配器，其余改动都落在既有文件里：

| 文件 | 改动 |
|---|---|
| `src/engine/eco-bridge.js`（新增） | 八品系 → 6 套调色板的映射；`attachBehavior()` 给生态鱼挂上运动 / 外观 / 相位字段 |
| `src/engine/simulation.js` | `DEFAULT_OPTIONS.ecoMode`（默认 **关**）；`initEco / syncEcoFish / resetEcoPopulation`；`update()` 里每帧推一次生态 tick；嘴部命中饲料时补 `eatPellet()`；`getStats()` 暴露 `eco` 快照 |
| `src/engine/eco/world.js` | 新增导出 `resetPopulation(world, count)`（按 §9.2 梯队等分插值日龄） |
| `src/engine/koi-renderer.js` | 死亡演出：淡出 + 下沉 + 侧翻（`scale(1, 1 − tilt·0.82)`） |
| `src/components/Pond.jsx` / `src/engine/pond.js` | 暴露 `resetPopulation(n)` 这个命令式入口 |
| `src/components/SettingsPanel.jsx` | 「生态模式」开关 + 生态状态栏 + 「重置池塘」按钮 |
| `src/lib/storage.js` / `src/App.jsx` | `ecoMode` 持久化；左下角角标改读真实存活数 |

**★ ecoMode 默认关** —— 既有 245 个测试与老用户升级后的观感都建立在「条数由 fishCount 决定」之上，所以开关默认关，要主动打开才接管生死。

**摄食口径**：行为层主导 —— 谁游到嘴边谁吃，吃到那一点上补一次 `eatPellet()`。
`world.js` 里的 `feed(world)` 是给**批量推演**用的（推演没有坐标，只能按感应圈比例 + 大鱼优先来分配），实时路径不走它。两条路径并存，互不干扰。

### 7.2 ★ 实装时踩到的三个坑（都已修 + 有回归断言）

| 症状 | 根因 | 修法 |
|---|---|---|
| 打开生态模式后，8 条梯队鱼立刻变成 12 条 | UI 每次挂载 / 任何设置变化都会把**整包 options** 传下来，`updateOptions` 里 `if ('fishCount' in options)` 就无条件重置了种群。非生态模式下 `syncFish()` 是幂等的所以看不出问题，而 `resetEcoPopulation()` 是**破坏性**的 | 改成只在 `options.fishCount !== previous.fishCount` 时动手；再把「重置」从滑杆实时生效改为**显式按钮**（`onResetPopulation`），生态模式下干脆不把 `fishCount` 放进 options |
| 关掉生态模式后，鱼还是 `eco` 鱼，数量对不上，再切回来状态是脏的 | `syncFish()` 非生态分支按 `!fish.custom` 筛原生鱼，而生态鱼的 `custom` 也是 `null`，于是被当成原生鱼留下了 | 筛选条件加 `&& !fish.eco` |
| 手绘鱼（KoiStudio）在生态模式下永远不追饲料 | `wantsFood(fish)` 读 `fish.satiety`，手绘鱼没这个字段 ⇒ `undefined < 85` 在 JS 里是 **`false`**（undefined 转 NaN，任何比较都是 false）⇒ 判定为「吃饱了」 | 判定加 `fish.eco` 前置条件，非生态鱼保持「看见就吃」的原行为 |

### 7.3 验收

| 套件 | 结果 |
|---|---|
| `pnpm test`（既有 245 个单元测试） | **245 / 245** ✔ —— 生态开关默认关，行为层一行未变 |
| `pnpm test:eco:bridge`（新增，32 项）| **32 / 32** ✔ —— 覆盖开关切换、行为字段完整性、每帧时钟、摄食联动、30 天加速推演后的接纳、视口/体积/重置回归 |
| `pnpm test:eco`（生态内核推演） | 8 / 9 —— 仍未过的一项是 §17 世代口径的机制性冲突（见 §6） |
| 真实桌面窗口（`tools/check-eco-ui.cjs`） | ✔ —— 开关在位、状态栏「第 1 代 · 存活 8 尾 · 拥挤 27%」、滑杆改称「重置种群」、左下角显示真实存活数 |

### 7.4 存档 · 离线演化 · 归来摘要 · 演化倍速（F-14 / §3）

**为什么这三件事必须一起做**：没有倍速，「离开三天」在界面上看不出任何变化，离线补算**无从验证**；没有存档，20× 快进出来的池塘一关窗口就没了。三者互为对方的观测手段，拆开做等于每次都只能靠推演脚本自证。

| 文件 | 改动 |
|---|---|
| `src/engine/eco/world.js` | 序列化段：`serialize / restoreWorld / SAVE_SCHEMA_VERSION`；抽出 `freshStats / buildWorld / normalizeWorldOptions` 供建世界与重建世界共用；`setNextId()`；`advanceDays` 加 `maxSteps` 选项 |
| `src/engine/eco/rng.js` | `restore(state)`（忽略 0 —— 0 是退化值，会让序列卡死） |
| `src/engine/simulation.js` | `ecoSpeed` + `ECO_SPEEDS`；`initEco` 支持 `ecoSnapshot` 还原；`applyAwayTime()` 走墙钟补算；`getSnapshot / resetEcoFully / takeAwayReport` |
| `src/lib/save-store.js`（新增） | 两条通道（文件 IPC 为主 / localStorage 兜底），读档取较新那份 |
| `electron/main.cjs` / `preload.cjs` | `pond:load-save` / `pond:save-save` IPC；`.tmp` + `rename` 原子写；`data === null` 表示清除 |
| `src/App.jsx` | 冷启动先读档再渲染；30s + 页面隐藏 + `beforeunload` 自动保存；归来摘要面板；「重置池塘」走 `resetEcoFully()` 并清档 |
| `src/components/SettingsPanel.jsx` | 倍速档位选择器（0.5/1/2/5/20×）；「重置池塘」二次确认（5 秒自动撤销） |
| `src/lib/storage.js` | `ecoSpeed` 持久化（**本地再写一份档位白名单** —— 「存档是不可信输入」的校验不该依赖引擎） |

口径：

| 项 | 取值 | 理由 |
|---|---|---|
| 存档位置 | `app.getPath('userData')/save.json` | 需求 F-14.1.1 字面写 `%APPDATA%\koi-pond\save.json`。**这里刻意偏离**：`app.setName('浮生锦鲤池')` 已把 userData 定死在 `%APPDATA%\浮生锦鲤池`，为对齐字面去改名会把老用户的设置与手绘鱼（都在 localStorage，按 origin 隔离）全部丢掉。**不破坏既有用户数据 > 路径字面一致**。 |
| 写入方式 | `.tmp` + `rename` 原子写 | 避免写一半断电，把上一个完好存档也毁掉 |
| 双通道 | 文件（IPC，容量不限）+ localStorage（同步兜底） | IPC 是异步的，`beforeunload` 那一刻发出去的请求多半赶不上落盘 |
| 读档取较新 | 按 `lastSeenWallClock` 比 | 某次文件没写成功时，不会读到比兜底更旧的档 |
| 保存时机 | 每 30s + 页面隐藏 + `beforeunload`（走同步通道） | 被强杀最多丢 30 秒 |
| 补算上限 / 步长 | 30 天；60s，>20000 步自动加粗 | F-14.2.3 / F-14.2.2 |
| 离线投喂 | `feedPerDay: 0` | F-14.2.4：没人点水面，只走自然饵料 |
| 倍速语义 | 只乘**生态时钟** | 20× 是「时间过得快」而非「鱼游得快」。行为层的游速/转向/涟漪一律不受影响，否则画面会退化成抽搐 |

★ 三个反直觉的坑（都已修，其中两个有回归断言）：

| 坑 | 症状 | 根因 | 修法 |
|---|---|---|---|
| 必须先读档再建世界 | 冷启动后用户的池塘变成新池，且**旧档被静默清空** | `PondEngine` 只在首次挂载时读一次 `options`。晚到的存档不生效，而紧接着的 30s 自动保存会把这份「新池」写回磁盘 | 加载期间不渲染 `<Pond/>`（IPC 读几 KB JSON 通常 <20ms）；`App.jsx` 的 `pondReady` 门控 |
| `maxSteps` 不能做全局默认值 | `validate.js` 365 天推演存活数 **28 → 32**，§6 的结论全部作废 | 它是为离线补算（30 天 = 43200 步，同步跑会卡主线程几秒）准备的；一旦设成 `advanceDays` 的默认值，推演步长从 0.05 被悄悄加粗到 0.219 | 默认 `Infinity`，由 `applyAwayTime` 显式传 `OFFLINE.maxSteps`——**只有需要它的调用方开启它** |
| hook 的 deps 数组在调用那一刻求值 | 整棵树白屏（`ReferenceError: Cannot access 'initialSave' before initialization`） | `const [initialSave] = useState()` 被写在用到它的 `options` useMemo **之后** | state 上移。⚠️ `vite build` 与 `node --test` **都发现不了**（构建只做模块级分析、单元测试不 import App.jsx）⇒ 新增 `tools/check-boot-ui.cjs`（5 秒白屏烟测，连 `pageerror` 一起断言） |

验收：

| 套件 | 结果 |
|---|---|
| `pnpm test`（含新增的「倍速档位被手改 ⇒ 退回 1×」） | **246 / 246** ✔ |
| `pnpm test:save`（新增，58 项） | **58 / 58** ✔ —— 含「读档不改变未来」强断言、离线补算截断、双通道取较新、重置归零 |
| `pnpm test:eco:bridge` | **32 / 32** ✔ |
| `pnpm test:eco` | 8 / 9（仍是 §17 那项） |
| 真实窗口全链路（`bash tools/check-save-full.sh`） | ✔ —— 倍速档位落到 localStorage、`beforeunload` 同步兜底写入、30s 后 `save.json` 落盘、**回拨时钟 3 天后冷启动弹出「你离开了 3 天 0 小时 —— 新生 12 尾 · 离世 0 尾 · 最高第 2 代 · 池子又走了 36 池塘日」**、重置需二次点击且 5 秒未点自动撤销 |
| 白屏烟测（`tools/check-boot-ui.cjs`） | ✔ —— 无未捕获异常、画布挂载、左下角有内容 |

#### ★ 端到端验收本身的五个坑（测不出来 ≠ 功能没做）

这条链路的每一环都只在真实 Electron 里成立（IPC 文件通道、`beforeunload` 同步兜底、冷启动先读档再建世界），但**测试假具自己会骗人**：

| 坑 | 症状 | 根因 | 修法 |
|---|---|---|---|
| `page.reload()` 不等于重启 | 回拨时钟 3 天后，「归来摘要」显示的是「你离开了 2 分钟」 | reload 会触发 `beforeunload`，App 的处理器拿 `Date.now()` 把墙钟重写一遍 ⇒ 刚回拨的值当场被冲掉 | 真的重启进程 |
| 强杀会丢掉 localStorage | 回拨的值根本没落盘，重启后摘要还是「2 分钟」 | Chromium 的 localStorage 是**异步**刷盘的，`taskkill /F` 没有优雅关闭 ⇒ 最近一次写入丢失 | 走应用自己的 `pondDesktop.quit()` 优雅退出。同时**退出前把 `fusheng-pond-save` 这个键在 `Storage.prototype.setItem` 上冻结**，让 `beforeunload` 的写入变成空操作（只冻这一个键，settings 照常写） |
| 优雅退出也不够：还有 ~5 秒的提交定时器 | 时好时坏 —— 上一轮全绿、这一轮摘要完全不弹 | Chromium 的 localStorage 有 **~5 秒的提交定时器**，`setItem` 之后立刻 `quit()` 时，刚写进去的「3 天前」还没落盘，磁盘上留着上一个（新鲜的）值 ⇒ 重启后被「取较新」判为胜出 | 回拨之后**干等 6 秒**再退出。同时让 restore 阶段把「两条通道各是多少天前 / 各多少尾」打出来 —— 不弹摘要时一眼能分清是「存档没读到」还是「读到了没补算」，不用对着一个 `null` 猜 |
| 断言别按脑补的文案写 | 明明面板上有「最高第 2 代」，`/世代/` 匹配不上 | 面板文案是「最高第 N 代」，不是「世代」 | 断言贴真实 DOM 文案；`tools/check-save-ui.cjs` 里第一次就把三条断言写错了两条 |
| 判断「文件写出来了」不能只看存在 | 上一次跑留下的旧档也在那里，永远通过 | 需要 mtime 变新才证明是**这一次**写的 | 轮询时比对 `mtimeMs > baseline` |
| 上个用例把面板留在打开状态 | Playwright 报 `intercepts pointer events`，点不动「设置」 | 黑色 backdrop 盖住了按钮 | 先按 Esc 收干净再点（`openSettings()`） |

另外，**存档路径不能照文档字面猜**：F-14.1.1 写 `%APPDATA%\koi-pond\save.json`，而 `app.setName('浮生锦鲤池')` 已把 userData 定死在 `%APPDATA%\浮生锦鲤池`。测试脚本第一版按 `fusheng-koi-pond`（package.json 的 `name`）去找，白等了 30 秒 —— 实际文件早就写好了。

### 7.5 投喂感应圈（F-2.8）+ 两处口径对齐（F-2.6 / F-7.3.3）

**要解决的问题**：US-1 的验收是「0.5s 内圈内 ≥3 条转向，**圈外鱼不变**」。改之前，撒一把食全池鱼都会横穿过来抢 —— 「附近」和「圈外」这两个词在实现里根本不存在。
顺带把两处硬编码口径拉回需求参数表：饲料上限 80 → `FEEDING.foodCap`(200)、嘴前判定 13px → `FEEDING.mouthPx`(6px)。

| 文件 | 改动 |
|---|---|
| `src/engine/eco/constants.js` | `FEED_CIRCLE` 3 键（本轮**首次被读**）：`radiusFraction 0.30` / `closeRangePx 34` / `displaySeconds 1.8` |
| `src/engine/simulation.js` | `this.feedCircles = []`；`feed()` 返回 `{ok, capped}` 并给**每一粒**饲料挂 `circle`；新增 `canReachFood(fish, pellet)`；选食循环加门控；嘴部判定改读 `FEEDING.mouthPx`；`update()` 推进/回收 `feedCircles`；`getStats()` 加 `foodCap` / `feedCircles` |
| `src/engine/pond.js` | `feed()` 透传返回值；新增 `drawFeedCircles()`（虚线圈 + 呼吸 + 起始脉冲，`reducedMotion` 下降级为静态）并插入渲染序列（紧跟 `drawRipples()`） |
| `src/App.jsx` | `feedPond()` / `onFeedResult()`：到 200 粒上限时提示「这一把够了 —— 水里还有 200 粒没吃完」（F-2.6） |
| `src/components/Pond.jsx` | `onFeed` 接线（顺带修掉一处重复 `return` —— 第一行 `return` 会让 `onFeed` 永不执行） |

口径（每条都有对应断言）：

| 项 | 取值 | 依据 |
|---|---|---|
| 感应圈半径 | **视口短边 × 0.30** | F-2.8。⚠️ §F-2.8 校准注写「1080p 半径约 270px」，那是 **1600×900 逻辑短边**下的值；按公式 1600×900 ⇒ 270 ✔、1920×1080 ⇒ 324。**公式才是硬口径，注释里的数字不是** |
| 圈外鱼是否看得见 | 看不见，**但贴脸 34px 例外** | F-2.8。阈值量到鱼身**中心**而非嘴 —— 判定发生在鱼移动**之前**，此时这一帧朝向还没定；34px 远小于体长，两种量法差别可忽略 |
| 门控挂在哪 | **挂在每一粒饲料上**（`pellet.circle`） | 见下面的坑 1 |
| 虚线圈显示 | 点击处 1.8s 椭圆虚线（`ry = rx × 0.64`）+ 起始脉冲 | 与涟漪同一套透视约定；画正圆会像贴了一层 UI 浮层 |
| 未食用上限 | 200 粒（满了这一把不撒 + 界面提示） | F-2.6 / F-7.3.6 |
| 嘴前判定 | 6px | F-7.3.3 |

★ 六个反直觉的坑：

| 坑 | 症状 | 根因 | 修法 |
|---|---|---|---|
| 1 · 门控不能只活在虚线圈的 1.8s 里 | 虚线圈一消失，圈外鱼立刻又能抢 | 直觉写法是「显示虚线圈的这段时间内圈外鱼不抢」。但饲料要活到落底淡出（F-7.3.7，**90s**），**门控必须跟饲料同寿**，否则中间那 88 秒语义是空的 | 门控读 `pellet.circle`（每粒饲料各自持有投喂时的圈），虚线圈只是**显示**，两者寿命解耦 |
| 2 · 「圈外鱼不变」有两个强度不同的读法 | 拿 `Max(位移偏差) < 8px` 当断言，实测 2s 就 35px，看着像漏网 | (i)「圈外鱼**看不见**这食」——能保证；(ii)「圈外鱼**轨迹逐位不变**」——**做不到**，有两条真实耦合：① 圈内鱼因为去抢食，`personalSpace` 从 30 缩到 18，它对圈外鱼施加的分离力变了；② 每条鱼重选漫游目标时才消耗一次 rng，圈内鱼改道 ⇒ **后续所有鱼（含圈外鱼）用到的随机数整体错位**（共用一条 rng 流必然如此，唯一解法是每尾鱼一条独立流，代价远大于收益） | 拆成三段证据：**④a** 单尾圈外鱼 vs 对照组 **4s 逐位零偏差（0.000e+0）** ⇒ 门控完备；**④b** 28 尾首 0.5s 偏差 **0.066px** ⇒ 没有瞬时反应（若门控漏，第一帧就会朝食冲，0.5s 内该是几十像素）；**④c** 2s 有界（<100px）且**到饲料的均值距离不缩短** ⇒ 是耦合不是吸引。偏差**随时间发散**这个形状本身就是证据 |
| 3 · 量具自己会把「画了」量成「没画」 | `check-feed-ui.cjs` 里 A 段过、B 段同一条椭圆 p90 却是 0 | `drawFeedCircles` 有**呼吸**：`rx = radius × (1 + sin(age×6.2) × 0.022)` —— 半径在 ±2.2%（±5.9px）内浮动，而虚线只有 `lineWidth 1.1`（±0.55px）。钉死在 `rx` 上取单点，只要 `age ≠ 0` 就整个采空。A 段能中纯属侥幸（那圈刚投，`sin(0)=0` ⇒ 半径正好贴合） | 沿半径做 **±12px 窗口取峰值**。这条要写进任何「验证一条细曲线在不在」的场景里 |
| 4 · Vite 的 transform 缓存会滞后于磁盘 | 真窗口**整片白屏**，`TypeError: this.drawFeedCircles is not a function` —— 而磁盘源码里这个方法明明在 | dev server 返回的 `pond.js` 里只有 `this.drawFeedCircles()` 的**调用**、没有**定义**（`curl` 数一下就知道：磁盘 2 处 / 产物 1 处）。`node --test` 与 `vite build` 都直接读磁盘源码，**都发现不了** | 验收脚本第 2 步**强制核对**「dev server 产物里的符号出现次数 == 磁盘上的次数」，对不上直接判失败。见 `tools/check-feed-full.sh` |
| 5 · 真窗口的 rAF 会被节流到近乎停摆 | 想靠 `waitForTimeout(2100)` 等虚线圈过期 —— 模拟时钟 2.1s 只推进了 **0.10s**，圈当然还在 | 无头/窗口不可见时 Chromium 把 rAF 降到极低频。等的那个「2.1s」是**真实时间**，而圈的寿命走的是**模拟时间** | 手动驱动 `sim.update(1/60)` 到目标状态，步数可控、结果确定 —— 顺带还能断言「**恰好**跨过 life 而非被别的东西提前清掉」 |
| 6 · 首次 `getImageData` 有回读噪声 | 「圈有没有画」的信号里混着 5 个灰度级的假差异 | 每次进入新的 evaluate，**第一次**回读会把待处理的合成 flush 掉，结果与紧随其后的第二次读不一致 | 每个 evaluate 先做一次丢弃式 warm-up 读 |

验收：

| 套件 | 结果 |
|---|---|
| `pnpm test`（含 5 条新增 F-2.8 测试 + 1 条按新规则重写的老测试） | **251 / 251** ✔ |
| `pnpm run check:feedcircle`（新增，32 项） | **32 / 32** ✔ —— 半径口径、圈内鱼数校准、「圈是局部的」几何判据、US-1 转向/到达、④a/b/c 三段圈外证据、贴脸例外边界（33px 内 / 35px 外）、虚线圈寿命 |
| `pnpm run check:feedcoupling`（新增，机理探针） | ✔ —— 把「门控漏了」与「群体耦合」分开的判据来源；改门控逻辑后重跑对拍 |
| 真窗口 `bash tools/check-feed-full.sh`（新增，12 项） | **12 / 12** ✔ —— 虚线圈可见性（沿椭圆差分 p90 123.3、变亮占比 **59.4%** vs 虚线 `[9,7]` 理论值 56.25%）、寿命回收（新圈信号 123.5 → 过期后残余 3.5，且「过期后渲染」与「强清后渲染」**逐点差 0.00**）、200 粒上限与界面提示 |

截图留档：`out/feed-circle.png`（投喂瞬间 —— 虚线圈 + 圈心饲料 + **鱼群全在圈外**）、`out/feed-circle-cap.png`（200 粒上限 —— 顶部提示 + 圈内 3 尾抢食 + 圈外仍有锦鲤正常游）。

三处**测试跟着实现改**（都是前提变更，不是新 bug）：

| 测试 | 变更 | 原因 |
|---|---|---|
| `tests/habitat.test.js` | `sim.feed(...)` 的布尔断言 → `.ok` | `feed()` 改返回 `{ok, capped}`（要区分「点在岸上」和「到 200 粒上限了」） |
| `tests/koi-motion.test.js` | 撒食点 `(1400,500)` → `(480,500)`，采样窗口 2s → 1s | 1600×1000 ⇒ 半径 300px。原撒食点在**圈外**，鱼根本看不见食物 ⇒ 「抢食时尾摆更强」的前提不成立。改到圈内后行程被半径锁死在 300px，2s 时鱼已接近食物开始减速（2s→3s 段的 Δphase 只有巡航的 1.18 倍，卡在 1.2 阈值下），窗口前移到速度峰值区（velocity 61.7 = 3.1× 巡航，窗口内 1.61 倍） |
| `tools/check-feedcircle.js` 等 | 见上面坑 2、3 | 断言口径与量具修正 |

### 7.6 阶段 → 外观 / 阶段群游 / 鱼卵群（C 方案）

**背景**：§6 的阶段表里有一列「行为特征」，其中**看得见**的四条一直没落地 ——
鱼苗「近半透明」、幼鱼「花纹显现」、老鱼「体色褪淡 / 游速下降 / 离群独处」，
以及 §11.2 层 6 的「鱼卵群」。
生态侧其实**早就算好了**：60 池塘日的推演里池中有
`fry 0.3% / juvenile 1.3% / subadult 2.5% / adult 4.7% / elder 11.3%` 的完整金字塔，
但渲染层从不体现 ⇒ 画面读起来「全是大鱼」。

**方案（用户拍板 C）**：不动任何尺度口径（F-7.2.2 的 16% 保留），
把已经算好的结构**翻译出来**。

#### 三处新增的翻译

| 落点 | 内容 |
|---|---|
| `eco/constants.js` | 新增 `APPEARANCE`（3 条曲线）/ `SCHOOL`（权重·感知·死区·分离倍率·拉力形状）/ `EGG_VISUAL`（9 个键） |
| `eco-bridge.js` | `updateFishLook()` 把「阶段 + 日龄」翻成 `aFade / aPattern / aPale` 三个纯数字；`clutchAnchor()` + `eggVisual()` 派卵的位置 |
| `simulation.js` | 邻居循环里的聚合项 + `updateSchoolRadii()` + `syncEggs()`；`koi-renderer.js` / `pond.js` 只读数字、只做乘法 |

★ **为什么由 eco-bridge 翻译而不是让渲染层查 `STAGES`**：
「鱼苗 / 幼鱼 / 老鱼」是**生态词汇**，渲染层只该认识「一个 0.52 的透明度」。
这样以后加阶段只改一张表，渲染层一行不动。

#### ★ 四个被量具抓出来的坑（每一个都值得记）

**坑 1 · 拉力形状是单调的 ⇒ 死区形同虚设**
初版 `pull = 1 − r/sense`，在 `r = 0` 处最强。代入 `dead = 0.055`、`sense = 0.17`：
死区边界上的拉力 = `1 − 0.055/0.17 = **0.68**`，也就是「比这更近就不拉了」的**死区边界上仍有 68% 满值拉力**。
⇒ 稳定点是"能多近就多近"，判据对参数极不敏感（`sense` 从 0.17 改到 0.60 几乎不动）。
**修法**：吸引改钟形 `pull = sin(π·(r − dead)/(sense − dead))`，两端归零、中点最强。

**坑 2 · 吸引与排斥不能共用形状**
排斥（负权重）套钟形的话，近处推力反而归零 ⇒ 两尾老鱼擦身而过时**不推了**。
**修法**：`attractHill = pullShape === 'hill' && schoolWeight > 0` ——
吸引走钟形（避免塌缩），排斥走单调 `1 − r/sense`（越近推得越狠）。

**坑 3 · 分离倍率只乘自己那一侧 ⇒ 「离群」变成"单方面后撤"**
老鱼原本 `spaceScale 1.55`，两尾老鱼的个人空间只有 `0.29×(108+108)×1.55 ≈ 97px`，
出圈就没人管了；而别的鱼照样顶到它身上。
**修法**：改成**成对取双方较大者**（`max(ownSpace, otherSpace)`）—— 大气泡是互相的。
再配合 `spaceScale.elder = 4.0`（老鱼↔老鱼 250px、老鱼↔鱼苗 130px）：

| spaceScale.elder | 老鱼隔离度（2 个种子） |
|---|---|
| 1.55（初版） | 1.00 / 1.02 —— **等于没做** |
| 2.5 | 1.03–1.14 / 1.19–1.20 |
| **4.0** | **1.45 / 1.82** |

代价核对：老鱼「贴到画幅边缘 13% 带里」的时间占比 **0%**（没被挤到墙角）。

**坑 4 · 老鱼判据本身是坏的（量具 bug）**
「同阶段公平对照 `same/control`」在**样本极少的阶段上不能用**：
老鱼中位 1–2 尾、峰值 3–8 尾，而「最近邻」是**极值统计**。
同一个参数在 4 个种子上读出 0.66 / 0.93 / 0.99 / 1.24 —— 全是噪声。
**修法**：老鱼改用**隔离度** = 到最近一尾鱼（**不限阶段**）的距离 ÷ 同一次采样里全池的中位。
对照组就在同一帧里，换种子/换种群规模都可比。这也更贴合 §6 的字面 ——
「离群独处」是**不跟群体待在一起**，不是"只躲着别的老鱼"。

#### ★ 另外两个"量具来不及"的问题

- **验收脚本每天只跑 5 秒运动**：群游是**队形**，浪游目标每 4–12 秒换一次，
  5 秒量到的是"刚出生随机散布"（鱼苗公平对照 1.02）。改成 1800 帧/天（30 秒）后是 **0.52**。
- **参数扫描在单点、小样本上做**：早期几次扫描是在单个 13 天状态上换 `sense` 重跑 1800 帧，
  n = 3–9，结果不单调、噪声主导，**不能用**。有效做法见 `tools/probe-school.js`
  （16 天 × 1800 帧/天、每 60 帧采样，单进程跑一组参数，扫参数用 shell 起多进程）。

#### 定稿参数与实测

| 参数 | 值 | 依据 |
|---|---|---|
| `SCHOOL.senseFraction` | **0.25**（225px @900 短边） | 0.17 时鱼苗最近邻中位 86px、公平对照 0.72（截图看还是散开）；0.25 ⇒ **48px / 0.52**。再往上（0.35/0.45）**反而变差**（0.63）—— 感知圈一大就把非同伴圈进来，拉力方向被稀释 |
| `SCHOOL.weight.fry` / `.juvenile` | **3.0 / 2.0** | 唯一能把"松散聚集"推成"成群"的开关。5.0/3.0 判据不再变好，却把幼鱼压到 `最近邻/身半径` 只剩 2.9 |
| `SCHOOL.weight.elder` | −0.80 | 语义是「不加入同类群体」；配合单调形状，负权重**永远不会**变成吸引 |
| `SCHOOL.pullShape` | `hill` | 坑 1 |
| `SCHOOL.spaceScale` | subadult 1.35 / **elder 4.0** | 坑 3 |
| `SCHOOL.elderSpeedScale` | 0.72 | §6 老鱼「游速下降」 |

5 个种子复核（16 天 × 1800 帧/天）：

```
鱼苗公平对照      0.52 / 0.61 / 0.58 / 0.52 / 0.62   （判据 < 0.8）
老鱼隔离度        1.66 / 2.18 / 2.37 / 2.19 / 2.45   （判据 > 1.15）
最紧 最近邻/身半径 1.57 / 2.32 / 2.28 / 1.75 / 2.42   （判据 ≥ 1，防"贴成一坨"）
老鱼贴边率        0% × 5
```

**防回归的两条硬线**（都进了 `npm test`，253 项）：
- `tools/trace-motion.js` —— sha256 逐位守「手绘鱼的运动没被碰过」。
  手绘鱼没有 `stage` ⇒ 权重落回 0（内层分支跳过）、分离倍率落回 1（乘 1 是恒等）。
- `tools/check-stage-look.js` —— 47 项验收（外观 14 / 真种群 8 / 群游 7 / 卵群 14 / 隔离性 4）。

#### 还没做的（诚实清单）

- 「一池全是中等身量的鱼」这个观感**不会**出现：软上限 30 ⇒ 池里 30–34 尾；
  参考画的"小鱼"≈ 短边 4.9%，正落在我们的**成体**档（4.4%），
  而我们的鱼苗只有 0.33%、幼鱼 1.4% 且半透明。C 方案不改尺度，给的是完整体长金字塔。
- §11.2 层 10（flora 绘制顺序倒置，鱼压在荷叶上）、层 3（焦散是死图）、
  层 11/12/13/16（风纹 / 明暗带 / 碎光 / 池灯）均未动，见 `docs/VISUAL-GAP.md` §2。

## 8. Windows / Linux 无边框改造

本体早就写好自绘窗口条（`App.jsx` 的 `.window-bar`：拖动区 + 全屏/最小化/隐藏/关闭四个按钮），
但 `electron/main.cjs` 里 Windows 一直是 `frame: true`，只有 macOS 用 `titleBarStyle: 'hiddenInset'`
⇒ **Windows 上原生标题栏和自绘窗口条叠在一起**，等于白写。本次一并修掉。

| 文件 | 改动 |
|---|---|
| `electron/main.cjs` | 窗口参数改为平台分支：macOS 保留 `hiddenInset` + 红绿灯定位；其余平台 `frame: false, thickFrame: true`。⚠️ 不要给 macOS 也设 `frame: false`，那会连红绿灯一起去掉。`thickFrame` 保持 true 才有阴影和边缘缩放。 |
| `src/App.jsx` | `<main>` 加 `platform-${desktop.platform}` 类名，供样式按平台分叉 |
| `src/styles.css` | `.platform-win32 .window-drag,.platform-linux .window-drag{margin-left:8px}` —— `.window-drag` 原有 `margin-left:85px` 是给 macOS 红绿灯让位的，Windows 无边框后没有红绿灯，那 85px 会变成死区拖不动 |
| `src/lib/platform.js`（新增） | `isMacPlatform()` / `acceleratorLabel()` —— 快捷键备注从主进程的 `CommandOrControl+Shift+K` 渲染成 macOS 的 `⌘ ⇧ K` 或 Windows 的 `Ctrl + Shift + K`。原先三处文案把 ⌘ 写死了，Windows 用户看到的提示是错的。 |

### 8.1 验收判据（★ 反直觉）

| 判据 | 结果 |
|---|---|
| ✘ `WS_CAPTION` 样式位 | **不可用**：`frame: false` 后 Electron **保留** `WS_CAPTION \| WS_THICKFRAME` 位，改用 `WM_NCCALCSIZE` 把非客户区裁成 0。实测 `style = 0x14C70000` 明明含 `WS_CAPTION`，但非客户区是 0 —— 按样式位判会误报「有边框」。 |
| ✔ 窗口矩形 − 客户区矩形 = 0 | 实测 `1725x1125 @ (857,127)` vs 客户区 `1725x1125 @ (857,127)` ⇒ 非客户区 **高 0 / 宽 0**，且原点点重合。**✔ 无边框**。 |

（1725×1125 = 逻辑 1380×900 × DPI 1.25，与 `main.cjs` 的 `Math.min(1380, 工作区宽−60)` 一致。）

界面侧另用 CDP 读真实 DOM 复核：`platform-win32` 类名在位、`.window-bar` 高 36px 且可见、
`.window-drag` 的 `margin-left` 为 `8px`（不再是 85px）、`shortcut-note` 输出
`Ctrl + Shift + K 恢复控制 · Ctrl + Shift + F 投食`（无 ⌘）。脚本：`tools/check-frameless-ui.cjs`。

### 8.2 ★ 启动环境陷阱（本机必踩）

宿主环境（WorkBuddy / IDE 终端）会注入两个变量，任何一个在都会让 Electron 起不来：

| 变量 | 症状 | 处理 |
|---|---|---|
| `ELECTRON_RUN_AS_NODE=1` | Electron 退化成纯 Node，`require('electron')` 拿不到 `app` ⇒ `TypeError: Cannot read properties of undefined (reading 'setName')` | 启动前清空 |
| `NODE_OPTIONS=--require=.../node-language-shim.cjs` | 该 shim 在 Electron 主进程内报错 | 启动前清空 |

命令行方式：

```bash
env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS \
  VITE_DEV_SERVER_URL=http://127.0.0.1:5188/ \
  ./node_modules/electron/dist/electron.exe . --no-sandbox --disable-gpu-sandbox --no-proxy-server
```

`启动桌面版.cmd` 已同步补上 `set NODE_OPTIONS=`（原先只清了 `ELECTRON_RUN_AS_NODE`）。

另两条已在原脚本注释里记过的坑：必须走 **Vite dev server（5188）** 而不是 `file://dist/index.html`
（ESM 在 `file://` 下 origin 为 null，被 CORS 挡成 `ERR_FAILED (-2)`）；`--no-proxy-server`
避免系统代理拦截 127.0.0.1。

## 9. 附：池底素材无缝化方法（与本体无关，仅存档）

试验目录里为了修 `pond_bottom-9vD2ISIF.png`（其实是「1024 瓦片 × 2×2 预览图」，
且缝是断的：环绕横缝 67.42 vs 局部参照 7.90）写过 `make-seamless.py`（half-offset 融合）。

**本体用不到**：本体的底图是整张四季场景图（`public/assets/{spring,autumn,winter,pond}.png`），
不是可平铺瓦片。方法已沉淀进 `canvas-texture-integration` skill 第三·五步，含：
单次半幅偏移无法处处无缝（`prod` 窗环绕缝好、中心十字线漏；`max` 窗反之）与
「跨边界台阶 ÷ 自然起伏」的量化判据。
