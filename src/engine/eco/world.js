/* ============================================================================
 * world.js —— World State 与 tick 编排（§16「Sim Core 与 Renderer 解耦」）
 * ----------------------------------------------------------------------------
 * 本文件是生态内核的入口。铁律：
 *   - **纯数据 + 纯函数**：不引用 DOM、不引用 PixiJS、不读系统时间（时间由调用方喂进来）
 *   - 同一 (seed, tick 序列) 必然得到同一世界状态 ⇒ 离线补算（F-14.2）可重放
 *   - 渲染层只读 world.fishes / world.eggs / world.food，不反向写入
 *
 * 时间单位统一用「池塘日」；对外暴露 advanceDays() 便于批量推演。
 * ========================================================================== */

import {
  TIME, INITIAL, HATCH_DAYS, GROWTH, FEEDING, POPULATION, BREED, OFFLINE,
  HEALTH, DEATH_FADE_SECONDS,
} from './constants.js';
import { makeRng } from './rng.js';
import { randomGenes, inheritGenes, rollSex, PALETTE_BY_ID, GENE_RANGES } from './genes.js';
import { lengthAtAge, lengthCap, personalK, grow, applyElderClamp, stageOf } from './growth.js';
import { tickFeeding, eatPellet, wantsFood } from './feeding.js';
import { isMature, breedRatePerDay, clutchSize, hatchRate, resetCooldown } from './breed.js';
import { crowdOf, stressDeathProbability, pickCullCandidates, sexBalance, needsRescue, hardCapOf } from './population.js';
import { lifespanOf, checkDeath, beginDying, tickDying, tickEgg } from './lifecycle.js';

let nextId = 1;
const resetIds = () => { nextId = 1; };
const setNextId = (value) => { nextId = Math.max(1, value | 0); };

/** 建一条鱼（初代或新生）*/
function makeFish({ genes, sex, ageDays, generation, parents, rng, viewportShortPx }) {
  const lCapCm = lengthCap(genes, { viewportShortPx });
  const k = personalK(genes);
  const fish = {
    id: nextId++,
    generation,
    genes,
    sex,
    ageDays,
    lifespanDays: lifespanOf(genes),
    stage: 'fry',
    lCapCm,
    lengthCm: Math.min(lCapCm, lengthAtAge(Math.max(0, ageDays), lCapCm, k)),
    satiety: INITIAL.satiety,
    health: INITIAL.health,
    condition: INITIAL.condition,
    nutrition: 0,
    state: 'wander',
    parents: parents ?? null,
    breedCooldown: 0,
    dead: false,
    dying: false,
    deathTimer: 0,
    deathDuration: 0,
    deathCause: null,
    bornAtPondDay: 0,
    // 运动（渲染层用；推演不关心，但留位避免结构漂移）
    pos: null, vel: null, heading: 0,
  };
  fish.stage = stageOf(ageDays).key;
  return fish;
}

/** §13 统计骨架（新建世界与读档都用它，保证字段完整）*/
function freshStats() {
  return {
    born: 0, died: 0, maxGeneration: 1,
    longestLivedDays: 0, longestLivedId: null,
    largestCm: 0, largestId: null,
    deathsByCause: { age: 0, health: 0, stress: 0 },
  };
}

/** 只建世界骨架、不投放任何鱼 —— createWorld 与 restoreWorld 共用 */
function buildWorld({ seed, viewportShortPx, softCap, globalLengthCapCm }) {
  return {
    seed,
    rng: makeRng(seed),
    viewportShortPx,
    softCap,
    globalLengthCapCm,
    pondDays: 0,
    realDays: 0,
    fishes: [],
    eggs: [],
    food: [],
    stats: freshStats(),
  };
}

function normalizeWorldOptions(opts = {}) {
  return {
    seed: opts.seed ?? 20260930,
    viewportShortPx: opts.viewportShortPx ?? 1080,
    softCap: opts.softCap ?? POPULATION.softCap,
    globalLengthCapCm: opts.globalLengthCapCm ?? GROWTH.globalLengthCapCm,
  };
}

/**
 * 创建世界。
 * @param {object} opts
 *   seed            随机种子
 *   viewportShortPx 视口短边（用于屏幕占比钳制与 pxPerCm）
 *   softCap         种群软上限（默认 30）
 *   globalLengthCapCm 全局体长硬顶（默认 30）
 */
