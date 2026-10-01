/* ============================================================================
 * rng.js —— 可复现随机
 * ----------------------------------------------------------------------------
 * ★ 为什么不用 Math.random：离线补算（F-14.2）会按时间戳重跑一段模拟，
 *   若随机不可复现，同一条鱼补算前后的花纹/基因会跳变 —— 存档就废了。
 *   依据：DESIGN_v1 P3「时间即 tick」，世界状态必须可由 (seed, tick) 完全决定。
 *
 * 算法：mulberry32（32 位状态、周期 2^32、分布足够、单文件无依赖）。
 * ========================================================================== */

/** 创建一个带 seed 的随机源。同一 seed 必然产出同一序列。 */
export function makeRng(seed = 1) {
  let s = seed >>> 0;
  if (s === 0) s = 0x9e3779b9;   // 全 0 状态会退化，换一个非零常量

  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  return {
    /** [0,1) */
    next,
    /** [a,b) 浮点 */
    range: (a, b) => a + next() * (b - a),
    /** [a,b] 整数 */
    int: (a, b) => a + Math.floor(next() * (b - a + 1)),
    /** 概率 p 命中 */
    chance: (p) => next() < p,
    /** 从数组按 weight 字段加权抽取 */
    pickWeighted(items, weightKey = 'weight') {
      const total = items.reduce((s, it) => s + it[weightKey], 0);
      let r = next() * total;
      for (const it of items) {
        r -= it[weightKey];
        if (r <= 0) return it;
      }
      return items[items.length - 1];
    },
    /** 抽取数组元素 */
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    /** 当前内部状态（用于存档/续算） */
    state: () => s,
    /**
     * 从存档恢复内部状态（与 state() 配对）。
     * ★ 必须恢复：不恢复的话，读档后随机序列从头开始 ——
     *   同一条鱼的花纹/性别/突变会在读档瞬间跳变，存档等于白存。
     * 状态 0 被 makeRng 视为退化值，所以忽略 0 而不是写入。
     */
    restore(value) {
      const next = Number(value) >>> 0;
      if (next !== 0) s = next;
      return s;
    },
  };
}

/** 32 位整数哈希：用于「由 id 派生子随机流」，避免全局序列互相干扰 */
export function hash32(a, b = 0, c = 0) {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^
          Math.imul(c | 0, 0x9e3779b1);
  h ^= h >>> 15; h = Math.imul(h, 0x2545f491); h ^= h >>> 13;
  return h >>> 0;
}
