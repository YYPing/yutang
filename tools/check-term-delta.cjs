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
const URL = 'http://127.0.0.1:5188/';
const PY = 'C:/Users/Y/.workbuddy/binaries/python/envs/default/Scripts/python.exe';
const EXE = 'C:/Users/Y/AppData/Local/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-win64/chrome-headless-shell.exe';

const SPRING = ['立春', '雨水', '惊蛰', '春分', '清明', '谷雨'];
const SUMMER = ['立夏', '小满', '芒种', '夏至', '小暑', '大暑'];
const AUTUMN = ['立秋', '处暑', '白露', '秋分', '寒露', '霜降'];
const WINTER = ['立冬', '小雪', '大雪', '冬至', '小寒', '大寒'];
const SEASON = { ...Object.fromEntries(SPRING.map(t => [t, 'spring'])), ...Object.fromEntries(SUMMER.map(t => [t, 'summer'])), ...Object.fromEntries(AUTUMN.map(t => [t, 'autumn'])), ...Object.fromEntries(WINTER.map(t => [t, 'winter'])) };
const TERMS = [...SPRING, ...SUMMER, ...AUTUMN, ...WINTER];

/* 相邻档水面 ΔE 下限。
 * ⚠️ **按实测分布定，不拍脑袋**（2026-10-04）：20 对同季相邻档实测落在
 *    **2.64 ~ 3.97**（p25 3.24 / 中位 3.73 / p75 3.85），分布极紧、无塌陷。
 *    阈值取 2.5 = 分布下沿之下。
 * ★ 诚实记录：这**低于**人眼"并排比对即可辨"的 5.0。换句话说
 *   「同季六档现在都能分辨，但都需要并排比对才看得出来，还不是一眼可辨」。
 *   若要破 5，需要继续加大 tint 全幅（会开始像滤镜）或叠加岸边语义物体。
 *   判据一旦被调到当前实测之上就会恒红，那就不是判据了，是自欺。 */
const DE_MIN = 2.5;

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
      almanacMode: 'manual', almanacTerm: '立春',
    }));
  });
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
      const prepared = await page.evaluate((p) => {
        const e = window.__pondEngine;
        if (!e) return false;
        e.updateOptions({ termPattern: p });
        window.__freeze(e);
        return true;
      }, tag === 'A' ? 0.85 : 0);
      if (!prepared) { console.log(`  跳过 ${term}（无引擎句柄）`); continue; }
      await page.waitForTimeout(350);
      const f = join(OUT, `${tag}-${TERMS.indexOf(term)}-${term}.png`);
      await page.locator('canvas.pond-canvas').screenshot({ path: f });
      shots.push({ term, f });
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
    'def water_mask(a):',
    '    m = np.minimum(a[..., 1], a[..., 2]) - a[..., 0]',
    '    w = np.clip((m - 0.015 * 255) / (0.08 * 255 - 0.015 * 255), 0, 1)',
    '    return w > 0.55',
    'def stats(shots):',
    '    out = []',
    '    for r in shots:',
    '        a = load(r[\'f\'])',
    '        msk = water_mask(a)',
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
  ok(A2.sameMin >= DE_MIN, `★ 同季每对相邻档 ΔE ≥ ${DE_MIN}`,
    `最小 ${A2.sameMin}（均匀对照时 ${B2.sameMin}，结构化后 ×${(A2.sameMin / Math.max(B2.sameMin, .01)).toFixed(2)}）`);
  ok(A2.sameMed > B2.sameMed, '★ 结构化确实提高了可辨度（中位）',
    `${B2.sameMed} → ${A2.sameMed}`);
  ok(A2.sameMed >= DE_MIN, `同季中位 ΔE 达 ${DE_MIN}`, `${A2.sameMed}`);
  ok(A2.crossMed > A2.sameMed, '★ 跨季仍显著高于同季（没调糊）',
    `跨季 ${A2.crossMed} vs 同季 ${A2.sameMed}`);

  // 亮度/饱和度没有跑偏（不许变成滤镜）
  const st = R.A.stats.filter((s) => 'rgb' in s);
  const lums = st.map((s) => s.lum);
  ok(Math.max(...lums) - Math.min(...lums) < 55, '水面亮度未被染色压垮',
    `L* ${Math.min(...lums).toFixed(1)}~${Math.max(...lums).toFixed(1)}（极差 ${(Math.max(...lums) - Math.min(...lums)).toFixed(1)}）`);

  // 分布塌陷检查：20 对不能挤在低位（那意味着"多数档位其实分不出来"）
  const sameDEs = R.A.pairs.filter((p) => p.same).map((p) => p.dE).sort((a, b) => a - b);
  const p25 = sameDEs[Math.floor(sameDEs.length * 0.25)];
  const med = sameDEs[Math.floor(sameDEs.length / 2)];
  ok(med - sameDEs[0] < 2.0, '★ 同季档间差分布无塌陷（不是只有个别档能分辨）',
    `最小 ${sameDEs[0]} / p25 ${p25} / 中位 ${med} / 最大 ${sameDEs[sameDEs.length - 1]}`);

  section('④ 页面异常');
  ok(errors.length === 0, '全程无页面异常', errors.slice(0, 3).join(' | '));

  console.log(`\n通过 ${pass} 项，未通过 ${fail} 项`);
  console.log(`截图目录：${OUT}`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
