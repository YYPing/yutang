import { PondSimulation, DEFAULT_OPTIONS, clamp } from './simulation.js';
import { renderScale, createFishShadow, watchDeviceScale } from './rendering.js';
import {Atmosphere} from './atmosphere.js';
import {Scenery} from './scenery.js';
import {Landscape} from './landscape.js';
import {KoiRenderer} from './koi-renderer.js';
import {prepareKoiSkin} from './koi-skin.js';
import {TurtleRenderer} from './turtles.js';
import {drawSurfaceRipples,drawShoreRipples} from './surface-waves.js';
import { EGG_VISUAL } from './eco/constants.js';
import { LightField, LIGHT } from './light-field.js';

const TAU = Math.PI * 2;

/* ============================================================ §10.5 光照场的画布口径 */
/**
 * ⚠️ 这三个数是**画布上的颜料浓度**，与 `LIGHT.*` 的**光场标量**不是同一个量纲，别混。
 *    光池峰值 `.55` 是 `lit`（F-10.5.2，用来算鱼亮度）；
 *    下面的 `.16` 是"这层径向涂多浓"（附录 A.2 #2）。
 *    两者都由需求给出，一个在 §10.5 的表里，一个在附录 A.2 的踩坑清单里。
 */
/** 光池的颜料浓度。**取 .16 不是调出来的**：附录 A.2 #2「光池压最亮处烧白 → 下移 y .26h、贡献 .16」。 */
const POOL_INK = 0.16;
/**
 * 单束光柱在带心的颜料浓度。
 *
 * ⚠️ **需求没有给这个数**（§10.5 只定了几何与时间：间隔 9–26s、存续 5.5–12s）。
 *    它是纯观感调参量 —— 但上下都有硬边界，不是随便填：
 *
 *  · **下界：要看得见**。0.13 时实测「带内有柱/无柱差分」带心附加 alpha 只有 .098、
 *    带内平均只抬高 **3.7 luma**（底色约 /145）。铺在密集的焦散网纹上，肉眼几乎读不出来 ——
 *    等于"功能做了但看不见"。这是被 `tools/shot-sunlight-ab.cjs` 的 A/B 实拍逼出来的。
 *  · **上界：不截顶**。滤色叠加的等效 alpha `1−Π(1−aᵢ)`，最坏情况是
 *    「光池 .16 + 两束光柱」同处 = 0.462。逐层套下来底色 210 的亮水也只到 244，
 *    离 255 还有余量 —— 所以 F-10.5.2 / 附录 A.2 #2 忌惮的"烧白"不会出现。
 *  · **取 .20 而不是"贴着光池的 .16"**：漫射天光与直射光柱不是一个量级，
 *    一束穿云而下的直射光**本来就该比它照亮的整片水面更亮**。
 *
 * 想再调：`SHAFT_INK` 是**唯一**该动的旋钮。调完必须重跑
 * `npm run check:light:ui`（带心 vs 带外 > .04、剖面单调、纵向中段最亮三条判据）
 * 与 `node tools/shot-sunlight-ab.cjs`（重新出一组 A/B 实拍）双确认。
 */
const SHAFT_INK = 0.2;
/** 层 12「明暗带」的 alpha。**需求写死的 .022** —— 调大立刻变成两条脏边。 */
const LIGHT_BAND_INK = 0.022;
/** 层 13「碎光」在晴天的峰值浓度。 */
const SPARKLE_INK = 0.34;
const ellipse = (ctx, x, y, rx, ry, fill, angle = 0) => {
  ctx.beginPath(); ctx.ellipse(x, y, rx, ry, angle, 0, TAU);
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
};

/**
 * 层 13 碎光用的小亮斑，**预渲染一次**。
 *
 * ⚠️ 不要每帧 `createRadialGradient` —— 每帧 26 个渐变对象 × 60Hz = 1560 个/秒，
 *    而这些点除了位置和透明度之外**完全一样**。预渲染成精灵再 `drawImage` 是同一张图，
 *    成本差一个数量级。（与 `createFishShadow()` 同一套做法。）
 */
