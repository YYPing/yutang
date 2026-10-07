/**
 * `pond.js` 的**方法清单护栏**。
 *
 * ★ 为什么需要它（2026-10-04 的一次真实事故）：
 *   重写 `drawLotus()` 时用「从 JSDoc 切到下一个方法之前」整段替换，
 *   而 `drawFeedCircles()` 恰好夹在这两者之间 —— 它被**静默吃掉**了。
 *   表现是页面报 `this.drawFeedCircles is not a function` 并**白屏**。
 *
 *   `node --check` 只查语法，**查不出少了方法**；
 *   截图判据也只会报「页面异常」，不会告诉你是哪个方法没了。
 *   ⇒ 只能靠一份**显式清单**在测试阶段挡住。
 *
 * 与 `tests/settings-forwarding.test.js`（防 options useMemo 漏字段）
 * 是同一类护栏：都是防「静默失败」，因为静默失败不会自己浮出来。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = readFileSync(join(ROOT, 'src', 'engine', 'pond.js'), 'utf8');

/**
 * PondEngine 必须有的方法（节选自实际实现，逐个在 render 里被调用过）。
 * ★ 增删方法时**同步改这里** —— 这是刻意的摩擦，不是负担：
 *   改清单时你会看到每个方法的名字，漏掉哪一个都会在 diff 里显形。
 */
const REQUIRED = [
  'render', 'resize', 'destroy', 'pointer', 'feed', 'updateOptions',
  'drawWater', 'drawLightPool', 'drawShafts', 'drawLightBands', 'drawSparkles',
  'drawEggs', 'drawFood', 'drawRipples', 'drawFeedCircles', 'drawLotus',
  'drawFrost', 'drawWeather', 'drawInsects',
];
/* ⚠️ 2026-10-07 又删掉两个方法（用户「删除冬天结冰和留着洞冒泡的设计」）：
 *   drawWinter  只调 drawFrost，单语义 → 名字已与内容不符，直接删（调用点自己调）
 *   drawIceHole 冰下泉眼 + 蒸汽
 *   ⇒ **第三次**削减冬季（① 整池冰层 ② 岸边积雪/雪粒 ③ 泉眼与蒸汽）。
 *   剩下的是**岸边浮霜**（drawFrost）与**降雪**（drawWeather 里的雪花），两者都不在删除范围。*/
/* ⚠️ 刻意**不列**的三项（写清单时踩过，别再补回去）：
 *   drawFish  定义在 koi-renderer.js:78，不在 pond.js
 *   update    定义在 simulation.js:534，pond 只调 this.sim.update(dt)
 *   isWater   是构造函数里赋的实例属性 this.isWater = (x,y)=>…，不是方法 */

/**
 * 取出某个方法的**完整源码**（从方法签名到**下一个方法定义**为止）。
 *
 * ★★★ 为什么不能写成 `SRC.indexOf('\n  drawIce()', start)` 这种「找下一个方法名」：
 *   那个哨兵太脆 —— 本轮把 `drawIce` 改名成 `drawWinter`（冰层取消），
 *   三处 `indexOf` 的字面量全部失效，而且我第一次「顺手改成新名字」时
 *   把 `\n  drawWinter() {` 写进了单引号字符串里的**真换行** ⇒
 *   文件直接 `SyntaxError`，测试文件自己都跑不起来。
 *   ⇒ **正确做法：不信任何方法名，只找「下一个形如 `  名字(...) {` 的行」**。
 *   方法增删改名的次数远少于测试失败次数。
 */
/**
 * **剥掉注释**后的方法体 —— 给「源码顺序 / 源码形态」类断言用。
 *
 * ★ 为什么必须剥（2026-10-05 实踩）：
 *   这类护栏断言的东西（`baseRot + j*2.399963`、`hw*1.14`）在**注释里**
 *   恰恰都要被写出来当反例说明（「这就是错的写法」）。
 *   直接拿带注释的源码去 match ⇒ 每条断言都命中自己的失败说明文本 ⇒ **全线假红**。
 *   （与 MEMORY 里「源码顺序类断言必须先剥注释，否则注释里提到变量名会假红」同源。）
 *
 * 实现：行注释整行去��块注释用状态机剥。**不做字符串字面量处理** ——
 *   本仓 `pond.js` 的方法体内没有会在注释里出现同形串的用例，
 *   而引入真正的 JS tokenizer 成本远大于收益。
 */
