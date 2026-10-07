const TAU=Math.PI*2;
export function windStrength(weather,season){return ({stormy:1.7,rainy:.85,cloudy:.65,snowy:.5,foggy:.18}[weather]??.28)+({autumn:.25,winter:.2,spring:.07}[season]??0)}
const wet=w=>w==='rainy'||w==='stormy';
/** Overscan both ends of a streak: rain covers the viewport, including its bottom edge. */
export function rainPosition(drop,width,height,options={}){
 // ★★ 2026-10-07（P2-2）：节气雨（`rainAmount>0` 但天气不是雨）也要有**斜度**。
 //   `windStrength` 在sunny 下只有 .28+季节加成 ⇒slant≈.09，雨丝几乎垂直，
 //   读成「垂直的白线」而不是雨。⇒ 有节气雨时额外补 .35 的风。
 //   ⚠️ 只在 `rainAmount>0` 时加：不能改`windStrength` 本身 ——
 //   它同时驱动落叶漂移与浮叶速度，无条件加会连带改变秋天的落叶手感。
 const base=windStrength(options.weather,options.season);
 const slant=(base+(Number.isFinite(options.rainAmount)&&options.rainAmount>0?.35:0))*.25;
 const fall=drop.height*(1-Math.min(1,drop.age/drop.life)),margin=drop.height*slant+12;
 return {x:drop.u*(width+margin*2)-margin+fall*slant,y:drop.v*(height+drop.height)-fall,slant};
}
/** Bounded, time-based weather particles. Rain and leaves each own their landing event. */
export class Atmosphere{
 constructor(options={},random=Math.random){this.random=random;this.options={};this.time=0;this.leaves=[];this.drops=[];this.termDrops=[];this.impacts=[];this.flash=0;this.landings=0;this.rainHits=0;this.configure(options)}
 point(){return {u:.18+this.random()*.62,v:.12+this.random()*.72}}
 drop(){return {u:this.random(),v:this.random(),age:0,life:.65+this.random()*.7,seed:this.random(),height:140+this.random()*140}}
 leaf(falling=false){const p=this.point();return {...p,phase:falling?'fall':'float',age:0,life:95+this.random()*90,fallTime:2.8+this.random()*1.8,angle:this.random()*TAU,seed:this.random(),size:(this.options.season==='spring'?5:12)+this.random()*(this.options.season==='spring'?6:13),variant:Math.floor(this.random()*3),fromRight:this.random()>.5}}
 /**
  * 落叶目标片数 —— 由节气档案 `litterCount` 驱动（0–20 片）。
  *
  * ★ 2026-10-04 接入：原先按 `season` 硬编码（autumn19/spring16/summer6/winter3），
  *   于是「大雪 / 冬至 / 小寒 / 大寒」全都飘 3 片橙色秋叶 ——
  *   翻译层**已经算好了** `litterCount`（立冬10 → 小雪6 → 大雪3 → 冬至2），
  *   但渲染层从没读过它，是典型的「算了不画」。
  *
  * ⚠️ 为什么不能直接 `litterCount` 一刀切：
  *   ① 存量与速率是**两个通道**。存量在 `configure` 里一次性铺满；
  *     速率在 `update` 里由 `nextLeaf` 控制。冬至该"少"，若只改存量，
  *     落叶仍以季节速率不断补进来，几分钟后又飘满。
  *   ② 速率不能取 0 —— `nextLeaf=0` 会每帧触发补叶，所以 0 片必须显式 return。
  *   ③ 没有 `litterCount` 的调用方（老存档 / 单测直接 new Atmosphere）
  *     必须**原样保留**季节硬编码值，否则会静默把秋天的落叶清空。
  */
 /*★★ 2026-10-07：`LITTER_FALLBACK.winter` 由 3 改成 **0**（用户评审清单 P0-1
 *   「擦干净冬季水面残留的橙黄枫叶」）。落叶贴图是**暖色高饱和**的，
 *   漂在冷蓝/雪白水面上就是清单说的违和（`scenery.js` 同时把冬季改成枯叶色）。
 *   ⚠️ 下面 `litterTarget` 末尾的 `??3` 也必须改成 `??0` ——
 * *   只改表不改兜底，`season` 是 winter 时若键缺失/拼错，会静默回落到 3 片。
 *   ⇒ **无档案路径（老存档、单测直接 new Atmosphere）也要一起清**，
 *      否则「改了档案就以为完了」会漏掉最旧那一档。 */
 static LITTER_FALLBACK={autumn:19,spring:16,summer:6,winter:0};
 /* 补充间隔基数（秒），沿用原季节手感。 */
 static LITTER_BASE_MS={autumn:4,spring:5,summer:14,winter:24};
 /*★★ 2026-10-07（P2-2「雨水不下雨」）新增 `termDrops` 通道。
  *   根因：雨丝是**天气门控**（`wet(weather)` 才建 drops），而天气来自城市天气 API
  *   或用户设置 ⇒「雨水这一档该下雨」这件事被**交给了天气**，演示轮转到雨水却晴天。
  *   ⇒ 正解与降雪同构（`pond.js` 的 `Math.round(14+18*v.ice)` 在非 snowy 天气也画）：
  *     **天气决定「要不要更猛」，节气决定「有没有」。**
  *
  * ★ 为什么**另开一个数组**而不是把两条通道合进 `this.drops`：
  *   `drops` 的重建条件是「天气/画质/reducedMotion 变了」（在 `configure` 里），
  *   而节气雨势在渐变模式下**每帧都在变**。若并进去，要么每帧重建
  *   （⇒ 全部雨滴位置被重置，视觉上「雨点整体闪一下」），
  *   要么给 `configure` 加逐帧分支（⇒ 与它「一次性铺满」的语义冲突）。
  *   拆成两个数组后：天气雨仍由 configure 一次性铺满，节气雨只**增删尾部**，
  *   两条通道各管一段、互不重置已有雨滴。
  *
  * ★★ 满档条数为什么是 70 而不是第一版的 44（2026-10-07 目视返工）：
  *   第一版按「物候雨≠暴雨」取 44（天气雨是 72），理由听起来对，但**1× 目视不成立** ——
  *   放大截图里雨丝与落水环都清清楚楚，1× 全图几乎读不出来。
  *   ★ 这就是 skill `canvas-visual-acceptance` 说的「8× 好看但 1× 不成立」。
  *   ⚠️ 但**归因不是条数**：44→70（+59%）时雨的屏幕占比一位没动（0.118%），
  *     真正见效的是「雨丝长度 12+9s→15+11s + 线宽 .85→1.15」（见 `scenery.rain`）。
  //     ⇒ 条数 70 的作用是**让长度/线宽的改动有足够密度可辨**，
  //     单靠加条数只是把同样的稀薄重复 70 次。
  *   ⇒ 判据也一并升级：`check-rain-fall` 除了落点提亮，还量**1× footprint**
  *     （on/kill 差分，随雨量单调）—— 只量 on/kill 差值的话，
  *     一个「存在但太淡」的雨也能过关。
  *   70 是折中：接近天气雨 72，物候上「雨水 = 全年降水峰值」站得住。 */
  static TERM_RAIN_MAX=70;   // 节气雨满档（雨水=1）的雨丝条数。见上方目视返工记录
 /** 节气雨目标条数。老存档/单测直接 new Atmosphere 时没有 `rainAmount` ⇒ 0（保持原样）。 */
 termRainTarget(o){
  if(!Number.isFinite(o?.rainAmount))return 0;
  const scale=(o.reducedMotion?.3:1)*(o.quality==='low'?.5:1);
  return Math.max(0,Math.round(o.rainAmount*Atmosphere.TERM_RAIN_MAX*scale));
 }
 /** 节气雨与天气雨的合集 —— `update` 的老化/落水与 `scenery.rain` 的绘制都读它。
  *  ⚠️ 没有节气雨时**直接返回 `drops` 本体**（不做 concat，避免每帧新建数组）。 */
 get rainDrops(){return this.termDrops.length?this.drops.concat(this.termDrops):this.drops}
 /** 每帧同步节气雨势（与 `syncLitter` 同构：值不变直接返回，只增删尾部不重铺）。 */
 syncRain(amount){
  if(!Number.isFinite(amount))return;
  this.options.rainAmount=Math.max(0,Math.min(1,amount));
  const target=this.termRainTarget(this.options);
  if(target===this.termDrops.length)return;
  this.termDrops=target>this.termDrops.length
   ?Array.from({length:target-this.termDrops.length},()=>{const d=this.drop();d.age=this.random()*d.life;return d})
   :this.termDrops.slice(0,target);
 }
 litterTarget(o){return Number.isFinite(o?.litterCount)?Math.max(0,Math.round(o.litterCount)):(Atmosphere.LITTER_FALLBACK[o?.season]??0)}
 /** 补充上界 —— **只有档案驱动时才生效**。
  *  ⚠️ 没有 `litterCount` 时返回 Infinity（旧的 30 片硬上限由 update 里那一行保留）。
  *    这条区分不是洁癖：原来秋天的落叶会从初始 19 片**一路堆到 30 片**封顶，
  *    若把上界改成季节默认值 19，就等于悄悄削掉了秋天的落叶量 ——
  *    老存档和既有单测（`assert.ok(a.leaves.length<=30)` 那条走的就是无档案路径）都依赖它。 */
 litterCeiling(o){return Number.isFinite(o?.litterCount)?this.litterTarget(o):Infinity}
 /** 每帧同步落叶目标（档案在渐变模式下逐帧变，不能只在 configure 里对一次）。
  *  ⚠️ 值不变就直接返回 —— 否则每帧都白跑一遍 configure 的重建分支。 */
 syncLitter(count){
  if(!Number.isFinite(count))return;
  const target=Math.max(0,Math.round(count));
  if(target===this.litterTarget(this.options)&&target===this.leaves.length)return;
  //★ 记下"这次是档案驱动"，之后configure 才知道该不该用target 当上界。
  this.options.litterCount=target;
  const prevLen=this.leaves.length;
  this.leaves=this.leaves.slice(0,target);
  while(this.leaves.length<target)this.leaves.push(this.leaf());
  // ★ 只在"变多"时重置倒计时：否则目标→0→目标 的来回会让 nextLeaf 一直被推后，
  //   补叶节奏变得不可预测（而这正是"存量变少时不该再补"的场景）。
  if(target>prevLen)this.nextLeaf=3;
 }
 /** 存量少得多 ⇒ 补得更快，两个通道指向同一个目标。Infinity = 不再补。 */
 litterInterval(o,target){if(!(target>0))return Infinity;const base=Atmosphere.LITTER_BASE_MS[o.season]??8;return base*(Atmosphere.LITTER_FALLBACK[o.season]??8)/target}
 configure(partial){
  const previous=this.options;this.options={season:'autumn',weather:'sunny',quality:'high',reducedMotion:false,...previous,...partial};
  const o=this.options;
  // ★ 重建条件从「季节变了」扩成「季节变了 **或** 落叶目标变了」。
  //   少了后半句，交节时 litterCount 的变化不会反映到存量上（又是一次静默失效）。
  if(previous.season!==o.season||!this.leaves.length||previous.litterCount!==o.litterCount){
   const count=this.litterTarget(o);
   // 目标变小时截断，变大时**只补差额** —— 不重铺。
   //   重铺会把已有落叶的 phase/age/位置全部重置（可见的"整体闪一下"）。
   this.leaves=this.leaves.slice(0,count);
   while(this.leaves.length<count)this.leaves.push(this.leaf());
   this.nextLeaf=3;
  }
  if(previous.weather!==o.weather||previous.quality!==o.quality||previous.reducedMotion!==o.reducedMotion){
   const count=wet(o.weather)?(o.reducedMotion?10:o.quality==='low'?32:o.weather==='stormy'?96:72):0;
   this.drops=Array.from({length:count},()=>{const d=this.drop();d.age=this.random()*d.life;return d});
   this.impacts=this.impacts.filter(p=>p.kind!=='rain');this.flash=0;
   if(previous.weather!==o.weather)this.nextThunder=o.weather==='stormy'?8+this.random()*6:Infinity;
  }
 }
 impact(x,y,kind){if(this.impacts.length>=160)this.impacts.shift();this.impacts.push({x,y,age:0,life:kind==='rain'?1.35:2.1,kind});if(kind==='rain')this.rainHits++;else this.landings++}
 update(dt,width,height,fish=[],hand={},isWater=()=>true){
  dt=Math.max(0,Math.min(.05,dt));this.time+=dt;const events=[],o=this.options,wind=windStrength(o.weather,o.season);
  this.impacts=this.impacts.filter(p=>(p.age+=dt)<p.life);
  for(const d of this.rainDrops){d.age+=dt;if(d.age>=d.life){const p=rainPosition(d,width,height,o);if(p.x>=0&&p.x<=width&&p.y>=0&&p.y<=height&&isWater(p.x,p.y))this.impact(p.x,p.y,'rain');Object.assign(d,this.drop())}}
  this.flash=Math.max(0,this.flash-dt*.22);
  if(o.weather==='stormy'&&(this.nextThunder-=dt)<=0){this.nextThunder=23+this.random()*22;this.flash=o.reducedMotion?0:.075;events.push({delay:900+this.random()*1200})}
  if(o.reducedMotion)return events;
  this.nextLeaf-=dt;
  // ★ 补充速率也要跟着档案走（存量之外的第二个通道）。
  //   target=0（谷雨/惊蛰实测 litter=0）⇒ nextLeaf=Infinity，
  //   不能靠"`nextLeaf<=0` 自然跳过"—— 那会让每帧都进这个分支补出一片。
  if(this.nextLeaf<=0){
   const target=this.litterTarget(o);
   const gap=this.litterInterval(o,target);
   // ⚠️ 上界必须同时卡 30（池面物理上限）和 target（档案要的片数）。
   //只卡 30 的话：冬六档目标 2 片，但只要历史存量到过 30，
   //   就会一直补到 30 才停 ⇒ 冬至又飘起一堆秋叶（存量被压缩后又自己长回来）。
   const ceiling=Math.min(30,this.litterCeiling(o));
   if(target>0&&this.leaves.length<ceiling)this.leaves.push(this.leaf(true));
   this.nextLeaf=gap===Infinity?Infinity:gap+this.random()*6;
  }
  for(const l of this.leaves){
   l.age+=dt;l.angle+=dt*(.025+wind*.035)*Math.sin(l.seed*TAU+this.time*.3);
   if(l.phase==='fall'){
    if(l.age>=l.fallTime){l.phase='float';l.age=0;this.impact(l.u*width,l.v*height,'leaf')}
   }else{
    const frozen=o.season==='winter'||o.weather==='snowy';if(frozen)continue;
    l.u+=dt*(3.3+wind*4+Math.sin(this.time*.18+l.seed*9)*1.6)/width;
    l.v+=dt*(1.2+Math.sin(this.time*.22+l.seed*7)*1.8)/height;
    const push=(x,y,radius,power)=>{const dx=l.u*width-x,dy=l.v*height-y,d=Math.hypot(dx,dy);if(d>1&&d<radius){const f=(1-d/radius)**2*power*dt;l.u+=dx/d*f/width;l.v+=dy/d*f/height;l.angle+=f*.006}};
    for(const f of fish)push(f.x,f.y,80,26);
    if(hand.life>0)push(hand.x,hand.y,100,60);
   }
  }
  this.leaves=this.leaves.filter(l=>l.age<l.life&&l.u<.88&&l.v<.91);
  return events;
 }
}
