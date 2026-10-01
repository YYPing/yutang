#!/usr/bin/env bash
# 存档全链路端到端验收（三段式，因为中间必须**真的重启进程**）。
#
# 为什么不能在一个进程里 page.reload()：reload 会触发 beforeunload，
# 那个处理器拿 Date.now() 把墙钟时间重写一遍，刚回拨的「3 天前」当场被冲掉。
# 为什么必须优雅退出而不是 taskkill /F：Chromium 的 localStorage 异步刷盘，
# 强杀会丢掉最近一次写入（回拨的值根本没落盘）。
#
# 前置：Vite dev server 已在 5188 监听（可用 启动桌面版.cmd 的前半段起）。
# 跑法：bash tools/check-save-full.sh [PORT]
set -u
cd "$(dirname "$0")/.."
PORT="${1:-9223}"
ELECTRON="./node_modules/electron/dist/electron.exe"

launch() {
  # ★ 必须 env -u：宿主会注入 ELECTRON_RUN_AS_NODE（Electron 退化成纯 Node）与
  #   NODE_OPTIONS=--require=...shim.cjs（shim 在 Electron 内报错）。
  #   置空（VAR=）不管用 —— Electron 仍按 Node 模式跑。
  env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS \
    VITE_DEV_SERVER_URL=http://127.0.0.1:5188/ \
    "$ELECTRON" . --no-sandbox --disable-gpu-sandbox --no-proxy-server \
    --remote-debugging-port="$PORT" >/tmp/koi-electron.log 2>&1 &
  disown 2>/dev/null || true
}

running() { tasklist //FI "IMAGENAME eq electron.exe" 2>/dev/null | grep -q electron.exe; }

kill_all() { taskkill //F //IM electron.exe >/dev/null 2>&1 || true; }

netstat -ano | grep -q ':5188 .*LISTENING' || { echo "✘ 5188 未监听：请先起 Vite dev server"; exit 1; }

echo "[1/4] 起窗口"
kill_all; sleep 1; launch; sleep 8

echo "[2/4] seed（开生态 / 设倍速 / 等落盘 / 回拨两条通道 / 优雅退出）"
node tools/check-save-ui.cjs "$PORT" seed || { echo "✘ seed 阶段未通过"; exit 1; }

echo "[3/4] 等进程退干净，再压磁盘存档"
for _ in $(seq 1 15); do running || break; sleep 1; done
if running; then echo "   ⚠️ 优雅退出没完成，兜底强杀（localStorage 可能没刷盘）"; kill_all; sleep 2; fi
node tools/check-save-ui.cjs "$PORT" rewind-file || { echo "✘ 回拨失败"; exit 1; }

echo "[4/4] 冷启动 restore（断言归来摘要 + 重置二次确认）"
launch; sleep 8
node tools/check-save-ui.cjs "$PORT" restore
