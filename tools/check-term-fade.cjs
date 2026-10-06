/**
 * 底图节气口径 + **8s 交叉淡入**的验收。
 *
 * ★★★ 这个量具要防的是三件「参数对但画面不对」的事，按难度递增：
 *
 *  ① **口径错**：底图没按节气选（`bgSeason` 返回的不是 `TERM_SEASON[档位]`）。
 *     这条最容易犯，因为 `probe-terms` 只查 `TERM_VISUAL` 的输出，**完全不碰
 *     `landscape`** —— 物候全对而底图选错季节，24 档判据照样全绿。
 *
 *  ② **淡入是死代码**：`uFade` 恒等于 1（`fadeFrom` 永远是 null），
 *     或者反过来恒等于 0（画面永远停在旧图）。
 *     ★ **光断言「uFade 存在」会假绿** —— uniform 声明了不等于被写过。
 *     必须读回 `gl.getUniform(program, loc)` 的**实际 GPU 值**。
 *
 *  ③ **淡入非单调 / 时长不对**：进度不回 0（切档瞬间就在中途），
 *     或者 8s 走不完 / 0.5s 就走完。
 *     ★ 这里沿用荷花那次的教训：**判据要覆盖「维度」不只覆盖「状态」**。
 *     只断言"淡入发生了"太弱 —— 一个 1 帧的淡入也满足。必须采样时间轴。
 *
 * ⚠️ 为什么必须读 GPU 侧 uniform 而不是 JS 字段：
 *   `landscape.fadeFrom` / `fadeStart` 是**我们的意图**；
 *   uniform 里的是**GPU 真正拿到的**。两者不一致时（key 短路、
 *   activeTexture 残留、uniform 被优化掉）只有后者能暴露问题。
 *
 * 前置：dev server 在 5188。
 */
const PW = require('C:/Users/Y/.workbuddy/binaries/node/workspace/node_modules/playwright-core');
const { join } = require('node:path');
const fs = require('node:fs');

const ROOT = join(__dirname, '..');
const URL = process.env.TERM_URL || 'http://127.0.0.1:5188/';
const EXE = 'C:/Users/Y/AppData/Local/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-win64/chrome-headless-shell.exe';

/* 24 档里真正的**跨季边界**（TERM_SEASON 变化的那 4 处）。
 * 只有这些换底图 ⇒ 只有这些会淡入。同季内相邻节气共用一张图。 */
/* ★★★ 跨季边界**必须从 TERM_SEASON 推导，不能手写**（本轮抓到的量具数据 bug）。
 *
 * 起因：这份表里第二对写的是 `['白露','秋分','summer','autumn']` ——
 *   而按 `SOLAR_TERMS`/`TERM_SEASON` 的实际轴，白露(11) 和 秋分(12) **都是 autumn**，
 *   压根不是跨季边界；真正的第二个边界是 **大暑(8) → 立秋(9)**（summer → autumn）。
 *
 * 为什么一直没被发现：那张表里的 `fs_`/`ts_`（起点/终点季节名）是**手写的期望值**，
 * 而量具又只在「切档 + 采样」里读 `fadeFrom`。上一对的残留状态恰好让
 * `fadeFrom` 读成 `summer` ⇒ 断言通过。**一次只错一对，且被前一pair 掩盖。**
 *
 * ⇒ 下面的自检从数据源重算，**不等就立刻报错**（宁可量具红也不要假绿）。
 *   真正的四个边界：谷雨→立夏 / 大暑→立秋 / 霜降→立冬 / 大寒→立春。 */
const CROSS_SEASON = [
  ['谷雨', '立夏', 'spring', 'summer'],
  ['大暑', '立秋', 'summer', 'autumn'],
  ['霜降', '立冬', 'autumn', 'winter'],
  ['大寒', '立春', 'winter', 'spring'],
];
/* 同季内相邻（**不该**淡入 —— 底图是同一张，fade 恒为 1） */
const SAME_SEASON = [['立夏', '小满'], ['芒种', '夏至'], ['小暑', '大暑'], ['立春', '雨水']];

/* ★ 表 vs 数据源的自检。放最前面，跑量具第一件事就是它。
 * 失败信息必须直接给出「正确值是什么」，否则排查要回头翻 almanac.js。 */
{
  const { SOLAR_TERMS, TERM_SEASON } = require_('src/engine/almanac.js');
  const truth = [];
  for (let i = 0; i < 24; i++) {
    const n = (i + 1) % 24;
    if (TERM_SEASON[i] !== TERM_SEASON[n]) {
      truth.push([SOLAR_TERMS[i], SOLAR_TERMS[n], TERM_SEASON[i], TERM_SEASON[n]]);
    }
  }
  if (JSON.stringify(truth) !== JSON.stringify(CROSS_SEASON)) {
    console.error('\x1b[31m✘✘ CROSS_SEASON 表与 almanac 的 TERM_SEASON 不一致。\x1b[0m');
    console.error('  量具里的表：' + JSON.stringify(CROSS_SEASON));
    console.error('  实际应该是：' + JSON.stringify(truth));
    console.error('  ⇒ 从 almanac.js 重算后替换。写错的后果是「测的不是跨季」而判据照样全绿。');
    process.exit(1);
  }
}
/* CJS 里同步 import ESM 源文件的最小实现（almanac.js 是纯 ESM，无副作用）。 */
function require_(p) {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
  // 只取两个常量：SOLAR_TERMS 与 TERM_SEASON（都是 Object.freeze 的字面量数组）
  const grab = (name) => {
    const m = src.match(new RegExp('export const ' + name + ' = Object\\.freeze\\(\\[([\\s\\S]*?)\\]\\);'));
    if (!m) throw new Error('抓不到 ' + name);
    return m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
  };
  return { SOLAR_TERMS: grab('SOLAR_TERMS'), TERM_SEASON: grab('TERM_SEASON') };
}