function methodBodyStripped(src, signature) {
  const raw = methodBody(src, signature);
  if (raw == null) return null;
  let out = '';
  let inBlock = false;
  for (const src of raw.split('\n')) {
    let line = src;
    if (inBlock) {
      const end = line.indexOf('*/');
      if (end < 0) continue;
      inBlock = false;
      line = line.slice(end + 2);
    }
    /* 行注释：从 // 起截断（本仓方法体内没有含// 的字符串字面量） */
    const li = line.indexOf('//');
    if (li >= 0) line = line.slice(0, li);
    const bi = line.indexOf('/*');
    if (bi >= 0) {
      const end = line.indexOf('*/', bi + 2);
      if (end < 0) { inBlock = true; line = line.slice(0, bi); }
      else line = line.slice(0, bi) + line.slice(end + 2);
    }
    out += line + '\n';
  }
  return out;
}

function methodBody(src, signature) {
  const start = src.indexOf(signature);
  if (start < 0) return null;
  /* 从签名之后开始找下一个「两空格缩进 + 标识符 + 括号」的行 */
  const rest = src.slice(start + signature.length);
  const m = /\n {2}(?:get |set )?[A-Za-z_$][\w$]*\s*\([^)]*\)\s*\{/.exec(rest);
  return m ? src.slice(start, start + signature.length + m.index) : src.slice(start);
}

test('PondEngine 的方法清单完整（整段替换函数体时最容易静默吃掉相邻方法）', () => {
  const missing = REQUIRED.filter((m) => !new RegExp(`^  ${m}\\s*\\(`, 'm').test(SRC));
  assert.equal(missing.length, 0,
    `pond.js 缺少方法：${missing.join(', ')}\n` +
    '（多半是整段替换某个函数体时把相邻方法一起吃掉了；node --check 查不出来）');
});

test('drawLotus 门控覆盖四种形态（不是只看 leafCount）', () => {
  // 白露/秋分 leafCount 还有 9~12，若门控只看 leafCount 则莲花类形态能画；
  // 但大雪~大寒四种全 0 必须真的不画。断言门控条件里四个字段都在。
  const m = SRC.match(/if \(([^)]*\b(?:tv|v)\.(?:leafCount|lotusCount|budCount|podCount)[^)]*)\) this\.drawLotus\(\)/)
         || SRC.match(/if \(([^)]*termVisual[^)]*)\) this\.drawLotus\(\)/);
  assert.ok(m, '找不到 drawLotus 的门控 if');
  for (const f of ['leafCount', 'lotusCount', 'budCount', 'podCount']) {
    assert.ok(m[1].includes(f), `门控条件缺少 ${f}（该形态会被整体跳过）`);
  }
});

test('flora 画在鱼之后（需求 §11.4 层 10「荷花荷叶 flora 压住鱼」）', () => {
  const lotus = SRC.indexOf('this.drawLotus()');
  const fish = SRC.indexOf('this.drawFish(fish, false)');
  assert.ok(lotus > 0 && fish > 0, '找不到 drawLotus 或 drawFish 调用');
  assert.ok(lotus > fish,
    'drawLotus 排在 drawFish 之前 ⇒ 鱼盖住荷叶，与需求层 10 相反');
});

