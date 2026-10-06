/**
 * 底图节气口径 + 8s 交叉淡入的**源码层护栏**。
 *
 * ★ 为什么像素量具之外还要源码护栏：
 *   `check-term-fade.cjs`（53 条）验的是**运行时的真实行为** —— 读 GPU 侧
 *   uFade、采样时间轴、注入反例。它抓不到「有人把 8s 改回 4s」以外的情况，
 *   也抓不到那些**只在特定路径下**才暴露的重构（比如把 `bgSeason` 悄悄
 *   改回读 `options.season`）。这两类都需要一条不依赖浏览器的断言。
 *
 * ★★★ 三条最贵的教训，都写进下面的断言里：
 *
 *  ① **`||` 兜底 + 上游已兜底 = 兜底失效**（第五次同类事故）。
 *     `termSeason()` 在名字找不到时 `return 'summer'` ——
 *     于是 `termSeason(x) || 老逻辑` 里的 `||` **永远不生效**。
 *     断言：必须先查 `SOLAR_TERMS.indexOf` 再取 `TERM_SEASON`。
 *
 *  ② **状态机的基准字段不能是「同时又被写」的字段**。
 *     淡入曾用 `this.season` 当「屏上显示的是哪张」的基准，
 *     而它在同一函数里紧跟着就被写成新季 ⇒ 淡入只活一帧。
 *     断言：必须存在独立的 `shownSeason`，且它只在淡入结束时才更新。
 *
 *  ③ **「懒两步」的资源加载必须自举**。
 *     `texture()` 第一次只发 `img.src`，建 texture 要等**下一次**调用。
 *     一旦某个季节不是当前季节，就永远没人再调它 ⇒ 图下完了、纹理建不出来
 *     （实测 `images` 四张 complete，`textures` 只有 1 个）。
 *     断言：`onload` 里必须回调 `texture(槽位)`。
 *
 *  ★★★ ④ **按槽位索引的东西，槽位清单只能有一个来源**（层③ 新增）。
 *     底图从「4 张按季节索引」升级成「N 张按 manifest 槽位索引」后，
 *     下面三处曾经各写一份清单/各用一个 key：
 *       · 预热列表硬编码 `['spring','summer','autumn','winter']`
 *       · `textures`/`waterMasks` 用**季节名**做 key
 *       · 淡入状态机用季节名判「图变了」
 *     补一张中间档图就会同时踩中三个：纹理串了、掩膜串了（雨圈落错地方
 *     **且不报错**）、同季内换图**静默不淡入**（而 check:term:fade 只测
 *     跨季 4 对，**照样全绿**）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SOLAR_TERMS, TERM_SEASON } from '../src/engine/almanac.js';
import { TERM_FADE_SECONDS } from '../src/engine/landscape.js';
import {
  TERM_IMAGE_MANIFEST, resolveTermImage, allTermImages,
  termImageURL, auditTermImages,
} from '../src/engine/term-images.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(join(HERE, '..', 'src', 'engine', 'landscape.js'), 'utf8');

/** 剥掉行注释与块注释。★ 反例常写在注释里说明"为什么不那样写"，不剥会命中自己。 */
const strip = (src) => {
  const out = [];
  let inBlock = false;
  for (const line of src.split('\n')) {
    let s = line;
    if (inBlock) {
      const e = s.indexOf('*/');
      if (e < 0) continue;
      s = s.slice(e + 2);
      inBlock = false;
    }
    const b = s.indexOf('/*');
    if (b >= 0) {
      if (s.indexOf('*/', b) < 0) { inBlock = true; continue; }
      s = s.slice(0, b) + s.slice(s.indexOf('*/', b) + 2);
    }
    const i = s.indexOf('//');
    /* ⚠️ 不能对 for...of 的循环变量赋值（const 不可赋值）——静默失效。
     * 这里只读不写，天然避开那个坑。 */
    if (i >= 0) s = s.slice(0, i);
    out.push(s);
  }
  return out.join('\n');
};
const CODE = strip(SRC);

test('★ 淡入时长就是需求 §2.3 写的 8 秒', () => {
  assert.equal(TERM_FADE_SECONDS, 8, '改这个值等于改需求；需求变更请同步改需求文档');
  assert.ok(/TERM_FADE_SECONDS\s*=\s*8/.test(CODE), 'landscape.js 里必须定义成字面量 8（别引入配置漂移）');
});

