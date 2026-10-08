/**
 * 节气档案的**物候单调性**护栏。
 *
 * ★ 为什么要有这个文件（2026-10-04 新增）：
 *   用户提供了 24 张水彩参考图（`koi-pond-assets`，`manifest.json` 的
 *   `lunarNote` 恰好就是 24 节气），我拿它的 `pondState` 描述去核对
 *   `almanac.js` 的六维档案 —— 那是**独立于本项目代码的第二信源**。
 *
 *   核对结果：找出一个**真缺陷** —— 春分的 `leaf` 档（.25）**低于惊蛰**（.35），
 *   而参考图明确写「惊蛰= 嫩绿新叶展开·零星花苞」「春分 = 巴掌大翠绿圆叶·
 *   七八支花苞待放」⇒ 春分的叶量应≥ 惊蛰。已把春分改成 .32。
 *
 * ★ 为什么只断言「不倒退」而不断言「严格单调」：
 *   真实物候**不是等速的**。同季六档里有三处刻意反向，都有物候依据：
 *     春分 .32 < 清明 .45 —— 谷雨才是「大量花苞满塘」的峰值，春分圆叶虽大但未铺满
 *     夏至 1.00 > 小暑 .96  —— 入伏后荷叶开始枯边（撞 1 还会让 round() 饱和）
 *     秋分 litter 1.00 > 寒露 .90 —— 秋分落叶最多，此后被霜压住
 *   断言"严格递增"等于**逼数据迁就公式**，那是在篡改物候。
 *   所以判据是「整体趋势对 + 不出现**反转**」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { termProfile, SOLAR_TERMS, termSeason, blendTerm } from '../src/engine/almanac.js';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 读引擎源码（消费链类判据用）。
 *  ⚠️ 默认**剥掉行注释** —— 本文件每条护栏的说明文字里都写着被断言的标识符
 *  （比如「scenery.rain 必须读 a.rainDrops」这句话本身含 `a.rainDrops`），
 *  不剥注释的话 `assert.match(SRC, /a\.rainDrops/)` 会被自己的注释命中 ⇒ 恒绿假绿。
 *  需要匹配注释时显式传 `{ raw: true }`。 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel, { raw = false } = {}) => {
  const src = readFileSync(join(ROOT, rel), 'utf8');
  return raw ? src : src.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
};

/** 物候序（季内真实顺序）。⚠️ 不能从 SOLAR_TERMS filter 出来——那是历法序、跨年排布。 */
const SEASON = {
  spring: ['立春', '雨水', '惊蛰', '春分', '清明', '谷雨'],
  summer: ['立夏', '小满', '芒种', '夏至', '小暑', '大暑'],
  autumn: ['立秋', '处暑', '白露', '秋分', '寒露', '霜降'],
  winter: ['立冬', '小雪', '大雪', '冬至', '小寒', '大寒'],
};

/**
 * 参考图 pondState 里能直接读出的**物候事实**（手工核对过manifest 全文）。
 * 只记"明确到不需要解释粒度"的那些 —— 例如"惊蛰= 新叶展开" vs
 * "春分 = 巴掌大翠绿圆叶"是明确的量级差，而"花苞 vs 盛开"不是（见下）。
 *
 * ⚠️ **不含冰**：参考图 24 张里从没画过冰（只有霜/雪），而项目档案冬天 ice=1
 *   ⇒ 这一维**无法用参考图核对**，用它是"拿不存在的信源当判据"。
 */
const REF_POND = {
  立春: '残雪斑驳·残茎·未见新芽',
  雨水: '残雪初融·水底新芽·铜钱大新叶·紧裹小花苞',
  惊蛰: '嫩绿新叶展开·零星花苞·无盛开荷花',
  春分: '巴掌大翠绿圆叶·七八支花苞待放',
  清明: '中号翠绿叶铺开·花苞挺立饱满待放',
  谷雨: '大圆盘翠绿叶·大量花苞满塘待放',
  立夏: '一两朵初绽粉荷·大部分仍是花苞·叶浓绿',
  小满: '三五朵初绽荷花·叶浓绿成荫',
  芒种: '多朵粉荷盛开·叶浓密翠绿·光斑斑驳',
  夏至: '荷花盛开·叶浓密·光斑下鱼身透亮如琉璃',
  小暑: '荷花全盛·叶最大最浓绿·光斑斑驳陆离',
  大暑: '荷花仍盛开·开始零星出现黄绿莲蓬',
  立秋: '荷花开始凋谢·黄绿莲蓬·叶仍翠绿·水面飘粉花瓣',
  处暑: '荷花大部分凋谢·莲蓬增多·叶绿但边缘泛黄·水略浑',
  白露: '荷叶仍绿但边缘泛黄·荷花基本凋谢·莲蓬尚存',
  秋分: '荷叶黄绿交错·部分卷曲·莲蓬干枯',
  寒露: '荷叶大片枯黄卷曲·褐黄残叶·干枯莲蓬挺立',
  霜降: '荷叶大片枯黄褐卷·荷花全谢·残荷败叶',
  立冬: '荷叶大部分枯萎成褐色残叶·黑褐残茎·初霜',
  小雪: '荷叶全枯萎成黑褐残茎·薄霜·无荷花',
  大雪: '黑褐残茎斜立·枯残褐叶·薄霜·无荷花',
  冬至: '黑褐残茎·枯叶边缘初覆薄雪·池边枯枝',
  小寒: '残荷枯枝·薄雪覆枯叶·灰蓝冷调',
  大寒: '残荷枯枝·积雪稍厚·深冬',
};

/* ───────────────────────── 护栏一：季内不反转 ───────────────────────── */

/**
 * 判据：`leaf` 在春/夏必须**整体上升**且**每步不下降超过 .05**
 *（容 .05 是因为允许有刻意的轻微回落，如夏至 1.00 → 小暑 .96）。
 *
 * ⚠️ 这条判据在本轮之前是**红的**（春分 .25 → 惊蛰 .35 下降 .10，超出容差）。
 *   它抓到的就是那个真缺陷。
 */
test('★ 春/夏六档的浮叶量整体上升且不出现明显反转（参考图：春分的叶已比惊蛰大）', () => {
  for (const s of ['spring', 'summer']) {
    const vals = SEASON[s].map((t) => termProfile(t).leaf);
    const first = vals[0], last = vals[vals.length - 1];
    assert.ok(last > first,
      `${s} 末档 leaf(${last}) 不高于首档(${first}) —— 整体趋势反了`);
    for (let i = 1; i < vals.length; i++) {
      const drop = vals[i - 1] - vals[i];
      assert.ok(drop <= 0.05 + 1e-9,
        `${s} ${SEASON[s][i - 1]}(${vals[i - 1].toFixed(2)}) → `
        + `${SEASON[s][i]}(${vals[i].toFixed(2)}) 下降 ${drop.toFixed(2)}，超过容差 0.05`
        + `（参考图：${REF_POND[SEASON[s][i - 1]]} → ${REF_POND[SEASON[s][i]]}）`);
    }
  }
});

