import {PondHabitat} from './habitat.js';
import {syncTurtles,updateTurtles} from './turtles.js';
import {updateSwimMotion} from './koi-motion.js';
import {koiBody, capsuleOverlap, COLLISION} from './koi-collision.js';
import {createWorld, restoreWorld, serialize, advanceDays, tick as tickEco, resetPopulation, stats as ecoStats} from './eco/world.js';
import {eatPellet, wantsFood} from './eco/feeding.js';
import {TIME, OFFLINE, pxPerCm, FEEDING, FEED_CIRCLE, SCHOOL, EGG_VISUAL, HATCH_DAYS} from './eco/constants.js';
import {attachBehavior, paletteName, updateFishLook, clutchAnchor, eggVisual} from './eco-bridge.js';
export const DEFAULT_OPTIONS = Object.freeze({
  // ecoMode 默认 **关**：保持既有的「条数由 fishCount 滑杆决定」行为不变。
  // 打开后由生态内核接管生死与体长，fishCount 滑杆语义变为「把种群重置为 N 条」。
  season: 'spring', weather: 'sunny', night: false, paused: false,
  reducedMotion: false, fishCount: 12, fishSize: 1, turtleCount: 0, quality: 'high', solarTerm: '春分',
  ecoMode: false, ecoSeed: 20260930, ecoSpeed: 1,
  // 碰撞体积默认**开**：这是"鱼不该互相穿透"的基础行为，不是可选装饰。
  collision: true,
});
export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
export const angleDelta = (from, to) => Math.atan2(Math.sin(to - from), Math.cos(to - from));
/** §3 演化倍速档位（默认 1x）。只作用于生态时钟，不改变鱼的实际游速。*/
export const ECO_SPEEDS = Object.freeze([0.5, 1, 2, 5, 20]);
const normalizeEcoSpeed = (value) => (ECO_SPEEDS.includes(value) ? value : 1);
const valid = Number.isFinite;
const finite = (value, fallback) => valid(value) ? value : fallback;
const TAU = Math.PI * 2;

/**
 * §6 阶段 → 行为的两张查表（数值表在 `eco/constants.js`）。
 *
 * ⚠️ 用 `Map.get()` 而不是「给鱼加一个默认值」：手绘鱼没有 `stage` ⇒ 取到 `undefined`
 *    ⇒ 调用处各自落回中性值（分离倍率 1 / 聚合权重 0）。
 *    **中性值必须是"乘 1、跳过分支"这种恒等操作**，否则手绘鱼的运动会被静默改动。
 */
const SCHOOL_WEIGHT = new Map(SCHOOL.weight);
const SCHOOL_SPACE = new Map(SCHOOL.spaceScale);

/** Browser-independent simulation, in CSS pixels and seconds. */
export class PondSimulation {
  constructor(width = 1000, height = 700, options = {}, random = Math.random) {
    this.width = Math.max(1, finite(width, 1000));
    this.height = Math.max(1, finite(height, 700));
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.random = random;
    this.habitat = new PondHabitat(this.width, this.height);
    this.fish = [];
    this.turtles = [];
    this.food = [];
    this.ripples = [];
    // F-2.8 感应圈的**显示**队列（只活 displaySeconds）。
    // ⚠️ 行为门控不走这里 —— 那个挂在每一粒饲料上（见 feed()），否则虚线圈一消失
    //    圈外鱼就又能抢了，与「圈外正常游」矛盾。
    this.feedCircles = [];
    // §11.2 层 6 鱼卵**视图**。生态侧的 world.eggs 只产出数据、刻意不给坐标
    // （见 eco/world.js 头注「推演里没有坐标」），位置由行为层派 —— 见 syncEggs()。
    this.eggs = [];
    this.eggVisuals = new Map();
    this.customFish = [];
    this.hand = { x: 0, y: 0, life: 0 };
    this.time = 0;
    this.serial = 0;
    this.ecoMode = this.options.ecoMode === true;
    this.eco = null;          // 生态世界（ecoMode 才有）
    this.ecoFish = [];        // 生态鱼的引用视图（不含已死透的）
    this.pxPerCmValue = 1;    // C28：pxPerCm = 短边 × .16 / L_global
    this.schoolSense = 0;     // §6 群游感知半径（短边 × SCHOOL.senseFraction）
    this.schoolDead = 0;      // §6 群游死区（短边 × SCHOOL.deadZoneFraction）
    this.updateSchoolRadii();
    this.ecoSpeed = normalizeEcoSpeed(this.options.ecoSpeed);
    this.lastAwayReport = null;   // F-14.2.5 归来摘要（UI 读过就清）
    if (this.ecoMode) this.initEco();
    this.syncFish();
    syncTurtles(this);
    this.reconcileHabitat();
  }

  createFish(index, custom = null) {
    const random = this.random;
    const x = this.width * (0.18 + random() * 0.64);
    const y = this.height * (0.19 + random() * 0.62);
    return {
      id: custom ? `custom-${custom.id}` : `koi-${this.serial++}`,
      custom, x, y, heading: random() * TAU,
      targetX: this.width * (0.15 + random() * 0.7),
      targetY: this.height * (0.16 + random() * 0.68),
      speed: 15 + random() * 13, velocity: 18,
      baseLength: custom ? 76 : 43 + random() * 61, length: 76, width: 0.115 + random() * 0.016,
      phase: random() * TAU, turn: 0, angularVelocity: 0, wander: 2 + random() * 5,
      variant: index % 6, depth: 0.84 + random() * 0.16,
      seed: random() * 100,
    };
  }

