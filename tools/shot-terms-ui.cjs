/**
 * 逐节气实截图 —— 证明「24 个节气在**画面上**真的不同」，而不只是参数不同。
 *
 * ── 为什么参数探针不够 ────────────────────────────────────────────
 * `probe-terms` 量的是 `TERM_VISUAL()` 的输出，那是**意图**。
 * 本脚本量的是**像素** —— 用户真正看到的东西。
 * 中间那一大段（options → pond → shader → canvas）任何一环断了，
 * 参数探针全绿而画面一动不动。
 *
 * ── 判据 ──────────────────────────────────────────────────────────
 *  ① 24 档全部截到，且**相邻两档的像素必须真的不同**（阈值 >6 灰阶）
 *  ② 差异要够大：相邻档的像素变化中位数 ≥ 0.6%
 *  ③ 同季节内的 6 档（共用同一张背景图）必须彼此不同 —— 这一条最关键
 *  ④ 冬六档之间有可见差异（用户反馈"都一样"的重灾区）
 *  ⑤ ★ 荷叶**在画面上**占多少像素（对照差分法，见下）
 *  ⑥ 全程无页面异常
 *
 * ── ⚠️ ⑤ 为什么不能只读引擎参数 ────────────────────────────────────
 * 第一版 ⑤ 写的是 `page.evaluate(() => __pondEngine.termVisual.leafCount)`。
 * 反证时把荷叶门控退回 `season==='summer'`，⑤ 依然全绿 ——
 * 因为引擎的 `termVisual.leafCount` **没被破坏**（档案照样算出 6 片），
 * 被破坏的只是「门控让不让画」。读参数 ⇒ 看不见门控断没断。
 *
 * ⇒ 改成**对照差分**：同一档位截两张 ——
 *   · A：原样
 *   · B：页面内把 `options.almanacProfile.leaf/lotus` 置 0（只动这两维，
 *        warmth 不动 ⇒ 水色不变，差分出来的就是荷叶与荷花的**真实占地**）
 * 然后 A−B 的变化像素占比就是荷叶面积。门控一断（春分/秋分/霜降不画了），
 * A−B 立刻趋近 0，判据翻红。
 *
 * ⚠️ 置 0 后必须**回读** `termVisual.leafCount === 0` 确认改动生效，
 *   否则量具会拿着一张和 A 一样的「对照图」报 0 面积 —— 假红。
 *
 * ── ⚠️⚠️ 冻结与抽鱼 ───────────────────────────────────────────────
 * `settings.reducedMotion` 只是把帧率降到 30（pond.js `tick` 的 interval），
 * `sim.update(dt)` 照跑 ⇒ **鱼一直在游动**。第一版量具因此把鱼尾巴的摆动
 * 当成了「荷叶占地」—— 大雪 0 片荷叶却测出 2.221% 面积。
 * 而且每次 reload 鱼群位姿重新随机 ⇒ ②③④ 的「相邻档差」里混着鱼的位姿差。
 * ⇒ 本脚本每档都：`paused:true` + 清空鱼/龟 + 手动 `render()`，
 * 量的才是**节气通道本身**。
 *
 * ── 像素差怎么算 ──────────────────────────────────────────────────
 * 取 RGB 三通道 **max** 绝对差（不是 PIL 的 `convert('L')`）——
 * convert('L') 是加权灰度，饱和度高的色相变化会被灰度吃掉一大半。
 *
 * 用法：node tools/shot-terms-ui.cjs      （需 dev server 在 5188）
 *      URL=http://127.0.0.1:5189/ node tools/shot-terms-ui.cjs
 */
const PW = require('C:/Users/Y/.workbuddy/binaries/node/workspace/node_modules/playwright-core');
const { join } = require('node:path');
const fs = require('node:fs');

const EXE = 'C:/Users/Y/AppData/Local/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-win64/chrome-headless-shell.exe';
const ROOT = join(__dirname, '..');
const OUT = join(ROOT, 'out', 'terms');
const URL = process.env.URL || 'http://127.0.0.1:5188/';