/**
 * ★★★ TDZ 护栏：`drawLotus` 里每个 `const` 局部声明都必须在**所有使用点之前**。
 *
 * 事故 1（2026-10-04 上午）：荷叶尺寸放大后，把「叶脉/描边/中心窝」的线宽从 `size` 改成
 * 锚在常量 `BASE` 上，而 `const BASE = 20` 写在了**叶脉段里** —— 叶柄段先读到它 ⇒
 * `ReferenceError: Cannot access 'BASE' before initialization` ⇒ **整页白屏**。
 *
 * 事故 2（同日下午，重写叶形时）：`const NV = 11` 声明在**箭头函数 `leafPath` 之后**，
 * 而 `leafPath` 体内要按 NV 拆段 ⇒ 又一次 TDZ 白屏。
 * ⇒ **同一个坑在同一段代码里踩了两次**，只断言 BASE 是不够的，必须泛化到全部 const。
 *
 * ★ 为什么 `node --check` 查不出：它只做语法分析，TDZ 是**运行期**错误。
 *   而这类错误的现场（截图变白）与"渲染参数不对"很难区分。
 *
 * ★ 四条实现教训（每条都对应一版假绿/假红）：
 *   ① 必须**先剥注释** —— 本函数的注释里就写着「锚在常量 BASE 上」，
 *      直接正则匹配会命中注释，把正确的代码判成红。
 *   ② 不能用「声明行缩进更深 ⇒ 在 for 块内 ⇒ 跳过」—— 事故 2 的 `const NV`
 *      就在 for 块**外**（for 体是它的兄弟节点），缩进与 for 内的 const 相同。
 *   ③ 不能用「声明处的括号深度 > 1 ⇒ 跳过」—— 同 ②，且箭头函数体会让深度虚高。
 *   ④ 也不能简单地「声明位置之前出现同名裸标识符就判红」——
 *      多个 for 里各自 `const a0` 是合法的（各自作用域），会大量误报。
 * ⇒ **正确判据**：只校验**方法体顶层**的 const（本文件里缩进 = 4 空格，
 *   因为 drawLotus 自身是 2 空格、for 体是 6 空格 —— 第一次写成 6 空格时
 *   「顶层」实际全落在 for 体内，断言只校验到 1 个，形同虚设），
 *   用「往后第一个缩进 ≤ 4 的非空行」切出它的作用域块，
 *   在**块内**找使用点（须在声明之后），再确认**声明之前**没有裸使用。
 *   for 内的 const 天然安全（自己声明自己、块内先声明后用），一律跳过。
 *   ⚠️ 这条护栏的价值在于它**两次都真抓到了**（注入回归验证过）：
 *   事故 1 的 BASE、注入版事故 2 的 NV 都会判红。
 */
test('★ drawLotus 顶层 const 都在使用点之前（TDZ 会白屏，node --check 查不出）', () => {
  const start = SRC.indexOf('drawLotus() {');
  assert.ok(start > 0, '找不到 drawLotus');
  const raw = methodBody(SRC, 'drawLotus() {');
  const body = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  /* 顶层 = 恰好 4 空格缩进的 `const`（方法签名 2 空格、for 体 6 空格）。
   * ⚠️ 缩进层级是这张表的**地基**：第一版误写成「6 空格 = 顶层」，
   *   结果匹配到的全是 for 体内的 a0/a1，断言只校验到 1 个、形同虚设。 */
  const TOP = /^ {4}const ([A-Za-z_$][\w$]*)\s*=/gm;
  const decls = [...body.matchAll(TOP)].map((m) => ({ name: m[1], index: m.index }));
  assert.ok(decls.length >= 5,
    `只找到 ${decls.length} 个顶层 const 声明（断言可能已失效，请核对 drawLotus）`);

  let checked = 0;
  for (const d of decls) {
    /* 声明之后（全函数体内）有没有使用点？没有就不管。
     * ⚠️ 刻意**不切作用域块**：曾试图按「下一个缩进 ≤ 4 的行」切块，
     *   但 `for (...) {` 本身就是 4 缩进 ⇒ 块只含声明那一行 ⇒ 永远查不到使用点。
     *   「声明后无任何使用」本来就无需检查，跨作用域误判的风险由
     *   下面「有更早的同名声明则视为被遮蔽」这一条兜住。 */
    const after = body.slice(d.index + `const ${d.name}`.length);
    const used = after.search(new RegExp(`[^A-Za-z_0-9$.]${d.name}[^A-Za-z_0-9]`, 'm'));
    if (used < 0) continue;

    /* 声明之前是否有裸使用（有更早的同名声明则被遮蔽，不算 TDZ） */
    const before = body.slice(0, d.index);
    const useBefore = before.search(new RegExp(`[^A-Za-z_0-9$.]${d.name}[^A-Za-z_0-9]`, 'm'));
    const shadowed = before.search(new RegExp(`\\b(?:const|let|var|function)\\s+${d.name}\\b`, 'm'));
    assert.ok(useBefore < 0 || shadowed >= 0,
      `\`${d.name}\` 在声明前就被使用（声明前偏移 ${useBefore}）`
      + ' ⇒ 运行时 TDZ ⇒ 白屏（node --check 查不出）');
    checked++;
  }
  assert.ok(checked >= 4, `只校验了 ${checked} 个顶层 const（断言可能已失效）`);
});

