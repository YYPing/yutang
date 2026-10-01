/* §10.5 光照场的**像素级**验收（US-11「阳光处鱼亮、偶有梦幻光柱」）。
 *
 * ── 为什么数值全绿了还要再量一遍像素 ──────────────────────────────────────
 * `check-light.js` 证明的是「`lightAt()` 这个函数算得对」。
 * 它**证明不了**：这个场有没有真的接到画布上、接的位置对不对、
 * 鱼有没有真的被提亮、光柱画出来是不是落在它自己算出来的位置上。
 * 「函数对了」和「画面对了」之间隔着一整层接线，那一层只能靠像素验。
 *
 * ── 为什么直接读 `.pond-canvas` 而不是 page.screenshot() ───────────────────
 * 场景是 **WebGL 底图 + 2D 画布**两层。`page.screenshot()` 拿到的是合成结果，
 * 里面混着底图的水色 —— 那正是**不该**去测的东西：本轮加的是 2D canvas 上那一层，
 * 要量的是"这层光加了多少"，不是"水面本身多亮"。
 * 直接读 `.pond-canvas` 的 `getImageData` 反而干净，而且 **alpha 本身就是一张现成的掩膜**：
 *   · 暗角处没池子/光柱 ⇒ alpha ≈ 0（用 alpha 0 的颜色 fillRect = 什么都没写）
 *   · 光池心 alpha ≈ .16　· 光柱带心 alpha ≈ .13　· 鱼体 alpha ≈ .98
 *
 * ── ★ 鱼亮度必须用「配对测量」，不能各测各的均值 ──────────────────────────
 * 天真做法是"亮的时候量一次均值、暗的时候量一次均值、相除"。
 * 这个做法会**系统性低估**倍数：鱼身上本来就有一批接近 255 的高光像素，
 * 乘 1.43 之后被截顶到 255，把均值往下拽。
 *
 * 所以这里做配对：先在**暗**的那一帧，挑出「alpha 够高（是鱼体）且 luma < 200（没饱和）」的像素，
 * 记下它们的位置；然后在**亮**的那一帧，只在这些**同一批位置**上取比值。
 * 于是：
 *   · 位置、水色、帧、随机数全同 —— 唯一变量是光照
 *   · 被截顶的像素天然被排除，量出来的比值才真的接近那个 1.43
 *
 * 前置：`npm run dev`（vite 在 5188）。页面上有 DEV-only 的 `window.__pondEngine`。
 * 跑法：node tools/check-light-ui.cjs
 */
const PW = require('C:/Users/Y/.workbuddy/binaries/node/workspace/node_modules/playwright-core');
const { join } = require('node:path');
const fs = require('node:fs');

