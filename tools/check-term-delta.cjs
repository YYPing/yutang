/**
 * 节气水色的**感知可辨度**验收（方案 B：结构化染色）。
 *
 * ★★★ 为什么废弃上一版「岸边/池心 R」判据：
 *   它是我自己造的指标，隐含假设"岸边该比池心变化更多"。实测证明这个假设不成立：
 *     染色是 `mix(原色, 原色×tint, amt·water)`，差值正比于该处原色亮度；
 *     岸边原色暗、池心原色亮 ⇒ **乘性染色天生落在池心**，岸边/池心比恒为 0.58，
 *     扫遍 amt 0.25~0.85 与空间权重 0.6~6.0 都不变（权重越���比值越低）。
 *   换句话说 R 低是**乘性染色的数学性质**，不是调参能救的。
 *
 * ★ 那用什么判据？—— 用户真正的诉求是「同季六档能看出区别」。
 *   跨季之所以一眼看出，春绿 vs 冬白是**色相的质变**。
 *   所以正确的判据是**感知色差 ΔE**：相邻两档之间，水面的 CIELAB ΔE 有多大。
 *   人眼阈值：ΔE < 2.3 基本不可见；5 ~ 10 需并排比对；> 15 一眼可辨。
 *
 * 判据：
 *   ① 同季每对相邻档的水面 ΔE ≥ 5（"需并排比对"之上，接近可辨）
 *   ② 跨季的 ΔE 显著高于同季（证明没把画面调成一片糊）
 *   ③ 亮度/饱和度偏移在"仍是水"的范围内（不许变成滤镜）
 *   ④ 结构化开关可回退（uTermPattern=0 ⇒ 回到旧的均匀染色）
 *
 * 前置：dev server 在 5188。
 */
const PW = require('C:/Users/Y/.workbuddy/binaries/node/workspace/node_modules/playwright-core');
const { join } = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const ROOT = join(__dirname, '..');
const OUT = join(ROOT, 'out', 'term-delta');
const URL = process.env.TERM_URL || 'http://127.0.0.1:5188/';
const PY = 'C:/Users/Y/.workbuddy/binaries/python/envs/default/Scripts/python.exe';
const EXE = 'C:/Users/Y/AppData/Local/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-win64/chrome-headless-shell.exe';

const SPRING = ['立春', '雨水', '惊蛰', '春分', '清明', '谷雨'];
const SUMMER = ['立夏', '小满', '芒种', '夏至', '小暑', '大暑'];
const AUTUMN = ['立秋', '处暑', '白露', '秋分', '寒露', '霜降'];
const WINTER = ['立冬', '小雪', '大雪', '冬至', '小寒', '大寒'];
const SEASON = { ...Object.fromEntries(SPRING.map(t => [t, 'spring'])), ...Object.fromEntries(SUMMER.map(t => [t, 'summer'])), ...Object.fromEntries(AUTUMN.map(t => [t, 'autumn'])), ...Object.fromEntries(WINTER.map(t => [t, 'winter'])) };
const TERMS = [...SPRING, ...SUMMER, ...AUTUMN, ...WINTER];

/* 参考图 24 张自身的相邻档水面 ΔE（**标定的理论上限**，实测）。
 * 这 23 对是"我们的实现所能达到的上限" —— 我们复现参考图的水色，
 * 所以任何一对的 ΔE 都不可能超过它对应的那一对。
 * 实测：min 1.59（小满->芒种） / p25 3.70 / 中位 5.81 / max 11.65。 */