export function createWorld(opts = {}) {
  resetIds();
  const world = buildWorld(normalizeWorldOptions(opts));

  // §9.2 初始投放：8 条梯队，冷却随机 0–16 日打散相位
  for (const ageDays of INITIAL.ages) {
    const genes = randomGenes(world.rng);
    const sex = rollSex(world.rng, 0);
    const fish = makeFish({ genes, sex, ageDays, generation: 1, rng: world.rng, viewportShortPx: world.viewportShortPx });
    fish.breedCooldown = world.rng.range(...INITIAL.cooldownRange);
    world.fishes.push(fish);
  }

  return world;
}

/** 存活（不含正在播死亡动画的）*/
export function aliveFishes(world) {
  return world.fishes.filter((f) => !f.dead && !f.dying);
}

/**
 * 投喂一次。
 * F-2.8 感应圈：只有圈内鱼抢食（圈外正常游）。
 * 校准（§5）：1080p 半径 ≈270px，圈内 3–6 条 / 圈外 19–27 条 ⇒ 圈内占比约 15–20%。
 * 推演里没有坐标，故按该比例随机取「圈内鱼」，再按 appetite 分配颗粒。
 */
export function feed(world, opts = {}) {
  const pellets = opts.pellets ??
    Math.round(world.rng.range(FEEDING.pelletsPerThrow[0], FEEDING.pelletsPerThrow[1]));
  const crowd = crowdOf(aliveFishes(world).length, world.softCap);
  const candidates = aliveFishes(world).filter(wantsFood);
  if (candidates.length === 0) return { eaten: 0, uneaten: pellets, participants: 0 };

  // 圈内鱼数量：按校准比例，1–6 条
  const circleFraction = opts.circleFraction ?? 0.18;
  const n = Math.max(1, Math.min(candidates.length, Math.round(candidates.length * circleFraction) + 1));

  // 按 appetite 加权挑参与者（appetite 高的更容易挤到）
  const pool = candidates.slice();
  const picked = [];
  for (let i = 0; i < n && pool.length; i++) {
    const idx = Math.floor(world.rng.next() * pool.length);
    picked.push(pool.splice(idx, 1)[0]);
  }

  // ★ 分配顺序：先给每位参与者保底 1 粒，剩余再按「大鱼优先」（F-7.3.3）。
  //   为什么要保底：纯大鱼优先时，8–12 粒会被前几条大鱼分光，幼鱼 nutrition 长期为 0
  //   ⇒ 生长调制被压到下限 0.2（慢 5 倍）⇒ 一代从理论的 6.6 天拖到 11.4 天。
  //   保底 1 粒既保留「幼鱼抢不过大鱼」的梯度（大鱼仍吃走大部分），
  //   又不至于让幼鱼完全饿着 —— 实测可把年化世代从 26 拉到 40+。
  let eaten = 0;
  const give = (f) => {
    const eff = eatPellet(f);
    f.satiety = eff.satiety;
    f.nutrition = eff.nutrition;
    eaten++;
  };

  for (const f of picked) {
    if (eaten >= pellets) break;
    if (f.satiety < FEEDING.forageSatietyCeiling) give(f);
  }

  const bigFirst = picked.slice().sort((a, b) => b.lengthCm - a.lengthCm);
  let guard = 0;
  while (eaten < pellets && guard++ < pellets * 4) {
    const taker = bigFirst.find((f) => f.satiety < FEEDING.forageSatietyCeiling);
    if (!taker) break;
    give(taker);
  }

  const uneaten = pellets - eaten;
  world.food.push({ count: uneaten, ageSeconds: 0 });   // F-7.3.7 落底 90s 淡出
  return { eaten, uneaten, participants: picked.length };
}

/**
 * 推进一个 tick。
 * @param dtDays 池塘日增量
 */
