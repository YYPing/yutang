# 2.5.0 桌面投食入口显形

## 背景

用户反馈桌面应用（尤其壁纸模式）看不到「抢食」——浏览器里能投食、鱼会抢，桌面端却不行。根因是壁纸模式开启鼠标穿透（`setIgnoreMouseEvents(true)`）且 HUD 收起，点水面不会触发投食；浏览器普通页面点击照常工作。本次采用 A 方案，让壁纸投食入口显形。

## 实际改动

- `src/App.jsx`：新增 `feedHint` 状态。进入桌面模式时显示提示，12 秒后自动淡出；一旦发生投食立即隐藏。渲染独立的 `.feed-hint-desktop` 提示「移动鼠标到池塘上 · 按 Ctrl+Shift+F 撒食，鱼群会游过来抢食」。
- `src/styles.css`：新增 `.feed-hint-desktop`，刻意独立于 `.hud`，壁纸模式下仍可见；玻璃质感、底部居中、`feedHintIn` 淡入动画。
- `electron/main.cjs`：菜单项改名为「撒一把鱼食」，点击 `sendPointer('feed', null, 'menu', true)` 在池塘中央投食；状态栏与托盘提示文案补充 `Ctrl+Shift+F`。该全局投食快捷键（macOS 为 `⌘+Shift+F`）早已实现，只是此前未被发现。
- 投食感应圈与抢食逻辑复用既有实现（特征常数 **2.35** 含抢食提速），桌面与网页两处行为一致。

## 已执行验证

- 构建：`CODEBUDDY_SAFE_DELETE_ENABLED=0 npm run build` 成功；`dist` 含改动（grep `feed-hint-desktop` / `Ctrl+Shift+F` / `2.35` 均命中）。
- 桌面启动：`NODE_OPTIONS= npm run check:desktop` 与一次性 `verify_boot.cjs` 均 8/8 通过（标题 `浮生 · 摸鱼桌面`、0 异常、canvas 2 个、root 1 子节点、非客户区 0×0、亮度 std≈22）。
- 壁纸穿透下的点击投食此前已在 `electron/interaction-smoke.cjs` 实测生效；浏览器点击投食不受影响。

## 复验

```sh
CODEBUDDY_SAFE_DELETE_ENABLED=0 npm run build
NODE_OPTIONS= npm run check:desktop
```

> 注：应用内显示的版本号在构建期从 `package.json` 读取；本次仅更新源码版本与文档，未重新打包，正式包内的版本字符串需下次构建后生效。