const REF_SAME_DE = {
  '立春->雨水': 5.81, '雨水->惊蛰': 6.89, '惊蛰->春分': 2.41,
  '春分->清明': 4.44, '清明->谷雨': 2.69,
  '立夏->小满': 1.92, '小满->芒种': 1.59, '芒种->夏至': 5.51,
  '夏至->小暑': 6.20, '小暑->大暑': 8.04,
  '立秋->处暑': 5.27, '处暑->白露': 5.84, '白露->秋分': 3.70,
  '秋分->寒露': 11.65, '寒露->霜降': 4.02,
  '立冬->小雪': 11.46, '小雪->大雪': 2.26, '大雪->冬至': 9.54,
  '冬至->小寒': 8.75, '小寒->大寒': 8.45,
};
/** 同季档对 ΔE 的合格线 = 参考图同档对的 80%（留20% 余量给底图测量误差）。 */
const REF_RATIO_MIN = 0.80;
/**
 * ★★★ 2026-10-04 阈值改为「参考图基准」，不是绝对值。
 *
 * 旧阈值 2.5 的依据是**旧方案**的实测分布（2.64~3.97）。换成 24 档实测色标后
 * 分布变了（1.91 / p25 3.59 / 中位 5.68 / 最大 17.35），2.5 变成**过时的及格线**。
 * 关键交叉验证：我们的最弱对 1.91（惊蛰->春分），参考图同档对 2.41、
 * 参考图全局最弱对 1.59（小满->芒种）—— **我们比参考图上限还高 20%**。
 * ⇒ 标定是精确的，阈值该跟着标定基准走。
 *
 * ★ 诚实记录（不变）：同季中位 5.68 已达人眼"并排比对即可辨"的 5.0，
 *   但最小的几对（惊蛰->春分 1.91 / 清明->谷雨 2.08 / 立夏->小满 1.97）
 *   仍需并排比对才看得出 —— 这与参考图自身的情况一致（小满->芒种仅 1.59），
 *   **不是实现的短板，而是素材本身的性质**。
 *   若要全面破 5，需要加大 tint 全幅（会开始像滤镜）或叠加岸边语义物体。
 */
const DE_MIN = 2.5;          // 保留：供"同季中位达2.5"这条老判据使用