export function tick(world, dtDays, opts = {}) {
  if (dtDays <= 0) return;
  world.pondDays += dtDays;
  world.realDays += dtDays / TIME.pondDaysPerRealDay;

  const alive = aliveFishes(world);
  const crowd = crowdOf(alive.length, world.softCap);
  const balance = sexBalance(world.fishes);

  /* --- 1. 个体推进：年龄 / 阶段 / 饱食 / 生长 --- */
  for (const fish of world.fishes) {
    if (fish.dead || fish.dying) continue;
    fish.ageDays += dtDays;
    if (fish.breedCooldown > 0) fish.breedCooldown -= dtDays;

    // 阶段（含 F-7.2.5 老鱼入阶钳制）
    const prevStage = fish.stage;
    const st = stageOf(fish.ageDays);
    fish.stage = st.key;
    if (fish.stage === 'elder' && prevStage !== 'elder') {
      fish.lengthCm = applyElderClamp(fish);
    }

    // 饱食 / 健康 / 肥满度 / nutrition
    const fed = tickFeeding(fish, dtDays);
    fish.satiety = fed.satiety;
    fish.health = fed.health;
    fish.condition = fed.condition;
    fish.nutrition = fed.nutrition;

    // 生长（消耗 nutrition）
    const g = grow(fish, dtDays, { conditionConst: undefined });
    fish.lengthCm = g.lengthCm;
    fish.nutrition = g.nutritionLeft;

    // 统计：最大个体 / 最长寿
    if (fish.lengthCm > world.stats.largestCm) {
      world.stats.largestCm = fish.lengthCm; world.stats.largestId = fish.id;
    }
    if (fish.ageDays > world.stats.longestLivedDays) {
      world.stats.longestLivedDays = fish.ageDays; world.stats.longestLivedId = fish.id;
    }

    // 死亡判定
    const verdict = checkDeath(fish);
    if (verdict) {
      fish.deathCause = verdict.cause;
      beginDying(fish, world.rng);
      world.stats.deathsByCause[verdict.cause]++;
      world.stats.died++;
    }
  }

  /* --- 2. C5 密度胁迫（硬闸门之上的额外死亡压力）--- */
  if (crowd > 1) {
    for (const fish of aliveFishes(world)) {
      const p = stressDeathProbability(fish, crowd, dtDays);
      if (world.rng.chance(p)) {
        fish.deathCause = 'stress';
        beginDying(fish, world.rng);
        world.stats.deathsByCause.stress++;
        world.stats.died++;
      }
    }
  }

  /* --- 3. 硬上限：超出则最老/最弱者加速衰老（不直接杀）--- */
  const stillAlive = aliveFishes(world);
  const cull = pickCullCandidates(stillAlive, stillAlive.length, world.softCap);
  for (const fish of cull) {
    fish.ageDays += dtDays * 2;          // 加速衰老
    fish.health -= dtDays * 1.5;
  }

  /* --- 4. 繁殖 --- */
  const mature = aliveFishes(world).filter((f) => isMature(f));
  const females = mature.filter((f) => f.sex === 'F');
  const males = mature.filter((f) => f.sex === 'M' && f.breedCooldown <= 0);

  if (females.length && males.length && crowd < 1.0) {
    for (const female of females) {
      const rate = breedRatePerDay(female, crowd);
      let p = rate * dtDays;
      if (needsRescue(aliveFishes(world).length)) p *= 3;   // §9.1 保底繁殖
      if (!world.rng.chance(Math.min(1, p))) continue;

      const male = males[Math.floor(world.rng.next() * males.length)];
      if (!male || male.breedCooldown > 0) continue;

      const n = clutchSize(female);
      const hr = hatchRate(crowd);
      const generation = Math.max(female.generation, male.generation) + 1;

      for (let i = 0; i < n; i++) {
        const genes = inheritGenes(male, female, world.rng);
        world.eggs.push({
          id: nextId++,
          genes,
          generation,
          parents: [female.id, male.id],
          remainingDays: HATCH_DAYS,          // §8.2 孵化 4 池塘日
          fertilized: world.rng.chance(hr),   // 受精判定含在孵化总时长内
        });
      }
      resetCooldown(female);
      resetCooldown(male);
      world.stats.maxGeneration = Math.max(world.stats.maxGeneration, generation);
    }
  }

  /* --- 5. 鱼卵孵化 --- */
  const hatched = [];
  const remain = [];
  for (const egg of world.eggs) {
    if (tickEgg(egg, dtDays)) {
      if (egg.fertilized) hatched.push(egg);
      // 未受精卵：变白淡出，不产生鱼苗
    } else {
      remain.push(egg);
    }
  }
  world.eggs = remain;
  // ★ 孵化闸门：产出卵时拥挤度还没超，但等 4 池塘日孵化时可能已经超了。
  //   不设这道闸，狂喂场景会一路涨到硬上限 45（实测），突破 §B.2「≤107%」。
  //   超出硬上限时这批鱼苗自然淘汰（表现为卵变白淡出），而不是孵出来再被密度胁迫杀掉。
  const hardCap = hardCapOf(world.softCap);
  for (const egg of hatched) {
    if (aliveFishes(world).length >= hardCap) continue;
    const sex = rollSex(world.rng, balance);
    const fish = makeFish({
      genes: egg.genes,
      sex,
      ageDays: 0,                      // 鱼苗 0 日龄
      generation: egg.generation,
      parents: egg.parents,
      rng: world.rng,
      viewportShortPx: world.viewportShortPx,
    });
    fish.breedCooldown = BREED.minAgeDays;   // 出苗即带上日龄门槛的冷却
    world.fishes.push(fish);
    world.stats.born++;
  }

  /* --- 6. 死亡动画结束 → 移除 --- */
  const dtSeconds = dtDays * TIME.pondDaySeconds;
  for (const fish of world.fishes) {
    if (fish.dying && !fish.dead) {
      if (tickDying(fish, dtSeconds)) fish.dead = true;
    }
  }
  if (world.fishes.length > 400) {
    world.fishes = world.fishes.filter((f) => !f.dead);
  }

  /* --- 7. 未食用饲料淡出 --- */
  for (const f of world.food) f.ageSeconds += dtSeconds;
  world.food = world.food.filter((f) => f.ageSeconds < FEEDING.foodFadeSeconds && f.count > 0);
}

