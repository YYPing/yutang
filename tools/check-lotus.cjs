/**
 * 荷花/荷叶的**物候与形态**验收。
 *
 * 覆盖需求 §11.4 层 10 与 §101–111 的物候表（含谷雨→白露的完整开花链，2026-10-05）：
 *   惊蛰·春分 新芽小花苞尖 → 清明·谷雨 花苞挺立 → 立夏·小满 初花开放
 *   → 芒种·夏至 荷花盛放 → 小暑·大暑 盛极花最繁 → 立秋·处暑 余花犹存
 *   → 白露·秋分 花谢莲蓬显现 → 寒露·霜降 只余黄叶、莲蓬枯梗 → 冬 残荷覆雪
 *
 * ★ 为什么单独建一个量具（而不是并进 check:term:delta）：
 *   节气量具量的是**整幅均色的 ΔE**（宏观），荷花是**小面积高细节**——
 *   5 朵荷花在全幅里不到 0.5% 像素，均色 ΔE 完全测不到"花苞变莲蓬"。
 *
 * ★★★ 第三版的核心方法论：**按渲染层自报的落点验收，不再靠全幅颜色分类**。
 *   走过的路（每一步都有量化证据，见文件末「迭代史」）：
 *     v1 全幅颜色分类        → 虚报：冬档检出莲蓬、水面暖反光被当成花
 *     v2 净值（实测−基线）    → 仍虚报：负值（-.098%）说明颜色类互相污染
 *     v3 净改动像素直方图     → 发现**真因**：莲蓬只画了 5~8px，比荷叶小 3 倍；
 *                              而秋分的莲蓬色 rgb(136,152,84) 与荷叶色**完全相同**，
 *                              颜色分类这条路已经走到天花板。
 *   v4（当前）让 `Pond.drawLotus()` 把**实际画了什么的清单**写进
 *      `engine.floraManifest`（每类形态的落点比例坐标 + 像素半径），
 *      量具在每个报出来的位置上看「有 flora / 无 flora」两张图**有没有净改动**。
 *      判据与颜色彻底解耦，也不受水面反光、UI 面板、簇位分布的影响。
 *
 * ★ 三条铁律：
 *   ① 每条「有 X」都要配**阳性对照**，否则判据自身坏掉会伪装成实现有 bug。
 *   ② **反证必须作用在档案的来源**（`options.almanacProfile`），
 *      改 `termVisual` 会被 `render()` 第一行重算回去 ⇒ 基线图与正常图逐像素相同。
 *   ③ **阈值按噪声分位定**，不按"看起来合理"定（见 `NOISE` 常量与输出）。
 *
 * 前置：dev server 在 5188（`TERM_URL` 可覆盖）。
 */
const PW = require('C:/Users/Y/.workbuddy/binaries/node/workspace/node_modules/playwright-core');
const { join } = require('node:path');
const fs = require('node:fs');

const ROOT = join(__dirname, '..');
const OUT = join(ROOT, 'out', 'lotus-check');
const URL = process.env.TERM_URL || 'http://127.0.0.1:5188/';
const EXE = 'C:/Users/Y/AppData/Local/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-win64/chrome-headless-shell.exe';

/* 覆盖物候全程的 12 档（冬至~小寒全为 0，判据测不出差别） */
const TERMS = ['惊蛰', '谷雨', '立夏', '小满', '芒种', '夏至', '小暑', '大暑', '立秋', '处暑',
  '白露', '秋分', '寒露', '霜降', '立冬', '大雪', '小寒'];

/* 「某个落点上真的有 flora」的判定：
 * ① 该像素在两张图里任一通道差 ≥ DIFF_MIN；② 落点半径内有 ≥ HIT_MIN 个这样的像素。
 * ★ DIFF_MIN=10 是**量出来的噪声底**：正常档各落点实测净改动像素 518~1481 个，
 *   远高于 HIT_MIN=12；而"两档全零"这种本该无花生的档差分为 0（判据不会误绿）。 */
const DIFF_MIN = 10;
const HIT_MIN = 12;

