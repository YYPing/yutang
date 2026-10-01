/* ============================================================================
 * genes.js —— §8.3 基因型与遗传
 * ----------------------------------------------------------------------------
 * ★ 口径漂移警告（本文件按 v4 定稿，两处既有代码与此不一致，须收敛）：
 *   - v4 §8.3 / §11.3 的 8 品系：红白 / 大正三色 / 昭和三色 / 黄金 / 浅黄 / 乌鲤 / 丹顶 / 写鲤
 *   - Desktop 版（scene/index.pixi.html）用的是：红白/大正/昭和/黄金/白金/绯鲤/白写/乌鲤
 *     ⇒ 多出「白金 / 绯鲤 / 白写」，缺少「浅黄 / 丹顶 / 写鲤」
 *   - fish-poc（js/fish-gen.js）只有 7 个：红白/白写/三色/纯红/乌鲤/金橙/纯白
 *     ⇒ 多出「纯红 / 金橙 / 纯白」，缺少「大正三色 / 浅黄 / 丹顶 / 写鲤」
 *   本文档为基线 ⇒ **以 v4 为准**。品系权重按 §8.3「白底系 4–5、深色系 1–2」配。
 * ========================================================================== */

import { GROWTH, BREED } from './constants.js';

/** §8.3 八品系。light=true 为白底系（权重 4–5），false 为深色系（权重 1–2）*/
export const PALETTES = [
  { id: 'kohaku',  name: '红白',     weight: 5.0, light: true  },
  { id: 'taisho',  name: '大正三色', weight: 4.0, light: true  },
  { id: 'showa',   name: '昭和三色', weight: 1.5, light: false },
  { id: 'ogon',    name: '黄金',     weight: 4.0, light: true  },
  { id: 'asagi',   name: '浅黄',     weight: 2.0, light: false },
  { id: 'karasu',  name: '乌鲤',     weight: 1.0, light: false },
  { id: 'tancho',  name: '丹顶',     weight: 4.5, light: true  },
  { id: 'utsuri',  name: '写鲤',     weight: 1.5, light: false },
];

export const PALETTE_BY_ID = Object.fromEntries(PALETTES.map((p) => [p.id, p]));

/** §8.3 基因位定义：位名 → [下限, 上限]（PATTERN_SEED / COLOR_PALETTE 特殊处理）*/
export const GENE_RANGES = {
  sizeLinf: GROWTH.sizeLinfRange,      // 0.8–1.2
  growthK: GROWTH.growthKRange,        // 0.85–1.15
  lifespan: [0.8, 1.2],
  fecundity: [0.8, 1.2],
  appetite: [0.8, 1.2],
  variegation: [0, 1],
};

/** 随机生成一套基因（rng 必须来自可复现随机源）*/
export function randomGenes(rng) {
  return {
    patternSeed: rng.int(1, 2 ** 31 - 1),
    palette: rng.pickWeighted(PALETTES).id,
    variegation: rng.range(0, 1),
    sizeLinf: rng.range(...GENE_RANGES.sizeLinf),
    growthK: rng.range(...GENE_RANGES.growthK),
    lifespan: rng.range(...GENE_RANGES.lifespan),
    fecundity: rng.range(...GENE_RANGES.fecundity),
    appetite: rng.range(...GENE_RANGES.appetite),
  };
}

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

/**
 * §8.3 遗传：每位随机取父或母，5% 概率 ±10% 突变，PATTERN_SEED 重 roll。
 * 注意：突变是在「选中父或母的值」上做 ±10%，不是重新随机 —— 否则世代间不连续。
 */
export function inheritGenes(father, mother, rng) {
  const take = (key, range) => {
    let v = rng.chance(0.5) ? father.genes[key] : mother.genes[key];
    if (rng.chance(BREED.mutationChance)) {
      const mult = rng.range(1 - BREED.mutationSpan, 1 + BREED.mutationSpan);
      v = clamp(v * mult, range[0], range[1]);
    }
    return v;
  };

  return {
    patternSeed: rng.int(1, 2 ** 31 - 1),      // 重 roll
    palette: rng.chance(0.5) ? father.genes.palette : mother.genes.palette,
    variegation: take('variegation', GENE_RANGES.variegation),
    sizeLinf: take('sizeLinf', GENE_RANGES.sizeLinf),
    growthK: take('growthK', GENE_RANGES.growthK),
    lifespan: take('lifespan', GENE_RANGES.lifespan),
    fecundity: take('fecundity', GENE_RANGES.fecundity),
    appetite: take('appetite', GENE_RANGES.appetite),
  };
}

/** §6 性别：按趋近 1:1 加权随机（§9.1 性别纠偏）*/
export function rollSex(rng, worldSexBalance = 0) {
  // worldSexBalance > 0 表示雄性偏多 ⇒ 降低雄性概率
  const pMale = clamp(0.5 - worldSexBalance * 0.25, 0.2, 0.8);
  return rng.chance(pMale) ? 'M' : 'F';
}