function createSparkleSprite() {
  const size = 32;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const half = size / 2;
  const dot = ctx.createRadialGradient(half, half, 0, half, half, half);
  dot.addColorStop(0, 'rgba(255,253,232,1)');
  dot.addColorStop(0.32, 'rgba(255,250,214,.72)');
  dot.addColorStop(0.66, 'rgba(255,246,196,.2)');
  dot.addColorStop(1, 'rgba(255,242,182,0)');
  ctx.fillStyle = dot;
  ctx.fillRect(0, 0, size, size);
  return canvas;
}
/** A transparent Canvas pond layer; UI owns all pointer event listeners. */
export class PondEngine extends KoiRenderer {
  constructor(canvas, options = {}, landscapeCanvas = null) {
    super(canvas.getContext('2d', {alpha:true}));
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: true });
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.sim = new PondSimulation(1000, 700, this.options);
    this.images = new Map();
    this.shadowSprite = createFishShadow();
    this.sparkleSprite = createSparkleSprite();
    this.atmosphere = new Atmosphere(this.options);
    this.scenery = new Scenery();
    this.turtleRenderer = new TurtleRenderer();
    this.landscape = new Landscape(landscapeCanvas);
    this.landscape.onLoad = () => this.render();
    // §10.5 光照场。★ 挂在 `this` 上（而不是只在 drawWater 里 new 一个）——
    //   KoiRenderer.drawFish 要靠 `this.lightField` 问每一条鱼位置的 `lightAt`，
    //   这就是 US-11「阳光处鱼亮」的通路。
    this.light = new LightField();
    this.light.configure(this.options);
    this.lightField = this.light;
    this.isWater = (x,y) => this.landscape.waterAt(x,y);
    this.running = false;
    this.destroyed = false;
    this.lastTime = 0; this.nextFrame = 0;
    this.rafInterval = 1000 / 60; this.previousRaf = 0;
    this.fps = 0;
    this.sampleStart = 0;
    this.sampleFrames = 0;
    this.frame = 0;
    this.width = 0;
    this.height = 0;
    this.dpr = 1;
    this.motes = Array.from({ length: 120 }, (_, i) => ({
      x: ((i * 0.61803398875 + 0.13) % 1),
      y: ((i * 0.38196601125 + 0.21) % 1),
      seed: ((i * 0.7548776662 + 0.1) % 1),
      size: 0.6 + ((i * 0.56984029) % 1) * 1.5,
    }));
    this.tick = this.tick.bind(this);
    this.handleVisibility = () => {
      this.lastTime = 0; this.nextFrame = 0;
      this.sampleStart = this.sampleFrames = this.fps = 0;
      if (document.hidden) { cancelAnimationFrame(this.frame); this.frame = 0; }
      else if (this.running && !this.destroyed) this.schedule();
    };
    document.addEventListener('visibilitychange', this.handleVisibility);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.handleResize = () => this.resize();
    this.stopWatchingDeviceScale = watchDeviceScale(this.handleResize);
    window.addEventListener('resize', this.handleResize);
    this.resizeObserver.observe(canvas);
    this.resize();
  }

  resize() {
    if (this.destroyed) return;
    const rect = this.canvas.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);
    this.displayScale = Math.max(window.devicePixelRatio || 1, this.options.desktopMode ? this.options.displayPixelRatio || 1 : 1);
    const dpr = renderScale(width, height, window.devicePixelRatio || 1, this.options.quality, this.options.desktopMode, this.options.displayPixelRatio);
    if (width !== this.width || height !== this.height || dpr !== this.dpr) {
      this.width = width; this.height = height; this.dpr = dpr;
      this.canvas.width = Math.round(width * dpr);
      this.canvas.height = Math.round(height * dpr);
      this.sim.setBounds(width, height);
      this.atmosphere.impacts.length = 0;
      this.landscape.resize(width, height, dpr);
    }
    if (this.options.desktopMode) {
      this.desktopSize = [this.canvas.width, this.canvas.height];
      this.desktopBackgroundSize = this.landscape.getStats().backgroundSize;
    }
    this.render();
  }

  start() { if (this.destroyed || this.running) return; this.running = true; this.lastTime = 0; this.nextFrame = 0; this.schedule(); }
  schedule() { if (!this.frame && !this.options.paused && !document.hidden && !this.destroyed) this.frame = requestAnimationFrame(this.tick); }
  tick(timestamp) {
    this.frame = 0;
    if (!this.running || this.destroyed || document.hidden) return;
    const interval = this.options.quality === 'low' || this.options.reducedMotion ? 1000 / 30 : 1000 / 60;
    if (this.previousRaf) this.rafInterval = this.rafInterval * .9 + Math.min(100, timestamp - this.previousRaf) * .1;
    this.previousRaf = timestamp;
    // At 60 Hz render every vsync; a second wall-clock gate would mistake GPU jitter
    // for a too-early frame. Faster displays and 30 FPS modes use a phase-aligned cap.
    if (interval < 20 && this.rafInterval > 14.5) this.nextFrame = timestamp + interval;
    else {
      if (!this.nextFrame || timestamp - this.nextFrame > interval * 2) this.nextFrame = timestamp;
      if (timestamp + 2 < this.nextFrame) { this.schedule(); return; }
      this.nextFrame += Math.max(1, Math.floor((timestamp - this.nextFrame + 2) / interval) + 1) * interval;
    }
    const dt = this.lastTime ? Math.min((timestamp - this.lastTime) / 1000, 0.05) : 1 / 60;
    this.lastTime = timestamp;
    this.sim.update(dt);
    // ⚠️ 光照场必须在 `render()` **之前**推进：光柱的包络是这一帧画出来的，
    //    晚一步就是"画的是上一帧的柱子"，鱼与亮带会错开一帧。
    this.light.update(dt, this.width, this.height);
    for (const event of this.atmosphere.update(dt, this.width, this.height, this.sim.fish, this.sim.hand, this.isWater)) this.options.onThunder?.(event);
    this.render();
    if (!this.sampleStart) this.sampleStart = timestamp;
    else this.sampleFrames++;
    if (timestamp - this.sampleStart >= 1000) {
      this.fps = Math.round(this.sampleFrames * 1000 / (timestamp - this.sampleStart));
      this.sampleStart = timestamp; this.sampleFrames = 0;
    }
    this.schedule();
  }

  updateOptions(partial = {}) {
    const qualityChanged = (partial.quality !== undefined && partial.quality !== this.options.quality)
      || (partial.desktopMode !== undefined && partial.desktopMode !== this.options.desktopMode)
      || (partial.displayPixelRatio !== undefined && partial.displayPixelRatio !== this.options.displayPixelRatio);
    this.options = { ...this.options, ...partial };
    this.sim.updateOptions(partial);
    this.atmosphere.configure(partial);
    this.light.configure(partial);
    if (this.options.paused) { cancelAnimationFrame(this.frame); this.frame = 0; this.lastTime = 0; this.nextFrame = 0; this.sampleStart = this.sampleFrames = this.fps = 0; }
    else if (this.running) this.schedule();
    if (qualityChanged) { this.nextFrame = 0; this.resize(); }
    else this.render();
  }
  pointer(x, y, active = true) { this.sim.pointer(x, y, active); }
  /** 返回 `{ok, capped}` —— capped 时界面按 F-2.6 提示「这一把够了」。*/
  feed(x, y) { const result = this.sim.feed(x, y); if (this.options.paused) this.render(); return result; }
  /** 生态模式：把种群重置为 N 尾（由设置面板的按钮显式触发，不是滑杆实时生效）。*/
  resetPopulation(count) { this.sim.resetEcoPopulation(count); this.render(); }
  /** F-14.1.4「重置池塘」：连生态时钟一起归零（新开一池）。*/
  resetEcoFully(count) { this.sim.resetEcoFully(count); this.render(); }
  /** §14.1 快照（非生态模式返回 null）。save-store 拿它落盘。*/
  getSnapshot() { return this.sim.getSnapshot(); }
  /** F-14.2.5 归来摘要，读过即清。*/
  takeAwayReport() { return this.sim.takeAwayReport(); }
  getStats() { return { ...this.sim.getStats(), fps: this.fps, width: this.canvas.width, height: this.canvas.height,
    ...this.landscape.getStats(), displayScale: this.displayScale,
    desktopMode: !!this.options.desktopMode, desktopSize: this.desktopSize, desktopBackgroundSize: this.desktopBackgroundSize, scenery: {rainDrops:this.atmosphere.drops.length, rainHits:this.atmosphere.rainHits, leaves:this.atmosphere.leaves.length, landings:this.atmosphere.landings, landscape:!!this.landscape.ready} }; }
  setCustomFish(items = []) {
    this.sim.setCustomFish(items);
    const wanted = new Set(this.sim.customFish.map((item) => item.texture).filter(Boolean));
    for (const key of this.images.keys()) if (!wanted.has(key)) this.images.delete(key);
    for (const texture of wanted) {
      if (this.images.has(texture)) continue;
      const img = new Image();
      this.images.set(texture, img);
      img.onload = () => {
        if (this.destroyed) return;
        const item = this.sim.customFish.find(f => f.texture === texture);
        try { img.skin = prepareKoiSkin(img, item?.appearance); } catch { /* A damaged saved PNG keeps a native koi visible. */ }
        this.render();
      };
      img.src = texture;
    }
    this.render();
  }
  destroy() {
    this.destroyed = true; this.running = false;
    cancelAnimationFrame(this.frame);
    this.resizeObserver.disconnect();
    this.stopWatchingDeviceScale?.();
    window.removeEventListener('resize', this.handleResize);
    document.removeEventListener('visibilitychange', this.handleVisibility);
    for (const img of this.images.values()) img.onload = null;
    this.images.clear();
    this.shadowSprite.width = this.shadowSprite.height = 0;
    this.sparkleSprite.width = this.sparkleSprite.height = 0;
    this.scenery.destroy(); this.landscape.destroy(); this.turtleRenderer.destroy();
  }

  render() {
    const ctx = this.ctx;
    if (!ctx || this.destroyed) return;
    this.landscape.render(this.sim.time, this.options, this.sim.hand);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.save();
    this.drawWater();
    // §11.2 层 6「鱼卵群」。卵在池底 / 岸边石缝 ⇒ 画在水色之后、荷叶与鱼之前：
    // 荷叶浮在水面、鱼从卵上方盖过去，都是对的。
    this.drawEggs();
    if (this.options.season === 'summer') this.drawLotus();
    const turtleScale = clamp(Math.min(this.width / 1250, this.height / 780), .78, 1.15);
    for (const turtle of this.sim.turtles) this.turtleRenderer.draw(ctx, turtle, {scale:turtleScale,night:this.options.night,shadow:true});
    for (const fish of this.sim.fish) this.drawFish(fish, true);
    for (const fish of this.sim.fish) this.drawFish(fish, false);
    for (const turtle of this.sim.turtles) this.turtleRenderer.draw(ctx, turtle, {scale:turtleScale,night:this.options.night});
    if (this.options.season === 'winter' || this.options.weather === 'snowy') this.drawIce();
    this.scenery.clouds(ctx, this.atmosphere, this.width, this.height, this.options);
    drawSurfaceRipples(ctx, this.sim.time, this.width, this.height, this.options);
    drawShoreRipples(ctx, this.sim.time, this.width, this.height, this.options, this.isWater);
    this.drawFood();
    this.drawRipples();
    this.drawFeedCircles();
    this.scenery.leaves(ctx, this.atmosphere, this.width, this.height, this.options);
    this.scenery.rain(ctx, this.atmosphere, this.width, this.height, this.options);
    this.drawWeather();
    this.drawInsects();
    ctx.restore();
  }

  drawWater() {
    const ctx = this.ctx, { weather, night, reducedMotion } = this.options;
    const t = reducedMotion ? 0 : this.sim.time;
    if (night) {
      ctx.fillStyle = 'rgba(7,25,39,.22)'; ctx.fillRect(0, 0, this.width, this.height);
      const moon = ctx.createRadialGradient(this.width * 0.72, this.height * 0.18, 0, this.width * 0.72, this.height * 0.18, this.width * 0.32);
      moon.addColorStop(0, 'rgba(176,224,230,.10)'); moon.addColorStop(1, 'rgba(131,204,215,0)');
      ctx.fillStyle = moon; ctx.fillRect(0, 0, this.width, this.height);
    } else if (weather === 'sunny') {
      // §10.5 白天「阳光照耀」= 高斯光池 + 偶发梦幻光柱。
      // 老代码这里是**一条硬编码的** `.10` 径向、位置 `y .16h` —— 附录 A.2 #1/#2
      // 两条坑写的正是它（"光池铺满无明暗" / "压最亮处烧白"）。现在峰值/σ/位置
      // 全部由 `LightField` 按 F-10.5.2 给，画布只是它的一次投影。
      this.drawLightPool();
      this.drawShafts();
    } else if (weather === 'cloudy' || weather === 'rainy' || weather === 'stormy') {
      ctx.fillStyle = weather === 'stormy' ? 'rgba(22,40,58,.25)' : weather === 'rainy' ? 'rgba(33,62,69,.18)' : 'rgba(41,70,66,.09)'; ctx.fillRect(0, 0, this.width, this.height);
    }
    if (this.options.quality === 'low') return;
    ctx.save(); ctx.globalCompositeOperation = 'screen'; ctx.lineWidth = 0.6;
    for (let i = 0; i < 10; i++) {
      const m = this.motes[i];
      const x = this.width * (0.17 + m.x * 0.64) + Math.sin(t * 0.07 + i) * 15;
      const y = this.height * (0.16 + m.y * 0.7) + Math.cos(t * 0.09 + i) * 12;
      ctx.strokeStyle = `rgba(221,246,200,${night ? 0.015 : 0.025 + Math.sin(t * 0.4 + i) * 0.009})`;
      ctx.beginPath(); ctx.ellipse(x, y, 38 + m.seed * 54, 13 + m.seed * 24, m.seed * 3, 0.4, 4.9); ctx.stroke();
    }
    ctx.restore();
    this.drawSparkles(t);
  }

  /**
   * F-10.5.2 光池。高斯（峰值 .55、σ .26、y ≈ .26h）投影到画布上就是一条径向。
   *
   * ⚠️ 这里有两套**不同量纲**的数字，混起来就错了：
   *   · `.55` 是**光场标量**（lit），用来算鱼亮度，不直接上画布；
   *   · `.16` 是**颜料浓度**（这条径向涂多浓），来自附录 A.2 #2。
   *   把 .55 当 alpha 用，画面立刻白洗（就是那个坑本身）。
   */
  drawLightPool() {
    const ctx = this.ctx;
    const [r, g, b] = this.light.channels.tint;
    const sigma = LIGHT.poolSigma * Math.min(this.width, this.height);
    const cx = this.width * LIGHT.poolX;
    const cy = this.height * LIGHT.poolY;
    const radius = sigma * 2.6;
    const pool = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
    // 三个 stop 是按高斯 `e^(−r²/2σ²)` 算的，不是随手拉的：
    // r=.91σ → .66　r=1.77σ → .21　r=2.6σ → .034
    pool.addColorStop(0, `rgba(${r},${g},${b},${POOL_INK})`);
    pool.addColorStop(0.35, `rgba(${r},${g},${b},${POOL_INK * 0.62})`);
    pool.addColorStop(0.68, `rgba(${r},${g},${b},${POOL_INK * 0.22})`);
    pool.addColorStop(1, `rgba(${r},${g},${b},0)`);
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    ctx.fillStyle = pool;
    ctx.fillRect(0, 0, this.width, this.height);
    ctx.restore();
  }

  /**
   * F-10.5.4 / F-10.5.5 光柱。几何与 `LightField.shaftGeometry` **共用一套坐标口径** ——
   * 这样"画出来的亮带"与"鱼读到的 lit"永远是同一个东西，不会出现
   * 「看起来亮在左边、鱼却在右边开始提亮」的错位。
   *
   * ⚠️ 纵向淡出靠**切片**，不是靠第二个渐变：canvas 的渐变只能是一维的，
   *    要同时表达「横向软边 × 纵向进出」就必须把带子切段、每段一个 `globalAlpha`。
   *    20 段 —— 再少会在淡出段看到台阶，再多就是白付建路径的钱（每帧最多 2 束）。
   */
  drawShafts() {
    const shafts = this.light.activeShafts();
    if (!shafts.length) return;
    const ctx = this.ctx;
    const [r, g, b] = this.light.channels.tint;
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    const slices = 20;
    for (const shaft of shafts) {
      const geo = this.light.shaftGeometry(shaft, this.width, this.height);
      const glow = ctx.createLinearGradient(geo.cx - geo.halfWidth, 0, geo.cx + geo.halfWidth, 0);
      glow.addColorStop(0, `rgba(${r},${g},${b},0)`);
      glow.addColorStop(0.5, `rgba(${r},${g},${b},1)`);
      glow.addColorStop(1, `rgba(${r},${g},${b},0)`);
      ctx.fillStyle = glow;
      const span = geo.bottom - geo.top;
      for (let i = 0; i < slices; i++) {
        const y0 = geo.top + (span * i) / slices;
        const y1 = geo.top + (span * (i + 1)) / slices;
        const ends = Math.sin(Math.PI * clamp(geo.alongAt((y0 + y1) * 0.5), 0, 1));
        const alpha = SHAFT_INK * shaft.envelope * ends * ends;
        if (alpha < 0.002) continue;
        ctx.globalAlpha = alpha;
        ctx.beginPath();
        ctx.moveTo(geo.axisAt(y0) - geo.halfWidth, y0);
        ctx.lineTo(geo.axisAt(y1) - geo.halfWidth, y1);
        ctx.lineTo(geo.axisAt(y1) + geo.halfWidth, y1);
        ctx.lineTo(geo.axisAt(y0) + geo.halfWidth, y0);
        ctx.closePath();
        ctx.fill();
      }
    }
    ctx.restore();
    this.drawLightBands(shafts);
  }

  /**
   * §11.2 层 12「明暗带（alpha .022）」。
   *
   * 光柱两侧本来就该有被对比出来的暗带 —— 阳光从云缝下来时，亮带旁边那片水面
   * **并没有真的变暗**，是眼睛把它读暗了。所以这里只补一层极淡的暗色，让亮带"坐得住"。
   * ⚠️ 这一层的全部本事就在"几乎看不见"：需求把它定死在 `.022`，
   *    调到 .06 就变成两条脏边，调到 0 亮带就"飘"在水面上没有落点。
   */
  drawLightBands(shafts) {
    const ctx = this.ctx;
    const slices = 8;
    ctx.save();
    ctx.fillStyle = `rgba(9,32,32,${LIGHT_BAND_INK})`;
    for (const shaft of shafts) {
      const geo = this.light.shaftGeometry(shaft, this.width, this.height);
      const span = geo.bottom - geo.top;
      for (const side of [-1, 1]) {
        const inner = geo.halfWidth * 1.04 * side;
        const outer = geo.halfWidth * 1.9 * side;
        for (let i = 0; i < slices; i++) {
          const y0 = geo.top + (span * i) / slices;
          const y1 = geo.top + (span * (i + 1)) / slices;
          const ends = Math.sin(Math.PI * clamp(geo.alongAt((y0 + y1) * 0.5), 0, 1));
          if (ends * ends < 0.05) continue;
          ctx.globalAlpha = shaft.envelope * ends * ends;
          ctx.beginPath();
          ctx.moveTo(geo.axisAt(y0) + inner, y0);
          ctx.lineTo(geo.axisAt(y1) + inner, y1);
          ctx.lineTo(geo.axisAt(y1) + outer, y1);
          ctx.lineTo(geo.axisAt(y0) + outer, y0);
          ctx.closePath();
          ctx.fill();
        }
      }
    }
    ctx.restore();
  }

  /**
   * §11.2 层 13「碎光」。需求 F-10.4.4 把它列为**光照调制通道之一**（不是独立的天气特效），
   * 所以强度跟着 `channels.sparkle` 走：晴 1 → 多云 .44 → 雨 .26 → 暴雨 .16。
   *
   * ⚠️ 位置不是随便撒的。碎光是**阳光在水面的镜面反射**，暗处不该有。
   *    候选点先用 `lightAt` 过一遍，只有落在光池/光柱里的才画 ——
   *    撒满全屏会读成"星星"，而不是"阳光在水上晃"。
   */
  drawSparkles(t) {
    const sparkle = this.light.channels.sparkle;
    if (sparkle <= 0.04 || this.options.quality !== 'high') return;
    const ctx = this.ctx;
    const count = 26;
    const reference = this.light.referenceLit;
    const reach = LIGHT.poolPeak + LIGHT.shaftPeak;
    const size = this.sparkleSprite.width;
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    for (let i = 0; i < count; i++) {
      const m = this.motes[(i * 17) % this.motes.length];
      const x = this.width * (0.08 + m.x * 0.86) + Math.sin(t * 0.11 + i * 1.7) * 9;
      const y = this.height * (0.08 + m.y * 0.86) + Math.cos(t * 0.13 + i * 2.1) * 8;
      const gain = clamp((this.light.lightAt(x, y, this.width, this.height) - reference) / reach, 0, 1);
      if (gain <= 0.02) continue;
      const flicker = 0.55 + 0.45 * Math.sin(t * (1.6 + m.seed * 2.4) + m.seed * TAU);
      const alpha = SPARKLE_INK * sparkle * gain * flicker;
      if (alpha < 0.01) continue;
      const scale = 4 + m.seed * 6;
      ctx.globalAlpha = alpha;
      ctx.drawImage(this.sparkleSprite, x - scale * 0.5, y - scale * 0.5, scale, scale);
    }
    ctx.restore();
  }

  /**
   * §11.2 层 6「鱼卵群」（§8.2 繁殖全过程 步骤 3–5 的视觉）。
   *
   * 需求 §8.2 把卵这一段写得很具体，三件事都要看得见：
   *   步骤 3 产卵     —— 水草/石上（落点由行为层派在靠岸环带上，见 eco-bridge.clutchAnchor）
   *   步骤 4 受精判定 —— 未受精卵**变白淡出**（产卵后 1 池塘日内结算完 ⇒ `egg.settle` 1→0）
   *   步骤 5 孵化     —— 卵粒**搏动**
   *
   * ⚠️ 渲染层只读 `sim.eggs` 的**视图字段**，不认识「一窝」「受精率」这些生态概念 ——
   *    那两层翻译在 eco-bridge / simulation 里做完了。
   */
  drawEggs() {
    const eggs = this.sim.eggs;
    if (!eggs.length) return;
    const ctx = this.ctx;
    const still = this.options.reducedMotion;
    const t = still ? 0 : this.sim.time;
    const [fr, fg, fb] = EGG_VISUAL.fertileRgb;
    const [wr, wg, wb] = EGG_VISUAL.whiteRgb;
    const pulseRate = EGG_VISUAL.pulseHz * TAU;
    for (const egg of eggs) {
      const settle = egg.settle;
      if (settle <= 0.02) continue;              // 已结算完的未受精卵：不画
      // 步骤 5「卵粒搏动」。减动效下取 1（不搏动）—— 与虚线圈/涟漪同一套 reducedMotion 口径。
      const pulse = still ? 1 : 1 + Math.sin(t * pulseRate + egg.phase) * EGG_VISUAL.pulseAmount;
      const r = egg.size * pulse;
      // 步骤 4「变白淡出」：`white = 1 − settle` 让颜色由琥珀推向白，同时 alpha 由 1 落到 0。
      const white = 1 - settle;
      const cr = (fr + (wr - fr) * white) | 0;
      const cg = (fg + (wg - fg) * white) | 0;
      const cb = (fb + (wb - fb) * white) | 0;
      ctx.save();
      ctx.globalAlpha = settle;
      ctx.fillStyle = `rgba(${cr},${cg},${cb},.92)`;
      ctx.beginPath(); ctx.ellipse(egg.x, egg.y, r, r * 0.9, 0, 0, TAU); ctx.fill();
      // 受精卵补一个亮核：池底本来就暗、卵又只有 2–3px，没有核就只是一粒"脏点"，
      // 读不出"里面有个小的在动"。
      if (egg.fertilized) {
        ctx.fillStyle = 'rgba(255,250,224,.55)';
        ctx.beginPath(); ctx.ellipse(egg.x - r * 0.24, egg.y - r * 0.24, r * 0.34, r * 0.3, 0, 0, TAU); ctx.fill();
      }
      ctx.restore();
    }
  }

  drawFood() {
    const ctx = this.ctx, t = this.sim.time;
    for (const pellet of this.sim.food) {
      const bob = Math.sin(t * 2 + pellet.phase) * 0.65;
      const alpha = Math.min(1, (pellet.life - pellet.age) / 3);
      ctx.globalAlpha = alpha;
      ellipse(ctx, pellet.x + 1.3, pellet.y + 2.5, pellet.size + 1, pellet.size * 0.65, 'rgba(10,45,28,.25)');
      ellipse(ctx, pellet.x, pellet.y + bob, pellet.size, pellet.size * 0.8, '#a16d38');
      ellipse(ctx, pellet.x - 0.4, pellet.y - 0.5 + bob, pellet.size * 0.52, pellet.size * 0.32, '#eed3a0');
    }
    ctx.globalAlpha = 1;
  }

  /**
   * 水面涟漪（投喂落水 / 鱼吃食）。
   *
   * ★ 俯视图口径：画**正圆**，不纵向压扁、不旋转。
   *   池塘是俯视构图（`public/assets/pond.png` = 俯视透水碧潭），水面上的环就该是圆。
   *   ⚠️ 这里曾经写成 `ry = rx × 0.64` + `rotate(-0.15)`，理由是"水面远平面被压扁" ——
   *   那是**斜视**场景的投影，本项目不是斜视。判据见 `tools/check-water-rings.cjs`
   *   （包围盒宽高比必须 = 1.000，压扁会读成 0.640）。
   */
  drawRipples() {
    const ctx = this.ctx;
    for (const ripple of this.sim.ripples) {
      const progress = ripple.age / ripple.life;
      const radius = 4 + progress * 65 * ripple.strength;
      ctx.lineWidth = 0.8;
      ctx.strokeStyle = `rgba(226,248,211,${(1 - progress) ** 1.6 * 0.45 * ripple.strength})`;
      ctx.beginPath(); ctx.arc(ripple.x, ripple.y, radius, 0, TAU); ctx.stroke();
      if (progress > 0.12) {
        ctx.strokeStyle = `rgba(193,230,194,${(1 - progress) ** 1.8 * 0.2 * ripple.strength})`;
        ctx.beginPath(); ctx.arc(ripple.x, ripple.y, radius * 0.72, 0, TAU); ctx.stroke();
      }
    }
  }

  /**
   * F-2.8 投喂感应圈：点击处 1.8s 虚线圈 + 脉冲。
   * ★ 俯视图口径：**正圆**，与 `drawRipples` 同一套 —— 水面上的环一律是圆。
   *   旧注释写"画正圆像贴 UI 浮层"，那是按斜视投影推的；本项目是俯视，正圆才是对的。
   * reducedMotion 下只保留静态虚线圈，不做脉冲与流动。
   */
  drawFeedCircles() {
    const ctx = this.ctx;
    const still = this.options.reducedMotion;
    for (const circle of this.sim.feedCircles) {
      const progress = clamp(circle.age / circle.life, 0, 1);
      const fade = (1 - progress) ** 0.8;
      const breathe = still ? 1 : 1 + Math.sin(circle.age * 6.2) * 0.022;
      const r = circle.radius * breathe;
      ctx.save();
      ctx.lineWidth = 1.1;
      ctx.setLineDash([9, 7]);
      if (!still) ctx.lineDashOffset = -circle.age * 26;   // 虚线缓慢流动，暗示"这里有一圈"
      ctx.strokeStyle = `rgba(232,250,214,${0.34 * fade})`;
      ctx.beginPath(); ctx.arc(circle.x, circle.y, r, 0, TAU); ctx.stroke();
      ctx.setLineDash([]);
      // 起始脉冲：把"投喂生效了"的反馈集中在头 1/3，之后交给呼吸感
      if (!still && progress < 0.34) {
        const p = progress / 0.34;
        ctx.lineWidth = 0.4 + 1.7 * (1 - p);
        ctx.strokeStyle = `rgba(214,242,196,${0.32 * (1 - p) * (1 - p)})`;
        ctx.beginPath(); ctx.arc(circle.x, circle.y, r * p, 0, TAU); ctx.stroke();
      }
      ctx.restore();
    }
  }

  drawLotus() {
    const ctx = this.ctx, t = this.options.reducedMotion ? 0 : this.sim.time;
    const pads = [[0.76, 0.93, 26], [0.80, 0.94, 34], [0.835, 0.905, 23]];
    for (let i = 0; i < pads.length; i++) {
      const [px, py, size] = pads[i];
      ctx.save(); ctx.translate(px * this.width, py * this.height + Math.sin(t * 0.5 + i) * 1.6);
      ctx.rotate(-0.3 + i * 0.7); ctx.scale(1, 0.67);
      ctx.shadowColor = 'rgba(9,48,31,.24)'; ctx.shadowBlur = 9; ctx.shadowOffsetY = 6;
      const g = ctx.createRadialGradient(-size * 0.3, -size * 0.3, 2, 0, 0, size);
      g.addColorStop(0, '#698357'); g.addColorStop(1, '#355f45');
      ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, size, 0.16, TAU - 0.22); ctx.closePath(); ctx.fill();
      ctx.shadowBlur = 0; ctx.shadowOffsetY = 0; ctx.strokeStyle = 'rgba(177,181,111,.22)'; ctx.lineWidth = 0.65;
      for (let j = 1; j < 10; j++) { const a = j / 10 * TAU; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(Math.cos(a) * size * 0.9, Math.sin(a) * size * 0.9); ctx.stroke(); }
      ctx.restore();
    }
    ctx.save(); ctx.translate(this.width * 0.815, this.height * 0.90 + Math.sin(t * 0.5) * 1.3);
    ctx.shadowColor = 'rgba(9,48,31,.24)'; ctx.shadowBlur = 6; ctx.shadowOffsetY = 4;
    for (let ring = 0; ring < 2; ring++) for (let i = 0; i < 7; i++) {
      ctx.save(); ctx.rotate(i / 7 * TAU + ring * 0.38);
      ctx.fillStyle = ring ? '#f6e0cf' : '#d6a6ad';
      ctx.beginPath(); ctx.moveTo(0, 2); ctx.bezierCurveTo(-8 + ring * 3, -4, -7 + ring * 2, -10, 0, -17 + ring * 6);
      ctx.bezierCurveTo(7 - ring * 2, -10, 8 - ring * 3, -4, 0, 2); ctx.fill(); ctx.restore();
    }
    ellipse(ctx, 0, 0, 3.4, 3.1, '#d3ad57'); ctx.restore();
  }

  drawIce() {
    const ctx = this.ctx;
    const width = this.width, height = this.height;
    const edge = Math.min(this.width, this.height) * 0.08;
    ctx.save();
    // Drawn above the fish: a clear frozen surface, with koi still visible below.
    ctx.globalAlpha = this.options.night ? 0.72 : 1;
    const sheen = ctx.createLinearGradient(0, height, width, 0);
    sheen.addColorStop(0, 'rgba(203,236,235,.018)');
    sheen.addColorStop(0.35, 'rgba(227,246,244,.038)');
    sheen.addColorStop(0.50, 'rgba(220,242,242,.070)');
    sheen.addColorStop(0.68, 'rgba(220,243,240,.025)');
    sheen.addColorStop(1, 'rgba(230,248,242,.042)');
    ctx.fillStyle = sheen; ctx.fillRect(0, 0, width, height);
    ctx.lineWidth = 0.65;
    const cracks = [
      [[0.19, 0.14], [0.27, 0.24], [0.31, 0.27], [0.35, 0.37], [0.43, 0.40]],
      [[0.31, 0.27], [0.38, 0.24], [0.42, 0.26]],
      [[0.90, 0.64], [0.79, 0.60], [0.73, 0.53], [0.66, 0.51], [0.61, 0.45]],
      [[0.73, 0.53], [0.70, 0.63], [0.63, 0.68]],
      [[0.22, 0.91], [0.27, 0.81], [0.37, 0.76], [0.40, 0.70]],
    ];
    for (let i = 0; i < cracks.length; i++) {
      ctx.strokeStyle = i % 2 ? 'rgba(232,252,247,.10)' : 'rgba(232,252,247,.17)';
      ctx.beginPath(); cracks[i].forEach(([x, y], j) => j ? ctx.lineTo(x * width, y * height) : ctx.moveTo(x * width, y * height)); ctx.stroke();
    }
    const gradient = ctx.createLinearGradient(0, 0, 0, edge * 1.8);
    gradient.addColorStop(0, 'rgba(208,237,229,.28)'); gradient.addColorStop(1, 'rgba(217,242,235,0)');
    ctx.fillStyle = gradient;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(this.width, 0); ctx.lineTo(this.width, edge * 0.8);
    for (let i = 18; i >= 0; i--) ctx.lineTo(this.width * i / 18, edge * (0.62 + Math.sin(i * 2.4) * 0.25));
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = 'rgba(222,245,240,.26)'; ctx.lineWidth = 0.7;
    for (let i = 0; i < 9; i++) {
      const x = this.width * (i + 0.35) / 9;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x + edge * 0.3, edge * 0.25); ctx.lineTo(x + edge * 0.18, edge * 0.52); ctx.stroke();
    }
    // Tiny settled snow grains stay at the banks instead of obscuring the pond.
    for (let i = 0; i < 46; i++) {
      const mote = this.motes[i + 20];
      const x = mote.x * width;
      const bankY = 3 + mote.seed * edge * 0.32;
      ellipse(ctx, x, i % 2 ? bankY : height - bankY, 0.65 + mote.size * 0.42, 0.5 + mote.size * 0.3, 'rgba(241,251,245,.56)');
    }
    ctx.restore();
  }

  drawWeather() {
    const ctx = this.ctx, { weather, season, reducedMotion, quality, night } = this.options;
    const t = reducedMotion ? 0 : this.sim.time;
    if (weather === 'snowy' || season === 'winter') {
      const deepWinter = ['大雪', '冬至', '小寒', '大寒'].includes(this.options.solarTerm);
      const count = weather === 'snowy' ? (quality === 'low' ? 34 : 72) : deepWinter ? 28 : 18;
      for (let i = 0; i < count; i++) {
        const m = this.motes[i];
        const x = (m.x * (this.width + 80) + Math.sin(t * 0.3 + i) * 18 + t * 4) % (this.width + 80) - 40;
        const y = (m.y * (this.height + 40) + t * (9 + m.seed * 15)) % (this.height + 40) - 20;
        ctx.globalAlpha = 0.38 + m.seed * 0.5;
        ellipse(ctx, x, y, m.size, m.size, '#eff8ec');
      }
      ctx.globalAlpha = 1;
    }
    if (weather === 'foggy') {
      for (let i = 0; i < 5; i++) {
        const m = this.motes[i];
        const x = (m.x * this.width + Math.sin(t * 0.06 + i) * this.width * 0.16);
        const y = this.height * (0.18 + m.y * 0.65);
        ctx.save(); ctx.translate(x, y); ctx.scale(2.8, 1);
        const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, this.height * 0.28);
        gradient.addColorStop(0, night ? 'rgba(159,197,197,.10)' : 'rgba(223,235,219,.18)'); gradient.addColorStop(1, 'rgba(232,242,228,0)');
        ctx.fillStyle = gradient; ctx.fillRect(-this.height, -this.height, this.height * 2, this.height * 2); ctx.restore();
      }
    }
    if (weather === 'sunny' && !night) {
      for (let i = 0; i < 19; i++) {
        const m = this.motes[i + 20];
        const opacity = Math.max(0, Math.sin(t * 0.75 + m.seed * 35)) ** 6 * 0.54;
        if (opacity < 0.02) continue;
        const x = this.width * (0.12 + m.x * 0.75) + Math.sin(t * 0.1 + i) * 5;
        const y = this.height * (0.13 + m.y * 0.73);
        ctx.strokeStyle = `rgba(246,253,214,${opacity})`; ctx.lineWidth = 0.8;
        ctx.beginPath(); ctx.moveTo(x - 2.5, y); ctx.lineTo(x + 2.5, y); ctx.moveTo(x, y - 1.2); ctx.lineTo(x, y + 1.2); ctx.stroke();
      }
    }
  }

  drawInsects() {
    const ctx = this.ctx, { night, weather, season, reducedMotion } = this.options;
    const t = reducedMotion ? 0 : this.sim.time;
    if (['rainy','stormy','snowy'].includes(weather)) return;
    if (night && season !== 'winter') {
      for (let i = 0; i < 12; i++) {
        const m = this.motes[i + 60];
        const x = this.width * (0.04 + m.x * 0.9) + Math.sin(t * 0.28 + i) * 22;
        const y = this.height * (0.2 + m.y * 0.75) + Math.sin(t * 0.39 + i * 4) * 12;
        const opacity = 0.1 + Math.max(0, Math.sin(t * 0.8 + i * 1.7)) * 0.66;
        const g = ctx.createRadialGradient(x, y, 0, x, y, 8);
        g.addColorStop(0, `rgba(236,245,145,${opacity})`); g.addColorStop(0.2, `rgba(221,239,133,${opacity * 0.4})`); g.addColorStop(1, 'rgba(223,238,143,0)');
        ctx.fillStyle = g; ctx.fillRect(x - 8, y - 8, 16, 16);
      }
      return;
    }
    if (night || weather === 'rainy' || weather === 'snowy' || season === 'winter') return;
    const count = season === 'summer' ? 3 : season === 'spring' ? 3 : 1;
    for (let i = 0; i < count; i++) {
      const m = this.motes[i + 51];
      const x = this.width * (0.15 + m.x * 0.72) + Math.sin(t * 0.15 + i * 3) * 60;
      const y = this.height * (0.18 + m.y * 0.64) + Math.cos(t * 0.19 + i) * 28;
      ctx.save(); ctx.translate(x, y); ctx.rotate(Math.sin(t * 0.15 + i) * 0.9);
      const flap = 0.26 + Math.abs(Math.sin(t * (season === 'summer' ? 27 : 11) + i)) * 0.74;
      ctx.globalAlpha = 0.77;
      if (season === 'summer') {
        ctx.strokeStyle = '#567967'; ctx.lineWidth = 1.6;
        ctx.beginPath(); ctx.moveTo(0, -4); ctx.lineTo(0, 9); ctx.stroke();
        for (const side of [-1, 1]) {
          ellipse(ctx, side * 5 * flap, -1, 7 * flap, 1.7, 'rgba(224,236,221,.65)', side * 0.3);
          ellipse(ctx, side * 4.5 * flap, 2, 6 * flap, 1.5, 'rgba(224,236,221,.55)', -side * 0.26);
        }
        ellipse(ctx, 0, -4, 1.8, 1.5, '#577565');
      } else {
        for (const side of [-1, 1]) {
          ellipse(ctx, side * 4 * flap, -1.9, 4.6 * flap, 5.5, i % 2 ? '#f1deb0' : '#edf0d6', side * 0.23);
          ellipse(ctx, side * 3.5 * flap, 3, 3.6 * flap, 3.8, i % 2 ? '#d7bb75' : '#d7dfba', -side * 0.2);
        }
        ctx.strokeStyle = '#747e50'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0, -4); ctx.lineTo(0, 5); ctx.stroke();
      }
      ctx.restore();
    }
  }
}

export default PondEngine;
