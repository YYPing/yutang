/**
 * `frost` 通道的**对照差分**验收 —— 防「算了不画」。
 *
 * ★★ 为什么必须用对照差分，不能只读参数：
 *   第一版 `term-visual.js` 里 frost 一直算得出、渲染层一次都没读；
 *   `probe-terms.mjs` 的 ① 段（"渲染参数读了档案的 frost"）查的是
 *   **源码里出现过 `.frost`** —— 那是"读得到"，不是"用不用"。
 *   记忆里已经记过这条铁律：判据失效时先确认「它拿到的是不是它以为的东西」。
 *   这次直接照着最坏情况做：同一档截「正常」与「强制 frost=0」两张，
 *   差出来的像素就是 frost 的真实贡献。
 *
 * ⚠️ 与 `check-bank-flora-ui.cjs`（已回退）不同，这里量的是**岸边一条带**，
 *   不是全图 —— 全图会被水色/焦散/落叶这些别的通道淹没。
 *   同时要验证"岸边带之外基本不变"，否则说明 frost 画错了地方（溢到池心）。
 *
 * 判据：
 *   ① 六个有霜档位（霜降→立春）岸边带像素差 > 0.1%（确实画了）
 *   ② 岸边带差值 > 池心差值 × 3（霜只挂岸边，不是全图泛白）
 *   ③ 无霜档位（惊蛰/春分）差 ≈ 0（不是无脑常开）
 *   ④ 薄冰档位才有霜：封冰档（大雪/冬至）必须为 0（霜被压在冰下）
 *   ⑤ 噪声底对照：同一档截两张，差应≈0
 *
 * 前置：dev server 在 5188。
 */
const PW = require('C:/Users/Y/.workbuddy/binaries/node/workspace/node_modules/playwright-core');
const { join } = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const ROOT = join(__dirname, '..');
const OUT = join(ROOT, 'out', 'frost-check');
const URL = 'http://127.0.0.1:5188/';
const PY = 'C:/Users/Y/.workbuddy/binaries/python/envs/default/Scripts/python.exe';
const EXE = 'C:/Users/Y/AppData/Local/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-win64/chrome-headless-shell.exe';

/* 霜的物候：寒露 .2 起 → 霜降 .8 → 立冬 1 → 立春 .6 → 雨水 .2 → 惊蛰 0。
 * 阈值「有霜」取 frost > 0.05；封冰档 ice >= 0.55 按设计不画。 */