/** 旧版单点断言保留为窄护栏：BASE 必须存在且真被使用（防止有人把锚定逻辑删了） */
test('★ drawLotus 的尺寸基准 BASE 仍被使用（叶脉线宽不能退回按 size 等比放大）', () => {
  const start = SRC.indexOf('drawLotus() {');
  const raw = methodBody(SRC, 'drawLotus() {');
  const body = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const decl = body.indexOf('const BASE');
  assert.ok(decl > 0, 'drawLotus 里没有 BASE 声明（若已改掉锚定逻辑，请同步删掉本条断言）');
  assert.ok(body.slice(decl).search(/[^A-Za-z_0-9]BASE[^A-Za-z_0-9]/) >= 0,
    'BASE 声明后没有任何使用点（断言可能已失效，请核对 drawLotus）');
});

/**
 * ★★★ per-frame 派生状态必须在 `render()` 里重置。
 *
 * 事故：`floraManifest` 只在 `drawLotus()` 里被赋值，而冬季四形态全为 0 时
 * `drawLotus()` **压根不被调用**（门控 `leafCount||lotusCount||budCount||podCount`）
 * ⇒ manifest 保留上一帧残留（实测冬档仍有 4~28 个"落点"），
 * 量具拿它当"本帧画了什么"就全错。
 *
 * 同 `atmosphere.syncLitter` 一类问题：不能指望生产者一定会被调用。
 */
