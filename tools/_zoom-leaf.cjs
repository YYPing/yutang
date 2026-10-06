/**
 * 隔离渲染单片**荷花形态**并放大 —— 目视验收用。
 *
 * ★ 为什么必须隔离：正常画面里荷叶只有 23~40px，且叠在水波/焦散/鱼身上，
 *   截出来根本看不出形态。而**存在的形态缺陷**（车胎黑环、中心黑洞、脉络被抗锯齿吃掉、
 *   花苞不像花苞、开花过程跳变） 在 40px 下与「正常」在像素上只差几个通道值 ——
 *   量具 14/14 全绿时靠的就是这双眼睛。
 *   做法：清空画布 → 只调 drawLotus（关掉其他所有图层）→ toDataURL 取图。
 *
 * 用法：node tools/_zoom-leaf.cjs [节气=夏至] [放大倍数=8] [形态=leaf|bud|flower|pod|auto]
 *   形态 auto（默认）= 优先 flower（夏至有 5 朵），其次 bud，最后 leaf。
 */
const PW = require('C:/Users/Y/.workbuddy/binaries/node/workspace/node_modules/playwright-core');
const { join } = require('node:path');
const fs = require('node:fs');

const ROOT = join(__dirname, '..');
const OUT = join(ROOT, 'out', 'leaf-zoom');
const URL = process.env.TERM_URL || 'http://127.0.0.1:5188/';
const EXE = 'C:/Users/Y/AppData/Local/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-win64/chrome-headless-shell.exe';
const TERM = process.argv[2] || '夏至';
const ZOOM = Number(process.argv[3] || 8);
const KIND = process.argv[4] || 'auto';

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

  const shots = await page.evaluate(({ zoom, kind }) => {
    const e = window.__pondEngine;
    const cv = e.canvas, ctx = e.ctx;
    const W = cv.width, H = cv.height;
    const out = [];

    /* 画法：只保留 drawLotus，其余全部抹掉。
     * ⚠️ `save()/restore()` 必须配对，否则缩放/透明度会漏到下一张。 */
    const iso = (scale, which) => {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
      ctx.fillStyle = '#123a52';          /* 深水底，方便看浅色叶脉 */
      ctx.fillRect(0, 0, W, H);
      const m = e.floraManifest;
      const list = m[which] || [];
      if (!list.length) { ctx.restore(); return null; }
      const spot = list[0];
      /* 放大：把画布内容整体放大 scale 倍，让 20~40px 的花变成 160~320px */
      ctx.translate(spot.x * W, spot.y * H);
      ctx.scale(scale, scale);
      ctx.translate(-spot.x * W, -spot.y * H);
      e.drawLotus();
      const url = cv.toDataURL('image/png');
      ctx.restore();
      return { url, spot, which, counts: Object.fromEntries(
        Object.entries(m).map(([k, v]) => [k, v.length])) };
    };

    /* 先取一次 manifest（正常缩放）确定有哪些形态可画 */
    e.render();
    const m = e.floraManifest;
    const order = kind === 'auto'
      ? ['flower', 'bud', 'leaf', 'pod']
      : [kind];
    for (const which of order) {
      const shot = iso(zoom, which);
      if (shot) { out.push(shot); break; }
    }
    return out;
  }, { zoom: ZOOM, kind: KIND });

  for (const s of shots) {
    const f = join(OUT, `leaf-${TERM}.png`);
    fs.writeFileSync(f, Buffer.from(s.url.split(',')[1], 'base64'));
    console.log(`形态 ${s.which}  落点 ${s.spot.x.toFixed(3)},${s.spot.y.toFixed(3)} r=${s.spot.r.toFixed(1)}px  →  ${f}  (${s.W}x${s.H} ×${ZOOM})`);
    console.log(`  本档四形态落点数：${JSON.stringify(s.counts)}`);
  }
  if (!shots.length) console.log(`⚠ ${TERM} 没有任何可画的形态`);
  await browser.close();
})();
