/**
 * P2-2「雨水不下雨」的**像素级**验收。
 *
 * ★★ 为什么单测锁不住这件事：
 *   护栏八锁的是**消费链每一环都存在**（源码里有 `syncRain`、有 `termDrops`、
 *   `scenery.rain` 读 `a.rainDrops`）。但本项目已经反复栽在同一个形态上：
 *   环都接上了，值仍然是 0 ⇒ 量具全绿、画面没雨。
 *   最接近的一次就是本次开发：`scenery.rain` 第一版读的仍是 `a.drops`
 *   （只在 `wet(weather)` 时有内容）⇒ 非雨天画出的雨丝恒为 0 条。
 *   ⇒ 必须有一把**只看像素**的量具。
 *
 * 判据设计（全部是「修好 vs 没修」能分开的）：
 *   ① 雨丝落点像素：on 档在**引擎自报落点处**的亮度必须明显高于 kill 档
 *      —— 落点由 `atmosphere.termDrops` 经 `rainPosition` 算出（与渲染同一函数）。
 *   ② 强反证：把 `syncRain` 换成 no-op 后，on/kill 的落点读数必须**明确不同**
 *      —— 没有这一条，① 可能因为任何其他原因恒绿。
 *   ③ 无雨档位落点处**不得**比 kill 档更亮（雨势不是常开通道）。
 *   ④ 雨势梯度：雨水落点数必须多于惊蛰（档案值有区分度，不是所有有雨档都拉满）。
 *   ⑤ 天气雨不受影响：`rainy` 天气下仍走 `a.drops` 老通道（`termDrops` 为 0 也下雨）。
 *
 * ★★★ 为什么**不能**用「全图像素里亮+冷色的占比」当判据（第一版就是这么写的，报假红）：
 *   ① **信号比阈值小一个量级**。44 条 × 约 16px 长 × 0.85px 宽 ≈ 700px
 *      = 全图 0.056%，而我第一版阈值写的是 0.15% ⇒ 阈值比信号大 3 倍，恒红。
 *   ② **特征不独占**。第一版把「亮 + 冷色」当雨丝，结果大雪档（**零雨**）
 *      测出 4.042%——那是雪。惊蛰 2.243% 反而高于雨水 0.586%，
 *      因为惊蛰的水色比雨水亮。⇒ 绝对特征量在多通道画面上必然被别的通道淹没。
 *   正解与 `check-lotus` 的 `floraManifest` 同一手法：**让渲染层自报落点，
 *   只在落点处取像素**。这样水色、雪、光斑全都在判据之外。
 *
 * 前置：dev server 在 5188。
 */
const PW = require('C:/Users/Y/.workbuddy/binaries/node/workspace/node_modules/playwright-core');
const { join } = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const ROOT = join(__dirname, '..');
const OUT = join(ROOT, 'out', 'rain-check');
const URL = 'http://127.0.0.1:5188/';
const PY = 'C:/Users/Y/.workbuddy/binaries/python/envs/default/Scripts/python.exe';
const EXE = 'C:/Users/Y/AppData/Local/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-win64/chrome-headless-shell.exe';

/* 覆盖：雨势峰值（雨水）/ 次级（惊蛰、立春）/ 零（夏秋冬各挑一档）。
 * ⚠️ 必须包含 rain=0 的档 —— 只测有雨档的话，
 *   「雨丝数量与 rain 无关（恒为 44 条）」也会全绿。
 * ⚠️ 特意包含**大雪**（雪也是亮色冷色）：它是「亮冷像素法」最好的反例，
 *   而按落点取像素时它必须读出 0。 */
const TERMS = ['雨水', '惊蛰', '立春', '大暑', '霜降', '大雪'];