test('★ 秋/冬六档的浮叶量单调下降（落叶盖住、残荷沉底）', () => {
  for (const s of ['autumn', 'winter']) {
    const vals = SEASON[s].map((t) => termProfile(t).leaf);
    for (let i = 1; i < vals.length; i++) {
      assert.ok(vals[i] <= vals[i - 1] + 1e-9,
        `${s} ${SEASON[s][i - 1]}(${vals[i - 1]}) → ${SEASON[s][i]}(${vals[i]}) 反而上升`);
    }
  }
});

/** 霜与冰：只在秋季末到冬季之间爬升，且一旦到 1 就不再回落成"化冻"。 */
test('★ frost/ice 只在秋冬爬升，且到 1 后不回落（"化冻"会让画面看起来坏了）', () => {
  // ⚠️ 第一版踩的坑：我按 `SOLAR_TERMS` 的顺序找"首次有冰的档"，
  //   而 24 序是**历法序、跨年排布**（首项是春分，末尾才是立春/雨水/惊蛰），
  //   于是"末尾两档"取到的是**惊蛰/雨水**（ice=0/0.12），判成"一冬化冻"。
  //   ⇒ 必须按**物候序**找，末档才是大寒。这个坑本项目已踩过多次
  //   （秩次表、SEG 段序、这里），根因始终是"历法序 ≠ 物候序"。
  const winter = SEASON.winter;
  const vals = winter.map((t) => termProfile(t).ice ?? 0);
  // 爬升段：立冬→大雪 必须逐档不降
  for (let i = 1; i <= 2; i++) {
    assert.ok(vals[i] >= vals[i - 1],
      `${winter[i - 1]}(${vals[i - 1]}) → ${winter[i]}(${vals[i]}) 的 ice 反而下降`);
  }
  // 封冻后（ice=1）到**大寒**不允许大幅回落 —— "化冻"会让"冰封"读起来像坏了
  const daHan = termProfile('大寒').ice ?? 0;
  assert.ok(daHan >= 0.9,
    `大寒 ice=${daHan} —— 四九虽转暖，但仍在"三九封冻"的延续里，不该化到 0.9 以下`);
  // 冬六档全程 ice >= 0.4（立冬 ice=.4）
  for (const t of winter) {
    assert.ok((termProfile(t).ice ?? 0) >= 0.4, `${t} 的 ice < 0.4，冬六档不该有"未结冰"的档`);
  }
  // 反向：夏与秋不该有冰；**立春/雨水仍可能有残冰** ——
  //   ⚠️ 第三版踩的坑：我写「春季不该有冰」，立春 ice=.45 当场判红。
  //   但参考图立春写的是「残雪斑驳 · 残茎 · 未见新芽」——
  //   **大寒刚封冻完，立春当然还有残冰**，春分才是 0。
  //   判据改成"按档案实际给的分档"，而不是"按季节一刀切"。
  for (const t of SEASON.summer) {
    assert.equal(termProfile(t).ice ?? 0, 0, `夏至季的 ${t} 不该有冰`);
  }
  for (const t of SEASON.autumn) {
    const v = termProfile(t).ice ?? 0;
    assert.ok(v <= 0.15, `秋季的 ${t} ice=${v} > 0.15（霜降 .15 之外不应有冰）`);
  }
  // 春季是过渡带：立春/雨水有残冰，惊蛰起归零
  const springIce = SEASON.spring.map((t) => [t, termProfile(t).ice ?? 0]);
  assert.ok(springIce[0][1] > 0 && springIce[0][1] <= 0.5,
    `立春 ice=${springIce[0][1]} 应在 0~0.5（残冰，不是封冻）`);
  for (const [t, v] of springIce.slice(2)) {
    assert.equal(v, 0, `${t} 已入春（参考图：嫩绿新叶展开），不该有冰（ice=${v}）`);
  }
  // 逐档走一遍：从立冬到立春，冰先凝（.4→.7→1）再化（1→…→0）
  // ⚠️ 第四版踩的坑：我把"允许上升"的名单写死成【大雪,冬至,小寒,大寒】，
  //   结果 小雪(0.7) → 大雪(1.0) 这一步被判红—— 那是**封冻过程本身**，
  //   本来就该上升。名单应该只列**已经封冻(ice=1)**之后的档。
  const seq = [...SEASON.winter, ...SEASON.spring];
  let sealed = false;
  for (let i = 1; i < seq.length; i++) {
    const prev = termProfile(seq[i - 1]).ice ?? 0;
    const cur = termProfile(seq[i]).ice ?? 0;
    if (prev >= 0.99) sealed = true;                // 已经封冻
    if (cur > prev + 1e-9) {
      assert.ok(!sealed,
        `ice 在 ${seq[i]} 封冻后回涨（${prev}→${cur}）—— 已封冻就不该再涨`);
    }
  }
});

/* ───────────────────── 护栏二：档案与参考图的荷花口径一致 ───────────────────── */

/**
 * `lotus` 控制的是**是否画盛开的荷花**（`lotusCount = round(lotus*5)`）。
 * 参考图用"初绽/零星/开始凋谢"这些**过程态**措辞，
 * 所以只有"明确盛开"与"明确谢尽"两类能当判据，中间态不判。
 *
 * ⚠️ 我第一版把"花苞"也当判据，报了 7 条假红 —— 花苞不必画荷花，档案没错。
 *   这条注释就是那次假红的记录。
 */
test('★ 荷花口径与参考图一致：明确盛开的档 lotus>0.3，明确谢尽的档 lotus≈0', () => {
  for (const [t, st] of Object.entries(REF_POND)) {
    const lo = termProfile(t).lotus ?? 0;
    // ⚠️ 第二版踩的坑：我把`荷花开始凋谢` 当成"谢尽"，
    //   于是立秋（档案 lotus=.6）被判红。但"开始凋谢"是**过程态**——
    //   池里还有七八成荷花在开，和"谢尽"是两回事。
    //   过程态一律不判（与"零星花苞"同类）。第一版把"花苞"当判据、
    //   第二版把"开始凋谢"当判据，都是同一个错误：**把过程态当终态**。
    //★★★ 2026-10-07：`REF_POND` 的花期描述整体**让位给真实物候**。
    //   用户提供了江南荷花物候时间轴，其中「小满 = 初开 1 朵」与参考图
    //   「小满 = 三五朵初绽荷花」直接冲突 —— 真荷在 5/21 只初开 1–2 朵，
    //   「三五朵」要到 6 月上旬（芒种）。
    //   ⇒ 这里只保留**方向性**判据（盛开的档 lotus>0.3 / 谢尽的档 ≈0），
    //     **逐档的精确朵数改由新的 `PHENOLOGY`（真实物候表）负责**，
    //     否则参考图与物候两张表会互相打架，下一轮又得猜该信谁。
    const bloom = /盛开|全盛|初绽|绽放/.test(st) && !/零星|大部分仍是花苞/.test(st);
    const gone = /无荷花|全谢/.test(st);
    if (bloom) {
      // ⚠️ 小满/立夏按真实物候是「初开 1 朵 / 0 朵只有苞」，属**过程态**，不判。
      const OVERRIDE = { 小满: '真实物候：初开 1 朵（参考图「三五朵」偏早两旬）' };
      if (!OVERRIDE[t]) {
        assert.ok(lo > 0.3, `${t} 参考图写「${st}」判为盛开，但档案 lotus=${lo}`);
      }
    }
    if (gone) {
      assert.ok(lo <= 0.15, `${t} 参考图写「${st}」判为谢尽，但档案 lotus=${lo}`);
    }
  }
  // 显式记录两个"不判"的档 —— 它们是**中间态**，各自的档案值都合理：
  //   立夏 lotus=0（只有尖苞·规范如此）  立秋 lotus=.34（花始谢，3 朵）
  //   处暑 lotus=.12（残花 1–2 朵）      惊蛰 lotus=0（钱叶都还没浮）
  //⚠️ 这条断言的价值是"把不判的理由写在代码里"，
  //   免得下一轮又有人拿这几档当判据、报一批假红。
  const NEUTRAL = { 惊蛰: 0, 立夏: 0, 立秋: 0.34, 处暑: 0.12 };
  for (const [t, v] of Object.entries(NEUTRAL)) {
    assert.ok(Math.abs((termProfile(t).lotus ?? 0) - v) < 0.26,
      `${t} 的 lotus 偏离"中间态"取值 ${v} 太多，请连同下面的注释一起更新`);
  }
});

