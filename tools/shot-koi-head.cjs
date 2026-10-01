/**
 * 把锦鲤**头部**放大拍下来，用于逐次核对吻部形态。
 *
 * 为什么不复用 `shot-sunlight-ab.cjs`：那是量「光柱看不看得见」的，
 * 判据全是像素差值；这里是量「轮廓对不对」，要的是**看**，而且要能对照。
 *
 * ── 三个必须钉死的量（不钉死拍出来的图不可比）────────────────────────
 *  1. **鱼的运动全部冻住**：`sim.update = () => {}`，`phase` 不推进 ⇒ 体波形状固定。
 *     否则两次拍的躯干弯曲不同，叠起来看不出头部到底变了没。
 *  2. **位置与朝向钉死**：`x/y/heading` 写死，`heading = 0` ⇒ 吻部恒朝 +x（画面右）。
 *     头部在画面右侧，放大裁剪框也固定在右侧。
 *  3. **缩放走 `length`，不走画布**：`drawFish` 里 `ctx.scale(scale)` 的 `scale` 来自
 *     `renderer.width/1250`。所以想放大鱼，**加大 `fish.length`** 比改 viewport 稳 ——
 *     改 viewport 会连带改变 `scale` 与光照场采样，两者一起动就分不清是谁的锅。
 *     这里固定 viewport，只把 `length` 从 60 拉到 260（≈4.3 倍），坐标换算按比例写死。
 *
 * 用法：
 *   node tools/shot-koi-head.cjs                  # 拍默认 6 条变体 → out/koi-head-*.png
 *   node tools/shot-koi-head.cjs --tag=after      # 打标签，便于前后并列
 *   node tools/shot-koi-head.cjs --len=300        # 再放大
 */

const PW = require('C:/Users/Y/.workbuddy/binaries/node/workspace/node_modules/playwright-core');
const { join } = require('node:path');
const fs = require('node:fs');

const EXE = 'C:/Users/Y/AppData/Local/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-win64/chrome-headless-shell.exe';
const ROOT = join(__dirname, '..');
const OUT = join(ROOT, 'out');