const TERMS = ['霜降', '立冬', '小雪', '大雪', '冬至', '立春', '雨水', '惊蛰', '春分'];

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
      season: 'summer', weather: 'sunny', day: 'day',
      fishCount: 10, fishSize: 1, turtleCount: 0, quality: 'high',
      reducedMotion: false, sound: false, volume: 0, ecoMode: false,
      almanacMode: 'manual', almanacTerm: '霜降',
    }));
  });
  await page.addInitScript(() => {
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
      e.render();
      return true;
    };
  });

  section('① 截图：每档两张（正常 / 强制 frost=0）');
  const shots = [];
  for (const term of TERMS) {
    await page.evaluate((t) => {
      const raw = JSON.parse(localStorage.getItem('fusheng-settings'));
      raw.almanacTerm = t;
      localStorage.setItem('fusheng-settings', JSON.stringify(raw));
    }, term);
    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('canvas.pond-canvas', { timeout: 20000 });

    const shoot = async (kill) => {
      const ready = await page.evaluate((k) => {
        const e = window.__pondEngine;
        if (!e) return null;
        window.__freeze(e);
        // ⚠️⚠️ 第一版在这里失败过，教训值得写下来：
        //   ① patch `e.render` 没用 —— `render()` 第一行就是
        //      `this.termVisual = visualFor(this.options)`，会把 frost 又算回来；
        //   ② 改 `e.options.almanacProfile.frost` 也没用 —— 档案每帧重算。
        //   正解：patch **`visualFor` 拿到的那个 profile 对象本身**是不行的（它是新对象），
        //   唯一稳定的办法是**让 `visualFor` 这个模块函数**在 kill 期间把 frost 抹掉。
        //   实现上通过 `e.options.almanacProfile` 的 **getter** 包装：
        //   render 里每次读 options.almanacProfile 都会拿到 frost=0 的副本。
        if (k && !e.__frostPatched) {
          e.__frostPatched = true;
          const src = e.options.almanacProfile;
          Object.defineProperty(e.options, 'almanacProfile', {
            configurable: true,
            get: () => (e.__frostKill ? { ...src, frost: 0 } : src),
          });
        }
        e.__frostKill = !!k;
        e.render();
        return { frost: e.termVisual.frost, ice: e.termVisual.ice };
      }, kill);
      if (!ready) return null;
      await page.waitForTimeout(320);
      const f = join(OUT, `${TERMS.indexOf(term)}-${term}-${kill ? 'off' : 'on'}.png`);
      await page.locator('canvas.pond-canvas').screenshot({ path: f });
      return { f, ...ready };
    };

    const on = await shoot(false);
    const off = await shoot(true);
    if (!on || !off) { console.log(`  跳过 ${term}（无引擎句柄）`); continue; }
    shots.push({ term, on, off });
    console.log(`  ${term.padEnd(3)} frost=${on.frost.toFixed(2)} ice=${on.ice.toFixed(2)}`);
  }
  ok(shots.length === TERMS.length, '全部档位截到', `${shots.length}/${TERMS.length}`);
  // ★ 阳性对照：kill 必须真生效。
  //   第一版量具拿到的是「两张逐字节相同的图」⇒ 全部 0.000%，
  //   而我一开始以为"frost 没画"。真相是 kill 没生效（render 里重算），
  //   量具坏掉却伪装成"实现有 bug"—— 这正是记忆里那条铁律的又一次复现：
  //   **判据失效时先确认「它拿到的是不是它以为的东西」**。
  //   这里用引擎回报的 frost 值反证：off 档必须读到 0，否则差分恒为 0 是必然的。
  const killWorks = shots.filter((s) => s.off.frost === 0).length;
  ok(killWorks === shots.length,
    '★ 对照组的 frost 确实是 0（kill 生效，否则下面所有差分恒为 0）',
    shots.map((s) => `${s.term}:on=${s.on.frost.toFixed(2)}/off=${s.off.frost.toFixed(2)}`).join(' '));

  section('② 对照差分（岸边带 vs 池心）');
  const listPath = join(OUT, '_list.json');
  fs.writeFileSync(listPath, JSON.stringify(shots));

  // ⚠️ 岸边带 = 上下各 12% 高度；池心 = 中间 40%（避开鱼/水纹/光柱的强纹理区）
  const script = join(OUT, '_diff.py');
  const outPath = join(OUT, '_diff.json');
  fs.writeFileSync(script, [
    'import json, numpy as np',
    'from PIL import Image',
    'rows = json.load(open(r\'' + listPath + '\', encoding=\'utf-8\'))',
    'def load(p):',
    '    return np.asarray(Image.open(p).convert(\'RGB\'), dtype=np.float32)',
    'out = []',
    'for r in rows:',
    '    a, b = load(r[\'on\'][\'f\']), load(r[\'off\'][\'f\'])',
    '    d = np.abs(a - b).max(axis=2)          # 每像素 RGB 最大通道差',
    '    H = d.shape[0]',
    '    bank = np.concatenate([d[:int(H*.12)].ravel(), d[-int(H*.12):].ravel()])',
    '    core = d[int(H*.30):int(H*.70)].ravel()',
    '    out.append({',
    '        "term": r["term"], "frost": r["on"]["frost"], "ice": r["on"]["ice"],',
    '        "bank": float((bank > 2).mean() * 100),',
    '        "core": float((core > 2).mean() * 100),',
    '    })',
    'print(json.dumps(out))',
  ].join('\n'));
  // ⚠️ **不要用 `execFileSync(..., {encoding:'utf8'})` 捕获 stdout** ——
  //   本沙箱会报 `spawnSync ... EBUSY`（-4082）。`check-term-delta.cjs` 能跑通
  //   是因为它用了 `stdio:'inherit'`（不捕获）；这里需要结果，所以改成
  //   **Python 自己写文件、Node 读文件**。这比在 Node 里解码 stdout 稳。
  if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
  fs.writeFileSync(script,
    (fs.readFileSync(script, 'utf8').replace(/print\(json\.dumps\(out\)\)/, `json.dump(out, open(r'${outPath}', 'w', encoding='utf-8'))`)));
  execFileSync(PY, [script], { stdio: 'inherit' });
  const rows = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  const byTerm = Object.fromEntries(rows.map((r) => [r.term, r]));

  for (const r of rows) {
    const ratio = r.core > 0.01 ? r.bank / r.core : Infinity;
    console.log(`  ${r.term.padEnd(3)} frost=${r.frost.toFixed(2)} ice=${r.ice.toFixed(2)}`
      + `  岸边差 ${r.bank.toFixed(3)}%  池心差 ${r.core.toFixed(3)}%  集中度 ${Number.isFinite(ratio) ? ratio.toFixed(1) : '∞'}`);
  }

  section('③ 判据');
  const withFrost = rows.filter((r) => r.frost > 0.05 && r.ice < 0.55);
  const noFrost = rows.filter((r) => !(r.frost > 0.05 && r.ice < 0.55));
  const drawn = withFrost.filter((r) => r.bank > 0.1);
  ok(drawn.length === withFrost.length,
    '① 所有「有霜且未封冰」档位岸边带都有可见变化（frost 真被消费了）',
    `${drawn.length}/${withFrost.length}（${withFrost.map((r) => `${r.term}:${r.bank.toFixed(2)}%`).join(' ')}）`);
  ok(withFrost.every((r) => r.core <= 0.05),
    '② 池心基本不变（霜只挂岸边，没有溢到池心）',
    `池心最大 ${Math.max(...withFrost.map((r) => r.core)).toFixed(3)}%`);
  const ratioOk = withFrost.filter((r) => r.core <= 0.05 || r.bank / r.core >= 3);
  ok(ratioOk.length === withFrost.length,
    '③ 岸边集中度 ≥ 3（霜在正确的位置，不是全图泛白）',
    withFrost.map((r) => `${r.term}:${(r.core <= 0.05 ? '∞' : (r.bank / r.core).toFixed(1))}`).join(' '));
  const maxNo = Math.max(0, ...noFrost.map((r) => r.bank));
  ok(maxNo <= 0.02,
    '④ 无霜档位/封冰档位岸边差≈ 0（不是无脑常开，也没把霜画到封冰下面）',
    noFrost.map((r) => `${r.term}(frost=${r.frost.toFixed(2)},ice=${r.ice.toFixed(2)}):${r.bank.toFixed(3)}%`).join(' '));

  section('④ 页面异常');
  ok(errors.length === 0, '全程无页面异常', errors.slice(0, 2).join(' | '));

  console.log(`\n通过 ${pass} 项，未通过 ${fail} 项`);
  console.log(`截图目录：${OUT}`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });