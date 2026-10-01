/* ============================================================================
 * save-store.js —— 池塘存档的读写门面（§14.1 快照）
 * ----------------------------------------------------------------------------
 * 两条通道，互为备份：
 *   ① **文件**（主通道）：Electron 下走 IPC 写 userData/save.json
 *      —— 用户能自己看到、备份、删除；体积不受限。
 *   ② **localStorage**（兜底）：API 是同步的，所以 `beforeunload` 里来得及写。
 *      IPC 是异步的，关窗口那一刻发出去的请求很可能赶不上落盘。
 *
 * 读档时**取两者中较新的那份**（按 lastSeenWallClock 比），
 * 这样即使某次文件没写成功，也不会读到比 localStorage 更旧的档。
 * ========================================================================== */

const FALLBACK_KEY = 'fusheng-pond-save';
export const SAVE_ENVELOPE_VERSION = 1;

const isRecord = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const bridge = () => (typeof window !== 'undefined' ? window.pondDesktop : null);

/** 信封校验：外层与生态快照各自有版本号，可独立演进 */
function normalizeEnvelope(raw) {
  if (!isRecord(raw) || !isRecord(raw.pond)) return null;
  return {
    schemaVersion: Number.isFinite(raw.schemaVersion) ? raw.schemaVersion : 0,
    // F-14.2.1：离线补算全靠它
    lastSeenWallClock: Number.isFinite(raw.lastSeenWallClock) ? raw.lastSeenWallClock : null,
    pond: raw.pond,
    preferences: isRecord(raw.preferences) ? raw.preferences : {},
  };
}

function readFallback() {
  try {
    return normalizeEnvelope(JSON.parse(localStorage.getItem(FALLBACK_KEY)));
  } catch {
    return null;   // 存档被写坏/被清空 —— 当作没有
  }
}

function writeFallback(envelope) {
  try {
    localStorage.setItem(FALLBACK_KEY, JSON.stringify(envelope));
    return true;
  } catch {
    return false;  // 配额满 / 隐私模式
  }
}

async function readFile() {
  const api = bridge();
  if (!api?.loadSave) return null;
  try {
    return normalizeEnvelope(await api.loadSave());
  } catch {
    return null;
  }
}

/**
 * 读档。两条通道都读，取较新的那份。
 * @returns {Promise<{envelope:object|null, source:'file'|'fallback'|null}>}
 */
export async function loadPondSave() {
  const [file, fallback] = [await readFile(), readFallback()];
  if (!file && !fallback) return { envelope: null, source: null };
  if (!file) return { envelope: fallback, source: 'fallback' };
  if (!fallback) return { envelope: file, source: 'file' };

  const fileClock = file.lastSeenWallClock ?? 0;
  const fallbackClock = fallback.lastSeenWallClock ?? 0;
  return fallbackClock > fileClock
    ? { envelope: fallback, source: 'fallback' }
    : { envelope: file, source: 'file' };
}

/** 存档：先同步写兜底，再异步写文件（顺序无关，但这样即使 IPC 失败也有底） */
export async function writePondSave(envelope) {
  const ok = writeFallback(envelope);
  const api = bridge();
  if (!api?.writeSave) return ok;
  try {
    await api.writeSave(envelope);
    return true;
  } catch {
    return ok;
  }
}

/** 退出前的同步兜底（`beforeunload` 里只能调它，异步来不及）*/
export function writePondSaveSync(envelope) {
  return writeFallback(envelope);
}

/** 「重置池塘」时把两条通道一起清掉，否则下次启动又被旧档顶回来 */
export async function clearPondSave() {
  try { localStorage.removeItem(FALLBACK_KEY); } catch { /* 忽略 */ }
  const api = bridge();
  if (!api?.writeSave) return;
  try { await api.writeSave(null); } catch { /* 忽略 */ }
}
