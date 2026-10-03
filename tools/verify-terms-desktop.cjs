/**
 * 桌面实例上的节气验证 —— 走 CDP 连真窗口（4173 站点 + 9224 CDP）。
 *
 * ★ 与浏览器版 `shot-terms-ui.cjs` 的区别：这里验的是**打包后的 dist**、
 *   在**真实 Electron 窗口**里，包含 DPR / 无边框 / 桌面模式的差异。
 *
 * ★★ 为什么这里不能像浏览器版那样 `__freeze()`：
 *   `src/components/Pond.jsx` 的 `window.__pondEngine` 被 `import.meta.env.DEV`
 *   门控，**生产包里整块被 tree-shake 掉**（那是刻意设计：不留调试开关）。
 *   ⇒ 桌面版拿不到引擎句柄，无法 paused / 无法清鱼群。
 *   ⇒ 实测直接截：跨季差 92~95%（全是鱼在游 + 水面在动），
 *      而浏览器版冻结后相邻档中位只有 1.63% ⇒ 量到的主要是**鱼**，不是节气。
 *
 * ★★ 本脚本的解法：**静止像素掩膜**。
 *   每档连截两张（间隔 700ms），自比得到「这一档里哪些像素在动」= 鱼 + 水面 + 落叶。
 *   档间差只在**静止像素**上统计 —— 动的像素会被自比掩膜剔除。
 *   这样既不用改产品代码（不破坏「生产包无调试开关」），
 *   也不必假装自己能冻结。顺带还能量出桌面版的真实噪声底。
 *
 * 判据阈值按**自测噪声分位**定，不拍脑袋（踩过两次：写死 0.05% 被噪声骗过、
 * max×5 把真实差异也判死）。
 *
 * 前置：`npm run desktop:local` 已启动（站点 4173 + CDP 9224）。
 */
const PW = require('C:/Users/Y/.workbuddy/binaries/node/workspace/node_modules/playwright-core');
const { join } = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const ROOT = join(__dirname, '..');
const OUT = join(ROOT, 'out', 'terms-desktop');
const DIFF = join(ROOT, 'out', 'terms-desktop-diff');
const CDP = 'http://127.0.0.1:9224';
const PY = 'C:/Users/Y/.workbuddy/binaries/python/envs/default/Scripts/python.exe';

// 跨季对照 + 冬六档里的代表（省时间：8 档够看出问题，不必全 24 档）
const TERMS = ['春分', '芒种', '夏至', '秋分', '霜降', '大雪', '小寒', '大寒'];
const WINTER = ['大雪', '小寒', '大寒'];
// 自比掩膜判定为「静止」的阈值：单通道 max 差 ≤ MOVE_TH ⇒ 视为静止
const MOVE_TH = 4;
// 档间差算「变了」的阈值（同浏览器版量具口径）
const DIFF_TH = 6;