  syncFish() {
    if (this.ecoMode) { this.syncEcoFish(); this.reconcileHabitat(); return; }
    const count = Math.round(clamp(finite(this.options.fishCount, 12), 0, 24));
    // ⚠️ 必须排除 fish.eco：从生态模式切回来时，那些生态鱼对象还挂着 eco 标记，
    //    若不排除就会被当作原生鱼留下 —— 数量对不上、且再切回生态时状态是脏的。
    const natives = this.fish.filter((fish) => !fish.custom && !fish.eco).slice(0, count);
    while (natives.length < count) natives.push(this.createFish(natives.length));
    this.fish = [...natives, ...this.syncCustomFish()];
    this.resizeFish();
    this.reconcileHabitat();
  }

  /** 手绘鱼（KoiStudio 保存的）复用旧对象，避免每帧重建导致运动相位跳变。*/
  syncCustomFish() {
    const previous = new Map(this.fish.filter((fish) => fish.custom).map((fish) => [fish.custom.id, fish]));
    return this.customFish.map((item, i) => {
      const old = previous.get(item.id);
      if (old) { old.custom = item; return old; }
      return this.createFish(i, item);
    });
  }

  /* ---------------------------------------------------------------------- *
   * 生态模式（ecoMode）                                                     *
   * ---------------------------------------------------------------------- */

  /** 建生态世界。视口短边同时决定 pxPerCm（C28）与屏幕占比钳制。优先级：存档快照 > 全新世界。*/
  initEco() {
    const short = Math.min(this.width, this.height);
    this.pxPerCmValue = pxPerCm(short);
    // 新世界 / 新存档 ⇒ 卵 id 从头开始，旧视图必须丢掉（否则会认领到别人的卵）。
    this.eggs = [];
    this.eggVisuals.clear();
    const snapshot = this.options.ecoSnapshot;
    const restored = snapshot ? restoreWorld(snapshot) : null;

    if (restored) {
      this.eco = restored;
      // 视口可能变了（换了窗口大小/显示器），按当前视口重挂一次
      this.eco.viewportShortPx = short;
      this.applyAwayTime(snapshot.lastSeenWallClock);
    } else {
      this.eco = createWorld({
        seed: Math.round(finite(this.options.ecoSeed, 20260930)),
        viewportShortPx: short,
      });
    }
    this.syncEcoFish();
  }

  /**
   * F-14.2 离线演化：按**真实时间戳**补算。
   * ★ 为什么必须按墙钟算而不是按会话时长：一世 = 15 天**日历时间**。
   *   否则每天只开 8 小时机的用户，一世要走 45 天，「半月一换」直接落空。
   * 离线期间**没有人为投喂**（F-14.2.4），只走自然饵料；密度逻辑与在线完全是同一套。
   */
  applyAwayTime(lastSeenWallClock) {
    if (!Number.isFinite(lastSeenWallClock)) return;
    const awayMs = Date.now() - lastSeenWallClock;
    if (!(awayMs > 60_000)) return;          // 离开不到 1 分钟不值得播报
    const awayDays = awayMs / 86_400_000;

    const before = ecoStats(this.eco);
    // advanceDays 内部按 F-14.2.3 把补算截断到 30 天（超出的时间直接丢弃）。
    // maxSteps 在这里才开启：补算 30 天按 60s 步长要 43200 步，
    // 同步跑完会卡住主线程数秒 —— 用户看到的是启动时卡一下。
    advanceDays(this.eco, awayDays, {
      feedPerDay: 0,
      stepDays: OFFLINE.stepSeconds / TIME.pondDaySeconds,
      maxSteps: OFFLINE.maxSteps,
    });
    const after = ecoStats(this.eco);

    this.lastAwayReport = {
      awayMs,
      awayDays: +awayDays.toFixed(2),
      // 超过 30 天意味着中间那段被丢弃了。摘要要如实说，不能让用户以为全算上了。
      capped: awayDays > OFFLINE.maxCatchUpDays,
      born: Math.max(0, after.born - before.born),
      died: Math.max(0, after.died - before.died),
      alive: after.alive,
      maxGeneration: after.maxGeneration,
      pondDays: +(after.pondDays - before.pondDays).toFixed(1),
    };
  }

  /** §14.1 快照：交给 save-store 落盘。非生态模式返回 null。*/
  getSnapshot() { return this.eco ? serialize(this.eco) : null; }

  /**
   * 「重置池塘」（F-14.1.4）：连生态时钟一起归零，等于新开一池，不是只换一批鱼。
   * 为什么不复用 resetPopulation()：那个刻意**保留** world.pondDays（它记的是「池子活了多久」），
   * 而用户点「重置」时想的是从头开始 —— 池龄、统计、节气全归零。
   * @param {number} [count] 只数；给了就按 §9.2 梯队重投 N 条，不给就用 createWorld 的默认 8 条。
   */
  resetEcoFully(count) {
    if (!this.eco) return;
    this.lastAwayReport = null;
    // id 会从 1 重来 ⇒ 旧卵视图必须清掉，否则新卵会沿用上一池的位置。
    this.eggs = [];
    this.eggVisuals.clear();
    this.eco = createWorld({
      seed: Math.round(finite(this.options.ecoSeed, 20260930)),
      viewportShortPx: Math.min(this.width, this.height),
    });
    if (Number.isFinite(count)) resetPopulation(this.eco, clamp(count, 1, 24));
    this.syncEcoFish();
  }

  /**
   * F-14.2.5 归来摘要：**读过即清**。
   * 它是一次性播报（开机那一刻才成立），不清的话每次轮询都会把弹窗顶回来。
   */
  takeAwayReport() {
    const report = this.lastAwayReport;
    this.lastAwayReport = null;
    return report;
  }