/**
 * 推进指定天数（批量推演用）。
 * @param realDays 真实天
 * @param stepDays 每步池塘日（默认 .05；离线补算用 F-14.2.2 的 stepSeconds 60）
 */
export function advanceDays(world, realDays, opts = {}) {
  let stepDays = opts.stepDays ?? 0.05;
  const feedPerDay = opts.feedPerDay ?? 0;      // 每天投喂次数
  const maxCatchUpDays = opts.maxCatchUpDays ?? OFFLINE.maxCatchUpDays;

  const days = Math.min(realDays, maxCatchUpDays);
  const totalPondDays = days * TIME.pondDaysPerRealDay;
  let steps = Math.max(1, Math.ceil(totalPondDays / stepDays));
  // F-14.2.2「>20000 步加粗」是**离线补算**的策略，不是推演工具的策略 ——
  // 所以默认不限制，由调用方传 maxSteps 显式开启。
  // ⚠️ 曾经把它写成全局默认值，结果 tools/validate.js 的 365 天推演
  //    从 0.05 步长被悄悄加粗到 0.219，存活数 28 → 32：推演基线被无声改掉了。
  const maxSteps = opts.maxSteps ?? Infinity;
  if (steps > maxSteps) { steps = maxSteps; stepDays = totalPondDays / steps; }
  const dt = totalPondDays / steps;

  let feedAccum = 0;
  for (let i = 0; i < steps; i++) {
    tick(world, dt, opts);
    if (feedPerDay > 0) {
      feedAccum += feedPerDay * (dt / TIME.pondDaysPerRealDay);
      while (feedAccum >= 1) { feed(world, opts); feedAccum -= 1; }
    }
  }
  return world;
}

/**
 * 把种群重置为 count 条（行为层 `fishCount` 滑杆在 ecoMode 下的语义，见 docs §7）。
 *
 * 日龄按 §9.2 的初始梯队**等分插值**取：
 *   - count = 8 时正好逐个对上 INITIAL.ages（124/105/88/71/56/41/28/15）
 *   - 其他数量则在梯队区间内线性插值，保证重置后立刻有成熟个体 + 完整年龄结构
 * 世界时钟（pondDays / realDays）**保留** —— 它记的是「这池子活了多久」，不是鱼群年龄。
 */