const arg = (k, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.split('=').slice(1).join('=') : d;
};
const TAG = arg('tag', '');
const LEN = Number(arg('len', '260'));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await PW.chromium.launch({ executablePath: EXE, args: ['--no-sandbox', '--use-gl=swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 900, height: 620 }, deviceScaleFactor: 2 });
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));

  await page.setContent('<!doctype html><meta charset="utf-8"><body style="margin:0;background:#0d1f1c"></body>');
  await page.addScriptTag({ path: join(ROOT, 'src/engine/simulation.js') }).catch(() => {});
  // 只引两个纯逻辑模块：几何（koi-motion）与渲染（koi-renderer）。它们不碰 DOM，
  // 只在传入的 ctx 上画 —— 所以可以直接在页面里 new 一个 canvas 上下文喂给它们。
  for (const f of ['src/engine/koi-motion.js', 'src/engine/koi-renderer.js']) {
    const code = fs.readFileSync(join(ROOT, f), 'utf8');
    await page.addScriptTag({ content: code.replace(/^import .*?;$/gm, '').replace(/^export /gm, '') });
  }

  const VARIANTS = [0, 1, 2, 3, 4, 5];
  const shots = [];
  for (const variant of VARIANTS) {
    const file = await page.evaluate(({ variant, LEN }) => {
      // 画布按「吻部在最右」留白：长度 LEN ⇒ 局部 x 从 −.41LEN 到 +.41LEN，
      // 宽度最大 ≈ .24LEN/2。取画布 900×560、原点居中偏左，让 +x 方向留足 500px。
      const W = 900, H = 560;
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const ctx = c.getContext('2d');
      // 水色底：和池水的青绿接近，避免把鱼的白底衬托误读成"白洗"
      ctx.fillStyle = '#20423c'; ctx.fillRect(0, 0, W, H);

      const fish = {
        x: 0, y: 0, heading: 0, length: LEN, width: 0.123, variant,
        phase: 1.15, swimAmplitude: 0.055, finPhase: 0.7, depth: 1,
        seed: 0.37 * (variant + 1), speed: 40, velocity: 30,
      };
      const r = new KoiRenderer(ctx);
      r.width = 900; r.height = 560;
      r.options = { quality: 'high', night: false };
      // ⚠️ **不注入 lightField** ⇒ gain 恒为 1、dream 恒为 0。
      //    这条就是本轮量具的第一条铁律：只量形态，就别让光照场进来搅局。
      ctx.save();
      ctx.translate(330, H / 2);
      r.drawFish(fish, false);
      ctx.restore();

      // 画一条竖直参考线在吻部，并标出 0.5×/1.0× 体宽的刻度 ——
      // 没有刻度，"饱满"只是形容词。
      ctx.strokeStyle = 'rgba(255,255,255,.14)';
      ctx.lineWidth = 1;
      for (const f of [0.5, 1.0]) {
        const halfW = Math.pow(Math.sin(0.569 * Math.PI), 0.8) * LEN * 0.123 * (0.64 + 0.569 * 0.52);
        ctx.beginPath(); ctx.moveTo(330, H / 2 - halfW * f); ctx.lineTo(900, H / 2 - halfW * f); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(330, H / 2 + halfW * f); ctx.lineTo(900, H / 2 + halfW * f); ctx.stroke();
      }
      return c.toDataURL('image/png');
    }, { variant, LEN });

    const name = `koi-head${TAG ? '-' + TAG : ''}-v${variant}.png`;
    fs.writeFileSync(join(OUT, name), Buffer.from(file.split(',')[1], 'base64'));
    shots.push(name);
    console.log(`  v${variant} → out/${name}`);
  }

  // 另存两张分析图。
  //
  // ⚠️⚠️ 为什么必须有 `_silhouette` 这张（踩过才知道）：
  //   我先前拍的那张 outline 图里同时有 白线(bodyPath) / 红线(脊) / 青线(半宽剖面)
  //   / 黄点(采样点)。量具按亮度取轮廓时，**黄点(亮度≈213)、青线(≈193)、
  //   白线(≈236) 全部超过阈值** ⇒ 量到的是"最亮的那个"，不是 bodyPath。
  //   于是改前改后读数一模一样 —— 尺子坏了，不是东西没改。
  //   所以这里额外渲染一张**纯填充**：只 fill(bodyPath)，白底黑身，别无他物。
  const silhouette = await page.evaluate(({ LEN }) => {
    const W = 900, H = 560;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H);   // 白底 ⇒ 鱼是黑的
    const fish = { x: 0, y: 0, heading: 0, length: LEN, width: 0.123, variant: 2,
      phase: 1.15, swimAmplitude: 0.055, finPhase: 0.7, depth: 1, seed: 1, speed: 40, velocity: 30 };
    const r = new KoiRenderer(ctx);
    r.width = W; r.height = H;
    r.options = { quality: 'high', night: false };
    ctx.translate(330, H / 2);
    r.bodyPath(fish);
    ctx.fillStyle = '#000000';
    ctx.fill();
    return c.toDataURL('image/png');
  }, { LEN });
  fs.writeFileSync(join(OUT, `koi-head-silhouette${TAG ? '-' + TAG : ''}.png`),
    Buffer.from(silhouette.split(',')[1], 'base64'));
  console.log(`  纯轮廓(黑鱼白底) → out/koi-head-silhouette${TAG ? '-' + TAG : ''}.png   ← 量具只认这张`);

  // 带标注的诊断图：脊线 / 轮廓 / 半宽剖面 / 采样点，只供人眼看
  const outline = await page.evaluate(({ LEN }) => {
    const W = 900, H = 560;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#12211e'; ctx.fillRect(0, 0, W, H);
    const fish = { x: 0, y: 0, heading: 0, length: LEN, width: 0.123, variant: 2,
      phase: 1.15, swimAmplitude: 0.055, finPhase: 0.7, depth: 1, seed: 1, speed: 40, velocity: 30 };
    const r = new KoiRenderer(ctx);
    r.width = W; r.height = H;
    r.options = { quality: 'high', night: false };
    ctx.translate(330, H / 2);
    // 脊线：细红线，把"轮廓 vs 脊"分开看
    ctx.beginPath();
    for (let i = 0; i <= 100; i++) {
      const p = r.bodyPoint(fish, i / 100);
      if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y);
    }
    ctx.strokeStyle = 'rgba(255,120,120,.55)'; ctx.lineWidth = 1; ctx.stroke();
    // 轮廓
    r.bodyPath(fish);
    ctx.strokeStyle = '#e8f0dc'; ctx.lineWidth = 2; ctx.stroke();
    // 半宽剖面折线（右侧），把 u→width 的关系画出来
    ctx.beginPath();
    for (let i = 70; i <= 100; i++) {
      const p = r.bodyPoint(fish, i / 100);
      if (i === 70) ctx.moveTo(p.x, p.y - p.width); else ctx.lineTo(p.x, p.y - p.width);
    }
    ctx.strokeStyle = 'rgba(120,220,255,.9)'; ctx.lineWidth = 2; ctx.stroke();
    // 每 5% 打一个点，标出 bodyPath 的**实际采样点**（20 段 ⇒ 每段 .05）
    for (let i = 70; i <= 100; i += 5) {
      const p = r.bodyPoint(fish, i / 100);
      ctx.beginPath(); ctx.arc(p.x, p.y - p.width, 3, 0, Math.PI * 2);
      ctx.fillStyle = '#ffd166'; ctx.fill();
    }
    return c.toDataURL('image/png');
  }, { LEN });
  fs.writeFileSync(join(OUT, `koi-head-outline${TAG ? '-' + TAG : ''}.png`), Buffer.from(outline.split(',')[1], 'base64'));
  console.log(`  轮廓 → out/koi-head-outline${TAG ? '-' + TAG : ''}.png`);
  console.log(`\n参考线：红线=脊线　白线=bodyPath 轮廓　蓝线=u∈[.70,1] 半宽剖面　黄点=实际采样点`);
  console.log(`刻度：上下各两条横线 = 体宽峰值的 0.5× / 1.0×`);

  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });