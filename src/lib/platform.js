/** 平台相关的显示助手。
 *
 * 快捷键在主进程里用 Electron accelerator 注册（`CommandOrControl+Shift+K`），
 * 也就是 macOS 上是 ⌘、Windows/Linux 上是 Ctrl。界面文案不能把 ⌘ 写死，
 * 否则 Windows 用户看到的提示是错的。
 */
const MAC_KEYS = { CommandOrControl: '⌘', CmdOrCtrl: '⌘', Command: '⌘', Control: '⌃', Ctrl: '⌃', Alt: '⌥', Option: '⌥', Shift: '⇧' };
const PC_KEYS = { CommandOrControl: 'Ctrl', CmdOrCtrl: 'Ctrl', Command: 'Ctrl', Control: 'Ctrl', Ctrl: 'Ctrl', Alt: 'Alt', Option: 'Alt', Shift: 'Shift' };

/** 优先用主进程给的 platform；浏览器里退回 navigator 嗅探 */
export function isMacPlatform(platform) {
  if (platform) return platform === 'darwin';
  return typeof navigator !== 'undefined' && /Mac/.test(navigator.platform || '');
}

/** `CommandOrControl+Shift+K` → macOS `⌘ ⇧ K` / 其他平台 `Ctrl + Shift + K` */
export function acceleratorLabel(accelerator, platform) {
  if (!accelerator) return '';
  const mac = isMacPlatform(platform);
  const table = mac ? MAC_KEYS : PC_KEYS;
  const parts = String(accelerator).split('+').map((part) => part.trim()).filter(Boolean).map((part) => table[part] || part);
  return parts.join(mac ? ' ' : ' + ');
}