  /**
   * 把生态世界的鱼同步到行为层：新鱼挂行为字段、已死透的回收。
   * 每次调用都会重建 this.fish（生态鱼 + 手绘鱼），把 this.fish 当作**视图**而不是身份。
   */
  syncEcoFish() {
    if (!this.eco) { this.ecoFish = []; this.eggs = []; this.eggVisuals.clear(); return; }
    const world = this.eco;
    const ctx = { width: this.width, height: this.height, random: this.random };
    for (const fish of world.fishes) {
      if (fish.dead) continue;
      attachBehavior(fish, ctx);
      // §6 阶段 → 外观：必须**每帧**重算（阶段随日龄推进而变化），
      // 而 attachBehavior 是幂等的、一辈子只跑一次，放它里面会让外观冻在出苗那一刻。
      updateFishLook(fish);
    }
    this.ecoFish = world.fishes.filter((fish) => !fish.dead);
    // 死亡动画播完的记录回收。生态侧要攒到 400 条才自己清，
    // 而这里每帧都要 filter 一遍 —— 长期挂机会白跑 O(n) 遍历，所以行为层主动收紧。
    if (world.fishes.length > 200) world.fishes = world.fishes.filter((fish) => !fish.dead);
    this.fish = [...this.ecoFish, ...this.syncCustomFish()];
    this.resizeFish();
    this.syncEggs();
  }

  /** §6 群游的感知半径与死区：都按视口短边算（与 pxPerCm 同源，换分辨率不用重调数值）。*/
  updateSchoolRadii() {
    const short = Math.min(this.width, this.height);
    this.schoolSense = short * SCHOOL.senseFraction;
    this.schoolDead = short * SCHOOL.deadZoneFraction;
  }

  /**
   * §11.2 层 6「鱼卵群」——把 `world.eggs` 同步成可绘制的**视图**数组。
   *
   * 三个设计点，每一个都有原因：
   *   ① **一窝一个落点**：world 里一次产卵 push 一整批，同一帧新出现的卵就是同一窝。
   *      给它们共用一个落点再小范围散开，画面上才是一「群」卵；
   *      逐粒独立取点会平铺在整条岸线上，读起来像撒了一把芝麻。
   *   ② **落点用卵 id 派生，不用 `this.random()`**：`this.random()` 是鱼群漫游共用的
   *      那条随机流，卵多撒几窝就会让全池鱼的随机数整体错位 —— 渲染/视图层不该改变行为层。
   *   ③ **视图对象与生态对象分开**：位置不写回 `world.eggs`。
   *      `serialize()` 直接遍历 `world.eggs`，写回去存档就会开始带上坐标，
   *      破坏「推演里没有坐标」这条生态侧的既定口径。
   */
  syncEggs() {
    if (!this.eco) { this.eggs = []; this.eggVisuals.clear(); return; }
    const ctx = { width: this.width, height: this.height, habitat: this.habitat };
    const live = [];
    let clutch = null;
    for (const egg of this.eco.eggs) {
      let view = this.eggVisuals.get(egg.id);
      if (!view) {
        if (!clutch) {
          // 由 id 派生 [0,1) 的确定性伪随机；同一窝共用它 ⇒ 同一窝永远落在一起。
          const u = ((Math.imul(egg.id ^ 0x51ed, 0x9e3779b1) >>> 0) % 65536) / 65536;
          clutch = clutchAnchor(u, ctx);
        }
        view = eggVisual(egg, clutch, ctx);
        this.eggVisuals.set(egg.id, view);
      }
      view.fertilized = egg.fertilized === true;
      // §8.2 步骤 4：未受精卵「变白淡出」，**产卵后 1 池塘日内结算**完。
      // `HATCH_DAYS − remainingDays` = 已过的池塘日 ⇒ settle 从 1 线性落到 0。
      // 受精卵恒为 1（一直可见到孵化那刻）。
      view.settle = view.fertilized
        ? 1
        : Math.max(0, Math.min(1, 1 - (HATCH_DAYS - egg.remainingDays) / EGG_VISUAL.settleDays));
      live.push(view);
    }
    // 回收：卵最多活 4 池塘日，而 eggVisuals 是 Map ⇒ 不清会随长跑无限长大。
    if (this.eggVisuals.size !== live.length) {
      const keep = new Set(live);
      for (const id of [...this.eggVisuals.keys()]) if (!keep.has(id)) this.eggVisuals.delete(id);
    }
    this.eggs = live;
  }

  /** ecoMode 下 fishCount 滑杆的语义：把种群重置为 N 条（不是「凑到 N 条」）。*/
  resetEcoPopulation(count) {
    if (!this.eco) return;
    resetPopulation(this.eco, clamp(finite(count, 12), 1, 24));
    this.syncEcoFish();
  }

  resizeFish() {
    const globalSize = clamp(finite(this.options.fishSize, 1), .6, 1.6);
    for (const fish of this.fish) {
      // 生态鱼：体长由 lengthCm 驱动，fishSize 滑杆降级为全局倍率
      if (fish.eco) { fish.length = fish.lengthCm * this.pxPerCmValue * globalSize; continue; }
      fish.length = fish.baseLength * globalSize * (fish.custom ? clamp(finite(fish.custom.size, 1), .55, 1.8) : 1);
    }
  }

  setCustomFish(items = []) {
    const seen = new Set();
    this.customFish = items.filter((item) => {
      if (!item || item.id == null || seen.has(item.id)) return false;
      seen.add(item.id); return true;
    }).slice(0, 12);
    this.syncFish();
  }