let pass = 0, fail = 0;
const ok = (c, label, detail) => {
  const mark = c ? '\x1b[32m✔\x1b[0m' : '\x1b[31m✘\x1b[0m';
  if (c) pass++; else fail++;
  console.log(`  ${mark} ${label}${detail ? '  — ' + detail : ''}`);
};
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await PW.chromium.launch({ executablePath: EXE, args: ['--no-sandbox', '--use-gl=swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1380, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE ' + m.text()); });

  await page.goto(URL, { waitUntil: 'load', timeout: 60000 });
  await page.evaluate(() => {
    localStorage.setItem('fusheng-settings', JSON.stringify({
      season: 'spring', weather: 'sunny', day: 'day',
      fishCount: 10, fishSize: 1, turtleCount: 0, quality: 'high',
      reducedMotion: false, sound: false, volume: 0, ecoMode: false,
      almanacMode: 'manual', almanacTerm: '雨水',
    }));
  });
  await page.addInitScript(() => {
    /* ★ `rainPosition` 必须挂到 window：判据要用**渲染层同一个函数**算落点，
     *   自己重写一份近似 ⇒ 坐标与实际笔画错位 ⇒ 恒红或恒绿。
     *   ⚠️ 用 `addInitScript`（每次 reload 都重跑）而不是 goto 后挂一次：
     *   `page.reload()` 会重置 window，一次性挂载在换档后就 `undefined` 了
     *   —— 症状是 `e.__rp is not a function`，第一版就踩了。
     *   动态 import 拿的是 Vite dev 下**当前正在跑的模块实例**（同 URL 同一实例）。 */
    window.__rpReady = import('/src/engine/atmosphere.js')
      .then((m) => { window.__rp = m.rainPosition; });
    window.__freeze = (e) => {
      e.updateOptions({ paused: true });
      e.sim.fish.length = 0; e.sim.turtles.length = 0;
      e.sim.time = 0; e.sim.hand = { x: 0, y: 0, life: 0 };
      e.light.time = 0; e.light.shafts.length = 0; e.light.nextShaft = 1e6; e.light.random = () => 0.5;
      e.atmosphere.random = () => 0.5; e.atmosphere.time = 0; e.atmosphere.leaves.length = 0;
      e.motes.forEach((m, i) => {
        m.x = ((i * 37) % 120) / 120; m.y = ((i * 53) % 120) / 120;
        m.seed = ((i * 17) % 100) / 100; m.size = 1 + (((i * 7) % 10) / 10) * 2;
      });
      e.landscape.lastDraw = null;
      // ★ 雨滴必须**冻结在可复现的位置**：`update` 每帧都会把到期的雨滴重掷
      //   （`Object.assign(d, this.drop())`）。冻结时把所有 age 压到 0，
      //   否则两次截图的雨丝位置不同，判据就成了「噪声 > 阈值」。
      e.atmosphere.drops.forEach((d) => { d.age = 0; });
      e.atmosphere.termDrops.forEach((d) => { d.age = 0; });
      e.render();
      return true;
    };
  });

  section('① 截图：每档两张（正常 / 强反证：syncRain 变 no-op）');
  const shots = [];
  for (const term of TERMS) {
    await page.evaluate((t) => {
      const raw = JSON.parse(localStorage.getItem('fusheng-settings'));
      raw.almanacTerm = t;
      localStorage.setItem('fusheng-settings', JSON.stringify(raw));
    }, term);
    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('canvas.pond-canvas', { timeout: 20000 });
    /* 等 `rainPosition` 挂好（`addInitScript` 里的动态 import 是异步的）。
     * ⚠️ 不能省这一步 —— `__rp` 还没挂上时取样会抛 `__rp is not a function`，
     *   而那与「雨丝没画」是完全不同的缺陷，不该混在同一个报错里。 */
    await page.waitForFunction(() => typeof window.__rp === 'function', { timeout: 10000 });

    const shoot = async (kill) => {
      const info = await page.evaluate((k) => {
        const e = window.__pondEngine;
        if (!e) return null;
        window.__freeze(e);
        if (k && !e.__rainPatched) {
          e.__rainPatched = true;
          e.__syncRain = e.atmosphere.syncRain;
          // ★ 反证手法：把 `syncRain` 换成 no-op，而不是改档案。
          //   改档案（如 `rain: 0`）会连 `visualFor` 的输出一起变，
          //   量具就分不清「雨丝没画」和「雨势算错了」——两种缺陷该分开定位。
          e.atmosphere.syncRain = () => {};
          e.__termDropsBackup = e.atmosphere.termDrops.slice();
          e.atmosphere.termDrops = [];
        }
        if (!k && e.__rainPatched) {
          e.atmosphere.syncRain = e.__syncRain;
          e.atmosphere.termDrops = e.__termDropsBackup;
          e.atmosphere.options.rainAmount = 0;   // 强制下一次 syncRain 重新按档案铺
        }
        e.render();
        /* ★★★ 自报雨丝落点（判据的地基）。
         *   `rainPosition` 是**渲染层用的同一个函数**（`scenery.rain` 里也是它），
         *   所以这里算出的坐标就是雨丝真正画上去的位置 —— 不是「估计大概在哪」。
         *   落点取线段的**中点**（`scenery.rain` 画的是
         *   `moveTo(x+4*slant, y-12-seed*9) → lineTo(x,y)`，中点落在笔画内部）。
         *   ⚠️ 坐标要乘 dpr：截图是设备像素，而 `rainPosition` 拿到的是 CSS 像素。 */
        const dpr = e.dpr || 1;
        const seg = (d) => {
          const p = window.__rp(d, e.width, e.height, e.options);
          return { x: (p.x + 2 * p.slant) * dpr, y: (p.y - (7.5 + d.seed * 5.5)) * dpr };
        };
        return {
          rain: e.termVisual.rain,
          drops: e.atmosphere.drops.length,
          termDrops: e.atmosphere.termDrops.length,
          weatherDrops: e.atmosphere.drops.length,
          pts: e.atmosphere.termDrops.map(seg),
          wpts: e.atmosphere.drops.slice(0, 12).map(seg),
        };
      }, kill);
      if (!info) return null;
      await page.waitForTimeout(260);
      const f = join(OUT, `${TERMS.indexOf(term)}-${term}-${kill ? 'kill' : 'on'}.png`);
      await page.locator('canvas.pond-canvas').screenshot({ path: f });
      return { f, ...info };
    };

    const on = await shoot(false);
    const killShot = await shoot(true);
    if (!on || !killShot) { console.log(`  跳过 ${term}（无引擎句柄）`); continue; }
    shots.push({ term, on, kill: killShot });
    console.log(`  ${term.padEnd(3)} rain=${on.rain.toFixed(2)} 天气雨drops=${on.drops} 节气雨termDrops=${on.termDrops}`
      + ` | kill档 termDrops=${killShot.termDrops}`);
  }
  ok(shots.length === TERMS.length, '全部档位截到', `${shots.length}/${TERMS.length}`);

  section('② 落点处取像素（雨丝自报坐标）');
  const listPath = join(OUT, '_list.json');
  fs.writeFileSync(listPath, JSON.stringify(shots));
  const outPath = join(OUT, '_stat.json');
  if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
  /* ★★★ 只在**雨丝自报落点**处取像素（本量具的核心，理由见文件头）。
   *   `sample` 取落点邻域 R×R 的平均亮度（convert('L')）——
   *   用邻域而非单像素：抗浏览器抗锯齿带来的半像素偏移。
   *   ⚠️ 落点为**空**时返回 None 而不是 0 ——
   *     0 与「落点处很暗」不可区分，而后者才是要抓的异常。
   *   ⚠️ 路径统一转正斜杠再嵌进 Python 字面量（Windows `\U` 之类是转义陷阱）。 */
  const pyPath = (p) => p.replace(/\\/g, '/');
  const script = join(OUT, '_stat.py');
  fs.writeFileSync(script, [
    'import json, numpy as np',
    'from PIL import Image',
    'R = 2',
    'rows = json.load(open(r\'' + pyPath(listPath) + '\', encoding=\'utf-8\'))',
    'def sample(p, pts):',
    '    a = np.asarray(Image.open(p).convert(\'L\'), dtype=np.float32)',
    '    H, W = a.shape',
    '    vals = []',
    '    for q in pts:',
    '        x, y = int(round(q[\'x\'])), int(round(q[\'y\']))',
    '        if x < R or y < R or x >= W - R or y >= H - R:',
    '            continue',
    '        vals.append(float(a[y - R:y + R + 1, x - R:x + R + 1].mean()))',
    '    return float(np.mean(vals)) if vals else None',
    'def footprint(on_p, kill_p):',
    '    """**雨在屏幕上占了多少像素** —— 1× 观感的直接代理量。',
    '    量法：on 与 kill 两张的逐像素最大通道差 > 6 的占比。',
    '    ⚠️ 第一版这里用的是「亮+冷像素绝对占比」，**那个指标压根没在量雨**：',
    '      雨丝是 alpha .31~.5 的细线压在中亮度水色上，落点亮度只有 ~0.66，',
    '      而阈值是 lum>0.80 ⇒ 雨丝**从一开始就被阈值排除在外**。',
    '      证据：`TERM_RAIN_MAX` 从 44 加到 70（+59%），该指标 0.586% → 0.586%（一位没动）。',
    '    ⇒ 「加了量但指标不动」正是判据没在量目标量的信号（同「全绿且很快」）。',
    '      差分法直接 attributable 于雨，且随雨量单调变化。"""',
    '    a = np.asarray(Image.open(on_p).convert(\'RGB\'), dtype=np.float32)',
    '    b = np.asarray(Image.open(kill_p).convert(\'RGB\'), dtype=np.float32)',
    '    return float((np.abs(a - b).max(axis=2) > 6).mean() * 100)',
    'out = []',
    'for r in rows:',
    '    rec = {',
    '        "term": r["term"], "rain": r["on"]["rain"],',
    '        "termDrops": r["on"]["termDrops"],',
    '        "killTermDrops": r["kill"]["termDrops"],',
    '        "weatherDrops": r["on"]["weatherDrops"],',
    '        "fp": footprint(r["on"]["f"], r["kill"]["f"]),',
    '    }',
    '    # 有雨档：on 档的落点集 vs kill 档**同一批坐标**（位置不变，只是雨丝不画了）',
    '    rec["onAt"] = sample(r["on"]["f"], r["on"]["pts"])',
    '    rec["killAt"] = sample(r["kill"]["f"], r["on"]["pts"])',
    '    # 天气雨落点（验证老通道没被我改坏）',
    '    rec["wOnAt"] = sample(r["on"]["f"], r["on"]["wpts"])',
    '    rec["wKillAt"] = sample(r["kill"]["f"], r["on"]["wpts"])',
    '    out.append(rec)',
    'json.dump(out, open(r\'' + pyPath(outPath) + '\', \'w\', encoding=\'utf-8\'))',
  ].join('\n'));
  execFileSync(PY, [script], { stdio: 'inherit' });
  const rows = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  const fmt = (v) => (v == null ? '  —  ' : v.toFixed(1).padStart(5));
  for (const r of rows) {
    const lift = (r.onAt != null && r.killAt != null) ? r.onAt - r.killAt : null;
    console.log(`  ${r.term.padEnd(3)} rain=${r.rain.toFixed(2)} termDrops=${String(r.termDrops).padStart(2)}`
      + `  落点亮度 on=${fmt(r.onAt)} kill=${fmt(r.killAt)} 提亮=${lift == null ? '—' : lift.toFixed(1).padStart(5)}`
      + `  1×雨 footprint ${r.fp.toFixed(3)}%`);
  }

  section('③ 判据');
  const byTerm = Object.fromEntries(rows.map((r) => [r.term, r]));
  const rainy = rows.filter((r) => r.rain > 0.2);
  const dry = rows.filter((r) => !(r.rain > 0.05));

  ok(rows.filter((r) => r.killTermDrops === 0).length === rows.length,
    '★ 反证生效：kill 档 termDrops 全部为 0（否则提亮恒为 0，判据自身失效）',
    rows.map((r) => `${r.term}:${r.killTermDrops}`).join(' '));

  ok(rainy.every((r) => r.termDrops > 0),
    '① 有雨档位的 termDrops 必须 > 0（atmosphere 真的按档案铺了雨丝）',
    rainy.map((r) => `${r.term}:${r.termDrops}`).join(' '));

  /* 阈值来自实测：雨丝是 `rgba(230,247,240,.31~.5)` 的 0.85px 亮线压在
   * 深色水面上 ⇒ 落点邻域均值提亮 10~40。噪声底 ≈0（同一批坐标、同一帧相位）。
   * 阈值取 4：既高于噪声，又能分开「画了」(实测 13~31) 与「没画」(0)。 */
  const LIFT_MIN = 4;
  ok(rainy.every((r) => r.onAt != null && r.onAt - r.killAt >= LIFT_MIN),
    `② 有雨档位的落点必须真的被画亮（提亮 ≥ ${LIFT_MIN}）`,
    rainy.map((r) => {
      const d = r.onAt != null && r.killAt != null ? (r.onAt - r.killAt).toFixed(1) : '—';
      return `${r.term}:+${d}`;
    }).join(' '));

  ok(dry.every((r) => r.termDrops === 0),
    '③ 无雨档位 termDrops 必须为 0（雨势不是常开通道）',
    dry.map((r) => `${r.term}(rain=${r.rain.toFixed(2)}):${r.termDrops}`).join(' '));

  /* ④ 无雨档位不能靠「取不到落点」蒙混过关：拿**天气雨坐标**做一次对照 ——
   *   若某档其实有天气雨（weatherDrops>0），它的落点同样该被画亮。
   *   而本量具统一用 sunny 天气 ⇒ weatherDrops 必为 0 ⇒ 整列应为 null。 */
  ok(rows.every((r) => r.weatherDrops === 0),
    '④ 本量具全程 sunny 天气（weatherDrops 必为 0），否则量到的是天气雨不是节气雨',
    rows.map((r) => `${r.term}:${r.weatherDrops}`).join(' '));

  const ws = byTerm['雨水'], jz = byTerm['惊蛰'], lc = byTerm['立春'];
  if (ws && jz) {
    ok(ws.termDrops > jz.termDrops && ws.termDrops > lc.termDrops,
      '⑤ 雨势梯度：雨水落点数必须多于惊蛰/立春（档案值有区分度，不是所有有雨档都拉满）',
      `雨水 ${ws.termDrops}条  惊蛰 ${jz.termDrops}条  立春 ${lc.termDrops}条`);
  }

  /* ⑥ ★★★ 「存在」不等于「看得见」，而**判据本身也得先证明它在量目标量**。
   *   落点提亮只证明雨丝被画在它该在的位置，**证明不了 1× 下读得出来**。
   *   这里量「雨在屏幕上占了多少像素」（on/kill 差分 footprint），两条要求：
   *   (a) **随雨量单调**：雨水 > 惊蛰 > 立春，且无雨档 ≈ 0
   *       —— 这条同时是判据自身的有效性检验：若雨量翻倍而 footprint 不动，
   *          说明这个指标压根没在量雨（第一版就栽在这里：44→70 条，
   *          「亮冷像素占比」0.586% → 0.586%，一位没动）。
   *   (b) **绝对下限**：见下方 FP_MIN 的来历。
   *
   * ★★ 阈值 0.12% 是**从反证实测反推**的，不是拍的。
   *   ⚠️ 第一版我拍了个 0.25%，然后反证立刻把它打脸：
   *     **线宽 1.15 改回 0.85，footprint 0.169% → 0.173%（反而更高，仍过阈值）**
   *     ⇒ 那个阈值区分不出「调过」与「没调过」，等于没判。
   *   逐档实测（70 条，只改笔画粗细/长度）：
   *     宽 1.15 · 长 15+11s ⇒0.169%  ← 定稿（1× 目视：斜向雨丝可辨）
   *     宽 0.85 · 长 15+11s ⇒ 0.173%（反证：仍过 ⇒ 宽度不是主要因子）
   *     宽 0.50 · 长 15+11s ⇒ 0.116%（反证：报红 ✓ 阈值在此之上）
   *   ⇒ 定 0.12%：高于「调到 0.5 宽」的反证态、低于定稿态，两端各留余量。
   *     结论也写进实现：**footprint 主要由「长度 × 条数」决定，线宽影响很小**
   *     （0.85 与 1.15 差在噪声内）—— 这与「雨是细线」的形态一致。
   *   ⚠️ 若将来有人把雨调得更密，**该调的是这个阈值而不是实现**——
   *     先想清楚「雨水这一档该有多密的雨」，那是物候判断，不是数值调节。 */
  const FP_MIN = 0.12;
  if (ws && jz && lc) {
    ok(ws.fp > jz.fp && jz.fp > lc.fp,
      '⑥a 雨的屏幕占比必须随雨量单调递增（雨水>惊蛰>立春）—— 兼作判据自身的有效性检验',
      `雨水 ${ws.fp.toFixed(3)}%  惊蛰 ${jz.fp.toFixed(3)}%  立春 ${lc.fp.toFixed(3)}%`);
    ok(ws.fp >= FP_MIN,
      `⑥b ★ 1× 绝对可见度：雨水档雨占屏幕 ≥ ${FP_MIN}%（不能「有但看不出来」）`,
      `实测 ${ws.fp.toFixed(3)}%（1× 截图目视：斜向雨丝可辨）`);
  }
  ok(dry.every((r) => r.fp <= 0.01),
    '⑥c 无雨档位的雨 footprint ≈ 0（不是无脑常开）',
    dry.map((r) => `${r.term}:${r.fp.toFixed(3)}%`).join(' '));

  section('④ 天气雨老通道未被改坏（rainy 天气下 termDrops=0 仍要下雨）');
  const w = await page.evaluate(async () => {
    const e = window.__pondEngine;
    e.updateOptions({ weather: 'rainy' });
    e.render();
    const dpr = e.dpr || 1;
    const seg = (d) => {
      const p = window.__rp(d, e.width, e.height, e.options);
      return { x: (p.x + 2 * p.slant) * dpr, y: (p.y - (7.5 + d.seed * 5.5)) * dpr };
    };
    return { drops: e.atmosphere.drops.length, termDrops: e.atmosphere.termDrops.length, pts: e.atmosphere.drops.slice(0, 12).map(seg) };
  });
  const wf = join(OUT, 'weather-rainy.png');
  await page.locator('canvas.pond-canvas').screenshot({ path: wf });
  ok(w.drops > 0 && w.termDrops === 0,
    '⑦ rainy 天气下走 a.drops 老通道、且不与节气雨叠加',
    `drops=${w.drops} termDrops=${w.termDrops}`);
  ok(w.pts.length > 0, '⑧ 天气雨落点可算（判据的取样坐标有效）', `${w.pts.length} 个`);

  section('⑤ 页面异常');
  ok(errors.length === 0, '全程无页面异常', errors.slice(0, 2).join(' | '));

  console.log(`\n通过 ${pass} 项，未通过 ${fail} 项`);
  console.log(`截图目录：${OUT}`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