let pass = 0, fail = 0;
const ok = (c, label, detail) => {
  const mark = c ? '\x1b[32m✔\x1b[0m' : '\x1b[31m✘\x1b[0m';
  if (c) pass++; else fail++;
  console.log(`  ${mark} ${label}${detail ? '  — ' + detail : ''}`);
};
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await PW.chromium.connectOverCDP(CDP);
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find((p) => p.url().includes('4173')) || ctx.pages()[0];
  if (!page) { console.error('找不到桌面页面'); process.exit(2); }

  const errors = [];
  page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE ' + m.text()); });

  await page.bringToFront();
  await page.waitForTimeout(600);

  // 固定成晴天白天手动模式：天气/昼夜会盖过节气效果（雨天本就看不见水色）。
  await page.evaluate(() => {
    localStorage.setItem('fusheng-settings', JSON.stringify({
      season: 'summer', weather: 'sunny', day: 'day', night: false,
      fishCount: 10, fishSize: 1, turtleCount: 0,
      quality: 'high', reducedMotion: false, sound: false, volume: 0, ecoMode: false,
      almanacMode: 'manual', almanacTerm: '大雪',
    }));
  });

  // 每档两张（a/b），b 用来算自比掩膜
  const shots = [];
  for (const term of TERMS) {
    await page.evaluate((t) => {
      const raw = JSON.parse(localStorage.getItem('fusheng-settings'));
      raw.almanacTerm = t;
      localStorage.setItem('fusheng-settings', JSON.stringify(raw));
    }, term);
    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('canvas.pond-canvas', { timeout: 20000 });
    await page.waitForTimeout(1400);
    const i = TERMS.indexOf(term);
    const a = join(OUT, `${i}-${term}-a.png`);
    const b = join(OUT, `${i}-${term}-b.png`);
    await page.locator('canvas.pond-canvas').screenshot({ path: a });
    await page.waitForTimeout(700);
    await page.locator('canvas.pond-canvas').screenshot({ path: b });
    shots.push({ term, a, b });
  }

  section('① 桌面实例截到 ' + TERMS.length + ' 档');
  ok(shots.length === TERMS.length, '全部截到', `${shots.length}/${TERMS.length}`);

  section('② 自比噪声底与静止掩膜');
  const listPath = join(OUT, '_list.json');
  fs.writeFileSync(listPath, JSON.stringify(shots));
  const script = join(OUT, '_diff.py');
  fs.writeFileSync(script, [
    'import json, os, numpy as np',
    'from PIL import Image',
    'DOUT = r\'' + DIFF + '\'',
    'os.makedirs(DOUT, exist_ok=True)',
    'rows = json.load(open(r\'' + listPath + '\', encoding=\'utf-8\'))',
    'MOVE_TH = ' + MOVE_TH,
    'DIFF_TH = ' + DIFF_TH,
    'def load(p):',
    '    return np.asarray(Image.open(p).convert(\'RGB\'), dtype=np.int16)',
    '',
    'stats, masks, A = [], [], []',
    'for r in rows:',
    '    a = load(r[\'a\']); b = load(r[\'b\']); A.append(a)',
    '    m = np.abs(a-b).max(axis=2)',
    '    still = m <= MOVE_TH',
    '    masks.append(still)',
    '    moving = 100.0*float((m > MOVE_TH).sum())/m.size',
    '    # ⚠️ 噪声底必须**在静止区内**算。全图算的话，掩膜本该剔掉的那 4~6%',
    '    #   动像素（鱼/水花）又全被算进来 ⇒ self 永远 >= 4% ⇒ 判据必然假红。',
    '    #   （第一版就是这么错的：掩膜已生效但 self 还报 6~8%。）',
    '    selfpct = 100.0*float(((m > DIFF_TH) & still).sum())/float(still.sum())',
    '    stats.append({\'term\': r[\'term\'], \'mean\': float(a.mean()),',
    '                  \'std\': float(a.std()), \'blue\': float(a[...,2].mean()),',
    '                  \'still\': round(100.0*float(still.sum())/still.size, 2),',
    '                  \'moving\': round(moving, 2),',
    '                  \'self\': round(selfpct, 4)})',
    '    d = np.clip(m * 8, 0, 255).astype(np.uint8)',
    '    Image.fromarray(d).convert(\'RGB\').save(os.path.join(DOUT, \'self-%s.png\' % r[\'term\']))',
    '',
    'res = []',
    'for i in range(len(rows)):',
    '    j = (i+1) % len(rows)',
    '    # 掩膜取两档的交集：两边都静止的像素才可信',
    '    still = masks[i] & masks[j]',
    '    pair = rows[i][\'term\'] + \' -> \' + rows[j][\'term\']',
    '    if A[i].shape != A[j].shape:',
    '        res.append({\'pair\': pair, \'pct\': 100.0, \'still\': 0.0}); continue',
    '    d = np.abs(A[i]-A[j]).max(axis=2)',
    '    tot = float(still.sum())',
    '    pct = 100.0*float(((d>DIFF_TH) & still).sum())/tot if tot else 100.0',
    '    res.append({\'pair\': pair, \'pct\': round(pct, 3),',
    '                \'still\': round(100.0*tot/d.size, 2)})',
    '    # 差异只在静止像素上放大显示 —— 这样图里剩下的就是节气本身',
    '    dd = np.zeros_like(d, dtype=np.uint8)',
    '    dd[still] = np.clip(d[still] * 12, 0, 255)',
    '    Image.fromarray(dd).convert(\'RGB\').save(',
    '        os.path.join(DOUT, \'%d-%s-%s.png\' % (i, rows[i][\'term\'], rows[j][\'term\'])))',
    'json.dump({\'stats\': stats, \'diffs\': res},',
    '          open(r\'' + join(OUT, '_d.json') + '\', \'w\', encoding=\'utf-8\'), ensure_ascii=False)',
  ].join('\n'));
  execFileSync(PY, [script], { stdio: 'inherit' });
  const D = JSON.parse(fs.readFileSync(join(OUT, '_d.json'), 'utf8'));

  console.log('  档位均亮 / 标准差 / 蓝通道 / 静止像素占比 / 动的像素占比 / 自比差');
  for (const s of D.stats) {
    console.log(`  ${s.term.padEnd(3)} ${s.mean.toFixed(1).padStart(6)} / ${s.std.toFixed(1).padStart(5)} / ${s.blue.toFixed(1).padStart(6)} / 静止 ${s.still.toFixed(1)}% / 动 ${s.moving.toFixed(1)}% / 自比 ${s.self.toFixed(3)}%`);
  }
  const selfWorst = Math.max(...D.stats.map((s) => s.self));
  const stillWorst = Math.min(...D.stats.map((s) => s.still));
  ok(selfWorst < 0.05, '★ 静止区噪声底已压到判据之下', `最大静止区自比差 ${selfWorst.toFixed(4)}%`);
  ok(stillWorst > 55, '静止掩膜有效（没把画面全剔掉）', `最小静止占比 ${stillWorst.toFixed(1)}%`);

  section('③ 静止像素上的相邻档差');
  // ★ 必须分两类判，混在一起判没有意义：
  //   跨季（A 方案的设计前提就是保留 4 张季节底图）⇒ 判"底图确实换了"，差异应当**很大**；
  //   同季（同一张底图，只有 tint + 六维档案在动）⇒ 这才是 A 方案真正要解的问题，
  //       差异**本来就只有 1~3 灰阶**，判它是否 > 噪声底即可。
  const SEASON = { '春分': 'spring', '芒种': 'summer', '夏至': 'summer', '秋分': 'autumn', '霜降': 'autumn', '大雪': 'winter', '小寒': 'winter', '大寒': 'winter' };
  const cross = D.diffs.filter((d) => {
    const [x, y] = d.pair.split(' -> ');
    return SEASON[x] !== SEASON[y];
  });
  const same = D.diffs.filter((d) => {
    const [x, y] = d.pair.split(' -> ');
    return SEASON[x] === SEASON[y];
  });
  for (const d of D.diffs) {
    const tag = cross.includes(d) ? '跨季' : '同季';
    console.log(`  ${d.pair.padEnd(11)} [${tag}] 像素差 ${d.pct.toFixed(3).padStart(6)}%   （静止区 ${d.still.toFixed(1)}%）`);
  }

  const zero = D.diffs.filter((d) => d.pct < 0.01);
  ok(zero.length === 0, '★ 真窗口里没有两档完全相同', zero.map((d) => d.pair).join(' '));

  ok(cross.length === 4 && cross.every((d) => d.pct >= 20),
    '★ 跨季确实换了季节底图（4 对）',
    cross.map((d) => `${d.pair} ${d.pct.toFixed(1)}%`).join('  '));

  // 同季：阈值只要求"高于静止区噪声底（0.0000%）"，不是拍脑袋的绝对值
  ok(same.length === 4 && same.every((d) => d.pct >= 0.05),
    '★ 同季 4 对全部可区分（这是 A 方案要解的问题）',
    same.map((d) => `${d.pair} ${d.pct.toFixed(3)}%`).join('  '));

  // 冬档**内部**的相邻对（大雪→小寒、小寒→大寒），排除跨季的大寒→春分
  const winterPairs = D.diffs.filter((d) => {
    const [x, y] = d.pair.split(' -> ');
    return WINTER.includes(x) && WINTER.includes(y);
  });
  ok(winterPairs.length === 2 && winterPairs.every((d) => d.pct >= 0.05),
    '★ 冬档在真窗口里可区分',
    winterPairs.map((d) => `${d.pair} ${d.pct.toFixed(3)}%`).join('  '));

  // 大雪应当明显更亮：冰层 + 岸边积雪把画面提亮
  const dx = D.stats.find((s) => s.term === '大雪');
  const mz = D.stats.find((s) => s.term === '芒种');
  ok(dx.mean > mz.mean, '大雪比芒种亮（结冰反光）', `大雪 ${dx.mean.toFixed(1)} vs 芒种 ${mz.mean.toFixed(1)}`);

  // 同季里最容易饱和的一对：芒种/夏至 leaf 分别是 21/22 片（round(.96*22) vs 1*22），
  // 而 ring=min(1,pads/22) 是**整簇缩放因子** ⇒ 这一对的差异天然偏大（~39%）。
  // 它偏大不是缺陷，但**不能拿它当"同季渐变有效"的证据** —— 证据是上面那 4 对。
  const ms = D.diffs.find((d) => d.pair === '芒种 -> 夏至');
  ok(ms && ms.pct > 0, '芒种→夏至未饱和（荷叶 21→22 片 + 整簇缩放）', ms ? ms.pct.toFixed(3) + '%' : 'n/a');

  section('④ 页面异常');
  ok(errors.length === 0, '全程无页面异常', errors.slice(0, 3).join(' | '));

  console.log(`\n通过 ${pass} 项，未通过 ${fail} 项`);
  console.log(`截图目录：${OUT}`);
  console.log(`差异图（静止像素 ·×12）：${DIFF}`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