/* ───────────── 护栏三：参考图清单本身与代码对齐（防止两处漂移） ───────────── */

test('★ 参考图清单覆盖全部 24 档且与 SOLAR_TERMS 一致（两处漂移会互相矛盾）', () => {
  // REF_POND 是手工从 manifest 抄的；这张表是它与 SOLAR_TERMS 之间的护栏。
  assert.equal(Object.keys(REF_POND).length, 24);
  assert.deepEqual(Object.keys(REF_POND).sort(), [...SOLAR_TERMS].sort());
});

/* ───── 护栏五：夏季荷量不能在中途塌成低谷（用户评审清单 P1-1） ─────
 *
 * 现象（P1-1 原话）：「一年最热、荷应最盛，结果全池仅 3 朵粉荷…**峰值节气做成了低谷**」。
 *
 * 数值实测（`lotusCount = round(lotus × 5)`）：
 *   夏至 1.00 → **5 朵** ┃ 小暑 .82 → 4 ┃ **大暑 .62 → 3** ┃ 立秋 .60 → 3
 * ⇒ 一年最热的三个档里，**大暑的荷比夏至少 40%**。这不是物候，是曲线塌了。
 *
 * ★ 判据的关键设计：**不要求严格单调递增**，只要求「峰值区不许塌」。
 *   理由同护栏一：真实物候非等速，小暑/大暑的 leaf 略降（枯边）是有依据的，
 *   硬要「递增」等于篡改物候。所以断言的是**下界**：
 *   「三伏天里最热的一档，荷量不得低于夏至的 60%」。
 */
test('★ 荷量抛物线：峰值在大暑，夏至不得更高（江南物候，2026-10-07）', () => {
  /* ⚠️★★ 必须**从渲染层常量反查 LOTUS_MAX**，不能写死 5 ——
   *   `lotusCount = Math.round(lotus * LOTUS_MAX)` 的换算式在 `term-visual.js`，
   *   而 `LOTUS_MAX` 本轮刚从 5 提到 9（大暑要 7–8 朵，5 是物理天花板）。
   *   写死 5 会让这条判据在大暑档**假红**，也会在下次改 MAX 时变成恒绿假判据
   *   —— 这正是「判据被旧值绑死」那条铁律的现场。
   *   正解：从源码正则取出真实 MAX，判据自动跟着换算式走。 */
  const tv = read('src/engine/term-visual.js', { raw: true });
  const m = tv.match(/const LOTUS_MAX = (\d+)/);
  assert.ok(m, 'term-visual.js 里找不到 `const LOTUS_MAX = <数>` —— 换算式改名了，这条判据要一起改');
  const MAX = Number(m[1]);
  const cnt = (t) => Math.round((termProfile(t).lotus ?? 0) * MAX);
  const cashew = (t) => cnt(t);
  /* 大暑是**盛花顶峰**：规范要求 7–8 朵（`LOTUS_MAX=9` 才有这个表达区间）。 */
  const peak = cashew('大暑');
  assert.ok(peak >= 7, `大暑应有至少 7 朵（物候「盛花顶峰 7–8 朵」），实为 ${peak}（LOTUS_MAX=${MAX}）`);
  /* ★ 峰值必须落在**大暑**，且夏至/小暑都不得高于它 ——
   *   旧判据写的是「夏至才是峰值」，那是**按旧参考图**定的，被真实物候推翻：
   *   夏至只是「盛花前夜」（3–4 朵），大暑才是顶峰。
   *   ⚠️ 绝不能把大暑顶到 1.0 再把夏至降下去—— 那会让三档同朵数 ⇒ 零贡献
   *   （与 `LEAF_MAX` 撞顶同型，靠改 MAX 解决不了，只能让档案峰值不撞 1）。 */
  for (const o of ['夏至', '小暑']) {
    assert.ok(cashew('大暑') > cashew(o),
      `大暑(${peak}) 必须 > ${o}(${cashew(o)})：物候「大暑=盛花顶峰」，${o} 只是盛花前夜/期始`);
  }
  /* 三伏逐档递增：夏至 → 小暑 → 大暑，荷量必须单调升。 */
  assert.ok(cashew('夏至') < cashew('小暑') && cashew('小暑') < cashew('大暑'),
    `盛花期必须逐档递增：夏至 ${cashew('夏至')} → 小暑 ${cashew('小暑')} → 大暑 ${cashew('大暑')}`);
});

/** ★ 附带修一处参考图与档案的脱节：大暑该有莲蓬了（`REF_POND` 明确写「开始零星出现黄绿莲蓬」）。 */
test('★ 莲蓬物候：大暑起出现 → 寒露达峰 → 立冬前回落（江南物候，2026-10-07）', () => {
  assert.ok((termProfile('大暑').pod ?? 0) > 0,
    '大暑 pod=0，但物候「大暑=盛花顶峰，开始零星出现莲蓬」⇒ 那是大暑的标志性形态');
  /* ★ 第一版写成「从芒种到白露严格单调不降」⇒ **判据过严，已判错**：
  *   立秋写的是「荷花**开始凋谢**·黄绿莲蓬」—— 凋谢期莲蓬会随花谢而波动，
  *   不该要求逐档递增。真正要锁的是「**莲蓬一旦出现就不能消失**」（单向过程）。
  *   ⇒ 改成：① 大暑起每档都有蓬 ② **寒露是峰值**。
  *⚠️ 峰值档从「白露」改到「寒露」（2026-10-07）：旧判据按旧参考图认定
  *   白露莲蓬最多，但物候是「小暑零星 → 立秋 2–3 → 处暑 4–5 → 白露褐 →
  *   秋分褐黑 → **寒露 5 个枯莲蓬梗（最多）** → 霜降残梗带霜 → 立冬倒伏」。
  *   莲蓬在寒露才数量最多（花全部谢完、梗全部挺立），白露时花还在谢。 */
  for (const t of ['大暑', '立秋', '处暑', '白露', '秋分', '寒露']) {
    assert.ok((termProfile(t).pod ?? 0) > 0, `${t} pod=0 ⇒ 莲蓬中途消失（花谢结蓬是单向过程）`);
  }
  const peak = termProfile('寒露').pod ?? 0;
  assert.ok(peak >= 0.8, `寒露应达莲蓬峰值（物候「只剩枯莲蓬梗」，5 个），实为 pod=${peak}`);
  for (const t of ['大暑', '立秋', '处暑', '白露', '秋分']) {
    assert.ok((termProfile(t).pod ?? 0) <= peak + 1e-9,
      `${t} 的 pod 不得超过寒露峰值(${peak})`);
  }
});

