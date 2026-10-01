const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const WAVE_DELAY = 3.8;
const SEGMENTS = 32;
const spines = new WeakMap();

/** Smooth effort and steering once per fish; phase never resets during a speed change. */
export function updateSwimMotion(fish, dt, time, reducedMotion) {
  const activity = clamp(fish.velocity / Math.max(10, fish.speed), .15, 3.6);
  const individuality = .94 + Math.sin(fish.seed * 1.73) * .075;
  const glide = .82 + Math.sin(time * .73 + fish.seed * 2.1) * .18;
  const stride = fish.velocity / Math.max(35, fish.length);
  const goalRate = (2.7 + stride * 5) * individuality * (reducedMotion ? .62 : 1);
  const goalAmplitude = clamp((.052 + activity * .029) * glide, .025, .115) * (reducedMotion ? .7 : 1);
  const previousRate = fish.strokeRate ?? goalRate;
  fish.strokeRate = previousRate + (goalRate - previousRate) * (1 - Math.exp(-dt * 5));
  fish.swimAmplitude = (fish.swimAmplitude ?? goalAmplitude) +
    (goalAmplitude - (fish.swimAmplitude ?? goalAmplitude)) * (1 - Math.exp(-dt * 3.4));
  fish.phase += (previousRate + fish.strokeRate) * .5 * dt;
  fish.finPhase = (fish.finPhase ?? (fish.phase * .61 + fish.seed)) +
    dt * (1.35 + fish.velocity * .013) * (reducedMotion ? .6 : 1);
  // Curvature depends on distance travelled, not only on the rotation speed.
  // The rear body trails a turn, then gently straightens as steering releases.
  const bend = clamp((fish.turn || 0) * fish.length * .4 / Math.max(14, fish.velocity, fish.speed * .6), -.9, .9);
  fish.bodyBend = (fish.bodyBend ?? 0) + (bend - (fish.bodyBend ?? 0)) * (1 - Math.exp(-dt * 3.8));
}

function spine(fish) {
  const phase = fish.phase, amplitude = fish.swimAmplitude ?? .072;
  const bend = fish.bodyBend ?? clamp((fish.turn || 0) * .4, -.9, .9);
  let pose = spines.get(fish);
  if (!pose) {
    pose = {x:new Float64Array(SEGMENTS+1),y:new Float64Array(SEGMENTS+1),c:new Float64Array(SEGMENTS+1),s:new Float64Array(SEGMENTS+1)};
    spines.set(fish, pose);
  }
  if (pose.phase === phase && pose.amplitude === amplitude && pose.bend === bend && pose.length === fish.length) return pose;
  Object.assign(pose, {phase,amplitude,bend,length:fish.length});
  const tangent = u => {
    const v=1-u, wave=phase-v*WAVE_DELAY;
    const slope=amplitude*(v*v*Math.cos(wave)*WAVE_DELAY-2*v*Math.sin(wave));
    return Math.atan2(slope,.78)-bend*v*v;
  };
  const ds=fish.length*.78/SEGMENTS;
  pose.x[SEGMENTS]=fish.length*.41;pose.y[SEGMENTS]=0;
  for(let i=SEGMENTS;i>=0;i--){
    const a=tangent(i/SEGMENTS);pose.c[i]=Math.cos(a);pose.s[i]=Math.sin(a);
    if(i<SEGMENTS){
      const mid=tangent((i+.5)/SEGMENTS);
      pose.x[i]=pose.x[i+1]-Math.cos(mid)*ds;
      pose.y[i]=pose.y[i+1]-Math.sin(mid)*ds;
    }
  }
  return pose;
}

/**
 * 宽度剖面峰值系数 —— `sin(uπ)^.8 · (.64+u·.52)` 的最大值。
 * 它是「吻端目标宽度」换算成绝对像素的基准。
 * ⚠️ 用**实测扫描**而不是心算闭式解：峰值落在 u≈0.569，
 *    是个没有初等闭式解的超越方程。模块加载时算一次（约 1ms）。
 *
 * ★ 导出给 `koi-collision.js` 用 —— 体半宽峰值 = `WIDTH_PEAK · l · width`。
 *   碰撞半径必须与渲染轮廓同源。**别在别处手抄这个数**：
 *   我抄过一次（写成 .0602，差了 15 倍），半径塌到 1px 下限，
 *   鱼几乎完全重叠 —— 而且没有任何报错，只是"看起来没生效"。
 */
export const WIDTH_PEAK = (() => {
  let peak = 0;
  for (let i = 1; i < 100000; i++) {
    const u = i / 100000;
    const v = Math.sin(u * Math.PI) ** .8 * (.64 + u * .52);
    if (v > peak) peak = v;
  }
  return peak;
})();

/**
 * 头身分界。≤ 该 u 的剖面**逐位沿用**原公式 —— 这是"只调整头部"的硬保证。
 * 取 .72：胸鳍根正好在 u=.72（腹鳍 .27 更靠后），所以胸鳍位置与大小逐位不变。
 */
const HEAD_U = .72;
/**
 * 吻端半宽 / 体半宽峰值。取 .34：真实锦鲤俯视时吻端约为体宽的三分之一，
 * 明显收窄但读起来是"钝"而非"削"。实测 .25 偏瘦、.40 偏胖（像河豚）。
 */