test('★ render() 每帧重置 floraManifest（冬季不调 drawLotus 会残留上一帧）', () => {
  const r = SRC.indexOf('render() {');
  const head = SRC.slice(r, r + 2000);
  assert.ok(/this\.floraManifest\s*=\s*\{\s*leaf:\s*\[\]/.test(head),
    'render() 开头没有重置 this.floraManifest ⇒ 冬季档会带着上一帧的落点');
  // 且 drawLotus 里必须是 push 到已有对象，不能重新赋值（否则覆盖 render 的清空）
  const l = SRC.indexOf('drawLotus() {');
  const body = methodBody(SRC, 'drawLotus() {');
  assert.ok(!/this\.floraManifest\s*=\s*\{/.test(body),
    'drawLotus 里又赋值了一次 floraManifest ⇒ 会覆盖 render 的清空');
});

/**
 * ★ 冬季**不再有冰层**（2026-10-05，用户「冬天的冰封效果取消」）。
 *
 * 改前 `drawIce()` 画四样东西：整池冰层反光（`iceAlpha` + 全屏 `sheen`）、
 * 8 条裂纹、岸边积雪带、岸边雪粒。用户只要求去掉**冰封**，保留浮霜与泉眼。
 *
 * ★ 2026-10-07 用户「删除冬天结冰和留着洞冒泡的设计」⇒ **泉眼与蒸汽也删了**。
 *   本项目**第三次**削减冬季：① 整池冰层 ② 岸边积雪/雪粒 ③ 冰下泉眼 + 蒸汽。
 *   冬季现在只剩两样：**岸边浮霜**（`drawFrost`）与**降雪**（`drawWeather` 的雪花）。
 *   ⚠️ `ice` 通道**没删** —— 它现在只驱动降雪强度（`14+18*ice`），与「结冰」无关。
 *
 * ⚠️ 这条断言存在的意义：那份画法很容易被「顺手优化」回来，
 *   而它有个隐蔽的副作用 —— 冰层是**全屏 alpha 叠加**，
 *   一旦恢复就会把水面整体压亮，冬六档的 ΔE 判据与 `check:terms` 都要重调。
 *   所以在源码层锁死，比在量具层等它把别的判据搞红更省事。
 */
test('★ 冬季不再有冰层 / 泉眼 / 蒸汽（2026-10-05 取消冰封 → 2026-10-07 取消泉眼）', () => {
  /* ⚠️ 断言方式：**方法必须不存在**，而不是「方法里不该画什么」。
   *   上一版写成「drawWinter 必须调 drawFrost + drawIceHole」—— 删泉眼后它必然红，
   *   而照着改又会变成「drawWinter 必须调 drawFrost」，把一个**单语义空壳**留下。
   *   ★ 同型坑（MEMORY）：**断言的形状必须跟着「意图」走**。意图从「保留两种冬季效果」
   *   变成「两种都删」，那正确的新增断言是**它们没了**。 */
  for (const gone of ['drawWinter() {', 'drawIceHole() {']) {
    assert.ok(!methodBody(SRC, gone), `${gone}又回来了 ⇒ 冬季又多了不该有的效果`);
  }
  /* ⚠️ 必须用 `methodBodyStripped`：调用点上方的注释里**故意**写着 `drawWinter`/
   *   `drawIceHole`（说明第三次削减的历史），直接 match 注释必然假红。
   *   —— 这正是本文件 2026-10-05 立`methodBodyStripped` 的原因，同一坑第二次遇到。 */
  const render = methodBodyStripped(SRC, 'render() {') || '';
  assert.ok(!/drawIceHole|drawWinter/.test(render),
    'render() 还在调 drawWinter / drawIceHole（两个方法都已删除，必然是运行时报错）');
  assert.ok(/drawFrost\(\)/.test(render),
    'render() 不调 drawFrost ⇒ 岸边浮霜也一起没了（浮霜不在删除范围内）');

  /* ★ 仍要保留的**冰层回归防护**：冰层是全屏 alpha 叠加 + 裂纹 stroke，
   *   恢复它会把冬六档的水色与亮度判据全搞乱（见本测试原注释）。
   *   判据从「某个方法里没有」升级为「**整个文件里没有**」——
   *   因为现在连承载它的方法都不该存在了。 */
  const FROST = methodBodyStripped(SRC, 'drawFrost() {') || '';
  for (const [re, why] of [
    [/fillRect\(0, 0, (this\.)?width, (this\.)?height\)/, '全屏 fillRect ⇒ 整池冰层/水面反光回来了'],
    [/cracks\b[\s\S]{0,80}stroke/, '画了裂纹 stroke ⇒ 冰层回来了'],
    [/iceAlpha|snowEdge/, '出现 iceAlpha / 岸边积雪 ⇒ 冰层回来了'],
  ]) assert.ok(!re.test(FROST), `drawFrost 里：${why}`);
});

/** 浮霜不能再被「封冰」门控挡掉 —— 冰层已取消，那道门的前提已消失。 */
test('★ drawFrost 不再有 ice>=0.55 门控（否则深冬四档反而一帧霜都不画）', () => {
  const frost = methodBody(SRC, 'drawFrost() {');
  assert.ok(frost, '找不到 drawFrost');
  assert.ok(!/v\.ice\s*>=\s*0\.55/.test(frost),
    'drawFrost 仍有 `ice >= 0.55` 早退 ⇒ 深冬（ice=1）四档全部不画霜，'
    + '与「霜降有霜、入冬反而没霜」的反直觉断裂');
  assert.ok(/v\.frost\s*>\s*0\.02/.test(frost),
    'drawFrost 没有按 frost 通道门控（不能从 ice 推：ice 在冬四档全 =1）');
});

/* ═══ 2026-10-05 荷花形态护栏 ═══
 *
 * 背景：用户「花不好看」这一条，本轮改了 8 轮（瓣宽 .82→.62→.46→.38→.28、
 *   层间 1.00/.78/.52 → 1.00/.62/.34 → 1.22/.84/.48、花苞 4 版）。
 * 每一版都是**目视**判定的，而目视判定的代价是「下一个人很容易把它调回去」。
 * ⇒ 把三条**当时最难、且最反直觉**的结论钉成断言。
 */

test('★ 荷花花瓣层内角度必须严格等距（golden angle 只对大样本成立）', () => {
  const lotus = methodBodyStripped(SRC, 'drawLotus() {');
  assert.ok(lotus, '找不到 drawLotus');
  assert.ok(/\(j\s*\/\s*count\)\s*\*\s*TAU/.test(lotus),
    '层内角度不是 `(j/count)*TAU` ⇒ 又在用 golden angle 排瓣。'
    + '实测 8 片排出来是 0/52.5/105/137.5/190/242.5/275/327.5，间隔在 32.5°~52.5° 乱跳，'
    + '花瓣一圈疏一圈挤。层间错开要用 baseRot 参数，不要混进层内。');
  assert.ok(!/baseRot\s*\+\s*j\s*\*\s*2\.399963/.test(lotus),
    '层内又出现 `baseRot + j*2.399963`（golden angle）');
});

test('★ 荷花必须做俯视压扁 FLORA_FLAT（这才是「瓣间有缝」的来源）', () => {
  const lotus = methodBodyStripped(SRC, 'drawLotus() {');
  assert.ok(/ctx\.scale\(1,\s*FLORA_FLAT\)/.test(lotus),
    '荷花段没有 `ctx.scale(1, FLORA_FLAT)` ⇒ 花瓣没有「向上翘」的透视压扁。'
    + 'rotate 在俯视投影里不改变瓣长，只调瓣宽只会换来柳叶/飞镖。'
    + '压扁才是让邻瓣之间露出水色的正解（对照 docs/design-reference.png 左下角那朵）。');
  assert.ok(/const FLORA_FLAT\s*=\s*0\.\d+/.test(SRC),
    'FLORA_FLAT 常量不见了（必须是顶层 const，声明在使用点之前）');
});

test('★ 花苞外苞片必须比苞体窄（宽＝包裹是错的直觉）', () => {
  const lotus = methodBodyStripped(SRC, 'drawLotus() {');
  assert.ok(lotus, '找不到 drawLotus');
  /* 苞片路径里不能出现 hw*1.1x 这种超出苞体的宽度 */
  assert.ok(!/hw\s*\*\s*1\.[1-9]\d*/.test(lotus),
    '外苞片宽度又超过苞体了（hw*1.1x）⇒ 它会把粉色苞体整个盖住，'
    + '8× 实测整朵花苞读成一个绿色郁金香。苞片只应从苞体上半段往上收、宽度全程 < 苞体。');
  assert.ok(/hw\s*\*\s*0\.[0-8]\d*/.test(lotus),
    '找不到「苞片比苞体窄」的宽度系数（应是 hw*0.7x~0.8x）');
});

test('★ 每朵按时间缓开：BLOOM_PERIOD 循环必须挂在时间上，且相位是 i 的确定性函数', () => {
  const lotus = methodBodyStripped(SRC, 'drawLotus() {');
  assert.ok(lotus, '找不到 drawLotus');
  assert.ok(/const BLOOM_PERIOD\s*=\s*\d+/.test(SRC), 'BLOOM_PERIOD 常量不见了');
  assert.ok(/t\s*\/\s*BLOOM_PERIOD/.test(lotus),
    '开放度不再随时间变化 ⇒ 同一节气内所有花同步，用户说的「过程不对」会复现');
  assert.ok(/phase\s*=\s*i\s*\*\s*2\.399963/.test(lotus),
    '相位不是 `i * 2.399963 + …` 的确定性函数。'
    + '不能用 Math.random()：每帧抖 ⇒ 量具无法复现同一画面。');
  /* low 必须随档位抬高：否则早期档的花会「开成 0 又合上」，读成「掉了又长」 */
  assert.ok(/low\s*=\s*OPEN\s*\*\s*0\.\d+/.test(lotus),
    '没有 `low = OPEN * k` 的下限 ⇒ 立夏的花会周期性开成 0，物候方向被破坏');
});