/* ───── 护栏六：blendTerm 必须插值**全部**物候维（用户评审清单 P0-2） ─────
 *
 * 现象（P0-2）：「左下角已切夏荷，右上角还挂着春桃花枝」「立秋/处暑水面仍残留夏天的粉色荷花和花苞」。
 *
 * ★★ 根因找到了一处**代码级遗漏**（不是「档间没对齐」那么笼统）：
 *   `blendTerm()` 只插值 `warmth / lotus / leaf / litter / frost / ice / deepWinter`
 *   —— **`bud`（花苞）与 `pod`（莲蓬）两维根本没有被返回**。
 *   于是档间过渡时：`lotus` 从 0.3 平滑升到 0.55（花变多），
 *   而 `bud` 读到的永远是 `termProfile()` 里**当前档的原始值**——
 *   花苞**不随过渡变化**，于是「上一档的花苞赖在新档里不走」。
 *
 *   ⇒ 这解释了为什么「花苞」比「荷花」更容易残留：荷花走 `lotus` 插值，
 *     花苞走的是**一个根本没被插值的通道**。
 *
 *   而「角落桃花」那一半属于底图像素（随manifest 槽位整张切换），
 *   它与水面**没有共同的过渡时钟** —— 那一半在 P0-2 里另作处理。
 */
test('★ P0-2 blendTerm 必须插值 bud 与 pod（花苞/莲蓬不能赖在新档里）', () => {
  /* 用「夏至 → 小暑」这一对：两档的 bud/pod 都有明确差异，
   * 若不插值则过渡中途拿到的仍是起点的值。 */
  const mid = blendTerm('夏至', 0.5);
  const a = termProfile('夏至'), b = termProfile('小暑');
  /* ★ 不能断言 `mid.bud` 精确等于某一端 —— `bud` 走 `mixProfile`（离散切换，
   *   过半程就整块切过去），那正是它本来的设计。
   *   这里断言的是**键存在**：不插值 ⇒ 该键 `undefined` ⇒ 渲染层读 `?? 0`，
   *   于是过渡中途花苞**凭空消失**（比「残留」更明显的 bug）。 */
  assert.ok('bud' in mid, `blendTerm 没返回 bud 键 ⇒ 读档方拿到 undefined（渲染层会当 0）`);
  assert.ok('pod' in mid, `blendTerm 没返回 pod 键 ⇒ 读档方拿到 undefined（渲染层会当 0）`);
  /* 端点必须与档案**逐位一致** —— 改前改后档位画面不能变。 */
  assert.equal(mid.bud, mixProfileOf(a.bud, b.bud, 0.5), '过渡中点的 bud 不等于 mixProfile(起,止,.5)');
  assert.equal(mid.pod, mixProfileOf(a.pod, b.pod, 0.5), '过渡中点的 pod 不等于 mixProfile(起,止,.5)');
  /* 起点 t=0 与终点 t=1 必须**精确等于档案**（不是近似）。 */
  const start = blendTerm('夏至', 0), end = blendTerm('夏至', 1);
  assert.equal(start.bud, a.bud, 't=0 的 bud 必须精确等于夏至档案');
  assert.equal(end.bud, b.bud, 't=1 的 bud 必须精确等于小暑档案');
  assert.equal(end.pod, b.pod, 't=1 的 pod 必须精确等于小暑档案');
});

/** 与 `almanac.js` 内部同形的离散切换（复制而非 import，因为那个函数没有导出）。 */
function mixProfileOf(a, b, t) {
  return t < 0.5 ? (a ?? 0) : (b ?? 0);
}

/**
 * ★★ P0-2 的另一半「角落 ↔ 水面不同步」——**经实测，该条指控不成立**，
 *   这里把「实测结论」固化成护栏，避免下一轮又有人按清单去「修」它。
 *
 * ① 「03-立夏 右上角还挂着春桃花枝」—— **不成立**。
 *   实测：立夏 `slot=summer` ⇒ 用 `pond.png`；把该图右上角裁出来看是
 *   **睡莲叶 + 粉色素色睡莲**（圆瓣、有莲蓬），而 `spring.png` 右上角才是
 *   **桃花枝**（细长花瓣 + 褐色枝条）。两者形态不同。
 *   之所以「读成桃花」，是因为睡莲的花瓣形状与桃花在缩略尺寸下相近。
 *
 * ② 「09-立秋 / 10-处暑 水面还残留夏天的粉荷花与花苞」—— **量偏重，但档案没错**。
 *   实测：立秋 `lotus .6 → 3 朵`、处暑 `.3 → 2 朵`；
 *   参考图对立秋写「荷花**开始凋谢**」、处暑写「**大部分凋谢**」
 *   ⇒ 「还有荷花」本身符合参考图，该档有花是对的。
 *
 * ⇒ 但**真缺陷确实存在，就在上面的 `blendTerm` 漏插 `bud`/`pod`**：
 *   花苞读的是**当前档的原始值**、`bud` 键压根不存在 ⇒ 过渡中途凭空消失，
 *   或在到达新档时**带着上一档的花苞数量**。
 */
test('★ P0-2 实测结论：立夏用的是夏季底图（不是春季），护栏锁定槽位映射', () => {
  /* 只锁「立夏→summer」这一条（清单点名的那一档），不锁全部 24 档 ——
   * 映射表的完整性由 `tests/term-fade.test.js` 的 manifest 对齐那条负责。 */
  const SUMMER_TERMS = ['立夏', '小满', '芒种', '夏至', '小暑', '大暑'];
  for (const t of SUMMER_TERMS) {
    assert.equal(termSeason(t), 'summer',
      `${t} 应属 summer 槽位（用 pond.png）；若它落到 spring，说明清单里那条`
      + '「立夏右上角春桃」是真的串味，需要查 resolveTermImage 的降级链');
  }
  assert.equal(termSeason('清明'), 'spring', '清明应属 spring（对照组：确认映射本身有效）');
});