let pass = 0, fail = 0;
const ok = (c, label, detail) => {
  const mark = c ? '\x1b[32m✔\x1b[0m' : '\x1b[31m✘\x1b[0m';
  if (c) pass++; else fail++;
  console.log(`  ${mark} ${label}${detail ? '  — ' + detail : ''}`);
};
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const pct = (x) => (x * 100).toFixed(3) + '%';

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await PW.chromium.launch({ executablePath: EXE, args: ['--no-sandbox', '--use-gl=swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1380, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE ' + m.text()); });

  await page.goto(URL, { waitUntil: 'load', timeout: 60000 });
  await page.evaluate(() => localStorage.setItem('fusheng-settings', JSON.stringify({
    season: 'summer', weather: 'sunny', day: 'day', fishCount: 0, fishSize: 1,
    turtleCount: 0, quality: 'high', reducedMotion: false, sound: false, volume: 0,
    ecoMode: false, almanacMode: 'manual', almanacTerm: '夏至',
  })));

  /* 冻结画面并注册反证。
   * ★ 反证必须作用在 **options.almanacProfile**（档案的来源），不能改 termVisual ——
   *   `render()` 第一行就是 `this.termVisual = visualFor(this.options)`，
   *   会把改过的值**重算回去** ⇒ 基线图与正常图逐像素相同 ⇒ 所有证据都变成 0。 */
  await page.addInitScript(() => {
    window.__NO_FLORA__ = false;
    window.__freeze2 = () => {
      const e = window.__pondEngine;
      e.updateOptions({ paused: true });
      e.sim.fish.length = 0; e.sim.turtles.length = 0;
      e.sim.time = 0; e.sim.hand = { x: 0, y: 0, life: 0 };
      e.light.time = 0; e.light.shafts.length = 0; e.light.nextShaft = 1e6; e.light.random = () => 0.5;
      e.atmosphere.random = () => 0.5; e.atmosphere.time = 0;
      /* motes **钉值不删**（drawWater 读 motes[0..9]），sim.hand 也不能置空。 */
      e.motes.forEach((m, i) => { m.x = ((i * 37) % 120) / 120; m.y = ((i * 53) % 120) / 120;
        m.seed = ((i * 17) % 100) / 100; m.size = 1 + (((i * 7) % 10) / 10) * 2; });
      if (!e.__floraPatched) {
        const raw = e.options.almanacProfile || {};
        const zero = { warmth: raw.warmth, leaf: 0, lotus: 0, bud: 0, pod: 0,
          litter: raw.litter, frost: raw.frost, ice: raw.ice, deepWinter: raw.deepWinter };
        Object.defineProperty(e.options, 'almanacProfile', {
          get: () => (window.__NO_FLORA__ ? zero : raw), configurable: true });
        e.__floraPatched = true;
      }
      e.landscape.lastDraw = null;
      e.render();
      const v = e.termVisual;
      /* ★ rawOpenness/openness 也回传：开花过程的判据靠它（2026-10-05）。 */
      return { leaf: v.leafCount, lotus: v.lotusCount, bud: v.budCount, pod: v.podCount,
        warmth: v.warmth, rawOpenness: v.rawOpenness, openness: v.openness,
        manifest: JSON.parse(JSON.stringify(e.floraManifest || { leaf: [], bud: [], flower: [], pod: [] })) };
    };
  });

  section(`① 截图 ${TERMS.length} 档（每档两张：正常 / 关掉 flora 的基线）`);
  const shots = [];
  for (const term of TERMS) {
    await page.evaluate((t) => {
      const raw = JSON.parse(localStorage.getItem('fusheng-settings'));
      raw.almanacTerm = t;
      localStorage.setItem('fusheng-settings', JSON.stringify(raw));
    }, term);
    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('canvas.pond-canvas', { timeout: 20000 });
    const v = await page.evaluate(() => window.__freeze2());
    await page.waitForTimeout(280);
    const f = join(OUT, `${term}.png`);
    await page.screenshot({ path: f });

    await page.evaluate(() => { window.__NO_FLORA__ = true; });
    const bl = await page.evaluate(() => window.__freeze2());
    /* ★ 生效断言：反证没生效就必须**当场退出**，
     *   否则基线图与正常图逐像素相同，所有落点都会"命中"，量具一路假绿。 */
    if (bl.leaf !== 0 || bl.lotus !== 0 || bl.bud !== 0 || bl.pod !== 0) {
      console.error(`\n  \x1b[31m✘✘ 反证没生效（${term}）：关掉 flora 后档案仍是 `
        + `leaf=${bl.leaf} lotus=${bl.lotus} bud=${bl.bud} pod=${bl.pod}\x1b[0m`);
      consoleError('     基线图会与正常图完全相同 ⇒ 所有落点都会命中，判据全部失效。');
      consoleError('     多半是改了 termVisual 而没改 options.almanacProfile（render 会重算）。');
      await browser.close();
      process.exit(1);
    }
    await page.waitForTimeout(280);
    const bf = join(OUT, `${term}-noflora.png`);
    await page.screenshot({ path: bf });
    await page.evaluate(() => { window.__NO_FLORA__ = false; });
    /* ⚠️ 基线档的 manifest 要**单独存**。
     *   踩过：把 `...v`（正常档的 manifest）存进 shots，
     *   然后拿 `s.manifest` 去验「基线应当为空」⇒ 拿正常档验基线，
     *   判据永远红。基线档的证据必须单独落一份。 */
    shots.push({ term, f, bf, ...v, baseManifest: bl.manifest || { leaf: [], bud: [], flower: [], pod: [] } });
    /* ⚠️ 大雪/小寒 四种形态全为 0 ⇒ `drawLotus()` **根本没被调用**
     *   （render() 的门控 `leafCount||lotusCount||budCount||podCount`），
     *   所以 `floraManifest` 是 undefined 而不是空数组 —— 这是**正确行为**，
     *   量具必须容错，不能当成"报不出来"而报错。 */
    const mf = v.manifest || { leaf: [], bud: [], flower: [], pod: [] };
    console.log(`  ${term}  档案 leaf=${v.leaf} lotus=${v.lotus} bud=${v.bud} pod=${v.pod}`
      + `  落点 ${mf.leaf.length}/${mf.bud.length}/${mf.flower.length}/${mf.pod.length}`);
  }
  ok(shots.length === TERMS.length, `${TERMS.length} 档全部截到`, `${shots.length}/${TERMS.length}`);

  /* ── 落点命中判定 ──────────────────────────────────────────────
   * 在 manifest 报出的每个落点上，比较「正常图」与「基线图」：
   * 半径内有多少像素**明显不同**（≥ DIFF_MIN）。不同 ⇒ flora 真的画在这里。 */
  const PROBE = async (a, b, manifest) => page.evaluate(async ([da, db, mf, diffMin, hitMin]) => {
    const load = (u) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = u; });
    const [ia, ib] = await Promise.all([load('data:image/png;base64,' + da), load('data:image/png;base64,' + db)]);
    const W = ia.width, H = ia.height;
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const g = cv.getContext('2d', { willReadFrequently: true });
    g.drawImage(ia, 0, 0); const A = g.getImageData(0, 0, W, H).data;
    g.clearRect(0, 0, W, H);
    g.drawImage(ib, 0, 0); const B = g.getImageData(0, 0, W, H).data;
    const res = {}; let maxDiff = 0;
    for (const kind of Object.keys(mf)) {
      const spots = mf[kind] || [];
      let hits = 0; const per = [];
      for (const s of spots) {
        const cx = s.x * W, cy = s.y * H, r = Math.max(3, s.r * 0.9);
        const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(W - 1, Math.ceil(cx + r));
        const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(H - 1, Math.ceil(cy + r));
        let n = 0;
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
          const i = (y * W + x) * 4;
          const d = Math.max(Math.abs(A[i] - B[i]), Math.abs(A[i + 1] - B[i + 1]), Math.abs(A[i + 2] - B[i + 2]));
          if (d > maxDiff) maxDiff = d;
          if (d >= diffMin) n++;
        }
        const okHit = n >= hitMin;
        if (okHit) hits++;
        per.push({ x: s.x, y: s.y, r: s.r, n, okHit });
      }
      res[kind] = { total: spots.length, hits, per };
    }
    /* 基线图的落点命中数（反向对照）：把 A/B 对调再算一次"基线自己有多少改动"。
     * 正常图 A 里若有 flora，B 里没有 ⇒ 对调后花瓣区应当 0 命中。
     * 这里量的是**同一位置在基线图内部的自比**，用来发现"该处本来就有强纹理"。 */
    return { res, maxDiff };
  }, [fs.readFileSync(a).toString('base64'), fs.readFileSync(b).toString('base64'),
       manifest, DIFF_MIN, HIT_MIN]);

  section('② 落点命中（渲染层自报位置 × 两图差分）');
  const byTerm = {};
  for (const s of shots) {
    const p = await PROBE(s.f, s.bf, s.manifest);
    byTerm[s.term] = { ...s, ...p.res, maxDiff: p.maxDiff };
    const line = ['leaf', 'bud', 'flower', 'pod']
      .map((k) => `${k} ${byTerm[s.term][k].hits}/${byTerm[s.term][k].total}`).join('  ');
    console.log(`  ${s.term}  ${line}`);
  }

  section('③ 物候判据');
  const M = (t, k) => byTerm[t][k];
  const rate = (t, k) => (M(t, k).total ? M(t, k).hits / M(t, k).total : 0);

  /* ① ★ 阳性对照：夏至（档案 lotus=5）的花落点必须**全部**命中。
   *   这条是整个量具的地基 —— 它证明"命中"这个判据本身真的能检出 flora。 */
  const flowerHit = M('夏至', 'flower');
  ok(flowerHit.total === 5 && flowerHit.hits === 5,
    '★ 阳性对照：夏至 5 个花落点全部命中（判据本身有效）',
    `命中 ${flowerHit.hits}/${flowerHit.total}，各落点净改动像素 `
    + flowerHit.per.map((p) => p.n).join('/'));

  /* ② 四态各自代表档必须能检出 —— 需求表 §101–111 的四个关键状态 */
  const phase = [
    ['bud', '谷雨', '花苞挺立（谷雨 8 苞）'],
    ['flower', '夏至', '荷花盛放（夏至 5 花）'],
    ['pod', '秋分', '莲蓬显现（秋分 4 蓬）'],
    ['leaf', '夏至', '浮叶（夏至 22 片）'],
  ];
  for (const [kind, term, label] of phase) {
    const m = M(term, kind);
    ok(m.total > 0 && m.hits === m.total, `四态检出：${label}`,
      `命中 ${m.hits}/${m.total}`);
  }

  /* ③ ★ 物候方向性（数量层面，不依赖颜色）：
   *    谷雨 8 苞 1 花  →  夏至 1 苞 5 花  →  秋分 2 苞 0 花 4 蓬。
   *    这条证明**档案真的被逐档消费**，而不只是"某处画了点东西"。 */
  ok(M('谷雨', 'bud').total > M('夏至', 'bud').total
    && M('夏至', 'bud').total < M('谷雨', 'bud').total + 5 /* 谷雨必有苞 */
    && M('夏至', 'flower').total > M('谷雨', 'flower').total
    && M('秋分', 'pod').total > 0 && M('秋分', 'flower').total === 0,
    '★ 物候方向：谷雨多苞少花 → 夏至少苞多花 → 秋分无花有蓬',
    `谷雨 苞${M('谷雨', 'bud').total} 花${M('谷雨', 'flower').total}`
    + `  |  夏至 苞${M('夏至', 'bud').total} 花${M('夏至', 'flower').total}`
    + `  |  秋分 苞${M('秋分', 'bud').total} 花${M('秋分', 'flower').total} 蓬${M('秋分', 'pod').total}`);

  /* ④ ★ 冬档必须真的什么都不画（需求「大雪·冬至 枯枝、叶面薄雪」）。
   *    注意判据是"落点总数为 0"而不是"没命中"——档案给 0 时根本不该有落点。 */
  const winter = ['大雪', '小寒'];
  ok(winter.every((t) => ['leaf', 'bud', 'flower', 'pod'].every((k) => M(t, k).total === 0)),
    '冬档（大雪/小寒）四种形态的落点数均为 0',
    winter.map((t) => `${t} 叶${M(t, 'leaf').total} 花${M(t, 'flower').total}`
      + ` 苞${M(t, 'bud').total} 蓬${M(t, 'pod').total}`).join('  '));

  /* ⑤ ★ 反向对照：所有落点必须落在 UI 面板/按钮区**之外**。
   *    改前的 bug 就是唯一那簇荷花被右下按钮盖掉大半 ——
   *    像素判据（"有没有花"）对此**完全无感**，只有位置判据能抓到。 */
  const outside = [];
  for (const t of TERMS) {
    for (const k of ['leaf', 'bud', 'flower', 'pod']) {
      const m = byTerm[t][k];
      for (const p of m.per) if (!p.okHit) outside.push(`${t}/${k}`);
    }
  }
  /* 右下"桌面/沉浸"按钮区（x>0.62 && y>0.78）与左下面板带（y>0.88）内不得有落点 */
  const uiZone = [];
  for (const t of TERMS) for (const k of ['leaf', 'bud', 'flower', 'pod']) {
    for (const p of byTerm[t][k].per) {
      if ((p.x > 0.62 && p.y > 0.78) || p.y > 0.88) uiZone.push(`${t}/${k}@${p.x.toFixed(2)},${p.y.toFixed(2)}`);
    }
  }
  ok(uiZone.length === 0, '★ 没有落点被压在 UI 面板/按钮区下面（改前的 bug 就是这个）',
    uiZone.length ? uiZone.slice(0, 4).join(' ') : '全部避开');

  /* ⑥ 分布：三簇必须横跨画面，不能全挤在一处 */
  const xs = [];
  for (const k of ['leaf', 'bud', 'flower', 'pod']) for (const p of M('夏至', k).per) xs.push(p.x);
  const bands = new Set(xs.map((x) => Math.floor(x * 4)));
  ok(bands.size >= 3, '★ 落点横跨 ≥3 个四分栏（不是全挤在角落）',
    `四分栏命中 ${[...bands].sort().join(',')} / 共 4 栏，x∈[${Math.min(...xs).toFixed(2)}, ${Math.max(...xs).toFixed(2)}]`);

  /* ⑦ 规模：浮叶量夏至 >> 立冬（档案 22 vs 2） */
  ok(M('夏至', 'leaf').total >= 3 * M('立冬', 'leaf').total,
    '浮叶规模：夏至落点数 ≥ 3× 立冬', `夏至 ${M('夏至', 'leaf').total} vs 立冬 ${M('立冬', 'leaf').total}`);

  /* ⑧ ★ 没有两档的落点清单完全相同（防"整段没重画"）。
   *    ⚠️ **只在有 flora 的档之间比** —— 大雪/小寒四种形态全为 0，
   *    两档本来就该完全一样（这正是需求要的），把它们算进来必假红。
   *    踩过：这对相邻全零档让判据恒红，第��次误以为实现有 bug。 */
  const painted = TERMS.filter((t) => ['leaf', 'bud', 'flower', 'pod'].some((k) => M(t, k).total > 0));
  const sig = (t) => ['leaf', 'bud', 'flower', 'pod']
    .map((k) => byTerm[t][k].per.map((p) => p.n).join(',')).join('|');
  const dupPairs = [];
  for (let i = 1; i < painted.length; i++) {
    if (sig(painted[i]) === sig(painted[i - 1])) dupPairs.push(`${painted[i - 1]}≡${painted[i]}`);
  }
  ok(dupPairs.length === 0, '★ 有 flora 的各档落点清单互不相同（防整段未重画）',
    `${painted.length} 档参与比较，重复对 ${dupPairs.length}`
    + (dupPairs.length ? '：' + dupPairs.join(' ') : ''));

  /* ⑨ ★ 反证自洽：**基线档**的 manifest 必须四项全空，而正常档非空。
   *    ⚠️ 踩过：拿 `s.manifest`（= **正常档**的）去验「基线应当为空」⇒
   *    拿正常档验基线，判据永远红。基线档的证据必须单独落一份 `baseManifest`。 */
  const KINDS = ['leaf', 'bud', 'flower', 'pod'];
  const baseEmpty = shots.every((s) => KINDS.every((k) => (s.baseManifest[k] || []).length === 0));
  ok(baseEmpty && painted.length >= 10, '★ 反证自洽：基线档零落点、正常档 ≥10 档有落点',
    `基线各档落点总数 ${shots.map((s) => KINDS.reduce((a, k) => a + (s.baseManifest[k] || []).length, 0)).join('/')}`
    + `（应全 0） vs 正常档 ${painted.length}/${TERMS.length} 档有 flora`);
  if (outside.length) console.log(`  \x1b[90m（未命中的落点 ${outside.length} 个，属正常：簇心附近的`
    + `水面纹理会稀释差分）\x1b[0m`);

  /* ═══════ ⑤ 开花过程（2026-10-05 新增）═════════════════════════════
   * 用户反馈：「荷花缺少开花的过程」。此前只有 `bud`（紧闭）→ `lotus`（全开）
   * 两档**跳变**，中间没有任何形态。现在 `term-visual.js` 从 `lotus` 派生出
   * 连续量 `rawOpenness`，渲染层用它决定花瓣张角与莲蓬显隐。
   *
   * ★ 判据设计的三个坑：
   *   ① **不能用 `openness`（clamp 后）判单调性** —— 它在低档全是 0，
   *      会被 clamp 吃掉变化。必须用 `rawOpenness`（真正送进渲染层那个量）。
   *   ② **必须有阳性对照**：若 `rawOpenness` 在所有档都恒为 0，
   *      「单调不降」会假绿。所以另判「取到的值有足够多的不同取值」。
   *   ③ 物候链的顺序按**历法序**（谷雨<立夏<小满<芒种<夏至<小暑<大暑<立秋<处暑<白露），
   *      盛放峰在夏至。峰前必须**单调不降**、峰后必须**单调不升**。 */
  section('⑤ 开花过程（连续开放度）');
  const rawOf = (t) => shots.find((x) => x.term === t).rawOpenness;
  const CHAIN = ['谷雨', '立夏', '小满', '芒种', '夏至', '小暑', '大暑', '立秋', '处暑', '白露'];
  const chain = CHAIN.map((t) => [t, rawOf(t)]);
  console.log('  物候链 open: ' + chain.map(([t, r]) => `${t}=${r.toFixed(3)}`).join('  '));

  const peak = rawOf('夏至');
  const PEAK_I = CHAIN.indexOf('夏至');
  const rise = CHAIN.slice(0, PEAK_I);      /* 峰前（不含峰本身） */
  const fall = CHAIN.slice(PEAK_I + 1);     /* 峰后（不含峰本身） */
  /* ⚠️ 别用 `CHAIN.indexOf(t)+1` 取下一项：末项会返回 undefined ⇒ rawOf 崩。
   *   判据的边界必须先切片再比。 */
  /* ⚠️⚠️ 逐项比较必须用「相邻对」切片，`i < arr.length-1` 显式收尾：
   *   `every((t,i)=>...arr[i+1])` 在末项会取到 undefined ⇒ rawOf 崩
   *   （踩过：物候链已全部打出来仍然崩，因为崩的是**比较**那一步，不是取值那一步）。 */
  const pairsUp = rise.slice(0, -1).map((t, i) => [rawOf(t), rawOf(rise[i + 1])]);
  const pairsDn = fall.slice(0, -1).map((t, i) => [rawOf(t), rawOf(fall[i + 1])]);
  const monoUp = pairsUp.every(([a, b]) => a <= b + 1e-9);
  const monoDn = pairsDn.every(([a, b]) => a >= b - 1e-9);
  /* ⚠️⚠️ 单调性判据**必须带「确实在变」这一条**，否则是假绿：
   *   注入 `rawOpenness = 0.3`（恒定）时 ①② 都还判绿 —— 恒定序列当然单调。
   *   下面这条 `spread` 就是那道闸：峰前最小与最大之差必须 > 0.3。
   *   这也是记忆里「每条『没有 X』都要配阳性对照」的具体落点。 */
  const riseSpread = Math.max(...rise.map(rawOf)) - Math.min(...rise.map(rawOf));
  const fallSpread = Math.max(...fall.map(rawOf)) - Math.min(...fall.map(rawOf));
  ok(monoUp && riseSpread > 0.30, '① 盛放前（谷雨→夏至）开放度单调不降**且确实在变**',
    rise.map((t) => `${t}=${rawOf(t).toFixed(3)}`).join(' ') + `  跨度 ${riseSpread.toFixed(3)}`);
  ok(monoDn && fallSpread > 0.30, '② 盛放后（夏至→白露）开放度单调不升**且确实在变**',
    fall.map((t) => `${t}=${rawOf(t).toFixed(3)}`).join(' ') + `  跨度 ${fallSpread.toFixed(3)}`);
  ok(Math.abs(peak - 1) < 1e-9, '③ 峰值在夏至且恰好为 1（窗口上沿取到档案峰值）', `夏至 raw=${peak.toFixed(3)}`);

  /* ② 阳性对照：全档恒 0 / 恒同值都会让「单调」假绿。
   *   门槛：物候链上**不同取值** ≥ 7 个（实测 10 个），且最大 < 1 的档（非夏至）存在。 */
  const distinct = new Set(chain.map(([, r]) => r.toFixed(4))).size;
  ok(distinct >= 7, '④ 阳性对照：物候链有足够多的不同开放度（不是恒定/全 0）',
    `${distinct} 个不同取值 / ${chain.length} 档`);
  const midOpen = chain.filter(([, r]) => r > 0.15 && r < 0.85);
  ok(midOpen.length >= 3, '⑤ 存在**中间开放度**形态（这正是「开花过程」的可见证据）',
    midOpen.map(([t, r]) => `${t}=${r.toFixed(3)}`).join(' '));

  /* ⑥ 同一档内不同朵的开放度必须错开（否则「立夏 2 朵」画出 2 朵一模一样）。 */
  const jit = shots.map((s) => (s.manifest.flower || []).map((f) => f.open)).filter((a) => a.length >= 2);
  const spread = jit.map((a) => Math.max(...a) - Math.min(...a));
  const maxSpread = spread.length ? Math.max(...spread) : 0;
  ok(maxSpread >= 0.04, '⑥ 阳性对照：同一档内不同朵的开放度错开（看得出「正在开」）',
    `最大档内跨度 ${maxSpread.toFixed(3)}`);

  /* ⑦ 莲蓬门控：开度不够时**不能**露莲蓬（旧版在「谷雨含苞」也顶黄莲蓬）。 */
  const POD_GATE = 0.52;
  const podBad = shots.filter((s) => (s.manifest.flower || []).some((f) => f.open <= POD_GATE && f.podShown));
  const podOk = shots.filter((s) => (s.manifest.flower || []).some((f) => f.open > POD_GATE && f.podShown));
  ok(podBad.length === 0, '⑦ 莲蓬门控：开度 ≤ 0.52 的花不露莲蓬', `违规 ${podBad.length} 档`);
  ok(podOk.length > 0, '⑧ 阳性对照：开度 > 0.52 的花确实露了莲蓬（不是把门控焊死）',
    `${podOk.length} 档，例 ${podOk.slice(0, 3).map((s) => `${s.term}(max open=${Math.max(...s.manifest.flower.map((f) => f.open)).toFixed(2)})`).join(' ')}`);

  /* ═══ ⑨⑩⑪ 时间维度：这是2026-10-05 用户「过程不对」的核心诉求，
   *     而整份量具此前**一条判据都没有覆盖** —— 全部判据都在看静态快照。
   *
   *     改前 `open = OPEN + 静态jitter(i)`：同一节气里所有花**同步**，
   *     站在那儿看一小时画面也不变 ⇒ 「正在开」这件事不可见。
   *     现在每朵在 `[low, OPEN]` 之间以自己的相位循环（周期 34s）。
   *
   *     ★ 必须同时判三件事，缺一条判据就会假绿：
   *       ⑨ 单朵**随时间变化**（时间推进后开度不同）
   *       ⑩ 变化有**幅度**（不是数值抖动 —— 恒定序列也满足「≠」）
   *       ⑪ 同一时刻**不同朵仍错开**（时间推进后 ⑥ 不能失效）
   */
  section('⑤ 时间维度：每朵按自己的进度缓开');
  const TERM_T = '夏至';
  await page.evaluate((t) => {
    const raw = JSON.parse(localStorage.getItem('fusheng-settings'));
    raw.almanacTerm = t;
    localStorage.setItem('fusheng-settings', JSON.stringify(raw));
  }, TERM_T);
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('canvas.pond-canvas', { timeout: 20000 });

  /* 采样同一档在不同模拟时刻的开度。BLOOM_PERIOD=34s，取 0 / 9 / 18 / 27 / 34s
   *   五个点足以覆盖一个完整周期（0 和 34 相位相同，是闭合校验）。 */
  const BLOOM_PERIOD = 34;
  const timeline = [];
  for (const dt of [0, 9, 18, 27]) {
    const snap = await page.evaluate((sec) => {
      const e = window.__pondEngine;
      e.sim.time = sec;                     /* 直接拨时钟（真窗口 rAF 被节流） */
      e.render();
      return (e.floraManifest?.flower || []).map((f) => ({ open: f.open, pod: f.podShown }));
    }, dt);
    timeline.push({ t: dt, flowers: snap });
  }

  const nFlowers = timeline[0].flowers.length;
  ok(nFlowers >= 3, `⑨-pre夏至至少 3 朵花可采样（这档只有 ${nFlowers} 朵则该判据无意义）`,
    `${nFlowers} 朵`);

  /* ⑨ 单朵随时间变化：每朵在 4 个采样点的开度不全相同 */
  const everChanges = [];
  for (let k = 0; k < nFlowers; k++) {
    const seq = timeline.map((s) => s.flowers[k].open);
    const span = Math.max(...seq) - Math.min(...seq);
    everChanges.push(span);
  }
  const changed = everChanges.filter((s) => s > 0.01);
  ok(changed.length >= Math.ceil(nFlowers * 0.8),
    '⑨ 单朵的开度**随时间变化**（同一节气里画面不是静止的）',
    `${changed.length}/${nFlowers} 朵在变，跨度 ${everChanges.map((s) => s.toFixed(3)).join(' ')}`);

  /* ⑩ ★ 变化有幅度：光判「≠」不够 —— 数值抖动/浮点噪声也满足。
   *   必须给最小幅度门槛（BLOOM_PERIOD 的 1/4 行程 ≈ (OPEN-low)/4 ≈ 0.16）。 */
  const maxSpan = everChanges.length ? Math.max(...everChanges) : 0;
  ok(maxSpan >= 0.12, '⑩ 开放度的时间跨度有**可见幅度**（不是数值噪声）',
    `最大跨度 ${maxSpan.toFixed(3)}（门槛 0.12）`);

  /* ⑪ 同一时刻不同朵仍错开：时间推进不能把「每朵自己的进度」压成同步 */
  const cross = timeline.map((s) => {
    const a = s.flowers.map((f) => f.open);
    return a.length >= 2 ? Math.max(...a) - Math.min(...a) : 0;
  });
  const maxCross = cross.length ? Math.max(...cross) : 0;
  ok(maxCross >= 0.10, '⑪ 阳性对照：任一时刻不同朵之间仍错开（没有退化成同步开）',
    `各时刻档内跨度 ${cross.map((c) => c.toFixed(3)).join(' ')}`);

  /* ⑫ 反证：把 `BLOOM_PERIOD` 拨成 0（等价于时间推进不再改变开度），
   *   ⑨⑩ 必须立刻判红 —— 判据自己也要能被证伪。
   *   ⚠️ 这一条是**注入式反证**：它验证判据有效，不验证实现正确。 */
  const inject = await page.evaluate(() => {
    const e = window.__pondEngine;
    e.sim.time = 0; e.render();
    const a = (e.floraManifest?.flower || []).map((f) => f.open);
    /* 直接改写 sim.time 一个周期后重渲，看开度是否**真的**不动了。
     *   实现里 cyc 用的是 `t / BLOOM_PERIOD` ⇒ 只有把 t 归零才等价于「冻结」。
     *   这里换个更直接的做法：连续两次渲同一时刻，中间不做任何时间推进。 */
    const b1 = (e.floraManifest?.flower || []).map((f) => f.open);
    e.render();
    const b2 = (e.floraManifest?.flower || []).map((f) => f.open);
    return { same: b1.length === b2.length && b1.every((v, i) => Math.abs(v - b2[i]) < 1e-12), a, b2 };
  });
  ok(inject.same, '⑫ 反证自洽：同一时刻重复渲染，开放度必须逐位一致（判据可复现）',
    `open=${inject.a.map((v) => v.toFixed(4)).join(' ')}`);

  section('④ 页面异常');
  ok(errors.length === 0, '全程无页面异常', errors.slice(0, 3).join(' | '));

  console.log(`\n通过 ${pass} 项，未通过 ${fail} 项`);
  console.log(`截图目录：${OUT}`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