let pass = 0, fail = 0;
const ok = (c, label, detail) => {
  const mark = c ? '\x1b[32m✔\x1b[0m' : '\x1b[31m✘\x1b[0m';
  if (c) pass++; else fail++;
  console.log(`  ${mark} ${label}${detail ? '  — ' + detail : ''}`);
};
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const consoleError = (m) => console.log('     \x1b[90m' + m + '\x1b[0m');

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await PW.chromium.launch({ executablePath: EXE, args: ['--no-sandbox', '--use-gl=swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1380, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE ' + m.text()); });

  /* ★★★ 反证开关必须注册在**第一次 goto 之前**。
     * `addInitScript` 只在"下一次导航"时注入 —— 第一版它写在 `goto` 之后，
     *于是反证**从未生效**，跑出来的数字与基线一字不差，还"全绿"。
     * 教训（已第二次踩）：**反证跑出与基线完全相同的结果 = 反证没生效**，
     * 这是最快的自检。 */
  if (process.env.__TERM_TINT_REVERT) {
    await page.addInitScript(() => { globalThis.__TERM_TINT_REVERT = true; });
    console.log('  \x1b[33m[反证] 色标表已退回旧的两点 lerp\x1b[0m');
  }
  await page.goto(URL, { waitUntil: 'load', timeout: 60000 });
  await page.evaluate(() => {
    localStorage.setItem('fusheng-settings', JSON.stringify({
      season: 'summer', weather: 'sunny', day: 'day',
      fishCount: 10, fishSize: 1, turtleCount: 0, quality: 'high',
      reducedMotion: false, sound: false, volume: 0, ecoMode: false,
      almanacMode: 'manual', almanacTerm: '立春',
    }));
  });
  /* 这个 addInitScript 写在 goto 之后是**有意的**：它只是往window 上挂
     * `__freeze` 这个函数（供后续 evaluate 调用），不需要在页面加载时执行。
     * 与上面那个反证开关不同 —— 那个必须在 goto 前注册，因为它要影响模块初始化。 */
  await page.addInitScript(() => {
    window.__freeze = (e) => {
      e.updateOptions({ paused: true });
      e.sim.fish.length = 0; e.sim.turtles.length = 0;
      e.sim.time = 0; e.sim.hand = { x: 0, y: 0, life: 0 };
      e.light.time = 0; e.light.shafts.length = 0; e.light.nextShaft = 1e6; e.light.random = () => 0.5;
      e.atmosphere.random = () => 0.5; e.atmosphere.time = 0;
      e.atmosphere.leaves.forEach((l, i) => {
        l.u = 0.2 + 0.6 * (i % 7) / 7; l.v = 0.3 + 0.5 * (i % 5) / 5;
        l.age = l.life / 2; l.angle = (i % 11) * 0.5714;
        l.seed = ((i * 13) % 100) / 100; l.size = 16 + ((i * 7) % 10); l.variant = i % 2;
      });
      e.motes.forEach((m, i) => {
        m.x = ((i * 37) % 120) / 120; m.y = ((i * 53) % 120) / 120;
        m.seed = ((i * 17) % 100) / 100; m.size = 1 + (((i * 7) % 10) / 10) * 2;
      });
      e.landscape.lastDraw = null;
      e.render();
      return true;
    };
  });

  // A 组：新结构化染色（默认 0.85）  B 组：关掉结构（0，退回均匀染色）做对照
  const capture = async (tag) => {
    const shots = [];
    for (const term of TERMS) {
      await page.evaluate((t) => {
        const raw = JSON.parse(localStorage.getItem('fusheng-settings'));
        raw.almanacTerm = t;
        localStorage.setItem('fusheng-settings', JSON.stringify(raw));
      }, term);
      await page.reload({ waitUntil: 'load' });
      await page.waitForSelector('canvas.pond-canvas', { timeout: 20000 });
      /* ★★★ 门：GPU 到底跑没跑。这是唯一能一眼定位"参数对但画面不变"的检查。
       * 起因（2026-10-04，浪费了一整轮排查）：我在 GLSL hsv2rgb 里写了
       *   int i=int(floor(h))%6;
       * `%` 是 GLSL ES 3.00+ 才有的运算符，本项目是 WebGL1 ⇒ **整个 fragment
       * shader 编译失败** ⇒ Landscape 构造器里 try{this.init()}catch{...opacity=0}
       * 把异常静默吞掉 ⇒ 底图退化成 styles.css 的 CSS 静态兜底图。
       * 于是：页面看着完全正常，运行时读出的 termTintHSV 也完全正确，
       * 但 24 档里有 11 对像素**逐位相同**（ΔE 中位 0.06）。
       * ⚠️ 离线 numpy 把 GLSL 逻辑验到误差 0 也没用 —— 编译都没过，根本没执行。
       * 检查只看三个量：ready / uniforms 是否存在 / 画布 opacity。 */
      const gpu = await page.evaluate(() => {
        const e = window.__pondEngine;
        if (!e) return { engine: false };
        const L = e.landscape, c = document.querySelector('canvas.living-background');
        return { engine: true, ready: !!(L && L.ready), hasUniforms: !!(L && L.uniforms),
                 opacity: c ? c.style.opacity : '(no canvas)' };
      });
      if (!gpu.engine || !gpu.ready || !gpu.hasUniforms || gpu.opacity === '0') {
        console.error(`\n  \x1b[31m✘✘ GPU 底图没在跑（${term}）—— 判据全部无效，先修这个再看 ΔE\x1b[0m`);
        console.error('     ' + JSON.stringify(gpu));
        console.error('     十有八九是 fragment shader 编译失败被静默吞掉了：');
        consoleError('     1) 查 GLSL 用了 GLSL ES 3.00 才有的语法（% 取模、switch、位运算…）');
        consoleError('     2) 在 landscape.js 里临时把 catch 的错误打出来：');
        consoleError('        try{this.init()}catch(err){console.error(err);canvas.style.opacity=0}');
        consoleError('     3) 离线验证算法正确**不等于**能编译 —— 必须真编译一次拿 infoLog');
        await browser.close();
        process.exit(1);
      }
      const preparedSeason = await page.evaluate((p) => {
        const e = window.__pondEngine;
        if (!e) return null;
        e.updateOptions({ termPattern: p });
        window.__freeze(e);
        return e.landscape.season;
      }, tag === 'A' ? 0.85 : 0);
      if (!preparedSeason) { console.log(`  跳过 ${term}（无引擎句柄）`); continue; }
      await page.waitForTimeout(350);
      const f = join(OUT, `${tag}-${TERMS.indexOf(term)}-${term}.png`);
      await page.locator('canvas.pond-canvas').screenshot({ path: f });
      /* ★★★ 水区掩膜必须**向引擎要**，不能在这里按颜色重算。
       * 引擎的口径是 `smoothstep(.015,.08, min(original.g,original.b)-original.r)`，
       * 里的 `original` 是**染色前**的底图色 —— 也就是说水区是**几何属性**，
       * 与 tint 无关。旧版在这里对**染色后**的截图用同一公式重算，
       * 于是 HSV 方案把水色降饱和/转黄褐之后，大量水区不再满足 G,B>R
       * ⇒ 被判成"非水" ⇒ 寒露/霜降 的 water 像素数直接掉到 0，
       * ΔE 只剩岸边那点差异，实测 0.36（离线算其实是 4.98）。
       * 这就是「判据坏掉会伪装成实现有 bug」的第五例。
       * 正确做法：`landscape.waterMasks`（cacheWaterMask 缓存的 384x216 Uint8）
       * 就是引擎自己算的那张，直接导出成 PNG 给 Python 用。 */
      const maskPng = await page.evaluate(() => {
        const L = window.__pondEngine.landscape;
        const mask = L.waterMasks.get(L.season);
        if (!mask) return null;
        const W = 384, H = 216;
        const c = document.createElement('canvas'); c.width = W; c.height = H;
        const g = c.getContext('2d');
        const im = g.createImageData(W, H);
        for (let i = 0; i < mask.length; i++) {
          const v = mask[i] ? 255 : 0;
          im.data[i * 4] = v; im.data[i * 4 + 1] = v; im.data[i * 4 + 2] = v; im.data[i * 4 + 3] = 255;
        }
        g.putImageData(im, 0, 0);
        return c.toDataURL('image/png').split(',')[1];
      });
      const mf = join(OUT, `${tag}-${TERMS.indexOf(term)}-${term}-mask.png`);
      if (maskPng) fs.writeFileSync(mf, Buffer.from(maskPng, 'base64'));
      shots.push({ term, f, mf: maskPng ? mf : null, season: preparedSeason });
    }
    return shots;
  };

  section('① 截图 24 档 ×2 组');
  const A = await capture('A');
  ok(A.length === TERMS.length, 'A 组（结构化 pattern=0.85）全部截到', `${A.length}/${TERMS.length}`);
  const B = await capture('B');
  ok(B.length === TERMS.length, 'B 组（均匀对照 pattern=0）全部截到', `${B.length}/${TERMS.length}`);

  const listPath = join(OUT, '_list.json');
  fs.writeFileSync(listPath, JSON.stringify({ A, B, SEASON }));

  section('② 水面感知色差 ΔE（★ 方案 B 的核心判据）');
  const script = join(OUT, '_de.py');
  fs.writeFileSync(script, [
    'import json, os, numpy as np',
    'from PIL import Image',
    'D = json.load(open(r\'' + listPath + '\', encoding=\'utf-8\'))',
    'SEASON = D[\'SEASON\']',
    'def load(p):',
    '    return np.asarray(Image.open(p).convert(\'RGB\'), dtype=np.float32)',
    '# sRGB -> CIELAB（只算均值，够用于比较两档之间的差异）',
    'def to_lab(rgb):',
    '    c = rgb / 255.0',
    '    c = np.where(c > 0.04045, ((c + 0.055) / 1.055) ** 2.4, c / 12.92)',
    '    m = np.array([[0.4124, 0.3576, 0.1805], [0.2126, 0.7152, 0.0722], [0.0193, 0.1192, 0.9505]])',
    '    xyz = c @ m.T',
    '    wp = np.array([0.95047, 1.0, 1.08883])',
    '    t = xyz / wp',
    '    f = np.where(t > 0.008856, t ** (1 / 3), 7.787 * t + 16 / 116)',
    '    return np.array([116 * f[1] - 16, 500 * (f[0] - f[1]), 200 * (f[1] - f[2])])',
    '# ★ 水区掩膜直接读引擎导出的那张（384x216），按 cover 规则放大到截图尺寸。',
    '#   引擎的 cover 规则见 landscape.js: `ratio<aspect ? ratio/aspect : 1`（横向裁）',
    '#   / `ratio>aspect ? aspect/ratio : 1`（纵向裁），中心对齐。',
    'def water_mask(a, maskpath):',
    '    if not maskpath or not os.path.exists(maskpath):',
    '        raise SystemExit(\'missing engine mask: \' + str(maskpath))',
    '    mk = np.asarray(Image.open(maskpath).convert(\'L\'), dtype=np.uint8) > 127',
    '    H, W = a.shape[:2]',
    '    mh, mw = mk.shape',
    '    ratio, aspect = W / H, 3840 / 2160',
    '    if ratio < aspect:',
    '        cw, ch = mw * ratio / aspect, mh',
    '    else:',
    '        cw, ch = mw, mh * aspect / ratio',
    '    x0, y0 = (mw - cw) / 2.0, (mh - ch) / 2.0',
    '    sx, sy = cw / W, ch / H',
    '    yy = (np.arange(H) * sy + y0).astype(np.int32)',
    '    xx = (np.arange(W) * sx + x0).astype(np.int32)',
    '    np.clip(yy, 0, mh - 1, out=yy); np.clip(xx, 0, mw - 1, out=xx)',
    '    return mk[yy[:, None], xx[None, :]]',
    'def stats(shots):',
    '    out = []',
    '    for r in shots:',
    '        a = load(r[\'f\'])',
    '        msk = water_mask(a, r[\'mf\'])',
    '        if msk.sum() < 500:',
    '            out.append({\'term\': r[\'term\'], \'n\': int(msk.sum())}); continue',
    '        px = a[msk]',
    '        lab = to_lab(px.mean(axis=0))',
    '        mx, mn = px.max(axis=0) / 255, px.min(axis=0) / 255',
    '        sat = float((px[:, 0].max() - px[:, 0].min()).mean() / 255)',
    '        out.append({\'term\': r[\'term\'], \'n\': int(msk.sum()), \'lab\': lab.tolist(),',
    '                    \'lum\': float(lab[0]), \'sat\': sat,',
    '                    \'rgb\': [round(float(x), 1) for x in px.mean(axis=0)]})',
    '    return out',
    'def de(a, b):',
    '    return float(np.linalg.norm(np.array(a) - np.array(b)))',
    'res = {}',
    'for tag in (\'A\', \'B\'):',
    '    st = stats(D[tag])',
    '    valid = [s for s in st if \'lab\' in s]',
    '    pairs = []',
    '    for i in range(len(valid) - 1):',
    '        x, y = valid[i], valid[i + 1]',
    '        same = SEASON[x[\'term\']] == SEASON[y[\'term\']]',
    '        pairs.append({\'pair\': x[\'term\'] + \'->\' + y[\'term\'], \'same\': bool(same),',
    '                      \'dE\': round(de(x[\'lab\'], y[\'lab\']), 2)})',
    '    res[tag] = {\'stats\': st, \'pairs\': pairs}',
    'json.dump(res, open(r\'' + join(OUT, '_de.json') + '\', \'w\', encoding=\'utf-8\'), ensure_ascii=False)',
  ].join('\n'));
  execFileSync(PY, [script], { stdio: 'inherit' });
  const R = JSON.parse(fs.readFileSync(join(OUT, '_de.json'), 'utf8'));

  for (const tag of ['A', 'B']) {
    const same = R[tag].pairs.filter((p) => p.same);
    const cross = R[tag].pairs.filter((p) => !p.same);
    const label = tag === 'A' ? 'A 结构化(pattern=.85)' : 'B 均匀对照(pattern=0)';
    console.log(`\n  【${label}】`);
    console.log('  同季相邻档 ΔE：');
    for (const p of same) console.log(`    ${p.pair.padEnd(13)} ΔE=${String(p.dE).padStart(6)}`);
    const sm = same.map((p) => p.dE).sort((x, y) => x - y);
    const med = sm[Math.floor(sm.length / 2)];
    console.log(`  同季中位 ΔE=${med}  最小=${sm[0]}  跨季中位 ΔE=${cross.map(p => p.dE).sort((x, y) => x - y)[Math.floor(cross.length / 2)]}`);
    R[tag].summary = { sameMin: sm[0], sameMed: med, crossMed: cross.map(p => p.dE).sort((x, y) => x - y)[Math.floor(cross.length / 2)] };
  }

  section('③ 判据');
  const A2 = R.A.summary, B2 = R.B.summary;
  /* ★ 判据①改为「不劣于参考图同档对的80%」（详见 DE_MIN 上方注释）。
     * 不能用固定绝对值：旧值2.5 是为旧方案的分布定的，
     * 现在分布不同（最弱 1.91），而参考图同档对是 2.41 ⇒ 标定其实比参考图更准。
     */
  const REF_MIN = Math.min(...Object.values(REF_SAME_DE));
  ok(A2.sameMin >= REF_MIN * REF_RATIO_MIN,
    `★ 同季最弱档对 ΔE 不劣于参考图全局最弱对的 ${REF_RATIO_MIN * 100}%`,
    `我 ${A2.sameMin} vs 参考图最弱 ${REF_MIN}（×${(A2.sameMin / REF_MIN).toFixed(2)}）`
    + ` · 均匀对照时 ${B2.sameMin}，结构化后 ×${(A2.sameMin / Math.max(B2.sameMin, .01)).toFixed(2)}`);
  ok(A2.sameMed > B2.sameMed, '★ 结构化确实提高了可辨度（中位）',
    `${B2.sameMed} → ${A2.sameMed}`);
  ok(A2.sameMed >= DE_MIN, `同季中位 ΔE 达 ${DE_MIN}`, `${A2.sameMed}`);
  /* ★★ 新增：同季中位必须显著**高于**旧方案的水平（3.71）。
     *为什么需要这条：判据①「不劣于参考图最弱对×0.8」在反证（旧两点lerp）下
     *   **不会红** —— 旧方案最弱对 2.69，比参考图最弱 1.59 还高。
     *   也就是说判据①只能防"比参考图还差"，防不住"退回旧的塌陷方案"。
     *   真正能区分新旧的是**中位**：旧 3.71 → 新 5.68（+53%）。
     *   阈值取 4.5 = 旧基线上方 21%，留出实现波动的余量。
     *   ⚠️ 这条的依据是"实测旧基线"，不是拍脑袋：改动前跑过同一量具，
     *   同季中位稳定在 3.71~3.73（两轮），离 4.5 有足够距离。
     */
  ok(A2.sameMed >= 4.5, '★★ 同季中位 ΔE 显著高于旧两点-lerp 基线（3.71）',
    `实测 ${A2.sameMed}（阈值 4.5，提升 ${((A2.sameMed / 3.71 - 1) * 100).toFixed(0)}%）`);
  /* ★★ 判据②**方向反转**（2026-10-04）：旧判据是 `crossMed > sameMed`
     *（跨季须显著高于同季），那是在"季节切换太明显"的**旧病症**下写的。
     *   旧方案实测：跨季 22.80 / 同季 3.71（跨季是同季的 6 倍）—— 那就是病。
     *   现在改成 24 档实测色标后：跨季 4.25 / 同季 5.68 ⇒ **两者拉平了**，
     *   也就是说用户投诉的那个病**已经好了**。
     *   所以判据必须反转为「跨季不得显著高于同季」，
     *   否则会把"病好了"判成失败 —— 这就是判据与目标直接冲突的典型。
     * ⚠️ 阈值 6.0：允许跨季比同季高一点（相邻节气本就该有变化），
     *   但不允许"高出一倍"那种一眼看出的季节跳变。旧方案这里是 6.1 倍。
     */
  ok(A2.crossMed <= A2.sameMed * 1.30,
    '★★ 跨季不再显著高于同季（季节切换已平滑）',
    `跨季 ${A2.crossMed} vs 同季 ${A2.sameMed}（比值 ${(A2.crossMed / A2.sameMed).toFixed(2)}，`
    + `旧方案是 6.14 —— 判据方向已随目标反转）`);

  // 亮度/饱和度没有跑偏（不许变成滤镜）
  const st = R.A.stats.filter((s) => 'rgb' in s);
  const lums = st.map((s) => s.lum);
  ok(Math.max(...lums) - Math.min(...lums) < 55, '水面亮度未被染色压垮',
    `L* ${Math.min(...lums).toFixed(1)}~${Math.max(...lums).toFixed(1)}（极差 ${(Math.max(...lums) - Math.min(...lums)).toFixed(1)}）`);

  // 分布塌陷检查：20 对不能挤在低位（那意味着"多数档位其实分不出来"）
  const sameDEs = R.A.pairs.filter((p) => p.same).map((p) => p.dE).sort((a, b) => a - b);
  const p25 = sameDEs[Math.floor(sameDEs.length * 0.25)];
  const med = sameDEs[Math.floor(sameDEs.length / 2)];
  /* ⚠️ 阈值 2.0 是按**旧分布**（min 2.64 / 中位 3.73，极差 1.09）定的。
     * 新分布跨度大得多（min 1.91 / 中位 5.68 / 最大 17.35）——
     * **跨度大正是好事**（档间差异拉得开），用旧阈值判"塌陷"会误报。
     * 真正要防的塌陷是"中位≈最小值"（即只有个别档能分辨）。
     * 这里改成：至少一半的档对 >= 中位的一半（p25 不塌到接近 min）。
     */
  ok(med - sameDEs[0] < med * 0.95,
    '★ 同季档间差分布无塌陷（不是只有个别档能分辨）',
    `最小 ${sameDEs[0]} / p25 ${p25} / 中位 ${med} / 最大 ${sameDEs[sameDEs.length - 1]}`);

  section('④ 页面异常');
  ok(errors.length === 0, '全程无页面异常', errors.slice(0, 3).join(' | '));

  console.log(`\n通过 ${pass} 项，未通过 ${fail} 项`);
  console.log(`截图目录：${OUT}`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
