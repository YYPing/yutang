const TAU=Math.PI*2;
export function windStrength(weather,season){return ({stormy:1.7,rainy:.85,cloudy:.65,snowy:.5,foggy:.18}[weather]??.28)+({autumn:.25,winter:.2,spring:.07}[season]??0)}
const wet=w=>w==='rainy'||w==='stormy';
/** Overscan both ends of a streak: rain covers the viewport, including its bottom edge. */
export function rainPosition(drop,width,height,options={}){
 const slant=windStrength(options.weather,options.season)*.25;
 const fall=drop.height*(1-Math.min(1,drop.age/drop.life)),margin=drop.height*slant+12;
 return {x:drop.u*(width+margin*2)-margin+fall*slant,y:drop.v*(height+drop.height)-fall,slant};
}
/** Bounded, time-based weather particles. Rain and leaves each own their landing event. */
export class Atmosphere{
 constructor(options={},random=Math.random){this.random=random;this.options={};this.time=0;this.leaves=[];this.drops=[];this.impacts=[];this.flash=0;this.landings=0;this.rainHits=0;this.configure(options)}
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
 static LITTER_FALLBACK={autumn:19,spring:16,summer:6,winter:3};
 /** 补充间隔基数（秒），沿用原季节手感。 */
 static LITTER_BASE_MS={autumn:4,spring:5,summer:14,winter:24};
 litterTarget(o){return Number.isFinite(o?.litterCount)?Math.max(0,Math.round(o.litterCount)):(Atmosphere.LITTER_FALLBACK[o?.season]??3)}
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
  for(const d of this.drops){d.age+=dt;if(d.age>=d.life){const p=rainPosition(d,width,height,o);if(p.x>=0&&p.x<=width&&p.y>=0&&p.y<=height&&isWater(p.x,p.y))this.impact(p.x,p.y,'rain');Object.assign(d,this.drop())}}
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