const TERMS = ['春分', '清明', '谷雨', '立夏', '小满', '芒种', '夏至', '小暑', '大暑', '立秋',
  '处暑', '白露', '秋分', '寒露', '霜降', '立冬', '小雪', '大雪', '冬至', '小寒', '大寒',
  '立春', '雨水', '惊蛰'];

let pass = 0, fail = 0;
const ok = (cond, label, detail) => {
  if (cond) { pass++; console.log(`  ${cond ? '\x1b[32m✔\x1b[0m' : '\x1b[31m✘\x1b[0m'} ${label}${detail ? '  — ' + detail : ''}`); }
  else { fail++; console.log(`  \x1b[31m✘\x1b[0m ${label}${detail ? '  — ' + detail : ''}`); }
};
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

/** 从 canvas 读像素统计（⚠️ 页面内 drawImage(canvas) 在某些环境恒为 0，
 *  所以这里用 CDP 的截图而不是页面内取样）。 */
async function stats(page) {
  return page.evaluate(() => {
    const e = window.__pondEngine;
    if (!e) return null;
    const v = e.termVisual;
    return v ? { leafCount: v.leafCount, lotusCount: v.lotusCount, ice: v.ice, litterCount: v.litterCount, causticInk: v.causticInk, tint: [v.tintR, v.tintG, v.tintB] } : null;
  });
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await PW.chromium.launch({ executablePath: EXE, args: ['--no-sandbox', '--use-gl=swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1100, height: 700 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE ' + m.text()); });

  await page.goto(URL, { waitUntil: 'load', timeout: 60000 });
  // ★ 固定成晴天 + manual 模式：天气会盖过节气效果（雨天本来就看不见水色）。
  await page.evaluate(() => {
    localStorage.setItem('fusheng-settings', JSON.stringify({
      // ⚠️ reducedMotion 必须**关**：它把焦散打到 35%、uMotion=0（见 landscape.js），
      //   于是量具测的是"关掉动效后的降级画面"，不是用户默认看到的。
      //   动画靠 `paused` 单独冻结（rAF 停 ⇒ 画面静止），与 reducedMotion 是两件事。
      season: 'summer', weather: 'sunny', day: 'day', fishCount: 10, fishSize: 1, turtleCount: 0,
      quality: 'high', reducedMotion: false, sound: false, volume: 0, ecoMode: false,
      almanacMode: 'manual', almanacTerm: '春分',
    }));
  });

  // ★★★ 冻结助手：**只做三件事，且必须三件都做**。
  //   ① paused      —— 停 rAF（sim.update 不再推进）
  //   ② 清鱼/龟    —— 每档 reload 后鱼的初始位姿重新随机，会混进像素差
  //   ③ time = 0    —— ★ 最容易被漏掉的一条：`Landscape.render` 有 `lastDraw.tick` 缓存，
  //                    焦散/光柱图案完全由 `time` 决定。paused 后 `sim.time`
  //                    停在"最后一帧跑到的残值"，两次 reload 落点不同 ⇒
  //                    同一档两张图能差 2.08%（实测秋分），噪声直接淹掉判据。
  //   ⚠️ 教训：**判据失效时先确认「它拿到的是不是它以为的东西」**。
  //      我一度以为是量具算错了，其实它拿到的是两个不同的时间点。
  // ★★★ 冻结助手：把**所有**不确定源钉死，否则判据全是噪声。
  //   每一条都是实测追出来的，不是预防性地加的 ——
  //   噪声从 2.14% 一路降到 0.10% 靠的就是把它们逐个找出来。
  // ★★★ 冻结助手：把**所有**不确定源钉死，否则判据全是噪声。
  //   每一条都是实测追出来的，不是预防性地加的 ——
  //   噪声从 2.14% 一路降到 0.10% 靠的就是把它们逐个找出来。
  await page.addInitScript(() => {
    window.__freeze = (e) => {
      e.updateOptions({ paused: true });          // ① 停 rAF
      e.sim.fish.length = 0;                      // ② 清鱼：每次 reload 位姿重随机
      e.sim.turtles.length = 0;
      e.sim.time = 0;                             // ③ 生态时钟：光池/焦散/光柱都由它定
      e.sim.hand = { x: 0, y: 0, life: 0 };       // ④ 手位：shader 的 uPointer 参与水面扰动

      // ⑤ 光照场是**第二个独立时钟**（light-field.js 的 update(dt) 自增），
      //    且 spawnShaft() 用 this.random 决定光柱横向位置。
      e.light.time = 0;
      e.light.shafts.length = 0;
      e.light.nextShaft = 1e6;
      e.light.random = () => 0.5;

      // ⑥ 落叶：光钉 random 不够 —— age/angle 已按随机数生成好，
      //    而 leaves() 按 age 算淡入淡出、按 time 算摆角。
      //    实测两次 reload 的 atmosphere.time 是 1.8167 vs 1.7499 ⇒ 噪声仍有 2.77%。
      e.atmosphere.random = () => 0.5;
      e.atmosphere.time = 0;
      e.atmosphere.leaves.forEach((l, i) => {
        l.u = 0.2 + 0.6 * (i % 7) / 7;
        l.v = 0.3 + 0.5 * (i % 5) / 5;
        l.age = l.life / 2;              // 淡入淡出的中点 ⇒ fade 恒为 1
        l.angle = (i % 11) * 0.5714;
        l.seed = ((i * 13) % 100) / 100;
        l.size = 16 + ((i * 7) % 10);
        l.variant = i % 2;
      });

      // ⑦ motes：120 个浮尘/亮斑的随机参数，drawSparkles 用它在光池里撒 26 个亮斑
      //    （quality=high 才画），drawWater 的水纹、drawIce 的岸边雪粒也都用它。
      e.motes.forEach((m, i) => {
        m.x = ((i * 37) % 120) / 120;
        m.y = ((i * 53) % 120) / 120;
        m.seed = ((i * 17) % 100) / 100;
        m.size = 1 + (((i * 7) % 10) / 10) * 2;
      });

      e.landscape.lastDraw = null;     // ⑧ 清 tick 缓存，强制真重画
      e.render();
      return true;
    };
  });

  const shots = [];
  const controlFail = [];
  // 噪声底探针：抽 5 档，每档**再截一张同档重载图**。
  // 同档两次之间的差异 = 渲染链自身的抖动（鱼位姿/水面/首帧时序残留），
  // 判据阈值必须按它的分位来定，不能拍脑袋。
  const NOISE_TERMS = ['春分', '清明', '立夏', '芒种', '秋分', '霜降', '大雪', '大寒'];
  const noise = [];
  for (const term of NOISE_TERMS) {
    await page.evaluate((t) => {
      const raw = JSON.parse(localStorage.getItem('fusheng-settings'));
      raw.almanacTerm = t;
      localStorage.setItem('fusheng-settings', JSON.stringify(raw));
    }, term);
    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('canvas.pond-canvas', { timeout: 20000 });
    const ok1 = await page.evaluate(() => {
      const e = window.__pondEngine;
      if (!e) return false;
      window.__freeze(e);
      return true;
    });
    if (!ok1) { controlFail.push(`${term}(noise,no-engine)`); continue; }
    await page.waitForTimeout(400);
    const f1 = join(OUT, `_noise-a-${term}.png`);
    await page.locator('canvas.pond-canvas').screenshot({ path: f1 });
    // 再重载一次，同样冻结 —— 同一档的第二张
    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('canvas.pond-canvas', { timeout: 20000 });
    await page.evaluate(() => { window.__freeze(window.__pondEngine); });
    await page.waitForTimeout(400);
    const f2 = join(OUT, `_noise-b-${term}.png`);
    await page.locator('canvas.pond-canvas').screenshot({ path: f2 });
    noise.push({ term, a: f1, b: f2 });
  }
  for (const term of TERMS) {
    await page.evaluate((t) => {
      const raw = JSON.parse(localStorage.getItem('fusheng-settings'));
      raw.almanacTerm = t;
      localStorage.setItem('fusheng-settings', JSON.stringify(raw));
    }, term);
    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('canvas.pond-canvas', { timeout: 20000 });
    // ⚠️⚠️ 必须 `paused` 冻结 + **清空鱼群**，只靠 reducedMotion 是不够的。
    //   ① reducedMotion 只把帧率降到 30（见 pond.js `tick` 的 interval），
    //      `sim.update(dt)` 照跑 ⇒ **鱼一直在游动**。
    //      第一版量具因此把「鱼的游动」当成了「荷叶占地」：
    //      大雪 0 片荷叶却测出 2.221% —— 那 2.2% 全是鱼尾巴在摆。
    //   ② 每次 reload 鱼群的初始位置重新随机 ⇒ 同一个节气两次截的鱼姿态不同，
    //      于是 ②③④ 的「相邻档像素差」里混着**鱼的位姿差**而非节气差。
    //   鱼与节气无关，留着只会当噪声。抽掉它，量的才是节气通道本身。
    const prepared = await page.evaluate(() => {
      const e = window.__pondEngine;
      if (!e) return false;
      window.__freeze(e);
      return true;
    });
    if (!prepared) controlFail.push(`${term}(no-engine)`);
    await page.waitForTimeout(400);
    const i = TERMS.indexOf(term);
    const file = join(OUT, `${i}-${term}.png`);
    await page.locator('canvas.pond-canvas').screenshot({ path: file });
    const v = await stats(page);

    // ★ 对照图：只把 leaf / lotus 两维置 0，warmth 不动 ⇒ 水色不变。
    //   差出来的像素就是荷叶+荷花的真实占地。
    const applied = await page.evaluate(() => {
      const e = window.__pondEngine;
      const p = e.options.almanacProfile;
      if (!p) return { ok: false, why: 'no-profile' };
      e.options.almanacProfile = { ...p, leaf: 0, lotus: 0 };
      e.render(); // 手动重画一帧（paused 时 rAF 已停）
      return { ok: true };
    });
    let ctl = null;
    if (applied.ok) {
      await page.waitForTimeout(250);
      // ⚠️ 回读确认改动生效，否则「对照图」= 原图 ⇒ 面积恒 0 ⇒ 假红
      const back = await page.evaluate(() => window.__pondEngine.termVisual.leafCount);
      if (back === 0) {
        ctl = join(OUT, `_ctl-${i}-${term}.png`);
        await page.locator('canvas.pond-canvas').screenshot({ path: ctl });
      } else {
        controlFail.push(`${term}(回读 leafCount=${back})`);
      }
    } else {
      controlFail.push(`${term}(${applied.why})`);
    }
    shots.push({ term, file, ctl, v });
  }

  section('① 24 档全部截到');
  ok(shots.length === 24, '截到 24 张', `${shots.length} 张`);
  const noVisual = shots.filter((s) => !s.v);
  ok(noVisual.length === 0, '每档都读到了 termVisual', noVisual.map((s) => s.term).join(' '));

  section('②③④ 像素差（用 Python 逐像素比对）');
  // 把文件清单交给 Python 做逐像素差分（页面内无法可靠比较两张 canvas）
  const listPath = join(OUT, '_list.json');
  fs.writeFileSync(listPath, JSON.stringify(shots.map((s) => ({ term: s.term, file: s.file }))));
  const { execFileSync } = require('node:child_process');
  const PY = 'C:/Users/Y/.workbuddy/binaries/python/envs/default/Scripts/python.exe';
  const script = join(ROOT, 'out', '_diff-terms.py');
  fs.writeFileSync(script, `
import json, numpy as np
from PIL import Image
shots = json.load(open(r'${listPath}', encoding='utf-8'))
def arr(p):
    return np.asarray(Image.open(p).convert('RGB'), dtype=np.int16)
def d(a, b):
    ia, ib = arr(a), arr(b)
    if ia.shape != ib.shape: return 100.0
    diff = np.abs(ia - ib).max(axis=2)
    return 100.0 * float((diff > 6).sum()) / diff.size
res = []
for i in range(len(shots)):
    res.append({'term': shots[i]['term'], 'next': shots[(i+1) % len(shots)]['term'],
                'pct': round(d(shots[i]['file'], shots[(i+1) % len(shots)]['file']), 3)})
json.dump(res, open(r'${join(OUT, '_diff.json')}', 'w', encoding='utf-8'), ensure_ascii=False)
`);
  execFileSync(PY, [script], { stdio: 'inherit' });
  const diffs = JSON.parse(fs.readFileSync(join(OUT, '_diff.json'), 'utf8'));
  const pcts = diffs.map((d) => d.pct);
  const sorted = [...pcts].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const worst = diffs.reduce((m, x) => (x.pct < m.pct ? x : m), { pct: Infinity });
  const zero = diffs.filter((d) => d.pct < 0.01);

  // ★★ 噪声底：同一档两次重载之间的差异。这是判据阈值的**唯一**依据。
  //   记一条铁律：**阈值按噪声分位定，不拍脑袋。**
  //   上一版把"组内相邻档 ≥ 0.05%"直接写死，结果反证时 winter 组掉到
  //   0.07% 仍然过关 —— 0.07% 到底是"差异"还是"抖动"，全靠阈值猜。
  const noisePath = join(OUT, '_noise.json');
  fs.writeFileSync(noisePath, JSON.stringify(noise));
  const noiseScript = join(ROOT, 'out', '_noise.py');
  fs.writeFileSync(noiseScript, `
import json, numpy as np
from PIL import Image
rows = json.load(open(r'${noisePath}', encoding='utf-8'))
out = []
for r in rows:
    ia = np.asarray(Image.open(r['a']).convert('RGB'), dtype=np.int16)
    ib = np.asarray(Image.open(r['b']).convert('RGB'), dtype=np.int16)
    diff = np.abs(ia - ib).max(axis=2)
    out.append({'term': r['term'], 'pct': 100.0 * float((diff > 6).sum()) / diff.size})
json.dump(out, open(r'${join(OUT, '_noise_result.json')}', 'w', encoding='utf-8'), ensure_ascii=False)
`);
  execFileSync(PY, [noiseScript], { stdio: 'inherit' });
  const noiseRes = JSON.parse(fs.readFileSync(join(OUT, '_noise_result.json'), 'utf8'));
  const noisePcts = noiseRes.map((n) => n.pct).sort((a, b) => a - b);
  const noiseMax = noisePcts.length ? noisePcts[noisePcts.length - 1] : 0;
  // ★★★ 阈值 = 噪声底 **加绝对余量**，不是**乘倍数**。这一步踩过两次坑：
  //   ① 先写死 0.05% ⇒ 反证时 winter 组掉到 0.07% 仍过关（阈值比噪声还低）。
  //   ② 改成 max×5 ⇒ 立夏偶发 0.107% 噪声把阈值抬到 0.536%，
  //      结果把**真实的**档间差异（惊蛰→春分 0.29%、夏至→小暑 0.20%）也判成不过。
  //   倍数会把"一个偶发尖峰"放大成"整张网的门槛"。噪声底已经压到 0.000~0.107%，
  //   绝对余量 0.15% 就足够（= 最坏噪声的 1.4 倍，且远低于最小真实差异 0.20%）。
  //   记一条铁律：**阈值 = 噪声底 + 绝对余量**。成倍放大会让偶发尖峰主导门槛。
  const noiseP90 = noisePcts.length ? noisePcts[Math.min(noisePcts.length - 1, Math.floor(noisePcts.length * 0.9))] : 0;
  const NOISE_MARGIN = 0.15;   // 绝对余量（百分点）
  const GROUP_MIN = Math.max(noiseP90 + NOISE_MARGIN, 0.15);
  console.log(`  噪声底（同档重载自比）：${noiseRes.map((n) => `${n.term} ${n.pct.toFixed(3)}%`).join('  ')}`);
  console.log(`  ⇒ 噪声 p90=${noiseP90.toFixed(3)}%  max=${noiseMax.toFixed(3)}%`);
  console.log(`  ⇒ 组内阈值 = p90 + ${NOISE_MARGIN} = ${GROUP_MIN.toFixed(3)}%（最小真实差异 0.20%，有余量）`);

  ok(zero.length === 0, '★ 没有两档像素完全相同',
    zero.length ? zero.map((d) => `${d.term}→${d.next}`).join(' ') : '');
  // 中位数阈值同样从噪声底推：相邻档中位差必须显著高于抖动。
  const medianMin = Math.max(noiseP90 + 0.50, 0.60);   // 中位数远高于噪声，但留得下"最小档"的空间
  ok(median >= medianMin, '★ 相邻档像素变化中位数显著高于噪声底',
    `median=${median.toFixed(2)}% min=${worst.pct.toFixed(2)}% @ ${worst.term}→${worst.next} max=${sorted.at(-1).toFixed(2)}%  阈值=${medianMin.toFixed(3)}%`);

  // 同季节 6 档
  const bySeason = { spring: ['春分', '清明', '谷雨', '立春', '雨水', '惊蛰'], summer: ['立夏', '小满', '芒种', '夏至', '小暑', '大暑'], autumn: ['立秋', '处暑', '白露', '秋分', '寒露', '霜降'], winter: ['立冬', '小雪', '大雪', '冬至', '小寒', '大寒'] };
  for (const [season, group] of Object.entries(bySeason)) {
    const adj = diffs.filter((d) => group.includes(d.term) && group.includes(d.next));
    const worstAdj = adj.reduce((m, x) => (x.pct < m.pct ? x : m), { pct: Infinity });
    ok(worstAdj.pct >= GROUP_MIN, `★ ${season} 组内相邻档有差异（共用同一张背景图）`,
      `最小 ${worstAdj.pct.toFixed(3)}% @ ${worstAdj.term}→${worstAdj.next}  阈值=${GROUP_MIN.toFixed(3)}%  |  ` +
      adj.map((d) => `${d.term}→${d.next} ${d.pct.toFixed(2)}%`).join('  '));
  }

  // 冬六档
  const winter = diffs.filter((d) => bySeason.winter.includes(d.term) && bySeason.winter.includes(d.next));
  const wWorst = winter.reduce((m, x) => (x.pct < m.pct ? x : m), { pct: Infinity });
  ok(wWorst.pct >= GROUP_MIN, '★ 冬六档之间有可见差异（用户反馈"都一样"的重灾区）',
    `最小 ${wWorst.pct.toFixed(3)}% @ ${wWorst.term}→${wWorst.next}  阈值=${GROUP_MIN.toFixed(3)}%`);

  section('⑤ ★ 荷叶在画面上的真实占地（对照差分，不是读引擎参数）');
  ok(controlFail.length === 0, '24 档对照图都成功置 leaf/lotus=0', controlFail.join(' '));
  const withCtl = shots.filter((s) => s.ctl);
  const ctlPath = join(OUT, '_ctl_list.json');
  fs.writeFileSync(ctlPath, JSON.stringify(withCtl.map((s) => ({ term: s.term, a: s.file, b: s.ctl, leaf: s.v.leafCount, lotus: s.v.lotusCount }))));
  const ctlScript = join(ROOT, 'out', '_leaf-area.py');
  fs.writeFileSync(ctlScript, `
import json, numpy as np
from PIL import Image
rows = json.load(open(r'${ctlPath}', encoding='utf-8'))
out = []
for r in rows:
    ia = np.asarray(Image.open(r['a']).convert('RGB'), dtype=np.int16)
    ib = np.asarray(Image.open(r['b']).convert('RGB'), dtype=np.int16)
    if ia.shape != ib.shape:
        out.append({'term': r['term'], 'area': -1.0, 'leaf': r['leaf'], 'lotus': r['lotus']}); continue
    diff = np.abs(ia - ib).max(axis=2)
    out.append({'term': r['term'], 'area': 100.0 * float((diff > 6).sum()) / diff.size,
                'leaf': r['leaf'], 'lotus': r['lotus']})
json.dump(out, open(r'${join(OUT, '_leafarea.json')}', 'w', encoding='utf-8'), ensure_ascii=False)
`);
  execFileSync(PY, [ctlScript], { stdio: 'inherit' });
  const areas = JSON.parse(fs.readFileSync(join(OUT, '_leafarea.json'), 'utf8'));
  const A = (t) => areas.find((a) => a.term === t);
  for (const a of areas) console.log(`  ${a.term.padEnd(4)} 档案 ${String(a.leaf).padStart(2)}片/${String(a.lotus).padStart(1)}花 → 画面 ${a.area.toFixed(3)}%`);

  const bigSnow = A('大雪');
  ok(bigSnow.area < 0.05, '★ 大雪画面上看不见荷叶/荷花（用户明确说过大雪没有花）',
    `${bigSnow.area.toFixed(3)}% 面积`);

  const springEq = A('春分'), summerGrain = A('芒种');
  ok(springEq.area > 0.05, '★ 春分画面上看得见浮叶（旧门控下这里是 0）', `${springEq.area.toFixed(3)}% 面积`);
  ok(summerGrain.area > springEq.area, '芒种荷叶面积 > 春分', `${summerGrain.area.toFixed(3)}% vs ${springEq.area.toFixed(3)}%`);

  // ★ 这条才是真正抓「门控退回 season==='summer'」的：
  //   秋分/霜降/惊蛰都不是夏季，档案却给了 9/4/8 片 —— 画面上必须看得见。
  const offSeason = ['秋分', '霜降', '惊蛰'].filter((t) => A(t).area < 0.05);
  ok(offSeason.length === 0, '★ 非夏季档位的浮叶也画出来了（秋分/霜降/惊蛰）',
    offSeason.join(' ') || areas.filter((a) => ['秋分', '霜降', '惊蛰'].includes(a.term)).map((a) => `${a.term} ${a.area.toFixed(3)}%`).join('  '));

  // 秩相关：画面上的荷叶多少，必须与档案的 leafCount 同序。
  //（不用线性面积比 —— drawLotus 里 size 还乘了 ring，非线性）
  const rank = (arr) => {
    const idx = arr.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]);
    const r = new Array(arr.length);
    for (let k = 0; k < idx.length; k++) r[idx[k][1]] = k + 1;
    return r;
  };
  const pearson = (a, b) => {
    const n = a.length, ma = a.reduce((s, x) => s + x, 0) / n, mb = b.reduce((s, x) => s + x, 0) / n;
    let sa = 0, sb = 0, sab = 0;
    for (let i = 0; i < n; i++) { const da = a[i] - ma, db = b[i] - mb; sa += da * da; sb += db * db; sab += da * db; }
    return sa && sb ? sab / Math.sqrt(sa * sb) : 0;
  };
  const rho = pearson(rank(areas.map((a) => a.area)), rank(areas.map((a) => a.leaf)));
  ok(rho >= 0.9, '★ 画面荷叶面积与档案 leafCount 强同序（Spearman）', `ρ=${rho.toFixed(3)}（24 档）`);

  section('⑥ 页面异常');
  ok(errors.length === 0, '全程无页面异常', errors.slice(0, 3).join(' | '));

  console.log(`\n通过 ${pass} 项，未通过 ${fail} 项`);
  console.log(`截图目录：${OUT}`);
  // 拼一张对比图（方便直接看）
  console.log('\n相邻档像素变化明细：');
  for (const d of diffs) console.log(`  ${d.term} → ${d.next}: ${d.pct.toFixed(2)}%`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})();