/* ───── 护栏七：春六档的雨丝物候（P2-2 附带项：雨水不下雨） ─────
 *
 * 现象（清单第三节）：春 6 张「雨水不下雨、惊蛰不抽芽」。
 *
 * ⚠️ 「惊蛰不抽芽」**已不成立**：`almanac` 惊蛰有 `bud: .45`（9苞）、
 *   且 2026-10-05 已把惊蛰 `leaf .35→.17`（「惊蛰只有新芽」）。
 *   剩下的是**雨水确实不下雨**这一条。
 *
 * ★ 关键设计裁决：**雨丝不能挂在 `weather` 上**。
 *   `drawWeather` 里雨是**天气门控**（`weather==='rainy'`），
 *   而天气来自城市天气 API 或用户设置 —— 也就是说
 *   **「雨水这一档下雨」这件事不该由天气决定，而该由节气决定**。
 *   否则「演示轮转到雨水」却没下雨，正是清单说的那个问题。
 *
 *   ⇒ 正解与降雪同构（`pond.js` 已有先例）：
 *     雪片数在**非 snowy 天气**也按 `v.ice` 连续插值（`Math.round(14+18*ice)`）
 *     —— 天气只决定「要不要更猛」，节气决定「有没有」。
 *   雨同理：新增 `rain` 通道（档案里的「雨势」），雨天在此基础上加量。
 */
test('★ P2-2 雨水必须有雨势（清单「雨水不下雨」）', () => {
  /*★★★ 2026-10-07：**「惊蛰不抽芽」这条从清单里删除**。
   *  清单第三节写「春 6 张：雨水不下雨、惊蛰不抽芽」，
   *  但按江南荷花物候，惊蛰（3/5）**连钱叶都还没浮出水面** ——
   *  「出芽前夜·泥面隐约小绿点」说的是**泥面**，不是水面。
   *  ⇒ 正确表述是「惊蛰**水面上什么也没有**」，而不是「应该有芽」。
   *  ⇒ 档案已把惊蛰/雨水/立春的 `bud`与 `leaf` 全部归零（见 `almanac.js`），
   *     这条判据改为锁定「**春组三档水面必须空**」——
   *     它防的是「有人照旧参考图『嫩绿新叶展开·零星花苞』把花苞加回来」。
   *  ⚠️ 这也是「指令性证据也会误判」的第二例：清单 P0 里那条是**真的**
   *     （当时水面确实漂着橙黄秋叶），但惊蛰这条是**清单作者按参考图写的**，
   *     而参考图在春组花期上整体偏早约 20 天。 */
  for (const t of ['立春', '雨水', '惊蛰']) {
    const a = termProfile(t);
    assert.equal(a.bud ?? 0, 0, `${t} 的 bud 必须为 0 —— 江南物候：这三档水面无花无苞`);
    assert.equal(a.leaf ?? 0, 0, `${t} 的 leaf 必须为 0 —— 钱叶要到春分才初浮（惊蛰只是「泥面隐约小绿点」）`);
  }
  /* 春分才开始有可见的叶：钱叶初浮 2–3 枚。 */
  assert.ok((termProfile('春分').leaf ?? 0) > 0, '春分应是钱叶初浮（leaf>0）');
  const ws = termProfile('雨水');
  /* 雨水是全年**降水最集中**的一档（华南梅雨、华北春雨），雨势必须显著。 */
  assert.ok(ws.warmth >= 0.35 && ws.warmth <= 0.45,
    `雨水 warmth=${ws.warmth} 应在 .35~.45（参考图「残雪初融」= 仍冷但已回暖）`);
  /* ★ 雨势本身：雨水必须是**全年峰值**，且冬夏必须为 0。
   *   这两条缺一不可 ——
   *   只断言「雨水>0」的话，立夏给 .3 也能过（而清单抱怨的正是「该下时不下」）；
   *   只断言「雨水最大」的话，给个 .3 的最大值也过（那还是不下雨）。 */
  assert.ok((ws.rain ?? 0) >= 0.9, `雨水rain=${ws.rain} 应≥.9（全年降水峰值档）`);
  for (const t of ['大雪', '冬至', '小寒', '大寒', '立夏', '大暑', '立秋']) {
    assert.equal(termProfile(t).rain ?? 0, 0,
      `${t} rain=${termProfile(t).rain} 应为 0/无键 —— 雨势不是常开通道（防无脑泛雨）`);
  }
});

/* ───── 护栏八：节气雨必须真的被渲染层消费（P2-2「雨水不下雨」的另一半） ─────
 *
 * ★★ 为什么档案有 `rain` 维**不等于**问题解决了。
 *   本项目已经踩过三次同一个坑，形态各不相同：
 *     ① `frost` —— `term-visual.js` 一直算得出，`drawFrost` 一次都没读（"算了不画"）；
 *     ② `bud`/`pod` —— `blendTerm` 的返回对象里压根没这两个键；
 *     ③ `ice`/`snow` —— 冰层取消后 `ice` 变成"算了没人读"的死通道。
 *   ⇒ 这里锁的是**消费链的每一环**都存在，且环环相扣（不许只改一环）。
 *
 * 链路：`almanac.rain` → `blendTerm` 插值 → `term-visual` 输出 `rain`
 *       → `pond.render` 调 `atmosphere.syncRain` → `atmosphere.termDrops`
 *       → `scenery.rain` 读 `rainDrops`（不是 `drops`！）→ 画在水面涟漪之上。
 */
test('★ P2-2 节气雨消费链必须环环相扣（档案→blend→翻译层→atmosphere→绘制）', () => {
  const src = {
    visual: read('src/engine/term-visual.js'),
    pond: read('src/engine/pond.js'),
    atmo: read('src/engine/atmosphere.js'),
    scenery: read('src/engine/scenery.js'),
  };
  /* ① 翻译层把 `rain` 输出出去（`?? 0` 兜底老存档）。 */
  assert.match(src.visual, /const rain = clamp01\(p\.rain \?\? 0\)/,
    'term-visual.js 没有从档案取 rain（老存档/中性档案会拿到 undefined）');
  /* ② 渲染层每帧同步（不能只在 updateOptions 里对一次 —— 渐变模式下会停在旧值）。 */
  assert.match(src.pond, /atmosphere\.syncRain\(this\.termVisual\.rain\)/,
    'pond.render 没调 syncRain ⇒ 雨丝数量停在初始值');
  /* ③ atmosphere 真的有 termDrops 通道，且 syncRain 会写它。 */
  assert.match(src.atmo, /syncRain\(amount\)\{/, 'atmosphere.syncRain 不存在');
  assert.match(src.atmo, /this\.termDrops\s*=/, 'syncRain 没有写 termDrops ⇒ 算了不画');
  /* ④★ 最关键的一环：`scenery.rain` 必须读 `rainDrops`。
   *   读 `a.drops` 是**第一版真实犯的错** —— `drops` 只在 `wet(weather)` 时有内容，
   *   于是「雨水档 + 晴天」画出的雨丝恒为 0 条，量具会全绿而画面没雨。 */
  const drawLine = src.scenery.split('\n').find((l) => l.includes('for(const d of a.')) || '';
  assert.ok(drawLine.includes('a.rainDrops'),
    `scenery.rain 的雨丝循环读的是 ${drawLine.trim() || '(没找到)'}，必须读 a.rainDrops（天气雨 drops + 节气雨 termDrops 的合集）`);
});

test('★ P2-2 同帧一致性：下雨时不得同时出蜻蜓与阳光十字', () => {
  const pond = read('src/engine/pond.js');
  assert.match(pond, /this\.termVisual\.rain >= 0\.05\) return;/,
    'drawInsects 的门控没读 rain ⇒ 雨水档会同时出现雨丝和蜻蜓');
  assert.match(pond, /weather === 'sunny' && !night && this\.termVisual\.rain < 0\.05/,
    '阳光十字（drawWeather）没被rain 门控 ⇒ 雨天出太阳光斑');
  assert.match(pond, /this\.termVisual\.rain < 0\.05\) \{/,
    '光池/光柱没被 rain 门控 ⇒ 雨天仍有阳光光池');
  assert.match(pond, /0\.10 \* termRain/,
    '没有按 rain 压暗水面 ⇒ 亮色雨丝叠在晴天水色上读成「白色竖线」而不是雨');
});