const SNOUT_RATIO = .34;

/** 端点值/斜率版三次 Hermite —— 接缝处值与斜率同时相等 ⇒ 无折角。 */
function hermite(t, v0, s0, v1, s1) {
  const t2 = t * t, t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * v0 + (t3 - 2 * t2 + t) * s0
       + (-2 * t3 + 3 * t2) * v1 + (t3 - t2) * s1;
}

/**
 * ★ 锦鲤的吻是**钝圆**的；原来的 `sin(uπ)^.8` 在 u→1 处宽度塌到 +.3 px，
 *   而 `sin` 的端点斜率发散 ⇒ 数学上的**尖锥**。实测（L=60）最后 12% 长度
 *   把半宽从 3.94px 压到 0.30px（斜率 ≈ −21 px/u）⇒ 读出来就是"扎尖"。
 *
 * ⚠️⚠️ 试过三条路全部失败，**别再走回头路**（完整过程见 tools/_tune-head.cjs 文件头）：
 *   ① `base·(1−s) + target·s` 混合 —— 只要两函数相对斜率不同，中段必出鼓包
 *      （"先降后升" = 吻部鼓成畸形猪嘴）。扫遍 SNOUT×CAP 全表零达标。
 *   ② `√(1−t²)` 圆弧整体替换 —— 它在 t=0 处斜率**恒为 0**，而 base 在肩部
 *      是 −13～−23 px/u，接缝折角实测 21 px/u，是巨大的拐点。
 *   ③ 抛物线 `(1−k)²` 收口 —— 中段先平、末端突收，读出来是"直筒 + 突然塌下去的尖"。
 *
 *   唯一成立的是**三次 Hermite 整段替换**：把接缝处的宽度与斜率都从原公式
 *   **实测**出来当边界条件，末端给"斜率 0"（⇒ 切线水平 ⇒ 圆钝吻），两端同时匹配。
 *
 * 实测（L=60/W=.123）：吻端 2.30px（峰值的 32.6%，原 0.30px/4.2%），
 *   头部 12 等分斜率呈完整钟形 −11.4 → −19.7（最陡）→ −2.7（吻端），
 *   即"先收、末段明显放缓"—— 正是钝吻而非尖锥的剖面特征。
 *   u ≤ .72 逐位不变；跨 L=43…104 折角均 <2.7%、回升 0 档。
 */
function bodyWidth(fish, u) {
  if (u <= HEAD_U) return Math.sin(u*Math.PI)**.8*fish.length*fish.width*(.64+u*.52)+.3;
  const span = 1 - HEAD_U;
  const t = (u - HEAD_U) / span;
  const base = (v) => Math.sin(v*Math.PI)**.8*fish.length*fish.width*(.64+v*.52)+.3;
  // ⚠️ 这两个边界条件必须**实测**，不能拍脑袋：
  //   接缝斜率若填 0，宽度会在头段中后部回升成鼓包（上面 ① 那个坑）。
  const e = 1e-5;
  const v0 = base(HEAD_U);
  const s0 = (base(HEAD_U + e) - base(HEAD_U - e)) / (2 * e) * span;
  return hermite(t, v0, s0, SNOUT_RATIO * WIDTH_PEAK * fish.length * fish.width, 0);
}

/** Arc-length spine with a continuous tangent; u runs tail stalk → nose. */
export function koiBodyPoint(fish, u) {
  u=clamp(u,0,1);
  const pose=spine(fish), index=Math.min(SEGMENTS-1,Math.floor(u*SEGMENTS)), t=u*SEGMENTS-index;
  const next=index+1, ds=fish.length*.78/SEGMENTS, t2=t*t, t3=t2*t;
  const h0=2*t3-3*t2+1,h1=t3-2*t2+t,h2=-2*t3+3*t2,h3=t3-t2;
  const d0=6*t2-6*t,d1=3*t2-4*t+1,d2=-d0,d3=3*t2-2*t;
  const x=h0*pose.x[index]+h1*ds*pose.c[index]+h2*pose.x[next]+h3*ds*pose.c[next];
  const y=h0*pose.y[index]+h1*ds*pose.s[index]+h2*pose.y[next]+h3*ds*pose.s[next];
  const dx=d0*pose.x[index]+d1*ds*pose.c[index]+d2*pose.x[next]+d3*ds*pose.c[next];
  const dy=d0*pose.y[index]+d1*ds*pose.s[index]+d2*pose.y[next]+d3*ds*pose.s[next];
  const magnitude=Math.hypot(dx,dy)||1, tx=dx/magnitude,ty=dy/magnitude;
  return {x,y,tx,ty,nx:-ty,ny:tx,angle:Math.atan2(dy,dx),
    width:bodyWidth(fish,u)};
}

export function koiTailAngle(fish) { return koiBodyPoint(fish,0).angle; }

export function koiPectoralPose(fish, side) {
  const phase = fish.finPhase ?? (fish.phase * .61 + fish.seed);
  const steering = clamp((fish.turn || 0) * side, -.9, .9);
  const stroke = Math.sin(phase + side * .55);
  return {
    spread: 1 + stroke * .14 + steering * .21,
    sweep: Math.cos(phase + side * .55) * .012 - steering * .025,
  };
}
