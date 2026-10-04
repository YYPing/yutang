/**
 * 昼夜连续化的**像素级**验收 —— 防「一天只有两种画面」。
 *
 * ★★ 为什么单测不够：`tests/daylight.test.js` 证明的是"每个插值函数本身连续"
 *   （`byDaylight` 单调、端点逐位一致）。但它**看不到画面**：
 *   15+ 处改造里只要有一处漏了、或者某个 `night` 布尔门控的权重算错，
 *   单测全绿而画面照样在黎明"啪"地跳一下。
 *   像素量具是唯一能回答"用户眼睛看到的那一帧，是平的还是跳的"的判据。
 *
 * ★★★ 三条不变式（本量具的设计前提，写下来防止以后误改）：
 *   ① **注入点选 `options.dayLight`**（不是改系统时钟）。
 *      `daylightOf()` 就是从它读连续标量的，而 dev 环境改时钟不可行。
 *      `options.dayLight` 是渲染层唯一的输入 ⇒ 改它等于改真实路径。
 *   ② **"改动前的画面"可以精确重建**：把 `dayLight` 换成二值 `night?0:1`
 *      就是改动前的逐位等价物（恒等式 `byDaylight(a,b,{dayLight:0}) === a`）。
 *      ⇒ 不必 stash、不必重新构建，A/B 两组能在**同一份代码、同一次会话**里跑完。
 *      这也让判据 ⑥ 有了真正的阳性对照，而不是"我记得以前是跳的"。
 *   ③ **门控翻转点（04:30→05:00、18:30→19:00）单列，不进平滑度阈值**。
 *      萤火虫/蝴蝶是**离散门控**（有意保留，见 tests/daylight.test.js 白名单）。
 *      把它们混进"平滑度"里量，等于把设计当成缺陷。
 *
 * ★★★ 第一版量具栽在哪（这是本文件最重要的一段注释，别删）：
 *   第一版用「**像素差 > 2 灰阶的占比**」当"跳变"的度量，结果 ④ 报 max **89.9%**、
 *   ③ 报夜间平台 **87.0%** —— 看着像画面在疯狂闪，实际一帧都没闪。
 *   根因：**夜罩是全屏 `fillRect(rgba(7,25,39, 0.22*dim))`**。dim 从 1 走到 .844
 *   （半个小时的真实变化）就让**全屏每个像素**各暗 2 个灰阶 ⇒ 90% 的像素"变了"。
 *   而这个变化人眼读出来就是"天慢慢亮"，**根本不是跳变**。
 *   ⇒ 「像素差占比」量的是**空间覆盖**，不是**感知跳变**。
 *   ★ 教训与记忆里第 8 条同源：**阈值/指标必须在"被测对象真正变化的维度"上选**。
 *     噪声底那次是"要在掩膜内算"，这次是"要用亮度差而不是像素覆盖率"。
 *
 *   正解：用**单档平均亮度变化（灰阶）**当跳变量。
 *   判"跳变"问的是"这一帧和上一帧差多少"，那是标量；覆盖率是空间量，
 *   对全屏渐变天生过敏。顺带白送一个强判据（见④的"钟形指纹"）。
 *
 * 判据（阈值全部按实测分布定，不拍脑袋；实测数见 §实测 注释）：
 *   ① 昼夜亮度必须真的分开（否则"连续"等于"什么都没变"）
 *   ② 幅度层单调：05:00→12:00 不回落、12:00→18:30 不回升
 *   ③ 平台期画面**逐像素相同**（00:00–04:30 与 19:30–24:00），且 24:00 ≡ 00:00
 *   ④ 过渡段单档亮度变化平缓，且步长呈**钟形**（smoothstep 的指纹，见下）
 *   ⑤ ★ 两端与改动前逐位一致：`dayLight:0` ≡ 不给 dayLight 只给 `night:true`
 *   ⑥ ★ 单档最大亮度变化：连续版明显小于改动前（二值对照版）
 *   ⑦ 噪声底 ≈ 0
 *
 * ★ 为什么④要额外查"钟形"：
 *   smoothstep 两端一阶导为 0 ⇒ 步长应该在过渡段**中间最大、两端趋零**。
 *   真正的阶跃（旧版）形状恰好相反：中间全 0、某一格突然吃掉全部 21.9 灰阶。
 *   两个都是"单调"，但分布形状完全不同 —— 只查 max 会漏掉"某两档之间偷偷跳一下
 *   但幅度不大"的情况（比如把过渡压缩到 10 分钟）。**分布形状比峰值更难伪造。**
 *
 * 前置：dev server 在 5188。
 */