test('★ 底图槽位必须先校验节气名再查表（否则 termSeason 的兜底会让降级路径成为死代码）', () => {
  const m = CODE.match(/bgSeason\(options\)\{([\s\S]*?)\n {1}\}/);
  assert.ok(m, '找不到 bgSeason 方法');
  const body = m[1];
  assert.ok(/SOLAR_TERMS\.indexOf\(term\)/.test(body),
    '必须先用 SOLAR_TERMS.indexOf 校验名字');
  assert.ok(/i\s*>=\s*0/.test(body) || /i\s*>\s*-1/.test(body),
    '必须判 index 合法后才返回 TERM_SEASON[i]');
  assert.ok(!/termSeason\s*\(/.test(body),
    '★ 不要在这里调 termSeason：它在名字找不到时返回 summer，'
    + '会让后面的降级分支永远走不到（老存档会被静默按夏天选图）');
});

test('★ 24 档全部能选出底图，且与 TERM_SEASON 逐档一致', () => {
  assert.equal(SOLAR_TERMS.length, 24);
  assert.equal(TERM_SEASON.length, 24);
  for (let i = 0; i < 24; i++) {
    const s = TERM_SEASON[i];
    assert.ok(['spring', 'summer', 'autumn', 'winter'].includes(s),
      `${SOLAR_TERMS[i]} 的季节是 ${s}，不是四季之一`);
  }
  /* 四季各 6 档 —— 与 CAUSTIC.season / SEASON_LIGHT 的四档对齐。 */
  for (const s of ['spring', 'summer', 'autumn', 'winter']) {
    assert.equal(TERM_SEASON.filter((x) => x === s).length, 6, `${s} 不是 6 档`);
  }
});

test('★ 淡入必须有独立的 shownSeason 基准字段（不能拿同时被写的 this.season 当基准）', () => {
  assert.ok(/this\.shownSeason/.test(CODE),
    '缺少 shownSeason。退而用 this.season 会导致：它在本函数内被写成新季 ⇒ '
    + '下一帧判「没变」⇒ 淡入只活一帧（这是实测踩过的）');
  /* ★ 关键不变式：淡入进行中时**不得**更新 shownSeason。 */
  assert.ok(/if\s*\(\s*!fadeFrom\s*\|\|\s*fade\s*>=\s*1\s*\)\s*this\.shownSeason\s*=\s*slot/.test(CODE),
    'shownSeason 只能在「无淡入」或「淡入已完成」时更新；'
    + '若每帧无条件更新，淡入第二帧就会被掐断');
  /* ★★ 层③：基准字段的语义从「季节」升级为「**槽位**」。
   * 判「图变了」必须比槽位，不是比季节 —— 补了中间档图之后，
   * 同一季节里会有两张不同的图，比季节会让 8s 淡入静默失效。 */
  assert.ok(/shownSeason\s*&&\s*this\.shownSeason\s*!==\s*slot/.test(CODE),
    '★ 「图是否变了」必须比 slot（manifest id），不能比 season：'
    + '同一季节的不同图是两张图，同季换档也必须走 8s 淡入');
});

test('★ 淡入进度必须挂在时间上，且只由 fadeStart 与 TERM_FADE_SECONDS 决定', () => {
  assert.ok(/time\s*-\s*this\.fadeStart/.test(CODE),
    '进度必须由 (time - fadeStart) 算，不能用别的');
  assert.ok(/\/\s*TERM_FADE_SECONDS/.test(CODE), '分母必须是 TERM_FADE_SECONDS');
  assert.ok(/Math\.min\(1,\s*Math\.max\(0,/.test(CODE), '进度必须夹在 [0,1]');
  assert.ok(!/random\(\)/.test(CODE.match(/render\(time,options,hand\)\{[\s\S]*?\n {1}\}/)?.[0] || ''),
    '淡入进度不能含 random()（每帧抖 ⇒ 无法复现、无法做判据）');
});

test('★ paused / reducedMotion 必须落终态（否则暂停时切节气会永远卡在上一季）', () => {
  const m = CODE.match(/const instant\s*=\s*!\!\(([^)]*)\)/);
  assert.ok(m, '找不到 instant 判定');
  assert.ok(/reducedMotion/.test(m[1]), 'reducedMotion 必须走终态');
  assert.ok(/paused/.test(m[1]),
    '★ paused 也必须走终态：sim.time 在 paused 下不前进，'
    + '不特判则画面永远停在上一季（SeasonPanel 允许暂停时切节气）');
});

test('★ 缓存 key 必须同时含 solarTerm 与淡入进度', () => {
  const m = CODE.match(new RegExp('const fk\\s*=\\s*' + String.fromCharCode(96) + '([^' + String.fromCharCode(96) + ']*)' + String.fromCharCode(96)));
  assert.ok(m, '找不到淡入相关 key');
  assert.ok(/solarTerm/.test(m[1]), 'key 必须含 solarTerm（同季换档 season 不变，不带它画面会逐位不变）');
  assert.ok(/fadeFrom/.test(m[1]), 'key 必须含 fadeFrom');
  assert.ok(/fade\.toFixed/.test(m[1]),
    'key 必须含量化后的 fade 进度 —— 淡入是连续量，每帧都变；不带它会被 lastDraw 短路');
  /* ★ 断言的是「solarTerm 有进 key」，**不是**「字面量出现在 key 模板里」。
   * 上一版查 `const key=` 模板串里有没有 options.solarTerm，结果假红 ——
   * 实际写法是 `${fk}` 间接引用（fk 里已含 solarTerm）。
   * 这与「判据必须量真正送进下游的那个量」同源：查中间变量不如查数据流终点，
   * 但也不能只查终点模板的字面量。 */
  const keyM = CODE.match(new RegExp('const key\\s*=\\s*' + String.fromCharCode(96) + '([^' + String.fromCharCode(96) + ']*)' + String.fromCharCode(96)));
  assert.ok(keyM, '找不到最终 key');
  assert.ok(/\$\{fk\}/.test(keyM[1]), '最终 key 必须把 fk 拼进去（否则 fk 白算）');
});

test('★ 双纹理必须绑到不同单元，且渲染后把活动单元复位回 0', () => {
  assert.ok(/uniform1i\(this\.uniforms\.uImage,\s*0\)/.test(CODE), 'uImage 必须绑单元 0');
  assert.ok(/uniform1i\(this\.uniforms\.uImageB,\s*1\)/.test(CODE), 'uImageB 必须绑单元 1');
  assert.ok(/activeTexture\(gl\.TEXTURE1\)[\s\S]{0,80}bindTexture\(gl\.TEXTURE_2D,\s*prevTexture\)/.test(CODE),
    '淡入时第二张图必须绑到单元 1');
  /* ★ 复位这条最容易漏：texture() 里是裸 bindTexture（绑当前活动单元），
   * 留在 1 的话下一帧新建的纹理会被挂到单元 1，uImage 读单元 0
   * ⇒ 画面停在旧图且**无任何报错**。 */
  assert.ok(/activeTexture\(gl\.TEXTURE0\)/.test(CODE), '必须复位活动纹理单元到 0');
  assert.ok(CODE.indexOf('activeTexture(gl.TEXTURE0)', CODE.indexOf('activeTexture(gl.TEXTURE1)')) > 0,
    '复位必须**出现在**绑单元 1 之后');
});

test('★ 底图加载必须自举：onload 里回调 texture(槽位)', () => {
  const m = CODE.match(/img\.onload\s*=\s*\(\)\s*=>\{([\s\S]*?)\}/);
  assert.ok(m, '找不到 img.onload');
  assert.ok(/this\.texture\(slot,file\)/.test(m[1]),
    '★ onload 里必须回调 texture(槽位[,file])。否则 texture()「懒两步」永远走不到第二步：'
    + '非当前槽位的图下完了也不会建纹理（实测 images 四张 complete 而 textures 只有 1 个）');
  assert.ok(/cacheWaterMask\(slot,\s*img\)/.test(m[1]), 'onload 仍必须缓存水区掩膜');
  assert.ok(/lastDraw\s*=\s*null/.test(m[1]), 'onload 后必须清 lastDraw 强制重画');
});

test('★ 纹理 / 掩膜的 key 必须是槽位，不能是季节名（层③ 头号坑）', () => {
  /* ★★★ 这是层③最贵的一条。三处曾经**各写一份清单**，补一张中间档图就同时炸：
   *   ① `textures`/`waterMasks` 用季节做 key ⇒ 第二张图把第一张顶掉，
   *      `waterAt()` 读到另一张图的水陆形状 ⇒ 雨圈落在不该落的地方，**不报错**；
   *   ② 淡入状态机判「图变了」也用季节 ⇒ 同季内换图 from===to ⇒ 不淡入；
   *   ③ 预热列表硬编码四季 ⇒ 新槽位的图现加载 ⇒ 首帧早退 ⇒ 硬切。
   * 而 `check-term-fade.cjs` **测不出 ①②**（它只测跨季 4 对），所以必须有源码护栏。 */
  /* ★ 抽取 texture() 方法体。边界用**下一个方法声明**来锚（`\n cacheWaterMask`），
   * 不要写成「两个换行」—— 那是本文件写断言时自伤的第三处：
   * 排版里方法之间只有**一个**换行 + 一个空格缩进，
   * 多写一个 \n 会让正则永远匹配不到 ⇒ 假红（而实现是好的）。 */
  const tex = CODE.match(/texture\(slot,file\)\{([\s\S]*?)\n cacheWaterMask/);
  assert.ok(tex, '找不到 texture(slot,file) 方法（边界正则与实际排版不符？）');
  assert.ok(!/textures\.(get|set|has)\(season\)/.test(tex[1]),
    'textures 的 key 必须是槽位');
  assert.ok(/this\.images\.get\(slot\)/.test(tex[1]), 'images 的 key 必须是槽位');

  const wat = CODE.match(/waterAt\(x,y\)\{([\s\S]*?)\n {1}\}/);
  assert.ok(wat, '找不到 waterAt 方法');
  assert.ok(/waterMasks\.get\(this\.slot\)/.test(wat[1]),
    '★ waterMasks 必须按 this.slot 取。掩膜是「这张图」的属性；'
    + '同一季节的两张图水陆形状不同，用季节取会拿到另一张图的掩膜，'
    + '⇒ 雨圈落在别的图的水里，且不报任何错');

  /* 预热清单必须来自 manifest，而不是硬编码四季数组。
   * 这是「槽位清单只能有一个来源」原则的落点。 */
  assert.ok(/this\.ready\)\s*for\s*\(\s*const\s+\w+\s+of\s+allTermImages\(\)\s*\)\s*this\.texture\(\s*\w+\.id\s*,\s*\w+\.file\s*\)/.test(CODE),
    '★ 预热列表必须来自 allTermImages()（manifest 的唯一来源），'
    + '且必须把 file 一并传下去（texture() 不再自己回查 manifest）。'
    + '硬编码四季数组的话，补了中间档图却没同步这里 ⇒ '
    + '切到那一档现下载 ⇒ texture() 返回 null ⇒ 早退 ⇒ 8s 淡入退化成硬切');
  assert.ok(!/for\s*\(\s*const\s+\w+\s+of\s*\[\s*'spring'\s*,\s*'summer'/.test(CODE),
    '不要在渲染层硬编码四季清单（它已经搬到 manifest 了）');
});

test('★ 文件名与版本号必须由调用方透传，texture() 不得回查 manifest', () => {
  const tex = CODE.match(/texture\(slot,file\)\{([\s\S]*?)\n cacheWaterMask/);
  assert.ok(tex, '找不到 texture(slot,file) 方法 —— file 必须由 bgSlot 的返回值透传进来');
  assert.ok(/termImageURL\(/.test(tex[1]),
    'URL 必须走 termImageURL()（版本号 v 在 manifest 里）');
  /* ★★★ 这条是量具抓到的一个真实缺陷（不是理论洁癖）：
   *   上一版 `texture(slot)` 只拿槽位 id，自己 `allTermImages().find(e=>e.id===slot)`
   *   回查 file —— **等于把 bgSlot 的解析结果扔掉重算**。后果：
   *   manifest 里没有的槽位（补图前、或测试注入的）find 到 undefined
   *   ⇒ fallback 用**槽位名当文件名** ⇒ 请求 /assets/<槽位名>.png ⇒ 404
   *   ⇒ onload 永不触发 ⇒ textures 永远建不出这个槽位
   *   ⇒ 症状是「切档后画面停在旧图，无任何报错」（404 只是网络层失败）。
   *   ⇒ 一份映射只能解析一次，然后逐层透传。 */
  assert.ok(!/allTermImages\(\)\.find\(/.test(tex[1]),
    '★ texture() 不要自己回查 manifest。bgSlot 已经解析好了，重算会丢掉注入槽位的 '
    + 'file，退化成用槽位名当文件名去请求（404，且 onload 永不触发 ⇒ 纹理建不出来）');
  assert.ok(!/\?v=1\.5/.test(tex[1]),
    '不要在渲染层硬编码 ?v=1.5。补/改图时 bump manifest 的 v 才生效，硬编码等于「改图不换缓存」');
  /* ★ 缺图必须留线索：否则 404 完全静默，量具只会报「淡入没生效」，
   * 而真因（图不存在）在任何日志里都不出现。 */
  assert.ok(/img\.onerror/.test(tex[1]),
    '必须挂 img.onerror 报出缺失的素材名 —— 否则素材漏了只能靠猜');
});

/* ══════════════════════════════════════════════════════════════════
 * 以下是 manifest 自身的数据护栏（层③ 的核心产物）。
 * ══════════════════════════════════════════════════════════════════ */

test('★ manifest 必须与 SOLAR_TERMS 完全对齐：24 档每档恰好被一个条目声明', () => {
  const audit = auditTermImages();
  assert.deepEqual(audit.unknown, [],
    'manifest 里有 SOLAR_TERMS 不存在的节气名（打错字了吧）');
  assert.deepEqual(audit.missing, [],
    '★ manifest 漏了节气。漏掉的档会走降级链拿季节图 —— '
    + '不报错，但那一档就永远只能用季节图，与「以节气区间为唯一口径」相违');

  /* ★★ 「恰好一次」是这里最要紧的断言。
   * `BY_TERM` 用 Map.set 逐条写入 ⇒ **后声明的覆盖先声明的、无声无息**。
   * 这正是补中间档图要的能力（把某档从季节图手里接过来），
   * 但也是「我明明写了清明怎么还是春天的图」的唯一成因。 */
  const counts = new Map();
  for (const e of TERM_IMAGE_MANIFEST) {
    for (const t of e.terms) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  const dup = [...counts].filter(([, n]) => n > 1);
  assert.deepEqual(dup, [],
    '★ 有节气被多个条目声明（后声明者胜出，静默覆盖）。'
    + '要么删掉旧的，要么调整顺序');
  assert.equal(counts.size, 24, '声明覆盖的节气总数必须正好 24');
});

test('★ 现有 4 张底图必须逐位复现 TERM_SEASON 的四季归属（manifest 不能改底图口径）', () => {
  for (const term of SOLAR_TERMS) {
    const want = TERM_SEASON[SOLAR_TERMS.indexOf(term)];
    const got = resolveTermImage({ solarTerm: term });
    assert.equal(got.id, want,
      `${term} 被 manifest 映射到 ${got.id}，但 TERM_SEASON 说它是 ${want}。`
      + '两张表必须一致，否则底图与水色/荷叶/霜雪会各说各话');
    assert.equal(got.source, 'term', `${term} 必须精确命中（不该走降级）`);
  }
});

test('★ 降级链每一级都必须真的可达（`||` 兜底失效事故的定点防御）', () => {
  /* ① 老存档：没有节气名 ⇒ 按 season 走。 */
  assert.equal(resolveTermImage({ season: 'winter' }).id, 'winter');
  assert.equal(resolveTermImage({ season: 'winter' }).source, 'season');
  /* ② 天气兜底：任一季节 + snowy 都落到 winter。
   * 这条老行为必须**逐位不变** —— 它是「非时令模式」下唯一的季节来源。 */
  assert.equal(resolveTermImage({ season: 'spring', weather: 'snowy' }).id, 'winter');
  assert.equal(resolveTermImage({ season: 'spring', weather: 'snowy' }).source, 'weather');
  /* ③ 完全没线索 ⇒ manifest 首条，且必须报出自己是兜底。 */
  const last = resolveTermImage({});
  assert.equal(last.source, 'fallback', '无任何线索时必须标记 source=fallback');
  assert.equal(last.id, TERM_IMAGE_MANIFEST[0].id);

  /* ★★ 反向断言：`termSeason()` 的兜底是 summer，所以**绝不能**用
   * `termSeason(x) || 老逻辑` 这种写法 —— 右边永远不执行。
   * 这里从行为上证明「先查表再降级」的写法是对的：
   * 一个**不存在的**节气名必须走降级，而不是静默变成夏天。 */
  const bogus = resolveTermImage({ solarTerm: '不存在的节气', season: 'autumn' });
  assert.equal(bogus.id, 'autumn',
    '★ 未知节气名必须走降级拿 autumn；若得到 summer，说明误用了 termSeason 的兜底');
  assert.equal(bogus.source, 'season');
});

test('★ 槽位 id 与文件名必须分开（夏天的文件历史上叫 pond.png）', () => {
  const summer = resolveTermImage({ solarTerm: '芒种' });
  assert.equal(summer.id, 'summer', 'id 必须是语义名 summer');
  assert.equal(summer.file, 'pond',
    '★ 文件名是 pond（历史包袱）。渲染层不该再有 season===\'summer\'?\'pond\':season '
    + '这种三元 —— 它已被 manifest 吸收');
  assert.ok(termImageURL('/', summer).endsWith('/assets/pond.png?v=1.5'),
    'URL 形态必须是 <base>assets/<file>.png?v=<v>');
  /* 反过来也要挡住：别有人把 id 直接当文件名用。 */
  assert.notEqual(summer.id, summer.file);
  assert.equal(allTermImages().length, TERM_IMAGE_MANIFEST.length);
});

test('★ GLSL 模板串里禁止反引号（WebGL1 shader 会静默编译失败）', () => {
  // 抽出 fragment 模板串。
  // ⚠️★ 本文件写这个断言时自伤了两次，都记在这里：
  //   ① 我在块注释里放了裸反引号，把注释提前终止 ⇒ 文件直接语法错误。
  //   ② 修 ① 时又在注释里写了块注释的结束符，同样自伤。
  //   与 MEMORY 第 12 条（Bash heredoc 吃反引号）同型且更宽：
  //   **会被外层解析器读的位置一律危险，注释也不安全**。
  //   所以本文件里所有反引号都改用字符码 96 构造，注释只写纯文字。
  const TICK = String.fromCharCode(96);
  const re = new RegExp('const\\s+\\w+\\s*=\\s*' + TICK, 'g');
  const allConstTpl = [...CODE.matchAll(re)];
  assert.ok(allConstTpl.length >= 2, '找不到 fragment 模板串');
  const fragStart = CODE.indexOf(TICK, allConstTpl[1].index) + 1;
  const fragEnd = CODE.indexOf(TICK, fragStart);
  assert.ok(fragEnd > fragStart, 'fragment 模板串未闭合');
  const frag = CODE.slice(fragStart, fragEnd);
  assert.ok(!frag.includes(TICK), 'fragment 串内不得有反引号（会截断模板串）');
  // ★ 下面两条是本项目最贵的两次静默失败（WebGL1 = GLSL ES 1.00）。
  assert.ok(!frag.includes('//'), 'fragment 串内不得有行注释（会吃掉后续代码）');
  assert.ok(!/int\s*\([^)]*\)\s*%/.test(frag),
    'GLSL ES 1.00 没有整数取模运算符，会让整个 shader 编译失败并被 try/catch 静默吞掉');
  assert.ok(!/vec3\s+\w+\s*=\s*\w+\s*;/.test(frag),
    'vec3 不能从裸 float 初始化（dimension mismatch，同样静默失败）');
});

test('★ 跨季边界恰好 4 处（每处都要真的换图、真的淡入）', () => {
  const cross = [];
  for (let i = 0; i < 24; i++) {
    const next = (i + 1) % 24;
    if (TERM_SEASON[i] !== TERM_SEASON[next]) cross.push([SOLAR_TERMS[i], SOLAR_TERMS[next]]);
  }
  assert.equal(cross.length, 4,
    `跨季边界数变了（${JSON.stringify(cross)}）。`
    + '若 TERM_SEASON 重排，check-term-fade.cjs 的 CROSS_SEASON 表也要同步改');
  /* ★★★ 断言**具体是哪四对**，不只是「有四个」。
   *
   * 起因：量具的 `CROSS_SEASON` 表里第二对写的是 `白露→秋分`，
   * 而按真实轴白露(11)/秋分(12) **都是 autumn** —— 它压根不是跨季边界。
   * 之所以一直没人发现：那张表里的起点/终点季节名是**手写期望值**，
   * 而量具读的是上一对留下的残留状态 ⇒ `fadeFrom` 恰好读成期望值 ⇒ 全绿。
   * ⇒ **一次只错一对，且被前一对的残留掩盖** —— 这类假绿最难被量具自己抓住，
   *   只能在「表 vs 数据源」这一层挡。 */
  assert.deepEqual(cross, [
    ['谷雨', '立夏'], ['大暑', '立秋'], ['霜降', '立冬'], ['大寒', '立春'],
  ], '跨季边界是这四对。改 TERM_SEASON 会同时改淡入表，必须一起改');
});
