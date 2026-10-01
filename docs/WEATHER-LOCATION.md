# 天气城市定位（自动定位）

> 覆盖：天气面板里「按网络定位城市 / 使用我的位置 / 重新定位」这一条链路。
> 代码位置：`src/lib/environment.js`（源与降级链）· `src/hooks/useEnvironment.js`（状态机）·
> `src/components/WeatherPanel.jsx`（交互）· `src/lib/storage.js` 的 `normalizeCity`（存档）· `index.html`（CSP）

## 1. 为什么要重做

改造前是**单源 + 只跑一次 + 没有出口**：

| 问题 | 后果 |
| --- | --- |
| 只有一个源 `ipwho.is` | 它一被墙 / 限流 / 改契约，用户永久停在兜底武汉 |
| 只在首次启动跑一次 | 换了网络（家 → 公司 → 热点）不会跟随 |
| 失败后没有任何重试入口 | 面板里连一个「再试一次」的按钮都没有 |
| 局域网 `http://` 走 `navigator.geolocation` | 非安全上下文下浏览器**必然拒绝**，且没有降级到 IP |

## 2. 三条通路

| 层 | 文件 | 职责 | 不做 |
| --- | --- | --- | --- |
| 源 | `environment.js` | 四个源的 URL 与 `parse()`，串行降级 | 不知道 UI 状态 |
| 状态 | `useEnvironment.js` | 何时定位 / 何时重试 / 何时刷新 / 结果怎么落地 | 不碰 DOM |
| 交互 | `WeatherPanel.jsx` | 按钮文案、失败原因、把用户点击变成一次 `locate()` | 不自己发定位请求 |

## 3. 降级链（顺序是实测结论，不是拍脑袋）

本机出口 IP `112.20.10.15`（中国移动 AS56046）在各家库里的归属：

| 源 | 城市 | 中文 | 备注 |
| --- | --- | --- | --- |
| **`api.bigdatacloud.net`**（链首） | **泰州市 / 高港区** | ✔（`localityLanguage=zh`） | 唯一到「区」级，且与所在地一致 |
| `ipwho.is` | 北京 | ✔（`lang=zh-CN`） | 在 Node `fetch` 下间歇性超时（沙箱代理导致） |
| `ipwhois.app` | 北京 | ✘ | 返 `"Beijing"`，靠反查表换回中文 |
| `geolocation-db.com` | 北京 | ✘ | 失败时不报错，返一堆 `null` —— 靠坐标校验兜住 |

⚠️ 这个结论来自**单个网络观测点**。换运营商 / 换城市后如果发现链首反而更粗，把 `ipwho.is` 挪到第一位即可 ——
顺序是纯数据（`LOCATION_PROVIDERS`），别处没有依赖它。

预算：单源 `LOCATION_TIMEOUT_MS = 5s`，整条链 `LOCATION_BUDGET_MS = 12s`。
串行而不是并行，因为**优先级本身就是答案的一部分**（更细的源更该赢）；首选可用就只花一次往返。

## 4. ★ CSP 白名单：最容易沉默失效的地方

`index.html` 的 `Content-Security-Policy` 里 `connect-src` 是**逐 host 白名单**：

```
connect-src 'self' ws://127.0.0.1:* https://api.open-meteo.com https://geocoding-api.open-meteo.com
            https://api.bigdatacloud.net https://ipwho.is https://ipwhois.app https://geolocation-db.com
```

**坑**：新增定位源时如果忘了往这里加一条，浏览器在 DNS 之前就把请求拦掉 ——
请求**根本不会发出**，所以：

- `vite build` 绿；
- `node --test` 绿（单测跑在 Node 里，没有 CSP）；
- 真机上表现为「第一个源永远失败，直接跳到第二个」，看起来像"那个源挂了"，其实是整条链在空转。