const PW = require('C:/Users/Y/.workbuddy/binaries/node/workspace/node_modules/playwright-core');
const { join } = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const ROOT = join(__dirname, '..');
const OUT = join(ROOT, 'out', 'daylight-check');
const URL = 'http://127.0.0.1:5188/';
const PY = 'C:/Users/Y/.workbuddy/binaries/python/envs/default/Scripts/python.exe';
const EXE = 'C:/Users/Y/AppData/Local/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-win64/chrome-headless-shell.exe';

/* 采样时刻：每半小时一档，00:00–24:00 共 49 档。
 * ⚠️ 24.0 与 0.0 是同一个 dayLight（都是深夜 0），两张图应当**逐像素相同** ——
 *   这是白送的一个跨零自比对照（判据 ③ 的一部分）。 */
const SAMPLES = [];
for (let i = 0; i <= 48; i++) {
  const h = i / 2;
  SAMPLES.push({ i, hour: h, hh: Math.floor(h), mm: (h % 1) * 60 });
}
/** `getDayPhase` 的分界：hour<5 → night，5~7 dawn，7~17 day，17~19 dusk，其余 night。
 *  ⚠️ 判据**不用**这个复算函数（自己验自己），它只留作可读性参照；
 *     真实相位一律从页面里的 `getDayPhase` 读（见下），交叉校验判⓪ 比的是
 *     "页面读回的 night 在 GATE_EDGES 处确实翻转了"。 */
const isNightPhase = (h) => !(h >= 5 && h < 19);
/* 门控翻转的两个时刻（相邻对跨过它们时画面差含"离散门控"，不进平滑度判据）。 */
const GATE_EDGES = [[4.5, 5.0], [18.5, 19.0]];
/** 门控恒定的过渡段：05:00–18:30（night 恒为 false，只有幅度在变）。 */
const SMOOTH_RANGE = [5.0, 18.5];

/* ★ 阈值按实测分布定，不拍脑袋（2026-10-04 首跑，49 档 ×2 组）：
 *
 * ④ 单档亮度变化 —— 过渡段 28 档实测步长
 *      [.00, 3.91, 7.35, 7.17, 3.50, (平台 0 ×N), 3.50, 7.17, 7.35, 3.92]
 *    升/降两半各自是钟形、且严格对称（3.91/3.50 · 7.35/7.35 · 7.17/7.17）——
 *    这正是 smoothstep 一阶导的形状（两端一阶导为 0 ⇒ 步长趋零）。
 *    阈值 9.0 = 峰值 7.35 上方留 22% 余量。
 *    ★ 对照：二值版（改动前）同区间是 **[21.94, 0×12, 21.94, 0]**
 *      —— 峰值 21.94 落在**边缘**、中间恒 0，是典型阶跃形状。
 *      阈值 9.0 距这个真信号仍有 2.4× 距离。
 *
 * ④钟形下沿 —— 判「半段内峰值 / 边缘步长 ≥ 1.5」。
 *    实测升段 7.35 / 0.00、降段 7.35 / 3.92 ⇒ 最小比值 1.88。
 *    阈值取 1.5：距实测 1.88 有 20% 余量，而阶跃版该比值是 **0**（峰值就在边缘）
 *    ⇒ 判据在两个方向上都有足够分离度。
 *    ⚠️ **必须按升/降两半分开判**（第一版整段取首尾 ⇒ 假红）：
 *      黄昏的峰值恰好落在末档（后面紧接平台 0），整段比值恒等于 1。
 *
 * ② 单调性容差 0.25 灰阶：平台内相邻档实测残差 0.000 灰阶，
 *    而任何真实回落都 ≥ 1 灰阶 —— 差一个量级，不会误放也不会误杀。
 *
 * ③⑤⑦ "逐像素相同"按定义必须为 0.000%，阈值 0.02% 只为容忍 PNG 编码器末位。
 *
 * ⑥ 改善倍数阈值 2.0（实测 2.98，即"每步最多走 1/3 的路"）。
 *   ⚠️ 只有 2.98 而不是 18×：因为连续版要走的总路更长（16 小时 vs 4 小时），
 *     摊到 14 步上每步自然就小。**倍数小不代表收益小** —— 收益在④的钟形里，
 *     不在⑥的倍数里。别为了让倍数好看去调窄过渡段。
 *
 * ① 昼夜亮度分离度下限：实测 21.94 灰阶，取 8 只要求"真的分开了"。 */
