#!/usr/bin/env bash
# 投喂感应圈（F-2.8）的真窗口全链路验收 —— 自包含：起 dev server → 核对缓存 → 起窗口 → 跑断言 → 清理。
#
# ⚠️ 为什么必须重启 dev server：
#   Vite 的 transform 缓存**不一定随文件编辑失效**。实测改完 pond.js 后，dev server 返回的
#   产物里只有 `this.drawFeedCircles()` 的调用、没有方法定义 ⇒ 真窗口当场白屏：
#       TypeError: this.drawFeedCircles is not a function
#   而 `node --test` 和 `vite build` 都直接读磁盘源码，**发现不了这个断层** ——
#   只有真窗口能暴露。所以这里先重启、再核对产物与磁盘是否一致，对不上就直接判失败。
#
# 跑法：bash tools/check-feed-full.sh [PORT]
set -u
cd "$(dirname "$0")/.."
PORT="${1:-9223}"
ELECTRON="./node_modules/electron/dist/electron.exe"
VITE_PID=""

cleanup() {
  taskkill //F //IM electron.exe >/dev/null 2>&1 || true
  [ -n "$VITE_PID" ] && taskkill //F //PID "$VITE_PID" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "[1/4] 重启 dev server（Vite 的 transform 缓存可能滞后于磁盘）"
OLD=$(netstat -ano | grep ':5188 .*LISTENING' | awk '{print $5}' | head -1)
[ -n "$OLD" ] && taskkill //F //PID "$OLD" >/dev/null 2>&1
sleep 2
npm run dev >/tmp/koi-vite.log 2>&1 &
sleep 14
if ! netstat -ano | grep -q ':5188 .*LISTENING'; then
  echo "✘ dev server 未起来，日志："; tail -20 /tmp/koi-vite.log; exit 1
fi
VITE_PID=$(netstat -ano | grep ':5188 .*LISTENING' | awk '{print $5}' | head -1)
echo "  dev server 已就绪（PID $VITE_PID）"

echo "[2/4] 核对 dev server 产物与磁盘源码一致（防缓存滞后）"
check_sym() {
  local file="$1" sym="$2" disk served
  disk=$(grep -c "$sym" "$file")
  served=$(curl -s "http://127.0.0.1:5188/$file" | grep -c "$sym")
  if [ "$disk" != "$served" ]; then
    echo "  ✘ $file 的「$sym」：磁盘 $disk 处 / dev server $served 处 —— 缓存没刷新"; return 1
  fi
  echo "  ✔ $file「$sym」一致（$disk 处）"
}
FAILED=0
check_sym src/engine/pond.js drawFeedCircles || FAILED=1
check_sym src/engine/simulation.js feedCircles || FAILED=1
check_sym src/engine/eco/constants.js FEED_CIRCLE || FAILED=1
[ "$FAILED" = "0" ] || { echo "✘ 产物与源码不一致，先修缓存再验"; exit 1; }

echo "[3/4] 起真窗口"
taskkill //F //IM electron.exe >/dev/null 2>&1 || true
sleep 1
# ★ 必须 env -u：宿主会注入 ELECTRON_RUN_AS_NODE（Electron 退化成纯 Node）与
#   NODE_OPTIONS（其中的 shim 在 Electron 内报错）。置空（VAR=）不管用。
env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS \
  VITE_DEV_SERVER_URL=http://127.0.0.1:5188/ \
  "$ELECTRON" . --no-sandbox --disable-gpu-sandbox --no-proxy-server \
  --remote-debugging-port="$PORT" >/tmp/koi-feed.log 2>&1 &
sleep 12

echo "[4/4] 跑断言"
node tools/check-feed-ui.cjs "$PORT"
CODE=$?
echo "=== check-feed-full 退出码 $CODE ==="
exit "$CODE"