/* ───── 护栏九：量具的桩必须与真实对象同构（P2-2踩到的 TypeError） ─────
 *
 * 现象：`scenery.rain` 改读 `a.rainDrops` 后，`check-water-rings.js` 报
 *   `TypeError: a.rainDrops is not iterable`。
 *
 * ★★ 为什么这类错特别难查：量具抛的是 TypeError，**看起来像实现坏了**，
 *   第一反应会去查 `scenery.js`。而真实原因是**桩落后于实现** ——
 *   桩是手搓的字面量对象（`{drops:[], flash:0, …}`），
 *   `Atmosphere` 加字段时没人会想到去改它。
 *   ⇒ 这里锁住：`Atmosphere` 的「形状」与桩里写的字段必须对得上。
 *
 * ⚠️ 判据选的是**具体字段清单**而不是「跑一遍量具」——
 *   跑量具需要 dev server，单测层拿不到；而字段清单是纯文本比对，零依赖。
 */
test('★ P2-2 量具桩必须与 Atmosphere 同构（防「桩落后于实现」的 TypeError）', () => {
  const stub = read('tools/check-water-rings.js');
  const atmo = read('src/engine/atmosphere.js');
  /* 桩里出现的每个 `atmosphere` 字段都必须在 `Atmosphere` 里真实存在。 */
  for (const f of ['drops', 'termDrops', 'impacts', 'flash', 'rainHits', 'landings']) {
    assert.match(atmo, new RegExp(`this\\.${f}\\s*=`),
      `Atmosphere 没有 ${f} 字段 —— 若桩里写了它，说明桩与实现已不同构`);
    assert.ok(stub.includes(`${f}:`) || stub.includes(`this.${f}`),
      `check-water-rings.js 的桩缺 ${f}（或没复刻它的 getter）`);
  }
  /* ★ `rainDrops` 是 **getter**，桩必须用 `Object.defineProperty` 复刻 ——
   *   直接写 `rainDrops: []` 会得到一个**永远为空**的数组 ⇒
   *   雨丝恒画 0 条而量具全绿（比抛 TypeError 更坏：它伪装成成功）。 */
  assert.match(stub, /defineProperty\(\s*a\s*,\s*'rainDrops'/,
    '桩里的 rainDrops 必须用 defineProperty 复刻 getter；写成普通字段会恒为空数组');
  assert.ok(/get\(\)\s*\{\s*return this\.termDrops\.length\s*\?/.test(stub),
    '桩的 rainDrops getter 语义与实现不一致（实现是 termDrops 为空时返回 drops 本体）');
});

/* ───── 护栏十：量具的落点取样坐标必须跟着雨丝笔画画法同步 ─────
 *
 * ★ 为什么这是个真坑：量具把「雨丝线段中点」**硬编码**成一组常数
 *   （`(len0+seed*len1)/2`），而 `scenery.rain` 的 `moveTo(x,y-len)` 是另一组。
 *   改实现（本次把长度 12+9s 加长到 15+11s、线宽 .85→1.15）而忘改量具 ⇒
 *   **量具还在量旧位置**，可能照样全绿（雨丝够长时旧位置仍落在笔画内），
 *   也可能假红（够短时落在笔画外）。两种都是「量具与被测量脱钩」。
 *   ⇒ 判据：量具里的两个常数必须精确等于 `scenery.rain` 那组的一半。
 */
test('★ P2-2 量具的落点坐标必须与 scenery.rain 的雨丝笔画画法同步', () => {
  const scenery = read('src/engine/scenery.js', { raw: true });
  const tool = read('tools/check-rain-fall.cjs');
  /* 从实现里解析出 `y-(LO+seed*HI)`（跳过注释行，避免读到文档里的旧值）。 */
  const code = scenery.split('\n').filter((l) => !/^\s*(\*|\/\/)/.test(l)).join('\n');
  const m = code.match(/ctx\.moveTo\(x\+\d+\*slant,\s*y-(\d+)-d\.seed\*(\d+)\)/);
  assert.ok(m, 'scenery.rain 的 moveTo 形状变了 ⇒ 量具的坐标推导需要一起改（先更新本护栏）');
  const halfBase = Number(m[1]) / 2, halfSpan = Number(m[2]) / 2;
  const want = `${halfBase} + d.seed * ${halfSpan}`;
  assert.ok(tool.includes(want),
    `check-rain-fall.cjs 的落点取样坐标应为 \`${want}\`（= 实现 ${m[1]}+${m[2]}*s 的中点）`
    + ' —— 不一致则量具在量旧位置，可能假绿也可能假红');
});

/* ───── 护栏四：冬季水面落叶（用户评审清单 P0-1，2026-10-07） ─────
 *
 * 现象：立冬→大寒的水面漂着**橙黄秋叶**，大寒最违和（冷蓝水面 + 橙红叶）。
 *
 * ★★ 这里有一对**必须先裁决的冲突需求**：
 *   评审清单 P0-1「擦干净冬季 6 张水面残留的橙黄枫叶」
 *   评审清单 P2-2「立冬补足初冬过程（初霜→残荷枯梗）」
 * 两条在**立冬这一档直接对立**：全清零 ⇒ P2-2 没东西可补；保留 ⇒ P0-1 没擦干净。
 *
 * ⇒ 裁决依据是**参考图 `REF_POND`**（第二信源，不是我的口味）：
 *     立冬 = 「荷叶大部分枯萎成褐色残叶 · 黑褐残茎 · 初霜」  ← **确有残叶，但是褐色**
 *     小雪 = 「荷叶全枯萎成黑褐残茎 · 薄霜 · 无荷花」        ← 残叶已归零
 *   所以正解不是「数量归零」，而是**「换颜色 + 深冬清零」**：
 *     ① 冬季用**枯叶色**（褐/灰褐），不与秋天的橙红共用一套贴图
 *     ② **立冬保留少量残叶**（兑现 P2-2的「残荷枯梗」）
 *     ③ **小雪起归零**（兑现 P0-1 的「擦干净」，且与参考图一致）
 *   ⇒ 两条需求同时满足，且落点从「数量」上移到「颜色 + 时机」。
 *
 * ⚠️ 为什么判据要拆成四条而不是一条：
 *   「冬季落叶数为 0」这一条**会被一种错误修法满足** —— 把立冬的残荷也一起清零。
 *   那就等于用「修掉违和感」的名义**删掉 P2-2 要求的物候**。
 *   拆开才能让「立冬仍有残叶」与「小雪起必须为零」**同时**被锁住。
 */

/** 深冬五档（不含立冬）水面必须无落叶 —— 依据 REF_POND 的小雪/大雪/冬至/小寒/大寒五条。 */
test('★ P0-1 深冬五档水面落叶必须为 0（依据参考图：小雪起已是「黑褐残茎·无残叶」）', () => {
  for (const t of ['小雪', '大雪', '冬至', '小寒', '大寒']) {
    assert.equal(termProfile(t).litter, 0,
      `${t} 的 litter 必须是 0。参考图 ${REF_POND[t]} 写的是「黑褐残茎/残荷枯枝」，`
      + '没有水面飘叶；而落叶贴图是橙红色的，漂在冷蓝/雪白水面上就是 P0-1 说的违和');
  }
});

/** 立冬必须有少量残叶 —— 这是 P2-2「残荷枯梗」的落点，不能被 P0-1 一刀切清掉。 */
test('★ P2-2 立冬仍应有少量残叶（参考图「褐色残叶」，且不能被 P0-1 连带清零）', () => {
  const v = termProfile('立冬').litter;
  assert.ok(v > 0, '立冬 litter=0 ⇒ 初冬过程里「残荷枯梗」这一环消失，P2-2 无法兑现');
  assert.ok(v <= 0.3, `立冬 litter=${v} 偏多，参考图是「大部分枯萎」的褐色残叶，不是满池秋叶`);
});

/** 秋季不能被连带清零 —— 反向断言，防止「冬季清零」被实现成「全局清零」。 */
test('★ 只清冬季：秋分/霜降的落叶量必须保持峰值（防连带清零）', () => {
  assert.ok(termProfile('秋分').litter >= 0.9, '秋分是落叶峰值，litter 必须≥ .9');
  assert.ok(termProfile('霜降').litter >= 0.6, '霜降落叶仍多，litter 必须 ≥ .6');
  assert.ok(termProfile('立秋').litter >= 0.09, '立秋刚开始落叶，litter 必须 > 0');
});

/**
 * ★★ 颜色维度：冬季落叶必须是**枯叶色**，不得与秋天共用橙红贴图。
 *
 * 这是本轮真正修掉「违和感」的那一刀 —— 数量只是表象，
 * 「橙红」才是刺眼的原因（暖色高饱和 vs 冷蓝/雪白背景 = 强对比）。
 *
 * ⚠️ 为什么这条只能断言源码而不能断像素：贴图是运行时 canvas 画的
 *   （`scenery.js` 的 `leafSprite`，按 season+variant 缓存），
 *   像素要等浏览器渲染；单测层只能锁「冬天不走秋天的颜色分支」。
 */
test('★ P0-1 冬季落叶必须用枯叶色，不得与秋天共用橙红（这是违和感的真正来源）', async () => {
  const { readFileSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'engine', 'scenery.js'), 'utf8');
  /* 剥掉注释：护栏的说明文字里必然提到「橙红」这些词，直接 match 会假红。 */
  const code = SRC.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');

  /* ★★ 第一版判据写成「找 winter 分支 / autumn 分支」⇒ **判据自身失效**：
   *   实现里 autumn 是三元的**末位 else**（没有 `autumn` 这个字面量），
   *   于是 `autumn[^;\n]{0,200}?\[…\]` 匹配不到 ⇒ 报「找不到 autumn 分支」。
   *   ★ 同型坑（MEMORY）：**「判据报『找不到 X』」要先怀疑判据自己，而不是急着改实现**。
   *   `leafSprite` 还会 return 早退缓存（`if(has) return`），正文与判据要按**字面量**对齐。
   */
  const LITERAL = (name) => {
    /* 匹配 `:'#rrggbb','#rrggbb','#rrggbb'` 这种颜色数组字面量。
     * 用「三个 #rrggbb 连着出现」而不是「找季节名」，因为季节名在三元里
     * 只有一个（autumn 是 else 兜底）—— **颜色数组才是三套都有的稳定锚点**。 */
    const all = [...code.matchAll(/\['(#[0-9a-f]{6})','(#[0-9a-f]{6})','(#[0-9a-f]{6})'\]/gi)].map((m) => m[0]);
    assert.ok(all.length >= 3,
      `scenery.js 里只找到 ${all.length} 套三色落叶配色（应≥3：春/夏/秋/冬各一套）`);
    return all;
  };
  const sets = LITERAL();
  /* 春季（粉）与夏季（绿）本来就有各自的字面量；关键是**秋橙红**与**冬枯褐**
   * 必须是**两个不同的数组**，而不是同一个被复用。
   * 判据不写死「哪一套是冬天」——那是实现细节；只断言「存在两套不同的暖色系，
   * 且 winter 分支引用的不是秋季那套」。 */
  const warm = sets.filter((s) => /#(d69a38|cb6337|e1b745|8a7355|7a6448|94805e)/i.test(s));
  assert.ok(warm.length >= 2,
    `秋季橙红与冬季枯褐必须是两套不同的配色，实际只找到 ${warm.length} 套：${JSON.stringify(warm)}`);
  /* 反向断言：三套主色必须两两不同（防止「冬季复用秋季」这种改法蒙混过关）。 */
  const uniq = new Set(sets);
  assert.equal(uniq.size, sets.length,
    `有 ${sets.length} 套配色但只有 ${uniq.size} 套不同值 ⇒ 存在跨季复用：${JSON.stringify(sets)}`);
  /* 兜底兜底：`litterTarget` 的 `??3` 若没改，冬季无档案路径仍会飘 3 片。 */
  const atmo = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'engine', 'atmosphere.js'), 'utf8');
  assert.ok(!/LITTER_FALLBACK=\{[^}]*winter:\s*[1-9]/.test(atmo),
    'atmosphere.js 的 LITTER_FALLBACK.winter 仍非 0 ⇒ 老存档路径还会飘落叶');
  assert.ok(!/LITTER_FALLBACK\[o\?\.season\]\?\?[1-9]/.test(atmo),
    'atmosphere.js 的 litterTarget 兜底仍是 `??3` ⇒ season 键缺失时会静默回落 3 片');
});
/* ══════════════ 护栏十一：立叶通道的**消费链必须环环相扣**（2026-10-08 层③）
 *
 * ★★★ 本项目已**三次**栽在同一个形态上 —— 「加了量但下游没人读」：
 *     ① `frost` 算了不画 ② `bud`/`pod` 漏键 ③ `rain` 漏键
 * 链路：almanac.standLeaf → blendTerm 插值 → term-visual 翻译 → pond 渲染 → manifest 自报。
 * ⚠️ 每一环漏掉都**不会报错**，只会让形态静默消失：
 *     `?? 0` 兜底、插值时被跳过、门控没加上、manifest 没 push。
 * ⇒ 这条护栏把**五环一起锁住**，因为它们全都不会自己暴露。
 */