本轮就是这么被坑的：链首 `bigdatacloud` 从来没被请求过，只有 CSP 里已有的 `ipwho.is` 通。
**只有真机 UI 检查抓得到它**（`tools/check-location-ui.cjs`：`page.route` 拿不到请求 = 请求没发出）。

已加的护栏：`tests/environment.test.js` 里一条断言，遍历 `LOCATION_PROVIDERS`，
要求每个 `provider.request().origin` 都在 `connect-src` 里。加源不同步改 CSP 会直接变红。

## 5. 状态机

`locationStatus`（城市**来源**）· `locationBusy`（有无请求在飞）· `locationError`（失败原因，给面板显示）

| locationStatus | 含义 | 何时进入 |
| --- | --- | --- |
| `locating` | 正在首启动定位 | 没有存档城市 |
| `approximate` | 城市来自网络定位 | 定位成功后落盘 |
| `saved` | 用户自己选的 | 搜索选城 / 手动 |
| `fallback` | 还没拿到城市，先用武汉兜底 | 首启动定位失败 |

三条不变式（都有单测/UI 检查兜着）：

1. **`manualPick ⇔ 当前城市不是"按网络定位来的"`** —— 用户手选 → 自动定位永不覆盖；定位落地 → 交还给自动跟随。
   所以「手选之后又点了『重新定位』并成功」不需要额外分支。
2. **兜底不是城市，是"还没有城市"** —— 定位失败**不写存档**，武汉只是兜底；
   否则下次启动会被当成"用户选过武汉"，再也不会自动定位。
3. **静默刷新失败不报错** —— 用户没点任何东西，弹红字只会让人以为程序坏了；它自己按退避重试。

时效力：`LOCATION_TTL_MS = 6h`（`city.locatedAt`）。到期后：
- 启动时静默刷新一次（**没有 `locatedAt` 也算过期** ⇒ 旧版本存档天然会在升级后刷一次）；
- 每 `15min`（与天气刷新同频）以及窗口 `focus` / `visibilitychange` 时检查一次；
- 保鲜期内一次都不打（否则每开一次就重定位一遍）。

退避：`15s → 1min → 5min`，三档用完就停下等用户点「重新定位」。
★ 退避窗口里 `focus` / `visibilitychange` 的检查一律让位给定时器，否则会绕开退避变成"一分钟试十次"。
★ 天气刷新成功 = 网络回来了 ⇒ 顺手解锁退避，让下一次检查能重试（不然"网络恢复了但定位还在罚站"）。

## 6. 三类页面原点走的分支（不一样，别混）

| 原点 | `window.pondDesktop` | 走哪条 | 按钮文案 |
| --- | --- | --- | --- |
| 桌面应用（`file://`） | 存在 | 按 IP 定位 | 按网络定位城市 / 重新定位 |
| 局域网 `http://192.168.x.x` | 不存在 | `isSecureContext === false` ⇒ 降级到 IP 定位 | 按网络定位城市 / 重新定位 |
| 本地 `http://127.0.0.1` | 不存在 | 安全上下文 ⇒ 优先问浏览器拿精确位置 | 使用我的位置 |

★ 局域网 `http://` 下 `navigator.geolocation` **必然被拒**，那不是"用户没给权限" ——
硬走它只会弹一句误导的话。所以判断条件是 `!pondDesktop && navigator.geolocation && window.isSecureContext`。
★ 首启动时**一律**先用 IP 拿一个城市（不弹权限、不留空白），精确位置只放在用户主动点的按钮上。

## 7. 验收

```
npm test                       # 259 项，含 CSP 白名单断言与降级链 6 条
npm run check:location         # 真 Chromium + 真 App + 拦截四个源，28 项
```
`check:location` 覆盖：首启动落盘与时效时间戳 / 只打链首一次 / 全失败不写存档且四个源都试过 /
兜底后点一下能救回来 / 手选城市零请求 / 过期静默刷新 / 保鲜期不打扰 / 三类原点各走对分支。
先 `npm run build`。