export function resetPopulation(world, count) {
  const n = Math.max(1, Math.round(count));
  const ages = INITIAL.ages;

  world.fishes = [];
  world.eggs = [];
  world.food = [];
  world.stats.born = 0;
  world.stats.died = 0;
  world.stats.maxGeneration = 1;
  world.stats.deathsByCause = { age: 0, health: 0, stress: 0 };
  world.stats.longestLivedDays = 0;
  world.stats.longestLivedId = null;
  world.stats.largestCm = 0;
  world.stats.largestId = null;

  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0 : i / (n - 1);
    const pos = t * (ages.length - 1);
    const lo = Math.floor(pos);
    const hi = Math.min(ages.length - 1, lo + 1);
    const ageDays = ages[lo] + (ages[hi] - ages[lo]) * (pos - lo);

    const genes = randomGenes(world.rng);
    const sex = rollSex(world.rng, 0);
    const fish = makeFish({ genes, sex, ageDays, generation: 1, rng: world.rng, viewportShortPx: world.viewportShortPx });
    fish.breedCooldown = world.rng.range(...INITIAL.cooldownRange);
    world.fishes.push(fish);
  }
  return world;
}

/** §13 统计快照 */
export function stats(world) {
  const alive = aliveFishes(world);
  const byStage = {};
  for (const f of alive) byStage[f.stage] = (byStage[f.stage] ?? 0) + 1;
  const avgAge = alive.length ? alive.reduce((s, f) => s + f.ageDays, 0) / alive.length : 0;
  const avgLen = alive.length ? alive.reduce((s, f) => s + f.lengthCm, 0) / alive.length : 0;
  const avgCond = alive.length ? alive.reduce((s, f) => s + f.condition, 0) / alive.length : 0;
  return {
    alive: alive.length,
    eggs: world.eggs.length,
    crowd: crowdOf(alive.length, world.softCap),
    byStage,
    avgAgeDays: +avgAge.toFixed(1),
    avgLengthCm: +avgLen.toFixed(2),
    avgCondition: +avgCond.toFixed(1),
    maxGeneration: world.stats.maxGeneration,
    born: world.stats.born,
    died: world.stats.died,
    deathsByCause: { ...world.stats.deathsByCause },
    longestLivedDays: +world.stats.longestLivedDays.toFixed(1),
    largestCm: +world.stats.largestCm.toFixed(2),
    pondDays: +world.pondDays.toFixed(1),
    realDays: +world.realDays.toFixed(2),
  };
}

/* ============================================================================
 * 存档：序列化 / 读档（§14.1 快照）
 * ----------------------------------------------------------------------------
 * 三条铁律：
 *   ① **存档是不可信输入**。用户能手改 JSON、旧版本可能缺字段 ⇒ 每一项都要校验并夹紧，
 *      坏值一律退回默认，**绝不因为一个坏字段就抛异常**（宁可能力退化，不可白屏）。
 *   ② **必须存 rng 状态**。不存的话读档后随机序列从头开始，同一批鱼的花纹/性别会跳变。
 *   ③ **必须存运动字段**。生态层不读它们，只是"代为保管" —— 不然读档后所有鱼
 *      会被重新随机到新位置，画面瞬移，观感像换了一池鱼。
 * ========================================================================== */

export const SAVE_SCHEMA_VERSION = 1;
const SAVE_MAX_FISH = 2000;
const SAVE_MAX_EGGS = 2000;
const SAVE_MAX_FOOD_RECORDS = 500;

/** 生态层自己产生并结算的字段 */
const ECO_FISH_FIELDS = [
  'id', 'generation', 'genes', 'sex', 'ageDays', 'lifespanDays', 'stage', 'lCapCm', 'lengthCm',
  'satiety', 'health', 'condition', 'nutrition', 'state', 'parents', 'breedCooldown',
  'bornAtPondDay', 'dying', 'deathTimer', 'deathDuration', 'deathCause',
];

/** 行为/渲染层写入的运动态。生态层**不读**，存档时原样保管 */
const MOTION_FISH_FIELDS = [
  'x', 'y', 'heading', 'targetX', 'targetY', 'speed', 'velocity', 'wander', 'phase',
  'finPhase', 'turn', 'angularVelocity', 'width', 'depth', 'variant', 'seed',
  'strokeRate', 'swimAmplitude', 'bodyBend',
];

