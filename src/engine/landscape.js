import {windStrength} from './atmosphere.js';
import {landscapeDimensions} from './rendering.js';
import {CAUSTIC} from './light-field.js';
const vertex=`attribute vec2 aPosition;varying vec2 vUv;void main(){vUv=(aPosition+1.0)*.5;gl_Position=vec4(aPosition,0.,1.);}`;
const fragment=`precision highp float;
uniform sampler2D uImage;uniform vec2 uCover;uniform vec2 uSize;uniform vec2 uTexel;uniform vec3 uPointer;uniform float uTime;uniform float uWind;uniform float uMotion;uniform float uClarity;
uniform float uCausticInk;uniform float uCausticScale;uniform float uCausticWarp;uniform float uCausticWarpSpeed;uniform float uCausticDrift;uniform float uCausticSharp;uniform float uCausticGate;uniform float uCausticShallow;
/* F-24 per-term tint: lets 24 solar terms differ even though there are
   only 4 background images; the tint applies over water only. */
uniform vec3 uTermTint;uniform float uTermTintAmt;
/* F-24b structured tint: a second weight that lets the term colour vary
   ACROSS the surface instead of uniformly. 0 = flat (old behaviour),
   1 = full spatial structure. */
uniform float uTermPattern;
varying vec2 vUv;
float oval(vec2 p,vec2 c,vec2 s){return 1.-smoothstep(.55,1.,length((p-c)/s));}
/* Water-surface caustic net (F-10.5 companion).
   Domain-warped periodic grid: fract() makes cell COUNT a real control.
   WARNING - plain (uv*scale) would only change cell SIZE, not density: the
   duty cycle stays ~19% at every scale and the net reads as flat grey fog.
   Measured by tools/probe-caustic.mjs; do not "simplify" this back.
   NOTE this whole block lives inside a JS template string: never use a
   backtick or a // line comment in here, both break the build.
   uCausticInk is the only amplitude knob. */
float causticNet(vec2 p,float t){
 vec2 drift=vec2(t*.13,-t*.09);
 vec2 q=p;
 /* domain warp: two incommensurate drift rates so the mesh never looks translated */
 q+=.42*vec2(sin(p.y*2.3+t*.26),cos(p.x*1.9-t*.21));
 q+=.24*vec2(sin(p.x*3.1-t*.19),cos(p.y*2.7+t*.17));
 vec2 cell=fract((q+drift)*2.6)-.5;
 /* ridge of cell-local Chebyshev distance: bright at borders, dark at centres */
 float d=max(abs(cell.x),abs(cell.y));
 return pow(clamp(1.-smoothstep(0.,.30,d),0.,1.),1.6);
}
void main(){
 vec2 screen=vec2(vUv.x,1.-vUv.y),uv=(screen-.5)*uCover+.5;
 vec3 original=texture2D(uImage,uv).rgb;
 // Animate only saturated leaf/blade pixels inside local rooted plant patches.
 float water=smoothstep(.015,.08,min(original.g,original.b)-original.r);
 float chroma=max(original.r,original.g)-original.b;
 float plantColor=smoothstep(.09,.25,chroma)*(1.-water);
 float rocks=max(oval(uv,vec2(.88,.83),vec2(.19,.22)),max(oval(uv,vec2(.08,.06),vec2(.15,.14)),oval(uv,vec2(.145,.965),vec2(.2,.15))));
 float leftReeds=oval(uv,vec2(.055,.52),vec2(.11,.31))*smoothstep(.006,.085,uv.x);
 leftReeds=max(leftReeds,oval(uv,vec2(.125,.76),vec2(.125,.14))*smoothstep(.03,.18,uv.x));
 float rightReeds=oval(uv,vec2(.97,.49),vec2(.085,.16))*smoothstep(.005,.06,1.-uv.x);
 float upperLeaves=oval(uv,vec2(.92,.055),vec2(.24,.17))*smoothstep(.006,.12,uv.y);
 float lowerLeaves=oval(uv,vec2(.965,.94),vec2(.13,.15))*smoothstep(.005,.10,1.-uv.x);
 float tips=max(max(leftReeds,rightReeds),max(upperLeaves,lowerLeaves));
 float foliage=tips*plantColor*(1.-rocks);
 float gust=sin(uTime*.85+uv.y*19.)*.6+sin(uTime*.39+uv.x*27.)*.4;
 vec2 pointDelta=(screen-uPointer.xy)*uSize;
 float nearHand=(1.-smoothstep(0.,110.,length(pointDelta)))*uPointer.z;
 vec2 bend=vec2(gust*(1.7+uWind*1.5)+nearHand*sign(pointDelta.x)*2.8,sin(uTime*.7+uv.x*18.)*.65);
 vec2 sampleUv=clamp(uv+bend/uSize*uCover*foliage*uMotion,vec2(.0001),vec2(.9999));
 vec3 color=texture2D(uImage,sampleUv).rgb;
 /* Caustic net: light is added, never subtracted, and only where the mask says water.
    Shallow edges get a brighter/denser mesh; deep centre stays quiet so the
    F-10.5 "dark corner .67" measurement does not move. */
 /* Per-term water tint (F-24): 24 terms share only 4 background images, so the
    tint is what actually separates the six terms of one season.
    Mixed over the water mask only - the banks keep their painted colour.
    ⚠️ This block lives inside a JS template string: no backticks, no // comments. */
 if(uTermTintAmt>0.){
  /* Push the water toward the term's tint while keeping some of the original
     hue: a full replacement would look like a colour filter over a photo.
     ------------------------------------------------------------------
     F-24b: the tint amount is no longer flat over the whole pond. 'pattern'
     modulates it with a **spatially varying** weight built from two terms that
     are already in this shader:
       · shallow - distance-to-centre falloff (1 near the banks)
       · caustic - the animated light net (its own structure)
     A flat tint reads as "the light changed", which the eye discards (measured
     岸边/池心 ratio 0.58: darker banks make multiplicative tint land on the
     water regardless of any weight). Spatially varying, the same tint is read
     as "the pond itself changed". 'uTermPattern' 0 keeps the old flat look so
     the change is reversible by one uniform. */
  float spatial=1.;
  if(uTermPattern>0.){
   /* Two-scale structure. Measured 2026-10-04: the FIRST version used
      broad=mix(.55,1.25,...) whose mean is 1.0, so multiplying it in made the
      overall tint slightly WEAKER (measured dE 3.28 -> 3.04) and also cancelled
      out part of the term difference. Now the pattern only ever *adds*
      (spatial >= 1), so it can lift the banks without dulling the centre. */
   float broad=1.+uTermPattern*.42*smoothstep(.02,.30,length(uv-vec2(.5)));
   float fine=1.+uTermPattern*.38*(causticNet(uv*uCausticScale,uTime)-.42);
   spatial=min(broad*fine,1.75);
  }
  vec3 tinted=mix(color,color*uTermTint,clamp(water*uTermTintAmt*spatial,0.,1.));
  color=tinted;
 }
 if(uCausticInk>0.){
  float shallow=smoothstep(.34,.02,length(uv-vec2(.5)));   /* 1 near the banks */
  float net=causticNet(uv*uCausticScale, uMotion>0.?uTime:0.);
  net=smoothstep(uCausticGate,1.,net);
  float amount=uCausticInk*net*(.45+uCausticShallow*shallow)*water*uMotion;
  color+=vec3(.62,.86,1.)*amount;   // cool daylight tint, not white
 }
 // A restrained edge-contrast correction counters the illustration's soft
 // scaling; it does not invent texture detail. Clamp it to prevent bright halos.
 if(uClarity>0.){
  vec2 dx=vec2(uTexel.x*1.6,0.),dy=vec2(0.,uTexel.y*1.6);
  vec3 neighbors=(texture2D(uImage,sampleUv-dx).rgb+texture2D(uImage,sampleUv+dx).rgb+texture2D(uImage,sampleUv-dy).rgb+texture2D(uImage,sampleUv+dy).rgb)*.25;
  color+=clamp((color-neighbors)*uClarity,vec3(-.018),vec3(.018));
 }
 gl_FragColor=vec4(clamp(color,0.,1.),1.);
}`;
/** Stable illustration with small, rooted, color-masked leaf motion. Water waves are a separate layer. */
export class Landscape{
 constructor(canvas){
  this.canvas=canvas;this.images=new Map();this.textures=new Map();this.waterMasks=new Map();this.dead=false;this.ready=false;
  if(!canvas)return;
  this.lost=e=>{e.preventDefault();this.ready=false;this.lastDraw=null;canvas.style.opacity='0';this.textures.clear()};
  this.restored=()=>{try{this.init();this.season=null}catch{this.ready=false}};
  canvas.addEventListener('webglcontextlost',this.lost);canvas.addEventListener('webglcontextrestored',this.restored);
  try{this.init()}catch{canvas.style.opacity='0'}
 }
 init(){
  const gl=this.canvas.getContext('webgl',{alpha:false,antialias:false,depth:false,powerPreference:'low-power'});if(!gl)return;this.gl=gl;
  const shader=(type,source)=>{const s=gl.createShader(type);gl.shaderSource(s,source);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS)){gl.deleteShader(s);throw Error('Landscape shader unavailable')}return s};
  const vs=shader(gl.VERTEX_SHADER,vertex),fs=shader(gl.FRAGMENT_SHADER,fragment),p=gl.createProgram();gl.attachShader(p,vs);gl.attachShader(p,fs);gl.linkProgram(p);gl.deleteShader(vs);gl.deleteShader(fs);if(!gl.getProgramParameter(p,gl.LINK_STATUS)){gl.deleteProgram(p);throw Error('Landscape program unavailable')}
  this.program=p;gl.useProgram(p);this.buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,this.buffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]),gl.STATIC_DRAW);
  const pos=gl.getAttribLocation(p,'aPosition');gl.enableVertexAttribArray(pos);gl.vertexAttribPointer(pos,2,gl.FLOAT,false,0,0);
  this.uniforms=Object.fromEntries(['uImage','uCover','uSize','uTexel','uPointer','uTime','uWind','uMotion','uClarity','uCausticInk','uCausticScale','uCausticWarp','uCausticWarpSpeed','uCausticDrift','uCausticSharp','uCausticGate','uCausticShallow','uTermTint','uTermTintAmt','uTermPattern'].map(n=>[n,gl.getUniformLocation(p,n)]));gl.uniform1i(this.uniforms.uImage,0);
  const viewport=gl.getParameter(gl.MAX_VIEWPORT_DIMS);
  this.maxSurfaceSize=Math.min(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE),viewport[0],viewport[1]);
  this.lastDraw=null;this.ready=true;
 }
 resize(width,height,dpr){
  if(!this.canvas)return;this.width=width;this.height=height;
  const [w,h]=landscapeDimensions(width,height,dpr,this.maxSurfaceSize);
  if(this.canvas.width!==w||this.canvas.height!==h){this.canvas.width=w;this.canvas.height=h;this.lastDraw=null}
 }
 getStats(){
  const image=this.images.get(this.season);
  return {backgroundSize:this.ready&&this.gl&&!this.gl.isContextLost()?[this.gl.drawingBufferWidth,this.gl.drawingBufferHeight]:null,
   sourceSize:image?.naturalWidth?[image.naturalWidth,image.naturalHeight]:null};
 }
 texture(season){
  if(this.textures.has(season))return this.textures.get(season);
  const image=this.images.get(season);
  if(image?.complete&&image.naturalWidth){
   const gl=this.gl,texture=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,texture);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGB,gl.RGB,gl.UNSIGNED_BYTE,image);this.textures.set(season,texture);return texture;
  }
  if(!image){const img=new Image();this.images.set(season,img);img.onload=()=>{if(!this.dead){this.cacheWaterMask(season,img);this.onLoad?.()}};img.src=`${import.meta.env.BASE_URL}assets/${season==='summer'?'pond':season}.png?v=1.5`}
  return null;
 }
 cacheWaterMask(season,image){
  // A one-time small color mask prevents rain from drawing water rings on dry banks.
  const c=document.createElement('canvas');c.width=384;c.height=216;
  const ctx=c.getContext('2d',{willReadFrequently:true});ctx.drawImage(image,0,0,384,216);
  const pixels=ctx.getImageData(0,0,384,216).data,mask=new Uint8Array(384*216);
  for(let i=0;i<mask.length;i++)mask[i]=Math.min(pixels[i*4+1],pixels[i*4+2])-pixels[i*4]>10?1:0;
  this.waterMasks.set(season,mask);c.width=c.height=0;
 }
 waterAt(x,y){
  const mask=this.waterMasks.get(this.season);if(!mask||!this.width)return true;
  const ratio=this.width/this.height,cx=Math.min(1,ratio/(16/9)),cy=Math.min(1,(16/9)/ratio);
  const u=(x/this.width-.5)*cx+.5,v=(y/this.height-.5)*cy+.5;
  if(u<0||u>=1||v<0||v>=1)return false;
  return !!mask[Math.floor(v*216)*384+Math.floor(u*384)];
 }
 render(time,options,hand){
  if(!this.ready||!this.width||this.gl.isContextLost())return;
  const gl=this.gl,season=options.weather==='snowy'?'winter':options.season,texture=this.texture(season);
  if(!texture){this.canvas.style.opacity='0';return}
  this.season=season;this.canvas.style.opacity='1';const u=this.uniforms;
  // Large native backgrounds keep their full pixel grid. Only the tiny plant
  // sway samples at 30 Hz above 4K; fish, rain and water continue at 60 Hz.
  const rate=this.canvas.width*this.canvas.height>3840*2160?30:60;
  const tick=options.reducedMotion?0:Math.floor(time*rate+1e-6);
  const key=`${season}:${options.weather}:${options.reducedMotion}:${options.quality}:${options.desktopMode}`;
  if(this.lastDraw?.tick===tick&&this.lastDraw.key===key)return;
  this.lastDraw={tick,key};
  gl.viewport(0,0,this.canvas.width,this.canvas.height);gl.useProgram(this.program);gl.bindTexture(gl.TEXTURE_2D,texture);
  const ratio=this.width/this.height,aspect=3840/2160;
  gl.uniform2f(u.uCover,ratio<aspect?ratio/aspect:1,ratio>aspect?aspect/ratio:1);
  gl.uniform2f(u.uSize,this.width,this.height);gl.uniform3f(u.uPointer,(hand.x||0)/this.width,(hand.y||0)/this.height,Math.min(1,hand.life||0));
  const image=this.images.get(season);gl.uniform2f(u.uTexel,1/image.naturalWidth,1/image.naturalHeight);
  gl.uniform1f(u.uClarity,options.desktopMode&&options.quality!=='low'?.28:0);
  // Caustic net: amplitude is the product of weather and season gates. Low quality
  // drops it entirely — the mesh is a high-frequency texture and aliases badly.
  // ★ 焦散强度改由 options.termVisual.causticInk 决定（它已经含 weather/season 门控
  //   与 warmth 连续调制，见 term-visual.js）。没有 termVisual 时退回旧的四季查表 ——
  //   老存档 / 无档案路径必须还能正常渲染，不能因为新通道缺失就黑屏。
  const v=options.termVisual;
  const caustic=options.quality==='low'?0
    :(v?v.causticInk:CAUSTIC.ink*(CAUSTIC.weather[options.weather]??1)*(CAUSTIC.season[options.season]??1));
  gl.uniform1f(u.uCausticInk,options.reducedMotion?caustic*.35:caustic);
  gl.uniform1f(u.uCausticScale,CAUSTIC.scale);gl.uniform1f(u.uCausticWarp,CAUSTIC.warp);
  gl.uniform1f(u.uCausticWarpSpeed,CAUSTIC.warpSpeed);gl.uniform1f(u.uCausticDrift,CAUSTIC.driftSpeed);
  gl.uniform1f(u.uCausticSharp,CAUSTIC.sharpness);gl.uniform1f(u.uCausticGate,CAUSTIC.gate);
  gl.uniform1f(u.uCausticShallow,CAUSTIC.shallowGain);
  /* Per-term water tint. Neutral multiplier (1,1,1) when there is no profile, so
     the image is untouched on the legacy path. */
  if(u.uTermTint&&v){
   /* ★★★ 这三个基址/跨度是**按 tint 的实际取值域反推**的，不是拍脑袋。
    *   旧写法 `0.72 + tintR*0.56`：tintR 的定义域是 .30(隆冬)~.55(盛夏)，
    *   于是 R 落在 .888~1.028、G 落在 .936~1.014 —— **两端都溢出 1.0**。
    *   后果是芒种/夏至/小暑/大暑/立秋的 R、G 全被 clamp 成 1.0，
    *   五档之间在水色上**完全无差别**（像素验收实测 夏至→小暑 仅 0.128%，
    *   远低于噪声底的 4 倍）。
    *   正解：把定义域端点**严格对齐**到目标区间 ——
    *   `base + tint*(1-base)`，其中 base 是"该通道最暗端"落在的下界。
    *   这样 0.30→base、0.55→1.0，全域严丝合缝，一档不浪费。
    *   B 通道同理：旧值 `0.74 + tintB*0.42` 落在 .999~1.16，也整段溢出。
    *   ⚠️ 别为了"更饱和"而让某通道 >1：>1 会被 clamp，而 clamp 掉的那段
    *      正是**档间差异最密的地方**（盛夏几档 tintR 只差 .01~.02）。
    *      溢出等于把差异扔掉。
    */
   // ⚠️ 基址 = 「最暗端落在哪」，它**直接决定摆幅**。
   //   .86 ⇒ tint 的全部定义域只映射到 .86~1.00 = 0.14 宽 ⇒ 相邻档水色差仅 0.5~0.9 灰阶
   //   （实测 夏至→小暑 0.62、惊蛰→春分 0.71）—— 肉眼根本读不出，等于白给。
   //   .70 ⇒ 摆幅 0.30，是 .86 的 2.1 倍 ⇒ 同样的档案差能到 1.3~1.9 灰阶。
   //   下界不能更低：再低就偏离"水色仍是水"读起来像滤镜（上界已经是 1.0，不能再高）。
   //   ★ 记一条：**把一个量映射到 [0,1] 时，基址/跨度必须由「实际取值域」反推，
   //     不能拍脑袋选个"看起来温和"的下界** —— 温和的下界等于温和的差异。
   /* ★★ 2026-10-04 实测重标定：.70/.78/.66 → .50/.60/.46。
      判据不是"好看"，而是两个可量化的数（扫了5 组基址，取平衡点）：
        基址                    全幅摆幅  两端ΔE   水面亮度降  饱和度涨
        [.70,.78,.66]（旧）      0.075    20.8      4.5%      2.3%
        [.60,.68,.56]           0.100    28.7      6.4%      2.9%
        [.50,.60,.46]（★采用）  0.125    35.7      8.0%      3.7%   ← ΔE +72%
        [.40,.50,.36]           0.150    43.8      9.9%      4.3%   ← 收益递减且开始伤画面
        [.30,.40,.26]           0.175    51.8     11.8%      5.0%   ← 明显像滤镜
      人眼同屏辨识阈约 ΔE 5；相邻档只吃到全幅的 1/5，所以**两端 ΔE 必须够大**。
      亮度降 8% / 饱和涨 3.7% 仍在"仍是水"的范围内。
   */
   const TINT_BASE = [0.50, 0.60, 0.46];   // 三通道各自的"最暗端"下界
   gl.uniform3f(u.uTermTint,
     TINT_BASE[0] + v.tintR * (1 - TINT_BASE[0]),
     TINT_BASE[1] + v.tintG * (1 - TINT_BASE[1]),
     TINT_BASE[2] + v.tintB * (1 - TINT_BASE[2]));
   /* amount scales with how far the term is from mid-season: the further the
      warmth, the stronger the tint - otherwise spring terms all look identical.
      ★ 下界抬到 .28：旧值 `|warmth-.55|*2.1` 在春分(0.42) 只有 .063，
      *   春分与惊蛰的水色差被压到几乎为零 ⇒ 这两档看着一样。
      *   .28 让最"中性"的档位也有可见的水色，档间差不再被 amt 二次压扁。 */
   /* uTermTintAmt：**不再**按 |warmth-.55| 二次调制。
      ⚠️ 旧公式 `0.28+|warmth-.55|*2.1×.72` 是个**纯衰减器**，不携带任何新信息：
        它把"最中性的那一档"（春分 warmth .58）压到 0.28 —— 而春分恰恰是
        六个春季节气之一。实测它的代价：同季感知 ΔE 只有 1.19。
        而 tint 的定义域已经在 term-visual.js 里**按季归一化**过了
        （seasonalWarmth，保证六档吃满全幅），这里再压一次就是自我抵消。
      现在是常量 0.86：留一点余量给"仍是水"（1.0 会像纯色滤镜），
      其余全部交给 tint 的定义域去表达档间差。 */
   gl.uniform1f(u.uTermTintAmt,options.termTintAmt??0.86);

   /* F-24b 结构化染色：让水色在**画面上有空间变化**，而不是一刀切。
      实测依据（2026-10-04）：均匀染色的人眼可辨度极低 ——
      ① 乘性染色天生落在池心：岸边原色暗、池心原色亮，
         岸边/池心 差异比恒为 **0.58**，与染色强度无关（amt 0.25→0.85 全程不变）；
      ② 加任何空间权重也改不了它（扫 ring 0.6~6.0，比值一路降到 0.24）。
      真正能拉开人眼感知的是**色相跨度**：实测 ΔL 3.0（现状）→ 16.4（拉大后），
         远超辨识阈 5。
      所以两件事一起做：a) 扩大 tint 的实际摆幅（见 TINT_BASE 注释）；
         b) 用空间权重调制，让染色在画面上**有结构**而不是一块均匀滤镜。 */
   gl.uniform1f(u.uTermPattern,options.termPattern??0.85);
  }else if(u.uTermTint){
   gl.uniform3f(u.uTermTint,1,1,1);gl.uniform1f(u.uTermTintAmt,0);
  }
  gl.uniform1f(u.uTime,time);gl.uniform1f(u.uWind,windStrength(options.weather,options.season));gl.uniform1f(u.uMotion,options.reducedMotion?0:1);gl.drawArrays(gl.TRIANGLES,0,6);
 }
 destroy(){
  this.dead=true;if(!this.canvas)return;this.canvas.removeEventListener('webglcontextlost',this.lost);this.canvas.removeEventListener('webglcontextrestored',this.restored);
  for(const image of this.images.values())image.onload=null;
  if(this.gl){for(const t of this.textures.values())this.gl.deleteTexture(t);this.gl.deleteBuffer(this.buffer);this.gl.deleteProgram(this.program)}this.images.clear();this.textures.clear();this.waterMasks.clear();this.canvas.width=this.canvas.height=0;
 }
}