  updateOptions(options) {
    const previous = this.options;
    this.options = { ...this.options, ...options };
    // 生态模式开关：切换时重建/丢弃生态世界，然后整体重同步一次。
    if ('ecoMode' in options && (options.ecoMode === true) !== this.ecoMode) {
      this.ecoMode = options.ecoMode === true;
      if (this.ecoMode) this.initEco();
      else { this.eco = null; this.ecoFish = []; this.eggs = []; this.eggVisuals.clear(); }
      this.syncFish();
      this.reconcileHabitat();
      return;
    }
    // ⚠️ 只在 fishCount **真的变了**才动手。非生态模式下 syncFish() 是幂等的（凑到 N 条），
    //    重复调无害；但生态模式下 resetEcoPopulation() 是**破坏性**的（清空鱼群、世代归 1），
    //    而 UI 每次挂载/任何设置变化都会把整包 options 传下来 —— 不判变化就会把池塘反复重置。
    if ('fishCount' in options && options.fishCount !== previous.fishCount) {
      if (this.ecoMode) this.resetEcoPopulation(options.fishCount);
      else this.syncFish();
    }
    if ('fishSize' in options) this.resizeFish();
    if ('turtleCount' in options) syncTurtles(this);
    if ('ecoSpeed' in options) this.ecoSpeed = normalizeEcoSpeed(options.ecoSpeed);
    // ★ 碰撞开关走**独立字段**，不塞进 DEFAULT_OPTIONS 的其它键里。
    //   门是 `this.options.collision !== false`（缺省 ⇒ 开），
    //   所以老存档 / 老调用方不传这个键时行为不变。
    if ('collision' in options) this.options.collision = options.collision !== false;
    this.reconcileHabitat();
  }

  setBounds(width, height) {
    const nextWidth = Math.max(1, finite(width, this.width));
    const nextHeight = Math.max(1, finite(height, this.height));
    const sx = nextWidth / this.width;
    const sy = nextHeight / this.height;
    for (const item of [...this.fish, ...this.turtles, ...this.food, ...this.ripples]) {
      item.x = clamp(item.x * sx, 0, nextWidth);
      item.y = clamp(item.y * sy, 0, nextHeight);
      if (valid(item.targetX)) { item.targetX *= sx; item.targetY *= sy; }
    }
    this.width = nextWidth;
    this.height = nextHeight;
    this.habitat.resize(nextWidth, nextHeight);
    // 视口变了 ⇒ C28 的 pxPerCm 必须重算，否则窗口一缩放生态鱼的体长就错。
    // （注意：lCapCm 不用重算 —— C28 下「屏幕占比 ≤16%」恒等于 L_global 钳制，见 docs §3。）
    if (this.ecoMode && this.eco) {
      this.pxPerCmValue = pxPerCm(Math.min(nextWidth, nextHeight));
      this.eco.viewportShortPx = Math.min(nextWidth, nextHeight);
      this.resizeFish();
    }
    // §6 群游半径跟视口走，视口一变必须重算（同 pxPerCm 的理由）。
    this.updateSchoolRadii();
    // 卵的坐标是行为层按视口派的绝对像素 ⇒ 必须重派，否则缩放窗口后卵会跑到岸上/画面外。
    this.eggVisuals.clear();
    this.syncEggs();
    this.reconcileHabitat();
  }

  bodyRadius(animal) {
    const scale = clamp(Math.min(this.width / 1250, this.height / 780), .78, 1.15);
    return Math.min(animal.length * .66 * scale + 5, Math.min(this.width, this.height) * .3);
  }

  reconcileHabitat() {
    for (const animal of [...this.fish, ...this.turtles]) {
      const radius = this.bodyRadius(animal);
      Object.assign(animal, this.habitat.project(animal.x, animal.y, radius));
      const target = this.habitat.project(animal.targetX, animal.targetY, radius + 2);
      animal.targetX = target.x; animal.targetY = target.y;
    }
    this.food = this.food.filter(p => this.habitat.contains(p.x, p.y, 8));
  }

  shoreForce(animal) {
    const edge = this.habitat.boundary(animal.x, animal.y);
    const clearance = edge.distance - this.bodyRadius(animal);
    const anticipation = Math.max(60, animal.velocity * 1.6);
    const force = Math.max(0, 1 - clearance / anticipation) * 7;
    return {x: edge.nx * force, y: edge.ny * force};
  }

