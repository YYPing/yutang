/**
 * 花/苞**整簇**在 1×（真实尺寸）下的全景切片 —— 目视验收用。
 *
 * ★ 为什么必须看 1× 全簇，而不是 8× 单朵：
 *   `_zoom-leaf.cjs` 放大到 160~320px，能看清「一朵花像不像花」，
 *   但**看不出簇的整体观感**。用户抱怨的「不好看」有两层：
 *     ① 单朵形态不对（8× 能抓）
 *     ② 簇的密度/大小/间距不对（只有 1× 能抓）
 *   实测教训：荷叶 8× 下完美、1× 下仍像「被咬了一口」；
 *   荷花 8× 下像花，1× 下 30px 的花在 1380px 画幅上就是几个色块。
 *
 * 做法：正常渲染（不动其他图层）→ 只截图** flora 簇的包围盒 + 边距」，
 *   再放大到 ≥600px。**不隔离图层**（要看水色/反光下的真实观感）。
 *
 * 用法：node tools/_flora-pano.cjs [节气=夏至] [形态=auto] [边距px=170]
 *   形态 auto = 优先 flower，其次 bud
 */
const PW = require('C:/Users/Y/.workbuddy/binaries/node/workspace/node_modules/playwright-core');
const { join } = require('node:path');
const fs = require('node:fs');

const ROOT = join(__dirname, '..');
const OUT = join(ROOT, 'out', 'flora-pano');
const URL = process.env.TERM_URL || 'http://127.0.0.1:5188/';
const EXE = 'C:/Users/Y/AppData/Local/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-win64/chrome-headless-shell.exe';
const TERM = process.argv[2] || '夏至';
const KIND = process.argv[3] || 'auto';
const PAD = Number(process.argv[4] || 170);

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await PW.chromium.launch({ executablePath: EXE, args: ['--no-sandbox', '--use-gl=swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1380, height: 900 } });
  page.on('pageerror', (e) => console.log('PAGEERROR ' + e.message));

  await page.goto(URL, { waitUntil: 'load', timeout: 60000 });
  await page.evaluate((t) => localStorage.setItem('fusheng-settings', JSON.stringify({
    season: 'summer', weather: 'sunny', day: 'day', fishCount: 0, fishSize: 1,
    turtleCount: 0, quality: 'high', reducedMotion: true, sound: false, volume: 0,
    ecoMode: false, almanacMode: 'manual', almanacTerm: t,
  })), TERM);
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => !!window.__pondEngine, null, { timeout: 20000 });

  /* 冻结：把鱼/水波/焦散全停掉，让截图只反映**静态构图**。
   * ⚠️ motes 钉值不删（drawWater 读 motes[0..9]），sim.hand 也不能置空。 */
  const info = await page.evaluate(() => {
    const e = window.__pondEngine;
    e.updateOptions({ paused: true });
    e.sim.fish.length = 0; e.sim.turtles.length = 0;
    e.sim.time = 0; e.sim.hand = { x: 0, y: 0, life: 0 };
    e.light.time = 0; e.light.shafts.length = 0; e.light.nextShaft = 1e6; e.light.random = () => 0.5;
    e.atmosphere.random = () => 0.5; e.atmosphere.time = 0;
    e.motes.forEach((m, i) => {
      m.x = ((i * 37) % 120) / 120; m.y = ((i * 53) % 120) / 120;
      m.seed = ((i * 17) % 100) / 100; m.size = 1 + (((i * 7) % 10) / 10) * 2;
    });
    e.landscape.lastDraw = null;
    e.render();
    const v = e.termVisual;
    return { leaf: v.leafCount, lotus: v.lotusCount, bud: v.budCount, pod: v.podCount,
      raw: v.rawOpenness,
      manifest: JSON.parse(JSON.stringify(e.floraManifest)) };
  });
  await page.waitForTimeout(320);

  const m = info.manifest;
  const order = KIND === 'auto' ? ['flower', 'bud'] : [KIND];
  let box = null, which = null;
  for (const k of order) {
    const l = m[k] || [];
    if (!l.length) continue;
    /* 整簇包围盒（比例坐标 → 像素） */
    const xs = l.map((p) => p.x), ys = l.map((p) => p.y), rs = l.map((p) => p.r);
    box = {
      x0: Math.min(...xs), y0: Math.min(...ys), y1: Math.max(...ys), x1: Math.max(...xs),
      r: Math.max(...rs),
    };
    which = k; break;
  }
  if (!box) { console.log(`${TERM} 形态 ${order[0]} 落点 0 —— 该档没画`); await browser.close(); return; }

  const cv = await page.$('canvas.pond-canvas');
  const bb = await cv.boundingBox();
  const sx = box.x0, sy = box.y1, sw = box.x1 - box.x0, sh = box.y0 - box.y1;
  const clip = {
    x: Math.max(0, bb.x + sx * bb.width - PAD),
    y: Math.max(0, bb.y + sy * bb.height - PAD),
    width: Math.min(bb.width, sw * bb.width + PAD * 2),
    height: Math.min(bb.height, sh * bb.height + PAD * 2),
  };
  const f = join(OUT, `${TERM}-${which}.png`);
  await page.screenshot({ path: f, clip });
  const r2 = (v) => Math.round(v);
  console.log(`${TERM} 形态 ${which}  ${r2(clip.width)}x${r2(clip.height)}  簇 bbox x∈[${box.x0.toFixed(2)},${box.x1.toFixed(2)}] y∈[${box.y0.toFixed(2)},${box.y1.toFixed(2)}]  r=${box.r.toFixed(1)}px  raw=${info.raw.toFixed(3)}`);
  console.log(`  落点数 ${(m[which] || []).length}  →  ${f}`);
  /* 1× 整屏：看整幅画面里簇的密度/大小/间距观感 */
  await page.screenshot({ path: join(OUT, `${TERM}-full.png`) });
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
