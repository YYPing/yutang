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
import { termProfile, SOLAR_TERMS } from '../src/engine/almanac.js';

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
    // ⚠️ 第二版踩的坑：我把 `荷花开始凋谢` 当成"谢尽"，
    //   于是立秋（档案 lotus=.6）被判红。但"开始凋谢"是**过程态**——
    //   池里还有七八成荷花在开，和"谢尽"是两回事。
    //   过程态一律不判（与"零星花苞"同类）。第一版把"花苞"当判据、
    //   第二版把"开始凋谢"当判据，都是同一个错误：**把过程态当终态**。
    const bloom = /盛开|全盛|初绽|绽放/.test(st) && !/零星|大部分仍是花苞/.test(st);
    const gone = /无荷花|全谢/.test(st);
    if (bloom) {
      assert.ok(lo > 0.3, `${t} 参考图写「${st}」判为盛开，但档案 lotus=${lo}`);
    }
    if (gone) {
      assert.ok(lo <= 0.15, `${t} 参考图写「${st}」判为谢尽，但档案 lotus=${lo}`);
    }
  }
  // 显式记录两个"不判"的档 —— 它们是**中间态**，各自的档案值都合理：
  //   惊蛰 lotus=.05（零星花苞，别画荷花）  立夏 lotus=.30（一两朵初绽，少量）
  //   立秋 lotus=.60（开始凋谢，但仍有花） 处暑 lotus=.30（大部分凋谢，剩莲蓬）
  //⚠️ 这条断言的价值是"把不判的理由写在代码里"，
  //   免得下一轮又有人拿这四档当判据、报一批假红。
  const NEUTRAL = { 惊蛰: 0.05, 立夏: 0.30, 立秋: 0.60, 处暑: 0.30 };
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