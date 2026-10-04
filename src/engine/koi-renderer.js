import {clamp} from './simulation.js';
import {koiBodyPoint,koiTailAngle,koiPectoralPose} from './koi-motion.js';
import {LIGHT, byDaylight} from './light-field.js';
const TAU = Math.PI * 2;

/**
 * §10.5 F-10.5.3「鱼亮度 = `.44 + .82×lit`」的实现方式：**乘在调色板上**。
 *
 * ⚠️ 为什么不叠一层白 —— 这是本轮最容易"看着像做对了"的地方：
 *    需求给的是一个**乘法**（明暗差 1.43 倍）。而"叠 .22 的白"作用在中间调上
 *    是 `180×.78 + 255×.22 = 197`，只有 ×1.09；亮部几乎不动、暗部被抬成灰。
 *    读起来是"鱼蒙了层雾"，不是"这条鱼正被太阳照着"。
 *    乘在调色板上则身体 / 鳍 / 头 / 斑块**一起**走，比例关系不变，
 *    也没有任何合成模式的副作用（附录 A.1 #13/#14 两条坑都是合成模式来的）。
 *
 * 缓存按「颜色 + 增益」开，增益先量化到 3 位小数，否则每个亚像素位置都是一个新键。
 */
const SHADE_CACHE = new Map();
function shadeHex(hex, gain) {
  const key = `${hex}|${gain}`;
  const cached = SHADE_CACHE.get(key);
  if (cached !== undefined) return cached;
  const n = parseInt(hex.slice(1), 16);
  const r = Math.min(255, Math.round(((n >> 16) & 255) * gain));
  const g = Math.min(255, Math.round(((n >> 8) & 255) * gain));
  const b = Math.min(255, Math.round((n & 255) * gain));
  const out = `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
  if (SHADE_CACHE.size < 4096) SHADE_CACHE.set(key, out);
  return out;
}
function shadePalette(palette, gain) {
  const out = {};
  for (const key in palette) out[key] = shadeHex(palette[key], gain);
  return out;
}
const smoothPath = (ctx, points, close = true) => {
  if (!points.length) return;
  ctx.beginPath();
  ctx.moveTo((points[0].x + points.at(-1).x) / 2, (points[0].y + points.at(-1).y) / 2);
  for (let i = 0; i < points.length; i++) {
    const next = points[(i + 1) % points.length];
    ctx.quadraticCurveTo(points[i].x, points[i].y, (points[i].x + next.x) / 2, (points[i].y + next.y) / 2);
  }
  if (close) ctx.closePath();
};
const ellipse = (ctx, x, y, rx, ry, fill, angle = 0) => {
  ctx.beginPath(); ctx.ellipse(x, y, rx, ry, angle, 0, TAU);
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
};
const palettes = [
  { base: '#f2efdf', light: '#fffdf0', side: '#9da79b', spot: '#d95b3c', fin: '#e9e0b9', accent: '#e08a52' },
  { base: '#ebad45', light: '#ffeaa1', side: '#b96e23', spot: '#f4e6c4', fin: '#f0c877', accent: '#bc672a' },
  { base: '#e4e7d9', light: '#fffbe9', side: '#7d9b88', spot: '#263d32', fin: '#d8dcb8', accent: '#e46835' },
  { base: '#dfb75b', light: '#fff0a7', side: '#948041', spot: '#d48d30', fin: '#f1db94', accent: '#c6923f' },
  { base: '#efeee0', light: '#fffcee', side: '#8da697', spot: '#dd553b', fin: '#e1e7d3', accent: '#d25839' },
  { base: '#d8e2d3', light: '#f5f1df', side: '#708b7a', spot: '#313e34', fin: '#b9cfc0', accent: '#d67d32' },
];

export class KoiRenderer {
  constructor(ctx) { this.ctx=ctx;this.width=1250;this.height=780;this.options={quality:'high'};this.images=new Map(); }
  bodyPoint(fish, u) {
    return koiBodyPoint(fish, u);
  }

  bodyPath(fish) {
    const points = [];
    for (let i = 0; i <= 20; i++) {
      const p = this.bodyPoint(fish, i / 20);
      points.push({ x: p.x - p.nx * p.width, y: p.y - p.ny * p.width });
    }
    for (let i = 20; i >= 0; i--) {
      const p = this.bodyPoint(fish, i / 20);
      points.push({ x: p.x + p.nx * p.width, y: p.y + p.ny * p.width });
    }
    smoothPath(this.ctx, points);
  }

  drawFish(fish, shadow) {
    const ctx = this.ctx;
    // ── §10.5 光照场：US-11「阳光处鱼亮、偶有梦幻光柱」──────────────────
    // ⚠️ 门是 `this.lightField` **存不存在**，不是外面的天气。
    //    没有光照场的场合（裸 KoiRenderer 的单测、鱼苗预览、手绘鱼）⇒ gain 恒为 1、
    //    dream 恒为 0，整条路径一次都不进 ⇒ 逐位不变。
    const light = this.lightField;
    let gain = 1;
    let dream = 0;
    if (light) {
      const lit = light.lightAt(fish.x, fish.y, this.width, this.height);
      gain = light.fishBrightness(lit) / light.fishBrightness(light.referenceLit);
      // 归一化分母 = 暗处 lit ⇒ 光池外的鱼 gain 恰好 1.0，只有进了光池/光柱的才提亮。
      if (!shadow && light.dream > 0) dream = light.dreamAt(fish.x, fish.y, this.width, this.height);
    }
    // F-10.5.5「柱内尾摆 ×(1+dream×.16)」。`swimAmplitude` 驱动的正是整条体波
    // （`koi-motion.js:28`），所以改它 = 改摆幅，不是改频率。
    // ⚠️ 只有柱内才克隆：克隆是分配，全池每帧都克隆一次纯属白付。
    if (dream > 0.01) fish = { ...fish, swimAmplitude: (fish.swimAmplitude ?? 0.072) * (1 + dream * LIGHT.dreamTail) };
    const skin = fish.custom && this.images.get(fish.custom.texture)?.skin;
    const basePalette = skin?.palette || palettes[fish.variant];
    const palette = gain === 1 ? basePalette : shadePalette(basePalette, Math.round(gain * 1000) / 1000);
    const scale = clamp(Math.min(this.width / 1250, this.height / 780), 0.78, 1.15);
    // §6 死亡演出：褪色 → 失衡侧翻 → 沉降 → 淡出。
    // 进度与时长由生态侧给（deathTimer / deathDuration，6–10s）；渲染层只读，不推进。
    // 手绘鱼没有这两个字段 ⇒ dying 恒为 0，行为完全不变。
    const dying = fish.dying && fish.deathDuration ? clamp(fish.deathTimer / fish.deathDuration, 0, 1) : 0;
    const tilt = dying * dying;   // 幂次让「先漂浮挣扎、后翻肚」的时序比线性更像真的
    ctx.save();
    ctx.translate(fish.x + (shadow ? 7 : 0), fish.y + (shadow ? 12 : 0) + tilt * (fish.length || 40) * 0.35);
    ctx.rotate(fish.heading);
    // 俯视图下的「侧翻」= 体宽投影收窄；1 − 0.82 ⇒ 翻到最后只剩 18% 宽度
    ctx.scale(scale, scale * (1 - tilt * 0.82));
    // ★ 昼夜连续化：原 night?0.82:0.98 硬切，现按 dayLight 插值（端点逐位一致）
    ctx.globalAlpha = shadow ? 0.22 : fish.depth * byDaylight(0.82, 0.98, this.options);
    if (dying > 0) ctx.globalAlpha *= (1 - dying) * (1 - dying);
    // §6 鱼苗「近半透明」：aFade 由 eco-bridge 按日龄算好（0.52 → 1）。
    // 手绘鱼没有这个字段 ⇒ undefined，按 1 处理，与改动前逐像素一致。
    if (fish.aFade !== undefined) ctx.globalAlpha *= shadow ? 1 : fish.aFade;
    if (shadow) {
      const stretch = fish.length / 86;
      ctx.drawImage(this.shadowSprite, -72 * stretch, -36 * stretch, 144 * stretch, 72 * stretch);
      ctx.restore(); return;
    }
    // F-10.5.5 梦幻第 1 层「aura」。**画在鱼体之前** —— 这样它只从鱼的边缘溢出来；
    // 画在鱼体之后会糊在花色上，把「梦幻」变成「失焦」。
    if (dream > 0.01) {
      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      ctx.lineJoin = 'round';
      // ⚠️ 用**描边**而不是 `ctx.scale(1.08,1.14)` 再 fill。
      //    缩放是以鱼的局部原点为心的 —— 靠近原点的体段几乎不动，
      //    只有离原点最远的尾柄才被推出去 8%，描出来的"光圈"一头有、一头没有。
      //    描边则沿轮廓均匀外扩半个线宽，前中后一致。
      ctx.lineWidth = Math.max(1.5, fish.length * 0.12);
      ctx.strokeStyle = `rgba(255,240,196,${0.16 * dream})`;
      this.bodyPath(fish);
      ctx.stroke();
      ctx.restore();
    }
    this.drawFins(fish, palette);
    this.bodyPath(fish);
    const gradient = ctx.createLinearGradient(0, -fish.length * 0.16, 0, fish.length * 0.15);
    gradient.addColorStop(0, palette.side);
    gradient.addColorStop(0.25, palette.base);
    gradient.addColorStop(0.47, palette.light);
    gradient.addColorStop(0.71, palette.base);
    gradient.addColorStop(1, palette.side);
    ctx.fillStyle = gradient; ctx.fill();
    ctx.save(); this.bodyPath(fish); ctx.clip();
    if (skin) this.drawSkin(fish, skin.surface);
    else this.drawPattern(fish, palette);
    if (this.options.quality !== 'low') this.drawScales(fish, palette);
    // §6 老鱼「体色褪淡」：叠一层**池水的青白色**（不是纯白 —— 纯白读成曝光过度，
    // 青白才读成「被水泡淡了」）。压在柱面光影（sheen）**之前**，
    // 这样褪色之后鱼还是圆的，不会变成一块平贴纸。
    if (fish.aPale > 0) {
      ctx.fillStyle = `rgba(226,236,224,${fish.aPale})`;
      ctx.fillRect(-fish.length, -fish.length, fish.length * 2, fish.length * 2);
    }
    // F-10.5.5 梦幻第 2 层「.11 暖薄光」。`.11` 是需求写死的浓度：
    // 它正好落在"看得出暖"与"洗掉本色"之间 —— 附录 A.2 #3「梦幻白洗失本色」记的就是这条。
    // ⚠️ 压在 sheen **之前**：之后会把鱼压成一片平贴纸（附录 A.2 #3 的下一句）。
    if (dream > 0.01) {
      ctx.fillStyle = `rgba(255,242,206,${LIGHT.dreamThin * dream})`;
      ctx.fillRect(-fish.length, -fish.length, fish.length * 2, fish.length * 2);
    }
    // A soft dorsal sheen gives every fish a rounded body in the water.
    // F-10.5.5 梦幻第 3 层「背脊 sheen」。
    //
    // ⚠️⚠️ sheen 的**颜色也要乘以 gain**，这是本轮踩得最深的一个坑。
    //
    //    sheen 是画在调色板**之后**的一层固定叠色：暗档 `rgba(7,35,28,.43)` 把鱼压向近黑、
    //    高光档把鱼拉向 255。**"拉向一个固定值"这件事本身会压缩倍数** ——
    //    你乘多少倍，它都往回拽一点。实测：只乘调色板时，鱼体**合成后**的像素倍数
    //    稳定在 **1.19**（三通道 1.19/1.19/1.23，确实是纯乘法，就是不够）。
    //
    //    把 sheen 的颜色一起抬起来，就等于让"被压暗的那部分"跟着一起亮 ——
    //    暗档 7→10、35→50 看似几乎没动，但**乘之后它们不再把结果钳在原地**。
    //    高光档会撞 255 上限（物理上就该撞：再亮也只能到白），所以中段仍会留一点压缩，
    //    最终落在 1.4 上下，而不是 1.19。
    //
    //    `lift()` 在 gain === 1 时原样返回 ⇒ 没进光照的鱼逐位不变。
    const lift = (v) => (gain === 1 ? v : Math.min(255, Math.round(v * gain)));
    const sheen = ctx.createLinearGradient(0, -fish.length * 0.12, 0, fish.length * 0.12);
    sheen.addColorStop(0, `rgba(${lift(7)},${lift(35)},${lift(28)},.43)`);
    sheen.addColorStop(0.43, `rgba(${lift(255)},${lift(255)},${lift(235)},${Math.min(0.95, 0.23 + 0.17 * dream)})`);
    sheen.addColorStop(0.59, `rgba(${lift(255)},${lift(255)},${lift(235)},.06)`);
    sheen.addColorStop(1, `rgba(${lift(5)},${lift(35)},${lift(27)},.45)`);
    ctx.fillStyle = sheen; ctx.fillRect(-fish.length, -fish.length, fish.length * 2, fish.length * 2);
    ctx.restore();
    this.drawHead(fish, palette);
    ctx.restore();
  }

  drawFins(fish, palette) {
    const ctx = this.ctx, l = fish.length;
    const root = this.bodyPoint(fish, 0);
    const tail = {x:0,y:0};
    ctx.save(); ctx.translate(root.x,root.y); ctx.rotate(koiTailAngle(fish));
    // Flexible fin tips follow the tail stalk a fraction of a stroke later.
    const wag = Math.sin(fish.phase - 4.65) * l * (fish.swimAmplitude ?? .072) * .7;
    const finGradient = ctx.createLinearGradient(tail.x, tail.y, tail.x - l * 0.27, tail.y);
    finGradient.addColorStop(0, palette.base);
    finGradient.addColorStop(0.65, palette.fin + 'bf');
    finGradient.addColorStop(1, palette.fin + '40');
    ctx.fillStyle = finGradient;
    ctx.beginPath(); ctx.moveTo(tail.x + 4, tail.y);
    ctx.bezierCurveTo(tail.x - l * 0.11, tail.y - l * 0.03, tail.x - l * 0.2, tail.y - l * 0.18 + wag, tail.x - l * 0.27, tail.y - l * 0.13 + wag);
    ctx.quadraticCurveTo(tail.x - l * 0.24, tail.y + wag, tail.x - l * 0.19, tail.y + wag * 0.7);
    ctx.quadraticCurveTo(tail.x - l * 0.23, tail.y + l * 0.1 + wag, tail.x - l * 0.27, tail.y + l * 0.14 + wag);
    ctx.bezierCurveTo(tail.x - l * 0.17, tail.y + l * 0.15 + wag, tail.x - l * 0.1, tail.y + l * 0.015, tail.x + 4, tail.y);
    ctx.fill();
    ctx.lineWidth = 0.45; ctx.strokeStyle = palette.side + '70';
    for (let i = -2; i <= 2; i++) {
      ctx.beginPath(); ctx.moveTo(tail.x, tail.y);
      ctx.quadraticCurveTo(tail.x - l * 0.13, tail.y + i * l * 0.025 + wag * 0.3, tail.x - l * 0.25, tail.y + i * l * 0.061 + wag);
      ctx.stroke();
    }
    ctx.restore();
    for (const side of [-1, 1]) {
      const p = this.bodyPoint(fish, 0.72);
      const fin = koiPectoralPose(fish, side);
      const rootY = side * p.width * 0.74;
      ctx.save(); ctx.globalAlpha *= 0.77;
      ctx.translate(p.x,p.y); ctx.rotate(p.angle); p.x=0; p.y=0;
      ctx.translate(p.x,rootY); ctx.transform(1,0,fin.sweep * 3,fin.spread,0,0); ctx.translate(-p.x,-rootY);
      const g = ctx.createLinearGradient(p.x, rootY, p.x - l * 0.1, rootY + side * l * 0.17);
      g.addColorStop(0, palette.base + 'e0'); g.addColorStop(1, palette.fin + '50');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.moveTo(p.x + l * 0.025, rootY);
      ctx.bezierCurveTo(p.x - l * 0.035, rootY + side * l * 0.21, p.x - l * 0.16, rootY + side * l * .14, p.x - l * 0.19, rootY + side * l * 0.08);
      ctx.quadraticCurveTo(p.x - l * 0.13, rootY + side * l * 0.025, p.x + l * 0.025, rootY);
      ctx.fill();
      ctx.strokeStyle = palette.side + '65'; ctx.lineWidth = 0.45;
      for (let i = 1; i < 5; i++) {
        ctx.beginPath(); ctx.moveTo(p.x, rootY);
        ctx.quadraticCurveTo(p.x - i * l * 0.025, rootY + side * l * 0.07, p.x - l * (0.025 + i * 0.03), rootY + side * l * (0.16 - i * 0.013)); ctx.stroke();
      }
      ctx.restore();
      const pelvic = this.bodyPoint(fish, 0.27);
      ctx.save(); ctx.globalAlpha *= .77;
      ctx.translate(pelvic.x,pelvic.y);ctx.rotate(pelvic.angle+Math.sin((fish.finPhase??fish.phase)-.8)*.06);
      pelvic.x=0;pelvic.y=0;
      ctx.fillStyle = palette.fin + '90';
      ctx.beginPath(); ctx.moveTo(pelvic.x + 5, pelvic.y + side * pelvic.width * 0.7);
      ctx.quadraticCurveTo(pelvic.x - 6, pelvic.y + side * l * 0.13, pelvic.x - 13, pelvic.y + side * l * 0.105);
      ctx.lineTo(pelvic.x - 3, pelvic.y); ctx.fill();
      ctx.restore();
    }
  }

  patch(fish, u, offset, rx, ry, color, seed) {
    const ctx = this.ctx, points = [];
    for (let i = 0; i < 10; i++) {
      const a = i / 10 * TAU;
      const r = 0.76 + Math.sin(i * 3.7 + seed * 9.3) * 0.17;
      const p = this.bodyPoint(fish, u + Math.cos(a) * rx * r / .78);
      const across = (offset + Math.sin(a) * ry * r) * fish.length;
      points.push({ x: p.x + p.nx * across, y: p.y + p.ny * across });
    }
    smoothPath(ctx, points); ctx.fillStyle = color; ctx.fill();
  }

  drawPattern(fish, palette) {
    const ctx = this.ctx;
    // §6 幼鱼「花纹显现」：斑块随日龄由淡到实，鱼苗期几乎看不出斑（aPattern 0.16 → 1）。
    // 手绘鱼没有这个字段 ⇒ 1，且**不**进 save/restore 分支之外 ——
    // 注意这里始终 save/restore，但 aPattern === 1 时不改 globalAlpha，
    // 所以既有的绘制结果逐像素不变。
    const grow = fish.aPattern === undefined ? 1 : fish.aPattern;
    ctx.save();
    if (grow < 1) ctx.globalAlpha *= grow;
    if (fish.variant === 4) {
      this.patch(fish, 0.85, 0, 0.081, 0.075, palette.spot, fish.seed);
      ctx.restore(); return;
    }
    if (fish.variant === 3) {
      this.patch(fish, 0.17, 0, 0.08, 0.03, '#f3d885', 1);
      ctx.restore(); return;
    }
    this.patch(fish, 0.77, -0.014, 0.116, 0.145, palette.spot, fish.seed);
    this.patch(fish, 0.48, 0.018, 0.131, 0.118, palette.spot, fish.seed + 4);
    this.patch(fish, 0.22, -0.013, 0.08, 0.07, palette.spot, fish.seed + 8);
    if (fish.variant === 2 || fish.variant === 5) {
      this.patch(fish, 0.9, 0, 0.056, 0.049, palette.accent, fish.seed + 2);
      this.patch(fish, 0.57, -0.071, 0.045, 0.061, palette.accent, fish.seed + 1);
    }
    if (fish.variant === 1) this.patch(fish, 0.96, 0.01, 0.06, 0.06, '#f2dfbd', 2);
    ctx.restore();
  }

  drawScales(fish) {
    const ctx = this.ctx, l = fish.length;
    ctx.lineWidth = 0.34;
    ctx.strokeStyle = fish.variant === 3 ? 'rgba(113,98,40,.25)' : 'rgba(76,89,66,.12)';
    for (let row = -2; row <= 2; row++) {
      for (let column = 2; column < 12; column++) {
        const u = column / 15 + (Math.abs(row) % 2) * 0.026;
        const p = this.bodyPoint(fish, u);
        const across = row * l * .035;
        ctx.beginPath(); ctx.ellipse(p.x+p.nx*across, p.y+p.ny*across, l * 0.023, l * 0.025, p.angle, -Math.PI * 0.5, Math.PI * 0.5); ctx.stroke();
      }
    }
    ctx.strokeStyle = 'rgba(255,254,216,.4)'; ctx.lineWidth = 0.6;
    ctx.beginPath();
    for(let i=0;i<=12;i++){const p=this.bodyPoint(fish,.30+i*.034);if(i)ctx.lineTo(p.x,p.y);else ctx.moveTo(p.x,p.y)}
    ctx.stroke();
  }

  drawHead(fish, palette) {
    const ctx = this.ctx, l = fish.length;
    const p = this.bodyPoint(fish, 0.88);
    ctx.lineWidth = 0.65;
    for (const side of [-1, 1]) {
      ellipse(ctx, p.x + l * 0.01, p.y + side * l * 0.04, l * 0.0145, l * 0.018, palette.side);
      ellipse(ctx, p.x + l * 0.013, p.y + side * l * 0.04, l * 0.0085, l * 0.011, '#172f29');
      ellipse(ctx, p.x + l * 0.016, p.y + side * l * 0.039, l * 0.0025, l * 0.0032, '#e9eec9');
      const gill = this.bodyPoint(fish, 0.77);
      ctx.strokeStyle = 'rgba(75,92,65,.36)';
      ctx.beginPath(); ctx.moveTo(gill.x + l * 0.014, gill.y + side * l * 0.02);
      ctx.quadraticCurveTo(gill.x - l * 0.028, gill.y + side * l * 0.075, gill.x - l * 0.055, gill.y + side * l * 0.083); ctx.stroke();
      this.drawBarbels(fish, palette, side);
    }
    ctx.strokeStyle = 'rgba(109,82,50,.38)'; ctx.lineWidth = 0.55;
    ctx.beginPath(); ctx.moveTo(l * 0.387, -l * 0.016); ctx.quadraticCurveTo(l * 0.368, 0, l * 0.387, l * 0.016); ctx.stroke();
  }

  /**
   * §6 锦鲤的须：嘴部两侧各一对，共 4 条 —— 上唇一对短、嘴角一对长。
   *
   * ⚠️⚠️ 须根坐标全部按「吻部改钝后」的新轮廓标定，别再照抄旧值。
   *   旧版只有 1 对短须，根在 (l·.379, ±l·.014)。那时吻端半宽只有 0.30px（针尖），
   *   改钝后吻端半宽是 2.30px —— 轮廓形状整个变了。
   *   用 `tools/probe-koi-barbel.cjs` 实测：旧须根 (l·.379, ±l·.014) 虽仍落在
   *   新轮廓内（余量 1.64px），但**旧须尖 (l·.44, ±l·.057) 已浮出轮廓外 1.12px**。
   *   所以下面这组值是按新轮廓重扫出来的，不是从旧值挪的。
   *
   * 坐标的三点都写成 `l` 的比例 ⇒ 跨 length 线性缩放，与身体其余部分同构。
   * 根的位置经 4 档 length（43/60/76/104）实扫取最安全的一组：
   *   上唇须根 (l·.383, ±l·.010) ⇒ L43 余量 1.84px、L104 余量 4.5px
   *   嘴角须根 (l·.366, ±l·.020) ⇒ L43 余量 1.05px、L104 余量 2.48px
   * 余量 = 轮廓半宽 − |y|，须大于线宽 0.62px 才不会「根画在轮廓外」。
   *
   * 摆动：`finPhase` 驱动，须子随手游节奏轻摆；嘴角须摆幅比上唇须大（长须更飘）。
   * 摆动用 `sin` 而非 `phase`，避免和体波同相导致须子看起来是身体的一部分。
   *
   * ★ 描边色带 `barbel/` 前缀：这是给量具用的**来源标记**。
   *   为什么需要：`drawHead` 里除须子外还有嘴线（`moveTo(l·.387, ±l·.016)`，长 1.9px），
   *   它和短须在位置上高度重叠 —— 我试过用长度阈值区分，须长 3.4px、嘴线 1.9px，
   *   阈值卡在 1.8px 时嘴线照样混进来（实测混了三次）。
   *   ⇒ **靠阈值猜"这是须子还是嘴线"本质上脆**；打标记才是可靠做法。
   *
   *   ⚠️⚠️ 标记**绝不能真的落进 canvas**：非法颜色字符串会让 `strokeStyle` 保持**旧值**，
   *   于是须子会用上一条描边（鳃线）的颜色画 —— 颜色错乱，而且**不报错**。
   *   所以下面用 `setBarbelMark(stroke, isUpper)` 打标记后**立刻把 strokeStyle 还原成合法值**，
   *   标记只活在量具的假 ctx 上（真 ctx 的 `setBarbelMark` 什么都不做）。
   */
  drawBarbels(fish, palette, side) {
    const ctx = this.ctx, l = fish.length;
    const swing = Math.sin((fish.finPhase ?? 0) * 1.7) * l * 0.004;
    const curl = Math.cos((fish.finPhase ?? 0) * 1.7) * l * 0.003;
    // 上唇须：短、靠中线、几乎伸直（真实锦鲤的上唇须最短且最直）
    ctx.lineWidth = 0.5;
    ctx.strokeStyle = palette.fin + 'b8';
    ctx.setBarbelMark?.(true);
    ctx.beginPath();
    ctx.moveTo(l * 0.383, side * l * 0.010);
    ctx.quadraticCurveTo(l * 0.404 + swing, side * l * 0.022 + curl, l * 0.428 + swing * 1.6, side * l * 0.036 + curl * 1.6);
    ctx.stroke();
    // 嘴角须：长、靠外、明显外撇并带一点下垂弧（这是锦鲤的招牌特征）
    ctx.lineWidth = 0.62;
    ctx.strokeStyle = palette.fin + 'a4';
    ctx.setBarbelMark?.(false);
    ctx.beginPath();
    ctx.moveTo(l * 0.366, side * l * 0.020);
    ctx.quadraticCurveTo(l * 0.400 + swing * 1.4, side * l * 0.052 + curl, l * 0.437 + swing * 2.2, side * l * 0.092 + curl * 2.2);
    ctx.stroke();
  }

  drawSkin(fish, surface) {
    const ctx=this.ctx, strips=this.options.skinStrips || (this.options.quality==='low'?18:Math.min(112,Math.max(36,Math.ceil(fish.length*.5))));
    // Follow each cross-section of the actual fish body, preserving the painted placement.
    for(let i=0;i<strips;i++){
      const u=(i+.5)/strips,p=this.bodyPoint(fish,u),dw=fish.length*.78/strips;
      ctx.save();ctx.translate(p.x,p.y);ctx.rotate(p.angle);
      ctx.drawImage(surface,i*surface.width/strips,0,surface.width/strips,surface.height,-dw*.5,-p.width,dw+.6,p.width*2);
      ctx.restore();
    }
  }
}
