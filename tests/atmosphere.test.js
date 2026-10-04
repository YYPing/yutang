import test from 'node:test';
import assert from 'node:assert/strict';
import {Atmosphere, rainPosition} from '../src/engine/atmosphere.js';
import {ambientMix} from '../src/audio/ambient.js';
import {mapWeatherCode} from '../src/lib/environment.js';

test('rain lands at its target and produces a ripple there',()=>{
 const a=new Atmosphere({weather:'rainy',season:'autumn'},()=>.5);
 const d=a.drops[0];d.age=d.life;const target=rainPosition(d,1000,700,a.options);d.age-=.01;
 a.update(.02,1000,700);
 const hit=a.impacts.find(p=>p.kind==='rain');
 assert.ok(hit);assert.equal(hit.x,target.x);assert.equal(hit.y,target.y);
});
test('fallen leaves land, ripple, drift, and stay bounded over a long session',()=>{
 const a=new Atmosphere({weather:'sunny',season:'autumn'},()=>.5);
 a.nextLeaf=0;a.update(.02,1000,700);
 const leaf=a.leaves.find(l=>l.phase==='fall');assert.ok(leaf);
 for(let i=0;i<200;i++)a.update(.025,1000,700);
 assert.equal(leaf.phase,'float');assert.ok(a.landings>0);
 const x=leaf.u;for(let i=0;i<12000;i++)a.update(.05,1000,700);
 assert.notEqual(leaf.u,x);assert.ok(a.leaves.length<=30);assert.ok(a.impacts.length<=160);
});
test('storm thunder is intermittent, cancelled by weather changes; reduced motion suppresses flash',()=>{
 const a=new Atmosphere({weather:'stormy',season:'autumn'},()=>.5);
 let count=0;
 for(let i=0;i<2400;i++)count+=a.update(.05,1000,700).length;
 assert.ok(count>=3&&count<=6);
 a.configure({weather:'sunny'});for(let i=0;i<1000;i++)assert.equal(a.update(.05,1000,700).length,0);
 assert.equal(a.drops.length,0);assert.equal(a.flash,0);
 a.configure({weather:'stormy',reducedMotion:true});a.nextThunder=0;
 assert.equal(a.update(.05,1000,700).length,1);assert.equal(a.flash,0);
});
test('reduced motion holds floating foliage and limits raindrops',()=>{
 const a=new Atmosphere({weather:'rainy',season:'autumn',reducedMotion:true},()=>.5);
 const u=a.leaves[0].u;for(let i=0;i<100;i++)a.update(.05,1000,700);
 assert.equal(a.leaves[0].u,u);assert.ok(a.drops.length<=12);
});
test('weather sound mixes change with season, use rain for rain, and remain within the volume budget',()=>{
 for(const season of ['spring','summer','autumn','winter']) for(const weather of ['sunny','cloudy','rainy','snowy','stormy','foggy']){
  const mix=ambientMix(weather,season,false);assert.ok(Object.values(mix).reduce((a,b)=>a+b,0)<=1.001);
  assert.ok(mix.stream>=0&&mix.wind>=0&&mix.rain>=0);
 }
 assert.ok(ambientMix('sunny','winter').wind>ambientMix('sunny','spring').wind);
 assert.ok(ambientMix('rainy','summer').rain>ambientMix('rainy','summer').stream);
 assert.equal(ambientMix('sunny','summer').rain,0);
 assert.equal(mapWeatherCode(95),'stormy');assert.equal(mapWeatherCode(45),'foggy');
});

/* ══════════════════════════════════════════════════════════════════
 * 落叶数量由节气档案驱动（2026-10-04 接入 litterCount）
 *
 * ★ 这是「算了不画」的第四个马甲：term-visual.js 一直算得出 litterCount
 *   （立冬10 → 小雪6 → 大雪3 → 冬至2），但 atmosphere.js 按 season
 *   硬编码（autumn19/spring16/summer6/winter3）⇒ 冬六档一律 3 片橙叶。
 *   用户可见症状：冬至池面飘着秋叶。
 *
 * ★ 每条都配阳性对照 —— 否则"全改成 0 片"也能让某些断言变绿。
 * ══════════════════════════════════════════════════════════════════ */