const isRecord = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const num = (value, lo, hi, fallback) => (Number.isFinite(value) ? Math.min(hi, Math.max(lo, value)) : fallback);
const int = (value, lo, hi, fallback) => (Number.isFinite(value) ? Math.min(hi, Math.max(lo, Math.round(value))) : fallback);

/** 基因位校验：逐位夹紧到 §8.3 的合法区间，品系必须在八品系表内 */
function normalizeGenes(raw) {
  const source = isRecord(raw) ? raw : {};
  const pick = (key, fallback) => num(source[key], GENE_RANGES[key][0], GENE_RANGES[key][1], fallback);
  return {
    patternSeed: int(source.patternSeed, 1, 2 ** 31 - 1, 1),
    palette: PALETTE_BY_ID[source.palette] ? source.palette : 'kohaku',
    variegation: pick('variegation', 0.5),
    sizeLinf: pick('sizeLinf', 1),
    growthK: pick('growthK', 1),
    lifespan: pick('lifespan', 1),
    fecundity: pick('fecundity', 1),
    appetite: pick('appetite', 1),
  };
}

function collectMotion(fish) {
  const motion = {};
  for (const key of MOTION_FISH_FIELDS) {
    if (Number.isFinite(fish[key])) motion[key] = fish[key];
  }
  return motion;
}

function serializeFish(fish) {
  const out = { motion: collectMotion(fish) };
  for (const key of ECO_FISH_FIELDS) {
    if (key === 'genes') { out.genes = { ...fish.genes }; continue; }
    if (key === 'parents') { out.parents = fish.parents ? [...fish.parents] : null; continue; }
    out[key] = fish[key];
  }
  return out;
}

/** 把存档里的鱼还原成完整对象：先建骨架（拿到所有默认值），再用存档字段覆盖 */
function reviveFish(raw, world) {
  const source = isRecord(raw) ? raw : {};
  const ageDays = num(source.ageDays, 0, 1e5, 0);
  const fish = makeFish({
    genes: normalizeGenes(source.genes),
    sex: source.sex === 'M' ? 'M' : 'F',
    ageDays,
    generation: int(source.generation, 1, 9999, 1),
    rng: world.rng,
    viewportShortPx: world.viewportShortPx,
  });

  fish.id = int(source.id, 1, 2 ** 30, fish.id);
  fish.lifespanDays = num(source.lifespanDays, 1, 1e5, fish.lifespanDays);
  fish.lCapCm = num(source.lCapCm, GROWTH.lBirthCm, world.globalLengthCapCm, fish.lCapCm);
  fish.lengthCm = num(source.lengthCm, GROWTH.lBirthCm, fish.lCapCm, fish.lengthCm);
  fish.satiety = num(source.satiety, FEEDING.satietyFloor, 100, INITIAL.satiety);
  fish.health = num(source.health, 0, HEALTH.max, INITIAL.health);
  fish.condition = num(source.condition, 0, 100, INITIAL.condition);
  fish.nutrition = num(source.nutrition, 0, 1e6, 0);
  fish.stage = typeof source.stage === 'string' ? source.stage : stageOf(ageDays).key;
  fish.state = typeof source.state === 'string' ? source.state : 'wander';
  fish.parents = Array.isArray(source.parents) ? source.parents.filter(Number.isFinite).slice(0, 2) : null;
  fish.breedCooldown = num(source.breedCooldown, 0, 1000, 0);
  fish.bornAtPondDay = num(source.bornAtPondDay, 0, 1e6, 0);
  fish.dying = source.dying === true;
  fish.deathTimer = num(source.deathTimer, 0, 1000, 0);
  fish.deathDuration = num(source.deathDuration, 0, 1000, fish.dying ? DEATH_FADE_SECONDS[0] : 0);
  fish.deathCause = typeof source.deathCause === 'string' ? source.deathCause : null;

  const motion = isRecord(source.motion) ? source.motion : null;
  if (motion) {
    for (const key of MOTION_FISH_FIELDS) {
      if (Number.isFinite(motion[key])) fish[key] = motion[key];
    }
    // 存档里带了位置 ⇒ 告诉行为层「这条鱼已经有运动态了」，
    // 否则 attachBehavior() 会把它重新随机到池子另一头。
    if (Number.isFinite(fish.x) && Number.isFinite(fish.y)) {
      fish.behaviorReady = true;
      fish.eco = true;
      fish.custom = null;
    }
  }
  return fish;
}

