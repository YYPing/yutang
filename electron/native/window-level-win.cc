// Windows 桌面层：把窗口挂进桌面外壳，落在"壁纸之上、桌面图标之下"。
// 对外暴露与 macOS 版 window-level.mm 完全相同的接口：setDesktopLevel(handle, enabled) -> int32
//
// Windows 没有 macOS 那样的"窗口层级"抽象，通用做法是往桌面外壳里塞窗口：
//   1) 找到 Progman（外壳桌面窗口）
//   2) 发未公开消息 0x052C，让系统分裂出一个用来承载壁纸的 WorkerW
//   3) SetParent 把自己的窗口挂进那个 WorkerW
// Lively Wallpaper / Wallpaper Engine 用的都是这条路。
//
// ⚠️ 0x052C 是未公开消息，Windows 大版本更新后可能失效；多显示器和虚拟桌面切换时
//    表现也不保证。所以：找不到 WorkerW 时返回 0，由调用方（main.cjs）降级回普通窗口。

#include <windows.h>
#include <node_api.h>

#include <cstring>
#include <unordered_map>

namespace {

// 记录原始样式与父窗口，退出桌面层时还原
std::unordered_map<HWND, LONG_PTR> g_originalStyle;
std::unordered_map<HWND, HWND> g_originalParent;

// 0x052C 请求外壳分裂出 WorkerW。幂等：已经分裂过时再发一次无副作用。
// 返回码：0 = 拿到容器；-1 = 找不到 Progman；-2 = 分裂后仍拿不到 WorkerW
int findWorkerW(HWND* outWorker) {
  HWND progman = FindWindowW(L"Progman", nullptr);
  if (!progman) return -1;
  SendMessageTimeoutW(progman, 0x052C, 0, 0, SMTO_NORMAL, 1000, nullptr);

  // ★ 反直觉的坑：网上流传的写法是 EnumWindows 扫【顶层】窗口、找含 DefView 的那个、
  //   再取它后面紧跟的 WorkerW。但 0x052C 分裂出来的 WorkerW 是 Progman 的【子窗口】，
  //   根本不在顶层窗口列表里。实测：这样写永远返回 -2（本机 Progman 子窗口里
  //   明明躺着 WorkerW=197174）。必须枚举 Progman 的子窗口。
  //
  //   Progman 子窗口的 Z 序（从上到下）实测为：
  //     SHELLDLL_DefView  → 桌面图标层
  //     WorkerW           → 壁纸层（我们要挂的容器，天然在图标层之下）
  //     ...我们挂进去的窗口
  HWND worker = nullptr;
  HWND child = nullptr;
  while ((child = FindWindowExW(progman, child, nullptr, nullptr)) != nullptr) {
    wchar_t cls[64] = {0};
    if (!GetClassNameW(child, cls, 64)) continue;
    if (_wcsicmp(cls, L"WorkerW") != 0) continue;
    // 跳过含图标层的那个（Windows 7 上 DefView 会被挪进某个 WorkerW）
    if (FindWindowExW(child, nullptr, L"SHELLDLL_DefView", nullptr)) continue;
    worker = child;
    break;
  }
  if (!worker) return -2;
  *outWorker = worker;
  return 0;
}

napi_value setDesktopLevel(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);

  bool isBuffer = false, enabled = false;
  if (argc != 2 || napi_is_buffer(env, argv[0], &isBuffer) != napi_ok || !isBuffer ||
      napi_get_value_bool(env, argv[1], &enabled) != napi_ok) {
    napi_throw_type_error(env, nullptr, "Expected a native window Buffer and a boolean.");
    return nullptr;
  }

  void* bytes = nullptr;
  size_t length = 0;
  napi_get_buffer_info(env, argv[0], &bytes, &length);
  if (length < sizeof(HWND)) {
    napi_throw_error(env, nullptr, "Window handle buffer is too small.");
    return nullptr;
  }
  HWND hwnd = nullptr;
  std::memcpy(&hwnd, bytes, sizeof(hwnd));
  if (!IsWindow(hwnd)) {
    napi_throw_error(env, nullptr, "Invalid native window handle.");
    return nullptr;
  }

  int32_t level = 0;
  if (enabled) {
    HWND worker = nullptr;
    int rc = findWorkerW(&worker);
    bool putBottom = false;
    if (rc == -2) {
      // 退化方案：直接挂进 Progman 并置于子窗口栈底部。
      // ⚠️ 实测这条路**画面不可见**：Progman 的子窗口栈里 WorkerW(壁纸层) 会盖在
      //    最底部子窗口之上，HWND_BOTTOM 等于把自己塞到壁纸底下。
      //    仅保留以防个别 Shell 环境结构不同 —— 正常路径应走上面的 WorkerW。
      worker = FindWindowW(L"Progman", nullptr);
      putBottom = worker != nullptr;
      rc = putBottom ? 0 : -2;
    }
    if (rc != 0) {
      // 细分码：-1 找不到 Progman / -2 拿不到 WorkerW，让调用方据此降级并给出准确提示
      napi_value result;
      napi_create_int32(env, rc, &result);
      return result;
    }
    if (!g_originalStyle.count(hwnd)) {
      g_originalStyle[hwnd] = GetWindowLongPtr(hwnd, GWL_STYLE);
      g_originalParent[hwnd] = GetParent(hwnd);
    }
    // 挂进 WorkerW 必须带 WS_CHILD，否则不会跟随桌面层行为
    LONG_PTR style = GetWindowLongPtr(hwnd, GWL_STYLE);
    SetWindowLongPtr(hwnd, GWL_STYLE, (style | WS_CHILD) & ~WS_POPUP);
    SetParent(hwnd, worker);
    // 铺满整个虚拟屏幕（多显示器一起覆盖）
    const int x = GetSystemMetrics(SM_XVIRTUALSCREEN);
    const int y = GetSystemMetrics(SM_YVIRTUALSCREEN);
    const int w = GetSystemMetrics(SM_CXVIRTUALSCREEN);
    const int h = GetSystemMetrics(SM_CYVIRTUALSCREEN);
    // 走 Progman 兜底时必须显式给 HWND_BOTTOM（此时不能带 SWP_NOZORDER，否则插入位置被忽略）
    if (putBottom) {
      SetWindowPos(hwnd, HWND_BOTTOM, x, y, w, h, SWP_NOACTIVATE | SWP_SHOWWINDOW);
    } else {
      SetWindowPos(hwnd, nullptr, x, y, w, h, SWP_NOZORDER | SWP_NOACTIVATE | SWP_SHOWWINDOW);
    }
    level = 1;
  } else {
    auto styleIt = g_originalStyle.find(hwnd);
    if (styleIt != g_originalStyle.end()) {
      SetParent(hwnd, g_originalParent.count(hwnd) ? g_originalParent[hwnd] : nullptr);
      SetWindowLongPtr(hwnd, GWL_STYLE, styleIt->second);
      g_originalStyle.erase(styleIt);
      g_originalParent.erase(hwnd);
    }
    SetWindowPos(hwnd, HWND_TOP, 0, 0, 0, 0,
                 SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW);
    level = 0;
  }

  napi_value result;
  napi_create_int32(env, level, &result);
  return result;
}

napi_value init(napi_env env, napi_value exports) {
  napi_value fn;
  napi_create_function(env, "setDesktopLevel", NAPI_AUTO_LENGTH, setDesktopLevel, nullptr, &fn);
  napi_set_named_property(env, exports, "setDesktopLevel", fn);
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