test('落叶存量跟着 litterCount 走（冬六档不再一律 3 片）',()=>{
 const counts=[10,6,3,2,2,2];                       // 立冬→大寒，实测档案值
 for(const [i,n] of counts.entries()){
  const a=new Atmosphere({season:'winter',litterCount:n});
  assert.equal(a.leaves.length,n,`第 ${i} 档存量应为 ${n}，实为 ${a.leaves.length}`);
 }
 // 阳性对照：同一季节下档案给不同值 ⇒ 存量必须真的不同
 //（不是"恰好都等于季节默认 3"）
 assert.notEqual(
  new Atmosphere({season:'winter',litterCount:2}).leaves.length,
  new Atmosphere({season:'winter',litterCount:10}).leaves.length);
});

test('没有 litterCount 时保留季节硬编码（老存档与既有单测不能被清空）',()=>{
 assert.equal(new Atmosphere({season:'autumn'}).leaves.length,19);
 assert.equal(new Atmosphere({season:'spring'}).leaves.length,16);
 assert.equal(new Atmosphere({season:'summer'}).leaves.length,6);
 assert.equal(new Atmosphere({season:'winter'}).leaves.length,3);
});

test('litterCount=0 时不再补叶（速率通道也要归零，不只是存量）',()=>{
 const a=new Atmosphere({season:'autumn',litterCount:19});
 a.syncLitter(0);
 assert.equal(a.leaves.length,0);
 a.nextLeaf=-1;                                    // 强制立刻触发补充分支
 for(let i=0;i<600;i++)a.update(.05,1000,700);     // 30 秒
 assert.equal(a.leaves.length,0,'0 片却自己长出来了');
 assert.equal(a.nextLeaf,Infinity,'间隔必须是 Infinity 而不是 0（0 会每帧触发）');
});

test('syncLitter 压低存量后跑一分钟不会自己长回去',()=>{
 const a=new Atmosphere({season:'autumn',litterCount:19},()=>.5);
 a.syncLitter(2);
 for(let i=0;i<1200;i++)a.update(.05,1000,700);
 // ⚠️ 固定随机源（`()=>.5`）+ 只断言**方向**：
  //   落叶会自然消亡（life 到期 / 漂出边界被filter），带随机性。
  //   不固定种子时"单跑连过三次、全量必红"—— 那是**测试自身抖动**，不是实现回归。
 // ⚠️ 不能断言 `=== 2`：补叶间隔是 36s，而 60 秒内完全可能掉到 1 片。
//   真正的判据是**方向**：不能回到 19（说明上界没生效），也不能归零（另一端的病）。
 assert.ok(a.leaves.length>0&&a.leaves.length<=2,
  `存量应在 1~2 之间（不回到 19、不归零），实为 ${a.leaves.length}`);
 // 阳性对照：档内补叶机制本身没被改坏 —— 存量被**自然消亡**压到 target 以下时，
  // 仍然要补得回来（不然就成了"补叶彻底停摆"）。
 // ⚠️ 第一版这里写成"值不变时补叶必须照常"，是**断言写错了**：
  //   存量恰好等于 target 时按设计不补（否则又长回 19 片，正是本测试要防的病）。
  //   正确的对照是"低于 target 时能补"。
 const b=new Atmosphere({season:'autumn',litterCount:19});
 b.syncLitter(19);
 b.leaves.splice(0,5);                       // 模拟 5 片被风吹走/漂出边界
 const before=b.leaves.length;
 b.nextLeaf=0;b.update(.02,1000,700);
 assert.ok(b.leaves.length>before,
  `存量(${before}) 低于 target(19) 时必须补叶，实为 ${b.leaves.length}`);
});

test('补充间隔在目标=季节默认时精确等于原手感（不因接入档案而变慢）',()=>{
 for(const [s,n] of Object.entries(Atmosphere.LITTER_FALLBACK)){
  const a=new Atmosphere({season:s,litterCount:n});
  const base=Atmosphere.LITTER_BASE_MS[s];
  const got=a.litterInterval(a.options,n);
  assert.ok(Math.abs(got-base)<1e-9,`${s} 间隔应为原基数 ${base}s，实为 ${got}`);
 }
});