/**
 * 序列化为纯 JSON（不碰文件系统、不碰 DOM）。
 * @returns {object|null} 世界快照
 */
export function serialize(world) {
  if (!world) return null;
  return {
    schemaVersion: SAVE_SCHEMA_VERSION,
    seed: world.seed,
    softCap: world.softCap,
    globalLengthCapCm: world.globalLengthCapCm,
    viewportShortPx: world.viewportShortPx,
    pondDays: +world.pondDays.toFixed(6),
    realDays: +world.realDays.toFixed(6),
    rngState: world.rng.state(),
    stats: { ...world.stats, deathsByCause: { ...world.stats.deathsByCause } },
    // dead 的不必存（它们已播完死亡动画，只是还没被回收）；dying 的要存（动画播到一半）
    fishes: world.fishes.filter((fish) => !fish.dead).map(serializeFish),
    eggs: world.eggs.map((egg) => ({
      id: egg.id, genes: { ...egg.genes }, generation: egg.generation,
      parents: egg.parents ? [...egg.parents] : null,
      remainingDays: egg.remainingDays, fertilized: egg.fertilized,
    })),
    food: world.food.map((item) => ({ count: item.count, ageSeconds: item.ageSeconds })),
  };
}

/**
 * 从快照重建世界。
 * @returns {object|null} 世界；快照不合法时返回 null（调用方应退回 createWorld）
 */
export function restoreWorld(data) {
  if (!isRecord(data)) return null;
  if (data.schemaVersion !== SAVE_SCHEMA_VERSION) return null;
  if (!Array.isArray(data.fishes) || data.fishes.length > SAVE_MAX_FISH) return null;

  const world = buildWorld(normalizeWorldOptions({
    seed: int(data.seed, 0, 2 ** 31 - 1, 20260930),
    viewportShortPx: num(data.viewportShortPx, 1, 1e5, 1080),
    softCap: num(data.softCap, 1, 10000, POPULATION.softCap),
    globalLengthCapCm: num(data.globalLengthCapCm, 1, 1000, GROWTH.globalLengthCapCm),
  }));

  world.rng.restore(data.rngState);
  world.pondDays = num(data.pondDays, 0, 1e9, 0);
  world.realDays = num(data.realDays, 0, 1e9, 0);

  const stats = isRecord(data.stats) ? data.stats : {};
  const baseline = freshStats();
  world.stats = {
    ...baseline, ...stats,
    deathsByCause: { ...baseline.deathsByCause, ...(isRecord(stats.deathsByCause) ? stats.deathsByCause : {}) },
  };

  world.fishes = data.fishes.map((raw) => reviveFish(raw, world));
  world.eggs = Array.isArray(data.eggs) ? data.eggs.slice(0, SAVE_MAX_EGGS).map((egg) => ({
    id: int(egg?.id, 1, 2 ** 30, 1),
    genes: normalizeGenes(egg?.genes),
    generation: int(egg?.generation, 1, 9999, 1),
    parents: Array.isArray(egg?.parents) ? egg.parents.filter(Number.isFinite).slice(0, 2) : null,
    remainingDays: num(egg?.remainingDays, 0, HATCH_DAYS, HATCH_DAYS),
    fertilized: egg?.fertilized === true,
  })) : [];
  world.food = Array.isArray(data.food)
    ? data.food.slice(0, SAVE_MAX_FOOD_RECORDS)
      .map((item) => ({
        count: int(item?.count, 0, 500, 0),
        ageSeconds: num(item?.ageSeconds, 0, FEEDING.foodFadeSeconds, 0),
      }))
      .filter((item) => item.count > 0)
    : [];

  // ★ id 计数器必须接到最大值之后，否则新生鱼/新卵会和存档里的 id 撞车，
  //   而 id 是 parents 引用的依据 —— 撞车会让亲缘关系指向错误的鱼。
  let maxId = 0;
  for (const fish of world.fishes) if (fish.id > maxId) maxId = fish.id;
  for (const egg of world.eggs) if (egg.id > maxId) maxId = egg.id;
  setNextId(maxId + 1);

  return world;
}