  /**
   * ★ 碰撞分离（`koi-collision.js` 的胶囊体）。
   *
   * 两段式：先按穿透深度**对称地推开位置**（硬约束，保证不穿透），
   * 再沿分离法线给一个**受限的速度反冲**（软约束，让鱼"被顶开"而不是"卡住"）。
   *
   * ⚠️⚠️ 关闭时必须与改动前**逐位一致**。
   *   门在调用点：`if (this.options.collision !== false) this.resolveCollisions(dt)`。
   *   关掉时整个方法一次都不进，`x/y/velocity/heading` 一个字节都不动 ——
   *   由 `tools/trace-motion.js` 的逐位摘要 + `tests/collision.test.js` 双守。
   *
   * ⚠️ 为什么**对称**推开：非对称（比如只推被撞的那条）会让"谁撞谁"成为
   *   一个隐含的状态量，两条鱼反复接触时会互相抢位置、出现高频抖动。
   *   完全重合时两边各推一半，任何一条都不占便宜。
   */
  resolveCollisions(dt) {
    const list = this.fish;
    if (list.length < 2) return;
    const scale = clamp(Math.min(this.width / 1250, this.height / 780), .78, 1.15);
    const bodies = list.map((f) => koiBody(f, scale));
    const n = list.length;
    // 每个个体先攒一份自己的修正量，最后统一施加 ⇒ 顺序无关、可复现
    const pushX = new Float64Array(n), pushY = new Float64Array(n);
    const impX = new Float64Array(n), impY = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const hit = capsuleOverlap(bodies[i], bodies[j]);
        if (!hit) continue;
        const { depth, nx, ny } = hit;
        // 质量按体长平方近似（体长 × 体宽 ∝ l²）—— 大鱼推力大、小鱼被推得多，
        // 这才符合"大鱼纹丝不动、小鱼被撞开"的直觉。
        const mi = list[i].length ** 2, mj = list[j].length ** 2;
        const total = mi + mj;
        const shareI = mj / total, shareJ = mi / total;
        const corr = depth * COLLISION.correction;
        pushX[i] += nx * corr * shareI; pushY[i] += ny * corr * shareI;
        pushX[j] -= nx * corr * shareJ; pushY[j] -= ny * corr * shareJ;
        // 速度反冲：∝ 穿透深度，但有上限，避免弹飞
        const kick = Math.min(COLLISION.maxSpeed, COLLISION.strength * depth * .1);
        impX[i] += nx * kick * shareI; impY[i] += ny * kick * shareI;
        impX[j] -= nx * kick * shareJ; impY[j] -= ny * kick * shareJ;
      }
    }
    for (let i = 0; i < n; i++) {
      const f = list[i];
      if (pushX[i] || pushY[i]) {
        const x = f.x + pushX[i], y = f.y + pushY[i];
        // 位置修正也要守栖息地边界，否则会被推到荷叶/池外
        if (this.habitat.contains(x, y, this.bodyRadius(f))) { f.x = x; f.y = y; }
      }
      if (impX[i] || impY[i]) {
        const vx = Math.cos(f.heading) * f.velocity + impX[i] * dt;
        const vy = Math.sin(f.heading) * f.velocity + impY[i] * dt;
        // 只改速度大小、**不改朝向** —— 鱼被撞会减速加速，但不会原地掉头。
        // 掉头交给转向避让，那里有平滑的角速度模型。
        f.velocity = Math.max(0, Math.hypot(vx, vy));
      }
    }
  }

  moveAnimal(animal, dt) {
    const x = animal.x + Math.cos(animal.heading) * animal.velocity * dt;
    const y = animal.y + Math.sin(animal.heading) * animal.velocity * dt;
    if (this.habitat.contains(x, y, this.bodyRadius(animal))) { animal.x = x; animal.y = y; }
    else animal.velocity *= Math.exp(-dt * 5);
  }

  pointer(x, y, active = true) {
    if (!active) { this.hand.life = 0; return; }
    if (!valid(x) || !valid(y)) return;
    this.hand = { x, y, life: 0.85 };
  }

  addRipple(x, y, strength = 1) {
    this.ripples.push({ x, y, age: 0, life: 2.6, strength });
    if (this.ripples.length > 40) this.ripples.splice(0, this.ripples.length - 40);
  }

  /**
   * 投喂（F-2.1 / F-2.6 / F-2.8）。
   *
   * ★ 感应圈的圈挂在**每一粒饲料**上（pellet.circle），不是只活在虚线圈显示的 1.8s 里。
   *   否则虚线圈一消失、圈外鱼就又能抢 —— 与 F-2.8「圈外正常游」直接矛盾。
   *   饲料活多久（F-7.3.7 落底淡出），这一把食的圈就管多久。
   *
   * @returns {{ok:boolean, capped:boolean}} capped=true 表示已到 F-2.6 的 200 粒上限、这一把没撒下。
   */
  feed(x, y) {
    if (!valid(x) || !valid(y) || !this.habitat.contains(x, y, 8)) return { ok: false, capped: false };
    // F-2.6 / F-7.3.6：未食用上限 200 粒，满了就不再撒（界面提示「这一把够了」）。
    if (this.food.length >= FEEDING.foodCap) return { ok: false, capped: true };
    // A feeding click invites fish; don't retain the preceding pointer scare.
    this.hand.life = 0;
    x = clamp(x, 8, Math.max(8, this.width - 8));
    y = clamp(y, 8, Math.max(8, this.height - 8));
    // F-2.8：半径 = 视口短边 × 0.30
    const circle = { x, y, radius: Math.min(this.width, this.height) * FEED_CIRCLE.radiusFraction };
    for (let i = 0; i < 9; i++) {
      const angle = this.random() * TAU;
      const radius = this.random() * 21;
      const px = x + Math.cos(angle) * radius, py = y + Math.sin(angle) * radius;
      if (!this.habitat.contains(px, py, 8)) continue;
      this.food.push({
        x: px, y: py, circle,
        // ★ 寿命以 `FEEDING.foodFadeSeconds` 为中心（= 90s，F-7.3.7
        //   「未食用饲料落底 90s 淡出溶解，无惩罚」，原文在 refs/yutang/开发提示词.md:225）。
        //   ⚠️ 这里曾经写死 `26 + this.random() * 5`（26–31s）—— 渲染层自己编了一个数、
        //      常量白定义了，两处对不上；生态层 `eco/world.js` 一直按 90s 走。
        //   ±3s（87–93，均值正好 90）只为「同批饲料不同时消失」，量级 3.3%，仍读作 90s。
        //   ★★★ **这一次 `random()` 一次都不能省**（别把它"简化"成常量）：
        //      `feed()` 的随机数消耗次数是**逐位基线**的一部分 —— `tools/trace-motion.js`
        //      在 120/300/500 帧各投喂一次，少抽一次 ⇒ 随机流错位 ⇒ 全池鱼漫游目标整体改变
        //      ⇒ 三个场景的 sha256 全变。实测：写死成常量后 3/3 场景全部"轨迹已变"。
        //      保住这一次抽样，改动的爆炸半径就只剩"饲料寿命"这一个可观测差异。
        age: 0, life: FEEDING.foodFadeSeconds + (this.random() - 0.5) * 6,
        phase: this.random() * TAU, size: 1.5 + this.random() * 1.2,
      });
    }
    if (this.food.length > FEEDING.foodCap) this.food.splice(0, this.food.length - FEEDING.foodCap);
    // 虚线圈 + 脉冲显示 displaySeconds（F-2.8）。上限 8 个只是防手抖连点堆出无上限的绘制队列。
    this.feedCircles.push({ ...circle, age: 0, life: FEED_CIRCLE.displaySeconds });
    if (this.feedCircles.length > 8) this.feedCircles.splice(0, this.feedCircles.length - 8);
    this.addRipple(x, y, 1.25);
    return { ok: true, capped: false };
  }

  /**
   * F-2.8：这粒饲料对这尾鱼可见吗？
   * 圈内鱼一律可见；**圈外鱼正常游**，只有「贴脸」（饲料在 34px 内）才例外。
   * ⚠️ 阈值量到鱼身中心而不是嘴 —— 判定发生在鱼移动**之前**，此时这一帧的朝向还没定，
   *    量嘴会把「鱼背对着饲料但已经贴上去」误判成看不见；34px 远小于体长，两种量法差别可忽略。
   */
  canReachFood(fish, pellet) {
    const circle = pellet.circle;
    if (!circle) return true;                       // 非投喂产生的饲料不受圈限制
    const dx = fish.x - circle.x, dy = fish.y - circle.y;
    if (dx * dx + dy * dy <= circle.radius * circle.radius) return true;
    return Math.hypot(pellet.x - fish.x, pellet.y - fish.y) < FEED_CIRCLE.closeRangePx;
  }

  update(delta) {
    if (this.options.paused || !valid(delta) || delta <= 0) return;
    const dt = Math.min(delta, 0.05);
    this.time += dt;
    this.hand.life = Math.max(0, this.hand.life - dt);
    // 生态推进：1 真实秒 = TIME.pondDaysPerSecond 池塘日（1/7200）。
    // dt 已被钳到 ≤50ms ⇒ 切后台回来或掉帧时不会一次补掉大半条鱼的寿命。
    // §3 演化倍速只乘在**生态时钟**上 —— 20x 是「时间过得快」，不是「鱼游得快」，
    // 所以行为层的游速、转向、涟漪完全不受它影响。
    if (this.ecoMode && this.eco) {
      tickEco(this.eco, dt * TIME.pondDaysPerSecond * this.ecoSpeed);
      this.syncEcoFish();
    }
    const { season, weather, reducedMotion } = this.options;
    const seasonalSpeed = season === 'winter' ? 0.51 : season === 'autumn' ? 0.86 : 1;
    const weatherSpeed = weather === 'rainy' || weather === 'stormy' || weather === 'snowy' ? 0.78 : 1;
    const motionSpeed = reducedMotion ? 0.42 : 1;
    // §6 聚合拉力的形状。每帧读一次（不是模块级常量）—— 因为 constants.js 里的
    // SCHOOL 是可调参数，探针工具会在 import 本模块之前改写它。
    const pullHill = SCHOOL.pullShape === 'hill';
    const marginX = Math.min(85, this.width * 0.13);
    const marginY = Math.min(75, this.height * 0.13);

    // Shared by both fish and turtles, including food delivered by global clicks.
    this.food = this.food.filter(p => { p.clearance = this.habitat.boundary(p.x, p.y).distance; return p.clearance >= 8; });
    for (const fish of this.fish) {
      const radius = this.bodyRadius(fish);
      fish.wander -= dt;
      let targetFood = null;
      let nearest = Infinity;
      for (const pellet of this.food) {
        if (pellet.clearance < radius) continue;
        // F-2.8 感应圈：圈外鱼根本看不见这一把食（贴脸例外见 canReachFood）。
        if (!this.canReachFood(fish, pellet)) continue;
        const distance = Math.hypot(pellet.x - fish.x, pellet.y - fish.y);
        if (distance < nearest) { nearest = distance; targetFood = pellet; }
      }
      if (targetFood && !this.habitat.routeClear(fish.x, fish.y, targetFood.x, targetFood.y, radius)) targetFood = null;
      // F-7.3.4：饱食 ≥85 不再抢食。只在生态模式下生效 —— 手绘鱼没有 satiety 字段，
      // 保持它们「看见就吃」的原有行为。
      if (targetFood && fish.eco && !wantsFood(fish)) targetFood = null;
      if (fish.wander <= 0 || Math.hypot(fish.targetX - fish.x, fish.targetY - fish.y) < 48) {
        fish.targetX = marginX + this.random() * Math.max(1, this.width - marginX * 2);
        fish.targetY = marginY + this.random() * Math.max(1, this.height - marginY * 2);
        const target = this.habitat.project(fish.targetX, fish.targetY, radius + 15);
        fish.targetX = target.x; fish.targetY = target.y;
        fish.wander = 4 + this.random() * 8;
      }
      const tx = targetFood ? targetFood.x : fish.targetX;
      const ty = targetFood ? targetFood.y : fish.targetY;
      const dist = Math.max(1, Math.hypot(tx - fish.x, ty - fish.y));
      let steerX = (tx - fish.x) / dist;
      let steerY = (ty - fish.y) / dist;
      let startled = false;
      if (this.hand.life > 0) {
        const dx = fish.x - this.hand.x;
        const dy = fish.y - this.hand.y;
        const handDist = Math.hypot(dx, dy);
        if (handDist < 125) {
          const force = (1 - handDist / 125) * 5.5 * Math.min(1, this.hand.life * 3);
          steerX += dx / Math.max(1, handDist) * force;
          steerY += dy / Math.max(1, handDist) * force;
          startled = true;
        }
      }
      // §6 阶段 → 行为：分离半径倍率（亚成体「领域意识」/ 老鱼「离群独处」）与聚合权重。
      // ⚠️ 手绘鱼没有 stage ⇒ 两个查表都取到 undefined ⇒ spaceScale 落回 1、weight 落回 0。
      //    乘 1 在 IEEE754 下是恒等、权重 0 时内层分支被跳过 ⇒ 浮点路径与加这个特性之前
      //    **完全一致**。这条由 `tools/trace-motion.js` 用逐位摘要守着。
      const schoolWeight = SCHOOL_WEIGHT.get(fish.stage) ?? 0;
      const ownSpace = SCHOOL_SPACE.get(fish.stage) ?? 1;
      const schoolSense = this.schoolSense;
      const schoolDead = this.schoolDead;
      // ★ 吸引与排斥的形状**必须不同**，不能共用一个钟形：
      //   吸引（w>0）用钟形 —— 两端归零，才有唯一的稳定间距，不会塌到重叠。
      //   排斥（w<0）用单调 `1 − r/sense` —— **越近推得越狠**，这才读作"保持距离"。
      //   给排斥也套钟形的话，近处推力反而归零 ⇒ 老鱼擦身而过就不推了。
      //   实测症状：老鱼的公平对照在 3 个种子上是 1.32 / 1.07 / 1.03（最差只剩 0.03 余量），
      //   而单条鱼最小比值仍会掉到 0.79 —— 就是被这条"近处不推"放过去的。
      const attractHill = pullHill && schoolWeight > 0;
      let cohesionX = 0, cohesionY = 0, cohesionN = 0;
      for (const other of this.fish) {
        if (other === fish) continue;
        const dx = fish.x - other.x;
        const dy = fish.y - other.y;
        const distance = Math.hypot(dx, dy);
        // 个人空间取**双方倍率的较大者**（§6 亚成体「领域意识」/ 老鱼「离群独处」）。
        // ★ 为什么必须成对取大，而不是只乘自己那一侧：
        //   只放大老鱼自己那侧时，"离群"变成老鱼**单方面后撤** —— 别的鱼照样一路顶到它身上，
        //   老鱼被挤在角落而不是待在开阔水面上。实测隔离度（到最近一尾鱼的距离 ÷ 全池中位）
        //   恒为 1.00，等于没做。成对取大之后大气泡是**互相的**，谁也别挤谁。
        // ⚠️ 手绘鱼两侧都取到 undefined ⇒ 落回 1 ⇒ `max(1,1) = 1`，乘 1 是 IEEE754 恒等操作，
        //    浮点路径与加这个特性之前一致（由 tools/trace-motion.js 逐位守着）。
        const otherSpace = SCHOOL_SPACE.get(other.stage) ?? 1;
        const spaceScale = otherSpace > ownSpace ? otherSpace : ownSpace;
        const personalSpace = (targetFood ? Math.max(18, (fish.length + other.length) * .15) : Math.max(30, (fish.length + other.length) * .29)) * spaceScale;
        if (distance < personalSpace && distance > 0.01) {
          const force = (1 - distance / personalSpace) * 1.15;
          steerX += dx / distance * force;
          steerY += dy / distance * force;
        }
        // §6 群游（鱼苗「紧密群游」）。只在**同一阶段**之间拉：
        // ★ 阶段隔离是必须的 —— 不隔离就退化成「全池挤成一坨」，
        //   而需求要的是一组**分化**的行为：鱼苗抱团、老鱼离群。
        // ⚠️ 死区（schoolDead）不能省：分离力在 personalSpace 之外就为 0，
        //    而拉力一直存在 ⇒ 没有死区时稳定点是「互相压住」，画面会读成一条鱼。
        if (schoolWeight === 0 || other.stage !== fish.stage) continue;
        if (distance >= schoolSense || distance <= schoolDead) continue;
        // dx = fish − other ⇒ 朝同伴的方向是 −dx。这里只**累加**，取平均在循环外做。
        // pull 的形状见 SCHOOL.pullShape：hill 在死区与感知半径两端都归零，
        // 才有唯一的稳定间距；linear（初版）在死区边界上仍有 68% 满值拉力 ⇒ 形同没死区。
        const pull = attractHill
          ? Math.sin(Math.PI * (distance - schoolDead) / (schoolSense - schoolDead))
          : 1 - distance / schoolSense;
        cohesionX -= dx / distance * pull;
        cohesionY -= dy / distance * pull;
        cohesionN++;
      }
      // ★ 为什么必须除以同伴数（取平均），不能逐条累加：
      //   分离力是**成对**的（一般只有 1–2 个邻居在推），而聚合项如果直接求和，
      //   鱼苗成群时感知半径（短边 × 0.17 ≈ 153px）里可能有十几条同伴 ⇒
      //   拉力比分离力大一个数量级 ⇒ 稳定点变成"互相压住"。
      //   实测：累加版的同阶段最近邻中位数掉到 9px，而那一批鱼体长才 9px —— 完全重叠。
      //   取平均之后拉力上界 = schoolWeight，与分离力（1.15）同量级，才有稳定队形。
      if (cohesionN) {
        const scale = schoolWeight / cohesionN;
        steerX += cohesionX * scale;
        steerY += cohesionY * scale;
      }
      // Soft banks anticipate the turn; hard clamps are a final resize safeguard.
      if (fish.x < marginX) steerX += (1 - fish.x / marginX) * 5;
      if (fish.x > this.width - marginX) steerX -= (1 - (this.width - fish.x) / marginX) * 5;
      if (fish.y < marginY) steerY += (1 - fish.y / marginY) * 5;
      if (fish.y > this.height - marginY) steerY -= (1 - (this.height - fish.y) / marginY) * 5;
      const bank = this.shoreForce(fish);
      steerX += bank.x; steerY += bank.y;
      const targetHeading = Math.atan2(steerY, steerX);
      const maxTurnRate = startled ? 2.0 : targetFood ? 2.3 : Math.hypot(bank.x, bank.y) > 1 ? 1.3 : .66;
      const goalTurn = clamp(angleDelta(fish.heading, targetHeading) * 2.25, -maxTurnRate, maxTurnRate);
      // A turn builds and releases continuously; choosing another morsel or
      // wandering target cannot flip the body's angular velocity in one frame.
      const previousTurn = fish.angularVelocity || 0;
      fish.angularVelocity = previousTurn + (goalTurn - previousTurn) *
        (1 - Math.exp(-dt * (targetFood || startled ? 5.2 : 3.2)));
      fish.heading += (previousTurn + fish.angularVelocity) * .5 * dt;
      fish.turn += (fish.angularVelocity - fish.turn) * (1 - Math.exp(-dt * 5));
      // Notice food across the pond, rush toward it, then brake before reaching
      // the mouth. Heading alignment avoids accelerating away during a U-turn.
      const approach = clamp((dist - 42) / 160, 0, 1);
      const easing = approach * approach * (3 - 2 * approach);
      const aligned = clamp(Math.cos(angleDelta(fish.heading, targetHeading)), 0, 1);
      const feedingSpeed = (1.05 + easing * 2.35) * (0.5 + aligned * 0.5);
      // §6 老鱼「游速下降」。乘数放在**最后**：非老鱼乘的是常量 1.0，
      // IEEE754 下 `x * 1.0 === x` 逐位成立 ⇒ 其它阶段与改动前完全一致。
      const goalSpeed = fish.speed * seasonalSpeed * weatherSpeed * motionSpeed
        * (startled ? 1.8 : targetFood ? feedingSpeed : 1)
        * (fish.stage === 'elder' ? SCHOOL.elderSpeedScale : 1);
      const response = fish.velocity > goalSpeed ? 5 : targetFood ? 4 : 1.7;
      fish.velocity += (goalSpeed - fish.velocity) * (1 - Math.exp(-dt * response));
      this.moveAnimal(fish, dt);
      updateSwimMotion(fish, dt, this.time, reducedMotion);
      const bodyScale = clamp(Math.min(this.width / 1250, this.height / 780), .78, 1.15);
      const mouthX = fish.x + Math.cos(fish.heading) * fish.length * .385 * bodyScale;
      const mouthY = fish.y + Math.sin(fish.heading) * fish.length * .385 * bodyScale;
      for (let i = this.food.length - 1; i >= 0; i--) {
        const pellet = this.food[i];
        if (Math.hypot(pellet.x - mouthX, pellet.y - mouthY) < FEEDING.mouthPx) {
          // 生态侧在同一点补一次进食结算（F-7.3.2：+6 饱食、+1 营养原料）。
          // 吃饱了（≥85）不咬，颗粒留在水里继续淡出。
          if (fish.eco) {
            if (!wantsFood(fish)) break;
            const eff = eatPellet(fish);
            fish.satiety = eff.satiety;
            fish.nutrition = eff.nutrition;
          }
          this.food.splice(i, 1);
          // 鱼在水面啄食 ⇒ 水面破一下、起一圈涟漪。食物浮在水面上（无下沉），
          // 所以这一圈必须看得见：半径 = 4 + 65×strength（0.7 ⇒ 最大 ~50px）。
          // 旧值 0.36 只有 ~27px、峰值 alpha 0.16，实际看不出"水面被扰动过"。
          this.addRipple(pellet.x, pellet.y, 0.7);
          break;
        }
      }
    }
    // ★ 碰撞分离：位置修正 + 速度反冲，在**转向循环之外**统一施加。
    //   为什么不放进转向循环：转向力是"期望方向"，分离是"硬约束"。
    //   混在一起会让两条鱼互相拉扯出振荡（一帧推左、下一帧推右）。
    //   位置修正在这里一次性结算，天然对称、不会累积偏向。
    if (this.options.collision !== false) this.resolveCollisions(dt);
    updateTurtles(this, dt);
    for (const pellet of this.food) {
      pellet.age += dt;
      pellet.x += Math.sin(this.time * 0.4 + pellet.phase) * dt * 0.42;
      pellet.y += Math.cos(this.time * 0.3 + pellet.phase) * dt * 0.35;
    }
    this.food = this.food.filter((pellet) => pellet.age < pellet.life && this.habitat.contains(pellet.x, pellet.y, 8));
    for (const ripple of this.ripples) ripple.age += dt;
    this.ripples = this.ripples.filter((ripple) => ripple.age < ripple.life);
    // 虚线圈只活 displaySeconds（F-2.8）；行为门控挂在饲料上，不跟着它一起消失。
    for (const circle of this.feedCircles) circle.age += dt;
    this.feedCircles = this.feedCircles.filter((circle) => circle.age < circle.life);
  }

  getStats() {
    const base = { fishCount: this.fish.length, turtleCount: this.turtles.length, foodCount: this.food.length, foodCap: FEEDING.foodCap, feedCircles: this.feedCircles.length, eggViews: this.eggs.length, ecoMode: this.ecoMode };
    if (!this.ecoMode || !this.eco) return base;
    const snapshot = ecoStats(this.eco);
    const largest = snapshot.largestId != null ? this.eco.fishes.find((fish) => fish.id === snapshot.largestId) : null;
    return {
      ...base,
      eco: {
        ...snapshot,
        pxPerCm: +this.pxPerCmValue.toFixed(3),
        // 界面用：池塘里最大的那尾（品系中文名 + 体长 + 阶段）
        largest: largest ? {
          id: largest.id, name: paletteName(largest.genes.palette), palette: largest.genes.palette,
          lengthCm: +largest.lengthCm.toFixed(2), stage: largest.stage,
          ageDays: Math.round(largest.ageDays), generation: largest.generation,
        } : null,
      },
    };
  }
}