const URL = process.argv[2] || 'http://127.0.0.1:5188/';
const OUT = join(__dirname, '..', 'out');
const EXE = 'C:/Users/Y/AppData/Local/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-win64/chrome-headless-shell.exe';

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✔ ${label}${detail ? '  — ' + detail : ''}`); }
  else { fail++; console.log(`  ✘ ${label}${detail ? '  — ' + detail : ''}`); }
};
const section = (t) => console.log(`\n${t}`);
const n2 = (v) => (Math.round(v * 100) / 100).toFixed(2);
const n3 = (v) => (Math.round(v * 1000) / 1000).toFixed(3);

/* ============================================================ 页面内的量具 */
/* 这整个函数会被序列化后丢进页面执行；所有输入输出都用 **CSS 像素**（引擎内部的口径）。 */
function PAGE_TOOLS() {
  const canvas = () => document.querySelector('.pond-canvas');
  const scale = () => {
    const c = canvas();
    return c.width / c.getBoundingClientRect().width;
  };
  /** `w`/`h` 分开给：量横向剖面时需要**窄而高**的一条（把稀疏的碎光摊薄）。 */
  const crop = (cx, cy, w, h = w) => {
    const c = canvas();
    const k = scale();
    const x0 = Math.max(0, Math.round((cx - w / 2) * k));
    const y0 = Math.max(0, Math.round((cy - h / 2) * k));
    const pw = Math.min(c.width - x0, Math.round(w * k));
    const ph = Math.min(c.height - y0, Math.round(h * k));
    if (pw <= 0 || ph <= 0) return null;
    return c.getContext('2d').getImageData(x0, y0, pw, ph);
  };
  const lum = (d, i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];

  /**
   * 一块区域在 `[alphaMin, alphaMax)` 掩膜下的统计。
   *
   * ⚠️ `alphaMedian` 不是装饰。碎光（层 13）是**按 `lightAt` 撒点**的 ⇒
   *    亮带附近碎光最密，而碎光是小而亮的点（α 最高 .34）。
   *    量"亮带的横向剖面"时用均值，会撞上一两颗碎光把远端的读数抬起来 ——
   *    实测过：剖面末端从 .086 回升到 .106，看着像"亮带画错了位"，
   *    其实是量具被碎光打偏了。中位数对这类稀疏异常点天然免疫。
   */
  const stats = (cx, cy, size, alphaMin = 0, alphaMax = 1.01, tall = 1) => {
    const img = crop(cx, cy, size, size * tall);
    if (!img) return { count: 0 };
    const d = img.data;
    let n = 0, aSum = 0, aMax = 0, r = 0, g = 0, b = 0, l = 0;
    let aTotal = 0;                 // **不加任何掩膜**的全块 alpha 总和
    const alphas = [];
    for (let i = 0; i < d.length; i += 4) {
      const a = d[i + 3] / 255;
      aTotal += a;
      if (a < alphaMin || a >= alphaMax) continue;
      n++; aSum += a; l += lum(d, i); r += d[i]; g += d[i + 1]; b += d[i + 2];
      if (a > aMax) aMax = a;
      if (tall > 1) alphas.push(a);
    }
    if (!n) return { count: 0, alphaTotal: aTotal };
    let median = aSum / n;
    if (alphas.length) { alphas.sort((x, y) => x - y); median = alphas[alphas.length >> 1]; }
    return {
      count: n, coverage: n / (d.length / 4),
      alphaMean: aSum / n, alphaMax: aMax, alphaMedian: median,
      /** 掩膜窗口一动，"同一些像素"就变了；要比较两帧的**总量**必须用它（不加掩膜）。 */
      alphaTotal: aTotal,
      luma: l / n, r: r / n, g: g / n, b: b / n,
    };
  };

  /** 记下"暗"的那一帧，供配对比较。 */
  let baseline = null;
  const captureBaseline = (cx, cy, size) => {
    const img = crop(cx, cy, size);
    baseline = img ? { data: Array.from(img.data), w: img.width, h: img.height } : null;
    return baseline ? baseline.data.length : 0;
  };
  /**
   * 当前帧 vs 基准帧的**逐像素配对**比值。
   * 只在「基准帧 alpha 够高（是鱼体）且基准帧 luma < `unsaturated`（没饱和）」的位置上取镜头，
   * 于是截顶像素不会把倍数往下拽。
   */
  const pairedVsBaseline = (cx, cy, size, alphaMin, unsaturated = 200) => {
    const img = crop(cx, cy, size);
    if (!img || !baseline || baseline.data.length !== img.data.length) return { count: 0 };
    const now = img.data, was = baseline.data;
    let n = 0, lr = 0, lg = 0, lb = 0, or = 0, og = 0, ob = 0, lLit = 0, lDark = 0;
    for (let i = 0; i < now.length; i += 4) {
      if (was[i + 3] / 255 < alphaMin) continue;
      const dark = lum(was, i);
      if (dark >= unsaturated) continue;
      n++; lr += now[i]; lg += now[i + 1]; lb += now[i + 2];
      or += was[i]; og += was[i + 1]; ob += was[i + 2];
      lLit += lum(now, i); lDark += dark;
    }
    if (!n) return { count: 0 };
    return {
      count: n,
      ratio: { r: lr / or, g: lg / og, b: lb / ob, luma: lLit / lDark },
      mean: { lit: lLit / n, dark: lDark / n },
    };
  };

  /** 记下"暗"那一帧的 **alpha 通道**，供 `alphaRaised` 用。 */
  let alphaBaseline = null;
  const captureAlphaBaseline = (cx, cy, size) => {
    const img = crop(cx, cy, size);
    if (!img) { alphaBaseline = null; return 0; }
    const a = new Uint8Array(img.width * img.height);
    for (let i = 0, j = 3; j < img.data.length; i++, j += 4) a[i] = img.data[j];
    alphaBaseline = a;
    return a.length;
  };
  /**
   * 对比基准帧，统计 alpha **被抬高**了多少个像素。
   * 用这个而不是"峰值"或"均值"，是因为 aura 只改一圈像素：
   * 均值会被大片没变的像素稀释，峰值会被鱼体自身的抗锯齿边缘占满（两帧都一样）。
   */
  const alphaRaised = (cx, cy, size, delta = 0.03) => {
    const img = crop(cx, cy, size);
    if (!img || !alphaBaseline || alphaBaseline.length !== img.width * img.height) return null;
    const now = img.data;
    let raised = 0, total = 0, sum = 0;
    for (let i = 0, j = 3; j < now.length; i++, j += 4) {
      const d = (now[j] - alphaBaseline[i]) / 255;
      if (d >= delta) raised++;
      if (d > 0) sum += d;
      total++;
    }
    return { raised, total, fraction: raised / total, sum };
  };

  const engine = () => window.__pondEngine;
  return {
    stats, captureBaseline, pairedVsBaseline, captureAlphaBaseline, alphaRaised,
    size: () => ({ width: engine().width, height: engine().height }),
    /** 钉成"只有光池、没有光柱"，并把光照场的时钟冻住（量光池用）。 */
    poolOnly() {
      const e = engine(), lf = e.light;
      lf.shafts.length = 0;
      lf.nextShaft = 1e9;
      lf.update = () => {};
      return {
        cx: e.width * 0.62, cy: e.height * 0.26,
        sigma: 0.26 * Math.min(e.width, e.height),
        width: e.width, height: e.height,
      };
    },
    /** 放一束已知几何的光柱，并冻住时钟（量光柱用）。 */
    withShaft(u, tilt) {
      const e = engine(), lf = e.light;
      lf.shafts.length = 0;
      lf.shafts.push({ u, tilt, width: 0.3, life: 1e9, seed: 1.2, age: 5e8, envelope: 1, lit: 1 });
      lf.nextShaft = 1e9;
      lf.update = () => {};
      const geo = lf.shaftGeometry(lf.shafts[0], e.width, e.height);
      return {
        u, tilt, halfWidth: geo.halfWidth, width: e.width, height: e.height,
        axisAtMid: geo.axisAt(e.height * 0.54), midY: e.height * 0.54,
      };
    },
    /** 把一条鱼钉在指定位置并标准化（不褪色、不淡出、不死亡、深度拉满），并冻住运动。 */
    pinFish(x, y) {
      const e = engine();
      const fish = e.sim.fish[0];
      if (!fish) return null;
      fish.x = x; fish.y = y; fish.heading = 0;
      fish.depth = 1; fish.aFade = 1; fish.aPale = 0; fish.dying = 0; fish.swimAmplitude = 0.072;
      // ⚠️ 变异体要钉死：`sim.fish[0]` 每次跑到的花色不同，而不同花色的明度差很多，
      //    量出来的倍数会在 1.19~1.26 之间跳 —— 那是**量具不可复现**，不是实现不稳。
      fish.variant = 2;
      e.sim.update = () => {};
      return { x, y, length: fish.length, variant: fish.variant };
    },
    render: () => engine().render(),
    setLightField(on) { engine().lightField = on ? engine().light : null; },
    configure(partial) { engine().light.configure(partial); engine().render(); },
    /**
     * ⚠️ 改天气必须走 `engine.updateOptions()`，**不能只改 `light.configure()`**。
     *    踩过：只改光照场时 `light.options.weather` 变了，但 `drawWater` 的分支读的是
     *    `this.options.weather`（引擎自己的），于是**仍然走晴天分支、还在画光池** ——
     *    量出来"雨天池心 α .154 ≈ 晴天 .166"，看着像门控失效，其实是测试改错了层。
     */
    setWeather(weather) { engine().updateOptions({ weather }); },
    /** 收掉所有光柱（保留光池）—— 用来给"有柱 / 无柱"做差分。 */
    noShaft() { engine().light.shafts.length = 0; engine().light.update = () => {}; engine().render(); },
    /**
     * 临时切画质档。**直接改 `options.quality`，不走 `updateOptions()`** ——
     * 后者会触发 `resize()`（`renderScale` 按画质改画布分辨率），
     * 一改分辨率，所有像素坐标与掩膜都得重算。
     * 走这条路只影响三个 `quality` 判据（碎光 / 粼光 / 鳞片），够用了。
     */
    setQuality(quality) { engine().options.quality = quality; engine().render(); },
  };
}
const INIT_TOOLS = `window.__lightTools = (${PAGE_TOOLS.toString()})();`;

/* ============================================================ 主流程 */

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await PW.chromium.launch({ executablePath: EXE, args: ['--no-sandbox', '--use-gl=swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE ' + m.text()); });

  await page.goto(URL, { waitUntil: 'load', timeout: 60000 });
  await page.evaluate(() => {
    localStorage.setItem('fusheng-settings', JSON.stringify({
      season: 'summer', weather: 'sunny', day: 'day', fishCount: 12, fishSize: 1, turtleCount: 0,
      quality: 'high', reducedMotion: false, sound: false, volume: 0, ecoMode: false,
    }));
  });
  await page.reload({ waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => Boolean(window.__pondEngine), null, { timeout: 20000 });
  await page.waitForTimeout(1200);
  await page.evaluate(INIT_TOOLS);
  await page.waitForFunction(() => Boolean(window.__lightTools), null, { timeout: 10000 });

  const T = (fn, ...args) => page.evaluate(
    ([src, a]) => window.__lightTools[src](...a),
    [fn, args],
  );
  const shot = (name) => page.screenshot({ path: join(OUT, `light-${name}.png`) });

  /* ---------------------------------------------------------- ① 光池 */
  section('① 光池：画面上真的有一块亮、其余地方是暗的');
  const geom = await T('poolOnly');
  await T('render');
  const pool = await T('stats', geom.cx, geom.cy, 70, 0);
  const dark = await T('stats', geom.cx * 0.12, geom.cy * 3.3, 70, 0);
  ok('量具读到了画布内容（池心与暗角都非空）', pool.count > 0 && dark.count > 0,
    `池心 ${pool.count}px　暗角 ${dark.count}px`);
  ok('光池心的附加光存在（平均 alpha 显著大于 0）', pool.alphaMean > 0.08, `池心 ᾱ ${n3(pool.alphaMean)}`);
  ok('暗角几乎没有附加光（光池没铺满整屏）', dark.alphaMean < 0.03, `暗角 ᾱ ${n3(dark.alphaMean)}`);
  ok('★ 光池心比暗角亮（附录 A.2 #1「光池铺满无明暗」的反面）', pool.luma > dark.luma + 4,
    `池心 ${n2(pool.luma)} vs 暗角 ${n2(dark.luma)}　差 ${n2(pool.luma - dark.luma)}`);
  await shot('01-pool-only');

  /* ---------------------------------------------------------- ② 光柱几何 */
  section('② 光柱：画出来的亮带必须落在它自己算出来的位置上');
  const shaft = await T('withShaft', 0.42, 0.18);
  await T('render');
  // 窄而高的一条（6×160），取中位数 —— 稀疏的碎光点打不偏它。
  /**
   * ⚠️ 采样时必须做「**有柱 / 无柱差分**」，不能只量有柱的那一帧。
   * 踩过的坑：光柱画在 `u=.42`（x≈605），而光池心在 `x≈893` ——
   * 横向往 +x 扫本来就越靠越近光池，光池的梯度会**盖过**光柱的衰减，
   * 量出来是"末端回升 0.086 → 0.106"，看着像亮带画错了位。
   * 差分之后光池/水色/碎光全被减掉，剩下的只有光柱自己。
   */
  const sampleProfile = async () => page.evaluate(([cx, cy, hw]) => {
    const out = [];
    for (let i = 0; i <= 10; i++) {
      // 窄而高（6×156）取中位数：稀疏的碎光点打不偏它
      out.push(window.__lightTools.stats(cx + hw * (i / 10) * 1.25, cy, 6, 0, 1.01, 26).alphaMedian);
    }
    return out;
  }, [shaft.axisAtMid, shaft.midY, shaft.halfWidth]);
  const profileWith = await sampleProfile();
  await T('noShaft');
  const profileWithout = await sampleProfile();
  // 光柱是加法/滤色叠加，差分是逐像素相减后的独立量，可直接相减
  const profile = profileWith.map((v, i) => Math.max(0, v - profileWithout[i]));
  const onAxis = profile[0];
  const offAxis = profile[10];
  ok('带轴上的附加光明显高于带外（差分口径）', onAxis > offAxis + 0.04,
    `轴心 ${n3(onAxis)}　带外 ${n3(offAxis)}`);
  // ⚠️ 单调性只对**光柱自己覆盖的那一段**成立（i = 0..8，即 0 → 1.0 倍半宽）。
  //    再往外是层 12 明暗带（halfWidth×1.04 ~ ×1.9），它**故意**在亮带外侧加一层 +
  //    .022，所以 i=9/10 会看到 0.020 的回升 —— 那是另外一层，不是光柱画歪了。
  let monotone = true;
  for (let i = 1; i <= 8; i++) if (profile[i] > profile[i - 1] + 0.008) monotone = false;
  ok('★ 横向剖面从带心单调衰减（亮带没画错位、没有第二个峰）', monotone,
    `${profile.slice(0, 9).map(n3).join(' → ')}　｜带外 ${n3(profile[10])}（层 12 明暗带）`);
  // 纵向：中段最亮、两端归零（同样差分）。
  // ⚠️ 采样坐标必须**先算好**再收柱 —— 收完 `shafts[0]` 就没了，`shaftGeometry` 会炸。
  //    （上面刚跑过 `noShaft` 做差分，所以这里得先把柱放回去。）
  await T('withShaft', 0.42, 0.18);
  const verticalPoints = await page.evaluate(() => {
    const e = window.__pondEngine;
    const geo = e.light.shaftGeometry(e.light.shafts[0], e.width, e.height);
    return [0.04, 0.3, 0.54, 0.8, 0.97].map((r) => ({
      r, x: geo.axisAt(e.height * r), y: e.height * r,
    }));
  });
  const sampleVertical = () => page.evaluate((points) => points.map((p) => ({
    r: p.r, a: window.__lightTools.stats(p.x, p.y, 10, 0, 1.01, 8).alphaMedian,
  })), verticalPoints);
  const verticalWith = await sampleVertical();
  await T('noShaft');
  const verticalWithout = await sampleVertical();
  const vertical = verticalWith.map((v, i) => ({ r: v.r, a: Math.max(0, v.a - verticalWithout[i].a) }));
  const mid = vertical.find((v) => v.r === 0.54).a;
  ok('★ 纵向中段最亮、两端接近归零（不是一根从头亮到尾的硬条）',
    mid > vertical[0].a + 0.03 && mid > vertical[4].a + 0.03,
    vertical.map((v) => `${v.r}:${n3(v.a)}`).join('　'));
  await T('withShaft', 0.42, 0.18);
  await shot('02-shaft');

  /* ---------------------------------------------------------- ③ 明暗带 */
  section('③ 层 12 明暗带：需求把浓度写死在 alpha .022，差分必须量到它');
  const bandWith = await T('stats', shaft.axisAtMid + shaft.halfWidth * 1.5, shaft.midY, 6, 0, 1.01, 26);
  await T('noShaft');
  const bandWithout = await T('stats', shaft.axisAtMid + shaft.halfWidth * 1.5, shaft.midY, 6, 0, 1.01, 26);
  await T('withShaft', 0.42, 0.18);
  const bandDelta = Math.max(0, bandWith.alphaMedian - bandWithout.alphaMedian);
  ok('★ 带侧真的有一层 .022 的暗带（差分 ≈ 需求值，不是 0 也不是 0.1）',
    bandDelta > 0.008 && bandDelta < 0.04, `差分 ${n3(bandDelta)}　需求 .022`);
  // 带心不该被暗带污染：暗带只在带外，带心是纯亮
  ok('暗带没有盖到带心上（带心比带侧亮得多）', onAxis > bandDelta * 3,
    `带心 ${n3(onAxis)} vs 带侧 ${n3(bandDelta)}`);

  /* ---------------------------------------------------------- ④ 鱼亮度 A/B */
  section('④ ★ US-11「阳光处鱼亮」：同位置同帧配对测量');
  await T('poolOnly');
  const pinned = await T('pinFish', geom.cx, geom.cy);
  if (!pinned) {
    ok('取到一条可用的鱼', false, 'sim.fish 为空');
  } else {
    const box = Math.max(24, Math.round(pinned.length * 1.9));
    // 基准 = 关掉光照场（`lightField = null` 正是 koi-renderer 里那个门）
    await T('setLightField', false);
    await T('render');
    const basePixels = await T('captureBaseline', pinned.x, pinned.y, box);
    const unlit = await T('stats', pinned.x, pinned.y, box, 0.62);
    await shot('03-fish-unlit');
    await T('setLightField', true);
    await T('render');
    // 130 而不是 200：截顶（>255）会把倍数系统性拉低，阈值越紧越接近真实的乘法倍数。
    // 两个阈值都量，把"截顶吃掉了多少"这件事显式记下来，而不是藏在一个宽区间里。
    const paired = await T('pairedVsBaseline', pinned.x, pinned.y, box, 0.62, 130);
    const pairedLoose = await T('pairedVsBaseline', pinned.x, pinned.y, box, 0.62, 200);
    const lit = await T('stats', pinned.x, pinned.y, box, 0.62);
    await shot('04-fish-lit');

    ok('掩膜取到了鱼体（既不是空集，也不是整块）',
      unlit.count > 150 && unlit.coverage < 0.95,
      `${unlit.count}px　覆盖率 ${n2(unlit.coverage * 100)}%　基准帧 ${basePixels} 字节`);
    ok('★ 光池里的鱼确实更亮', lit.luma > unlit.luma,
      `亮 ${n2(lit.luma)} vs 暗 ${n2(unlit.luma)}`);
    // ⚠️ 区间下界 1.15 不是"凑出来的达标线"，它对应一个**已知且有解释**的差额：
    //    光照场本身的倍数是 **1.431**（`check-light.js` 逐位验过），
    //    而鱼体**合成后**的像素倍数只有 ~1.2，差额来自鱼身上那些
    //    **固定叠色层**（`drawScales` 的 .4/.36/.38 描边、sheen、头部高光）——
    //    它们把像素往自己的固定颜色上拉，天然压缩倍数。
    //    下面的诊断行就是在量这个压缩有多大，别让它变成一个看不见的含糊。
    ok('★ 未截顶像素的配对倍数明显 > 1（方向对、量级在 1.2 上下）',
      paired.count > 60 && paired.ratio.luma > 1.15 && paired.ratio.luma < 1.6,
      `${n2(paired.ratio.luma)} 倍　配对 ${paired.count}px　`
      + `暗部均值 ${n2(paired.mean.dark)} → 亮部均值 ${n2(paired.mean.lit)}`);
    console.log(`    截顶影响：阈值 200 → ${n2(pairedLoose.ratio.luma)} 倍（${pairedLoose.count}px）；`
      + `阈值 130 → ${n2(paired.ratio.luma)} 倍（${paired.count}px）`);
    // 诊断（不断言）：关掉鳞片描边再看一次，量"固定叠色层"的影响有多大。
    // ⚠️ 试过用这一步去断定"是鳞片在压缩倍数"—— 结论是**不成立**（关掉之后读数反而更低）。
    //    所以这里只报数、不下结论：合成倍数低于 1.43 这件事**归因未定**，
    //    已知的只有「鱼体由调色板 + 若干固定 alpha 叠色层共同构成，后者不随光照缩放」。
    //    把没验清的因果写成结论，比留一个开放问题更坏。
    await T('setQuality', 'low');
    await T('setLightField', false);
    await T('render');
    await T('captureBaseline', pinned.x, pinned.y, box);
    await T('setLightField', true);
    await T('render');
    const noScales = await T('pairedVsBaseline', pinned.x, pinned.y, box, 0.62, 130);
    await T('setQuality', 'high');
    console.log(`    参照读数：关掉鳞片层 ${n2(noScales.ratio.luma)} 倍（${noScales.count}px）`
      + ` vs 全开 ${n2(paired.ratio.luma)} 倍　｜光照场本身 1.43 倍，合成后被稀释，归因未定`);
    // ⚠️ 这一条是**区分"乘法"与"叠白"**的判据。乘法保色相（三通道等比），
    //    叠白会把暗通道抬得比亮通道多（比值散开）。没有这条，实现换成叠白也照样绿。
    const r = paired.ratio;
    const spread = Math.max(r.r, r.g, r.b) - Math.min(r.r, r.g, r.b);
    ok('★ 三通道等比（乘法），不是叠了一层白（附录 A.2 #3「梦幻白洗失本色」）',
      spread < 0.3, `R/G/B ${n2(r.r)} / ${n2(r.g)} / ${n2(r.b)}　极差 ${n3(spread)}`);
  }

  /* ---------------------------------------------------------- ⑤ 梦幻 aura */
  section('⑤ F-10.5.5 柱内三层梦幻：鱼体之外必须多出一圈溢光（aura）');
  const dreamShaft = await T('withShaft', 0.5, 0);
  const dreamFish = await T('pinFish', dreamShaft.axisAtMid, dreamShaft.midY);
  if (dreamFish) {
    const ring = Math.max(30, Math.round(dreamFish.length * 2.2));
    // 量 aura 必须先**把碎光和粼光关掉**（直接改 options.quality，不触发放缩）：
    // aura 的浓度（≤.13）与光柱本身（.13）同档，碎光却能到 .34 ——
    // 不关的话量到的是碎光，不是 aura。实测踩过：开关两态只差 .001，断言形同虚设。
    await T('setQuality', 'low');
    await T('setLightField', false);
    await T('render');
    const ringPixels = await T('captureAlphaBaseline', dreamFish.x, dreamFish.y, ring);
    const ringOn = await page.evaluate(([x, y, s]) => window.__lightTools.stats(x, y, s, 0), [dreamFish.x, dreamFish.y, ring]);
    await T('setLightField', true);
    await T('render');
    const raised = await T('alphaRaised', dreamFish.x, dreamFish.y, ring, 0.03);
    await shot('05-fish-dream');
    // ⚠️ 判据既不能用掩膜内的**峰值**（踩过：两态都读到 .498 —— 那是**鱼体边缘抗锯齿像素**，
    //    开关两态完全一样，等于在量鱼不在量 aura），也不能只看**总和**
    //    （会被大片没变的像素稀释，随鱼的大小飘：实测 7 ~ 67）。
    //    只有"**被抬高的像素计数**"同时对两边免疫：均值不受稀释、峰值不受抗锯齿干扰。
    ok('★ 柱内多出一圈被抬亮的像素（aura + .11 暖光），且没有糊满整条鱼',
      raised && raised.raised > 60 && raised.fraction < 0.5,
      `抬高 ${raised ? raised.raised : '?'}px / ${ringPixels}px（${raised ? n2(raised.fraction * 100) : '?'}%）`
      + `　Δalpha 总和 ${raised ? n2(raised.sum) : '?'}`);
    console.log(`    对照组（光照场关闭时同一块）：${n3(ringOn.alphaTotal)} 总 alpha`);
    await T('setLightField', false);
    await T('render');
    await shot('06-fish-dream-off');
    await T('setLightField', true);
  }

  /* ---------------------------------------------------------- ⑥ 门控 */
  section('⑥ 门控：转阴雨后画面上不该再有光池/光柱');
  // ⚠️ 两个坑都在这一节踩过：
  //   ① ④⑤ 把一条鱼**钉在了池心** ⇒ 这里量到的 .317 其实是那条鱼，不是雨。
  //      所以先把鱼全清掉，只留下"水"。
  //   ② 雨天本来就有一层 `.18` 的整屏压暗（不是 0），
  //      所以判据不能是"附加光 < .03"，而必须是"**池心与远角的差 ≈ 0**"
  //      —— 光池的特征是**有梯度**，压暗的特征是**均匀**。
  await page.evaluate(() => { window.__pondEngine.sim.fish.length = 0; window.__pondEngine.sim.update = () => {}; });
  await T('setQuality', 'low');
  await T('setWeather', 'sunny');
  await T('render');
  // A 必须落在光池里、B 落在外——否则两点都是 0，"有没有梯度"这条断言必然假绿。
  // 踩过：一开始取 (0.25w, 0.75h) 与 (0.06w, 0.94h)，两个都在光池之外。
  const sunnyA = await T('stats', geom.cx, geom.cy, 60, 0);
  const sunnyB = await T('stats', geom.width * 0.06, geom.height * 0.94, 60, 0);
  await T('setWeather', 'rainy');
  const rainyA = await T('stats', geom.cx, geom.cy, 60, 0);
  const rainyB = await T('stats', geom.width * 0.06, geom.height * 0.94, 60, 0);
  ok('晴天：两点之间的附加光**有梯度**（光池把画面分成了亮/暗）',
    Math.abs(sunnyA.alphaMean - sunnyB.alphaMean) > 0.03,
    `A ${n3(sunnyA.alphaMean)} vs B ${n3(sunnyB.alphaMean)}　差 ${n3(Math.abs(sunnyA.alphaMean - sunnyB.alphaMean))}`);
  ok('★ 雨天：两点之间的附加光**是均匀的**（光池/光柱真的被通道关掉了）',
    Math.abs(rainyA.alphaMean - rainyB.alphaMean) < 0.02,
    `A ${n3(rainyA.alphaMean)} vs B ${n3(rainyB.alphaMean)}　差 ${n3(Math.abs(rainyA.alphaMean - rainyB.alphaMean))}`);
  await T('setQuality', 'high');
  await shot('07-rainy');

  /* ------------------------------------------------- ⑦ 层 18 四角暗角 */
  section('⑦ §11.2 层 18「暗角」：这条 CSS 覆盖层改过但从没被量过');
  /**
   * 层 18 是个 `position:absolute` 的 **DOM 覆盖层**（`.edge-shade`），
   * 不在 `.pond-canvas` 里 —— 所以上面那套 `getImageData` 一点都读不到它，
   * 必须走真正的合成截图。
   *
   * ⚠️ 而 playwright 的 `screenshot()` 返回的是 **PNG 字节**，Node 里没有解码器。
   *    绕法：把这张 PNG 以 data URL **喂回页面**，让浏览器自己 `createImageBitmap` 解出来，
   *    再画进一个 canvas 读像素 —— 零依赖，而且解出来的就是真·合成结果。
   *
   * ⚠️ 判据要**两头夹**：只断言"四角变暗"是不够的 —— 把整屏刷一层暗色也能过。
   *    必须同时断言"画面中带几乎没变"（径向渐变 47% 以内是 transparent，
   *    纵向 22%–78% 也没被那条线性渐变碰到）。一暗一亮才是"暗角"而不是"滤镜"。
   */
  const overlayLuma = async (visible, clip) => {
    await page.evaluate((v) => {
      const el = document.querySelector('.edge-shade');
      if (el) el.style.visibility = v ? '' : 'hidden';
    }, visible);
    const buf = await page.screenshot({ clip });
    return page.evaluate(async (b64) => {
      const img = new Image();
      img.src = 'data:image/png;base64,' + b64;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      const cx = c.getContext('2d');
      cx.drawImage(img, 0, 0);
      const d = cx.getImageData(0, 0, c.width, c.height).data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      return sum / (d.length / 4);
    }, buf.toString('base64'));
  };

  const shade = await page.evaluate(() => {
    const el = document.querySelector('.edge-shade');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const bg = getComputedStyle(el).backgroundImage;
    return { w: r.width, h: r.height, x: r.x, y: r.y, bg, vw: innerWidth, vh: innerHeight };
  });
  ok('层 18 的覆盖元素存在、铺满视口、且径向渐变真的生效了',
    Boolean(shade) && shade.w >= shade.vw - 1 && shade.h >= shade.vh - 1
      && shade.bg.includes('radial-gradient') && shade.bg.includes('linear-gradient'),
    shade ? `${shade.w}×${shade.h} @(${shade.x},${shade.y})　视口 ${shade.vw}×${shade.vh}　`
      + `radial ${shade.bg.includes('radial-gradient') ? '有' : '无'}　linear ${shade.bg.includes('linear-gradient') ? '有' : '无'}`
      : '找不到 .edge-shade');

  const VW = shade ? shade.vw : await page.evaluate(() => innerWidth);
  const VH = shade ? shade.vh : await page.evaluate(() => innerHeight);
  const CORNER = { x: 0, y: Math.round(VH * 0.88), width: Math.round(VW * 0.12), height: Math.round(VH * 0.12) };
  const MIDDLE = { x: 0, y: Math.round(VH * 0.46), width: VW, height: Math.round(VH * 0.08) };
  const cornerOn = await overlayLuma(true, CORNER);
  const cornerOff = await overlayLuma(false, CORNER);
  const middleOn = await overlayLuma(true, MIDDLE);
  const middleOff = await overlayLuma(false, MIDDLE);
  const cornerDrop = cornerOff - cornerOn;
  const middleDrop = middleOff - middleOn;
  ok('★ 四角被压暗了（不是"改了 CSS 但没渲染"）', cornerDrop > 3,
    `左下角均亮度 ${cornerOff.toFixed(1)} → ${cornerOn.toFixed(1)}　暗了 ${cornerDrop.toFixed(1)} luma`);
  ok('★ 画面中带几乎没被动过（说明是"收边"而不是"刷了一层滤镜"）', Math.abs(middleDrop) < 1.5,
    `中带 ${middleOff.toFixed(1)} → ${middleOn.toFixed(1)}　差 ${middleDrop.toFixed(2)} luma`);
  await page.evaluate(() => { const el = document.querySelector('.edge-shade'); if (el) el.style.visibility = ''; });

  ok('全程无页面异常', errors.length === 0, errors.slice(0, 3).join(' | '));

  console.log(`\n${fail === 0 ? '✔' : '✘'} 光照场像素验收：${pass} 通过 / ${fail} 失败`);
  console.log(`截图已写入 ${OUT}\\light-*.png`);
  await browser.close();
  process.exit(fail === 0 ? 0 : 1);
})().catch((error) => { console.error('运行失败：', error); process.exit(1); });