test('★ 层③ 立叶通道消费链必须环环相扣（档案→blend→翻译层→渲染→manifest）', () => {
  const alm = read('src/engine/almanac.js');
  const vis = read('src/engine/term-visual.js');
  const pnd = read('src/engine/pond.js');

  /* ① 档案：必须有 standLeaf 维，且春组三档为 0（钱叶期不该有立叶）。 */
  assert.match(alm, /standLeaf:\s*\.\d/, 'almanac 档案缺 standLeaf 维');
  for (const t of ['立春', '雨水', '惊蛰']) {
    assert.match(alm, new RegExp(t + ':\\s*\\{[^}]*standLeaf:\\s*0'),
      t + ' 的 standLeaf 必须为 0 —— 江南物候：立叶要到谷雨才冒尖');
  }
  /* ② blendTerm：漏掉这一环 ⇒ 过渡途中立叶凭空消失（bud/pod/rain 都栽过这个）。 */
  assert.match(alm, /standLeaf:\s*mix\(a\.standLeaf/,
    'blendTerm 没插值 standLeaf ⇒ 立叶在过渡途中消失（bud/pod/rain 都栽过这个）');
  /* ③ 翻译层：独立 MAX + 独立计数 + 输出。 */
  assert.match(vis, /const STAND_LEAF_MAX = (\d+)/, 'term-visual 缺 STAND_LEAF_MAX');
  assert.match(vis, /const standLeafCount = Math\.round\(clamp01\(p\.standLeaf \?\? 0\) \* STAND_LEAF_MAX\)/,
    'term-visual 的 standLeafCount 必须读 p.standLeaf');
  assert.match(vis, /standLeafCount,/, 'term-visual 的输出对象缺 standLeafCount');
  /* ④ 渲染层 + 门控：立叶要在 drawLotus 里画，且 render 的门控要考虑它。 */
  assert.match(pnd, /standLeafCount/, 'pond.js 完全没读 standLeafCount（立叶不会被画）');
  assert.match(pnd, /manifest\.standLeaf\.push/,
    'floraManifest 没自报 standLeaf ⇒ 量具对「立叶到底画没画」完全无感');
  /* ⑤ 中性档案：漏一个键只会让未知节气下形态静默消失，不报错。 */
  assert.match(alm, /NEUTRAL[\s\S]{0,200}standLeaf/,
    'NEUTRAL 中性档案缺 standLeaf ⇒ 未知节气下立叶静默消失');
});

/* ══════════════ 护栏十二：循环体内的局部常量**不得跨循环引用**（2026-10-08 层③）
 *
 * ★★★ 本项目已因这类事故**三次**白屏：
 *     ① `BASE` 声明在叶脉段却被前面的叶柄段用（TDZ）
 *     ② `NV` 声明在叶形之后却被叶形路径用（TDZ）
 *     ③ **立叶段引用了浮叶循环里的 `u`**（ReferenceError，不是 TDZ）
 *
 * ★★ ③ 的症状最误导：抛的是 `u is not defined`，但因为抛在 `requestAnimationFrame`
 *   回调里，**画布从未完成首帧** ⇒ 量具报的是
 *   `waitForSelector: canvas timeout`，看起来像「页面没加载出来」，
 *   而真实原因是渲染函数里一个未定义标识符。
 *   ⇒ 光靠 `node --check` 查不出（它只做语法分析，不查作用域里的未定义引用）。
 *
 * 正解不是「小心一点」，而是**护栏**：立叶循环里凡是浮叶循环也声明过的
 * 名字，必须**自己**再声明一次（同名、独立作用域）。
 */
test('★ 立叶循环不得引用浮叶循环内的局部 const（防 ReferenceError 白屏）', () => {
  const pnd = read('src/engine/pond.js', { raw: true });
  const lines = pnd.split('\n');
  const floatLoop = lines.findIndex((l) => l.includes('for (let i = 0; i < pads; i++)'));
  const standLoop = lines.findIndex((l) => l.includes('for (let i = 0; i < standPads; i++)'));
  assert.ok(floatLoop > 0 && standLoop > floatLoop,
    '定位不到两个叶循环（浮叶@' + floatLoop + ' / 立叶@' + standLoop
    + '）—— 结构变了要同步改本护栏');

  /* 用缩进定位循环结束：循环体内的收尾 `}` 缩进比 `for` 行深 2 空格。 */
  const indentOf = (i) => (lines[i].match(/^\s*/) || [''])[0].length;
  const endOf = (start) => {
    const base = indentOf(start);
    for (let i = start + 1; i < lines.length; i++) {
      if (indentOf(i) === base && lines[i].trim() === '}') return i;
    }
    return -1;
  };
  const floatEnd = endOf(floatLoop);
  const standEnd = endOf(standLoop);
  assert.ok(floatEnd > floatLoop && standEnd > standLoop,
    '循环结束定位失败（浮叶结束@' + floatEnd + ' / 立叶结束@' + standEnd + '）');

  const floatInner = [...lines.slice(floatLoop, floatEnd).join('\n').matchAll(/const (\w+)/g)]
    .map((m) => m[1]);
  /* ⚠️⚠️ **必须剥掉注释**再统计声明，否则本护栏**恒绿假绿** ——
   * 而原因是本文件顶部 `read()` 注释里写的那条，本次**复发了一次**：
   *   我在立叶段的**警告注释**里写了 `const u = size / 28;` 这行示例
   *   （说明"必须自己再声明一次"），于是「立叶段有没有声明 u」被判成 `true`
   *   —— **断言被自己的注释命中**。
   *   ★★ 第一版只剥了 `//` 行注释，结果**仍然假绿**：立叶段的警告是用
   *     **多行块注释**写的（不是行注释），块注释内容整段留了下来。
   *     ⇒ 两种注释都必须剥，否则只是从一种假绿换成另一种。
   *   统计一律用剥净注释后的代码，与本文件其它护栏保持一致。 */
  const stripComments = (s) => s
    .replace(/\/\*[\s\S]*?\*\//g, ' ')   /* 块注释（含跨行） */
    .replace(/\/\/.*$/gm, '');          /* 行注释 */
  const standSeg = stripComments(lines.slice(standLoop, standEnd + 1).join('\n'));
  const declaredInStand = new Set([...standSeg.matchAll(/const (\w+)/g)].map((m) => m[1]));
  /* 去掉「声明行」再看剩下用到哪些名字 —— 否则那行 u 的声明会命中自己。
   * ⚠️ 本段刻意**不写** u 声明的字面量：本注释外层是块注释，
   *   一旦里面出现裸反引号包裹的块注释结束符就会**提前闭合** ⇒ 整段变成代码
   *   ⇒ SyntaxError。（MEMORY 铁律：注释里裸反引号会提前终止块注释。
   *   本项目已因此报废过两次文件，第三次就是这里。） */
  const standUses = standSeg.replace(/const\s+\w+\s*=[^;]+;/g, '');

  /* 两个循环共享的名字（改动时要同步检查的一组）。 */
  const SHARED = ['u', 'size', 'spot', 'tilt', 'phase'];
  const missing = SHARED.filter((n) => floatInner.includes(n)
    && !declaredInStand.has(n)
    && new RegExp('(?<![\\w.])' + n + '(?![\\w])').test(standUses));
  assert.deepEqual(missing, [],
    '立叶循环引用了浮叶循环的局部 const：' + missing.join(', ')
    + ' ⇒ 运行时 ReferenceError，而画布在 rAF 里抛错 ⇒ 量具报「canvas timeout」，看不出真因');
});