const STEP_LUM_MAX = 9.0;
const BELL_RATIO_MIN = 1.5;
const IDENTICAL_MAX = 0.02;
const MONO_TOL = 0.25;
const IMPROVE_MIN = 2.0;
/** ① 昼夜亮度分离度下限 */
const SEP_MIN = 8;

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
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE ' + m.text()); });

  // 反证开关：设 __DL_STEP=1 时把 dayLightAt 换成硬阶跃（t 到 1 才跳），验证判据抓得住真跳变。
  // ⚠️⚠️ **必须注册在第一次 goto 之前** —— `addInitScript` 只在**下一次导航**时注入。
  //   第一版反证放在 goto 之后 ⇒ 开关从未生效 ⇒ 跑出来 19/19 全绿，
  //   而曲线数据与正跑一字不差 —— 这就是「反证自己没跑」的典型形态：
  //   **结果与基线完全相同，就是反证没生效的信号**（记忆里那条"反证时结果没变"）。
  if (process.env.__DL_STEP) {
    await page.addInitScript(() => { globalThis.__DAYLIGHT_STEP = true; });
    console.log('  \x1b[33m[反证] dayLightAt 已被换成硬阶跃\x1b[0m');
  }

  await page.goto(URL, { waitUntil: 'load', timeout: 60000 });
  await page.evaluate(() => {
    localStorage.setItem('fusheng-settings', JSON.stringify({
      season: 'summer', weather: 'sunny', day: 'day',
      fishCount: 0, fishSize: 1, turtleCount: 1, quality: 'high',
      reducedMotion: false, sound: false, volume: 0, ecoMode: false,
      almanacMode: 'manual', almanacTerm: '夏至',
    }));
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('canvas.pond-canvas', { timeout: 20000 });

  // ★ 曲线与相位都从**真实模块**取，不在本工具里复算一遍。
  //   复算 = 迟早分叉，而分叉之后量具量的是一个不存在的曲线
  //   （记忆里"量具必须与引擎真实路径同步"那条铁律，此处最典型的适用场景）。
  const envReady = await page.evaluate(async () => {
    const m = await import('/src/lib/environment.js');
    window.__dayLightAt = m.dayLightAt;
    window.__getDayPhase = m.getDayPhase;
    return typeof m.dayLightAt === 'function' && typeof m.getDayPhase === 'function';
  });
  ok(envReady, '★ 真实 dayLightAt / getDayPhase 已从 /src/lib/environment.js 装入', `dev server ${URL}`);

  const hasEngine = await page.evaluate(async () => {
    const e = window.__pondEngine;
    if (!e) return false;
    // 冻结：暂停 rAF、清鱼、锁死所有随机源与独立时钟。
    // ★ 与 check-term-delta 同一套，理由见那里。这里额外注意 `paused`
    //   会 cancelAnimationFrame ⇒ 画面完全静态，所以**不需要静止像素掩膜**。
    e.updateOptions({ paused: true });
    e.sim.fish.length = 0;
    e.sim.hand = { x: 0, y: 0, life: 0 };
    e.light.time = 0; e.light.shafts.length = 0; e.light.nextShaft = 1e6; e.light.random = () => 0.5;
    e.atmosphere.random = () => 0.5; e.atmosphere.time = 0;
    e.motes.forEach((m, i) => {
      m.x = ((i * 37) % 120) / 120; m.y = ((i * 53) % 120) / 120;
      m.seed = ((i * 17) % 100) / 100; m.size = 1 + (((i * 7) % 10) / 10) * 2;
    });
    // 乌龟位置钉住：turtleCount=1，它的 alpha 是昼夜插值的一处真实通道。
    e.sim.turtles.forEach((t, i) => { t.x = e.width * 0.32; t.y = e.height * 0.62; t.angle = 0.6 + i; });
    // ★★★★ **收敛不等于稳定 —— 还要先把 resize 等完**（这条花了三轮才找到）。
    //   症状：只有 **00:30 一档**的像素差是 0.0961%（984 像素，固定在
    //   x1019–1161 / y32–85），别的 48 档全0；换个轮次又可能消失。
    //   根因：`pond.js:140` 的 **`new ResizeObserver(() => this.resize())` 是异步的**。
    //   `page.reload()` 之后 React 把 HUD 渲染完才触发 resize，而预热跑在
    //   那之前 ⇒ **第0 档截在 resize 前、第 1 档截在 resize 后**，
    //   两帧的画布尺寸不同 ⇒ 那一块区域整片错位。
    //   ⇒ 光"渲染到不动点"抓不到它，因为 resize 之后画面又变了一次。
    //
    //   正解：**先强制 resize 并等它落定，再开始收敛**。
    //   而且这件事必须做在**冻结之前** —— 尺寸变了，`motes` 钉好的归一化坐标
    //   与 `ctx` 的 dpr 变换都要重新对齐。
    e.resize();
    window.dispatchEvent(new Event('resize'));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

    // ★★ 渲染到不动点：不是"渲染够几帧"，而是"连续两帧像素完全相同"。
    //   这与记忆里「光钉 random 不够，要连状态一起钉」同源：
    //   **冻结 = 让画面收敛到不动点，而不是让第一帧恰好等于稳态。**
    //   ⚠️ 收敛循环只能抓"渲染造成的变化"，抓不到 resize —— 见上面那条。
    e.landscape.lastDraw = null;
    let warm = 0, stable = -1;
    const c2 = e.ctx, W = e.width, H = e.height;
    const grab = () => Array.from(c2.getImageData(0, 0, W, H).data);
    let prev = grab();
    for (let i = 0; i < 40; i++) {
      e.render();
      const now = grab();
      let d = 0;
      for (let k = 0; k < now.length; k += 4) if (now[k] !== prev[k] || now[k + 1] !== prev[k + 1] || now[k + 2] !== prev[k + 2]) d++;
      prev = now;
      if (d === 0) { stable = i + 1; break; }
      warm = i + 1;
    }
    e.__warmFrames = warm;
    e.__stableAt = stable;
    return true;
  });
  ok(hasEngine, '引擎句柄可用且已冻结 + 预热到不动点（连续两帧像素差为 0）');
  // 预热帧数只做记录，不设判据 —— 不同机器上 GL 首帧耗时不同（swiftshader 尤其慢）。
  console.log(`     预热收敛：${await page.evaluate(() => `连续 ${window.__pondEngine.__stableAt} 帧后进入不动点`)}`);

  /* 注入并截图。
   * @param useBool false ⇒ dayLight = 真实曲线值（连续版）
   *                 true  ⇒ dayLight = night?0:1（**改动前的逐位等价物**） */
  const shoot = async (tag, useBool) => {
    const shots = [];
    let maxSettle = 0;
    for (const s of SAMPLES) {
      const info = await page.evaluate(({ hh, mm, useBool }) => {
        const date = new Date(2026, 8, 27, hh, mm, 0, 0);
        const dl = window.__dayLightAt(date);
        const phase = window.__getDayPhase(date);
        const night = phase === 'night';
        const e = window.__pondEngine;
        e.updateOptions({ dayLight: useBool ? (night ? 0 : 1) : dl, night });
        // ★ 每一档都要重新收敛一次，不能只靠开局的预热：
        //   换options 会触发 `landscape.lastDraw` 的 key 变化（tick/quality 等），
        //   GL 画面要重建 ⇒ 这一档的第一帧又不是稳态帧了。
        //   与其猜"要几帧"，不如**测到不动点为止**，并把实际帧数报出来。
        const c2 = e.ctx, W = e.width, H = e.height;
        const grab = () => Array.from(c2.getImageData(0, 0, W, H).data);
        e.render();
        let prev = grab(), settle = 0, d = 1;
        for (let i = 0; i < 40 && d !== 0; i++) {
          e.render();
          const now = grab();
          d = 0;
          for (let k = 0; k < now.length; k += 4) if (now[k] !== prev[k] || now[k + 1] !== prev[k + 1] || now[k + 2] !== prev[k + 2]) d++;
          prev = now; settle = i + 1;
        }
        return { dl, night, phase, settle };
      }, { hh: s.hh, mm: s.mm, useBool });
      maxSettle = Math.max(maxSettle, info.settle);
      // ★ 每档之间也让两个 rAF 过去：ResizeObserver 是异步的，
      //   截完上一档到截这一档之间，HUD/字体度量可能改变画布尺寸。
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      await page.waitForTimeout(60);
      const f = join(OUT, `${tag}-${String(s.i).padStart(2, '0')}.png`);
      await page.locator('canvas.pond-canvas').screenshot({ path: f });
      shots.push({ ...s, f, ...info });
    }
    console.log(`     ${tag} 组：各档收敛帧数 max=${maxSettle}（不设判据，机器相关）`);
    return shots;
  };

  section('① 截图 49 档 × 2 组（连续版 / 二值对照版）');
  const cont = await shoot('cont', false);
  const disc = await shoot('disc', true);
  ok(cont.length === 49 && disc.length === 49, '两组各 49 档全部截到', `${cont.length} / ${disc.length}`);

  // ⑤ 端点逐位一致的四张参照图（改动前口径 vs 改动后口径）
  const identCases = [
    ['id-night-bool', undefined, true],   // 改动前：只给 night:true
    ['id-night-cont', 0, true],           // 改动后：dayLight:0
    ['id-day-bool', undefined, false],    // 改动前：只给 night:false
    ['id-day-cont', 1, false],            // 改动后：dayLight:1
  ];
  for (const [name, dl, night] of identCases) {
    await page.evaluate(({ dl, night }) => {
      const e = window.__pondEngine;
      // ⚠️ `dayLight: undefined` 不是"没传"：`updateOptions` 的 spread 会把
      //    key 写成 undefined，而 `Number.isFinite(undefined) === false`
      //    ⇒ `daylightOf` 回退到 night 布尔。**这正是改动前的调用方式。**
      e.updateOptions({ dayLight: dl, night });
      e.render();
    }, { dl, night });
    await page.waitForTimeout(120);
    await page.locator('canvas.pond-canvas').screenshot({ path: join(OUT, `${name}.png`) });
  }
  ok(true, '⑤ 端点参照图 4 张已截（布尔口径 vs dayLight 口径）');

  // ⑦ 噪声底：同一档连截两张（间隔 400ms，跨过若干帧）
  await page.evaluate(() => {
    const e = window.__pondEngine;
    e.updateOptions({ dayLight: 0.5, night: false });
    e.render();
  });
  await page.waitForTimeout(120);
  await page.locator('canvas.pond-canvas').screenshot({ path: join(OUT, 'noise-a.png') });
  await page.waitForTimeout(400);
  await page.locator('canvas.pond-canvas').screenshot({ path: join(OUT, 'noise-b.png') });

  const listPath = join(OUT, '_list.json');
  fs.writeFileSync(listPath, JSON.stringify({ cont, disc, ident: identCases.map(([n]) => n) }));

  section('② 亮度曲线与相邻画面差');
  // ⚠️ Python 自己写 json、Node 读文件 —— 本沙箱 `execFileSync(...,{encoding:'utf8'})` 报 EBUSY。
  // ⚠️ 源码用数组 join('\n') 拼，里面**只写ASCII** —— 含引号的中文行极易把
  //    字符串提前闭合（记忆里踩过：`'... → \' + ...'` 把箭头落到引号外 ⇒ SyntaxError）。
  const script = join(OUT, '_day.py');
  const outPath = join(OUT, '_day.json');
  if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
  const py = [
    'import json, os, numpy as np',
    'from PIL import Image',
    'OUT = r\'' + OUT.replace(/\\/g, '/') + '\'',
    'D = json.load(open(os.path.join(OUT, \'_list.json\'), encoding=\'utf-8\'))',
    'def load(p):',
    '    return np.asarray(Image.open(p).convert(\'RGB\'), dtype=np.float32)',
    'def lum(a):',
    '    return float((0.2126*a[...,0] + 0.7152*a[...,1] + 0.0722*a[...,2]).mean())',
    'def diff(a, b, thr=2):',
    '    return float((np.abs(a-b).max(axis=2) > thr).mean() * 100)',
    'out = {}',
    'for tag in (\'cont\', \'disc\'):',
    '    rows = D[tag]',
    '    arrs = [load(r[\'f\']) for r in rows]',
    '    lums = [lum(a) for a in arrs]',
    '    seq = []',
    '    for k, r in enumerate(rows):',
    '        # step = 与上一档的**平均亮度**差（灰阶）——跳变量的正确量纲，见文件头',
    '        st = 0.0 if k == 0 else abs(lums[k] - lums[k-1])',
    '        seq.append({\'i\': r[\'i\'], \'hour\': r[\'hour\'], \'dl\': r[\'dl\'],',
    '                    \'night\': bool(r[\'night\']), \'phase\': r[\'phase\'],',
    '                    \'lum\': lums[k], \'step\': st,',
    '                    # pix 仅作诊断输出，不参与任何判据（见文件头）',
    '                    \'pix\': 0.0 if k == 0 else diff(arrs[k-1], arrs[k])})',
    '    out[tag] = seq',
    'ident = {}',
    'for name in D[\'ident\']:',
    '    a = load(os.path.join(OUT, name + \'.png\'))',
    '    ident[name] = {\'lum\': lum(a), \'f\': name}',
    '# 端点逐位一致：布尔口径 vs dayLight 口径，同night 值下比',
    'out[\'idNightDiff\'] = diff(load(os.path.join(OUT, \'id-night-bool.png\')),',
    '                             load(os.path.join(OUT, \'id-night-cont.png\')))',
    'out[\'idDayDiff\'] = diff(load(os.path.join(OUT, \'id-day-bool.png\')),',
    '                           load(os.path.join(OUT, \'id-day-cont.png\')))',
    'out[\'ident\'] = ident',
    '# 跨零自比：24:00 与 00:00 应逐像素相同',
    'out[\'wrapDiff\'] = diff(load(os.path.join(OUT, \'cont-48.png\')),',
    '                         load(os.path.join(OUT, \'cont-00.png\')))',
    'out[\'noise\'] = diff(load(os.path.join(OUT, \'noise-a.png\')),',
    '                     load(os.path.join(OUT, \'noise-b.png\')))',
    'json.dump(out, open(r\'' + outPath.replace(/\\/g, '/') + '\', \'w\', encoding=\'utf-8\'), ensure_ascii=False)',
  ].join('\n');
  fs.writeFileSync(script, py);
  execFileSync(PY, [script], { stdio: 'inherit' });
  const R = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  const C = R.cont, B = R.disc;
  const at = (seq, hour) => seq.find((r) => r.hour === hour);

  console.log('  时刻    dayLight night 相位      连续版亮度  单档步长   二值版亮度  单档步长');
  for (let k = 0; k < C.length; k++) {
    if (C[k].hour % 2 !== 0 && k !== C.length - 1) continue;
    const g = (h) => String(h).padStart(2, '0');
    console.log(`  ${g(C[k].hour)}:00${C[k].hour % 1 ? '30' : '  '}  ${C[k].dl.toFixed(3)}     `
      + `${C[k].night ? 'Y' : 'n'}    ${String(C[k].phase).padEnd(9)} ${C[k].lum.toFixed(2).padStart(8)}  ${C[k].step.toFixed(3).padStart(7)}   `
      + `${B[k].lum.toFixed(2).padStart(8)}  ${B[k].step.toFixed(3).padStart(7)}`);
  }
  console.log(`\n  过渡段单档亮度步长（灰阶）—— 判④的原始分布：`);
  // ★ 过渡段内的相邻对（门控恒定，只有幅度在变）。**不含门控翻转的两个时刻**。
  const smoothC = C.slice(1).filter((r) => r.hour >= SMOOTH_RANGE[0] && r.hour <= SMOOTH_RANGE[1]);
  const smoothB = B.slice(1).filter((r) => r.hour >= SMOOTH_RANGE[0] && r.hour <= SMOOTH_RANGE[1]);
  console.log(`    连续版: [${smoothC.map((r) => r.step.toFixed(2)).join(', ')}]`);
  console.log(`    二值版: [${smoothB.map((r) => r.step.toFixed(2)).join(', ')}]`);

  section('③ 判据');
  // 0 交叉校验：GATE_EDGES / SMOOTH_RANGE 是硬编码的，必须与真实 getDayPhase 对齐，
  //   否则量具会静默采错档（"我们以为的 05:00"其实实现里还是 night）。
  //   ⚠️ 判据用**页面读回的 phase** 而不是 isNightPhase 复算 —— 复算等于自己验自己。
  const edgePhaseOk = GATE_EDGES.every(([, b]) => at(C, b).night !== at(C, b - 0.5).night);
  ok(edgePhaseOk, '⓪ 门控翻转点确实落在 getDayPhase 的相位边界上',
    GATE_EDGES.map(([a, b]) => `${a}→${b}: night ${at(C, a).night ? 'Y' : 'n'}→${at(C, b).night ? 'Y' : 'n'}（phase ${at(C, a).phase}→${at(C, b).phase}）`).join('  '));
  const smoothNightOk = smoothC.every((r) => r.night === false);
  ok(smoothNightOk, '⓪ 过渡段内 night 恒为 false（该段只含幅度变化，不含门控）',
    `n=${smoothC.length}，night=true 的档数 ${smoothC.filter((r) => r.night).length}`);

  // ① 昼夜真的分开了吗（否则"连续"可能等于"什么都没变"）
  const deep = at(C, 3).lum, noon = at(C, 12).lum;
  ok(noon - deep >= SEP_MIN, '① 昼夜亮度真的分开（"连续"不等于"什么都没变"）',
    `深夜 03:00 ${deep.toFixed(2)} → 正午 12:00 ${noon.toFixed(2)}，差 ${(noon - deep).toFixed(2)} 灰阶（下限 ${SEP_MIN}）`);

  // ② 幅度层单调（门控恒定的过渡段内）
  // ⚠️ 两次都量「**反方向**的变化」：升段量下降、降段量上升。
  //   第一版把降段也写成 `前 - 后`，量到的其实是"下降量"（7.35），
  //   然后拿它去判"不回升" ⇒ 必然假红。同一个符号错误在
  //   tests/atmosphere.test.js 的 ambientMix 单调性断言里也犯过一次。
  const rise = C.filter((r) => r.hour >= SMOOTH_RANGE[0] && r.hour <= 12);
  const fall = C.filter((r) => r.hour >= 12 && r.hour <= SMOOTH_RANGE[1]);
  const worstRise = Math.max(...rise.slice(1).map((r, i) => rise[i].lum - r.lum));   // 升段量"下降"
  const worstFall = Math.max(...fall.slice(1).map((r, i) => r.lum - fall[i].lum));   // 降段量"上升"
  ok(worstRise <= MONO_TOL, '② 黎明→正午 亮度不回落（幅度层单调）',
    `最大回落 ${worstRise.toFixed(3)} 灰阶（容差 ${MONO_TOL}）· n=${rise.length - 1}`);
  ok(worstFall <= MONO_TOL, '② 正午→黄昏 亮度不回升（幅度层单调）',
    `最大回升 ${worstFall.toFixed(3)} 灰阶（容差 ${MONO_TOL}）· n=${fall.length - 1}`);

  // ③ 平台期画面逐像素相同 + 跨零自比
  // ⚠️ 19:00 那一档的 step/pix 跨了门控边（18:30→19:00），必须从平台统计里剔掉。
  const platformRows = [
    ...C.filter((r) => r.hour > 0 && r.hour <= 4.5),
    ...C.filter((r) => r.hour >= 19.5),
  ];
  const platformPix = platformRows.map((r) => r.pix);
  ok(Math.max(...platformPix) <= IDENTICAL_MAX, '③ 夜间平台（19:30–04:30）画面逐像素相同',
    `最大像素差 ${Math.max(...platformPix).toFixed(4)}%（阈值 ${IDENTICAL_MAX}%）· n=${platformPix.length}`);
  ok(Math.max(...platformRows.map((r) => r.step)) <= MONO_TOL, '③ 夜间平台亮度也逐档恒定',
    `最大单档亮度步长 ${Math.max(...platformRows.map((r) => r.step)).toFixed(4)} 灰阶`);
  ok(R.wrapDiff <= IDENTICAL_MAX, '③ 跨零自比：24:00 ≡ 00:00',
    `差 ${R.wrapDiff.toFixed(4)}%（两档 dayLight 同为 ${at(C, 0).dl}）`);

  // ④ 过渡段单档亮度步长：上限 + 钟形
  // ⚠️ 钟形必须**按升/降两半分开判**（第一版把整段当一个序列取首尾 ⇒ 假红）：
  //   实测分布 [0, 3.91, 7.35, 7.17, 3.50, 0×20, 3.50, 7.17, 7.35]
  //   —— 上升沿与下降沿**各自**是钟形，且两半严格对称（3.91/3.50、7.35/7.35、7.17/7.17）。
  //   整段取首尾的话，黄昏的峰值恰好落在末档（后面就是 0），比值恒等于 1。
  //   正确的不变量：**半段内峰值不在边缘，且边缘步长远小于峰值**。
  const steps = smoothC.map((r) => r.step);
  const peak = Math.max(...steps);
  ok(peak <= STEP_LUM_MAX, '④ 过渡段单档亮度变化平缓（无阶跃）',
    `峰值 ${peak.toFixed(2)} 灰阶（阈值 ${STEP_LUM_MAX}）· n=${steps.length}`);

  // 升/降两半：5.0→7.0 与 17.0→19.0（各含门控边那一档，因为它的"幅度步长"仍是曲线的真值）
  const halfRise = C.filter((r) => r.hour >= 5.0 && r.hour <= 7.0).map((r) => r.step);
  const halfFall = C.filter((r) => r.hour >= 17.0 && r.hour <= 19.0).map((r) => r.step);
  const bell = (arr) => {
    const p = Math.max(...arr);
    const inner = arr.slice(1, -1);
    return { p, edge: Math.max(arr[0], arr[arr.length - 1]), innerPeak: Math.max(...inner), innerMin: Math.min(...inner) };
  };
  const bR = bell(halfRise), bF = bell(halfFall);
  const bellOk = (b) => b.innerPeak >= b.edge * BELL_RATIO_MIN && b.innerPeak >= b.p * 0.99;
  ok(bellOk(bR) && bellOk(bF),
    '★ ④ 步长呈钟形：升/降两半各自的峰值都在内部、两端趋零（smoothstep 的一阶导指纹）',
    `升段 [${halfRise.map((s) => s.toFixed(2)).join(', ')}] 内部峰 ${bR.innerPeak.toFixed(2)} / 边缘 ${bR.edge.toFixed(2)}`
    + `　降段 [${halfFall.map((s) => s.toFixed(2)).join(', ')}] 内部峰 ${bF.innerPeak.toFixed(2)} / 边缘 ${bF.edge.toFixed(2)}`
    + `（比值下限 ${BELL_RATIO_MIN}×）`);
  console.log(`     参考：二值对照版同区间 [${smoothB.map((r) => r.step.toFixed(2)).join(', ')}]`
    + ` —— 峰值在**边缘**且中间全 0，正是阶跃形状（两个判据都会红）`);

  // ⑤ 两端与改动前逐位一致
  const idl = Object.fromEntries(Object.entries(R.ident).map(([k, v]) => [k, v.lum]));
  ok(R.idNightDiff <= IDENTICAL_MAX, '⑤ 夜端与改动前逐位一致（dayLight:0 ≡ 只给 night:true）',
    `差 ${R.idNightDiff.toFixed(4)}% · 亮度 ${idl['id-night-cont'].toFixed(3)} vs ${idl['id-night-bool'].toFixed(3)}`);
  ok(R.idDayDiff <= IDENTICAL_MAX, '⑤ 昼端与改动前逐位一致（dayLight:1 ≡ 只给 night:false）',
    `差 ${R.idDayDiff.toFixed(4)}% · 亮度 ${idl['id-day-cont'].toFixed(3)} vs ${idl['id-day-bool'].toFixed(3)}`);

  // ⑥ 单档最大亮度变化：连续版 vs 改动前
  const peakB = Math.max(...smoothB.map((r) => r.step));
  const ratio = peak / Math.max(peakB, 1e-6);
  ok(peakB / Math.max(peak, 1e-6) >= IMPROVE_MIN,
    '★ ⑥ 单档最大亮度变化：连续版明显小于改动前（二值对照版）',
    `连续 ${peak.toFixed(2)} vs 二值 ${peakB.toFixed(2)} 灰阶，改善 ×${(peakB / Math.max(peak, 1e-6)).toFixed(2)}（下限 ${IMPROVE_MIN}×）`);

  // ⑦ 噪声底
  ok(R.noise <= IDENTICAL_MAX, '⑦ 噪声底（同档连截两张，间隔 400ms）≈ 0', `${R.noise.toFixed(4)}%`);

  section('④ 页面异常');
  ok(errors.length === 0, '全程无页面异常', errors.slice(0, 3).join(' | '));

  console.log(`\n通过 ${pass} 项，未通过 ${fail} 项`);
  console.log(`截图目录：${OUT}`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