let pass = 0, fail = 0;
const ok = (c, label, detail) => {
  const mark = c ? '\x1b[32m✔\x1b[0m' : '\x1b[31m✘\x1b[0m';
  if (c) pass++; else fail++;
  console.log(`  ${mark} ${label}${detail ? '  — ' + detail : ''}`);
};
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

(async () => {
  fs.mkdirSync(join(ROOT, 'out', 'term-fade'), { recursive: true });
  const browser = await PW.chromium.launch({ executablePath: EXE, args: ['--no-sandbox', '--use-gl=swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1380, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE ' + m.text()); });

  await page.goto(URL, { waitUntil: 'load', timeout: 60000 });
  await page.evaluate(() => {
    localStorage.setItem('fusheng-settings', JSON.stringify({
      season: 'summer', weather: 'sunny', day: 'day', night: false,
      fishCount: 10, fishSize: 1, turtleCount: 0,
      quality: 'high', reducedMotion: false, sound: false, volume: 0, ecoMode: false,
      almanacMode: 'manual', almanacTerm: '立夏',
    }));
  });
  await page.reload({ waitUntil: 'load', timeout: 60000 });
  try {
    await page.waitForSelector('canvas.pond-canvas', { timeout: 20000 });
  } catch (e) {
    /* ★ 排障第一步就把 pageerror 打出来。量具挂掉时只看到
     *   "waiting for locator(...) to be visible" 是最浪费时间的一种失败 ——
     *   真正的原因（页面白屏 / shader 编译失败被吞）在 console 里。 */
    console.error('\n\x1b[31m✘✘ 画布没出现。先看下面的 pageerror：\x1b[0m');
    errors.forEach((x) => console.error('  ' + x));
    const html = await page.content();
    console.error('  页面长度 ' + html.length + '，body 前 400 字：');
    console.error('  ' + html.slice(0, 400).replace(/\s+/g, ' '));
    await browser.close();
    process.exit(1);
  }
  await page.waitForFunction(() => {
    const e = window.__pondEngine;
    return !!(e && e.landscape && e.landscape.ready && e.landscape.season);
  }, { timeout: 20000 });
  /* ★ 等 4 张底图全部就绪。理由：8s 交叉淡入要求切档瞬间两张图都在显存里，
   * 而量具是「切档 + 立刻读 uFade」—— 只要有一张还在下载，读到的就是
   * 早退分支的 uFade=1，判据会以「淡入没生效」的形式假红。
   * 这不是量具将就：产品侧也靠构造时的预热来满足同一条件
   * （见 landscape.js 构造器里的预热注释），两边是同一个前提。 */
  await page.waitForFunction(() => {
    const t = window.__pondEngine?.landscape?.textures;
    return !!t && t.size >= 4;
  }, { timeout: 30000 });

  /* 把 uFade 的**真实 GPU 值**读出来的探针。
   * ⚠️ 必须走 gl.getUniform —— 读 JS 字段只能证明「我们想让它淡入」。 */

  /* ★★★★ 冻结 rAF 循环（2026-10-06 层③ 新增，此前踩了三次才补上）。
   *
   * 起因：`PondSimulation.update(delta)` 里有 `this.time += dt`，
   * 而 `update` 由页面的 **rAF 循环**每帧调用 ⇒ **`sim.time` 一直在被真实时钟推进**。
   * 量具写 `e.sim.time = 0` 只是「设了一个瞬时值」，下一次 rAF 立刻把它推走。
   *
   * 实测症状（一次只暴露一个，典型的「把环境噪声当成实现 bug」）：
   *   ① `__warmSlot` 要等真实下载（~1.2s）⇒ 这段时间 rAF 跑了 ~70 帧
   *      ⇒ 紧接着 `__toSlot(..., 0)` 时 fadeStart 被盖成 **9.05**
   *      ⇒ 4s 处进度算成 (4 - 9.05)/8 < 0 ⇒ 夹成 **0**（看着像「淡入没推进」）。
   *   ② 跨 `page.evaluate` 往返（实测一次 >8s）时淡入已被跑完 ⇒ uFade 全是 1。
   *   ③ 段与段之间上一段的淡入还挂在飞 ⇒ 下一段被判「已在淡入中」⇒ 全红。
   * 三次同一个根因：**量具没有接管时钟，就等于在跟真实时间赛跑。**
   *
   * 正解：把 `requestAnimationFrame` 换成空实现。
   * ⚠️ `cancelAnimationFrame` **不够** —— 已排队的回调仍会执行一次。
   * ⚠️ 必须成对恢复：只冻不解会让页面在后续量具里一直静止；
   *   本文件在 ⑨ 段（判「无报错」**之前**，否则冻结期内的异常会被漏判）恢复。 */
  await page.evaluate(() => {
    if (!window.__rafOrig) {
      window.__rafOrig = window.requestAnimationFrame.bind(window);
      window.__rafFrozen = false;
    }
    window.__rafFrozen = true;
    window.requestAnimationFrame = () => 0;          // 不再排新帧
  });
  const unfreeze = () => page.evaluate(() => {
    if (!window.__rafFrozen) return;
    window.__rafFrozen = false;
    window.requestAnimationFrame = window.__rafOrig;
    window.__rafOrig(() => {});   // 立刻补一帧，画面回到正常状态
  });

  await page.evaluate(() => {
    window.__fade = () => {
      const e = window.__pondEngine, L = e.landscape, gl = L.gl;
      return {
        season: L.season,
        /* ★ 层③：slot 是「一张具体的图」的标识，与 season（季节名）是两个概念。
         * 补了中间档图之后同一季节会有两张图 —— 所有判据都必须看 slot。 */
        slot: L.slot,
        shownSeason: L.shownSeason,
        fadeFrom: L.fadeFrom,
        fadeStart: L.fadeStart,
        /* ★ GPU 侧实读。三个量缺一不可：
         *   uFade 是系数；uImage/uImageB 是两张纹理的**对象身份**，
         *   用 isTexture 判定即可（无需真去读像素）。 */
        uFade: gl.getUniform(L.program, L.uniforms.uFade),
        uImageIsTex: gl.getUniform(L.program, L.uniforms.uImage) !== null,
        uImageBIsTex: gl.getUniform(L.program, L.uniforms.uImageB) !== null,
        simTime: e.sim.time,
        ready: !!L.ready,
        hasUniforms: !!L.uniforms,
        opacity: document.querySelector('canvas.living-background')?.style.opacity,
      };
    };
    /* ★★★ 切档必须**只**改 options 并手动 render，不能走 React 的 almanac 状态。
     *
     * 踩过的坑（第一版量具 19 条假红）：用
     *   `e.updateOptions({...e.options, solarTerm: term})` 切档，
     *   结果读出来 `landscape.season` 全是 summer/spring 错位。
     * 根因是**双写**：`App.jsx` 的 `useEnvironment` 也在按 localStorage 里的
     * `almanacTerm` 算 `solarTerm`，任何一次 React 重渲染都会把我们的值覆盖回去
     * ⇒ 底图选的是"React 以为的档"，而 tint 走的是同一份 options，
     *   两边一起错位，量具读到的是混合态。
     * 正解：只写 `e.options.solarTerm`（引擎的数据源）+ 清 `lastDraw` 强制重画。
     * 引擎的 `render()` 每帧从 `this.options` 取，**不依赖 React**，
     * 所以这是最短路径且不与 UI 打架。
     * ⚠️ 不改 localStorage：那是 React 的输入，改了会引发重渲染。 */
    /* ★ 只推进时间、**不重新切档** —— 用来在同一次淡入里采样时间轴。
     * 第一版把「切档」和「推进时间」混在 __toTerm 里，每次调用都重新触发
     * 一次切档 ⇒ fadeStart 被刷成当前 time ⇒ 每个采样点都是"刚起步"那一帧。
     * 这与荷花那次「判据要覆盖维度」同源：**「状态切换」与「状态演进」必须是
     * 两次独立操作**，否则量具测的是切换动作，不是演进过程。 */
    window.__advance = (simTime) => {
      const e = window.__pondEngine;
      e.sim.time = simTime;
      e.landscape.lastDraw = null;
      e.render();
      return window.__fade();
    };
    window.__toTerm = (term, simTime) => {
      const e = window.__pondEngine;
      e.options = { ...e.options, solarTerm: term, paused: false, reducedMotion: false };
      e.sim.updateOptions({ solarTerm: term, paused: false, reducedMotion: false });
      if (simTime !== undefined) e.sim.time = simTime;
      e.landscape.lastDraw = null;   // 绕过 key 短路，强制真的画一帧
      e.render();
      return window.__fade();
    };
    /* ★★★ 层③ 专用：切到**指定槽位**而不是指定节气。
     *
     * 用途：验证「8s 淡入的门是**槽位**，不是季节」——
     * 而这件事在只有 4 张图的现状下**无法用节气测出来**
     * （同季 6 档共用一张图 ⇒ from===to ⇒ 永远不淡入）。
     * 所以这里直接换掉 `bgSlot` 的返回值，模拟「manifest 里多了一条中间档图」。
     *
     * ★ 做法刻意选「假槽位指向**同一张**图片文件」：
     *   这样画面内容不变（像素差≈0，天然排除「差异来自图变了」的解释），
     *   唯一的变量就是槽位 id ⇒ 若淡入仍然发生，就只能是槽位在起作用。
     *   ⚠️ 反过来说，这也意味着它**不能**证明新图会被正确加载 ——
     *   那是另一条判据（看 slot 切换后 uImage/uImageB 指向不同纹理对象）。 */
    window.__toSlot = (slotId, file, simTime) => {
      const e = window.__pondEngine, L = e.landscape;
      if (!L.__origBgSlot) L.__origBgSlot = L.bgSlot.bind(L);
      L.bgSlot = () => ({ id: slotId, file, v: '1.5', terms: [], source: 'term' });
      if (simTime !== undefined) e.sim.time = simTime;
      L.lastDraw = null;
      e.render();
      return window.__fade();
    };
    /* ★★★ 热身：把假槽位的**纹理先建出来**，再谈淡入。
     *
     * 起因是量具自己踩了层①修过的那个死锁：`texture()` 是「懒两步」，
     * 第一次调用只发 `img.src` 并返回 null ⇒ `render()` 在
     * `if(!texture) return` 处早退 ⇒ **`this.slot=slot` 那行根本没执行**。
     * 于是量具读到的是「slot 还是上一个」+「淡入根本没起算」，
     * 看起来像实现的门挂错了，其实是**图还没下完**。
     *
     * ⚠️ 这类「量具把『资源没就绪』误读成『逻辑不对』」的错误，
     *   判据上无法自证（读到的值都是真的）—— 只能靠**排障输出**发现。
     *   所以上面 waitForFunction(纹理数≥4) 那一步是硬前提，不是可选项。 */
    window.__warmSlot = async (slotId, file) => {
      const L = window.__pondEngine.landscape;
      /* ★★★ 这里**绝不能**先装 bgSlot 替身再热身 —— 那会让 `img.onload`
       * 里的 `this.onLoad?.()`（= pond.js 的 render）**顺带起算一次淡入**：
       *   那一刻 slot 已是替身给的假槽位，而 sim.time 还是上一次 settle 的 9
       *   ⇒ fadeStart 被盖成 9、`fadeFrom` 指向真槽位
       *   ⇒ 紧接着 `__toSlot(..., 0)` 走进「已在淡入：只看进度」分支
       *   ⇒ (0 - 9)/8 夹成 0 ⇒ **看起来像「淡入不推进」**。
       *
       * 实现是对的（`onload` 里那一帧确实该按当时的 slot 画），
       * 错的是量具：它想「只加载不渲染」，却没阻止 onload 触发渲染。
       * ⇒ 解法是**不装替身**，直接调 texture() 把资源建出来。
       *
       * ⚠️ 这是本轮第三次「量具自身污染状态」了（前两次：跨 evaluate 采样、
       *   段间未 settle）。共同教训：**凡是想「只做副作用、不触发渲染」，
       *   就不能借用那条会顺带渲染的路径。** */
      L.texture(slotId, file);               // 第一次：只发请求
      const t0 = Date.now();
      while (!L.textures.has(slotId)) {
        if (Date.now() - t0 > 15000) throw new Error(`槽位 ${slotId} 的纹理 15s 内没建出来（素材 assets/${file}.png 是不是不存在？）`);
        await new Promise((r) => setTimeout(r, 120));
      }
      return { slot: slotId, tex: true, mask: !!L.waterMasks.get(slotId) };
    };
    /* 撤除替身，并把注入期间攒下的状态**清干净**。
     * ★ 必须清：假槽位在测试中途被换掉时，shownSeason/fadeFrom 可能指着
     *   一个已经不存在的槽位 ⇒ 下一段真实切档会被判成「已在淡入中」
     *   ⇒ 整段都不起算（实测 ③ 的第一对因此全红）。 */
    window.__restoreBgSlot = () => {
      const L = window.__pondEngine.landscape;
      if (L.__origBgSlot) { L.bgSlot = L.__origBgSlot; L.__origBgSlot = null; }
      L.fadeFrom = null; L.shownSeason = null; L.lastDraw = null;
      return window.__fade();
    };
    /* 读回真实槽位（不被 __toSlot 的替身影响）—— 用于「确实换了槽位」的断言。
   * ⚠️ options 取 **`__pondEngine.options`**（引擎的那份），不是 `landscape.options` ——
   *   `Landscape` 上根本没有 `.options`（它只从 render(time, options, hand) 的形参拿），
   *   传 undefined 进去会静默走 resolveTermImage 的 fallback ⇒ 恒返回 manifest 首条（spring）。
   *   这是本轮量具自己踩的坑：读出来的值都是真的，但读的是**错的那个对象**。 */
    window.__realSlot = () => {
      const e = window.__pondEngine, L = e.landscape;
      return L.__origBgSlot ? L.__origBgSlot(e.options).id : L.slot;
    };
    /* ★ 落稳到某档：切过去之后**把淡入走完**，让 shownSeason 真的等于目标槽位。
   * 不做这一步的代价很具体：上一段 `立春→雨水` 的淡入还挂在飞，
   * `shownSeason` 仍是 spring ⇒ 下一段切档被判成「从 spring 淡入」而不是
   * 「从 summer 淡入」⇒ 断言全红，而实现完全正确。
   * ⇒ 任何跨段的状态机测试，段与段之间都要有「归位 + 走完」的动作。 */
    window.__settle = (term, simTime = 9) => {
      window.__toTerm(term, 0);
      window.__advance(simTime);          // 走完 8s 淡入
      return window.__fade();
    };
  });

  // ─────────────────────────────────────────────────────────────
  section('⓪ GPU 真的在跑（判据全部有效的前提）');
  const gpu = await page.evaluate(() => window.__fade());
  ok(gpu.ready && gpu.hasUniforms && gpu.opacity !== '0', 'WebGL 底图在渲染',
    `ready=${gpu.ready} uniforms=${gpu.hasUniforms} opacity=${gpu.opacity}`);
  ok(gpu.uImageIsTex && gpu.uImageBIsTex, 'uImage / uImageB 都拿到了纹理单元 1 的绑定',
    `uImage=${gpu.uImageIsTex} uImageB=${gpu.uImageBIsTex}`);
  ok(gpu.uFade === 1, '静止态 uFade 恰为 1（不是 0 —— 那会永远显示上一季）',
    `uFade=${gpu.uFade}`);

  // ─────────────────────────────────────────────────────────────
  section('① 底图槽位按节气选（不是按月份/天气）');
  const slotRows = [];
  for (const term of ['春分', '立夏', '芒种', '白露', '霜降', '大雪', '大寒', '立春', '雨水']) {
    const r = await page.evaluate((t) => window.__toTerm(t), term);
    /* ★ 读 slot 而不是 season —— 层③ 之后这两者会分叉
     * （补了中间档图，「小满」仍是 summer 但有自己的槽位）。 */
    slotRows.push([term, r.slot]);
  }
  const EXPECT = {
    春分: 'spring', 雨水: 'spring', 立春: 'spring',
    立夏: 'summer', 芒种: 'summer',
    白露: 'autumn', 霜降: 'autumn',
    大雪: 'winter', 大寒: 'winter',
  };
  const slotOk = slotRows.every(([t, s]) => EXPECT[t] === s);
  ok(slotOk, '9 档的底图槽位与 TERM_SEASON 一致（层③ 现状：四季各一张）',
    slotRows.map(([t, s]) => `${t}=${s}`).join(' '));
  /* ★ 前置自检：确认切档真的生效了。
   * 第一版量具在这里 19 条假红，根因是 React 与引擎**双写 solarTerm** ——
   * 若哪天切档又失效（读到的是上一档），上面那条会以「全错位」的形式
   * 报出来，但看不出是量具坏了还是实现坏了。这一条把两种情况分开。 */
  const echo = await page.evaluate(() => {
    const e = window.__pondEngine;
    const seen = [];
    for (const t of ['春分', '立夏', '大雪', '立春']) {
      window.__toTerm(t);
      seen.push([e.options.solarTerm, e.landscape.slot]);
    }
    return seen;
  });
  const echoOk = echo.every(([opt, got], i) =>
    opt === ['春分', '立夏', '大雪', '立春'][i]
    && got === ['spring', 'summer', 'winter', 'spring'][i]);
  ok(echoOk, '切档自检：options.solarTerm 与底图槽位逐档一致（量具自身没坏）',
    echo.map(([o, g]) => `${o}→${g}`).join(' '));
  ok(!slotRows.some(([, s]) => s === null || s === undefined), '没有档位选不出底图（兜底链有效）');
  const seasonSlotAgree = await page.evaluate(() => {
    const e = window.__pondEngine;
    window.__toTerm('芒种');
    return [e.landscape.season, e.landscape.slot];
  });
  ok(seasonSlotAgree[0] === 'summer' && seasonSlotAgree[1] === 'summer',
    'layer③ 双字段都在维护：season（季节名，给人看）与 slot（槽位，给索引）',
    `season=${seasonSlotAgree[0]} slot=${seasonSlotAgree[1]}`);

  // ─────────────────────────────────────────────────────────────
  section('② 同季内相邻节气**不**淡入（底图是同一张，淡入=白做）');
  for (const [from, to] of SAME_SEASON) {
    const b = await page.evaluate(([f, t]) => {
      window.__toTerm(f, 0);
      return window.__toTerm(t, 100);
    }, [from, to]);
    ok(b.fadeFrom === null && b.uFade === 1, `${from} → ${to} 无淡入（同槽位）`,
      `fadeFrom=${b.fadeFrom} uFade=${b.uFade}`);
  }

  /* ★★★ 层③ 的核心判据：淡入的门必须是**槽位**，不是季节。
   *
   * 现状（4 张图）下这个区别**测不出来**：同季 6 档共用一张图，
   * 于是「同季换档」与「同图换档」是同一件事，
   * 用季节还是用槽位判，结果完全一样 ⇒ 量具全绿也证明不了任何事。
   * 而层② 一旦补上中间档图（清明有自己的图），
   * 「小满 → 芒种」就是**同季节、不同图**，此时若门还挂在季节上，
   * 8s 淡入会**静默失效**（from===to ⇒ 直接 uFade=1）——
   * 而且 §② 那 4 条断言照样全绿，因为它们测的确实是同一张图。
   *
   * 做法：把 `bgSlot` 的返回值换成「指向同一张图片文件的假槽位」。
   * 于是**画面内容逐位不变**（像素差≈0），唯一变量是槽位 id。
   * 若淡入仍然发生 ⇒ 只能是槽位在起作用。
   * ⚠️ 这条测不出「新图能否被正确加载」—— 那是下面 ② 之二 的职责。 */
  section('② 之二 换槽位（同一张图）也要淡入 —— 证明门是槽位而非季节');
  const slotGate = await page.evaluate(async () => {
    // ★ 先「落稳」到 summer：切过去 + 走完淡入，让 shownSeason 真的等于 summer。
    //   否则本段的起点会被上一段未完成的淡入污染（shownSeason 停在 spring）。
    const base = window.__settle('芒种');
    await window.__warmSlot('midterm-xiaoman', 'pond');   // 先把纹理建出来
    window.__toSlot('midterm-xiaoman', 'pond', 0);
    const at0 = window.__fade();
    const mid = window.__advance(4);
    window.__advance(9);                 // 走完淡入，避免下一段被判「已在淡入」
    window.__restoreBgSlot();
    window.__settle('芒种');             // 归位并落稳
    return { base, at0, mid };
  });
  ok(slotGate.base.slot === 'summer' && slotGate.base.season === 'summer',
    '前置：当前真实槽位是 summer', `slot=${slotGate.base.slot}`);
  ok(slotGate.at0.slot === 'midterm-xiaoman' && slotGate.at0.season === 'summer',
    '假槽位生效：slot 变了而 season 没变（同季节换图）',
    `slot=${slotGate.at0.slot} season=${slotGate.at0.season}`);
  ok(slotGate.at0.fadeFrom === 'summer' && Math.abs(slotGate.at0.uFade) < 1e-6,
    '★ 同季节换槽位，淡入照样从 0 起算 —— 这正是层②补图能用上淡入的前提',
    `fadeFrom=${slotGate.at0.fadeFrom} uFade=${slotGate.at0.uFade}`);
  ok(Math.abs(slotGate.mid.uFade - 0.5) < 1e-3,
    '4s 处进度恰为 0.5（与跨季淡入同一套时基）',
    `uFade=${slotGate.mid.uFade} fadeFrom=${slotGate.mid.fadeFrom} `
    + `fadeStart=${slotGate.mid.fadeStart} simTime=${slotGate.mid.simTime} `
    + `slot=${slotGate.mid.slot} shown=${slotGate.mid.shownSeason} `
    + `| at0: fadeStart=${slotGate.at0.fadeStart} simTime=${slotGate.at0.simTime} `
    + `shown=${slotGate.at0.shownSeason} | base: shown=${slotGate.base.shownSeason} `
    + `fadeStart=${slotGate.base.fadeStart}`);

  /* ★★★ 第二问：新槽位指向**另一张**图时，纹理与掩膜确实换过去了。
   * 上一段刻意用同一张文件，排除了「图变了」的解释，也就**测不出**加载。
   * 这里用真实的另一张图（autumn.png），查三处缓存：
   *   textures / images / waterMasks 都必须出现新槽位的条目。
   * ⚠️ 掩膜这条最要紧：`waterAt()` 是雨圈落点的唯一依据，
   *   错按季节取会拿到**另一张图的水陆形状** ⇒ 雨圈落在不该落的地方，
   *   **且不报任何错**（没有异常、没有 console、像素量具也不看这个）。 */
  section('② 之三 新槽位指向另一张图：纹理与水区掩膜都换过去');
  const swap = await page.evaluate(async () => {
    const e = window.__pondEngine, L = e.landscape;
    window.__settle('芒种');                   // ★ 落稳（上一段淡入已走完）
    const beforeTex = L.textures.get(L.slot);
    const beforeMaskSum = (() => {
      const m = L.waterMasks.get(L.slot);
      if (!m) return -1;
      let s = 0; for (let i = 0; i < m.length; i++) s += m[i];
      return s;
    })();
    // 换到指向 autumn.png 的新槽位（先热身，等纹理真的建出来）
    await window.__warmSlot('midterm-qingming', 'autumn');
    window.__toSlot('midterm-qingming', 'autumn', 0);
    const afterTex = L.textures.get('midterm-qingming');
    let afterMaskSum = -1;
    const m2 = L.waterMasks.get('midterm-qingming');
    if (m2) { let s = 0; for (let i = 0; i < m2.length; i++) s += m2[i]; afterMaskSum = s; }
    const realSlot = window.__realSlot();
    window.__restoreBgSlot();
    window.__settle('芒种');
    return {
      realSlot, beforeTex, afterTex,
      beforeMaskSum, afterMaskSum,
      maskKeys: [...L.waterMasks.keys()],
      texKeys: [...L.textures.keys()],
    };
  });
  ok(swap.realSlot === 'summer', '替身已撤除，真实槽位仍是 summer', `slot=${swap.realSlot}`);
  ok(!!swap.afterTex && swap.afterTex !== swap.beforeTex,
    '新槽位拿到了**不同的纹理对象**（确实换了图，不是同一张被复用）',
    `before=${!!swap.beforeTex} after=${!!swap.afterTex} same=${swap.afterTex === swap.beforeTex}`);
  ok(swap.texKeys.includes('midterm-qingming') && swap.texKeys.includes('summer'),
    'textures 里两个槽位并存（没被顶掉）', `keys=${swap.texKeys.join(',')}`);
  ok(swap.maskKeys.includes('midterm-qingming') && swap.maskKeys.includes('summer'),
    'waterMasks 按槽位并存（★ 若只按 season 存，这里会只剩 4 个键、且 rain 落点会错）',
    `keys=${swap.maskKeys.join(',')}`);
  ok(swap.afterMaskSum !== swap.beforeMaskSum,
    '两张图的水区掩膜确实不同（内容层面证明掩膜跟着图走，不是同一份）',
    `summer=${swap.beforeMaskSum} midterm=${swap.afterMaskSum}`);

  // ─────────────────────────────────────────────────────────────
  section('③ 跨季时 8s 交叉淡入：时间轴采样（判据覆盖「维度」不只「状态」）');
  const timeline = [];
  for (const [from, to, fs_, ts_] of CROSS_SEASON) {
    // 先落到 from 档（此时 season 已等于 fs_）—— 与采样同在一次 evaluate 内，
    // 否则「切到 from」和「切到 to」之间也会被 rAF 推进时间。
    const before = await page.evaluate((t) => window.__toTerm(t, 0), from);
    // 切到 to 档，并把 sim.time 钉在 fade 起点（0）
    /* ★ 切档**只做一次**（t=0 那一帧），之后只推进 sim.time。
     * 第一版把「切档」和「推进时间」混在 __toTerm 里，每次调用都重新触发
     * 一次切档 ⇒ fadeStart 被刷成当前 time ⇒ 采样到的全是「刚起步」那一帧，
     * 于是 12 个采样点里除第一个外全是 uFade=1。
     * 这与荷花那次「判据覆盖维度」同源：**要把「状态切换」和「状态演进」分成
     * 两次操作**，否则量具测的是切换动作本身，不是演进过程。 */
    /* ★★★ 整条时间轴必须在**一次** evaluate 里采完。
     * 踩过的坑：每个采样点一次 `page.evaluate`，而两次调用之间页面的
     * rAF 循环仍在跑 —— `sim.time` 被真实时钟推进（实测一次往返就 >8s）
     * ⇒ 第二个采样点读到的淡入早已结束，uFade 全是 1。
     * 这与「单测里冻结时钟、真窗口里节流 rAF」是同一类问题的两面：
     * **只要采样跨了事件循环，就必须自己接管时钟**。
     * 正解：一次进入、同步跑完 8 个点，中途不让出。 */
    const samples = await page.evaluate(([f, t, ats]) => {
      /* ★★★ 段与段之间必须「落稳」，否则**上一段未完成的淡入会污染下一段**。
       *
       * 实测症状（本轮新增，58/63 时的 ③ 首对全红）：
       *   ② 之三结束时调了 `__restoreBgSlot()`，它把 `shownSeason` 清成 null；
       *   而这里第一句 `__toTerm(f, 0)` 只切档**不**走完淡入
       *   ⇒ 谷雨 那一步的起点是 null ⇒ 状态机走「无淡入」分支
       *   ⇒ `fadeFrom` 保持 null、`uFade` 恒 1（判据读到的值都是真的，
       *   但测的是「没起算」而不是「起算得不对」）。
       *
       * ⇒ `__settle` = 切档 + `__advance(9)`（>8s，保证淡入走完）。
       *   这条对**所有**跨段的状态机测试都成立，不只是这一处。 */
      window.__settle(f);
      const out = [{ at: 0, ...window.__toTerm(t, 0) }];
      for (const at of ats) out.push({ at, ...window.__advance(at) });
      return out;
    }, [from, to, [1, 2, 4, 6, 7.99, 8, 12]]);
    timeline.push({ from, to, fs_, ts_, before, samples });
  }

  for (const row of timeline) {
    const { from, to, fs_, ts_, samples } = row;
    const start = samples[0], end = samples[samples.length - 1];
    ok(start.fadeFrom === fs_, `${from}→${to}：切档瞬间 fadeFrom 是旧季（淡入真从 0 开始）`,
      `fadeFrom=${start.fadeFrom} 期望=${fs_}`);
    ok(Math.abs(start.uFade) < 1e-6, `${from}→${to}：t=0 时 uFade=0（回退起点，不是从中途开始）`,
      `uFade=${start.uFade}`);
    ok(Math.abs(end.uFade - 1) < 1e-6, `${from}→${to}：t=12s 时 uFade=1（8s 走完了）`,
      `uFade=${end.uFade}`);
  }

  section('④ 淡入时长 = 8s（中间点必须在 0<progress<1，且 8s 前未完成）');
  for (const row of timeline) {
    const { from, to, samples } = row;
    const at = (t) => samples.find((s) => s.at === t);
    const exp = (t) => t / 8;
    const mid = [1, 2, 4, 6].map((t) => [t, at(t).uFade, exp(t)]);
    /* ★ 逐点比对期望值而不只是「在 0 和 1 之间」——
     *   只判区间的话，一个「1s 就淡完」的假淡入也能过。 */
    const allMatch = mid.every(([, got, want]) => Math.abs(got - want) < 1e-3);
    ok(allMatch, `${from}→${to}：4 个中间点都等于 t/8`,
      mid.map(([t, g, w]) => `${t}s:${g.toFixed(3)}(期望${w.toFixed(3)})`).join(' '));
    ok(Math.abs(at(7.99).uFade - 0.99875) < 1e-3, `${from}→${to}：7.99s 仍未完成（真的按秒走，不是 1 帧闪完）`,
      `uFade=${at(7.99).uFade}`);
    ok(at(8).uFade === 1 && at(8).fadeFrom === null, `${from}→${to}：8.00s 整恰好收尾并清空 fadeFrom`,
      `uFade=${at(8).uFade} fadeFrom=${at(8).fadeFrom}`);
  }

  section('⑤ 淡入单调递增（不能来回抖）');
  for (const row of timeline) {
    const v = row.samples.map((s) => s.uFade);
    const mono = v.every((x, i) => i === 0 || x >= v[i - 1] - 1e-9);
    ok(mono, `${row.from}→${row.to}：uFade 单调不减`, v.map((x) => x.toFixed(2)).join(' → '));
  }

  // ─────────────────────────────────────────────────────────────
  section('⑥ paused / reducedMotion 落终态（否则暂停时切节气会永远卡在旧图）');
  for (const [from, to, , ts_] of CROSS_SEASON) {
    const r = await page.evaluate(([f, t]) => {
      const e = window.__pondEngine;
      window.__toTerm(f);
      window.__toTerm(t, 0);          // 先真的开始淡入（t=0 ⇒ uFade=0）
      e.options = { ...e.options, paused: true }; e.landscape.lastDraw = null; e.render();
      const a = window.__fade();
      e.options = { ...e.options, paused: false, reducedMotion: true };
      e.landscape.lastDraw = null; e.render();
      const b = window.__fade();
      return { paused: a, reduced: b };
    }, [from, to]);
    ok(r.paused.uFade === 1 && r.paused.season === ts_, `${from}→${to}：paused 时直接落 ${ts_}`,
      `season=${r.paused.season} uFade=${r.paused.uFade}`);
    ok(r.reduced.uFade === 1 && r.reduced.season === ts_, `${from}→${to}：reducedMotion 时直接落 ${ts_}`,
      `season=${r.reduced.season} uFade=${r.reduced.uFade}`);
  }

  // ─────────────────────────────────────────────────────────────
  section('⑦ 反证：注入一个「卡在中间」的 uFade，④ 的逐点判据必须转红');
  /* ★★★ 双向验证：不注入反例就不知道判据是不是恒绿。
   * ⚠️ 归位要**两步并走完中间的淡入**：`__toTerm('大寒')` 只起算，
   *   shownSeason 还停在 summer；紧接着 `__toTerm('立春')` 因为
   *   shownSeason≠立春 且 fadeFrom 仍指着 summer 而被判成「已在淡入」
   *   ⇒ 根本不重新起算 ⇒ 读到 uFade=1。
   *   这是状态机带来的必然约束：**一次只能有一段淡入在飞**。
   * 做法：把 GPU 侧 uFade 强行钉成 0.5，再拿 ④ 的判据去比 ——
   *   2s 处的期望值是 0.25，注入值 0.5 ⇒ 必须判「不相等」。
   * ⚠️ 起算与推进必须在**同一次 evaluate** 内完成（与 ③ 段同一个坑）：
   *   跨 evaluate 时页面 rAF 会把 sim.time 推走（实测一次往返 >8s），
   *   fadeStart 记的是被推走后的时刻 ⇒ 进度整体偏移，读到的不是 0.25。
   * ⚠️ 注入后要把 lastDraw 打成不可能命中的样子，否则下一帧重画会覆盖掉。 */
  const inj = await page.evaluate(() => {
    const e = window.__pondEngine, L = e.landscape, gl = L.gl;
    /* ★ 先归位到 summer。上一段（同季换档测试）结束时 shownSeason 已是 summer，
     * 若直接切大寒就不会起算（shownSeason===season ⇒ idle 分支）⇒ fadeFrom=null。
     * 每次反证都要一个**真的换过图**的起点。 */
    window.__toTerm('夏至', 0);
    window.__toTerm('大寒', 0);
    window.__advance(9);                       // ★ 走完上一次的淡入
    const r0 = window.__toTerm('立春', 0);      // 起算帧
    const at0 = gl.getUniform(L.program, L.uniforms.uFade);
    window.__advance(4);
    const at4 = gl.getUniform(L.program, L.uniforms.uFade);
    gl.uniform1f(L.uniforms.uFade, 0.5);        // 注入：假装卡在中间
    const injected = gl.getUniform(L.program, L.uniforms.uFade);
    L.lastDraw = { tick: -1, key: 'INJECTED' };  // 防下一帧被重画覆盖
    return { at0, fadeFromAt0: r0.fadeFrom, at4, injected,
             afterFrame: gl.getUniform(L.program, L.uniforms.uFade) };
  });
  ok(Math.abs(inj.at0) < 1e-6 && inj.fadeFromAt0 === 'winter',
    '反证前置：起算帧 uFade=0 且 fadeFrom=winter', `uFade=${inj.at0} fadeFrom=${inj.fadeFromAt0}`);
  ok(Math.abs(inj.at4 - 0.5) < 1e-3, '反证前置：4s 处诚实值就是 0.5', `honest=${inj.at4}`);
  ok(inj.injected === 0.5 && inj.afterFrame === 0.5,
    '注入的 0.5 确实进了 GPU 且未被重画覆盖',
    `injected=${inj.injected} afterFrame=${inj.afterFrame}`);

  /* 4s 处的期望值恰好就是 0.5 ⇒ 拿它比不出一致，必须用 2s（期望 0.25）。 */
  const inj2 = await page.evaluate(() => {
    const e = window.__pondEngine, L = e.landscape, gl = L.gl;
    window.__toTerm('夏至', 0);
    window.__toTerm('大寒', 0);
    window.__advance(9);                       // ★ 同上：先把上一次的淡入走完
    window.__toTerm('立春', 0);
    window.__advance(2);
    const honest = gl.getUniform(L.program, L.uniforms.uFade);   // 期望 0.25
    gl.uniform1f(L.uniforms.uFade, 0.5);
    L.lastDraw = { tick: -1, key: 'INJECTED2' };
    return { honest, injected: gl.getUniform(L.program, L.uniforms.uFade), expect: 2 / 8 };
  });
  ok(Math.abs(inj2.honest - 0.25) < 1e-3, '2s 处诚实值 = 0.25（判据基准本身是对的）',
    `honest=${inj2.honest}`);
  ok(Math.abs(inj2.injected - inj2.expect) > 1e-3,
    '注入 0.5 后 ④ 的逐点判据会转红（期望 0.25，实得 0.5）—— 判据不是恒绿',
    `期望 ${inj2.expect} vs 注入 ${inj2.injected}`);

  section('⑧ 收尾状态干净（回到某档后不留残影）');
  const fin = await page.evaluate(() => {
    window.__toTerm('夏至', 30);
    window.__toTerm('大暑', 60);     // 同季，不淡入
    const e = window.__pondEngine, L = e.landscape, gl = L.gl;
    void e;
    return { season: L.season, fadeFrom: L.fadeFrom, uFade: gl.getUniform(L.program, L.uniforms.uFade) };
  });
  ok(fin.season === 'summer' && fin.fadeFrom === null && fin.uFade === 1,
    '同季换档后 fadeFrom 已清空、uFade=1', `season=${fin.season} fadeFrom=${fin.fadeFrom} uFade=${fin.uFade}`);

  // ─────────────────────────────────────────────────────────────
  section('⑨ 无运行时报错');
  /* ★ rAF 是**解冻**在判「无报错」之前：冻结期间若有异常被吞掉，
   *   解冻后的那一帧才会暴露出来。顺序反了就会漏判。 */
  await unfreeze();
  ok(errors.length === 0, 'pageerror / console.error 为空',
    errors.length ? errors.slice(0, 3).join(' | ') : '0 条');

  await browser.close();
  console.log(`\n\x1b[1m结果：${pass} 通过 / ${fail} 失败\x1b[0m`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
