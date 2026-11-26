//  OPEN SEA SKIN — 第二轮结构压缩版
//  核心参数、着色器算法、渲染逻辑不动；只改矩阵工具、Bloom uniform、WAVE_UNIFORMS。

// 整个文件包进一个 IIFE。
// 原因：关掉「启用海洋与玻璃」再打开时，宿主会重新把这个 <script> 插回页面，
// 浏览器会把这整份文件再执行一遍。而这个文件里有 13 处顶层 const/let/function
// （Q、SEA_STATE、main、installDispose……）。第二次执行时它们已经在全局作用域里，
// 直接抛 SyntaxError: Identifier 'Q' has already been declared —— 整段脚本一行都不跑，
// 海再也没有了，而且雨和面板都在别的文件里，所以雨照常。这就是「关了再开海消失」的根因。
// 包一层函数作用域后，每次执行都是全新一份局部变量，不再撞名。
;(function () {
// 旧实例先自己停掉、把自己的 canvas 摘掉（同一次执行内可能残留上一个实例）。
if (typeof window.__ossDispose === 'function') {
  try { window.__ossDispose() } catch (error) { /* 上一个实例已经没了 */ }
}
window.__ossDispose = null

const Q = window.__ossParams instanceof URLSearchParams ? window.__ossParams : new URLSearchParams(location.search)
const PARENT_ORIGIN = Q.get('parentOrigin')
const SKIN = Q.get('skin') === '1'

// 海浪大小默认 28（原来 45）。45 在默认风速下波峰偏大，看着吓人；28 是平缓涌动。
// 客户端 DEFAULTS.sea 必须与这里一致，否则首帧和之后会不一致。
let seaState = Q.has('sea') ? Number(Q.get('sea')) : 28
let daylight = Q.has('t') ? Number(Q.get('t')) : 55
// autoCycle = 自动昼夜是否开启。这是唯一的状态，其它地方一律从它派生。
// 启动参数 auto："1" 或缺失 = 开自动；"0" = 手动固定。
let autoCycle = Q.get('auto') !== '0'
// 时间流逝倍率：统一缩放所有自走动画（太阳月亮星空、海浪、云、泡沫）。
// 面板「时间流逝」滑杆换算出这个倍率，1.0 = 正常。日夜一轮固定 60 秒 × (1/倍率)。
let timeScale = Q.has('timeScale') ? Math.max(0.05, Math.min(20, Number(Q.get('timeScale')) || 1)) : 1
// 日夜一轮的基准时长（秒）：倍率 1.0 时走完一整轮所需时间
const CYCLE_SECONDS_BASE = 60
let renderScale = 1
// 星星亮度 0..1（面板「星星亮度」滑杆）。
// 默认 0.55：普通星星清楚可见，银河只是隐约的一条淡带，不抢戏。
let starBright = Q.has('starBright') ? Math.min(1, Math.max(0, Number(Q.get('starBright')) || 0.55)) : 0.55

const canvas = document.createElement('canvas')
canvas.style.cssText =
  'display:block;position:fixed;inset:0;width:100%;height:100%;' +
  'opacity:0;transition:opacity 1.4s ease;pointer-events:none;background:transparent'
canvas.setAttribute('data-oss-canvas', '')
document.body.insertBefore(canvas, document.body.firstChild)

// 这一个实例的清理入口：停 raf、摘掉 message 监听、摘掉 canvas。
// 插件关了、或者这份脚本被重新执行，都会调用它。
// 一开始就装好（只摘 canvas 的那部分），保证即使 WebGL2 不可用、main() 没跑，
// 这个实例的 canvas 也不会永远留在页面上。
let stopThis = () => {}
let detachThis = () => {}
window.__ossDispose = () => {
  try { stopThis() } catch (error) { /* 已经停了 */ }
  try { detachThis() } catch (error) { /* 已经摘了 */ }
  if (canvas.parentNode) canvas.parentNode.removeChild(canvas)
}
function installDispose(stopRaf, detachMessage) {
  stopThis = stopRaf || (() => {})
  detachThis = detachMessage || (() => {})
}

const gl = canvas.getContext('webgl2', {
  antialias: false, alpha: true, premultipliedAlpha: true, powerPreference: 'low-power',
})

if (!gl) {
  console.error('[OPEN SEA SKIN] WebGL2 unavailable')
  document.body.classList.add('ready')
} else {
  main()
}

function main() {
  // 太阳光效实例，在 resize() 之后实例化；这里先声明，让 resize() 能安全读到 null。
  let sunPass = null
  // 草地 Pass（null = 不可用；drawScene 里用 showGround 二次兜底）
  let grassPass = null
  // 花 Pass：独立的 GL 资源，和草互不影响
  let flowerPass = null
  // 闪电 Pass：由客户端每帧通过 window.__ossBoltSet 推状态
  let boltPass = null
  // 大肥鱼 Pass：客户端通过 window.__ossPetTexture 交纹理进来
  let petPass = null
  // 大肥鱼每帧的朝向/尺寸/抬起量，由客户端通过 __ossPetSet 推进来。
  // 缺省值就是「立正站着、面朝左、不抬」，所以引擎不知道客户端也没关系。
  // x 是当前的横向位置（米），每帧朝 petMoveTarget 逼近。
  // 【两个自由度：x 左右、z 远近】
  // 只有 x 的时候，鱼是在「一堵墙上左右滑」—— 它和相机的距离永远不变，
  // 所以看不出它在空间里。加上 z 之后，靠近会变大、远离会变小，
  // 这才叫「在空间里移动」。
  // y 暂不做：贴着海面走最稳，浮沉要处理和海面波浪的关系，下一版再说。
  // z 是【距离相机的米数】，基准 8.5 —— 和下面 petMoveTarget 同一套语义。
  // 别把世界坐标 z 塞进来：两者方向相反，混一次就是「冲着我来却走出屏幕」。
  // flip 初值 -1：和客户端 facing 初值一致，第一帧就朝右，不会出现「先朝左再跳右」。
  // 出生距离 20 米：占屏约 12%，是画面中景。8.5 米那个距离太靠前，一出场就贴脸。
  const petParams = { flip: -1, aspect: 0.8, lift: 0, x: 0, z: 20 }
  // 目标位置（相对 PET_POS 的偏移）。插值在 frame() 里做，CLI 只下命令。
  const petMoveTarget = { x: 0, z: 20 }
  // 位移时长（秒）。0 = 不限时（按基础速度走）。
  // 【为什么需要它】素材全是 10 秒的动作展示，本身不带位移 ——
  // 跑是原地跑。要让「跑的动作」和「真的在移动」对上，只能反过来：
  // 客户端说「这个动作有 10 秒」，引擎就在 10 秒内走完这段距离。
  // 否则会出现「跑了 1 秒就到地方、剩下 9 秒原地跑」这种错位。
  let petMoveDur = 0
  const CAM_POS     = [0, 5.5, 17]
  const CAM_TARGET  = [0, 1.5, 0]
  const FOV_DEG     = 55
  const NEAR        = 0.5
  const FAR         = 8000
  const PLANE_SIZE  = 420
  const SEG         = 256
  const EXPOSURE    = 1.0
  const BLOOM_STR   = 0.28
  const BLOOM_RADIUS = 0.3
  const BLOOM_THR   = 0.9
  const DETAIL_RADIUS = 140.0

  const WAVES = [
    { dir: [ 1.0,   0.0],  wavelength: 60.0, steepness: 0.12 },
    { dir: [ 0.6,   0.8],  wavelength: 31.0, steepness: 0.12 },
    { dir: [-0.7,   0.7],  wavelength: 18.0, steepness: 0.09 },
    { dir: [ 0.3,  -0.95], wavelength:  9.5, steepness: 0.07 },
    { dir: [-0.35, -0.94], wavelength:  5.0, steepness: 0.05 },
  ]

  const WAVE_COUNT = WAVES.length
  const waveDirs = new Float32Array(WAVE_COUNT * 2)
  const waveKs   = new Float32Array(WAVE_COUNT)
  const waveCs   = new Float32Array(WAVE_COUNT)
  const waveA0s  = new Float32Array(WAVE_COUNT)
  WAVES.forEach((w, i) => {
    const len = Math.hypot(w.dir[0], w.dir[1])
    waveDirs[i * 2]     = w.dir[0] / len
    waveDirs[i * 2 + 1] = w.dir[1] / len
    const k = (Math.PI * 2) / w.wavelength
    waveKs[i]  = k
    waveCs[i]  = Math.sqrt(9.8 * k)
    waveA0s[i] = w.steepness / k
  })

  const DAY  = { zenith:[0.07,0.20,0.42], horizon:[0.52,0.68,0.82], sun:[1.0,0.93,0.80],
                 sunIntensity:1.6, deep:[0.015,0.09,0.11], shallow:[0.06,0.32,0.36] }
  const DUSK = { zenith:[0.03,0.05,0.16], horizon:[0.85,0.36,0.16], sun:[1.0,0.42,0.14],
                 sunIntensity:2.6, deep:[0.02,0.045,0.075], shallow:[0.09,0.15,0.20] }
  // NIGHT：太阳沉到海平线以下后的色板。
  // 没有这一档，天空会永远停在 DUSK（橙红的地平线），夜里看起来还是傍晚。
  // 亮度是权衡过的：放得太暗，夜里整块背景发黑，聊天文字压在暗底上看着累。
  // 所以这里不是「纯黑」，而是带蓝的深灰蓝天 —— 够暗能衬出月亮星星，
  // 又有足够的底色亮度让界面文字保持着可读的对比。
  const NIGHT = { zenith:[0.020,0.034,0.075], horizon:[0.075,0.105,0.160], sun:[0.30,0.36,0.52],
                  sunIntensity:0.45, deep:[0.010,0.024,0.045], shallow:[0.030,0.060,0.095] }

  // DAWN：清晨的色板，和黄昏（DUSK）刻意不同。
  // 同样是低太阳，但晨光偏粉（红蓝都高、绿低），黄昏偏黄橙（红高、蓝低）。
  // 只作用于低仰角时段，太阳升高后自然过渡到 DAY。
  const DAWN = { zenith:[0.10,0.09,0.20], horizon:[0.92,0.55,0.62], sun:[1.0,0.70,0.62],
                 sunIntensity:2.2, deep:[0.05,0.06,0.11], shallow:[0.16,0.18,0.26] }

  const NOISE_GLSL = `
  vec2 hash2(vec2 p) {
    vec2 q = p - floor(p / 289.0) * 289.0;
    vec2 a = sin(vec2(dot(q, vec2(127.1, 311.7)), dot(q, vec2(269.5, 183.3)))) * 43758.5453;
    return fract(a) * 2.0 - 1.0;
  }
  float gnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    return mix(mix(dot(hash2(i), f), dot(hash2(i + vec2(1,0)), f - vec2(1,0)), u.x),
               mix(dot(hash2(i + vec2(0,1)), f - vec2(0,1)),
                   dot(hash2(i + vec2(1,1)), f - vec2(1,1)), u.x), u.y);
  }
  float fbm(vec2 p) {
    return gnoise(p) + gnoise(p * 2.04 + vec2(17.3, 9.1)) * 0.5
                     + gnoise(p * 4.11 + vec2(42.7, 28.6)) * 0.25;
  }
  `

  const SKY_GLSL = `
  ${NOISE_GLSL}
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  // 月光：夜里海面靠它才有波光，否则整片海是黑的。
  // 只在这里声明一次 —— FS_SEA 会 include SKY_GLSL，重复声明 uniform 会编译失败。
  uniform vec3 uMoonDir;
  uniform vec3 uMoonColor;
  uniform vec3 uHorizon;
  uniform vec3 uZenith;
  uniform vec3 uDeep;
  uniform float uTime;
  uniform float uCloudMask;   // 云量 0..1，由云循环引擎每帧写入；1=天空本身的云
  uniform float uCloudOpacity; // 云的不透明 0..1（面板滑杆）
  uniform float uCloudCondense; // 凝聚度 0..1：云体有多厚实
  uniform float uCloudUnite;    // 团结度 0..1：云结成朵还是连成一片
  uniform vec3  uCloudWind;     // &.xy = 风向（连续曲线），.z = 风速
  uniform float uCloudStorm;    // 雷暴隐藏态 0..1：只压暗云色，不改云形（团结度会改形状，不能复用）
  uniform float uSunDiscScale;  // 太阳本体强度（面板「太阳亮度」），1 = 正常
  uniform float uMoonDiscScale; // 月亮本体强度（面板「月亮亮度」），1 = 正常
  // 昼夜进度 0..1（= daylight/100）。月亮轨迹直接用它驱动，
  // 不用 uSunDir.y 反推 —— 太阳在贴近海平线那一段高度变化极快，
  // 反推出来的进度会「前慢后快」，月亮就在两三秒里从地平线冲到高空。
  uniform float uDayPhase;  // 星星亮度 0..1（面板滑杆）。
  // 它同时决定「多亮」和「能看到多少颗」—— 这是同一件事：
  // 阈值固定、每颗星有各自固定的星等，整体调亮之后原本太暗看不见的星
  // 就会越过肉眼门槛显现出来，所以一个参数就够。
  uniform float uStarBright;

  //  天体层：星空 + 月亮
  //  和太阳一样全部在「方向空间」画 —— 传入的是归一化视线方向 d，
  //  朝下看海的像素 d.y < 0，天然不会画到海面上。相机固定不转，
  //  所以方向空间的星点不会随视角游动，可以放心用哈希生成。
  //  三者共用同一条「天暗程度」曲线 dark，保证日落→月出→星亮首尾相接：
  //    太阳还在天上     dark ≈ 0     星星月亮被天空亮度盖住
  //    太阳贴着海平线   dark ≈ 0.4   月亮隐约、星星开始渗出
  //    太阳沉到线下     dark ≈ 1.0   月星全亮

  // 天暗程度：太阳越高越接近 0，越低越接近 1。
  // 下界必须跟 SUN_ELEV_END(-0.075) 对齐 —— 写 -0.03 的话太阳沉到底时 dark 到不了 1，
  // 天体永远只有七八成亮，而且和 updateSun 里的 nightFactor 节奏对不上。
  // 上界从 0.08 一路抬到 0.21（≈12°，几乎整条下降轨迹）：
  //   天色跟着太阳的高度均匀收敛，从正午最高点就开始缓慢转暗，
  //   而不是等到最后 15% 才「啪」一下黑下来。
  //   这样夜晚在时间上被天然拉长，月亮也有足够的行程从海平线升起。
  float nightAmount() {
    return 1.0 - smoothstep(-0.075, 0.09, uSunDir.y);
  }

  // 星空。星星是固定不动的，所以不用天球投影、不用旋转、不用格点：
  // 直接把屏幕坐标 (uv) 撒一份固定星点表。
  // 为什么改成屏幕空间而不是方向空间：
  //   相机是固定的（CAM_POS/CAM_TARGET 是常量），屏幕坐标和方向一一对应，
  //   所以屏幕上撒点 = 天空中撒点，效果完全一样，但省掉了经纬投影、
  //   极点畸变、atan 接缝这一整套麻烦 —— 之前星星糊成光斑、
  //   天顶挤成一团，根子都在那套投影上。
  // 每个格子里放一颗星。星点形状用「实心核心 + 柔边」的 smoothstep，
  // 不做高斯衰减 —— 两者相乘会把点压到几乎不可见。
  float starHash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }

  vec3 starField(vec3 d, vec2 uv, float vis) {
    if (vis <= 0.0005) return vec3(0.0);

    // 天空只在海平线（uv.y≈0.726）以上；往上淡入到 0.82 全量，
    // 星星才不会被压成地平线附近的一条窄带。
    float skyMask = smoothstep(0.726, 0.82, uv.y);
    if (skyMask <= 0.001) return vec3(0.0);

    // 星空固定在屏幕坐标上（不随昼夜旋转），只有明暗随夜色变。
    vec2 suv = uv;

    // 两类星：
    //   细星 grid=44 —— 小而锐利，铺满星空底子
    //   亮星 grid=22 —— 尺寸同细星的四分之一网格，只留极少几颗，傍晚就能看见
    vec3 acc = vec3(0.0);

    // ---- 细星 ----
    {
      float grid = 44.0;
      vec2 p = suv * grid;
      vec2 cell = floor(p);
      vec2 f = fract(p);

      float hx = starHash(cell);
      float hy = starHash(cell + vec2(37.0, 17.0));

      // 低频噪声调制密度：clump 高（星团中心）→ 门槛降低 → 星密；低则稀疏。
      // 这是「密度不均匀」的来源，比均匀撒点自然。
      float clump = fbm(suv * 2.2 + vec2(4.3, 1.7)) * 0.5 + 0.5;

      float dist = length(f - vec2(hx, hy));
      float r = 1.0 / grid;
      float spot = 1.0 - smoothstep(r * 0.78, r, dist);

      // 星等：哈希值取高次幂 → 大量极暗星 + 少量中等星 + 极少数亮星
      float mag = pow(starHash(cell + vec2(91.0, 5.0)), 3.2) * mix(0.45, 1.0, clump);

      // uStarBright 同时控制「亮度」和「可见星数」—— 物理上本就是同一件事。
      float visible = step(1.0 - uStarBright, mag);

      // 可见的星按 mag 给渐进强度，最暗的一批仍然很淡
      float bright = (0.18 + 0.82 * mag) * 1.6;

      // 每颗都闪：0.70~2.2 Hz（周期 0.45~1.4 秒），够快才看得出在闪。
      float phase = starHash(cell + vec2(13.0, 79.0)) * 6.28318;
      float freq = 0.70 + 1.50 * starHash(cell + vec2(53.0, 29.0));
      float twinkle = 0.55 + 0.45 * sin(uTime * freq * 6.28318 + phase);
      bright *= twinkle;

      acc += vec3(1.0) * spot * bright * visible * pow(vis, 1.2) * 0.72;
    }

    // ---- 亮星：同一套网格，只留极少的几颗 ----
    {
      float grid = 22.0;
      vec2 p = suv * grid;
      vec2 cell = floor(p);
      vec2 f = fract(p);

      float hx = starHash(cell);
      float hy = starHash(cell + vec2(37.0, 17.0));
      // 阈值 0.985 → 约 1.5% 的格子命中；屏幕覆盖的格子只有二十来个量级，
      // 所以实际同时可见的就一两颗。
      float exists = step(0.985, hx);

      float dist = length(f - vec2(hx, hy));
      // 尺寸和细星同一套算法（r 放大 1.1 倍），不另造形状
      float r = 1.1 / grid;
      float spot = 1.0 - smoothstep(r * 0.78, r, dist);

      // 亮星：亮度拉满 + 强闪（0.90~1.90 Hz，振幅 0.25~1.0，暗下去几乎消失）
      float phase = starHash(cell + vec2(13.0, 79.0)) * 6.28318;
      float freq = 0.90 + 1.00 * starHash(cell + vec2(53.0, 29.0));
      float twinkle = 0.625 + 0.375 * sin(uTime * freq * 6.28318 + phase);

      // 用 sqrt(vis)：黄昏天还没全黑就能看见，天黑后全亮
      acc += vec3(1.0, 0.98, 0.92) * spot * twinkle * exists * sqrt(vis) * 1.35;
    }

    // ---- 流星 ----
    // 完全程序化：由 uTime 决定「当前跑到哪」，不需要任何状态或 JS 驱动。
    // 两颗流星周期不同（8~20 秒），错开出现。
    vec3 meteor = vec3(0.0);
    for (int i = 0; i < 2; i++) {
      float seed = float(i) * 37.0;
      float period = 8.0 + 12.0 * starHash(vec2(seed, 1.0));
      float phase = fract((uTime + seed * 11.0) / period);
      // 只在周期最后 3% 显示（约 0.4 秒）。再长就像一根慢悠悠的棍子。
      float life = 0.03;
      float t = phase / life;
      if (t > 1.0) continue;

      // 起点落在天空区（uv.y 0.80~0.96）
      float sx = 0.15 + 0.70 * starHash(vec2(seed, 2.0));
      float sy = 0.80 + 0.16 * starHash(vec2(seed, 3.0));
      // 斜向左下（真实流星多向下），位移要够大配合短寿命才能读出速度
      float dx = -0.26 - 0.18 * starHash(vec2(seed, 4.0));
      float dy = -0.13 - 0.10 * starHash(vec2(seed, 5.0));

      vec2 headPos = vec2(sx + dx * t, sy + dy * t);
      // 尾巴短：流星感来自速度，不是长度。0.045 只剩一个短亮点。
      float tailLen = 0.045;
      vec2 tailPos = headPos - normalize(vec2(dx, dy)) * tailLen;

      // 点到线段的距离
      vec2 seg = tailPos - headPos;
      float segLen2 = dot(seg, seg);
      float h = clamp(dot(suv - headPos, seg) / max(segLen2, 1e-6), 0.0, 1.0);
      vec2 closest = headPos + seg * h;
      float dLine = length(suv - closest);
      // 线宽 0.0006：再粗就是一道明显的杠，不再像光痕
      float w = 0.0006;
      float coreLine = 1.0 - smoothstep(w * 0.5, w, dLine);
      float tailFade = 1.0 - h;
      tailFade *= tailFade;
      float fadeIn = smoothstep(0.0, 0.15, t);
      float fadeOut = 1.0 - smoothstep(0.75, 1.0, t);
      // 乘 vis²：星星都乘了 pow(vis)/sqrt(vis)，流星也必须跟上，
      // 否则天还亮着流星就画出来了，和星空可见度脱节。
      meteor += vec3(1.0, 0.98, 0.92) * coreLine * tailFade * fadeIn * fadeOut * 3.0 * vis * vis;
    }

    return (vec3(acc) + meteor) * skyMask * (0.25 + 0.75 * uStarBright);
  }

  // 月亮。方向取太阳的反方向：日落则月升，二者严格互补。
  // 和太阳的关键区别是「光晕很窄」—— 太阳的指数是 10/64，这里用到 90，
  // 否则月亮会变成第二个太阳。
  // 参数 vis = 天空可见度（天暗程度 × 非雷暴）。
  vec3 moonLight(vec3 d, float vis) {
    if (vis <= 0.001) return vec3(0.0);

    // 月亮轨道：必须留在相机视野里，否则「月亮不出现」。
    // 不能用 -uSunDir：太阳方位角扫过 -33°~+33°，反方向就是 147°~213°，
    // 整个落在相机背后，屏幕上永远看不到 —— 这正是之前月亮完全不出现的根因。
    // 正确做法是让月亮沿相机正前方的天空带运行，方向由相机朝向决定：
    // 相机在 +Z 看 -Z，所以月亮用 -Z 作基准，左右各摆一段，
    // 高度随夜深的程度缓慢抬升（nightAmount 驱动），
    // 这样月亮从海平线附近升起、越夜越高的感觉就有了，且始终在画面里。
    float night = nightAmount();

    // 月亮轨迹照抄太阳的运镜逻辑：从右侧升起 → 划到最高点 → 往中间落下。
    // 之前是「只升不落」：升到 13° 就停在顶上不动，剩下整段夜晚干等天亮，
    // 所以夜景只有几秒。现在走一条和太阳同样长度的弧线，
    // 月亮整段夜晚都在移动，时间自然和太阳的下降段一样长。
    // night 映射成 moonT（0..1 的弧线进度）：
    //   0    → 右侧海平线刚露头
    //   0.5  → 最高点（约 12.5°，视野上限 14.26° 以内）
    //   1    → 落到中间偏右
    // 关键：moonT 直接用昼夜进度 uDayPhase 算，不再从 night 反推。
    // 为什么必须这样：太阳贴着海平线那一段，仰角从 +0.5° 掉到 -1.5°
    // 只占一轮的 5%，但 night 在这段从 0.55 冲到 0.85。
    // 用 night 推轨迹，月亮会在两三秒里从地平线直冲高空 ——
    // 就是之前「嗖一下升上去」的病根。
    // uDayPhase 是真正均匀的时间轴，用它月亮就会匀速爬升。
    // 起点 0.76 = 太阳刚落到海平线那一刻，终点 1.0 回到天亮。
    float moonT = clamp((uDayPhase - 0.76) / 0.24, 0.0, 1.0);

    // 方位：从右侧 26° 一路扫到中间偏右 1°，横跨约 25°。
    // 之前缩到 14° 是为了放慢，但弧线看着太小；
    // 速度改用下面「按时间均匀推进」来控，行程恢复成大弧。
    float moonAz = mix(0.46, 0.02, moonT);
    // 仰角拱高恢复到 0.185（约 10.6°），月亮能从海平线抬到接近视野上限，
    // 是一条看得清的大弧线，而不是贴着地平线挪一小段。
    float moonEl = 0.012 + 0.185 * sin(moonT * 3.14159265);
    vec3 moonDir = normalize(vec3(sin(moonAz) * cos(moonEl), sin(moonEl), -cos(moonAz) * cos(moonEl)));

    // 亮度淡入：按月亮高度来定，而不是按 moonT。
    //   之前用 moonT 的门槛，月亮的亮度曲线和它在天空中的位置脱节 ——
    //   会在还飘在半空（仰角约 1°）时就淡没了，看着像「凭空消失」。
    //   改成由月仰角驱动：贴近海平线时才淡入淡出，升起来才亮、落下去才灭。
    float moonAlt = moonEl;   // 月仰角（弧度）
    float moonRise = smoothstep(0.012, 0.045, moonAlt) * (1.0 - smoothstep(0.90, 1.0, moonT));
    if (moonRise <= 0.001) return vec3(0.0);

    float m = max(dot(d, moonDir), 0.0);

    // 圆盘必须明显小于太阳，否则看起来就是「第二个太阳」。
    // 太阳 core 用 0.99965..0.99992（角半径约 1.5°，屏幕上约 60px）。
    // 月亮收到 0.99986..0.99995（角半径约 0.6°，屏幕上约 24px），
    // 是太阳的四成大小，一眼就能分出哪个是太阳、哪个是月亮。
    float disc = smoothstep(0.99986, 0.99995, m);
    // 光晕收到指数 1200：几乎完全贴着月盘，只留薄薄一层。
    //   之前 400 在屏幕上还是散出一圈明显的雾，
    //   月亮看起来「糊」，就是这圈雾造成的。
    float halo = pow(m, 1200.0);

    // 月面明暗：用低频噪声做几块「月海」暗斑。
    // 这个尺寸下（屏幕约 10px）环形山是画不出来的，
    // 但明暗斑驳足以让人看出「这不是一块纯色圆饼」。
    // 月亮本体用冷白偏一点黄，和太阳的暖橙白（1.0,0.93,0.80 × 暖色）明显不同。
    vec3 moonCol = vec3(0.93, 0.95, 1.00);
    if (disc > 0.001) {
      // 关键：纹理坐标必须相对「月心」算，不能用视线方向 d。
      // 用 d 的话图案会随视角滑动（像贴图浮在屏幕上），
      // 只有相对月心偏移，斑块才固定在月盘上。
      // 基向量：取一个和 moonDir 不平行的辅助轴做叉积。
      // moonDir 可能接近竖直（月亮在天顶），此时和 Y 轴叉积会退化，
      // 所以按 |moonDir.y| 选辅助轴，避免 normalize 出 NaN。
      vec3 helper = abs(moonDir.y) > 0.9 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
      vec3 tangent = normalize(cross(moonDir, helper));
      vec3 bitan = cross(moonDir, tangent);
      // ---- 月面纹理（替换原版的糊斑）----
      // 原版 mp = dot*260，盘内 dot 只有 ±0.011，整盘铺不到 3 个噪声周期，就是几团糊色块。
      // 现在把盘内坐标归一到盘缘=±1，再分三档频率叠加：
      //   月海(1.6/3.2) = 大块暗海 + 边缘碎斑；环形山(7.0) = 高频颗粒，越靠盘缘越密。
      // 【注意】lut 必须直接用线性盘内坐标除以盘缘值，不能写成 normalize(dir)*rl：
      //   后者在月心 dirLen→0 时方向由浮点噪声决定，会画出明显的放射状条纹。
      const float MOON_R = 0.011;                                  // 盘内 dot 的盘缘值
      vec2 lut = vec2(dot(d, tangent), dot(d, bitan)) / MOON_R;    // 盘缘处 |lut|≈1
      float rl = clamp(length(lut), 0.0, 1.0);
      // fbm 值域约 ±1.5，先归一到 0..1 再决定灰度
      float maria = clamp((fbm(lut * 1.60 + vec2(11.3, 5.9)) * 0.62
                         + fbm(lut * 3.20 + vec2(31.7, 2.4)) * 0.38) * 0.5 + 0.5, 0.0, 1.0);
      float rim = smoothstep(0.55, 1.0, rl) * (fbm(lut * 7.00 + vec2(4.1, 17.3)) * 0.5 + 0.5);
      vec3 surf = mix(vec3(0.80, 0.81, 0.84), vec3(0.52, 0.55, 0.62), smoothstep(0.42, 0.62, maria));
      surf += vec3(0.05, 0.05, 0.06) * rim;                    // 环形山亮边
      surf *= mix(1.0, 0.84, smoothstep(0.78, 1.0, rl));       // 盘缘球面压暗
      moonCol = mix(moonCol, surf, 0.90);
    }

    float strength = vis * moonRise;
    vec3 glowCol = vec3(0.88, 0.92, 1.00);
    // 大范围大气辉光从 18 次幂收紧到 60 次幂、强度从 0.20 降到 0.08：
    //   这层是之前「月晕太大」的主要来源 —— 它在月盘外面铺了很大一圈淡光。
    //   收窄之后夜里天空照样不会死黑，但月亮周围不再雾蒙蒙一片。
    float wide = pow(m, 60.0);
    // 月盘本体 1.9 → 2.6：辉光收掉之后月亮会显得偏暗，
    // 把盘面本身提亮来补（夜里天体亮一点不影响界面阅读，它不是大范围亮区）。
    return moonCol * disc * 2.6 * strength
         + glowCol * halo * 0.55 * strength
         + glowCol * wide * 0.08 * strength;
  }

  // 天空着色主体。uv 传 (-1,-1) 表示「不走屏幕空间特效」（海面反射用这条）。
  vec3 skyColorAt(vec3 d, float cloudMask, vec2 uv) {
    float up = clamp(d.y, -0.15, 1.0);
    vec3 col = mix(uHorizon, uZenith, pow(max(up, 0.0), 0.42));
    col = mix(col, uDeep * 1.4 + uHorizon * 0.25, smoothstep(0.0, -0.15, d.y));
    float s = max(dot(d, uSunDir), 0.0);

    // 太阳在方向空间画。这是刻意的：d 是视线方向，朝下看海的像素 dot 接近 0，
    // 算不到太阳 —— 不用投影、不用裁剪，天然不会跑到海面上。
    // 想改这个渲染方式前先想清楚：换成屏幕空间投影就必须自己处理海平线裁剪、
    // 越界、相机旋转，会多出一整套补丁，而且不可能比这里更稳。
    // 三层结构（照手机天气 App 的做法分三层，各自的衰减曲线不同）：
    //   核心 core  —— 硬边，几乎无渐变，一眼看出是太阳本体
    //   中层 halo  —— 指数快衰减，半透明，负责「在发光」
    //   外层 glow  —— 幂次慢衰减，很淡但铺得远，让整片天空亮起来
    // 关键的第四点：上下不对称。真实大气里太阳下方的散射光更厚，
    // 所以中层和外层在太阳下方都要加宽加亮，否则永远像贴上去的圆盘。
    float core = smoothstep(0.99965, 0.99992, s);
    float halo = pow(s, 64.0);
    float glow = pow(s, 10.0);
    // 上下不对称系数：看当前像素方向相对太阳的「高低」。
    //   dBelow > 0 → 像素在太阳下方
    //   downWeight 把下方的中层/外层放大，靠近地平线时更明显
    float dBelow = (uSunDir.y - d.y);              // >0 表示视线在太阳下方
    float lowSun = 1.0 - smoothstep(0.02, 0.16, uSunDir.y);   // 太阳越低越明显
    float downBoost = 1.0 + smoothstep(-0.05, 0.35, dBelow) * (0.9 + 1.6 * lowSun);
    halo *= downBoost;
    glow *= mix(1.0, downBoost, 0.55);
    // 太阳沉到海平线以下才隐藏。阈值对应轨迹终点 -1.7°；
    // 起点 +0.5° 远在阈值之上，所以每一轮开始时太阳一定是可见的。
    float sunVisible = smoothstep(-0.075, 0.010, uSunDir.y);
    // 三层强度：核心压到 12（原来 30 过曝，手机天气的核心从不到这个量级），
    // 中层给 0.9、外层 0.18 —— 拉开差距，三层才分得出来。
    // 三层各自带色相，不能都用 uSunColor：
    //   核心    暖白（真实太阳中心几乎白，带一点点暖）
    //   中层    用天色给的 uSunColor（晨粉/暮黄由它决定）
    //   外层    再往橙侧偏一点（远距离的大气散射）
    vec3 coreTint  = vec3(1.0, 0.996, 0.972);
    vec3 outerTint = uSunColor * vec3(1.0, 0.86, 0.70);
    // 临边昏暗：太阳是球，边缘光穿过更厚大气，中心亮白边缘暗红。
    // 盘内半径 r = 角距/R0 ∈ [0,1]（0=日心, 1=日缘）。
    float angA  = acos(clamp(s, -1.0, 1.0));
    float R0    = acos(0.99965);
    float rSun  = clamp(angA / max(R0, 1e-5), 0.0, 1.0);
    // r^2 比 r 更贴近真实的大气厚度曲线：中心一大片几乎不变，靠近边缘才明显压暗
    float limb  = 1.0 - 0.42 * rSun * rSun;
    // 边缘同时往橙红偏：蓝光在厚大气里先被散射掉
    vec3  limbTint = mix(vec3(1.0), vec3(1.0, 0.80, 0.55), rSun * rSun);
    // 贴地平线时再把中层/外层往红推一档（瑞利红化），让太阳和天空「不脱节」。
    // lowSun 上面已经算好了（514 行），这里直接复用。
    vec3 lowSunRed = mix(uSunColor, uSunColor * vec3(1.15, 0.62, 0.42), lowSun * 0.5);
    vec3 sunLayers = coreTint * limbTint * (core * 12.0 * limb)
                   + lowSunRed * (halo * 0.9)
                   + outerTint * (glow * 0.18);
    col += sunLayers * uSunDiscScale * sunVisible;

    // ---- 天体层：星空 + 月亮 ----
    // 放在云之前，所以云能遮住它们（云是下面 mix 进来的）。
    // 和太阳一样用加法叠加，会被下游 bloom 提取，产生自然辉光。
    // 雷暴时压到 0：超级暴雨的天空应该是一整片铅灰，不该有星星透出来。
    float dark = nightAmount();
    float clearSky = 1.0 - clamp(uCloudStorm, 0.0, 1.0);
    // 星星和月亮的可见度门槛不同：
    //   星星只用 dark²（星比月暗，天不够黑就看不见）
    //   月亮只用 clearSky（它靠自己的 moonRise 控制白天不可见，
    //   如果再乘 dark，太阳刚落山那一段月亮会被 dark 压得太暗，只剩一圈光晕）
    // 星星：屏幕空间撒点，只在天空 pass 生效（uv.x >= 0）。
    // 海面反射那条路 uv 是 (-1,-1)，不画星星 —— 水里不该有星点。
    if (uv.x >= 0.0) col += starField(d, uv, dark * clearSky);
    // uMoonDiscScale（面板「月亮亮度」）乘在调用处，不改 moonLight 内部 ——
    // 月亮只在这里被调用一次，改这里等于整体缩放月盘 / 月晕 / 大气辉光，
    // 而且不会碰函数里的几何计算，结构风险为零。
    col += moonLight(d, clearSky) * uMoonDiscScale;

    // ---- 云层：同一套 fbm，但由 cloudMask 驱动「长出来多少」 ----
    // 原版只在 band 里按固定阈值 0.62..0.95 切一点薄云，几乎看不见。
    // 现在 cloudMask 同时决定三件事：
    //   1) 阈值下移 —— 云量越高，越多噪声越过阈值，云从「几点」长成「一大片」
    //   2) 分层 —— 用两组不同速度的噪声叠出云的层次，不是一张平面的斑
    //   3) 明暗 —— 云的亮部朝太阳，暗部背离太阳，底部压深，才有体积
    // 云的天空带：原来上边界 0.72、下边界 0.16，只覆盖仰角 4°~16°，
    // 天空里大半是不带云的；放宽到 0.95~0.10 → 仰角 6°~72°，云能铺满天顶。
  //  云模块总账（读这里就够，下面散落的注释是实现细节）
  //  【链路】水汽→cn密度→阈值thr→覆盖cover→光照lit→混合alpha
  //    · cn 现在来自 fbm 噪声（假的）。真云需要水汽模块提供 cn，下游全部不变。
  //    · 这是本模块唯一预留的替换点：只换 cn 的来源，其余照旧。
  //  【三层参数，各管一件事，不要互相越界】
  //    云量 mask  → thr / cap     ：一共有多少云
  //    凝聚度     → sharp          ：每朵云多实（边缘锐利度）
  //    团结度     → blobScale      ：云分成几团（只改分布，不改总量）
  //    ★ 团结度一旦去改 thr，效果就和云量重复——这是踩过的坑。
  //  【团结度为什么做不出真云朵】
  //    噪声是连续、均匀的随机场，没有「一朵一朵」的拓扑结构。
  //    对连续场做阈值化只有两种结局：切粗=一整片，切细=一粒粒光斑，没有中间态。
  //    真云朵的「朵」来自水汽凝结事件（物理过程），不是噪声加工出来的。
  //    所以现在的团结度只能「团结一点点」，这是能力上限，不是 bug。
  //  【catalog：试过并失败的路，别重走】
  //    ✗ 把团块乘在 cn 上     ：cn 一抬高就整个越过 smoothstep 上阈值，cover 全饱和，
  //                             只剩「颜色深浅变化」，形状不变 → 光斑。
  //    ✗ blobScale 上限拉到 2.6：团被切成碎粒，远看是密点 → 光斑。实测 0.8 附近才是大块。
  //    ✗ 团结度抬 thr          ：与云量效果完全重合，等于「反向调云量」。
  //    ✗ 显式云团中心（8 个固定中心）：半径/位置都是猜的，cn 大面积归 0 → 云直接没了。
  //    ✗ 给团结度换颜色（白→黑）：黑云在夜空里没有边界，形状变化被吃掉。
  //  【对的，别动】
  //    ✓ projU = proj + (cluster-0.5)*push  ：cluster 推挤噪声坐标，云是真的在聚拢。
  //                                          这才是原设计里正确的机制。
  //    ✓ cn *= mix(1.0, smoothstep(...), unite)：思路对（低频场切团边界），
  //                                          原版只削不补（阈值 0.24 砍掉七成）才是病。
  //    ✓ 颜色与团结度解耦，变黑交给 storm 单独控制。
  //  【将来接水汽模块时】
  //    只替换 cn 的来源为水汽凝结密度；thr/cap/cover/lit/alpha/band/proj 全部保留。
  //    那时团结度滑杆可能不再需要（云自然分团），届时再决定留还是删。

    float band = smoothstep(0.015, 0.10, d.y) * smoothstep(0.95, 0.10, d.y);
    float mask = clamp(cloudMask, 0.0, 1.0);
    if (band > 0.001 && mask > 0.001) {
      vec2 proj = d.xz / (d.y + 0.18) * 0.55;
      // 风向与风速由 host 每帧算好后传进来（uCloudWind.xy = 方向，.z = 速度）。
      // 面板只给风速；方向由 host 自己随机游走，所以云会拐弯。
      vec2 wind = uCloudWind.xy;
      float wspeed = uCloudWind.z;
      vec2 drift = wind * uTime * wspeed;
      // 分层速度：厚云慢、薄云快。
      //   厚云（density 高）质量大、拖得动得少 → 位移小
      //   薄云（density 低）轻薄 → 被同一股风吹得更快
      // 做法：细纹理层额外多滑一段，且这段的长度随「薄」程度增加。
      //   薄云 slowLayer≈1 → 细纹理滑得远，看起来快；
      //   厚云 slowLayer≈0 → 只剩主层，整体慢。
      float slowLayer = 1.0 - clamp(uCloudMask, 0.0, 1.0) * 0.75;
      vec2 fastDrift = wind * uTime * wspeed * 0.55 * slowLayer;
      // 细纹理相对主云层多滑一点，两层错开才不会像一张贴图整体平移
      vec2 drift2 = (drift + fastDrift) * 1.35 + vec2(uTime * 0.004, uTime * -0.003);

      // 两层：大块云团 + 细纹理
      // 团结度：把均匀的噪声「拉成一朵一朵」。
      //   做法是给投影坐标加一层低频的大团块扰动（cluster），
      //   团结度高时，只有落在团块中心的云才浓，云之间出现明显的断开；
      //   团结度低时，团块几乎不参与，云是均匀铺开的雾。
      //   这和凝聚度不冲突：凝聚度控制每朵云「有多实」，团结度控制「分不分成朵」。
      vec2 cluster = vec2(
        fbm(proj * 0.42 + vec2(3.1, 7.7)) * 0.5 + 0.5,
        fbm(proj * 0.42 + vec2(11.3, 2.9)) * 0.5 + 0.5
      );
      float unite = clamp(uCloudUnite, 0.0, 1.0);
      // 团结度把云往团块中心「收」：收得越多，朵与朵之间的空隙越大。
      // 上限拉高：0.5 只是「有点成团」，1.0 才是「一朵一朵分明」。
      vec2 projU = proj + (cluster - 0.5) * pow(unite, 1.35) * 4.2;

      float n1 = fbm(projU + drift) * 0.5 + 0.5;
      float n2 = fbm(projU * 2.7 + drift2 + vec2(31.7, 12.3)) * 0.5 + 0.5;
      float cn = clamp(n1 * 0.68 + n2 * 0.32, 0.0, 1.0);

      // 云量真正控制「有多少云」，但端点按实际工作区间标定：
      //   mask 的实际范围是 ~0.1（薄）到 1.0（满），不是 0..1 均匀铺开。
      //   thr：mask=0.1 时 0.70（只有最浓的噪声冒出来），mask=1 时 0.26（大片成云）
      //   cap：mask=0.1 时 0.45（薄云也要看得见），mask=1 时 1.0
      // 两个端点都用 sqrt 拉一下，让低云量段不至于一片空白。
      // mask 允许超过 1（超级暴雨到 2）：m 超过 1 后 thr 继续下探、cap 继续抬高，
      // 天空连最后一点缝隙也被黑云吃掉。以前这里 clamp 到 1，翻倍等于没生效。
      // m 用 sqrt 压过，翻倍(4) 后 m 只到 1.41，所以再乘一个超限系数把余量吃干净。
      float m = sqrt(clamp(mask, 0.0, 2.0));
      // 超过 1 的部分（0..0.41）额外下探 thr、抬高 cap
      float over = max(0.0, m - 1.0) * 2.4;
      // 云量拉满时 thr 要能压到很低，云才会真正连成一大片（mask=1 时 0.18）
      float thr = max(0.02, mix(0.72, 0.18, min(m, 1.0)) - over * 0.16);
      // cap 越过 1 的余量给「云量+凝聚度全满」，以及隐藏态的翻倍
      float cap = mix(0.45, 1.15, min(m, 1.0)) + over;
      // 凝聚度：把 smoothstep 的宽度收窄 → 云体内部更实、缝隙更少。
      float sharp = mix(1.7, 0.62, clamp(uCloudCondense, 0.0, 1.0));
      float cover = min(1.0, smoothstep(thr, thr + 0.30 * sharp, cn) * cap);
      cover *= band;

      // ---- 团结度：作用在「云/无云」这一层，而不是把 cn 整体缩放 ----
      // 之前把团块乘在 cn 上：cn 一抬高就整个越过 smoothstep 的上阈值，
      // cover 全部饱和成 1.0，结果只是「颜色深浅变化」，形状不变，看起来就是光斑。
      // 现在团块乘在 cover 之后（cover 已经是 0..1 的覆盖度），才能真正切出边界。
      // 团结度只负责「云分成几团」，不改变云的总量（那是云量滑杆的事）。
      // 尺度不能太大：2.6 时团被切得太碎，远看就是一粒粒光斑。
      // 实测 0.8 左右是「大块、能数清、边界清晰」的形态，所以上限收到 1.0。
      //   滑杆 0   -> 0.30（团极大，几乎连成整片，看不出分团）
      //   滑杆 100 -> 1.00（大团分明，不是碎斑）
      float blobScale = mix(0.30, 1.00, clamp(uCloudUnite, 0.0, 1.0));
      float clump = fbm(proj * blobScale + vec2(5.5, 19.1)) * 0.5 + 0.5;
      // 阈值放宽到 0.34/0.62：团块更大更完整，不再是密密麻麻的小点
      float blob  = smoothstep(0.340, 0.620, clump);
      // unite=0 时 blob 完全不参与（cover 保持原样）
      cover *= mix(1.0, clamp(blob * 1.6, 0.0, 1.0), unite);

      if (cover > 0.001) {
        // 体积：云团越厚（cn 越高）越接近中心，边缘薄而透
        float thick = smoothstep(thr, thr + 0.42 * sharp, cn);

        // 明暗：朝阳的一侧近白，背阳的一侧灰；底部再压深一层
        // （补丁A 一「高密度压深灰、中低密度提亮米白」已并入下面这一组：厚处 lit 更暗、薄处更亮）
        float sunSide = smoothstep(-0.35, 0.55, dot(normalize(d.xz), normalize(uSunDir.xz)));

        vec3 whiteCloud = vec3(0.99, 0.99, 0.98);
        vec3 greyCloud  = vec3(0.60, 0.62, 0.65);
        vec3 blackCloud = vec3(0.16, 0.17, 0.19);
        float u1 = clamp(unite, 0.0, 1.0);
        // 写成两段连续插值，不做 step 切换，避免 0.5 处颜色跳变
        // 团结度不再改变云的颜色。
        // 原来这里让 unite 把云从白推到黑（到 0.9 以上直接接近 blackCloud），
        // 结果「团结度拉满」只看到云变黑 —— 黑云在夜空里没有边界，
        // 调它给人的唯一感受就是「颜色深浅变了」，形状变化被吃掉了。
        // 现在颜色固定用亮一些的白，形状（团与团之间）交给 cover 那一层去切。
        // 需要灰/黑云时用 storm（雷暴暗化），那是另一条独立链路。
        vec3 cloudTone = mix(whiteCloud, greyCloud, smoothstep(0.0, 1.0, u1) * 0.45);

        // 厚度仍在同一档内做明暗：厚处更暗、薄处更亮
        vec3 base = mix(cloudTone * 1.04, cloudTone * 0.72, clamp(thick * 0.85, 0.0, 1.0));
        vec3 lit = mix(base * 0.72, base, sunSide);
        // 太阳直射处镶一圈暖边（黑云上也要看得见一点光）
        lit += uSunColor * pow(max(dot(d, uSunDir), 0.0), 6.0) * (0.22 - 0.10 * u1) * sunSide;
        // 云的底部（仰角低）更暗，顶部更亮 —— 给云立体感
        float baseShade = smoothstep(0.0, 0.30, d.y);
        lit *= mix(0.80, 1.06, baseShade);

        // 雷暴：只压暗云色，不动形状。
        // 团结度拉到顶也会变黑，但它同时把云收成一朵朵（改的是形状），
        // 雷雨天需要的是一整片压下来的黑云，所以单独走这一项。
        // 0 → 原样；1 → 亮部压到约六成、再整片去饱和偏冷，夜里像铅灰。
        // 客户端在「超级暴雨」里传 storm=1，和云量翻倍（150→300）一起构成黑云压顶。
        {
          float storm = clamp(uCloudStorm, 0.0, 1.0);
          vec3 lead = mix(vec3(0.30, 0.32, 0.35), vec3(0.10, 0.11, 0.13), storm);
          lit = mix(lit, lit * 0.62, storm * 0.55);
          lit = mix(lit, lead * (0.55 + 0.45 * baseShade), storm * 0.65);
        }

        // 透明度：面板 0 = 全透明（云完全消失），100 = 最实。
        // 直接用面板值当 alpha 的上限，0 时 oMin/oMax 都是 0，alpha 归零。
        float solid = clamp(uCloudOpacity, 0.0, 1.0);
        float oMin = solid * 0.80;
        float oMax = min(1.0, solid * 1.20);
        // 云体厚度对遮挡的影响：这里 thick 就是云在当前像素上的「厚」程度。
        // 透光律：厚少薄多，透过率 = 1 - density × 0.7。
        // 也就是说最厚的云仍放 30% 的光过去，不会变成整块死黑。
        float density = thick;
        float transmission = 1.0 - density * 0.7;
        float alpha = cover * mix(oMin, oMax, thick) * (0.55 + 0.45 * density);
        col = mix(col, lit, alpha);
        // 太阳透光：云挡住太阳时不该变成一块死黑斑。
        // 按「离太阳的夹角」给云加一点透射光，靠近太阳处的云被照亮，
        // 形成「太阳在云后面」的观感，而不是黑块把阳光整个吃掉。
        // transmission 让薄云透更多、厚云透一点，和上面的透光律一致。
        float sunThru = pow(max(dot(d, uSunDir), 0.0), 24.0);
        col += uSunColor * sunThru * transmission * alpha * 0.55 * sunVisible;
      }
    }
    return col;
  }

  // 海面反射用这条：不传屏幕 uv，所以不画星星（水里不该有星点）。
  vec3 skyColor(vec3 d, float cloudMask) {
    return skyColorAt(d, cloudMask, vec2(-1.0));
  }
  `

  function sh(type, src) {
    const s = gl.createShader(type)
    gl.shaderSource(s, src)
    gl.compileShader(s)
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(s)
      console.error('[OPEN SEA SKIN]', log)
      const pre = document.createElement('pre')
      pre.style.cssText = 'position:fixed;left:8px;top:8px;color:#f66;font:11px monospace;white-space:pre-wrap;max-width:92vw;z-index:99'
      pre.textContent = log
      document.body.appendChild(pre)
      return null
    }
    return s
  }

  function link(vs, fs) {
    if (!vs || !fs) return null
    const p = gl.createProgram()
    gl.attachShader(p, vs)
    gl.attachShader(p, fs)
    gl.linkProgram(p)
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      console.error('[OPEN SEA SKIN] link:', gl.getProgramInfoLog(p))
      return null
    }
    return p
  }

  const VS_FULL = `#version 300 es
  void main() {
    vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
  }`

  // 改动 3：WAVE_UNIFORMS 收常量
  const WAVE_UNIFORMS = `uniform vec2 uWaveDir[${WAVE_COUNT}];
  uniform float uWaveK[${WAVE_COUNT}];
  uniform float uWaveC[${WAVE_COUNT}];
  uniform float uWaveA0[${WAVE_COUNT}];`

  const VS_SEA = `#version 300 es
  precision highp float;
  in vec3 aPos;
  uniform mat4  uViewProj;
  uniform float uTime;
  uniform float uSea;
  ${WAVE_UNIFORMS}

  out vec3  vWorld;
  out vec3  vNormal;
  out float vCrest;

  void displace(vec2 xz, out vec3 disp, out vec3 tangX, out vec3 tangZ, out float crest) {
    disp  = vec3(0.0);
    tangX = vec3(1.0, 0.0, 0.0);
    tangZ = vec3(0.0, 0.0, 1.0);
    crest = 0.0;

    for (int i = 0; i < ${WAVE_COUNT}; i++) {
      vec2  dir = normalize(uWaveDir[i]);
      float k   = uWaveK[i];
      float c   = uWaveC[i];
      float a   = uWaveA0[i] * uSea;

      float f  = k * dot(dir, xz) - uTime * c;
      float cf = cos(f), sf = sin(f);

      disp += vec3(dir.x * a * cf, a * sf, dir.y * a * cf);

      float ak = a * k;
      tangX -= vec3(dir.x * dir.x * ak * sf, dir.x * ak * cf, dir.x * dir.y * ak * sf);
      tangZ -= vec3(dir.x * dir.y * ak * sf, dir.y * ak * cf, dir.y * dir.y * ak * sf);
      crest += a * sf;
    }
  }

  void main() {
    vec2 xz = aPos.xz;
    vec3 disp, tx, tz;
    float crest;
    displace(xz, disp, tx, tz, crest);
    vec3 p = vec3(xz.x, 0.0, xz.y) + disp;
    vWorld  = p;
    vNormal = normalize(cross(tz, tx));
    vCrest  = crest;
    gl_Position = uViewProj * vec4(p, 1.0);
  }`

  const FS_SEA = `#version 300 es
  precision highp float;
  in vec3  vWorld;
  in vec3  vNormal;
  in float vCrest;
  out vec4 fragColor;

  uniform vec3  uCamPos;
  uniform vec3  uShallow;
  uniform float uDetailScale;
  uniform float uDetailRadius;
  // 海陆共用同一个雾量 groundFog，地平线才接得上（地表用 smoothstep(25,90)+uFog*0.35）
  uniform float uFog;
  ${SKY_GLSL}

  float detailHeight(vec2 xz, float t) {
    return fbm(xz * 0.85 + vec2(t * 0.55, t * 0.32))
         + fbm(xz * 2.10 + vec2(-t * 0.4, t * 0.5)) * 0.45;
  }

  void main() {
    vec3 N = normalize(vNormal);
    vec3 toCam = uCamPos - vWorld;
    float dist = length(toCam);
    vec3 V = normalize(toCam);

    vec3  spec = vec3(0.0);
    float foam = 0.0;

    // 细节层在 70%~100% 半径内淡出到 0，避免 140m 处高光/白沫硬断成一条边
    float det = 1.0 - smoothstep(uDetailRadius * 0.70, uDetailRadius, dist);
    if (dist < uDetailRadius) {
      vec2 xz = vWorld.xz;
      float e  = 0.1;
      float h0 = detailHeight(xz, uTime);
      float hx = detailHeight(xz + vec2(e, 0.0), uTime);
      float hz = detailHeight(xz + vec2(0.0, e), uTime);
      // The detail normal has to fade too: fading only spec leaves another seam
      // from the normal perturbation out at the far edge.
      vec3 Ndet = normalize(N + vec3(h0 - hx, 0.0, h0 - hz) * uDetailScale);
      N = normalize(mix(N, Ndet, det));

      vec3 H = normalize(uSunDir + V);
      float ndh = max(dot(N, H), 0.0);
      float sparkleNoise = clamp(fbm(xz * 0.3 + vec2(uTime * -0.07, uTime * 0.05)) * 0.5 + 0.5, 0.0, 1.0);
      spec = uSunColor * (pow(ndh, 500.0) * mix(0.4, 3.4, sparkleNoise) + pow(ndh, 48.0) * 0.12);

      // 月光的高光：月亮方向单独算一遍。
      // 指数 260 比太阳的 500 更宽 —— 月光不像日光那样是一个针尖，
      // 它会在海面上铺成一条较宽的银色光带，这正是「月光照亮海面」的来源。
      vec3 Hm = normalize(uMoonDir + V);
      float ndhm = max(dot(N, Hm), 0.0);
      float moonSparkle = clamp(fbm(xz * 0.3 + vec2(uTime * -0.05, uTime * 0.04)) * 0.5 + 0.5, 0.0, 1.0);
      // 乘 uMoonDiscScale：月亮在面板上拉黑时必须连海面这条银光带一起消失，
      // 否则天上没月亮、海里却还有一条亮带，一眼就假。
      spec += uMoonColor * (pow(ndhm, 260.0) * mix(0.5, 2.6, moonSparkle) + pow(ndhm, 40.0) * 0.16) * uMoonDiscScale;

      float foamNoise = clamp(fbm(xz * 1.1 + vec2(uTime * 0.22, uTime * 0.14)) * 0.5 + 0.5, 0.0, 1.0);
      foam = smoothstep(0.5, 0.95, foamNoise) * smoothstep(1.0, 2.0, vCrest) * 0.85;
      // Specular and foam close out on the same soft edge instead of a hard cut.
      spec *= det;
      foam *= det;
    }

    vec3 col = mix(uDeep, uShallow, clamp(vCrest * 0.35 + 0.45, 0.0, 1.0));
    float sss = pow(max(dot(V, uSunDir), 0.0), 3.0) * max(vCrest, 0.0) * 0.18;
    col += uShallow * uSunColor * sss;
    // 月光的透射：夜里海水被月光从背后透亮，浪尖泛出一点冷蓝。
    // 透射同样跟着月亮亮度走，不然浪尖还泛着冷蓝，月亮却没了。
    float moonSss = pow(max(dot(V, uMoonDir), 0.0), 3.0) * max(vCrest, 0.0) * 0.22 * uMoonDiscScale;
    col += uShallow * uMoonColor * moonSss;

    vec3 R = reflect(-V, N);
    R.y = max(R.y, 0.04);
    float fresnel = 0.02 + 0.98 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
    col = mix(col, skyColor(normalize(R), step(0.25, fresnel)), fresnel);

    col += spec;
    col = mix(col, vec3(0.82, 0.88, 0.90), foam);
    // 保留海面原有起雾距离(150~290m)，另乘地表同一个 uFog，地平线处才连贯
    float seaFog = clamp(smoothstep(150.0, 290.0, dist) + uFog * 0.35, 0.0, 1.0);
    col = mix(col, uHorizon, seaFog);

    fragColor = vec4(col, 1.0);
  }`

  const FS_SKY = `#version 300 es
  precision highp float;
  out vec4 o;
  uniform vec3  uCamPos;
  uniform mat4  uInvVP;
  uniform vec2  uRes;
  ${SKY_GLSL}

  void main() {
    vec2 uv = gl_FragCoord.xy / uRes;
    vec2 ndc = uv * 2.0 - 1.0;
    vec4 f4 = uInvVP * vec4(ndc, 1.0, 1.0);
    vec3 d = normalize(f4.xyz / f4.w - uCamPos);
    o = vec4(skyColorAt(d, uCloudMask, uv), 1.0);
  }`

  const FS_BRIGHT = `#version 300 es
  precision highp float;
  out vec4 o;
  uniform sampler2D uTex;
  uniform vec2  uRes;
  uniform float uThreshold;
  void main() {
    vec2 uv = gl_FragCoord.xy / uRes;
    vec3 c = texture(uTex, uv).rgb;
    float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
    o = vec4(c * smoothstep(uThreshold, uThreshold + 0.3, lum), 1.0);
  }`

  const FS_BLUR = `#version 300 es
  precision highp float;
  out vec4 o;
  uniform sampler2D uTex;
  uniform vec2 uDir;
  uniform vec2 uRes;
  uniform float uRadius;
  void main() {
    vec2 uv = gl_FragCoord.xy / uRes;
    vec3 sum = vec3(0.0);
    float wsum = 0.0;
    for (int i = -8; i <= 8; i++) {
      float fi = float(i);
      float w = exp(-(fi * fi) / (2.0 * uRadius * uRadius * 64.0));
      sum += texture(uTex, uv + uDir * fi * 1.4 / uRes).rgb * w;
      wsum += w;
    }
    o = vec4(sum / wsum, 1.0);
  }`

  const FS_COMP = `#version 300 es
  precision highp float;
  out vec4 o;
  uniform sampler2D uScene;
  uniform sampler2D uBloom;
  uniform vec2  uRes;
  uniform float uBloomStrength;
  uniform float uExposure;
  vec3 aces(vec3 x) {
    const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
    return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
  }
  void main() {
    vec2 uv = gl_FragCoord.xy / uRes;
    vec3 scene = texture(uScene, uv).rgb;
    vec3 bloom = texture(uBloom, uv).rgb;
    vec3 col = scene + bloom * uBloomStrength;
    col = aces(col * uExposure);
    o = vec4(col, 1.0);
  }`

  // 太阳光束（丁达尔）：屏幕空间散射，叠在 rtScene 上、drawBloom 之前。
  // 太阳本体不在这里画 —— 那归 skyColor 的方向空间那段。本模块只管光束。
  const SUN_DEBUG = false
  const SUN_LOG = '[open-sea-skin][SunGlowGodray]'

  function createSunPass() {
    // 默认值：太阳 1.0（标准亮度，一眼能看见）、光晕半径 0.012。
    // sunDiscScale 小于 0.3 时太阳会淹没在天空底色里，别再往低调。
    const P = {
      glowIntensity: 1.0,
      glowRadius: 0.018,
      // 太阳本体相对亮度：1.0 = 标准，0 = 天体不存在
      sunDiscScale: 0.12,
      // 月亮本体相对亮度：1.0 = 原样，0 = 月亮消失。面板「月亮亮度」滑杆。
      moonDiscScale: 1.0,
      godrayIntensity: 0.8,
      godrayScatter: 0.6,
      godraySteps: 8,
      effectGlobalScale: 1.0,
    }
    const LIMITS = {
      glowIntensity: [0, 2], glowRadius: [0, 0.018], sunDiscScale: [0, 2],      moonDiscScale: [0, 2],
      godrayIntensity: [0, 2], godrayScatter: [0.2, 1.5], godraySteps: [4, 16],
      // effectGlobalScale 就是各着色器里的 uLightGlobal（环境光总倍率）。
      // 原来上限是 1 —— 也就是「环境光最多就是标准值」，想更亮只能把太阳本体拉爆，
      // 结果太阳刺眼、草和地面却还是暗的。
      // 放到 1.8：标准值 1 仍然是默认，想要更亮的白天可以把整体环境光抬到 1.8 倍。
      // 1.8 之上草地会开始过曝（草基色本来就乘了 GRASS_GAIN），所以不再往上留。
      effectGlobalScale: [0, 1.8],
    }
    const clampParam = (k, v) => {
      const lim = LIMITS[k]
      const n = Number(v)
      if (!Number.isFinite(n)) return P[k]
      const c = Math.min(lim[1], Math.max(lim[0], n))
      return k === 'godraySteps' ? Math.round(c) : c
    }

    // 降级状态：与用户参数完全分离，降级/恢复只动这两个字段
    let degraded = false
    let dirtyFrames = 0
    let cleanFrames = 0
    let godrayDynamic = true
    // 探针宏：null = 不注入任何探针分支（等价于上线剥离）
    let probe = null

    const FS_SUN = `#version 300 es
    precision highp float;
    out vec4 o;

    uniform vec3  uSunDir;
    uniform vec3  uSunColor;
    uniform float uCloudMask;
    uniform float uHorizonFactor;
    uniform vec2  uRes;
    uniform float uRenderScale;
    uniform float uHorizonUV;   // 海平线在屏幕上的 uv.y，JS 每帧按相机俯仰算好传入

    uniform float uGlowRadius;      // 光束的屏幕范围
    uniform float uGodrayIntensity;
    uniform float uGodrayScatter;
    uniform int   uGodraySteps;
    uniform float uEffectGlobalScale;

    // 太阳在屏幕上的位置，由 JS 用相机正向 viewProj 投影后传入（uv 空间 0..1）。
    // 不在 shader 里算：shader 只有 uInvVP（逆矩阵），拿它乘世界坐标方向是反的。
    uniform vec2 uSunUV;
    uniform float uTime;   // 场景时间（秒）：只用来让云缝缓慢漂移，不参与任何几何

    // 云缝用的轻量噪声。不引入 NOISE_GLSL（那套 fbm 体积大、编译慢），
    // 这里只要「低频、平滑、看不出格子」，hash + 双线性插值足够。
    float hash21(vec2 p) {
      p = fract(p * vec2(123.34, 456.21));
      p += dot(p, p + 45.32);
      return fract(p.x * p.y);
    }
    float valueNoise(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      f = f * f * (3.0 - 2.0 * f);
      float a = hash21(i);
      float b = hash21(i + vec2(1.0, 0.0));
      float c = hash21(i + vec2(0.0, 1.0));
      float d = hash21(i + vec2(1.0, 1.0));
      return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
    }
    // 两层叠出云缝的不规则感（单层会看出格阵）
    float cloudGapNoise(vec2 p) {
      return valueNoise(p) * 0.65 + valueNoise(p * 2.3 + 17.0) * 0.35;
    }

    void main() {
      vec2 uv = gl_FragCoord.xy / uRes;

      // ---- 探针（设计稿第 11 节）：无 PROBE 宏时不展开任何分支 ----
      #ifdef DEBUG_EFFECT_SOLID
      o = vec4(1.0, 0.25, 0.25, 1.0); return;   // 基准色：校验 pass 是否执行
      #endif
      #ifdef DEBUG_NODE_SUN_UV
      o = vec4(uSunUV, 0.0, 1.0); return;  // 中间量：太阳屏幕坐标（JS 侧算好传入）
      #endif
      #ifdef DEBUG_NODE_CLOUD_READ
      o = vec4(uCloudMask, uCloudMask, uCloudMask, 1.0); return; // 中间量：云遮挡读取值
      #endif

      // 两道过滤：
      //   1) sunDir.y < 0 说明太阳沉到海平线以下，本来就不该出现
      //   2) uv.y < 海平线 说明这个像素是海，不能往上叠太阳（否则海上会有光斑）
      // 第 2 条的阈值由 JS 按相机俯仰算出后传入，不是硬编码。
      if (uSunDir.y < -0.012) { o = vec4(0.0); return; }
      if (uv.y < uHorizonUV) { o = vec4(0.0); return; }

      // sunUV 由 JS 用相机正向 viewProj 投影算出后传进来。
      // 不能在 shader 里算：这里只有 uInvVP（逆矩阵），方向是反的。
      vec2 sunUV = uSunUV;
      float dist = length(uv - sunUV);

      // 太阳圆盘 + 光晕已经由天空着色器在「方向空间」画好了（见 skyColor 里那段）。
      // 方向空间天然不会越界，效果也比屏幕空间稳，所以这里不再画太阳本体，
      // 只负责屏幕空间才能做的「光束」这一件事。
      float radius = max(1e-3, uGlowRadius);

      float godray = 0.0;
      #ifdef ALLOW_DYNAMIC_RAY_STEP
      vec2 toSun = sunUV - uv;
      float d2 = length(toSun);
      if (d2 > 1e-4) {
        vec2 rayDir = toSun / d2;
        int steps = uGodraySteps;
        float stepLen = d2 / float(steps);
        float acc = 0.0;
        for (int i = 0; i < 16; i++) {
          if (i >= steps) break;
          vec2 sampleUv = uv + rayDir * stepLen * (float(i) + 0.5);
          float dd = length(sampleUv - sunUV);
          acc += exp(-dd * uGodrayScatter * 4.0);
        }
        godray = acc * (1.0 / float(steps)) * uGodrayIntensity;
        // 云对光柱的影响分两层，缺一层都假：
        //   1.整体遮挡（云多则光柱整体变淡）—— 用 uCloudMask
        //   2.穿缝效果（云缝处透光、云体处挡住）—— 用低频噪声模拟云层的不均匀
        // 只有1.的话，云一多就是整片均匀变暗，看不到「一束光从缝里打下来」。
        float horizonBand = 1.0 - smoothstep(0.08, 0.30, abs(uSunDir.y));
        // 云缝噪声：在采样方向上取一段低频噪声，阈值随云量上移 ——
        // 云越厚，能形成「缝」的区域越少（只有最稀疏处才透光）。
        float gapNoise = cloudGapNoise(uv * 4.2 + vec2(uTime * 0.03, -uTime * 0.021));
        float gapThr = 0.30 + uCloudMask * 0.45;
        float gap = smoothstep(gapThr, gapThr + 0.22, gapNoise);
        // 云缝透光：完全无云时 gap 恒为 1（不造缝），云越厚缝越明显
        float gapLight = mix(1.0, gap, clamp(uCloudMask * 1.4, 0.0, 1.0));
        godray *= mix(1.0, (1.0 - uCloudMask * 0.75) * gapLight, horizonBand);
        // 光束限定在太阳周围，避免整屏泛白
        godray *= smoothstep(radius * 6.0, radius * 1.2, dist);
      }
      #endif

      // 这里只输出光束。太阳本体的亮度由面板「太阳亮度」控制，
      // 但那是天空着色器的事，不在这里重复画。
      vec3 col = uSunColor * godray * uEffectGlobalScale * uHorizonFactor;
      col = clamp(col, vec3(0.0), vec3(100.0));
      o = vec4(col, 1.0);
    }`

    let program = null
    let U = {}
    let initOk = false

    function uni(p, n) { return gl.getUniformLocation(p, n) }

    function build() {
      // 先用带动态循环的版本编译；驱动拒绝就退回去掉宏的版本（只保留光晕）。
      // 探针宏按 probe 值注入，probe 为 null 时一行都不注入（等价于上线剥离）。
      const probeMacro = probe ? `#define ${probe}\n` : ''
      const head = `#version 300 es\n#define ALLOW_DYNAMIC_RAY_STEP 1\n${probeMacro}`
      const fragmentSource = FS_SUN.replace('#version 300 es', head)
      const without = FS_SUN.replace('#version 300 es', head).replace('#ifdef ALLOW_DYNAMIC_RAY_STEP', '#if 0')

      program = link(sh(gl.VERTEX_SHADER, VS_FULL), sh(gl.FRAGMENT_SHADER, fragmentSource))
      if (program) {
        godrayDynamic = true
        if (SUN_DEBUG) console.log(SUN_LOG, '[init] dynamic godray ok')
      } else {
        program = link(sh(gl.VERTEX_SHADER, VS_FULL), sh(gl.FRAGMENT_SHADER, without))
        godrayDynamic = false
        console.warn(SUN_LOG, '[init] dynamic loop rejected, glow only')
      }
      if (!program) {
        console.error(SUN_LOG, '[shader_fail] sun effect disabled')
        return false
      }
      U = {
        uSunDir: uni(program, 'uSunDir'),
        uSunColor: uni(program, 'uSunColor'),
        uCloudMask: uni(program, 'uCloudMask'),
        uHorizonFactor: uni(program, 'uHorizonFactor'),
        uRes: uni(program, 'uRes'),
        uHorizonUV: uni(program, 'uHorizonUV'),
        uSunUV: uni(program, 'uSunUV'),
        uTime: uni(program, 'uTime'),
        uRenderScale: uni(program, 'uRenderScale'),
        uGlowRadius: uni(program, 'uGlowRadius'),
        uGodrayIntensity: uni(program, 'uGodrayIntensity'),
        uGodrayScatter: uni(program, 'uGodrayScatter'),
        uGodraySteps: uni(program, 'uGodraySteps'),
        uEffectGlobalScale: uni(program, 'uEffectGlobalScale'),
      }
      return true
    }

    function snapshotDirty(sunDir) {
      const d = sunDir
      const bad = !Number.isFinite(d[0]) || !Number.isFinite(d[1]) || !Number.isFinite(d[2])
      // 连续 3 帧脏 → 降级；连续 2 帧干净 → 恢复
      if (bad) { dirtyFrames += 1; cleanFrames = 0 } else { dirtyFrames = 0; cleanFrames += 1 }
      if (bad && dirtyFrames >= 3) {
        if (!degraded) { degraded = true; console.warn(SUN_LOG, '[degrade] dirty_frame') }
      } else if (!bad && cleanFrames >= 2 && degraded) {
        degraded = false
        dirtyFrames = 0
        console.log(SUN_LOG, '[recover] input healed')
      }
      return bad
    }

    function glError(tag) {
      const e = gl.getError()
      if (e !== gl.NO_ERROR) {
        console.error(SUN_LOG, '[gl_error]', tag, e)
        return true
      }
      return false
    }

    return {
      init() {
        initOk = build()
        return initOk
      },
      get enabled() { return initOk && !degraded && P.effectGlobalScale > 0 },
      set params(next) {
        for (const k in next) if (k in P) P[k] = clampParam(k, next[k])
      },
      get params() { return { ...P, degraded, godrayDynamic } },
      // input: { sunDir, sunColor, cloudMask, horizonFactor, sunUV, renderScale }
      draw(input, rtFb) {
        // sunPass 只画光束，所以只看 effectGlobalScale（面板的「太阳光效」开关）。
        // sunDiscScale 是太阳本体的亮度，归天空着色器用，不在这里判。
        if (!initOk || degraded || P.effectGlobalScale <= 0) return
        if (!input || !input.sunDir || !input.sunUV) return
        if (snapshotDirty(input.sunDir)) return

        // 【关键】先清掉遗留的 GL 错误。
        // gl.getError() 返回并清空「最近一个」错误 —— 如果上一帧别的 Pass
        // （比如草地）留下了错误，这里会把那个错误误报成 bindFb 失败，
        // 然后直接 return 跳过光柱 → 用户看到「画面一闪一闪」。
        // 这不是真正的绑定失败，是错误计数串扰。先清空再检查才准。
        gl.getError()
        gl.bindFramebuffer(gl.FRAMEBUFFER, rtFb)
        if (glError('bindFb')) return
        gl.viewport(0, 0, W, H)
        gl.useProgram(program)

        gl.uniform3fv(U.uSunDir, input.sunDir)
        gl.uniform3fv(U.uSunColor, input.sunColor)
        gl.uniform1f(U.uCloudMask, Math.min(1, Math.max(0, input.cloudMask)))
        gl.uniform1f(U.uHorizonFactor, Math.min(1, Math.max(0, input.horizonFactor)))
        gl.uniform2f(U.uRes, W, H)
        // 海面关掉时把海平线推到屏幕外（-1）：shader 里那句
        // `if (uv.y < uHorizonUV) return` 就永远不成立，
        // 阳光会照到整个画面 —— 因为那时下半屏也是天空，不该再遮阳光。
        // 传 -1 而不是改 shader，是为了让这段着色器保持原样、少一处动画风险。
        gl.uniform1f(U.uHorizonUV, showSea ? input.horizonUV : -1)
        gl.uniform2f(U.uSunUV, input.sunUV[0], input.sunUV[1])
        // 只驱动云缝噪声的缓慢漂移，不影响任何几何
        gl.uniform1f(U.uTime, elapsed)
        gl.uniform1f(U.uRenderScale, input.renderScale)
        gl.uniform1f(U.uGlowRadius, P.glowRadius)
        gl.uniform1f(U.uGodrayIntensity, P.godrayIntensity)
        gl.uniform1f(U.uGodrayScatter, P.godrayScatter)
        gl.uniform1i(U.uGodraySteps, P.godraySteps)
        gl.uniform1f(U.uEffectGlobalScale, P.effectGlobalScale)
        if (glError('uniform')) return

        gl.enable(gl.BLEND)
        gl.blendFunc(gl.ONE, gl.ONE)
        gl.disable(gl.DEPTH_TEST)
        gl.disable(gl.CULL_FACE)
        gl.drawArrays(gl.TRIANGLES, 0, 3)
        if (glError('draw')) return
        // 恢复成下游 drawBloom 期望的状态：不混合、无深度、无剔除
        gl.disable(gl.BLEND)
        gl.blendFunc(gl.ONE, gl.ZERO)

        if (SUN_DEBUG) console.log(SUN_LOG, '[draw]', { scale: P.effectGlobalScale, horizon: input.horizonFactor })
      },
      dispose() {
        if (program) { try { gl.deleteProgram(program) } catch (e) {} }
        program = null
        initOk = false
        if (SUN_DEBUG) console.log(SUN_LOG, '[dispose]')
      },
    }
  }

  //  草地模块 · 第 1 期（骨架）

  //  【边界】只在 drawScene 里加一次 grassPass.draw()；不改海洋、天空、云、
  //  天气任何链路。失败隔离照抄 createSunPass（initOk / degraded），草挂了海照跑。

  //  【为什么用同一套 env】真实感的全部来源是「同一个天空函数」。草必须吃
  //  和 pSea 同一帧的 env.sunDir / env.horizon，否则和海面反射对不上 ——
  //  这正是 DETAIL.zh.md 里「云长在海洋里面」那条的同一个道理。

  //  【偷来的六条】来自 Vault 80 的实战记录（公开博客）：
  //    1. 两片交叉从上方看是十字架 → 六片扇开
  //    2. uv.y 是 0根 1尖，风和假 AO 都挂它
  //    3. aOffset 用绝对世界坐标 → 块间风不接缝
  //    4. 包围球自己设，computeBoundingSphere 只看到原点
  //    5. 双面卡片法线会翻转 → dome normal
  //    6. alphaTest 随距离松 0.42→0.14（mipmap 会吃草叶）

  const GRASS_TERRAIN_GLSL = `

  // 80k 0.5m gnoise A f
  // 0.66 fbm 0.5 2.13
  // 0.55 0.047 / P90 0.079 / 0.147 3.9m
  // 0.6 40m
  // P92 0.083 8%
  // / grass-consistency-test SLOPE_MAX
  float terrainFbm(vec2 p) {
    return gnoise(p) + gnoise(p * 2.13 + vec2(31.7, 12.9)) * 0.5;
  }
  float terrainHeight(vec2 xz) {
    float h = terrainFbm(xz * 0.010) * 6.0
            + terrainFbm(xz * 0.045 + vec2(7.3, 19.1)) * 1.20
            + gnoise(xz * 0.140 + vec2(3.7, 11.3)) * 0.42;
    return h * 0.55 + 2.20;
  }
  // 0.5m 0.05~1.0m
  // 2m 0.5
  float terrainSlope(vec2 xz) {
    float e = 0.5;
    float hx = terrainHeight(xz + vec2(e, 0.0)) - terrainHeight(xz - vec2(e, 0.0));
    float hz = terrainHeight(xz + vec2(0.0, e)) - terrainHeight(xz - vec2(0.0, e));
    return clamp(length(vec2(hx, hz)) / (2.0 * e), 0.0, 1.0);
  }
  // 0 = 1 =
  // Vault 80
  float grassGrowth(vec2 xz) {
    return clamp(gnoise(xz * 0.021 + vec2(5.1, 2.7)) * 0.5 + 0.5
               + gnoise(xz * 0.071 + vec2(13.3, 8.9)) * 0.25, 0.0, 1.0);
  }
  `

  // Shared lighting model. Grass and flowers used to carry identical copies of
  // this block; keeping one copy means "tone the lighting" is a single edit and
  // the two can never drift apart.
  //
  // The uniforms (uSunDir, uSunColor, uMoonDir, uMoonColor, uSunScale,
  // uMoonScale, uLightGlobal, uHorizon, uZenith) are declared by each shader,
  // because each one needs a different subset elsewhere too. This block only
  // carries the function.
  //
  // The key point: sunDiscScale is not "sun brightness". It scales the sun DISC
  // in the sky. Real sunlight strength lives in env.sunColor, which already has
  // the time-of-day intensity folded in. Before this was understood, grass was
  // multiplying by the disc scale and losing ~88% of its sunlight, which is why
  // day and night used to look identical.
  const LIGHT_GLSL = `
  // N: surface normal.
  // Returns the light reaching the surface, to be MULTIPLIED into the material
  // colour - not a brightness adjustment. sunOut/skyOut expose the two terms
  // the weather layer still needs (wet sheen, snow tint).
  vec3 shadeLight(vec3 N, out vec3 sunOut, out vec3 skyOut) {
    float sunLit = max(dot(N, uSunDir), 0.0);
    // Half-lambert: shadowed side keeps 40%. Grass blades scatter a lot.
    float sunWrap = sunLit * 0.60 + 0.40;
    vec3 sunLight = uSunColor * uSunScale * uLightGlobal;

    float moonLit = max(dot(N, uMoonDir), 0.0);
    vec3 moonLight = uMoonColor * uMoonScale * (moonLit * 0.65 + 0.35);

    float skyUp = clamp(N.y * 0.5 + 0.5, 0.0, 1.0);
    vec3 skyLight = mix(uHorizon * 0.55, uZenith * 0.90, skyUp);

    sunOut = sunLight;
    skyOut = skyLight;
    // Weights measured against three time-of-day targets:
    //   noon ~0.30 brightness, dusk ~0.22 (warm), night ~0.10. A 2-3x spread is
    // what makes the changing sky visible at all.
    return sunLight * sunWrap * 3.20
         + moonLight * 1.80
         + skyLight * 0.85 * (0.45 + 0.55 * uLightGlobal);
  }
  `

  const VS_GRASS = `#version 300 es
  precision highp float;
  ${NOISE_GLSL}

  in vec3 aPos;       // ( )
  in vec3 aNormal;    // dome normal,
  in vec2 aUV;        // uv.y: 0 = ,1 =

  in vec3 aOffset;    // ( )
  in vec4 aParams;    // x= Y , y=XZ , z=Y ( ), w=
  in vec2 aVar;       // x= , y=
  // :0 = ( ),1 = ,2 = .
  // , draw call -- ,
  in float aKind;

  uniform mat4  uViewProj;
  uniform vec3  uCamPos;
  uniform float uTime;
  uniform vec2  uWind;      // (__ossWind)
  uniform float uWindSpeed;
  uniform float uPressure;  // 0 = ( ), 1 = ( )

  out vec2  vUV;
  out vec3  vNormal;
  out vec3  vWorld;
  out vec2  vVar;
  out float vHeightN;

  void main() {
    float t = aUV.y;
    // aKind is still bound as a vertex attribute (the instance buffer carries
    // it), so it must be read somewhere or the compiler strips the attribute
    // and getAttribLocation returns -1. Multiplying the height scale by
    // aKind*0.0 is a no-op that keeps it alive without affecting geometry.
    float kindKeep = aKind * 0.0;
    // [ ]aKind :
    // , flowerPass .
    // aKind ( ), .

    // -> Y ->
    vec3 p = aPos * vec3(aParams.y, aParams.z, aParams.y);
    float ca = cos(aParams.x), sa = sin(aParams.x);
    p = vec3(p.x * ca + p.z * sa, p.y, -p.x * sa + p.z * ca);
    vec3 world = aOffset + p;

    // : + , t -- , .
    float gust = 0.65 + 0.35 * sin(uTime * 0.35 + aVar.x * 6.28318);
    // ---- 风扫草浪 ----
    // 【旧写法为什么看不到草浪】
    //   wavePhase = windDist*0.35 - uTime*1.80     ← 行波想以 1.8rad/s 沿风向扫
    //   lowRaw    = sin(uTime*1.15 + phase + ...)  ← 又加了一个全片同步的 uTime*1.15
    //   两个时间项互相抵消，净扫速只剩 0.65rad/s，而且相位被搅乱 ——
    //   结果是"整片草一起慢慢晃"，波前读不出来。
    // 【正确做法】时间只出现在一处：行波自己带着时间往前走，
    //   sin() 里除了叶片位置 t（叶根到叶尖的相位差，让叶子有弧度）之外不再加时间。
    //   这样相邻草的相位差完全由 windDist 决定，屏幕上就是一道波推过去。
    vec2  wdir = normalize(uWind + vec2(0.0001));
    float windDist = dot(aOffset.xz, wdir);           // 该撮草在风向轴上的位置(m)
    // 波长 12m（k=0.52）→ 48m 场地上约 4 个波；扫速 2.4rad/s → 一波扫完约 2.6 秒。
    // 比原来更密更快：波长越短、扫得越快，肉眼越容易读出「波」而不是「整体晃」。
    const float WAVE_K = 0.52;
    const float WAVE_W = 2.40;
    float wavePhase = windDist * WAVE_K - uTime * WAVE_W;
    // 【随机相位必须远小于空间相位差，否则波前被打散】
    // 相邻草相距 1m 时，空间相位差 = 1 × WAVE_K = 0.52 rad。
    // 随机项跨度 = aParams.w(0..2π) × 系数：
    //   系数 0.18 → 跨度 1.13 rad，是空间项的 2.2 倍 → 波前被随机打散，只看到乱晃
    //   系数 0.03 → 跨度 0.19 rad，只有空间项的 36% → 波前清晰，又不至于像硬板
    // 草的个体差异应该体现在粗细/高度/亮度（aVar.x / aParams.z / aVar.y），不是在相位上。
    const float PHASE_JITTER = 0.03;
    float phase = wavePhase + aParams.w * PHASE_JITTER;
    // 叶片弧度：叶根到叶尖的相位差，让整片叶子呈弧形而不是一根直棍
    float bladeArc = t * 1.6;
    float lowRaw  = sin(phase + bladeArc);
    float highRaw = sin(phase * 1.7 + t * 4.0) * 0.35;
    // 草也只朝一个方向弯（与花同一处理）。
    // 【弯曲量必须是"始终有基础值"的单边正值】
    // 原来：low = 0.25 + 0.75*(...)  →  谷底 0.25，再减 high 的 -0.175 = 0.075，
    //       谷底位移只有叶尖 1.7cm，草几乎直立；波峰却有 42cm。
    //       差 25 倍，视觉上像"草在抽动"，不是"风压过去"。
    // 现在：谷底抬到 0.55，波峰到 1.0 —— 任何时刻草都是伏的，只是伏多少在变。
    float low = 0.55 + 0.45 * (lowRaw * 0.5 + 0.5);
    // high 缩小到 ±0.10，保证 low+high 恒在 0.45..1.10，永不接近 0
    float high = highRaw * 0.30;
    // ---- 风的压制力（基础压弯量）----
    // 【旧版为什么压不住】
    //   gustEnv = 0.55 + 0.45*sin(wavePhase)*... 会随行波在 0.10~1.00 之间变，
    //   波谷时 amp 几乎归零 —— 草在谷底是直立不动的，波峰才弯下去。
    //   加上低频摆动，看到的就是「一会儿弯一会儿直」的抖动，而不是「一直被风压着」。
    // 【现在】拆成两层：
    //   basePress：恒定压弯，保证任何时刻草都是伏的（这就是风的压制力）
    //   gustEnv  ：在压弯之上叠加阵风起伏，只做小幅增强/减弱，不再归零
    const float GRASS_SWAY = 3.2;
    float amp = uWindSpeed * (0.16 + 0.22 * aVar.x) * aParams.z * gust * GRASS_SWAY;
    // 基础压制 + 阵风调制。0.62 底 + 0.38 起伏 → gustEnv 恒在 0.62~1.00，
    // 永远压着，只是力量大小在变。
    float gustEnv = 0.62 + 0.38 * sin(wavePhase) * (0.40 + 0.60 * uWindSpeed);
    amp *= gustEnv;
    // 【力道：t² 是"只有叶尖在动"的罪魁】
    // bend = wdir * (low+high) * amp * t * t
    //   t 是叶根(0)→叶尖(1)。t² 让中段只剩 25% 位移，
    //   于是整根草看起来"基部钉死、只有尖在抖"—— 这就是力道不足的观感来源，
    //   和风速（WAVE_W）完全无关，是【幅度分布】的问题。
    // 真实草叶是整根呈弧形弯曲，不是只有尖动。改用 t^1.35：
    //   t=0.5 时代入 = 0.39（原来 0.25，多出 56%），中段明显跟着伏下去，
    //   同时叶根仍为 0（不穿地）。
    float tArc = pow(t, 1.35);
    vec2  bend = wdir * (low + high) * amp * tArc;

    world.xz += bend;
    // 弯得越多，叶尖垂得越多（草叶长度守恒的近似）
    world.y -= low * amp * 0.55 * tArc;

    // : ( 1 2 )
    float sag = (1.0 - uPressure) * t * t * 0.42 * aParams.z;
    world.y -= sag;

    // : , t (dome normal)
    vec3 n = normalize(mix(aNormal, vec3(0.0, 1.0, 0.0), 0.45));

    vUV = aUV;
    vNormal = n;
    vWorld = world;
    vVar = aVar;
    vHeightN = aParams.z;
    gl_Position = uViewProj * vec4(world, 1.0 + kindKeep);
  }`

  const FS_GRASS = `#version 300 es
  precision highp float;
  ${NOISE_GLSL}

  in vec2  vUV;
  in vec3  vNormal;
  in vec3  vWorld;
  in vec2  vVar;
  in float vHeightN;

  uniform vec3  uCamPos;
  uniform vec3  uSunDir;
  uniform vec3  uSunColor;
  uniform vec3  uHorizon;
  uniform vec3  uZenith;
  uniform float uCloudMask;
  // 云影 [windX, windY, driftRate]，只有地表着色器有
  uniform vec3  uCloudShadow;
  uniform float uFog;        // 0 = ,1 = (__ossAtmos.visibility )
  uniform float uTime;
  uniform float uAlphaBase;  // alphaTest
  uniform float uGrassRadius; // : ,

  // ---- ( sunPass / env, )----
  uniform vec3  uMoonDir;     // (env.moonDir), -sunDir
  uniform vec3  uMoonColor;   // ,
  uniform float uSunScale;    // ->
  uniform float uMoonScale;   // ->
  uniform float uLightGlobal; // (0 = )

  // Weather coupling. Two numbers only, pushed by the client's precipitation
  // state; the shader never inspects the weather itself, so the seam stays
  // narrow and testable.
  //   uSnowCover 0..1  how much snow has settled (0 dry, 1 fully snowed over)
  //   uWetness   0..1  how soaked the leaves are  (0 dry, 1 dripping)
  uniform float uSnowCover;
  uniform float uWetness;

  out vec4 frag;

  // Injected AFTER the uniforms: shadeLight() reads them, so the declarations
  // must come first.
  ${LIGHT_GLSL}

  void main() {
    // This shader only draws grass. The stone and flower branches that used to
    // live here were unreachable (the vertex stage writes vKind = aKind * 0.0,
    // which is always 0) and have been removed; flowers are drawn by their own
    // pass with their own program.
    float x = abs(vUV.x - 0.5) * 2.0;
    // ---- 叶尖宽度：远处抬高下限 ----
    // 原来 mix(1.0, 0.06, vUV.y)：叶尖只有 6% 宽，近处很利落，
    // 但草地半径 48m，远处叶尖落到 1 像素以下，像素之间忽有忽无，
    // 叠成一片抖动的噪点 —— 这就是「远处发糊」的主要来源之一。
    // 现在按距离把叶尖下限抬起来：近处保持 0.06（锋利），
    // 远处抬到 0.30（变成一根能看清的细茎，不再闪）。
    float dist = length(uCamPos - vWorld);
    float farLift = smoothstep(10.0, 45.0, dist);
    float tipW = mix(0.06, 0.30, farLift);
    float width = mix(1.0, tipW, vUV.y);
    float edge = width + (gnoise(vec2(vWorld.x + vWorld.z, vUV.y * 3.0)) * 0.10);
    if (x > edge) discard;

    // ---- alphaTest (mipmap )----
    float alphaThreshold = mix(uAlphaBase, 0.14, smoothstep(8.0, 48.0, dist));
    if (alphaThreshold > 0.99) discard;

    // smoothstep(0.0, 0.95, uv.y) ^ 1.35: ,
    // 0.22 , 0.85:
    // 22% ( ), .
    float g = pow(smoothstep(0.22, 1.0, vUV.y), 0.85);

    vec3 rootCol = vec3(0.075, 0.115, 0.048);
    vec3 tipA    = vec3(0.32, 0.46, 0.16);
    vec3 tipB    = vec3(0.44, 0.52, 0.20);
    vec3 tipCol  = mix(tipA, tipB, vVar.x);
    // , 20cm
    tipCol = mix(tipCol, tipCol * 1.06, vVar.y);
    vec3 col = mix(rootCol, tipCol * (0.85 + 0.3 * vVar.y), g);
    // ---- 基础亮度（GRASS_GAIN）----
    // 上面这组基色是旧值：叶根 (0.075,0.115,0.048) 接近黑，叶尖也才 0.32~0.44。
    // 而最终是 col *= lightSum（相乘，不是相加），所以白天叶片中段出来只有
    // 约 0.3~0.4 的亮度，整体发闷。
    // 这里统一乘一个增益：1.0 = 旧观感，1.45 = 现在（白天明亮、叶片通透）。
    // 只调基色不动光照 —— 改 shadeLight 会连带影响花和地面，风险更大。
    const float GRASS_GAIN = 1.45;
    col *= GRASS_GAIN;

    // ---- Light ----
    // Per-clump normal tilt so the field is not uniformly lit.
    float tiltA = vVar.x * 6.28318;
    vec3 N = normalize(vNormal + vec3(sin(tiltA) * 0.38, 0.0, cos(tiltA) * 0.38));
    vec3 sunLight, skyLight;
    vec3 lightSum = shadeLight(N, sunLight, skyLight);
    col *= lightSum;

    // ---- Weather: wetness and snow cover ----
    //
    // Wet: water darkens a leaf and dulls its diffuse response while sharpening
    // the specular lobe. Cheap approximation: darken, then add a broad
    // sun-facing sheen plus a little overcast bounce.
    float wet = clamp(uWetness, 0.0, 1.0);
    col *= 1.0 - wet * 0.32;
    float sheen = pow(max(dot(N, uSunDir), 0.0), 6.0);
    col += sunLight * sheen * wet * 0.55;
    col += skyLight * wet * 0.06;

    // Snow: settles on the upper part of each blade, thins towards the root.
    // Per-clump "hold" makes the field patchy instead of uniformly white, and
    // the colour is multiplied by ambient so snow turns blue at night and warm
    // at dusk rather than staying a flat white cut-out.
    float snow = clamp(uSnowCover, 0.0, 1.0);
    if (snow > 0.001) {
      // Snow builds from the tip downwards and, by the time the field is fully
      // covered, reaches almost to the root. The previous version only ever
      // whitened the top third, and a blade is a few pixels wide, so nothing
      // was visible. Now the coverage line sweeps the whole blade:
      //   snow 0.2 -> tips only      snow 0.7 -> most of the blade
      //   snow 1.0 -> down to the root, only a hint of green left
      float hold = 0.75 + 0.25 * vVar.x;          // per-clump variation
      float coverage = clamp(snow * hold * 1.9, 0.0, 1.0);
      // vUV.y: 0 = root, 1 = tip. Invert so coverage grows downwards as snow rises.
      float onBlade = smoothstep(1.0 - coverage, 1.0 - coverage + 0.35, vUV.y);
      vec3 snowCol = vec3(0.92, 0.94, 0.97) * (skyLight * 0.55 + sunLight * 0.35);
      col = mix(col, snowCol, clamp(onBlade, 0.0, 1.0));
      // Snow is matte: kill most of the wet sheen where it has settled.
      col *= 1.0 - onBlade * 0.12;
    }

    // ( ) , 0.30.
    // ---- 叶片次表面散射（SSS）----
    // 原来只有 backGate 一项，而且门限 0.55~0.98：只有在「相机-太阳-叶片」
    // 几乎一条线时才生效，其它角度完全没有透光 —— 于是叶片背光面纯黑，
    // 整片草看起来死沉沉的、毫无鲜艳感。
    // 真实叶片是半透薄膜，光会穿过叶肉并带上叶绿素的黄色调。这里分两层：
    //   ① wrap：环绕光。把 Lambert 的负半区折回来，背光面也有 25% 的透光，
    //      不依赖视角，草无论在什么太阳角度都不会死黑。
    //   ② backGate：逆光透射。原有那层，负责「背对太阳看草时边缘发亮」。
    vec3 V = normalize(uCamPos - vWorld);
    float back = max(dot(-V, uSunDir), 0.0);
    float backGate = smoothstep(0.45, 0.95, back);
    // 叶片朝向太阳的程度（N 已在上面算好）
    float ndl = dot(N, uSunDir);
    // wrap：把 -1..1 的 Lambert 折到 0..1，背光面保底 0.25
    float wrap = clamp(ndl * 0.5 + 0.5, 0.0, 1.0);
    // 系数 0.25 太小（实测背光面只多加 0.004，肉眼无感），提到 1.6
    float sssWrap = wrap * wrap * 1.6;
    // 透射色：叶绿素透光偏黄绿，叶尖更黄（薄膜更薄）
    vec3 throughCol = mix(vec3(0.38, 0.55, 0.14), vec3(0.68, 0.82, 0.26), vUV.y);
    col += throughCol * sunLight * (sssWrap + backGate * 0.30) * g;

    // 云影落地：同一套 fbm 投到世界坐标并随 uCloudShadow 漂移，
    // cSh=1 在云下、0 在云缝；差值随 uCloudMask 缩放，无云时退化为旧观感。
    float maskN = clamp(uCloudMask, 0.0, 1.0);
    vec2  csP = vWorld.xz * 0.03 + uCloudShadow.xy * uTime * uCloudShadow.z * 0.5;
    float cSh = smoothstep(0.15, 0.55, fbm(csP) * 0.5 + 0.5);
    // Cloud gaps keep the old uniform dimming; under a cloud one more 0.76.
    // maskN scales the difference, so with no cloud the whole term returns to
    // 1.0 - identical to before this change.
    float cloudShade = mix(1.0, 0.72, maskN);
    float cloudShadeC = mix(cloudShade, cloudShade * 0.76, cSh * maskN);
    col *= mix(1.0, cloudShadeC, 0.65);
    // Cloud shadow: a slight cool shift under cloud (scattered light), tiny amount
    col = mix(col, col * vec3(0.92, 0.95, 1.02), cSh * maskN * 0.4);

    // [ ] GRASS_RADIUS(48m), .
    // 48m , --
    // :36->48m , , .
    // edge -- 60 float edge( ),
    // GLSL . grass shader failed .
    float radiusEdge = uGrassRadius;            // , JS GRASS_RADIUS
    float edgeFade = smoothstep(radiusEdge, radiusEdge - 12.0, dist);   // 12m
    if (edgeFade < 0.02) discard;                          //

    // 雾：原来 smoothstep(25, 90) 起得太早 —— 草地半径才 48m，
    // 等于超过一半的草地都被雾糊掉了，远处自然一片发灰。
    // 改成 70~190：雾只在真正的远景才出现，中近距离保持清晰。
    float fog = smoothstep(70.0, 190.0, dist);
    fog = clamp(fog + uFog * 0.35, 0.0, 1.0);
    col = mix(col, uHorizon, fog);

    if (g <= 0.0) discard;
    frag = vec4(col, 1.0);
  }`

  const FS_GROUND = `#version 300 es
  precision highp float;
  ${NOISE_GLSL}

  in vec3 vWorld;
  out vec4 frag;

  uniform vec3  uCamPos;
  uniform vec3  uSunDir;
  uniform vec3  uSunColor;
  uniform vec3  uHorizon;
  // uZenith is needed by the puddle reflection (sky colour straight up).
  uniform vec3  uZenith;
  uniform float uCloudMask;
  uniform vec3  uCloudShadow;  // cloud shadows (v2-C): [windX, windY, driftRate], same as grass
  uniform float uFog;
  uniform float uSlopeMax;   // ,
  // Same two weather numbers the grass uses, so ground and grass never diverge.
  uniform float uSnowCover;
  uniform float uWetness;
  // Light module, so puddles glint with the same sun/moon as grass and ocean.
  uniform vec3  uMoonDir;
  uniform vec3  uMoonColor;
  uniform float uSunScale;
  uniform float uMoonScale;
  uniform float uLightGlobal;
  // Puddle ripples drift with time, same as the ocean detail waves.
  uniform float uTime;

  ${GRASS_TERRAIN_GLSL}

  void main() {
    vec2 xz = vWorld.xz;
    float slope = terrainSlope(xz);
    float growth = grassGrowth(xz);
    // :0 = ,1 = . ,
    float sn = clamp(slope / max(uSlopeMax, 1e-4), 0.0, 1.5);
    float grain = terrainFbm(xz * 0.9) * 0.5 + 0.5;
    // ---- 基色（已按白天观感提亮）----
    // 旧值 soil (0.115,0.088,0.060) / turf (0.048,0.078,0.032) 太暗，
    // 而地面这套光照最多只乘到 1.0（见下方 sunLit 那段），所以白天出来就一片发闷。
    // 这里把基色整体抬到能看见材质关系的量级：泥土发褐、草皮发绿，而不是一团深灰。
    vec3 soil   = mix(vec3(0.20, 0.152, 0.104), vec3(0.30, 0.232, 0.158), grain);
    vec3 gravel = mix(vec3(0.32, 0.30, 0.27), vec3(0.46, 0.43, 0.39), grain);
    // (sn > 1)
    vec3 col = mix(soil, gravel, smoothstep(0.80, 1.30, sn));
    // . 72% , --
    // growth (0.82~1.0), .
    vec3 turfA = vec3(0.105, 0.160, 0.070);   // :
    vec3 turfB = vec3(0.170, 0.235, 0.110);   // :
    vec3 turf = mix(turfA, turfB, growth);
    // (sn > 0.75)
    col = mix(col, turf, mix(0.82, 1.0, growth) * (1.0 - smoothstep(0.75, 1.15, sn)));

    // 解析法线：用 terrainHeight 中心差分代替 dFdx 导数法线。
    // 96 段铺 130m 时导数法线逐三角面为常量，斜面上会有折面/网格感。
    // e=0.6 略宽于 terrainSlope 的 0.5，正好跨过半格。
    float eN = 0.6;
    float hxN = terrainHeight(vWorld.xz + vec2(eN, 0.0)) - terrainHeight(vWorld.xz - vec2(eN, 0.0));
    float hzN = terrainHeight(vWorld.xz + vec2(0.0, eN)) - terrainHeight(vWorld.xz - vec2(0.0, eN));
    vec3 N = normalize(vec3(-hxN, 2.0 * eN, -hzN));
    if (N.y < 0.0) N = -N;
    float sunLit = max(dot(N, uSunDir), 0.0);
    col *= mix(0.55, 1.0, sunLit * 0.5 + 0.5);
    col += uSunColor * sunLit * 0.04;
    // ---- 天光（hemisphere ambient）----
    // 原来这里【只有直射太阳】，一点环境光都没有：太阳一斜、地一背光，
    // 整块地面就掉到接近黑。真实地表大部分亮度来自天空的漫射，
    // 所以补一项：朝上 → 取天顶色，朝下 → 取地平线色，中间平滑过渡。
    // 系数 0.55 让阴影面也能看出材质，而不是死黑。
    float skyUpG = clamp(N.y * 0.5 + 0.5, 0.0, 1.0);
    vec3 ambientSky = mix(uHorizon * 0.75, uZenith * 1.15, skyUpG);
    col += col * ambientSky * 0.55;
    // 谷地 AO：低处被周围地形遮挡而压暗（地形基准高 2.20，2.0~3.4 为过渡段）
    float valleyAO = smoothstep(2.0, 3.4, terrainHeight(vWorld.xz));
    col *= mix(0.72, 1.0, valleyAO);
    // 云影：与 FS_GRASS 同一噪声和相位，云缝保持 0.78、云下再乘 0.76
    float maskN = clamp(uCloudMask, 0.0, 1.0);
    vec2  csP = xz * 0.03 + uCloudShadow.xy * uTime * uCloudShadow.z * 0.5;
    float cSh = smoothstep(0.15, 0.55, fbm(csP) * 0.5 + 0.5);
    float cloudShadeG = mix(0.78, 0.78 * 0.76, cSh * maskN);
    col *= mix(1.0, cloudShadeG, 0.65);
    col = mix(col, col * vec3(0.92, 0.95, 1.02), cSh * maskN * 0.4);

    // ---- Weather on the ground: puddles ----
    //
    // Scale matters more than anything else here. A puddle should be knee-deep
    // and arm's width across - about 0.5-2 m. The first version sampled the
    // noise at 0.85, i.e. features tens of metres wide, so the water merged
    // into one pond in the foreground. Sampling at ~3.5 brings the pools down
    // to a couple of metres, which is what a field actually does.
    //
    // The other half is that standing water is a *surface*, so it has to take
    // light from the same module as everything else: sky reflection plus a
    // sun/moon specular, both scaled by the panel sliders.
    float wet = clamp(uWetness, 0.0, 1.0);
    col *= 1.0 - wet * 0.22;                     // wet ground is darker first
    if (wet > 0.001) {
      // Water collects where the ground is flat: steep slopes drain.
      float flatness = 1.0 - smoothstep(0.25, 0.95, sn);
      // Two octaves: a ~1 m main body plus a finer broken edge, so the boundary
      // reads as water soaking into soil rather than a stamped decal.
      // (1/1.15 = 0.87 m features - measured, not guessed. Going finer than
      //  ~1.8 makes it sparkle like gravel instead of pooling.)
      float big = terrainFbm(xz * 1.15) * 0.5 + 0.5;
      float fine = terrainFbm(xz * 4.3 + 11.3) * 0.5 + 0.5;
      float pools = big * 0.70 + fine * 0.30;
      // The first version turned every hollow into a pond: coverage was far too
      // wide and the edge too soft, so the foreground became one sheet of water.
      // Now the mask is hard-thresholded so puddles stay separate, and the area
      // they cover only ramps up in the top of the slider range.
      float coverage = pools * flatness;
      // Threshold and width both move with the slider, so coverage grows
      // roughly linearly instead of jumping to a maximum at 25%.
      // Measured: this keeps the covered area between ~5% and ~35% over the
      // whole slider range (see puddle-cover3), which reads as "a few puddles"
      // at the low end and "a waterlogged field" at the top - never a pond.
      float thr = mix(0.72, 0.40, wet);
      float puddle = clamp((coverage - thr) / 0.16, 0.0, 1.0);
      if (puddle > 0.001) {
        // ---- Use the ocean's water model, not a simplified copy ----
        //
        // The previous version was a decal: a fixed sky tint plus one
        // pow() glint. It looked painted on because it was missing the three
        // things that actually make water read as water in FS_SEA:
        //   1. a perturbed normal (a real puddle surface is never perfectly flat)
        //   2. Schlick fresnel with the 5th power
        //   3. two-lobe specular with sparkle noise
        // Everything below mirrors FS_SEA so ground water and sea water agree.
        vec3 V = normalize(uCamPos - vWorld);

        // 1. Disturb the normal with a fine, slow ripple.
        //
        // Careful with the scale: sampling terrainFbm at 3.1 (0.3 m features)
        // with an 8 cm stencil produced a nearly constant gradient over the
        // whole puddle, which the eye reads as horizontal banding rather than
        // water. A puddle is almost flat - the ripple has to be both much
        // finer than the puddle and much weaker than a wave. 0.055 keeps the
        // streaks out entirely while still breaking up the mirror like a
        // real surface film does.
        vec2 pxz = vWorld.xz;
        float e = 0.05;
        float h0 = terrainFbm(pxz * 9.0 + vec2(uTime * 0.05, uTime * 0.03));
        float hx = terrainFbm((pxz + vec2(e, 0.0)) * 9.0 + vec2(uTime * 0.05, uTime * 0.03));
        float hz = terrainFbm((pxz + vec2(0.0, e)) * 9.0 + vec2(uTime * 0.05, uTime * 0.03));
        vec3 Nw = normalize(N + vec3(h0 - hx, 0.0, h0 - hz) * 0.055);

        // 2. Schlick fresnel, same 0.02 base as the sea. Head-on a puddle shows
        // the ground beneath; at a grazing angle it turns into a mirror.
        float fresnel = 0.02 + 0.98 * pow(1.0 - max(dot(Nw, V), 0.0), 5.0);

        // Sky reflection. The curve matters: a plain mix() over R.y makes the
        // reflection look flat and washed out. The 0.42 power matches how the
        // sky actually brightens toward the horizon, which is the same curve
        // the sky itself uses. Without it the water reads as a grey decal.
        vec3 R = reflect(-V, Nw);
        R.y = max(R.y, 0.04);
        float rUp = clamp(R.y, 0.0, 1.0);
        vec3 skyRefl = mix(uHorizon, uZenith, pow(rUp, 0.42));
        // Below the reflected horizon the surface sees the darker ground-side
        // hemisphere rather than the zenith, which is why puddle edges look
        // darker than their centres.
        skyRefl = mix(skyRefl, uHorizon * 0.62, smoothstep(0.30, 0.0, R.y));

        // 3. Two-lobe specular + sparkle, driven by the light module.
        vec3 sunLight = uSunColor * uSunScale * uLightGlobal;
        vec3 moonLight = uMoonColor * uMoonScale;
        vec3 H = normalize(uSunDir + V);
        float ndh = max(dot(Nw, H), 0.0);
        float sparkle = clamp(terrainFbm(pxz * 5.0 + vec2(uTime * -0.09, uTime * 0.06)) * 0.5 + 0.5, 0.0, 1.0);
        vec3 spec = sunLight * (pow(ndh, 420.0) * mix(0.4, 3.0, sparkle) + pow(ndh, 40.0) * 0.10);
        vec3 Hm = normalize(uMoonDir + V);
        float ndhm = max(dot(Nw, Hm), 0.0);
        spec += moonLight * (pow(ndhm, 220.0) * mix(0.5, 2.2, sparkle) + pow(ndhm, 36.0) * 0.14);

        // ---- Transparent water, not an opaque mirror ----
        //
        // This is the fix. Everything above computed a nice reflection, but then
        // painted it over the ground with a flat 0.35 darken - so the puddle
        // became an opaque grey disc. Real shallow water is mostly transparent:
        // you see the ground through it, refracted and tinted, with the sky
        // reflection laid on top according to Fresnel.
        //
        // Reference: the standard shallow-water shading used by every puddle
        // demo (Schlick fresnel + refract() toward the ground + Beer's law for
        // turbidity). Same maths as the ocean, plus the ground underneath.

        // Refract the view ray into the water and look at the ground through it.
        vec3 refrDir = refract(-V, Nw, 1.0 / 1.333);
        float depth = 0.05 + 0.09 * puddle;          // puddle depth in metres
        // The ground under a puddle is the ground we already shaded. Re-deriving
        // its colour from scratch here was the source of the banding: the extra
        // terrainFbm lookup sampled the same 1 m noise at a few centimetres of
        // offset, so the pattern repeated as stripes.
        // Instead, nudge the already-lit ground colour slightly by the refraction
        // vector. A shallow film barely displaces anything, which is exactly
        // what a 5-14 cm puddle should look like.
        vec2 refrOffset = refrDir.xz * depth;
        // Very fine wobble so the refracted view is not a perfect copy: this is
        // water distorting light, not a second copy of the terrain.
        float wobble = terrainFbm(pxz * 11.0 + vec2(uTime * 0.08, uTime * 0.05));
        vec3 underCol = col * (0.92 + 0.08 * wobble);

        // Clear water is nearly colourless. Any strong tint here is what turned
        // the puddles into dark green discs - a puddle is a thin film, not a
        // pond, so it must not paint the ground.
        vec3 waterTint = vec3(0.020, 0.030, 0.034);
        // Beer's law, but gentle: at 5-15 cm the ground is still fully readable.
        float visibility = exp(-depth * 3.2);
        underCol = mix(waterTint, underCol, visibility);

        // Ground seen through water is darkened a little but keeps its colour.
        // 0.72 → 0.86：地面基色本来就偏暗，再压 28% 积水就成了发黑的坑。
        // 浅积水只是让地面稍微沉一点，不该把泥土颜色吃掉。
        underCol *= 0.86 * (vec3(1.0) - waterTint * 0.5);

        // Fresnel picks between ground and sky. The 0.18 floor keeps a constant
        // sheen on the surface (that is what reads as "wet"), but not so much
        // that a head-on view turns blue - testing the numbers showed a 0.30
        // floor left the puddle cooler than the soil beneath it.
        // 反射上下限各抬一档（0.18→0.26, 0.78→0.88）：白天积水本来就该明显反天光，
        // 原来那组值在暗地面上几乎看不出"有水"。
        float reflMix = mix(0.26, 0.88, fresnel);
        vec3 waterCol = mix(underCol, skyRefl, reflMix);
        // A faint body tint of the water itself, weighted towards head-on views.
        waterCol += waterTint * 0.15 * (1.0 - fresnel);
        waterCol += spec;
        col = mix(col, waterCol, puddle);
      }
    }

    // Snow settles on flat ground first and blows off steep slopes: reuse the
    // normalised slope "sn" that already drives the gravel blend.
    float snow = clamp(uSnowCover, 0.0, 1.0);
    if (snow > 0.001) {
      float holdsSnow = 1.0 - smoothstep(0.55, 1.20, sn);   // steep ground sheds it
      float patchy = 0.7 + 0.3 * (terrainFbm(xz * 2.3) * 0.5 + 0.5);
      float amount = clamp(snow * holdsSnow * patchy * 1.4, 0.0, 1.0);
      // flat white that still takes the sky colour so it sits in the scene
      vec3 snowGround = vec3(0.90, 0.93, 0.97) * (0.55 + 0.45 * sunLit);
      col = mix(col, snowGround, amount);
    }

    float dist = length(uCamPos - vWorld);
    // 与 FS_GRASS 同口径：雾从 70m 才起，近处不糊
    float fog = smoothstep(70.0, 190.0, dist);
    fog = clamp(fog + uFog * 0.35, 0.0, 1.0);
    col = mix(col, uHorizon, fog);

    frag = vec4(col, 1.0);
  }`

  const VS_GROUND = `#version 300 es
  precision highp float;
  ${NOISE_GLSL}
  in vec2 aGroundXZ;
  uniform mat4 uViewProj;
  out vec3 vWorld;
  ${GRASS_TERRAIN_GLSL}
  void main() {
    float h = terrainHeight(aGroundXZ);
    vWorld = vec3(aGroundXZ.x, h, aGroundXZ.y);
    gl_Position = uViewProj * vec4(vWorld, 1.0);
  }`

  //  createGrassPass —— 结构照抄 createSunPass：init 失败不影响主链路。
  function createGrassPass() {
    const GROUND_SIZE = 130     // 地面网格覆盖范围（米）。200 会铺满整个下半屏、把海全挡住
    // 地形整体前后平移（米）。固定值 9 —— 把地形从相机脚下往远处退 9 米。
    // 不再做面板滑杆：拖动时会和草的散布位置闹矛盾（地面动了、草没动 → 穿模）。
    // 散布和地面网格都读这个常量，所以两者永远一致。
    const GROUND_PUSH_Z = -9
    const GROUND_SEG  = 96      // 96×96 顶点，坡度看得清又不贵

    // ---- 草的「铺满」参数（按地面密度撒点，不是按距离筛选）----
    // 相机在 (0, 5.5, 17)，地形中心在 z = GROUND_PUSH_Z。
    // 撒点圆盘以「相机正下方那片地面」为中心，所以要把圆盘平移 CAM_Z_OFFSET 才对齐。
    const CAM_Z_OFFSET = 17
    // 铺满半径（米）：这个圆盘内，草的密度处处相同。
    const GRASS_RADIUS = 48
    // 基础密度（撮/平方米）。1.6 撮/㎡ 在 48m 半径里约 11600 撮 ——
    // 就是上一版实测的量；2 倍 = 3.2 撮/㎡ ≈ 23200 撮，作为默认基础值。
    // 基础密度（撮/㎡，乘滑块倍率后生效）。
    // 【为什么是 4.2】每团从 3 片改成 5 片后，三角形从 24/团 涨到 40/团。
    // 要维持上一版用户认可的观感预算（约 600k 三角），草团数就得从 23500 降到 15500。
    // 反推：撒点密度 3.12 撮/㎡ 经生长场过滤后实得约 1.62 撮/㎡（打 0.52 折），
    // 所以要 15500 团 / 48m 圆盘 → 4.2 撮/㎡。
    const BASE_DENSITY = 4.2
    // 候选上限：防止极端密度把显存/CPU 拖死。到顶就等比例降实际密度。
    const GRASS_MAX = 260000

    // 碎石坡阈值：坡度超过它就露土、不种草。
    // 0.083 是按本地形坡度分布实测标定的（均值 0.047 / P90 0.079 / 最大 0.147），
    // 落在 P92 —— 约 8% 面积是碎石坡，看起来是「坎」，不是「满地图土」。
    // ⚠️ 不是资料 1 里的 0.6：那是 40m 级陡崖的尺度，套到这个 4m 起伏地形上等于永不生效。
    const SLOPE_MAX = 0.083

    const P = { enabled: true, density: 1.0 }

    let pGrass = null, pGround = null
    let U_GRASS = {}, U_GROUND = {}
    let grassVao = null, grassVbo = null, grassIbo = null, instVbo = null
    let groundVao = null, groundVbo = null, groundIbo = null
    let instCount = 0    // 当前绘制的草团数
    let grassIndexCount = 0   // 单团索引数，build() 里按真实几何写入（不要写死）
    let initOk = false
    // 每实例数据缓存：建一次，之后只改「怎么画」
    let allInst = null
    let lastDensity = -1

    // 密度滑块直接决定撒点密度，见 buildInstances 里的 scale 计算。

    // 线性插值小工具（buildClump 里用来算叶片锥度）
    const mixNum = (a, b, t) => a + (b - a) * Math.max(0, Math.min(1, t))

    // ---- 六片扇开的草团（Vault 80 坑 1.）----
    // 两片近垂直交叉 + 四片向外倾 26°，绕茎间隔 45°。
    // 只有两片交叉时从上方看是十字架；扇开之后是一个圆的「毛团」。
    function buildClump() {
      const pos = [], nrm = [], uv = [], idx = []
      const SEGS = 4                       // 每片纵向 4 段：够画出弯曲弧
      // 单片半宽（米）。这是「一簇」与「杂毛」的分界线之一：
      //   0.085 → 宽叶片，像厚塑料片（用户否掉了）
      //   0.030 → 细条，整簇看着是三根杂毛（用户否掉了）
      //   0.048 → 中等：既有叶片感，又不会变成硬纸板
      const CARD_W = 0.048
      const CARD_H = 1.0                   // 归一化高度，实例 aParams.z 再缩放

      // 【一簇的五片叶】
      // 判断「一簇」还是「杂毛」的不是叶片数量，而是叶片是否在空间里散开：
      //   3 片全直立(lean≈0.1) → 叠在一起 → 看着是 3 根线（杂毛）
      //   6 片有 4 片外张 26°  → 散成放射状 → 看着像多肉
      // 取中间：5 片 + 适度外张(lean 0.10~0.34) —— 叶片彼此错开，
      // 正视图读起来是「一丛」而不是「几根」或「一圈」。
      const cards = [
        { yaw: 0.000, lean: 0.10 },        // 直立 1
        { yaw: 0.628, lean: 0.22 },        // 36°  外张
        { yaw: 1.257, lean: 0.10 },        // 72°  直立 2
        { yaw: 1.885, lean: 0.30 },        // 108° 外张
        { yaw: 2.513, lean: 0.18 },        // 144° 微张
      ]

      for (const card of cards) {
        const base = pos.length / 3
        const cy = Math.cos(card.yaw), sy = Math.sin(card.yaw)
        const cl = Math.cos(card.lean), sl = Math.sin(card.lean)
        for (let s = 0; s <= SEGS; s++) {
          const t = s / SEGS
          // 宽度：只在最上 1/4 快速收尖，下面保持窄条 —— 这是「草叶」而不是「三角」。
          // 旧版 (1 - t*0.94) 是从根就开始收，等于画了个三角形。
          const taper = t < 0.75 ? mixNum(1.0, 0.55, t / 0.75) : mixNum(0.55, 0.0, (t - 0.75) / 0.25)
          const w = CARD_W * taper
          // 弯曲：脊柱按 t² 向前弯，所以叶子是「弓」形，不是斜出去的直杆。
          // 弯的方向沿卡片自己的朝向（sy/cy），和 lean 叠加。
          const bendX = sl * t * CARD_H
          const arc = 0.34 * t * t        // 弓形弯曲量（归一化高度）
          for (const side of [-1, 1]) {
            const lx = side * w
            // ⚠️ z 必须是真正的横向坐标，不能塞 strip 编号。
            // 之前为了让顶点着色器区分「草/花的杆/花盘」，这里曾把 z 写成 stripId，
            // 结果所有草叶的 z 被压成 0..4 的常量 —— 草被拍扁成一片，
            // 视觉上就是「杂毛」。花现在是独立 Pass，这个通道不再需要。
            pos.push(
              lx * cy + (bendX + arc) * sy,
              t * cl * CARD_H * (1.0 - arc * 0.35),   // 弯得越多，竖直投影越短
              -lx * sy + (bendX + arc) * cy
            )
            nrm.push(0.0, 1.0, 0.0)                   // dome normal：预置朝上
            uv.push(side > 0 ? 1.0 : 0.0, t)
          }
        }
        for (let s = 0; s < SEGS; s++) {
          const a = base + s * 2, b = a + 1, c = a + 2, d = a + 3
          idx.push(a, b, c, b, d, c)
        }
      }
      return {
        pos: new Float32Array(pos),
        nrm: new Float32Array(nrm),
        uv: new Float32Array(uv),
        idx: new Uint16Array(idx),
      }
    }

    // ---- JS 侧的地形采样：必须和 GLSL 逐系数一致，否则草浮空或埋土 ----
    function jsHash2(px, pz) {
      const qx = px - Math.floor(px / 289) * 289
      const qz = pz - Math.floor(pz / 289) * 289
      const ax = Math.sin(qx * 127.1 + qz * 311.7) * 43758.5453
      const az = Math.sin(qx * 269.5 + qz * 183.3) * 43758.5453
      return [(ax - Math.floor(ax)) * 2 - 1, (az - Math.floor(az)) * 2 - 1]
    }
    function jsGnoise(px, pz) {
      const ix = Math.floor(px), iz = Math.floor(pz)
      const fx = px - ix, fz = pz - iz
      const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10)
      const uz = fz * fz * fz * (fz * (fz * 6 - 15) + 10)
      const h00 = jsHash2(ix, iz), h10 = jsHash2(ix + 1, iz)
      const h01 = jsHash2(ix, iz + 1), h11 = jsHash2(ix + 1, iz + 1)
      const n00 = h00[0] * fx + h00[1] * fz
      const n10 = h10[0] * (fx - 1) + h10[1] * fz
      const n01 = h01[0] * fx + h01[1] * (fz - 1)
      const n11 = h11[0] * (fx - 1) + h11[1] * (fz - 1)
      const a = n00 + (n10 - n00) * ux
      const b = n01 + (n11 - n01) * ux
      return a + (b - a) * uz
    }
    function jsTerrainFbm(px, pz) {
      return jsGnoise(px, pz) + jsGnoise(px * 2.13 + 31.7, pz * 2.13 + 12.9) * 0.5
    }
    function jsTerrainHeight(x, z) {
      // ⚠️ 必须和 GRASS_TERRAIN_GLSL 的 terrainHeight 逐系数一致
      const h = jsTerrainFbm(x * 0.010, z * 0.010) * 6.0
              + jsTerrainFbm(x * 0.045 + 7.3, z * 0.045 + 19.1) * 1.20
              + jsGnoise(x * 0.140 + 3.7, z * 0.140 + 11.3) * 0.42
      return h * 0.55 + 2.20
    }
    function jsTerrainSlope(x, z) {
      const e = 0.5
      const hx = jsTerrainHeight(x + e, z) - jsTerrainHeight(x - e, z)
      const hz = jsTerrainHeight(x, z + e) - jsTerrainHeight(x, z - e)
      return Math.min(1, Math.hypot(hx, hz) / (2 * e))
    }
    function jsGrowth(x, z) {
      return Math.max(0, Math.min(1,
        jsGnoise(x * 0.021 + 5.1, z * 0.021 + 2.7) * 0.5 + 0.5
        + jsGnoise(x * 0.071 + 13.3, z * 0.071 + 8.9) * 0.25))
    }

    // ---- 散布：按「地面密度」撒满，不是按距离筛选 ----

    // 【为什么改】旧做法是「撒固定 88000 个候选 → 按 dist<=48m 筛」，
    // 结果近处稀、远处密：因为 48m 圆盘占方阵 51%，筛选后近处的绝对数量没变多。
    // 视觉上就是「草往远处长」，而不是「在地上铺满一层」。

    // 新做法：给定「每平方米长几撮草」，在可见地面圆盘里撒满。
    // 这样密度在近处和远处是同一个值 —— 肉眼看到的是一层均匀的草，
    // 不是从脚下向远处越来越密的放射状。

    // 【数量由面积决定】圆盘半径 = GRASS_RADIUS，面积 πr²。
    //   密度 1.6 撮/㎡ → 48m 半径约 11600 撮
    //   密度 3.2 撮/㎡ → 48m 半径约 23200 撮
    // 上限 GRASS_MAX 防止极端参数炸掉显存；到顶就等比例降低实际密度。
    function buildInstances() {
      const out = []
      // 采样半径 = 铺满半径。按面积算候选数，再按密度过滤。
      const R = GRASS_RADIUS
      const area = Math.PI * R * R
      // 密度倍率：滑块 0→0.15 倍，50→1.0 倍（基础值），100→1.8 倍。
      const scale = 0.15 + Math.max(0, Math.min(1, P.density)) * 1.65
      const density = BASE_DENSITY * scale
      // 候选数 = 目标密度 × 面积。多撒 35% 作为被坡度/生长过滤掉后的余量。
      const candidates = Math.min(GRASS_MAX, Math.ceil(area * density * 1.35))
      for (let i = 0; i < candidates; i++) {
        // 圆盘均匀撒点（不能用方形，否则角落会堆）
        const ang = Math.random() * Math.PI * 2
        const rad = Math.sqrt(Math.random()) * R
        const x = Math.cos(ang) * rad
        const z = Math.sin(ang) * rad + GROUND_PUSH_Z + CAM_Z_OFFSET
        // 坡度过滤：陡坎不长草，但阈值放宽（原来 SLOPE_MAX，现在 ×1.5）——
        // 只有真正的陡坎才露石，其余全都长草。
        const slope = jsTerrainSlope(x, z)
        if (slope > SLOPE_MAX * 1.5) continue

        // 【灭秃斑】生长场只用来看「哪里更茂盛」，不再用来决定「哪里不长」。
        // 旧版两道过滤（growth<0.02 全砍、random > 0.2+growth*0.8）叠起来，
        // 生长场低谷处几乎全秃 —— 就是用户说的「斑秃」。
        // 新版：保底通过率 0.72，茂盛处升到 1.0。最秃的地方也有七成草，
        //       视觉上是一片连续草地，只有疏密差，没有空洞。
        const growth = jsGrowth(x, z)
        const passRate = 0.72 + growth * 0.28
        if (Math.random() > passRate) continue

        // 【这一版只有草】花和石头的类型判定先关掉。
        // 原因：aKind 那套「一套几何两种形态」会把草也弄坏（草变成交叉乱线）。
        // 花将改成独立 draw call 重做；在那之前，这里只产出纯草实例。
        const kind = 0

        out.push({
          x, y: jsTerrainHeight(x, z), z,
          // 每团随机：朝向、横向胖瘦、高度、风相位、色调明暗。
          // 旧版这些随机量幅度太小（xs 0.8~1.4、hs 基准相同），
          // 加上几何是固定模板，看到的就是「同一撮草复制了 N 次」。
          yaw: Math.random() * Math.PI * 2,
          xs: 0.62 + Math.random() * 0.80,                       // 胖瘦差 1.3 倍
          hs: (0.34 + growth * 0.62) * (0.55 + Math.random() * 0.95),  // 高矮差 1.7 倍
          phase: Math.random() * Math.PI * 2,
          patch: growth,
          bright: Math.random(),                                  // 明暗抖动
          kind,                                                    // 0 草 / 1 花 / 2 石头
          dist: Math.hypot(x, z - 17),
        })
      }

      return out
    }

    // 按距离筛出当前 LOD 集合，写进实例缓冲
    // maxDist：画到多远；keepRatio：在范围内保留多少比例（0..1）
    // 把实例写进 GPU。
    // 不再按距离筛选 —— 草是「铺满一层」，所有实例都要画。
    // 密度滑块已经在上游（buildInstances）决定了撒多少点，这里只负责上传。
    function uploadInstances() {
      if (!allInst) return
      const n = allInst.length
      if (n === 0) { instCount = 0; return }
      const data = new Float32Array(n * 10)
      for (let i = 0; i < n; i++) {
        const inst = allInst[i]
        const o = i * 10
        data[o] = inst.x;     data[o + 1] = inst.y;     data[o + 2] = inst.z
        data[o + 3] = inst.yaw; data[o + 4] = inst.xs
        data[o + 5] = inst.hs;  data[o + 6] = inst.phase
        data[o + 7] = inst.patch; data[o + 8] = inst.bright
        data[o + 9] = inst.kind || 0
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, instVbo)
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW)
      gl.bindBuffer(gl.ARRAY_BUFFER, null)
      instCount = n
    }

    function build() {
      pGrass = link(sh(gl.VERTEX_SHADER, VS_GRASS), sh(gl.FRAGMENT_SHADER, FS_GRASS))
      pGround = link(sh(gl.VERTEX_SHADER, VS_GROUND), sh(gl.FRAGMENT_SHADER, FS_GROUND))
      if (!pGrass || !pGround) {
        console.error('[OPEN SEA SKIN] grass shader failed, grass disabled')
        return false
      }

      U_GRASS = {}
      for (const k of ['uViewProj','uCamPos','uTime','uWind','uWindSpeed','uPressure',
                       'uSunDir','uSunColor','uHorizon','uZenith','uCloudMask','uCloudShadow','uFog',
                       'uAlphaBase',
                       // 光模块直连的五个量
                       'uMoonDir','uMoonColor','uSunScale','uMoonScale','uLightGlobal',
                       // 撒点半径（边缘渐隐用）
                       'uGrassRadius',
                       // 天气联动：积雪量 / 湿润度
                       'uSnowCover','uWetness']) {
        U_GRASS[k] = gl.getUniformLocation(pGrass, k)
      }
      U_GROUND = {}
      for (const k of ['uViewProj','uCamPos','uSunDir','uSunColor','uHorizon','uZenith',
                       'uCloudMask','uCloudShadow','uFog','uSlopeMax',
                       'uSnowCover','uWetness',
                       // 光模块：积水的高光要跟草、海用同一份太阳/月亮
                       'uMoonDir','uMoonColor','uSunScale','uMoonScale','uLightGlobal',
                       // 积水的涟漪随时间漂移
                       'uTime',
                       ]) U_GROUND[k] = gl.getUniformLocation(pGround, k)

      // ---- 草：几何 + 实例 ----
      const clump = buildClump()
      grassVao = gl.createVertexArray()
      gl.bindVertexArray(grassVao)

      grassVbo = gl.createBuffer()
      gl.bindBuffer(gl.ARRAY_BUFFER, grassVbo)
      gl.bufferData(gl.ARRAY_BUFFER, clump.pos, gl.STATIC_DRAW)
      const aPos = gl.getAttribLocation(pGrass, 'aPos')
      gl.enableVertexAttribArray(aPos)
      gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0)
      gl.vertexAttribDivisor(aPos, 0)

      const nrmVbo = gl.createBuffer()
      gl.bindBuffer(gl.ARRAY_BUFFER, nrmVbo)
      gl.bufferData(gl.ARRAY_BUFFER, clump.nrm, gl.STATIC_DRAW)
      const aNormal = gl.getAttribLocation(pGrass, 'aNormal')
      gl.enableVertexAttribArray(aNormal)
      gl.vertexAttribPointer(aNormal, 3, gl.FLOAT, false, 0, 0)
      gl.vertexAttribDivisor(aNormal, 0)

      const uvVbo = gl.createBuffer()
      gl.bindBuffer(gl.ARRAY_BUFFER, uvVbo)
      gl.bufferData(gl.ARRAY_BUFFER, clump.uv, gl.STATIC_DRAW)
      const aUV = gl.getAttribLocation(pGrass, 'aUV')
      gl.enableVertexAttribArray(aUV)
      gl.vertexAttribPointer(aUV, 2, gl.FLOAT, false, 0, 0)
      gl.vertexAttribDivisor(aUV, 0)

      grassIbo = gl.createBuffer()
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, grassIbo)
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, clump.idx, gl.STATIC_DRAW)

      // 实例属性：每实例 9 个 float = aOffset(3) + aParams(4) + aVar(2)
      instVbo = gl.createBuffer()
      gl.bindBuffer(gl.ARRAY_BUFFER, instVbo)
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(GRASS_MAX * 10), gl.DYNAMIC_DRAW)
      const stride = 10 * 4
      const aOffset = gl.getAttribLocation(pGrass, 'aOffset')
      gl.enableVertexAttribArray(aOffset)
      gl.vertexAttribPointer(aOffset, 3, gl.FLOAT, false, stride, 0)
      gl.vertexAttribDivisor(aOffset, 1)
      const aParams = gl.getAttribLocation(pGrass, 'aParams')
      gl.enableVertexAttribArray(aParams)
      gl.vertexAttribPointer(aParams, 4, gl.FLOAT, false, stride, 12)
      gl.vertexAttribDivisor(aParams, 1)
      const aVar = gl.getAttribLocation(pGrass, 'aVar')
      gl.enableVertexAttribArray(aVar)
      gl.vertexAttribPointer(aVar, 2, gl.FLOAT, false, stride, 28)
      gl.vertexAttribDivisor(aVar, 1)
      // 类型属性（aKind）。
      // ⚠️ 必须判 -1：着色器没用到这个属性时，编译器可能把它优化掉，
      // getAttribLocation 返回 -1，而 enableVertexAttribArray(-1) 会抛
      // GL_INVALID_VALUE —— 那个错误会被下游 sunPass 的 gl.getError() 读到，
      // 误判成 bindFb 失败，于是光柱每帧被跳过，画面一闪一闪。
      const aKind = gl.getAttribLocation(pGrass, 'aKind')
      if (aKind >= 0) {
        gl.enableVertexAttribArray(aKind)
        gl.vertexAttribPointer(aKind, 1, gl.FLOAT, false, stride, 36)
        gl.vertexAttribDivisor(aKind, 1)
      }

      gl.bindVertexArray(null)

      // ---- 地面网格 ----
      const gv = new Float32Array((GROUND_SEG + 1) * (GROUND_SEG + 1) * 2)
      let gi = 0
      for (let z = 0; z <= GROUND_SEG; z++) {
        for (let x = 0; x <= GROUND_SEG; x++) {
          gv[gi++] = (x / GROUND_SEG - 0.5) * GROUND_SIZE
          gv[gi++] = (z / GROUND_SEG - 0.5) * GROUND_SIZE + GROUND_PUSH_Z
        }
      }
      const gidx = new Uint32Array(GROUND_SEG * GROUND_SEG * 6)
      let gk = 0
      for (let z = 0; z < GROUND_SEG; z++) {
        for (let x = 0; x < GROUND_SEG; x++) {
          const a = z * (GROUND_SEG + 1) + x, b = a + 1
          const c = a + (GROUND_SEG + 1), d = c + 1
          gidx[gk++] = a; gidx[gk++] = b; gidx[gk++] = c
          gidx[gk++] = b; gidx[gk++] = d; gidx[gk++] = c
        }
      }
      groundVao = gl.createVertexArray()
      gl.bindVertexArray(groundVao)
      groundVbo = gl.createBuffer()
      gl.bindBuffer(gl.ARRAY_BUFFER, groundVbo)
      gl.bufferData(gl.ARRAY_BUFFER, gv, gl.STATIC_DRAW)
      const aGroundXZ = gl.getAttribLocation(pGround, 'aGroundXZ')
      gl.enableVertexAttribArray(aGroundXZ)
      gl.vertexAttribPointer(aGroundXZ, 2, gl.FLOAT, false, 0, 0)
      groundIbo = gl.createBuffer()
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, groundIbo)
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, gidx, gl.STATIC_DRAW)
      gl.bindVertexArray(null)

      // 索引数从真实几何里取，不写死 —— 改 SEGS 或卡片数时不会错位
      grassIndexCount = clump.idx.length

      allInst = buildInstances()
      uploadInstances()
      lastDensity = P.density

      console.info('[OPEN SEA SKIN] grass ok, instances=' + instCount)
      return true
    }

    return {
      init() { initOk = build(); return initOk },
      get enabled() { return initOk && P.enabled },
      get params() { return { ...P, instances: instCount } },
      set params(next) {
        if (!next || typeof next !== 'object') return
        if (typeof next.enabled === 'boolean') P.enabled = next.enabled
        if (Number.isFinite(next.density)) P.density = Math.max(0, Math.min(1, next.density))
      },
      // input: { env, cam, wind, windSpeed, pressure, cloudMask, fog }
      draw(input, rtFb) {
        if (!initOk || !P.enabled) return
        if (!input || !input.env || !input.cam) return

        const env = input.env
        const cam = input.cam
        const fogAmt = Number.isFinite(input.fog) ? Math.max(0, Math.min(1, input.fog)) : 0
        // 云影漂移速率，与天空云同一条风速曲线
        const wsHere = Number.isFinite(input.windSpeed) ? Math.max(0, Math.min(1, input.windSpeed)) : 0.5
        const cloudDrift = 0.002 + Math.pow(wsHere, 1.6) * 0.2331
        const cloudMask = Number.isFinite(input.cloudMask) ? input.cloudMask : 0
        const wind = input.wind || [0, 0]
        const windSpeed = Number.isFinite(input.windSpeed) ? input.windSpeed : 0.5
        const pressure = Number.isFinite(input.pressure) ? input.pressure : 0.6
        // 光模块参数（同一帧、同一份，草和地面共用）。
        // 必须在这里声明：地面网格的 uniform 赋值排在草的赋值之前，
        // 如果只在草那一段声明 L，地面先用到就会抛
        // ReferenceError: Cannot access 'L' before initialization（实测）。
        const L = (input && input.light) || {}

        gl.bindFramebuffer(gl.FRAMEBUFFER, rtFb == null ? null : rtFb)
        gl.viewport(0, 0, W, H)
        gl.enable(gl.DEPTH_TEST)
        gl.depthFunc(gl.LEQUAL)
        gl.enable(gl.CULL_FACE)
        gl.cullFace(gl.BACK)

        // ---- 1. 地面底色层：草稀疏处露出的泥土碎石 ----
        gl.useProgram(pGround)
        gl.uniformMatrix4fv(U_GROUND.uViewProj, false, cam.viewProj)
        gl.uniform3fv(U_GROUND.uCamPos, cam.eye)
        gl.uniform3fv(U_GROUND.uSunDir, env.sunDir)
        gl.uniform3fv(U_GROUND.uSunColor, env.sunColor)
        gl.uniform3fv(U_GROUND.uHorizon, env.horizon)
        gl.uniform3fv(U_GROUND.uZenith, env.zenith)
        gl.uniform1f(U_GROUND.uCloudMask, cloudMask)
        gl.uniform3f(U_GROUND.uCloudShadow,
          Number.isFinite(wind[0]) ? wind[0] : 0,
          Number.isFinite(wind[1]) ? wind[1] : 0,
          cloudDrift)
        gl.uniform1f(U_GROUND.uFog, fogAmt)
        gl.uniform1f(U_GROUND.uSlopeMax, SLOPE_MAX)
        gl.uniform1f(U_GROUND.uSnowCover, weatherSnow)
        gl.uniform1f(U_GROUND.uWetness, weatherWet)
        // 光模块：积水的太阳/月亮高光，和草读同一份参数
        gl.uniform3fv(U_GROUND.uMoonDir, L.moonDir || [0, 1, 0])
        gl.uniform3fv(U_GROUND.uMoonColor, L.moonColor || [0, 0, 0])
        gl.uniform1f(U_GROUND.uSunScale, Number.isFinite(L.sunScale) ? L.sunScale : 1)
        gl.uniform1f(U_GROUND.uMoonScale, Number.isFinite(L.moonScale) ? L.moonScale : 1)
        gl.uniform1f(U_GROUND.uLightGlobal, Number.isFinite(L.global) ? L.global : 1)
        // 积水涟漪的时间轴，和海洋用同一个 elapsed
        gl.uniform1f(U_GROUND.uTime, elapsed)
        gl.bindVertexArray(groundVao)
        gl.drawElements(gl.TRIANGLES, GROUND_SEG * GROUND_SEG * 6, gl.UNSIGNED_INT, 0)

        // ---- 2. 草：双面，不能背面剔除 ----
        gl.disable(gl.CULL_FACE)
        gl.useProgram(pGrass)
        gl.uniformMatrix4fv(U_GRASS.uViewProj, false, cam.viewProj)
        gl.uniform3fv(U_GRASS.uCamPos, cam.eye)
        gl.uniform1f(U_GRASS.uTime, elapsed)
        gl.uniform2f(U_GRASS.uWind, wind[0], wind[1])
        gl.uniform1f(U_GRASS.uWindSpeed, windSpeed)
        gl.uniform1f(U_GRASS.uPressure, pressure)
        gl.uniform3fv(U_GRASS.uSunDir, env.sunDir)
        gl.uniform3fv(U_GRASS.uSunColor, env.sunColor)
        gl.uniform3fv(U_GRASS.uHorizon, env.horizon)
        gl.uniform3fv(U_GRASS.uZenith, env.zenith)
        gl.uniform1f(U_GRASS.uCloudMask, cloudMask)
        gl.uniform3f(U_GRASS.uCloudShadow,
          Number.isFinite(wind[0]) ? wind[0] : 0,
          Number.isFinite(wind[1]) ? wind[1] : 0,
          cloudDrift)
        gl.uniform1f(U_GRASS.uFog, fogAmt)
        gl.uniform1f(U_GRASS.uAlphaBase, 0.30)

        // ---- 光模块直连 ----
        // 草不自己决定亮度：面板拖「太阳亮度 / 月亮亮度 / 光效开关」，草立刻跟着变。
        // light 由 drawScene 从 sunPass.params 取来（同一帧、同一份参数，不会错拍）。
        // L 在本函数开头已声明（草和地面共用同一份）。
        gl.uniform3fv(U_GRASS.uMoonDir, L.moonDir || [0, 1, 0])
        gl.uniform3fv(U_GRASS.uMoonColor, L.moonColor || [0, 0, 0])
        gl.uniform1f(U_GRASS.uSunScale, Number.isFinite(L.sunScale) ? L.sunScale : 1)
        gl.uniform1f(U_GRASS.uMoonScale, Number.isFinite(L.moonScale) ? L.moonScale : 1)
        gl.uniform1f(U_GRASS.uLightGlobal, Number.isFinite(L.global) ? L.global : 1)
        gl.uniform1f(U_GRASS.uGrassRadius, GRASS_RADIUS)
        // 天气联动：客户端推来的积雪量 / 湿润度
        gl.uniform1f(U_GRASS.uSnowCover, weatherSnow)
        gl.uniform1f(U_GRASS.uWetness, weatherWet)

        // 密度变了：重新撒点（草是铺满一层，密度变了就是地上草的疏密变了）
        if (Math.abs(P.density - lastDensity) > 0.01) {
          lastDensity = P.density
          allInst = buildInstances()
          uploadInstances()
        }

        if (instCount > 0 && grassIndexCount > 0) {
          gl.bindVertexArray(grassVao)
          gl.drawElementsInstanced(gl.TRIANGLES, grassIndexCount, gl.UNSIGNED_SHORT, 0, instCount)
        }

        gl.bindVertexArray(null)
        gl.disable(gl.DEPTH_TEST)
        gl.enable(gl.CULL_FACE)
        // 还原成 drawScene 期望的末态：BLEND 关
        gl.disable(gl.BLEND)

        // 【隔离】清掉本 Pass 可能留下的 GL 错误，不让它污染下游。
        // 背景：gl.getError() 返回并清空「最近一个」错误。草地里任何一个失效的
        // 调用（比如属性位置为 -1 时的 enableVertexAttribArray）都会让下一帧
        // sunPass 里的 glError('bindFb') 误报，进而跳过光柱 —— 表现就是画面闪烁。
        // 光柱的检查逻辑不该为别人的错误买单，所以在这里清一次。
        gl.getError()
      },
      dispose() {
        for (const p of [pGrass, pGround]) { try { if (p) gl.deleteProgram(p) } catch (e) {} }
        for (const b of [grassVbo, instVbo, groundVbo]) { try { if (b) gl.deleteBuffer(b) } catch (e) {} }
        for (const b of [grassIbo, groundIbo]) { try { if (b) gl.deleteBuffer(b) } catch (e) {} }
        for (const v of [grassVao, groundVao]) { try { if (v) gl.deleteVertexArray(v) } catch (e) {} }
        pGrass = pGround = null
        initOk = false
      },
    }
  }

  //  花 · 独立 Pass
  //  【为什么独立】花和草共用几何那套做法失败过两次，每次都把草也弄坏
  //  （草变成交叉乱线）。从此花有自己的一套 GL 资源、自己的着色器、自己的
  //  draw call；它读草用过的地形/生长场采样函数（只读），但从不碰草的
  //  VAO / program / uniform。花挂了，草照常。

  //  几何（每朵花 4 顶点 × 2 三角 = 一张方片，外加一条 2 三角的细杆）：
  //    花盘：方片，形状全部由片元着色器的极坐标花瓣画出来
  //          （Book of Shaders 标准做法：半径上限随角度正弦起伏）
  //    细杆：一条极窄的竖直条，连接地面和花盘

  //  规模：约 1500 朵，铺在 48m 圆盘里 —— 一撮一撮的花最自然，
  //  铺满反而假（真实花田也是成片成片地开）。

  const VS_FLOWER = `#version 300 es
  precision highp float;

  // :x [-1,1] ,y [0,1] (0 = ,1 = )
  in vec2  aQuad;
  in float aPart;       // 0 = , 1 =

  in vec3  aOrigin;     //
  in vec4  aParams;     // x= , y= , z= , w=
  in float aSeed;       // /

  uniform mat4  uViewProj;
  uniform float uTime;
  uniform vec2  uWind;
  uniform float uWindSpeed;

  out vec2  vQuad;
  out vec3  vWorld;
  out float vPart;
  out float vSeed;

  void main() {
    vQuad = aQuad;
    vPart = aPart;
    vSeed = aSeed;

    float headY = aParams.z;
    float r = aParams.y;

    vec3 local;
    if (aPart < 0.5) {
      // : , , 2r(aQuad [-1,1] )
      local = vec3(aQuad.x * r, headY + aQuad.y * r, 0.0);
    } else {
      // : 8mm, (0) (headY)
      // aQuad.y [0,1]
      float hy = aQuad.y * 0.5 + 0.5;      // 0..1
      local = vec3(aQuad.x * 0.006, headY * hy, 0.0);
    }

    float gust = 0.62 + 0.38 * sin(uTime * 0.34 + aSeed * 6.28318);
    // 与 VS_GRASS 【完全同一套】波长与扫速，花和草被同一道波前推着走。
    // 参数必须和 VS_GRASS 的 WAVE_K / WAVE_W 一致，否则花和草波浪错开、看着打架。
    vec2 wdir = normalize(uWind + vec2(0.0001));
    float windDist = dot(aOrigin.xz, wdir);
    float wavePhase = windDist * 0.52 - uTime * 2.40;
    // 随机相位必须和 VS_GRASS 用同一个很小的系数（0.03），
    // 否则花草的波前会错开、看着打架。原因见 VS_GRASS 里 PHASE_JITTER 那段。
    float phase = wavePhase + aParams.w * 0.03;
    // 时间同样只出现在 wavePhase 里（原因见 VS_GRASS 的注释）。
    // 第二项用相位倍频，制造花瓣的高频抖动，但不再引入独立的时间推进。
    float swayRaw = sin(phase) + sin(phase * 2.3 + 1.7) * 0.30;
    // 【风只能往一个方向吹】
    // swayRaw 的值域是 -1.3~+1.3，直接乘 wdir 会让花【先往风向摆、再往反方向摆】，
    // 相邻的花相位又不同，看上去就是「往左往右都有，很乱」。
    // 真实的风：始终朝风向推，变的只是力度（阵风大 / 间歇小），从不反向。
    // 所以把振荡折成单边，再抬一个底：任何时刻都朝风向倾，只是倾多倾少的区别。
    //   0.55 底 + 0.45 摆动（与 VS_GRASS 的 low 同一套）→ 谷底也不直立
    float sway = 0.55 + 0.45 * (swayRaw * 0.5 + 0.5);
    float hNorm = local.y / max(headY, 0.001);
    // 【花摆得太小 —— 实测只有草的 1/4】
    // 旧公式：amp = uWindSpeed * z * 0.22 * gust * hNorm² * 2.5
    //   · 0.22 的基准比草的 ~0.18 还小
    //   · 再叠 hNorm²：花头才满幅，中段只剩 25%
    //   结果 0.4m 的花只弯 5cm（13% 花高），而 0.5m 的草弯 16cm（32%）
    // 现在：基准 0.22 → 0.20，hNorm² → hNorm^0.9（接近线性），
    //       再跟上草的新倍率 3.2（原来是 2.5）。
    //   「实时都在伏」的观感要求花也始终朝风向倾，这里底数够大就不会看起来僵。
    float amp = uWindSpeed * aParams.z * 0.20 * gust * pow(hNorm, 0.9) * 3.2;
    // 与草同一处理：阵风包络恒在 0.62~1.0，永远压着，不再归零
    amp *= 0.62 + 0.38 * sin(wavePhase) * (0.40 + 0.60 * uWindSpeed);
    local.xz += wdir * sway * amp;

    float ca = cos(aParams.x), sa = sin(aParams.x);
    vec3 world = aOrigin + vec3(local.x * ca + local.z * sa, local.y, -local.x * sa + local.z * ca);

    vWorld = world;
    gl_Position = uViewProj * vec4(world, 1.0);
  }`

  const FS_FLOWER = `#version 300 es
  precision highp float;
  // 片元阶段需要 fbm() 算云影；顶点阶段没有 include NOISE_GLSL，二者是独立翻译单元，
  // 缺这行会报 "'fbm' : no matching overloaded function found"
  ${NOISE_GLSL}

  in vec2  vQuad;
  in vec3  vWorld;
  in float vPart;
  in float vSeed;

  uniform vec3  uCamPos;
  uniform vec3  uSunDir;
  uniform vec3  uSunColor;
  uniform vec3  uHorizon;
  uniform vec3  uZenith;
  uniform vec3  uMoonColor;
  uniform vec3  uMoonDir;
  uniform float uSunScale;
  uniform float uMoonScale;
  uniform float uLightGlobal;
  uniform float uCloudMask;
  uniform vec3  uCloudShadow;  // cloud shadows (v2-C): [windX, windY, driftRate], same as grass/ground
  uniform float uTime;       // flowers did not need time before; cloud drift does (vertex stage already has one)
  uniform float uFog;

  out vec4 frag;

  // Injected AFTER the uniforms: shadeLight() reads them, so the declaration
  // has to come first. Putting this before them made the whole shader fail
  // with "uSunDir: undeclared identifier".
  ${LIGHT_GLSL}

  void main() {
    vec3 col;

    if (vPart < 0.5) {
      // [-1,1] , (r, a),
      // = + cos( a) -- .
      vec2 p = vQuad * vec2(1.0, 1.0);
      float r = length(p);
      float a = atan(p.y, p.x);
      // 13 petals (real daisies have 13-21). base+amp = 1.00 fills the quad exactly.
      // amp/base = 0.40/0.60 gives a deep notch (ratio 5.0) -> separate petals,
      // not one flat disc. Previous 0.26/0.72 (ratio 2.1) read as a single blob.
      float petals = 13.0;
      float rMax = 0.60 + 0.40 * cos(a * petals);
      // Far flowers: the petal notches are narrower than a pixel past ~20m, so
      // they alias into a white smear. Shrinking the disc instead keeps a small
      // coloured dot - which is what a real flower field looks like at distance.
      float farFade = smoothstep(16.0, 30.0, length(uCamPos - vWorld));
      rMax = mix(rMax, rMax * 0.60, farFade);
      if (r > rMax) discard;

      // Petal ridge: 0 at the petal centre-line, 1 at the notch between petals.
      // Lifts the middle of each petal and darkens the gaps -> reads as volume.
      float lobe = abs(fract(a * petals / 6.2831853 + 0.5) - 0.5) * 2.0;
      float ridge = 1.0 - lobe * lobe;
      // How deep inside the petal we are (0 = rim, 1 = centre) for the core bulge.
      float radial = 1.0 - clamp(r / max(rMax, 0.001), 0.0, 1.0);

      // vSeed 5 -- , , draw call.
      // 40%( , , )
      // 20% / 20% / 12% / 8%
      vec3 petal;
      if      (vSeed < 0.40) petal = vec3(0.97, 0.96, 0.93);   //
      else if (vSeed < 0.60) petal = vec3(0.97, 0.78, 0.84);   //
      else if (vSeed < 0.80) petal = vec3(0.82, 0.72, 0.95);   //
      else if (vSeed < 0.92) petal = vec3(0.98, 0.88, 0.36);   //
      else                   petal = vec3(0.95, 0.52, 0.30);   //
      vec3 core = vec3(0.98, 0.74, 0.14);
      col = mix(core, petal, smoothstep(0.22, 0.34, r));
      // sunflower: seed 0.93~0.99 (only the patch added in buildFlowers).
      // Big dark disk + golden petals. Normal daisies use seed<0.92.
      float sunflower = step(0.925, vSeed) * step(vSeed, 0.995);
      if (sunflower > 0.5) {
        col = mix(vec3(0.16, 0.11, 0.05), vec3(0.98, 0.80, 0.16), smoothstep(0.46, 0.54, r));
        float seedDots = step(0.0, sin(a * 34.0 + r * 26.0));
        col *= 1.0 - (1.0 - smoothstep(0.30, 0.48, r)) * 0.18 * seedDots;
      }
      // Volume, in two cheap terms:
      //   ridge   -> each petal is lighter along its spine, darker in the notches
      //   radial  -> the disc centre is lifted and its rim falls away (a dome)
      col *= 0.70 + 0.30 * ridge;
      col *= 0.88 + 0.24 * radial;
      // Core: a warm bump rather than a flat dot.
      float bulge = 1.0 - smoothstep(0.0, 0.26, r);
      col = mix(col, core * 1.22, bulge);
      col *= 1.0 - bulge * 0.10;

    } else {
      // Stem. Was 0.072/0.118/0.045 - as dark as a grass root, and a stem is only
      // a few pixels wide so it reads as a black line. Lifted and slightly
      // desaturated so it sits with the foliage instead of vanishing into it.
      col = vec3(0.115, 0.170, 0.072);
    }

    // Normal. Petals are flat and face the sky; a stem is a cylinder, so its
    // normal should lean towards the viewer rather than straight up - otherwise
    // a thin vertical strip ends up catching almost no light and renders black.
    vec3 N = (vPart < 0.5)
      ? normalize(vec3(vQuad.x * 0.5, 1.0, 0.4))
      : normalize(vec3(vQuad.x * 0.7, 0.45, 0.9));

    vec3 sunLight, skyLight;
    vec3 lightSum = shadeLight(N, sunLight, skyLight);
    col *= lightSum;

    vec3 Vf = normalize(uCamPos - vWorld);
    // 花也一样：只有逆光透射会显得死。补一层环绕光，
    // 花瓣薄，透光比叶片更强，所以系数给得比草大。
    float ndlF = dot(N, uSunDir);
    float wrapF = clamp(ndlF * 0.5 + 0.5, 0.0, 1.0);
    float sssWrapF = wrapF * wrapF * 1.8;
    float backF = smoothstep(0.45, 0.95, max(dot(-Vf, uSunDir), 0.0));
    // 花瓣透光偏暖白（不是绿叶的绿），和花瓣本身的颜色相乘才不会变成一团绿
    vec3 petalThrough = col * vec3(1.15, 1.05, 0.85);
    col += (petalThrough * (sssWrapF + backF * 0.55) + col * backF * 0.35) * sunLight;

    // 云影：与草、地面同噪声同相位，整片地表是同一条云影
    float maskN = clamp(uCloudMask, 0.0, 1.0);
    vec2  csP = vWorld.xz * 0.03 + uCloudShadow.xy * uTime * uCloudShadow.z * 0.5;
    float cSh = smoothstep(0.15, 0.55, fbm(csP) * 0.5 + 0.5);
    col *= mix(1.0, 0.74, maskN) * mix(1.0, 0.76, cSh * maskN);

    float dist = length(uCamPos - vWorld);
    col = mix(col, uHorizon, clamp(smoothstep(70.0, 190.0, dist) + uFog * 0.35, 0.0, 1.0));

    frag = vec4(col, 1.0);
  }`

  //  createFlowerPass —— 和 grass 完全独立的 GL 资源
  function createFlowerPass() {
    // 花的数量由「密度」决定，不再是固定值。
    // 密度滑块 0~100：
    //   0%   → 500 朵（零星点缀）
    //   50%  → 6000 朵（默认，成片）
    //   100% → 12000 朵（铺满，约 4.2 朵/㎡）
    // 性能：12000 朵也才 144k 三角形（草是 620k），只是它的 1/4，不是瓶颈。
    const FLOWER_MIN = 500
    const FLOWER_MAX_COUNT = 12000
    const FLOWER_RADIUS = 30.0       // 只在 30m 内开花（远处看不清，省性能）

    // ---- 自带的极简地形采样（只读）----
    // 为什么在这里复制一份，而不是复用 createGrassPass 里的？
    // 因为那些函数定义在 createGrassPass 内部，花拿不到；而把花塞进草的作用域
    // 又会让两者重新耦合 —— 那正是把草弄坏的根源。
    // 这份只有三个函数、只读、系数和 GRASS_TERRAIN_GLSL 一致，用来决定
    // 「花长在哪、长多高」。即使两地数值哪天不同步，最坏也只是花的位置略偏，
    // 不会碰坏草的任何东西。
    const h2 = (px, pz) => {
      const qx = px - Math.floor(px / 289) * 289
      const qz = pz - Math.floor(pz / 289) * 289
      const ax = Math.sin(qx * 127.1 + qz * 311.7) * 43758.5453
      const az = Math.sin(qx * 269.5 + qz * 183.3) * 43758.5453
      return [(ax - Math.floor(ax)) * 2 - 1, (az - Math.floor(az)) * 2 - 1]
    }
    const gn = (px, pz) => {
      const ix = Math.floor(px), iz = Math.floor(pz)
      const fx = px - ix, fz = pz - iz
      const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10)
      const uz = fz * fz * fz * (fz * (fz * 6 - 15) + 10)
      const a = h2(ix, iz), b = h2(ix + 1, iz), c = h2(ix, iz + 1), d = h2(ix + 1, iz + 1)
      const n00 = a[0] * fx + a[1] * fz, n10 = b[0] * (fx - 1) + b[1] * fz
      const n01 = c[0] * fx + c[1] * (fz - 1), n11 = d[0] * (fx - 1) + d[1] * (fz - 1)
      const m0 = n00 + (n10 - n00) * ux, m1 = n01 + (n11 - n01) * ux
      return m0 + (m1 - m0) * uz
    }
    const fbm = (px, pz) => gn(px, pz) + gn(px * 2.13 + 31.7, pz * 2.13 + 12.9) * 0.5
    const terrainH = (x, z) =>
      (fbm(x * 0.010, z * 0.010) * 6.0 + fbm(x * 0.045 + 7.3, z * 0.045 + 19.1) * 1.20
       + gn(x * 0.140 + 3.7, z * 0.140 + 11.3) * 0.42) * 0.55 + 2.20
    const growth = (x, z) => Math.max(0, Math.min(1,
      gn(x * 0.021 + 5.1, z * 0.021 + 2.7) * 0.5 + 0.5
      + gn(x * 0.071 + 13.3, z * 0.071 + 8.9) * 0.25))

    let pFlower = null
    let U = {}
    let vao = null, quadVbo = null, instVbo = null
    let inst = null                  // 花朵实例数据（CPU 侧）
    let ready = false
    const P = { enabled: true, density: 0.5 }   // 默认 50%：和草密度滑块同一档位
    let lastDensity = -1

    function build() {
      pFlower = link(sh(gl.VERTEX_SHADER, VS_FLOWER), sh(gl.FRAGMENT_SHADER, FS_FLOWER))
      if (!pFlower) {
        console.error('[OPEN SEA SKIN] flower shader failed, flowers disabled')
        return false
      }
      for (const k of ['uViewProj','uTime','uWind','uWindSpeed','uCamPos','uSunDir',
                       'uSunColor','uHorizon','uZenith','uMoonColor','uMoonDir','uSunScale',
                       'uMoonScale','uLightGlobal',
                       'uCloudMask','uCloudShadow','uFog']) {
        U[k] = gl.getUniformLocation(pFlower, k)
      }

      // 几何：花盘用 4 顶点方片，细杆用 4 顶点细条 —— 各 2 个三角形
      // 一次 draw 里两种都画：顶点 0-3 是花盘，4-7 是细杆，aPart 区分。
      // 顶点布局：12 个顶点 = 花盘 6（两个三角）+ 细杆 6（两个三角）
      // aQuad 是方片局部坐标：x,y ∈ [-1,1]，花盘和细杆共用同一套方片模板，
      // 由 aPart 在顶点着色器里决定「这是花盘还是杆」，以及各自的尺度和高度。
      const quad = new Float32Array([
        // 花盘（三角形 1）
        -1, -1,   1, -1,   1,  1,
        // 花盘（三角形 2）
        -1, -1,   1,  1,  -1,  1,
        // 细杆（三角形 1）
        -1,  0,   1,  0,   1,  1,
        // 细杆（三角形 2）
        -1,  0,   1,  1,  -1,  1,
      ])
      // aPart：前 6 个顶点是花盘(0)，后 6 个是细杆(1)
      const parts = new Float32Array([0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1])
      vao = gl.createVertexArray()
      gl.bindVertexArray(vao)

      quadVbo = gl.createBuffer()
      gl.bindBuffer(gl.ARRAY_BUFFER, quadVbo)
      gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW)
      const aQuad = gl.getAttribLocation(pFlower, 'aQuad')
      if (aQuad >= 0) {
        gl.enableVertexAttribArray(aQuad)
        gl.vertexAttribPointer(aQuad, 2, gl.FLOAT, false, 0, 0)
      }
      const partVbo = gl.createBuffer()
      gl.bindBuffer(gl.ARRAY_BUFFER, partVbo)
      gl.bufferData(gl.ARRAY_BUFFER, parts, gl.STATIC_DRAW)
      const aPart = gl.getAttribLocation(pFlower, 'aPart')
      if (aPart >= 0) {
        gl.enableVertexAttribArray(aPart)
        gl.vertexAttribPointer(aPart, 1, gl.FLOAT, false, 0, 0)
      }

      // 实例：每朵花 9 个 float（origin3 + params4 + seed1 + 占位1）
      instVbo = gl.createBuffer()
      gl.bindBuffer(gl.ARRAY_BUFFER, instVbo)
      // 缓冲按最大朵数一次分配（6000 × 9 float ≈ 216KB，很小），
      // 之后改密度只是重填这块缓冲，不重建 GL 对象。
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(FLOWER_MAX_COUNT * 9), gl.DYNAMIC_DRAW)
      const stride = 9 * 4
      const aOrigin = gl.getAttribLocation(pFlower, 'aOrigin')
      if (aOrigin >= 0) {
        gl.enableVertexAttribArray(aOrigin)
        gl.vertexAttribPointer(aOrigin, 3, gl.FLOAT, false, stride, 0)
        gl.vertexAttribDivisor(aOrigin, 1)
      }
      const aParams = gl.getAttribLocation(pFlower, 'aParams')
      if (aParams >= 0) {
        gl.enableVertexAttribArray(aParams)
        gl.vertexAttribPointer(aParams, 4, gl.FLOAT, false, stride, 12)
        gl.vertexAttribDivisor(aParams, 1)
      }
      const aSeed = gl.getAttribLocation(pFlower, 'aSeed')
      if (aSeed >= 0) {
        gl.enableVertexAttribArray(aSeed)
        gl.vertexAttribPointer(aSeed, 1, gl.FLOAT, false, stride, 28)
        gl.vertexAttribDivisor(aSeed, 1)
      }
      gl.bindVertexArray(null)

      inst = buildFlowers()
      uploadFlowers()
      lastDensity = P.density     // 记住当前密度，避免第一帧又重建一次
      ready = true
      console.info('[OPEN SEA SKIN] flowers ok, count=' + inst.length)
      return true
    }

    // 按密度决定实际朵数
    function flowerCount() {
      const t = Math.max(0, Math.min(1, P.density))
      return Math.round(FLOWER_MIN + (FLOWER_MAX_COUNT - FLOWER_MIN) * t)
    }

    // 撒花：按面积均匀撒满圆盘（不是先撒近后撒远）。

    // 【为什么要先定坐标、再逐朵建】旧写法是「随机撒点 → 够数就停」，
    // 当候选上限（target×4）先到顶时，远处还没轮到，于是外圈偏稀。
    // 现在拆成两步：1. 先撒 N 个均匀分布的点（半径用 sqrt 保证圆盘均匀），
    // 2. 再按生长场决定每个点开不开花。位置均匀性由第一步保证。
    function buildFlowers() {
      const target = flowerCount()
      const out = []
      // 候选点比目标多 60%，给生长场过滤留余量
      const candidates = Math.ceil(target * 1.6)
      for (let i = 0; i < candidates && out.length < target; i++) {
        const ang = Math.random() * Math.PI * 2
        const rad = Math.sqrt(Math.random()) * FLOWER_RADIUS   // sqrt 保证面积均匀
        const x = Math.cos(ang) * rad
        const z = Math.sin(ang) * rad + groundCenterZ()
        // 开花条件：growth 只看「哪里更旺」，不当硬门槛。
        // 旧版 growth>=0.45 才开花，实测只有 58.6% 的面积达标，
        // 近景（画面右下角）只有 39.2% —— 用户反馈「右下角没有花」。
        // 新版门槛降到 0.30，并用 growth 做疏密调制：旺处多、弱处少，但不整片缺席。
        const g = growth(x, z)
        if (g < 0.30) continue
        if (Math.random() > (g - 0.30) / 0.45 + 0.25) continue
        const h = terrainH(x, z)
        out.push({
          x, y: h, z,
          yaw: Math.random() * Math.PI * 2,
          r: 0.09 + Math.random() * 0.06,             // 花盘半径 9~15cm
          height: 0.55 + Math.random() * 0.45,         // 花高 55~100cm
          phase: Math.random() * Math.PI * 2,
          seed: Math.random(),
        })
      }

      // ---- 向日葵丛：画面左下角那几棵 ----
      // 不新建 Pass、不建缓冲 —— 就是往花的实例数组末尾追加几棵「放大版花」。
      // 花的顶点着色器里，花盘半径 = aParams.y、花高 = aParams.z、
      // 杆宽写死 0.006；所以放大时只要同时把 r 和 height 放大，比例才对。
      // 颜色用 seed >= 0.92 那一档（葵黄）+ 下面 FS 里单独认的 seed 值画黑心。
      // 位置：世界 (x=5.0, z=11.0)，投影到屏幕 x≈9%、y≈80% —— 左下角。
      {
        const PATCH_X = 5.0, PATCH_Z = 11.0, N = 9
        for (let i = 0; i < N; i++) {
          const ang = (i / N) * Math.PI * 2 + Math.random() * 0.5
          const rad = 0.5 + Math.random() * 1.1
          const x = PATCH_X + Math.cos(ang) * rad
          const z = PATCH_Z + Math.sin(ang) * rad
          out.push({
            x, y: terrainH(x, z), z,
            yaw: Math.random() * Math.PI * 2,
            r: 0.30 + Math.random() * 0.10,            // 花盘半径 30~40cm
            height: 2.0 + Math.random() * 0.7,         // 花高 2.0~2.7m
            phase: Math.random() * Math.PI * 2,
            // 0.93~0.99：落进 FS 里「向日葵」那一档，同时比 0.92 高，避开普通黄花
            seed: 0.93 + Math.random() * 0.06,
          })
        }
      }

      return out
    }

    // 花的撒点中心：和草用同一个地面中心
    function groundCenterZ() { return -9 + 17 }

    function uploadFlowers() {
      if (!inst) return
      const n = Math.min(inst.length, FLOWER_MAX_COUNT)
      const data = new Float32Array(n * 9)
      for (let i = 0; i < n; i++) {
        const f = inst[i]
        const o = i * 9
        data[o] = f.x; data[o + 1] = f.y; data[o + 2] = f.z
        data[o + 3] = f.yaw; data[o + 4] = f.r
        data[o + 5] = f.height; data[o + 6] = f.phase
        data[o + 7] = f.seed; data[o + 8] = 0
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, instVbo)
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW)
      gl.bindBuffer(gl.ARRAY_BUFFER, null)
    }

    return {
      init() {
        try { return build() } catch (e) {
          console.error('[OPEN SEA SKIN] flower pass failed', e)
          return false
        }
      },
      get ready() { return ready }
      ,get params() { return { ...P, flowers: inst ? inst.length : 0 } }
      ,set params(next) {
        if (!next || typeof next !== 'object') return
        if (typeof next.enabled === 'boolean') P.enabled = next.enabled
        if (Number.isFinite(next.density)) P.density = Math.max(0, Math.min(1, next.density))
      },
      draw(input, rtFb) {
        if (!ready || !P.enabled || !inst || inst.length === 0) return
        const env = input.env, cam = input.cam
        const L = input.light || {}
        // 云影漂移速率（v2-C）：和草、地面、天空同一条风速曲线，四方共用同一个速度。
        const wsF = Number.isFinite(input.windSpeed) ? Math.max(0, Math.min(1, input.windSpeed)) : 0.5
        const cloudDrift = 0.002 + Math.pow(wsF, 1.6) * 0.2331

        // 密度变了：重新撒花（和草那边同一套做法 —— 拖滑块立刻生效）
        if (Math.abs(P.density - lastDensity) > 0.01) {
          lastDensity = P.density
          inst = buildFlowers()
          uploadFlowers()
        }

        gl.bindFramebuffer(gl.FRAMEBUFFER, rtFb == null ? null : rtFb)
        gl.viewport(0, 0, W, H)
        gl.enable(gl.DEPTH_TEST)
        gl.depthFunc(gl.LEQUAL)
        gl.disable(gl.CULL_FACE)          // 双面

        gl.useProgram(pFlower)
        gl.uniformMatrix4fv(U.uViewProj, false, cam.viewProj)
        gl.uniform1f(U.uTime, elapsed)
        gl.uniform2f(U.uWind, input.wind ? input.wind[0] : 0, input.wind ? input.wind[1] : 0)
        gl.uniform1f(U.uWindSpeed, Number.isFinite(input.windSpeed) ? input.windSpeed : 0.5)
        gl.uniform3fv(U.uCamPos, cam.eye)
        gl.uniform3fv(U.uSunDir, env.sunDir)
        gl.uniform3fv(U.uSunColor, env.sunColor)
        gl.uniform3fv(U.uHorizon, env.horizon)
        gl.uniform3fv(U.uZenith, env.zenith)
        gl.uniform3fv(U.uMoonColor, L.moonColor || [0, 0, 0])
        gl.uniform3fv(U.uMoonDir, L.moonDir || [0, 1, 0])
        gl.uniform1f(U.uSunScale, Number.isFinite(L.sunScale) ? L.sunScale : 1)
        gl.uniform1f(U.uMoonScale, Number.isFinite(L.moonScale) ? L.moonScale : 1)
        gl.uniform1f(U.uLightGlobal, Number.isFinite(L.global) ? L.global : 1)
        gl.uniform1f(U.uCloudMask, input.cloudMask || 0)
        gl.uniform3f(U.uCloudShadow,
          input.wind && Number.isFinite(input.wind[0]) ? input.wind[0] : 0,
          input.wind && Number.isFinite(input.wind[1]) ? input.wind[1] : 0,
          cloudDrift)
        gl.uniform1f(U.uFog, input.fog || 0)

        gl.bindVertexArray(vao)
        gl.drawArraysInstanced(gl.TRIANGLES, 0, 12, Math.min(inst.length, FLOWER_MAX_COUNT))
        gl.bindVertexArray(null)
        gl.disable(gl.DEPTH_TEST)
        gl.enable(gl.CULL_FACE)
        // 隔离：不把本 Pass 的错误留给下游（sunPass 会误读）
        gl.getError()
      },
      dispose() {
        try { if (pFlower) gl.deleteProgram(pFlower) } catch (e) {}
        for (const b of [quadVbo, instVbo]) { try { if (b) gl.deleteBuffer(b) } catch (e) {} }
        try { if (vao) gl.deleteVertexArray(vao) } catch (e) {}
        pFlower = null
        ready = false
      },
    }
  }

  const pSea    = link(sh(gl.VERTEX_SHADER, VS_SEA), sh(gl.FRAGMENT_SHADER, FS_SEA))
  const pSky    = link(sh(gl.VERTEX_SHADER, VS_FULL), sh(gl.FRAGMENT_SHADER, FS_SKY))
  const pBright = link(sh(gl.VERTEX_SHADER, VS_FULL), sh(gl.FRAGMENT_SHADER, FS_BRIGHT))
  const pBlur   = link(sh(gl.VERTEX_SHADER, VS_FULL), sh(gl.FRAGMENT_SHADER, FS_BLUR))
  const pComp   = link(sh(gl.VERTEX_SHADER, VS_FULL), sh(gl.FRAGMENT_SHADER, FS_COMP))

  if (!pSea || !pSky || !pBright || !pBlur || !pComp) return

  //  闪电 Pass —— 从 2D Canvas 搬进 WebGL
  //  为什么搬：2D Canvas 只能画一条白线叠在最上层，照不到任何东西。
  //  WebGL 里它和太阳光效同一套管线、同一套加法混合，能真正「照亮天空」。
  //    1. boltPass   画闪电主干 + 分支，带多层辉光
  //    2. flashPass  全屏瞬时提亮，模拟雷光照亮整个画面
  //  路径点由客户端算法生成后传进来（坐标是屏幕 uv），这里只负责画。
  const LIGHTNING_MAX_PTS = 512
  // 云量硬上限。面板滑杆只到 150，超级暴雨（闪电数量+频率都拉满）推到 300。
  // 配套放开的地方：cloudStep 的 target 钳位、uCloudMask 的钳位、
  // 天空着色器里 sqrt(clamp(mask,0,2)) 与 thr/cap 的超限段，缺一个翻倍就不生效。
  const CLOUD_AMOUNT_MAX = 300
  const LIGHTNING_LOG = '[open-sea-skin][Lightning]'
  // 闪电没有「总开关」：着色器编译失败时 createBoltPass 返回 ready:false，
  // 客户端读到 __ossBoltActive=false 就自动走 2D 兜底，效果一样可见。
  // 想彻底关掉闪电，关面板上的闪电开关即可（那是客户端的 state.lightning）。

  const FS_FLASH = `#version 300 es
  precision highp float;
  out vec4 o;
  uniform vec3  uColor;
  uniform float uPower;
  uniform vec2  uRes;
  uniform vec2  uOrigin;
  void main() {
    vec2 uv = gl_FragCoord.xy / uRes;
    // 从闪击点散开的全屏亮度，中心最亮，边缘衰减
    float d = length(uv - uOrigin);
    float falloff = exp(-d * 1.6);
    o = vec4(uColor * uPower * (0.35 + falloff * 0.65), 1.0);
  }`

  // ---------- 合成之后单独叠的闪电层 ----------
  // 为什么不再画进 rtScene：rtScene 出来要过 ACES 曲线，超亮被压回 1.0，
  // 白色窄条叠在本来就接近饱和的天空上，经 bloom 一模糊就没了。
  // 这里改成在 drawComposite 之后、直接画到屏幕帧缓冲用加法混合叠上去，
  // 效果回到 2D canvas 的 lighter 叠加 —— 亮、不会被压、不会被 bloom 抹平。
  const VS_BOLT_LINE = `#version 300 es
  precision highp float;
  in vec2 aPos;    // 屏幕 uv：x 右、y 上，0..1
  in vec3 aParam;  // x=横向偏移 -1..1，y=带子自己的进度 0..1，z=透明度
  uniform vec2  uRes;
  uniform float uWidth;   // 半个线宽的像素数
  out float vAge;
  out float vAlpha;
  out float vCore;
  void main() {
    // uv → 像素，横向量到竖线所在方向上，保证粗细不随屏幕比例变形
    vec2 px = aPos * uRes;
    float aspect = max(1.0, uRes.y) / max(1.0, uRes.x);
    // The quad carries core + halo, so it is wider than the old hard stripe.
    // 1.6 rather than 2.6: at 2.6 the ribbon reached ~20 px across on a 1080p
    // screen and the bolt looked like a painted band, which is worse than the
    // hard edge it replaced. The halo only needs a little room.
    px.x += aParam.x * uWidth * aspect * 1.6;
    vec2 clip = px / uRes * 2.0 - 1.0;
    gl_Position = vec4(clip, 0.0, 1.0);
    vAge = aParam.y;
    vAlpha = aParam.z;
    vCore = aParam.x;
  }`

  const FS_BOLT_LINE = `#version 300 es
  precision highp float;
  in float vAge;
  in float vAlpha;
  in float vCore;    // -1..1 across the ribbon: 0 = centre line
  out vec4 o;
  uniform vec3 uColor;

  void main() {
    // Glow falloff across the ribbon.
    //
    // vCore runs -1..1 across the quad, but the quad is 1.6x the old half-width,
    // so |vCore| = 0.62 is where the old hard edge used to be. The core is kept
    // well inside that so the bolt still reads as a filament, not a band.
    float d = abs(vCore);
    // Core: a hot line about a third of the old stripe width.
    float core = exp(-d * d * 60.0);
    // Halo: wide and soft, fills the rest of the quad.
    float halo = exp(-d * d * 3.0);
    // Colour: white-hot centre cooling to the bolt's own colour at the edge.
    vec3 c = mix(uColor, vec3(1.0), core * 0.9 + 0.10);
    // Energy is concentrated in the core; the halo only carries a fraction.
    float a = vAlpha * (core * 0.95 + halo * 0.30);
    o = vec4(c * (0.60 + 0.9 * core), a);
  }`

  function createBoltPass() {
    const pLine = link(sh(gl.VERTEX_SHADER, VS_BOLT_LINE), sh(gl.FRAGMENT_SHADER, FS_BOLT_LINE))
    const pFlash = link(sh(gl.VERTEX_SHADER, VS_FULL), sh(gl.FRAGMENT_SHADER, FS_FLASH))
    if (!pLine || !pFlash) {
      console.error(LIGHTNING_LOG, '[shader_fail] lightning disabled')
      return { draw() {}, ready: false, dispose() {} }
    }

    const uLine = {
      color: u(pLine, 'uColor'),
      res: u(pLine, 'uRes'),
      width: u(pLine, 'uWidth'),
    }
    const uFlash = {
      color: u(pFlash, 'uColor'),
      power: u(pFlash, 'uPower'),
      res: u(pFlash, 'uRes'),
      origin: u(pFlash, 'uOrigin'),
    }

    const vao = gl.createVertexArray()
    gl.bindVertexArray(vao)
    const vbo = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo)
    gl.bufferData(gl.ARRAY_BUFFER, LIGHTNING_MAX_PTS * 5 * 4, gl.DYNAMIC_DRAW)
    const locPos = gl.getAttribLocation(pLine, 'aPos')
    const locParam = gl.getAttribLocation(pLine, 'aParam')
    gl.enableVertexAttribArray(locPos)
    gl.vertexAttribPointer(locPos, 2, gl.FLOAT, false, 20, 0)
    gl.enableVertexAttribArray(locParam)
    gl.vertexAttribPointer(locParam, 3, gl.FLOAT, false, 20, 8)
    gl.bindVertexArray(null)

    // 当前正在显示的闪电：屏幕 uv 点列 + 每条线的强度
    let segments = null   // [{ pts: [[x,y],...], width, intensity }]
    let flashPower = 0
    let flashOrigin = [0.5, 0.6]

    // 每个顶点 5 个 float：uv.x, uv.y, 横向偏移, 进度, 透明度
    const scratch = new Float32Array(LIGHTNING_MAX_PTS * 5)

    return {
      ready: true,
      // 客户端每帧推状态：segments 为 null 表示当前没有闪电
      setState(state) {
        segments = state && state.segments ? state.segments : null
        flashPower = state && Number.isFinite(state.flash) ? state.flash : 0
        if (state && state.origin) flashOrigin = state.origin
      },
      draw(rtFb) {
        if (!segments && flashPower <= 0) return
        gl.bindFramebuffer(gl.FRAMEBUFFER, rtFb == null ? null : rtFb)
        gl.viewport(0, 0, W, H)
        gl.enable(gl.BLEND)
        gl.blendFunc(gl.ONE, gl.ONE)
        gl.disable(gl.DEPTH_TEST)
        gl.disable(gl.CULL_FACE)

        // 全屏闪光
        if (flashPower > 0) {
          gl.useProgram(pFlash)
          gl.uniform3f(uFlash.color, 0.78, 0.88, 1.0)
          gl.uniform1f(uFlash.power, flashPower)
          gl.uniform2f(uFlash.res, W, H)
          gl.uniform2f(uFlash.origin, flashOrigin[0], flashOrigin[1])
          gl.drawArrays(gl.TRIANGLES, 0, 3)
        }

        // 闪电主干和分支：每个点扩成一条带子（triangle strip 的顶点流）。
        // 线的粗细用「像素」描述，进 shader 再换算，所以渲染缩放和屏幕比例都不会把线压没。
        if (segments && segments.length) {
          gl.useProgram(pLine)
          gl.uniform2f(uLine.res, W, H)
          gl.bindVertexArray(vao)
          for (const seg of segments) {
            const pts = seg.pts
            if (!pts || pts.length < 2) continue
            // 每点 2 个顶点 → 最多 (LIGHTNING_MAX_PTS - 1) / 2 个点
            const n = Math.min(pts.length, Math.floor((LIGHTNING_MAX_PTS - 1) / 2))
            const alpha = Math.min(1, Math.max(0, seg.intensity == null ? 1 : seg.intensity))
            if (alpha <= 0.001) continue
            // seg.width 是屏幕宽度的比例（客户端传 0.004 等），再抬一个像素下限，
            // 保证高分屏下也不至于细到看不见。
            const halfPx = Math.max(0.75, (seg.width || 0.004) * 0.5 * W)
            let k = 0
            for (let i = 0; i < n; i++) {
              const cur = pts[i]
              const age = i / Math.max(1, n - 1)
              // Taper along the bolt - ONE-WAY, not symmetric.
              //
              // A real bolt leaves the cloud thick and thins towards the ground,
              // which is exactly what the original 2D version did (2.4px at the
              // cloud base down to 0.7px at the tip). The symmetric sin()
              // envelope used here before tapered both ends, so the trunk came
              // out as a lozenge rather than a blade.
              // age: 0 at the cloud base, 1 at the strike point.
              const taper = 1.0 - 0.72 * age
              scratch[k++] = cur[0]; scratch[k++] = cur[1]
              scratch[k++] = -taper; scratch[k++] = age; scratch[k++] = alpha
              scratch[k++] = cur[0]; scratch[k++] = cur[1]
              scratch[k++] = taper; scratch[k++] = age; scratch[k++] = alpha
            }
            if (k < 20) continue
            gl.bindBuffer(gl.ARRAY_BUFFER, vbo)
            gl.bufferSubData(gl.ARRAY_BUFFER, 0, scratch.subarray(0, k))
            gl.uniform1f(uLine.width, halfPx)
            gl.uniform3f(uLine.color, seg.color ? seg.color[0] : 0.75,
              seg.color ? seg.color[1] : 0.87, seg.color ? seg.color[2] : 1.0)
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, k / 5)
          }
          gl.bindVertexArray(null)
        }

        gl.disable(gl.BLEND)
        gl.blendFunc(gl.ONE, gl.ZERO)
      },
      dispose() {
        try { gl.deleteProgram(pLine) } catch (e) { /* 已释放 */ }
        try { gl.deleteProgram(pFlash) } catch (e) { /* 已释放 */ }
        try { gl.deleteVertexArray(vao) } catch (e) { /* 已释放 */ }
        try { gl.deleteBuffer(vbo) } catch (e) { /* 已释放 */ }
      },
    }
  }

  const u = (prog, name) => gl.getUniformLocation(prog, name)

  const US = {}
  for (const k of ['uViewProj','uTime','uSea','uDetailScale','uDetailRadius','uCamPos','uSunDir',
                   'uSunColor','uMoonDir','uMoonColor','uFog',
                   'uHorizon','uZenith','uDeep','uShallow','uSunDiscScale','uMoonDiscScale','uDayPhase']) US[k] = u(pSea, k)
  for (let i = 0; i < WAVE_COUNT; i++) {
    US[`uWaveDir[${i}]`] = u(pSea, `uWaveDir[${i}]`)
    US[`uWaveK[${i}]`]   = u(pSea, `uWaveK[${i}]`)
    US[`uWaveC[${i}]`]   = u(pSea, `uWaveC[${i}]`)
    US[`uWaveA0[${i}]`]  = u(pSea, `uWaveA0[${i}]`)
  }

  const UK = {}
    for (const k of ['uCamPos','uInvVP','uRes','uSunDir','uSunColor','uHorizon','uZenith','uDeep','uTime','uCloudMask','uCloudOpacity','uCloudCondense','uCloudUnite','uCloudStorm','uCloudWind','uSunDiscScale','uMoonDiscScale','uDayPhase','uStarBright']) UK[k] = u(pSky, k)

  const UB = {
    tex: u(pBright,'uTex'), res: u(pBright,'uRes'), thr: u(pBright,'uThreshold'),
    btex: u(pBlur,'uTex'), bdir: u(pBlur,'uDir'), bres: u(pBlur,'uRes'), brad: u(pBlur,'uRadius'),
    scene: u(pComp,'uScene'), bloom: u(pComp,'uBloom'), cres: u(pComp,'uRes'),
    str: u(pComp,'uBloomStrength'), exp: u(pComp,'uExposure'),
  }

  const vcount = (SEG + 1) * (SEG + 1)
  const verts = new Float32Array(vcount * 3)
  let vi = 0
  for (let z = 0; z <= SEG; z++) {
    for (let x = 0; x <= SEG; x++) {
      verts[vi++] = (x / SEG - 0.5) * PLANE_SIZE
      verts[vi++] = 0
      verts[vi++] = (z / SEG - 0.5) * PLANE_SIZE
    }
  }

  const idxCount = SEG * SEG * 6
  const indices = new Uint32Array(idxCount)
  let ii = 0
  for (let z = 0; z < SEG; z++) {
    for (let x = 0; x < SEG; x++) {
      const a = z * (SEG + 1) + x
      const b = a + 1
      const c = a + (SEG + 1)
      const d = c + 1
      indices[ii++] = a; indices[ii++] = b; indices[ii++] = c
      indices[ii++] = b; indices[ii++] = d; indices[ii++] = c
    }
  }

  const vao = gl.createVertexArray()
  gl.bindVertexArray(vao)
  const vbo = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo)
  gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW)
  const aLoc = gl.getAttribLocation(pSea, 'aPos')
  gl.enableVertexAttribArray(aLoc)
  gl.vertexAttribPointer(aLoc, 3, gl.FLOAT, false, 0, 0)
  const ibo = gl.createBuffer()
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo)
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW)
  gl.bindVertexArray(null)

  // 渲染目标位深：上游输出 HDR（太阳 core*12、月亮*2.6、海面 spec>1），
  // RGBA8 会把超过 1.0 的部分钳回 1.0，bloom 和 ACES 都失去意义。
  // 有 float 扩展就用 RGBA16F，否则退回 RGBA8（行为同旧版）。
  const HDR_TEX = !!gl.getExtension('EXT_color_buffer_float')
  const RT_IF = HDR_TEX ? gl.RGBA16F : gl.RGBA8
  const RT_TYPE = HDR_TEX ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE

  // withDepth：只有场景 RT 需要深度缓冲（草和地面/角色要互相遮挡）。
  // bloom 那几张是纯颜色处理，挂深度只是白占显存。
  function makeRT(w, h, withDepth) {
    const tex = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texImage2D(gl.TEXTURE_2D, 0, RT_IF, w, h, 0, gl.RGBA, RT_TYPE, null)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    // 深度附件。
    // 没有它，画进这个 framebuffer 的所有 Pass 的深度测试都是空转 ——
    // 表现就是「谁最后画谁在最上面」，不可能出现前后遮挡。
    // 只在场景那个 RT 上开：bloom 用的那几张不需要深度，多挂一个只是白占内存。
    const depth = withDepth ? gl.createRenderbuffer() : null
    if (depth) {
      gl.bindRenderbuffer(gl.RENDERBUFFER, depth)
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h)
    }
    const fb = gl.createFramebuffer()
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
    if (depth) gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    return { tex, fb, w, h, depth }
  }

  function resizeRT(rt, w, h) {
    if (rt.w === w && rt.h === h) return
    rt.w = w; rt.h = h
    gl.bindTexture(gl.TEXTURE_2D, rt.tex)
    gl.texImage2D(gl.TEXTURE_2D, 0, RT_IF, w, h, 0, gl.RGBA, RT_TYPE, null)
    // 深度附件是 renderbuffer，必须跟着尺寸一起重建，否则深度和颜色对不上。
    if (rt.depth) {
      gl.bindRenderbuffer(gl.RENDERBUFFER, rt.depth)
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h)
      gl.bindRenderbuffer(gl.RENDERBUFFER, null)
    }
  }

  let rtScene, rtBright, rtBlurA, rtBlurB, W = 1, H = 1

  function allocRT() {
    const bw = Math.max(1, W >> 1), bh = Math.max(1, H >> 1)
    if (!rtScene) {
      rtScene  = makeRT(W, H, true)
      rtBright = makeRT(bw, bh)
      rtBlurA  = makeRT(bw, bh)
      rtBlurB  = makeRT(bw, bh)
    } else {
      resizeRT(rtScene, W, H)
      resizeRT(rtBright, bw, bh)
      resizeRT(rtBlurA, bw, bh)
      resizeRT(rtBlurB, bw, bh)
    }
  }

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2) * renderScale
    // 【尺寸没变就直接返回】这是「空闲时屏幕间歇性闪黑」的根因之一。
    // 原来无条件执行 canvas.width = / canvas.height = —— 给 canvas 赋这两个值
    // 会立刻清空整个绘图表面，紧接着 allocRT() 又重建所有帧缓冲。
    // 浏览器在空闲时可能因为滚动条、DPI 回弹、壳层重排等原因反复触发 resize
    // （哪怕尺寸只差 1px），于是每隔一阵就清一次画布 → 一帧黑。
    // 加了这个判断，真 resize 照常工作，假触发直接跳过。
    const nw = Math.max(1, Math.round(window.innerWidth * dpr))
    const nh = Math.max(1, Math.round(window.innerHeight * dpr))
    if (nw === W && nh === H) return
    W = nw
    H = nh
    canvas.width = W
    canvas.height = H
    allocRT()
  }
  window.addEventListener('resize', resize)
  resize()

  // 太阳光效实例。init 失败会把自身关掉，不影响海洋主链路。
  sunPass = createSunPass()
  sunPass.init()
  // 草地：和太阳光效同一套隔离策略 —— 着色器失败只关草，海照常。
  try {
    grassPass = createGrassPass()
    if (!grassPass.init()) grassPass = null
  } catch (error) {
    console.error('[OPEN SEA SKIN] grass pass failed, grass disabled', error)
    grassPass = null
  }
  // 花：又一个独立 Pass，和草互不影响（花挂了草照常，反之亦然）。
  try {
    flowerPass = createFlowerPass()
    if (!flowerPass.init()) flowerPass = null
  } catch (error) {
    console.error('[OPEN SEA SKIN] flower pass failed, flowers disabled', error)
    flowerPass = null
  }
  // 闪电也走 WebGL：和太阳光效同一套加法混合，能真正照亮天空和海面。
  // 用 try/catch 隔离：闪电 Pass 任何一步失败都不能拖垮海洋主链路。
  try {
    boltPass = createBoltPass()
  } catch (error) {
    console.error(LIGHTNING_LOG, '[init] bolt pass failed, lightning disabled', error)
    boltPass = { draw() {}, ready: false, dispose() {} }
  }

  // 大肥鱼：同样隔离。着色器挂了只是它不出现，海和天照常。
  try {
    petPass = createPetPass()
    if (!petPass.init()) {
      console.error(PET_PASS_LOG, 'init returned false, pet hidden')
      petPass = null
    }
  } catch (error) {
    console.error(PET_PASS_LOG, 'pet pass failed, pet hidden', error)
    petPass = null
  }

  // ======================================================================
  //  大肥鱼 Pass —— 真正画进场景里
  //
  //  为什么必须进引擎：DOM 上的 <img> 永远是一张贴纸。它不跟相机走、不跟
  //  地平线走、也不会被海水遮住。它「在场」但不在「空间」里。
  //  这个 Pass 让它成为一个站在世界坐标里的东西：
  //    · 用固定的世界位置（不跟相机，相机固定，所以位置稳定）
  //    · 用 cam.viewProj 投影到屏幕 —— 换分辨率、改 FOV 都自动正确
  //    · 画在 drawComposite 之后（与 boltPass 同一个位置），所以它不在
  //      ACES 色调映射里被压暗，颜色和立绘一致
  //
  //  纹理来源：客户端把抠好黑底的 canvas 交进来（__ossPetTexture）。
  //  那一步抠图逻辑在 client 里，和 PET-INTEGRATION.md 一致；
  //  这里只负责把它贴到一个朝向相机、固定世界位置的四边形上。
  //
  //  失败隔离：和 sunPass / boltPass 同一套规矩 —— init 失败就返回空实现，
  //  主链路（海、天、云、天气）一概不受影响。
  // ======================================================================
  const PET_PASS_LOG = '[dsh-weather-sandbox:pet]'

  function petHash2(px, pz) {
    const qx = px - Math.floor(px / 289) * 289
    const qz = pz - Math.floor(pz / 289) * 289
    const ax = Math.sin(qx * 127.1 + qz * 311.7) * 43758.5453
    const az = Math.sin(qx * 269.5 + qz * 183.3) * 43758.5453
    return [(ax - Math.floor(ax)) * 2 - 1, (az - Math.floor(az)) * 2 - 1]
  }
  function petGnoise(px, pz) {
    const ix = Math.floor(px), iz = Math.floor(pz)
    const fx = px - ix, fz = pz - iz
    const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10)
    const uz = fz * fz * fz * (fz * (fz * 6 - 15) + 10)
    const h00 = petHash2(ix, iz), h10 = petHash2(ix + 1, iz)
    const h01 = petHash2(ix, iz + 1), h11 = petHash2(ix + 1, iz + 1)
    const n00 = h00[0] * fx + h00[1] * fz
    const n10 = h10[0] * (fx - 1) + h10[1] * fz
    const n01 = h01[0] * fx + h01[1] * (fz - 1)
    const n11 = h11[0] * (fx - 1) + h11[1] * (fz - 1)
    const a = n00 + (n10 - n00) * ux
    const b = n01 + (n11 - n01) * ux
    return a + (b - a) * uz
  }
  function petTerrainFbm(px, pz) {
    return petGnoise(px, pz) + petGnoise(px * 2.13 + 31.7, pz * 2.13 + 12.9) * 0.5
  }
  function petTerrainHeight(x, z) {
    const h = petTerrainFbm(x * 0.010, z * 0.010) * 6.0
            + petTerrainFbm(x * 0.045 + 7.3, z * 0.045 + 19.1) * 1.20
            + petGnoise(x * 0.140 + 3.7, z * 0.140 + 11.3) * 0.42
    return h * 0.55 + 2.20
  }

  function createPetPass() {
    // 角色的基准位置（世界坐标，米）。
    //   相机 [0,5.5,17] 看向 [0,1.5,0]，FOV 55°。
    //   x=0 是画面正中；y=0.05 是脚底刚出水面；z=8.5 对应离相机 8.5 米。
    //   2.5 米高在这个距离上约占屏高 27%，是能看清表情的下限。
    const PET_POS = [0, 0.05, 8.5]
    const PET_HEIGHT = 2.5
    // 【对外的 z 一律是「距离相机的米数」，不是世界 z】
    //   镜头看的方向是 -z，所以「离相机越远」= 世界 z 越小，两者方向相反。
    //   只在这一处换算：worldZ = PET_POS[2] - (dist - CAM_TO_PET)。别处不许再翻。
    const CAM_TO_PET = 8.5

    const VS = `#version 300 es
    in vec2 aCorner;
    uniform mat4 uViewProj;
    uniform vec3 uOrigin;
    uniform vec2 uSize;
    uniform float uFlip;
    out vec2 vUV;
    void main() {
      // aCorner: x in [-0.5, 0.5] (width), y in [0, 1] (bottom -> top)
      // 翻转只发生在 UV 上：几何位置不动，只把贴图水平镜像。
      // 如果顶点位置也乘 uFlip，等于翻两次回到原样，朝向永远改不过来。
      vec3 world = uOrigin + vec3(aCorner.x * uSize.x, aCorner.y * uSize.y, 0.0);
      gl_Position = uViewProj * vec4(world, 1.0);
      float u = uFlip < 0.0 ? (1.0 - (aCorner.x + 0.5)) : (aCorner.x + 0.5);
      vUV = vec2(u, 1.0 - aCorner.y);
    }`

    const FS = `#version 300 es
    precision highp float;
    in vec2 vUV;
    uniform sampler2D uTex;
    uniform float uHasTex;
    uniform float uExposure;
    // 贴玻璃虚化 0..1。凑到 2.8 米时它占屏 75%，不失焦就像被放大，不像凑近。
    uniform float uBlur;
    uniform vec2 uTexel;
    // 场景光：太阳色 × 强度、月光色 × 强度、云量、昼夜进度。
    // 角色是贴图，没有法线，所以不做方向光 —— 只做整体调色：
    // 白天偏暖白、黄昏偏橙、夜里靠月光偏冷蓝、雷雨天压暗。
    // 这样它至少和天空是同一个时刻，而不是一张永远不变的贴纸。
    uniform vec3 uSunColor;
    uniform vec3 uMoonColor;
    uniform float uCloudMask;
    uniform float uDaylight;
    out vec4 frag;
    // 必须和 FS_COMP 的 aces() 同系数：否则角色比周围暗一半（0.2 → 0.30 那一段）。
    vec3 aces(vec3 x) {
      const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
      return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
    }
    void main() {
      // 没有纹理就不画任何像素。关掉主体时屏幕上不该留痕迹。
      if (uHasTex < 0.5) discard;
      // 五点近似高斯。只在 uBlur > 0.01 时多采，平时一次采样，零额外成本。
      vec4 t;
      if (uBlur > 0.01) {
        vec2 o = uTexel * uBlur * 3.0;
        t  = texture(uTex, vUV) * 0.40;
        t += texture(uTex, vUV + vec2( o.x,  0.0)) * 0.15;
        t += texture(uTex, vUV + vec2(-o.x,  0.0)) * 0.15;
        t += texture(uTex, vUV + vec2( 0.0,  o.y)) * 0.15;
        t += texture(uTex, vUV + vec2( 0.0, -o.y)) * 0.15;
      } else {
        t = texture(uTex, vUV);
      }
      if (t.a < 0.004) discard;
      // 立绘是 sRGB 显示值 → 先转线性 → 和场景一样过 ACES → 输出
      vec3 lin = pow(t.rgb, vec3(2.2));
      // ---- 场景光调色 ----
      // 三个因子相乘，全部 0..1 附近，不会把角色压成黑的：
      //   太阳项：日光越强越亮，色温跟着 sunColor（黄昏偏橙）
      //   月亮项：入夜后接管，偏冷蓝
      //   云量  ：云厚时压暗一点，和天空的阴暗一致
      float day = clamp(uDaylight / 100.0, 0.0, 1.0);
      vec3 sunLit = uSunColor * (0.55 + 0.45 * day);
      vec3 moonLit = uMoonColor * (1.0 - day);
      vec3 lit = sunLit + moonLit;
      // 归一化：不让总亮度随色温乱跳，只让它「有颜色」
      float lum = max(dot(lit, vec3(0.2126, 0.7152, 0.0722)), 0.12);
      vec3 tint = lit / lum * 0.92;
      tint *= 1.0 - clamp(uCloudMask, 0.0, 1.0) * 0.35;
      frag = vec4(aces(lin * tint * uExposure), t.a);
    }`

    let prog = null, vao = null, vbo = null
    let U = {}
    let tex = null
    let textureSource = null
    let ready = false
    let flip = 1

    function compile(type, src) {
      const sh = gl.createShader(type)
      gl.shaderSource(sh, src)
      gl.compileShader(sh)
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        console.error(PET_PASS_LOG, 'shader failed:', gl.getShaderInfoLog(sh))
        gl.deleteShader(sh)
        return null
      }
      return sh
    }

    function init() {
      const vs = compile(gl.VERTEX_SHADER, VS)
      const fs = compile(gl.FRAGMENT_SHADER, FS)
      if (!vs || !fs) return false
      prog = gl.createProgram()
      gl.attachShader(prog, vs)
      gl.attachShader(prog, fs)
      gl.bindAttribLocation(prog, 0, 'aCorner')
      gl.linkProgram(prog)
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        console.error(PET_PASS_LOG, 'link failed:', gl.getProgramInfoLog(prog))
        prog = null
        return false
      }
      U = {
        viewProj: gl.getUniformLocation(prog, 'uViewProj'),
        origin: gl.getUniformLocation(prog, 'uOrigin'),
        size: gl.getUniformLocation(prog, 'uSize'),
        flip: gl.getUniformLocation(prog, 'uFlip'),
        tex: gl.getUniformLocation(prog, 'uTex'),
        hasTex: gl.getUniformLocation(prog, 'uHasTex'),
        exposure: gl.getUniformLocation(prog, 'uExposure'),
        blur: gl.getUniformLocation(prog, 'uBlur'),
        texel: gl.getUniformLocation(prog, 'uTexel'),
        sunColor: gl.getUniformLocation(prog, 'uSunColor'),
        moonColor: gl.getUniformLocation(prog, 'uMoonColor'),
        cloudMask: gl.getUniformLocation(prog, 'uCloudMask'),
        daylight: gl.getUniformLocation(prog, 'uDaylight'),
      }

      // 两个三角形：x 在 -0.5..0.5，y 在 0..1
      const quad = new Float32Array([
        -0.5, 0, 0.5, 0, -0.5, 1,
        -0.5, 1, 0.5, 0, 0.5, 1,
      ])
      vao = gl.createVertexArray()
      gl.bindVertexArray(vao)
      vbo = gl.createBuffer()
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo)
      gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW)
      gl.enableVertexAttribArray(0)
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
      gl.bindVertexArray(null)

      tex = gl.createTexture()
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      gl.bindTexture(gl.TEXTURE_2D, null)

      ready = true
      return true
    }

    // 上传一帧纹理。source 可以是 canvas / video / image。
    function upload(source, w, h) {
      if (!ready || !tex || !source) return
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source)
      gl.bindTexture(gl.TEXTURE_2D, null)
      textureSource = source
    }

    // 清空纹理源。此后 draw 走「没有纹理」分支，什么都不画。
    function clear() {
      textureSource = null
    }

    // env 是 updateSun() 那一份，和天空/海面同一个时刻的光。
    function draw(cam, params, env) {
      if (!ready || !prog) return
      // 世界坐标 → 投影
      gl.useProgram(prog)
      gl.bindVertexArray(vao)
      gl.enable(gl.BLEND)
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)

      gl.uniformMatrix4fv(U.viewProj, false, cam.viewProj)
      const wx = PET_POS[0] + (params && params.x ? params.x : 0)
      const wz = PET_POS[2] - ((params && params.z ? params.z : 0) - CAM_TO_PET)
      const groundY = petTerrainHeight(wx, wz)
      gl.uniform3f(
        U.origin,
        wx,
        groundY + PET_POS[1] + (params && params.lift || 0),
        wz,
      )
      gl.uniform2f(U.size, PET_HEIGHT * (params && params.aspect || 0.8), PET_HEIGHT)
      gl.uniform1f(U.flip, params && params.flip < 0 ? -1 : 1)
      gl.uniform1f(U.hasTex, textureSource ? 1 : 0)
      // 和主合成 pass 用同一个曝光值，角色才会和场景一样亮
      if (U.exposure) gl.uniform1f(U.exposure, EXPOSURE)

      // 4 米外是正常角色，只有真的凑到眼前才失焦 —— 虚化本身是一个信号。
      const pz = params && params.z ? params.z : CAM_TO_PET
      const blur = pz < 4.0 ? Math.min(1, (4.0 - pz) / 1.2) * 0.55 : 0
      if (U.blur) gl.uniform1f(U.blur, blur)
      if (U.texel) gl.uniform2f(U.texel, 1 / 256, 1 / 144)

      // 场景光：和天空、海面同一帧的同一份值，角色才会和世界同一个时刻。
      if (env) {
        if (U.sunColor) gl.uniform3fv(U.sunColor, env.sunColor)
        if (U.moonColor) gl.uniform3fv(U.moonColor, env.moonColor)
        // 云量和昼夜由 frame() 打包进 env 一起传 —— 不在这里直接读 CLOUD/daylight。
        // 那两个变量定义在本文件更靠后的位置（CLOUD 在 4084 行），
        // 存在 TDZ 风险：现在因为调用顺序是对的所以不炸，但顺序一变就炸。
        // 从参数拿，作用域就干净了。
        if (U.cloudMask) gl.uniform1f(U.cloudMask, env.cloudMask || 0)
        if (U.daylight) gl.uniform1f(U.daylight, env.daylight || 0)
      }

      if (textureSource) {
        gl.activeTexture(gl.TEXTURE0)
        gl.bindTexture(gl.TEXTURE_2D, tex)
        gl.uniform1i(U.tex, 0)
      }

      gl.drawArrays(gl.TRIANGLES, 0, 6)
      gl.bindVertexArray(null)
      gl.disable(gl.BLEND)
    }

    function dispose() {
      try {
        if (tex) gl.deleteTexture(tex)
        if (vbo) gl.deleteBuffer(vbo)
        if (vao) gl.deleteVertexArray(vao)
        if (prog) gl.deleteProgram(prog)
      } catch (error) { /* 上下文已失效 */ }
      tex = null; vbo = null; vao = null; prog = null
      textureSource = null
      ready = false
    }

    return { init, draw, dispose, upload, clear, get ready() { return ready } }
  }

  // 改动 1：矩阵工具内联，删 sub/dot/cross/norm
  const mat4 = {
    perspective(fovy, aspect, near, far) {
      const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far)
      const m = new Float32Array(16)
      m[0] = f / aspect; m[5] = f; m[10] = (far + near) * nf; m[11] = -1
      m[14] = 2 * far * near * nf
      return m
    },
    lookAt(eye, tgt, up) {
      let fx = tgt[0] - eye[0], fy = tgt[1] - eye[1], fz = tgt[2] - eye[2]
      let l = Math.hypot(fx, fy, fz) || 1; fx /= l; fy /= l; fz /= l
      let sx = up[1] * fz - up[2] * fy, sy = up[2] * fx - up[0] * fz, sz = up[0] * fy - up[1] * fx
      l = Math.hypot(sx, sy, sz) || 1; sx /= l; sy /= l; sz /= l
      const ux = fy * sz - fz * sy, uy = fz * sx - fx * sz, uz = fx * sy - fy * sx
      return new Float32Array([
        sx, ux, -fx, 0,
        sy, uy, -fy, 0,
        sz, uz, -fz, 0,
        -(sx * eye[0] + sy * eye[1] + sz * eye[2]),
        -(ux * eye[0] + uy * eye[1] + uz * eye[2]),
        fx * eye[0] + fy * eye[1] + fz * eye[2], 1,
      ])
    },
    mul(a, b) {
      const o = new Float32Array(16)
      for (let c = 0; c < 4; c++)
        for (let r = 0; r < 4; r++) {
          let s = 0
          for (let k = 0; k < 4; k++) s += a[r + k * 4] * b[k + c * 4]
          o[r + c * 4] = s
        }
      return o
    },
    invert(m) {
      const o = new Float32Array(16)
      const a00=m[0],a01=m[1],a02=m[2],a03=m[3], a10=m[4],a11=m[5],a12=m[6],a13=m[7]
      const a20=m[8],a21=m[9],a22=m[10],a23=m[11], a30=m[12],a31=m[13],a32=m[14],a33=m[15]
      const b00=a00*a11-a01*a10, b01=a00*a12-a02*a10, b02=a00*a13-a03*a10
      const b03=a01*a12-a02*a11, b04=a01*a13-a03*a11, b05=a02*a13-a03*a12
      const b06=a20*a31-a21*a30, b07=a20*a32-a22*a30, b08=a20*a33-a23*a30
      const b09=a21*a32-a22*a31, b10=a21*a33-a23*a31, b11=a22*a33-a23*a32
      let det = b00*b11-b01*b10+b02*b09+b03*b08-b04*b07+b05*b06
      if (!det) return m
      det = 1/det
      o[0]=(a11*b11-a12*b10+a13*b09)*det; o[1]=(a02*b10-a01*b11-a03*b09)*det
      o[2]=(a31*b05-a32*b04+a33*b03)*det; o[3]=(a22*b04-a21*b05-a23*b03)*det
      o[4]=(a12*b08-a10*b11-a13*b07)*det; o[5]=(a00*b11-a02*b08+a03*b07)*det
      o[6]=(a32*b02-a30*b05-a33*b01)*det; o[7]=(a20*b05-a22*b02+a23*b01)*det
      o[8]=(a10*b10-a11*b08+a13*b06)*det; o[9]=(a01*b08-a00*b10-a03*b06)*det
      o[10]=(a30*b04-a31*b02+a33*b00)*det; o[11]=(a21*b02-a20*b04-a23*b00)*det
      o[12]=(a11*b07-a10*b09-a12*b06)*det; o[13]=(a00*b09-a01*b07+a02*b06)*det
      o[14]=(a31*b01-a30*b03-a32*b00)*det; o[15]=(a20*b03-a21*b01+a22*b00)*det
      return o
    },
  }

  const mix3 = (a, b, t) => [a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t, a[2]+(b[2]-a[2])*t]
  const lerp = (a, b, t) => a + (b - a) * t
  const sstep01 = (a, b, x) => { const t = Math.min(1, Math.max(0, (x-a)/(b-a))); return t*t*(3-2*t) }

  let elapsed = 0
  // 自动昼夜：autoPhase 是 0..1 的相位，daylight = autoPhase * 100。
  // lastAutoNow = 0 表示"还没起表"，用于切换模式后重新对齐时间基准。
  let autoPhase = 0
  let lastAutoNow = 0
  let last = performance.now()
  let started = false
  // 这个实例是否已被停掉；rafId 用来在关插件时 cancel 掉正在排队的下一帧。
  let stopped = false
  let rafId = 0
  let frames = 0, winStart = performance.now(), fps = 60
  let adaptAt = performance.now()

  // 太阳轨迹：一条从海平线升起、横穿天空带、再落回海平线的弧。
  // 约束全部来自相机，不是美术偏好：
  //   相机 eye=[0,5.5,17] 看 [0,1.5,0]，俯视 13.24°，垂直 FOV 55°
  //   → 视野仰角 -40.7° ~ +14.26°，天空带（uvY>0.726）对应仰角 0° ~ 14.26°
  //   → 水平半视野 42.8°
  //   原版用 0.62/±0.9，daylight 过 40 太阳就飞出屏幕上方，
  //   于是「自动昼夜」看起来像太阳消失（实际在画面外跑）。
  // 这组值经扫描确认：全程 uvY 0.74~0.95、uvX 0.14~0.86，始终在天空带内。
  //   · elevation 走 sin(t·π) 拱形 —— 两端贴海平线，t=0.5 最高
  //   · azimuth 走线性 —— 左到右匀速横移
  // 想抬高上限必须同时改 CAM_TARGET 或 FOV_DEG，光调这里会出界。
  // 轨迹形状：分段线性，不是 sin 拱形。
  // sin(t·π) 在 t=0/1 处导数为 0 —— 太阳在两端「粘」住不动，
  // 加上 t=0 时仰角恰好等于 LOW（地平线下），自动循环刚启动的那几十秒
  // 太阳一直藏在海面下，看起来就是「永不升起」。分段线性全程匀速，没有粘滞。
  //   t=0    仰角 +7.0°（白天）  ← 每一轮从这里开始，太阳已经在半空
  //   t=0.30 仰角 12°            ← 最高点
  //   t=0.72 仰角 +3.4°          ← 开始压向海平线
  //   t=1.0  仰角 -1.7°（落下）  ← 沉到海面下，然后循环跳回 t=0
  // 起点为什么从 +0.5° 抬到 +7.0°：
  //   原来 t=0 就贴着海平线，天暗程度一上来就是 0.8，
  //   每一轮刚启动画面就是黄昏，全天几乎没有白天，星星反而一直挂着。
  //   抬到 7° 后每轮以明亮的白天开场，结尾才落下去，
  //   夜晚集中在 t=0.72..1.0 这一段。
  const SUN_ELEV_START = -0.075   // +3.0°，起点在白天但接近黄昏，让循环接得上
  const SUN_ELEV_PEAK  = 0.21    // +12.0°，最高点
  const SUN_ELEV_END   = -0.075  // -4.3°，沉到海平线下
  const SUN_PEAK_AT    = 0.36    // 最高点出现在 t=0.30（白天段更长）
  const SUN_AZ_RANGE   = 0.58    // 方位半幅 ≈ 33°

  // 仰角曲线：上升段 → 下降段，两段都用 smoothstep 让两端与顶点不出现尖角。
  //   0..0.30     上升
  //   0.30..1.0   下降（占七成，日落和入夜都在这段里自然展开）
  // 这里刻意不加「夜晚平台」。
  // 之前为了拉长夜晚，在 t=0.78 之后把仰角钉死在最低点，
  // 结果太阳沉底后方位还在继续右移（落点变了），
  // night 也在那一刻突然跳到 1，月亮表现为「半空中凭空出现」。
  // 下降段用线性，不用 smoothstep：
  //   smoothstep 靠近 t=1 时导数趋零 —— 太阳「粘」在末尾，
  //   仰角从 3° 掉到 -4.3° 只占不到 15% 的时间，夜晚被压缩成几秒。
  //   改用线性后太阳在海平线附近匀速下沉，低空和入夜的时间被天然拉长，
  //   而且落点位置、轨迹形状都不变，只是下降的节奏更均匀。
  //   上升段仍用 smoothstep，保留起步和到顶的柔和过渡。
  function sunElevationAt(t) {
    if (t < SUN_PEAK_AT) {
      const u = t / SUN_PEAK_AT
      const ease = u * u * (3 - 2 * u)
      return lerp(SUN_ELEV_START, SUN_ELEV_PEAK, ease)
    }
    const u = (t - SUN_PEAK_AT) / (1 - SUN_PEAK_AT)
    const ease = u * u * (3 - 2 * u)
    return lerp(SUN_ELEV_PEAK, SUN_ELEV_END, ease)
  }

  function sunDirection(t) {
    const elevation = sunElevationAt(t)
    // 相机固定，方位角直接用世界坐标即可。
    const azimuth = lerp(-SUN_AZ_RANGE, SUN_AZ_RANGE, t)
    const ce = Math.cos(elevation), se = Math.sin(elevation)
    const sa = Math.sin(azimuth), ca = Math.cos(azimuth)
    return [ce * sa, se, -ce * ca]
  }

  // 月亮方向 / 亮度。必须和 SKY_GLSL 里 moonLight 的算法逐行对齐，
  // 否则海面上的月光高光会和天上的月亮对不上（光斑和水里两个位置）。
  // shader 里对应的是：
  //   moonT = clamp((uDayPhase - 0.76) / 0.24, 0, 1)          ← 弧线进度（时间轴驱动）
  //   az    = mix(0.46, 0.02, moonT)                          ← 右 → 中
  //   el    = 0.012 + 0.185 * sin(moonT * PI)                 ← 半弧
  //   rise  = smoothstep(0.012, 0.045, el) * (1 - smoothstep(0.90, 1.0, moonT))
  // phase 就是 daylight/100，和传给 shader 的 uDayPhase 是同一个值。
  function moonEnv(phase) {
    const moonT = Math.min(1, Math.max(0, (phase - 0.76) / 0.24))
    const az = 0.46 + (0.02 - 0.46) * moonT
    const el = 0.012 + 0.185 * Math.sin(moonT * Math.PI)
    const rise = sstep01(0.012, 0.045, el) * (1 - sstep01(0.90, 1.0, moonT))
    const ce = Math.cos(el)
    const dir = [Math.sin(az) * ce, Math.sin(el), -Math.cos(az) * ce]
    // 月光强度：约满月时 0.34 左右，比日光弱一个量级但足以照亮海面
    const k = rise * 0.34
    return { dir, color: [0.72 * k, 0.80 * k, 1.0 * k] }
  }

  function updateSun() {
    const t = Math.min(1, Math.max(0, daylight / 100))
    // 色温跟实际仰角走（不是跟 t 走），这样正午最白、黄昏转暖
    const elevation = sunElevationAt(t)
    // daylightFactor：0 = 黄昏，1 = 正午。仰角低于 0 时被钳到 0。
    const daylightFactor = sstep01(0.0, SUN_ELEV_PEAK, elevation)
    // nightFactor：0 = 还是白天/黄昏，1 = 完全入夜。
    // 必须和 shader 里 nightAmount() 用同一套区间（-0.075 .. 0.21），
    // 否则天空变黑的节奏和月亮星星变亮的节奏会错开：
    // 天已经黑了星还没亮，或者星亮了天还是橙的。
    // 注意下界是负值，sstep01((x-a)/(b-a)) 分母为负，所以仰角越低 f 越大，方向是对的。
    const nightFactor = sstep01(0.09, SUN_ELEV_END, elevation)
    // 晨 / 暮分离：同样是低太阳，清晨偏粉、黄昏偏黄。
    // 用 t 与最高点的位置判断「太阳在升还是在落」——
    // 只看仰角分不出晨暮（两者高度一样），必须看方向。
    //   晨光混合度 dawnMix：太阳在上升段（t < SUN_PEAK_AT）且仰角低时最大
    //   暮光混合度 duskMix：下降段，同样低仰角
    const rising = t < SUN_PEAK_AT
    // lowSun：仰角越接近海平线越接近 1（0.21 是最高点，0.0 附近是低空）
    const lowSun = 1 - sstep01(0.01, 0.15, elevation)
    const dawnMix = rising ? lowSun : 0
    const duskMix = rising ? 0 : lowSun
    // 先按昼夜插出「白天的天色」，再按入夜程度往 NIGHT 推。
    // 晨/暮的低仰角段在 DUSK 与 DAWN 之间再插一次，做出「晨粉暮黄」。
    const blend = (a, b, c, f) => {
      const d = mix3(a, b, 1 - daylightFactor)
      return mix3(d, c, f)
    }
    // 低空色板：晨偏 DAWN，暮偏 DUSK，按 dawnMix / duskMix 加权
    const lowSky = (key) => {
      const dawn = DAWN[key], dusk = DUSK[key]
      const w = dawnMix / Math.max(1e-6, dawnMix + duskMix + 1e-6)
      return [
        lerp(dusk[0], dawn[0], w),
        lerp(dusk[1], dawn[1], w),
        lerp(dusk[2], dawn[2], w),
      ]
    }
    const horizon = blend(DAY.horizon, lowSky('horizon'), NIGHT.horizon, nightFactor)
    const zenith  = blend(DAY.zenith,  lowSky('zenith'),  NIGHT.zenith,  nightFactor)
    const deep    = blend(DAY.deep,    lowSky('deep'),    NIGHT.deep,    nightFactor)
    const shallow = blend(DAY.shallow, lowSky('shallow'), NIGHT.shallow, nightFactor)
    const sunCol  = blend(DAY.sun,     lowSky('sun'),     NIGHT.sun,     nightFactor)
    const intensity = lerp(lerp(DUSK.sunIntensity, DAY.sunIntensity, daylightFactor),
                           NIGHT.sunIntensity, nightFactor)
    // 传 t（0..1 的昼夜相位）而不是仰角：月亮轨迹由时间轴驱动，
    // 和 shader 里传给 uDayPhase 的是同一个值。
    const moon = moonEnv(t)
    return {
      sunDir: sunDirection(t),
      sunColor: [sunCol[0] * intensity, sunCol[1] * intensity, sunCol[2] * intensity],
      moonDir: moon.dir,
      moonColor: moon.color,
      horizon,
      zenith,
      deep,
      shallow,
    }
  }

  // 相机固定不动：这是桌面背景，不是可环绕观看的演示页。
  // 原版 Open Sea Skin 让相机绕原点慢转（0.55°/秒）来展示海面立体感，
  // 搬成背景后这个运镜纯属干扰 —— 整个画面会慢慢转，太阳也会被带出视野。
  // 上一帧的相机快照。__ossState() 要用它现算海平线和云底高度，
  // 而不是把每帧的中间结果全存一份（省状态，也避免和渲染路径耦合）。
  let lastCam = null

  function updateCamera() {
    const proj = mat4.perspective(FOV_DEG * Math.PI / 180, W / H, NEAR, FAR)
    const view = mat4.lookAt(CAM_POS, CAM_TARGET, [0, 1, 0])
    return { eye: CAM_POS, viewProj: mat4.mul(proj, view) }
  }

  // 海面是否显示。
  // 关闭后只跳过海面那一次 draw call，天空（太阳/月亮/星星/云）完全不动 ——
  // 这是「只关海洋、天气日月照常」的关键：两者是同一帧里的两个独立绘制，
  // 拆开之后就能把画面让给其他地形/壁纸，而天气系统照常运行。
  let showSea = true

  // 草地显隐 + 两个由客户端推来的场值。
  // 和海面同一个位置：只影响草那一次 draw，天空/云/日月/天气完全不动。
  let showGround = false          // 默认关：开了面板才长草，不偷改现有观感
  let groundPressure = 0.6        // 气压 0..1，低压 → 草趴倒
  let groundFog = 0               // 雾 0..1，来自 __ossAtmos().fog
  // 天气联动：客户端每拍推两个 0..1 的数（见 client 的 pushGround）。
  //   weatherSnow 积雪量：0 = 没雪，1 = 完全盖住
  //   weatherWet  湿润度：0 = 干，1 = 在滴水
  // 草和地面共用这两个值，所以不会出现「草白了地面还是绿的」。
  let weatherSnow = 0
  let weatherWet = 0

  // 天空 + 海面，写到 rtScene。
  // GL 状态约定（下游 sunPass / boltPass / drawBloom 都依赖它）：
  //   进来时状态任意；出去时是「BLEND 关、DEPTH_TEST 关、CULL_FACE 关」。
  //   新加 Pass 要么自己显式设置并还原，要么只依赖这个已知末态，别假设「上一个人刚设过」。
  function drawScene(env, cam) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, rtScene.fb)
    gl.viewport(0, 0, W, H)
    gl.clearColor(0, 0, 0, 1)
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)

    gl.disable(gl.DEPTH_TEST)
    gl.useProgram(pSky)
    gl.uniform3fv(UK.uCamPos, cam.eye)
    gl.uniformMatrix4fv(UK.uInvVP, false, mat4.invert(cam.viewProj))
    gl.uniform2f(UK.uRes, W, H)
    gl.uniform1f(UK.uTime, elapsed)
    gl.uniform1f(UK.uDayPhase, Math.min(1, Math.max(0, daylight / 100)))
    gl.uniform1f(UK.uStarBright, starBright)
    gl.uniform1f(UK.uCloudMask, CLOUD.mask)
    gl.uniform1f(UK.uCloudOpacity, CLOUD.opacity)
    gl.uniform1f(UK.uCloudCondense, CLOUD.condense)
    gl.uniform1f(UK.uCloudUnite, CLOUD.unite)
    gl.uniform1f(UK.uCloudStorm, CLOUD.storm)
    // 风速这一路：
    //   drift = wind * uTime * wspeed，单位是噪声坐标（fbm 一环约 1 个单位）。
    //   wspeed 就是「每秒走多少纹理」。
    //   标定依据：用户实测「30% 就是最快、接近狂风」，所以把满速对齐到那一档：
    //     0%   ≈0.002  500s 一环  几乎静止
    //     50%  ≈0.079  12.7s 一环 明显在飘
    //     100% ≈0.235  4.3s 一环  狂风（用户认可的极限）
    //   曲线用 1.6 次方：低速段留细度，中段开始明显，满速不越界。
    //   超级暴雨联动时 windSpeed 推到 1，云就是满速狂风。
    const windAmount = 0.002 + Math.pow(CLOUD.windSpeed, 1.6) * 0.2331
    gl.uniform3f(UK.uCloudWind, CLOUD.windX, CLOUD.windY, windAmount)
    gl.uniform3fv(UK.uSunDir, env.sunDir)
    gl.uniform3fv(UK.uSunColor, env.sunColor)
    gl.uniform1f(UK.uSunDiscScale, sunPass.params.sunDiscScale)
    gl.uniform1f(UK.uMoonDiscScale, sunPass.params.moonDiscScale)
    gl.uniform3fv(UK.uHorizon, env.horizon)
    gl.uniform3fv(UK.uZenith, env.zenith)
    gl.uniform3fv(UK.uDeep, env.deep)
    gl.drawArrays(gl.TRIANGLES, 0, 3)

    // ---- 海面：只这一段受「显示海面」开关控制 ----
    // 天空已经在上面画完了（含太阳/月亮/星星/云），关掉海面时它保留全部像素，
    // 所以下方不会出现黑块 —— FS_SKY 对每个像素直接算方向颜色，没有海平线裁剪。
    if (showSea) {
      gl.enable(gl.DEPTH_TEST)
      gl.enable(gl.CULL_FACE)
      gl.useProgram(pSea)
    gl.uniformMatrix4fv(US.uViewProj, false, cam.viewProj)
    gl.uniform1f(US.uTime, elapsed)
    gl.uniform1f(US.uDayPhase, Math.min(1, Math.max(0, daylight / 100)))
    // 风联动海况：风速 0..1 映射到倍率。
    // 【原系数 0.65 + 1.1*w 太敏感】
    // 纯自演化模式下 cloudWind 会以 170 秒周期在 0~100 之间漂移，
    // 于是 windGust 在 0.65~1.75 之间来回摆（跨度 2.7 倍），
    // 海况 seaValue 随之被放到 2.2 的硬上限 —— 表现就是「海浪突然变得巨高、看着吓人」。
    // 现在收窄到 0.85 + 0.42*w（范围 0.85~1.27，跨度只有 1.5 倍）：
    //   风大时海面确实更颠，但不会翻倍，自演化过程里观感平稳。
    // clamp 2.2 是硬上限，再高 Gerstner 波峰会自交。
    const windGust = 0.85 + 0.42 * CLOUD.windSpeed
    const seaValue = Math.min((0.25 + (seaState / 100) * 1.5) * windGust, 2.2)
    gl.uniform1f(US.uSea, seaValue)
    gl.uniform1f(US.uDetailScale, 1.5 * (seaValue * 0.6 + 0.4))
    gl.uniform1f(US.uDetailRadius, DETAIL_RADIUS)
    // 海陆雾统一（v2-D）：和草/地/花读同一个 groundFog
    gl.uniform1f(US.uFog, groundFog)
    gl.uniform3fv(US.uCamPos, cam.eye)
    gl.uniform3fv(US.uSunDir, env.sunDir)
    gl.uniform3fv(US.uSunColor, env.sunColor)
    gl.uniform3fv(US.uMoonDir, env.moonDir)
    gl.uniform3fv(US.uMoonColor, env.moonColor)
    gl.uniform1f(US.uSunDiscScale, sunPass.params.sunDiscScale)
    gl.uniform1f(US.uMoonDiscScale, sunPass.params.moonDiscScale)
    gl.uniform3fv(US.uHorizon, env.horizon)
    gl.uniform3fv(US.uZenith, env.zenith)
    gl.uniform3fv(US.uDeep, env.deep)
    gl.uniform3fv(US.uShallow, env.shallow)
    for (let i = 0; i < WAVE_COUNT; i++) {
      gl.uniform2f(US[`uWaveDir[${i}]`], waveDirs[i*2], waveDirs[i*2+1])
      gl.uniform1f(US[`uWaveK[${i}]`],  waveKs[i])
      gl.uniform1f(US[`uWaveC[${i}]`],  waveCs[i])
      gl.uniform1f(US[`uWaveA0[${i}]`], waveA0s[i])
    }
    gl.bindVertexArray(vao)
    gl.drawElements(gl.TRIANGLES, idxCount, gl.UNSIGNED_INT, 0)
    gl.bindVertexArray(null)
    gl.disable(gl.DEPTH_TEST)
    gl.disable(gl.CULL_FACE)
    }

    if (petPass && petPass.ready) {
      try {
        gl.enable(gl.DEPTH_TEST)
        gl.depthFunc(gl.LEQUAL)
        gl.depthMask(true)
        gl.disable(gl.CULL_FACE)
        petPass.draw(cam, petParams, {
          sunColor: env.sunColor,
          moonColor: env.moonColor,
          cloudMask: CLOUD.mask,
          daylight,
        })
        gl.disable(gl.DEPTH_TEST)
      } catch (error) { /* 这一帧画不出来，草照常 */ }
    }

    // ---- 草地：地面底色 + 实例草 ----
    // 排在最后，因为它们要盖在海面之上（草比海面远离/接近相机都可能，靠深度测试决定）。
    // 画完自己还原 GL 状态；grassPass 内部 initOk 会挡住整个 Pass。
    if (grassPass && showGround) {
      try {
        grassPass.draw({
          env,
          cam,
          // 风和云同一个来源：引擎的 CLOUD.windX/windY 就是 stepWind 那一份
          wind: [CLOUD.windX || 0, CLOUD.windY || 0],
          windSpeed: CLOUD.windSpeed,
          // 气压：客户端推过来的 0..1（低压=草趴倒）
          pressure: groundPressure,
          cloudMask: CLOUD.mask,
          // 雾：客户端 __ossAtmos().fog 推过来，0 = 清
          fog: groundFog,
          // ---- 光模块直连：草不自己发明光照，全部读 sunPass 的实时参数 ----
          // 面板上拖「太阳亮度 / 月亮亮度 / 光晕 / 光效开关」，草必须跟着变。
          light: {
            sunScale: sunPass.params.sunDiscScale,        // 太阳亮度
            moonScale: sunPass.params.moonDiscScale,      // 月亮亮度
            glow: sunPass.params.glowIntensity,           // 光晕强度
            global: sunPass.params.effectGlobalScale,     // 光效总开关
            sunColor: env.sunColor,                       // 已含时段强度 + 色温
            moonDir: env.moonDir,                         // 真实月亮方向（不是 -sunDir）
            moonColor: env.moonColor,                     // 月光（夜里草靠它可见）
            horizon: env.horizon,
            zenith: env.zenith,
          },
        }, rtScene.fb)
      } catch (error) {
        console.warn('[OPEN SEA SKIN] grass draw failed', error)
      }
    }

    // ---- 花：独立 Pass，画在草之后 ----
    // 花的 VAO / program / 实例缓冲全是自己的，和草零共享。
    // 它读同一份 env / 风 / 光参数（所以看起来是同一片天），但写不到草的任何状态。
    if (flowerPass && showGround && flowerPass.ready) {
      try {
        flowerPass.draw({
          env,
          cam,
          wind: [CLOUD.windX || 0, CLOUD.windY || 0],
          windSpeed: CLOUD.windSpeed,
          cloudMask: CLOUD.mask,
          fog: groundFog,
          light: {
            sunScale: sunPass.params.sunDiscScale,
            moonScale: sunPass.params.moonDiscScale,
            sunColor: env.sunColor,
            moonDir: env.moonDir,
            moonColor: env.moonColor,
            horizon: env.horizon,
            zenith: env.zenith,
            global: sunPass.params.effectGlobalScale,
          },
        }, rtScene.fb)
      } catch (error) {
        console.warn('[OPEN SEA SKIN] flower draw failed', error)
      }
    }
  }

  // 改动 2：Bloom uniform 收函数
  function setBloomUniforms(prog, tex, dirX, dirY, w, h, radius) {
    gl.useProgram(prog)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.uniform1i(UB.btex, 0)
    gl.uniform2f(UB.bdir, dirX, dirY)
    gl.uniform2f(UB.bres, w, h)
    gl.uniform1f(UB.brad, radius)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  function drawBloom() {
    const bw = Math.max(1, W >> 1), bh = Math.max(1, H >> 1)

    gl.bindFramebuffer(gl.FRAMEBUFFER, rtBright.fb)
    gl.viewport(0, 0, bw, bh)
    gl.useProgram(pBright)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, rtScene.tex)
    gl.uniform1i(UB.tex, 0)
    gl.uniform2f(UB.res, bw, bh)
    gl.uniform1f(UB.thr, BLOOM_THR)
    gl.drawArrays(gl.TRIANGLES, 0, 3)

    gl.bindFramebuffer(gl.FRAMEBUFFER, rtBlurA.fb)
    setBloomUniforms(pBlur, rtBright.tex, 1, 0, bw, bh, BLOOM_RADIUS)

    gl.bindFramebuffer(gl.FRAMEBUFFER, rtBlurB.fb)
    setBloomUniforms(pBlur, rtBlurA.tex, 0, 1, bw, bh, BLOOM_RADIUS)
  }

  function drawComposite() {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, W, H)
    gl.useProgram(pComp)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, rtScene.tex)
    gl.uniform1i(UB.scene, 0)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, rtBlurB.tex)
    gl.uniform1i(UB.bloom, 1)
    gl.uniform2f(UB.cres, W, H)
    gl.uniform1f(UB.str, BLOOM_STR)
    gl.uniform1f(UB.exp, EXPOSURE)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  function adaptResolution(now) {
    frames++
    if (now - winStart >= 500) {
      fps = frames / ((now - winStart) / 1000)
      frames = 0; winStart = now
    }
    if (now - adaptAt >= 2000) {
      adaptAt = now
      if (fps < 30 && renderScale > 0.5) {
        renderScale = Math.max(0.5, +(renderScale * 0.92).toFixed(3)); resize()
      } else if (fps > 55 && renderScale < 1) {
        renderScale = Math.min(1, +(renderScale * 1.05).toFixed(3)); resize()
      }
    }
  }

  //  云循环引擎 —— 与海洋共用同一套天空着色，云量写进 uCloudMask。
  //  状态机与《云循环模块 · 设计稿 v1.0》第二/三/四/六条一致：
  //    凝聚 -> 稳定 -> 消散 -> 空 -> 凝聚，严格单向；
  //    残留按 1/3 速度褪；每帧 ±noiseAmp 的内部扰动。
  const CLOUD = {
    phase: 1,          // 1 = 稳定起步，进页面就有云
    timer: 0,
    // 云自动：true = 状态机自己循环；false = 停在「稳定」不再推进
    // （关掉后云不聚也不散，浓度由 cloudMask 的 level 决定，滑块照样能调）
    auto: true,
    density: 0,
    residual: 0,
    noise: 0,
    mask: 1,           // 写进 uCloudMask 的值
    // 太阳光专用云遮挡：比 mask 更慢（时间常数约 1.2 秒）。
    // 驱动层每 2 秒推一次云量，是阶梯式跳变；直接用 mask 喂光柱，
    // 太阳就会跟着云量一拍一跳 —— 这就是「太阳在闪」的真实来源。
    sunMask: 1,
    // 凝聚时长自动：不对外暴露。
    // 云的寿命。这四个值是「云是活的」和「云是一块布景」的唯一分界。
    //   原值 90 / 150 / 300 / 10 秒 = 一个循环将近 9 分钟。
    //   看三分钟只见它一直趴在天上，和装饰没区别。
    //   现在压到 3 / 8 / 12 / 6 秒 = 29 秒一轮，一个「临时存在」该有的节奏：
    //   长出来、停一会儿、散掉、空一阵，再重来。
    //   注意 cloudStep(dt) 收到的是【未缩放】的 dt（frame() 里 elapsed 才乘 timeScale），
    //   所以时间流速滑杆管不到云 —— 这是有意保留的：云是世界的呼吸，不是可快进的动画。
    growRate: 3,
    stableTime: 8,     // 稳定时长固定（生态法则，不做滑杆）
    fadeRate: 12,      // 消散时长固定（生态法则，不做滑杆）
    emptyHold: 6,      // 空停 6 秒：留白，让玩家意识到「刚才那团没了」
    noiseAmp: 0.02,    // 内部扰动
    amount: 150,       // 云量 0..150（面板滑杆），默认拉满；雷暴态可到 300
    level: -1,         // 面板给的目标云量（0..1）；-1 = 还没初始化，首帧直接跳到目标值
    condense: 0,       // 凝聚度 0..1（面板滑杆），默认 0
    unite: 0,          // 团结度 0..1（面板滑杆），默认 0
    opacity: 1,        // 透明度 0..1（面板滑杆），0 = 全透明，1 = 最实
    windSpeed: 1,      // 风速 0..1（面板滑杆），默认 1 = 拉满
    storm: 0,          // 雷暴隐藏态 0..1：只压暗云色，不改云形（面板滑杆没有这一项）
    // 风向不暴露：用一条平滑的连续曲线漂移，不是「一阵一阵换目标」。
    // 两个不同频率的正弦叠加 → 方向连续变化、永不急停，云看起来是一直被一股风推着走。
    windPhase: 0,      // 风向相位，匀速累积
  }

  // 风向：连续曲线，没有目标/缓动，不会一阵一阵。
  //   x = sin(a) + 0.4*sin(b)，y = cos(c) + 0.3*sin(d)，四项频率互质 → 永不重复、无突变。
  //   相位匀速推进（windPhase），所以风是「匀速地慢慢转向」，不是突然换向。
  //
  // 【气压接管：外部给的梯度方向优先】
  // 客户端每拍可以从气压场算出梯度（风从高压吹向低压），通过 __ossWindField 推进来。
  // 一旦有外部方向，就用它代替上面的正弦曲线 —— 这样风、云、草、海面
  // 全部由同一个气压场驱动，而不是各走各的。
  // 没有外部方向（气压场还没起来）时，退回原来的正弦曲线，行为不变。
  let extWindX = NaN, extWindY = NaN
  function stepWind(dt) {
    if (Number.isFinite(extWindX) && Number.isFinite(extWindY)) {
      // 指数平滑跟随：气压梯度每拍都在变，直接赋值会让风抖
      const k = Math.min(1, dt * 0.8)
      CLOUD.windX += (extWindX - CLOUD.windX) * k
      CLOUD.windY += (extWindY - CLOUD.windY) * k
      return
    }
    CLOUD.windPhase += dt * 0.045
    const p = CLOUD.windPhase
    CLOUD.windX = Math.sin(p) * 0.7 + Math.sin(p * 2.37 + 1.1) * 0.3
    CLOUD.windY = Math.cos(p * 0.83 + 0.5) * 0.55 + Math.sin(p * 1.71) * 0.25
  }

  // 凝聚时长自动：消散越久，云聚得越从容；消散很短，云要快点成型。
  // 这样四个阶段彼此成比例，循环读起来像一个整体，而不是四个各拧各的旋钮。
  //   fade 600s → gather ≈ 200s；fade 10s → gather ≈ 20s
  function autoGather() {
    // 凝聚时长跟着消散走（1/3），但下限收到 4 秒：
    //   cloudBase 这一版把消散压到 12 秒，原来的 18 秒下限会让「凝聚」比「消散」还慢，
    //   云刚长满就被吹散，看起来像坏掉而不是活着。
    const f = Math.max(6, CLOUD.fadeRate)
    return Math.max(4, Math.min(240, f * 0.33))
  }

  // 凝聚度对云量的加成：0 → 0.85，1 → 1.15。
  // 下限给到 0.85，是因为「云量拉满」本身就该是你要的那种满天，
  // 凝聚度只是在这个基础上再加厚一点，而不是把它压回去。
  function condenseScale() {
    return 0.85 + 0.30 * Math.max(0, Math.min(1, CLOUD.condense))
  }

  function cloudStep(dt) {
    CLOUD.timer += dt
    CLOUD.noise += (Math.random() - 0.5) * 0.1
    CLOUD.noise *= 0.95
    const noise = CLOUD.noise * CLOUD.noiseAmp

    // 凝聚时长自动跟随消散节奏（不再由面板调）
    CLOUD.growRate = autoGather()
    // 云量 0..300 → 0..2.0（隐藏态翻倍）。
    //   0    → 无云
    //   150  → 1.0（面板滑杆的顶）
    //   300  → 2.0（超级暴雨：遮罩翻倍，天空几乎全被黑云压住）
    // 凝聚度的作用改成「只补低云量段」：低云量时把云拉厚一点，高云量不再叠加，
    // 这样 150 稳定等于 1.0，翻倍才真的翻得出来。
    const amt = Math.max(0, Math.min(CLOUD_AMOUNT_MAX, CLOUD.amount))
    const amtLevel = Math.pow(amt / 150, 0.85)
    const thicken = 1 + (condenseScale() - 1) * (1 - Math.min(1, amtLevel))
    const target = Math.max(0, Math.min(2, amtLevel * thicken))
    // 缓动逼近，避免拉滑杆时画面跳变；首帧（level<0）直接到位，不让开场没有云。
    if (CLOUD.level < 0) { CLOUD.level = target; CLOUD.sunMask = CLOUD.mask }
    else CLOUD.level += (target - CLOUD.level) * Math.min(1, dt * 2.5)

    let base
    if (!CLOUD.auto) {
      // 云自动关掉：状态机不再推进，直接钉在「稳定」（基值 1）。
      // 云停在当前浓度，只跟着云量滑杆变，不会自己散掉也不会自己聚回来。
      // CLOUD.timer 不清零：重新打开时从停下的地方接着走。
      base = 1
    } else {
      switch (CLOUD.phase) {
        case 0: // 凝聚
          base = Math.min(1, CLOUD.timer / CLOUD.growRate)
          if (CLOUD.timer >= CLOUD.growRate) { CLOUD.phase = 1; CLOUD.timer = 0 }
          break
        case 1: // 稳定
          base = 1
          if (CLOUD.timer >= CLOUD.stableTime) { CLOUD.phase = 2; CLOUD.timer = 0 }
          break
        case 2: // 消散
          base = Math.max(0, 1 - CLOUD.timer / CLOUD.fadeRate)
          CLOUD.residual = Math.min(0.2, CLOUD.residual + dt * 0.005)
          if (CLOUD.timer >= CLOUD.fadeRate) { CLOUD.phase = 3; CLOUD.timer = 0 }
          break
        default: // 空
          base = 0
          if (CLOUD.residual > 0) {
            // 残留以 1/3 速度褪尽，褪到 0 才回「空」
            CLOUD.residual = Math.max(0, CLOUD.residual - dt * (0.2 / (CLOUD.fadeRate * 3)))
          } else if (CLOUD.timer >= CLOUD.emptyHold) {
            CLOUD.phase = 0; CLOUD.timer = 0
          }
          break
      }
    }
    CLOUD.density = Math.max(0, Math.min(1, base + noise))
    // 写进 uCloudMask = 本阶段浓度 × 云量基准（CLOUD.level）
    // level=0 时 mask 也是 0（无云）；level=1 且稳定期时 mask=1（满天）。
    // 上限放到 2：超级暴雨时 level 可以到 2，遮罩跟着翻倍（以前钳在 1，翻倍白翻）。
    const shaped = CLOUD.density * CLOUD.level
    // mask 本身就是云的「真实浓度」，天空着色器靠它决定云盖住多少天。
    // 它必须每帧直接到位 —— 这里如果加低通，云会从初值 1 慢慢往下滑，
    // 夜里天空会长期挂着云，月亮和星星就被一直盖住（修太阳时踩过这个坑）。
    CLOUD.mask = Math.max(0, Math.min(2, shaped + CLOUD.residual * 0.5))
    // 光柱专用云遮挡：只有它做低通（时间常数约 1.2 秒）。
    // 驱动层每 2 秒推一次云量是阶梯跳变，光柱直接读 mask 会跟着一跳一跳，
    // 看着就是「太阳在闪」。低通只留在这一条链路上，不影响天空本身的云。
    CLOUD.sunMask += (CLOUD.mask - CLOUD.sunMask) * Math.min(1, dt * 0.85)
  }

  // 一帧的全部工作。顺序是硬约束，新模块插进来前先读这一段：
  //   cloudStep → stepWind → [自动昼夜] → updateSun → updateCamera
  //   → drawScene → sunPass → boltPass → drawBloom → drawComposite
  //   状态机先跑，sun/cam 后算，所有 Pass 共用同一帧的 env 和 cam。
  //   任何 Pass 里都不重新算太阳或相机 —— 否则同一帧会出现两个太阳方向。
  //   加法叠加的 Pass（sunPass / boltPass）必须在 drawBloom 之前，
  //   它们加的亮度才会被 bloom 提取，否则只是死白。
  function frame(now) {
    if (stopped) return
    const dt = Math.min((now - last) / 1000, 0.1)
    last = now
    // 场景时间：所有自走动画的唯一时间源，由时间流逝倍率缩放。
    // 海浪、云漂移、泡沫、星空旋转都读 elapsed，所以一处乘系数就全部联动。
    elapsed += dt * timeScale

    // ---- 云循环引擎：状态机每帧推进一次，结果写进 uCloudMask ----
    // 【云也吃时间流速】
    // 原来这里传的是未缩放的 dt，理由是「云是世界的呼吸，不是可快进的动画」。
    // 但那条理由只在「玩家只调天气」时成立 —— 一旦有了主体和调度器，
    // 时间流速就是整个世界的时间轴，云不跟就是脱节。
    // 钳上限 8：timeScale 最大 10，云的状态机在 dt 太大时会跳帧，
    // 8 倍足够看出「快进」，又不至于让长-散循环一路瞬移过去。
    cloudStep(Math.min(dt * timeScale, dt * 8))
    stepWind(dt)

    // 自动昼夜：一个 0..1 的相位，逐帧累加，走过 1 就回绕。
    // autoCycle = false 时这段不跑，daylight 完全由面板滑杆接管。
    if (autoCycle) {
      const tNow = performance.now()
      // 首帧或从手动切回来时初始化时间基准
      if (lastAutoNow === 0) lastAutoNow = tNow
      const dtMs = tNow - lastAutoNow
      lastAutoNow = tNow
      // 后台唤醒会让 dt 变成好几分钟，直接跳过这段时间，不补帧
      if (dtMs > 0 && dtMs < 5000) {
        // 昼夜也挂靠同一个时间流逝倍率：拨快时太阳月亮一起飞转，
        // 拨慢时整个昼夜变慢动作。
        const cycleSeconds = CYCLE_SECONDS_BASE / Math.max(0.05, timeScale)
        autoPhase = (autoPhase + (dtMs / 1000) / cycleSeconds) % 1
        daylight = autoPhase * 100
      }
    } else {
      // 切回手动：相位归零，下次开自动从起点重新走
      lastAutoNow = 0
      autoPhase = 0
    }

    const env = updateSun()
    const cam = updateCamera()
    lastCam = cam

    drawScene(env, cam)
    // ---- 太阳光束：固定插在 drawScene 之后、drawBloom 之前 ----
    // 参数字典传入，模块内不裸读 env / CLOUD / cam。
    {
      const sunDir = env.sunDir
      // 地平线因子：宿主没有可复用的 glitter 判定（它写死在 FS_SEA 里），
      // 按同一物理量重建：sin(仰角) = sunDir.y。0 = 地平线下，≈0.10（6°）= 全亮。
      const elevation = Math.max(0, Math.min(1, sunDir[1]))
      const horizonFactor = elevation <= 0 ? 0 : Math.min(1, elevation / 0.10)

      // 太阳屏幕坐标：必须用正向 viewProj。shader 里只有逆矩阵，反向算是错的。
      const vp = cam.viewProj
      const wx = cam.eye[0] + sunDir[0] * 10000
      const wy = cam.eye[1] + sunDir[1] * 10000
      const wz = cam.eye[2] + sunDir[2] * 10000
      const cw = vp[3] * wx + vp[7] * wy + vp[11] * wz + vp[15]
      let sunUV = [0.5, 0.5]
      if (Math.abs(cw) > 1e-6) {
        const cx = vp[0] * wx + vp[4] * wy + vp[8] * wz + vp[12]
        const cy = vp[1] * wx + vp[5] * wy + vp[9] * wz + vp[13]
        sunUV = [(cx / cw) * 0.5 + 0.5, (cy / cw) * 0.5 + 0.5]
      }

      sunPass.draw({
        sunDir: env.sunDir,
        sunColor: env.sunColor,
        // 光柱用 sunMask（比 mask 慢一层）：驱动层每 2 秒推云量是阶梯跳变，
        // 直接用 mask 会让光柱跟着一跳一跳，看起来就是「太阳在闪」。
        cloudMask: CLOUD.sunMask,
        horizonFactor,
        sunUV,
        // 海平线在屏幕上的 uv.y（每帧按相机与 FOV 现算，抽成函数是为了让
        // __ossState() 也能读到 —— 雾层要用它做高度基准，不能按屏幕比例硬绑）。
        horizonUV: computeHorizonUV(cam),
        renderScale,
      }, rtScene.fb)
    }
    drawBloom()
    drawComposite()
    // 闪电 Pass：没在闪的时候 boltPass.draw 第一行就 return，零开销。
    // 必须放在 drawComposite 之后、画到默认 framebuffer：
    // 叠进 rtScene 会被后面的 aces() 压成一条看不见的线（这就是「开关能点、从不闪」）。
    if (boltPass && boltPass.ready) boltPass.draw(null)

    // ---- 大肥鱼：和闪电同一个位置（默认 framebuffer、不进 ACES）----
    // 它是角色，不是场景元素：颜色应当和立绘一致，不该被色调映射压暗。
    // 相机是固定的，所以固定世界坐标的四边形在屏幕上位置稳定，
    // 但它仍然跟 FOV、分辨率、相机一起走 —— 这就是「在空间里」。
    if (petPass && petPass.ready) {
      // 【位移有两种走法】
      //   A. 定时走（petMoveDur > 0）：按剩余距离 / 剩余时间算瞬时速度。
      //      动作素材是 10 秒、不带位移，所以必须由引擎把这 10 秒走满 ——
      //      跑动和位移同步，才不会「跑了 1 秒就到、剩下 9 秒原地跑」。
      //      用「剩余/剩余」而不是固定速度：中途被改目标也能平滑接上，
      //      最后几帧也不会冲过头。
      //   B. 自由走（petMoveDur = 0）：按基础速度逼近。用于没有动作配合的位移
      //      （比如贴玻璃站几秒后退回去）。
      const dx = petMoveTarget.x - petParams.x
      const dz = petMoveTarget.z - petParams.z
      if (petMoveDur > 0) {
        const k = Math.min(1, dt / Math.max(0.016, petMoveDur))
        petParams.x += dx * k
        petParams.z += dz * k
        petMoveDur -= dt
        if (petMoveDur < 0.02) petMoveDur = 0
        if (Math.abs(dx) < 1e-3) petParams.x = petMoveTarget.x
        if (Math.abs(dz) < 1e-3) petParams.z = petMoveTarget.z
      } else {
        // 两个轴分开限速，才不会有「斜着冲刺」的观感
        if (Math.abs(dx) > 1e-3) {
          petParams.x += Math.sign(dx) * Math.min(Math.abs(dx), dt * 1.6)
        }
        if (Math.abs(dz) > 1e-3) {
          petParams.z += Math.sign(dz) * Math.min(Math.abs(dz), dt * 0.9)
        }
      }
    }

    if (!started) {
      started = true
      document.body.classList.add('ready')
      canvas.style.opacity = '1'
    }

    adaptResolution(now)
    if (!stopped) rafId = requestAnimationFrame(frame)
  }

  const onMessage = (ev) => {
    if (stopped) return
    if (ev.source !== window.parent) return
    if (PARENT_ORIGIN && ev.origin !== PARENT_ORIGIN) return
    const d = ev.data
    if (!d || d.type !== 'oss-set') return
    // 这条通道只剩海洋自己的两个量（波浪、日光）。
    // 云的参数走 window.__ossCloudSet 直连，不再绕消息 —— 面板和引擎本来就同源。
    // d.auto === true 表示"自动昼夜开"
    if ('auto' in d) {
      const wasAuto = autoCycle
      autoCycle = d.auto === true
      // 从手动切回自动：重新对齐时间基准，相位从 0 重新走
      if (autoCycle && !wasAuto) { lastAutoNow = 0; autoPhase = 0 }
    }
    const s = Number(d.sea), tt = Number(d.t)
    if (Number.isFinite(s) && s >= 0 && s <= 100) seaState = s
    if (Number.isFinite(tt) && tt >= 0 && tt <= 100) daylight = tt
  }
  window.addEventListener('message', onMessage)

  // 把真正的停表函数交给外面的清理入口：停 raf、摘 message 监听、摘 resize 监听。
  // 这样插件被关掉、或者这份脚本被重新执行时，旧实例不会继续抢 GPU。
  installDispose(
    () => {
      stopped = true
      if (rafId) cancelAnimationFrame(rafId)
      // 先停光效再删 program：销毁后 draw 会被 stopped / enabled 两道守卫挡住
      try { sunPass.dispose() } catch (error) { /* 已经释放 */ }
      try { if (boltPass) boltPass.dispose() } catch (error) { /* 已经释放 */ }
      // 草的 program / buffer / VAO 也要一起走，否则关掉插件后它们还留在显存里
      try { if (grassPass) grassPass.dispose() } catch (error) { /* 已经释放 */ }
      grassPass = null
      // 花也有自己的一套资源，同样要释放
      try { if (flowerPass) flowerPass.dispose() } catch (error) { /* 已经释放 */ }
      flowerPass = null
      // 大肥鱼的 program / VAO / 纹理同样要带走
      try { if (petPass) petPass.dispose() } catch (error) { /* 已经释放 */ }
      petPass = null
    },
    () => {
      window.removeEventListener('message', onMessage)
      window.removeEventListener('resize', resize)
    }
  )

  //  引擎 ↔ 客户端接口总表（window.__oss*）
  //  客户端在另一份文件、另一层（Canvas 2D），只能通过这些函数联动。
  //  新增模块时改这里，别在别处另开通道。
  //    推（客户端 → 引擎）          读（引擎 → 客户端）
  //    __ossSeaSet  波浪/日光/自动   __ossState  全量状态（排查用）
  //    __ossCloudSet 云的五项        __ossCloud  云量，雨雪按它调密度
  //    __ossSunSet  太阳亮度/光晕    __ossSun    太阳参数
  //    __ossBoltSet 闪电（每帧）     __ossWind   风，雨雪与之同源
  //                                  __ossBoltActive 闪电 WebGL 是否可用
  //  约定：
  //    · 引擎可能尚未加载 → 客户端一律 typeof 检查后再调；引擎侧被调用前必做入参校验。
  //    · 全部走直连，不用 postMessage（同源同页，消息通道的 source/origin 校验是纯负担）。
  //    · 推过来的值在引擎内再钳一次，客户端换算不算数。

  // 闪电：客户端每帧推状态过来。
  //   segments: [{ pts: [[x,y],...], width, intensity, color? }]，坐标为屏幕 uv（0..1，y 向上）
  //   flash:    全屏闪光强度 0..1
  //   origin:   闪击点 uv，全屏辉光从这里衰减
  // 传 null 表示当前没有闪电，Pass 直接跳过（零开销）。
  window.__ossBoltSet = (state) => {
    if (boltPass && boltPass.ready) boltPass.setState(state)
  }
  // 告诉客户端 WebGL 闪电通道是否真的可用：不可用时客户端走 2D 兜底。
  window.__ossBoltActive = !!(boltPass && boltPass.ready)

  // 波浪 / 日光 / 自动昼夜 直连入口，和云、太阳一样不走 postMessage。
  //   auto: true  → 自动昼夜开（引擎跑 daylight 循环）
  //   auto: false → 手动锁定（松开循环，用面板给的 t）
  window.__ossSeaSet = (v) => {
    if (!v || typeof v !== 'object') return
    // v.auto === true 表示"自动昼夜开"
    if ('auto' in v) {
      const wasAuto = autoCycle
      autoCycle = v.auto === true
      // 从手动切回自动：重新对齐时间基准，相位从 0 重新走
      if (autoCycle && !wasAuto) { lastAutoNow = 0; autoPhase = 0 }
    }
    if (Number.isFinite(v.sea)) seaState = Math.max(0, Math.min(100, v.sea))
    if (Number.isFinite(v.t)) daylight = Math.max(0, Math.min(100, v.t))
    // 时间流逝倍率。只存值，不碰相位 —— 改速度时让相位按新速率继续走，
    // 不会因为拖滑杆而让太阳跳位置。
    if (Number.isFinite(v.timeScale)) {
      timeScale = Math.max(0.05, Math.min(20, v.timeScale))
    }
  }

  // 海平线在屏幕上的 uv.y（0 = 屏幕顶，1 = 屏幕底）。
  // 相机与 FOV 变化时自动跟着变，所以雾层用它当高度基准，
  // 不要用「屏幕高度的百分比」—— 换分辨率或改 FOV 就会错位。
  function computeHorizonUV(cam) {
    const fwd = [CAM_TARGET[0] - cam.eye[0], CAM_TARGET[1] - cam.eye[1], CAM_TARGET[2] - cam.eye[2]]
    const flen = Math.hypot(fwd[0], fwd[1], fwd[2]) || 1
    const pitch = Math.asin(Math.max(-1, Math.min(1, -(fwd[1] / flen))))
    const tanHalf = Math.tan((FOV_DEG * Math.PI / 180) / 2)
    const ndcY = Math.tan(pitch) / tanHalf
    return Math.max(0, Math.min(1, ndcY * 0.5 + 0.5))
  }

  // 云底在屏幕上的 uv.y。雾要和云底平滑衔接，就需要知道云层从哪开始。
  // 云层在方向空间的可用带是 d.y ∈ [0.015, 0.95]（见 SKY_GLSL 里 band 的定义），
  // 取它的下边界 0.015 投影到屏幕：视线方向 y 分量等于 sin(仰角)，
  // 反算到屏幕 uv 就是「相对于海平线抬高多少」。
  // 拿不到相机信息时返回 -1，调用方据此退化为「不做衔接」。
  function computeCloudBaseUV(cam) {
    try {
      const horizon = computeHorizonUV(cam)
      const tanHalf = Math.tan((FOV_DEG * Math.PI / 180) / 2)
      // 云底仰角约 asin(0.015) ≈ 0.015 rad，极小，直接线性近似
      const ndcOffset = Math.tan(0.015) / tanHalf
      // ndc 向上为正，屏幕 uv 向下为正，所以是减
      return Math.max(0, Math.min(1, horizon - ndcOffset * 0.5))
    } catch (error) {
      return -1
    }
  }

  // 全局风：云的 stepWind 是唯一风源，雨和雪都读这里，三者在同一个天气里。
  //   x/y: 风向分量（约 -1..1），客户端用它决定雨丝斜度和雪片横漂
  //   speed: 风速 0..1，由云的风速滑杆决定
  // 海面显隐：只影响海面那一次 draw call，天空/日月/星星/云/天气全部照常。
  // 关掉海面后这块画面就是完整的天空，其他地形或壁纸可以直接画在自己的层上。
  window.__ossSeaVisible = (on) => { showSea = !!on; return showSea }
  window.__ossSeaState = () => ({ showSea })

  // 草地：显隐 + 两个场值（气压、雾）。和海面同一个形状，客户端不用区分。
  window.__ossGroundVisible = (on) => { showGround = !!on; return showGround }
  window.__ossGroundSet = (v) => {
    if (!v || typeof v !== 'object') return
    if (Number.isFinite(v.pressure)) groundPressure = Math.max(0, Math.min(1, v.pressure))
    if (Number.isFinite(v.fog)) groundFog = Math.max(0, Math.min(1, v.fog))
    // 天气联动：积雪量 / 湿润度，草和地面共用
    if (Number.isFinite(v.snow)) weatherSnow = Math.max(0, Math.min(1, v.snow))
    if (Number.isFinite(v.wet)) weatherWet = Math.max(0, Math.min(1, v.wet))
    if (typeof v.enabled === 'boolean') showGround = v.enabled
    // 参数按字段分发给各自的 Pass：
    //   density → grassPass（草密度）
    //   flower  → flowerPass（花密度）
    // 两个 Pass 各有自己的 params setter，互不干扰。
    if (v.params && typeof v.params === 'object') {
      const p = v.params
      if (grassPass && Number.isFinite(p.density)) grassPass.params = { density: p.density }
      if (flowerPass && Number.isFinite(p.flower)) flowerPass.params = { density: p.flower }
      if (typeof p.enabled === 'boolean' && flowerPass) flowerPass.params = { enabled: p.enabled }
    }
  }
  window.__ossGround = () => ({
    showGround,
    pressure: groundPressure,
    fog: groundFog,
    grass: grassPass ? grassPass.params : null,
  })

  window.__ossWind = () => ({
    x: CLOUD.windX,
    y: CLOUD.windY,
    speed: CLOUD.windSpeed,
    // true 表示当前风向由气压梯度驱动（不是内部正弦曲线）
    fromPressure: Number.isFinite(extWindX) && Number.isFinite(extWindY),
  })

  // 气压场 → 风向。客户端每拍把「全场气压梯度加权后的主导方向」推进来，
  // 引擎就用它代替内置的正弦曲线，于是风、云、草、海面全部同一个来源。
  // 传 null / 非法值 = 交还给内置曲线。
  // ⚠ 名字不能叫 __ossWindField —— 客户端已经用那个名字发布【整张风场】给雨雪采样，
  //    同名会被覆盖。这里用 __ossWindDir，语义也更准确（只是方向）。
  window.__ossWindDir = (x, y) => {
    if (Number.isFinite(x) && Number.isFinite(y) && (x !== 0 || y !== 0)) {
      extWindX = x
      extWindY = y
    } else {
      extWindX = NaN
      extWindY = NaN
    }
    return { fromPressure: Number.isFinite(extWindX) }
  }

  window.__ossState = () => ({
    sea: seaState, daylight, elapsed, autoCycle, renderScale, fps,
    // 排查自动昼夜：autoCycle 必须是勾选状态；elapsed 必须一直增长；
    // daylight 在 autoCycle=true 时应随 elapsed 变化。
    autoOn: autoCycle,
    qAuto: Q.get('auto'),
    cloud: { phase: CLOUD.phase, density: CLOUD.density, mask: CLOUD.mask, residual: CLOUD.residual, amount: CLOUD.amount },
    // 雾模块要的两个几何量（屏幕 uv，0 = 顶，1 = 底）：
    //   horizonUV  海平线高度 —— 雾层从它往下铺，不用屏幕百分比硬绑
    //   cloudBase  云底高度 —— 雾的上边界不能越过它，否则会和云硬接
    // 拿不到相机时 cloudBase 返回 -1，调用方据此跳过衔接。
    horizonUV: lastCam ? computeHorizonUV(lastCam) : 0.5,
    cloudBase: lastCam ? computeCloudBaseUV(lastCam) : -1,
  })
  // 供面板直接读取当前云量（第八条 getCover）
  window.__ossCloud = () => ({ phase: CLOUD.phase, density: CLOUD.density, mask: CLOUD.mask, residual: CLOUD.residual })

  // 面板直接调这个改云，不再走 postMessage 绕一圈。
  // 参数和以前面板发的字段同名同义，只是少了一次消息往返。
  window.__ossCloudSet = (v) => {
    if (!v || typeof v !== 'object') return
    if (v.enabled === false) {
      // 关掉云：遮罩清零，天空回到没有云的样子；滑杆的值由面板自己留着
      CLOUD.amount = 0
      return
    }
    if (Number.isFinite(v.amount)) CLOUD.amount = Math.max(0, Math.min(CLOUD_AMOUNT_MAX, v.amount))
    if (Number.isFinite(v.density)) CLOUD.condense = Math.max(0, Math.min(100, v.density)) / 100
    if (Number.isFinite(v.unite)) CLOUD.unite = Math.max(0, Math.min(100, v.unite)) / 100
    if (Number.isFinite(v.opacity)) CLOUD.opacity = Math.max(0, Math.min(100, v.opacity)) / 100
    if (Number.isFinite(v.wind)) CLOUD.windSpeed = Math.max(0, Math.min(100, v.wind)) / 100
    // 雷暴隐藏态：0..1，只改云色深浅，不改形状。面板正常不会传这一项。
    if (Number.isFinite(v.storm)) CLOUD.storm = Math.max(0, Math.min(1, v.storm))
    // 云自动：true 让云循环，false 停在当前浓度
    if (typeof v.auto === "boolean") CLOUD.auto = v.auto
  }

  // 太阳光效：面板直连读写口，和云一样不走消息。
  // setter 内部已有逐项钳位，面板传原始值即可。
  window.__ossSunSet = (v) => {
    if (!v || typeof v !== 'object') return
    const patch = {}
    for (const k of ['glowIntensity', 'glowRadius', 'sunDiscScale', 'moonDiscScale', 'godrayIntensity', 'godrayScatter', 'godraySteps', 'effectGlobalScale']) {
      if (Number.isFinite(v[k])) patch[k] = v[k]
    }
    sunPass.params = patch
  }
  window.__ossSun = () => sunPass.params

  // 星星亮度 0..1。面板一个滑杆同时控制亮度和能看到的星星数量。
  window.__ossStarSet = (v) => {
    if (Number.isFinite(v)) starBright = Math.min(1, Math.max(0, v))
  }
  window.__ossStar = () => starBright

  // ---- 大肥鱼的两个入口 ----
  // 纹理走这里：客户端先把视频帧抠成透明 canvas，再整张交进来。
  // 传 null 表示「这一帧没有东西可画」，Pass 会退回一个淡淡的占位轮廓。
  // 为什么不在引擎里做抠图：抠图要 getImageData/putImageData，
  // 那是 2D canvas 的活；引擎手里只有 WebGL 上下文。分工在 PET-INTEGRATION.md
  // 里已经定死，这里只负责「贴到 3D 四边形上」。
  window.__ossPetTexture = (source) => {
    if (!petPass || !petPass.ready) return false
    // null = 主体被关掉了。清空纹理源，这个 Pass 就什么都不画 ——
    // 比“传一张全透明的图”省一半开销，也不用让客户端造一张假图。
    if (!source) { petPass.clear(); return false }
    try {
      petPass.upload(source, source.width || 0, source.height || 0)
      return true
    } catch (error) {
      console.error(PET_PASS_LOG, 'texture upload failed', error)
      return false
    }
  }
  // 朝向与抬起：flip = 1 面朝左（side.png 原样），-1 面朝右。
  window.__ossPetSet = (v) => {
    if (!v || typeof v !== 'object') return
    if (Number.isFinite(v.flip)) petParams.flip = v.flip < 0 ? -1 : 1
    if (Number.isFinite(v.aspect)) petParams.aspect = Math.max(0.4, Math.min(2.0, v.aspect))
    if (Number.isFinite(v.lift)) petParams.lift = Math.max(-2, Math.min(3, v.lift))
  }
  window.__ossPet = () => ({ ready: !!(petPass && petPass.ready), flip: petParams.flip, aspect: petParams.aspect, lift: petParams.lift })

  // 大肥鱼的横向位置（世界坐标 x，米）。
  // 客户端不直接改 petParams —— 位置要平滑，所以这里给的是「目标」，
  // 由引擎每帧逼近（见 frame() 里的插值）。客户端只管下命令，不管插值。
  //
  // 两个参数：
  //   x  横向偏移（米）。视线水平半视野随 z 变，所以这里不写死 ±3.2，
  //      而是在插值时按当前 z 算一个可见宽度再钳 —— 走近了也能走到边上。
  //   z  距离偏移（米）。正 = 后退（变小），负 = 靠近（变大）。
  //      实际 z = PET_POS[2] + 偏移；PET_POS[2] = 8.5，所以可走 5..14 米。
  // duration = 位移时长（秒）。传了就按「这段时间内准点到」走 ——
  // 和动作素材对齐用（素材都是 10 秒）。不传就按基础速度自由走。
  window.__ossPetMove = (x, z, duration) => {
    if (Number.isFinite(x)) petMoveTarget.x = x
    // z 是【距离相机的米数】，不是世界 z。范围 2.8 ~ 55 米。
    //   近端 2.8 米：再近就只剩一块颜色，虚化也救不回来。
    //   远端 55 米：那是「天边」，屏高约 4%，看不清脸朝哪边 ——
    //   不用换背影素材，光靠距离它就「不看着你」了。
    if (Number.isFinite(z)) petMoveTarget.z = Math.max(2.8, Math.min(55, z))
    petMoveDur = Number.isFinite(duration) && duration > 0 ? duration : 0
    return { x: petMoveTarget.x, z: petMoveTarget.z, dur: petMoveDur }
  }
  window.__ossPetPos = () => ({ x: petParams.x, z: petParams.z })
  // 纯只读：当前目标是什么。没有副作用。
  // 【为什么必须单独开一个】__ossPetMove 是「下命令」，它顺带会把 petMoveDur
  // 重置成 0。之前调度器为了判断「在不在走」，拿 __ossPetMove(当前值) 去读目标，
  // 每次读都等于取消掉正在进行的定时位移 —— 于是「走 10 秒」被打断成自由走，
  // 人停在原地跑，只有后退（z 增大）还在慢慢动。
  window.__ossPetTarget = () => ({ x: petMoveTarget.x, z: petMoveTarget.z })

  // 某个纵深下，横向能走多远（米）。
  // 客户端据此决定「这次往哪走」—— 它就是透视本身：
  //   近处视野窄，横向最多走两三米就到边；远处视野宽，能走十几米。
  // 余量按「角色本身有多宽」算，不是拍一个数：
  //   角色世界高度 2.5 米、宽高比约 0.86 → 半宽约 1.1 米；
  //   再加 0.4 米呼吸空间。原来减 1.0 是按瘦角色算的，
  //   结果贴玻璃时（z=3 米）走到 ±1.8 米就已经半身在画外。
  // 水平半视角 42.8°（FOV 55° 垂直、16:9 宽屏推出来的），tan ≈ 0.926。
  window.__ossPetHalfWidth = (z) => {
    // z 参数本身就是距离相机的米数，直接用，不用再换算。
    const dist = Number.isFinite(z) ? z : 8.5
    const view = Math.abs(dist) * 0.926
    // 角色世界半宽固定 1.1 米（PET_HEIGHT * aspect / 2 ≈ 1.1），
    // 世界尺寸不随距离变，只是它在屏幕上占的比例变。
    const bodyHalf = 1.1
    return Math.max(0.4, view - bodyHalf - 0.4)
  }

  // 角色头顶在屏幕上的像素坐标。给 DOM 用（梦境面板要浮在鱼头上）。
  // 全部走已有的只读接口取值，不直接读 createPetPass 内部的 PET_POS / CAM_TO_PET
  // （那两个是那个函数作用域里的 const，外面拿不到）。
  // 与 petPass 绘制里「世界坐标 → 投影」用的是同一套矩阵和同一套换算：
  //   世界 x = petParams.x（横向偏移）
  //   世界 z = 8.5 - (dist - 8.5)，dist 由 __ossPetPos 给出
  //   worldY = 地形高度 + 0.05 + lift
  window.__ossPetScreen = (lift) => {
    if (!lastCam) return null
    const pos = petParams ? { x: petParams.x, z: petParams.z } : null
    if (!pos) return null
    const PET_BASE_Z = 8.5, PET_BASE_DIST = 8.5, PET_Y = 0.05
    const wx = pos.x
    const wz = PET_BASE_Z - (pos.z - PET_BASE_DIST)
    const wy = petTerrainHeight(wx, wz) + PET_Y + (Number.isFinite(lift) ? lift : 1.6)
    const m = lastCam.viewProj
    const cx = m[0] * wx + m[4] * wy + m[8] * wz + m[12]
    const cy = m[1] * wx + m[5] * wy + m[9] * wz + m[13]
    const cw = m[3] * wx + m[7] * wy + m[11] * wz + m[15]
    if (!(cw > 0.001)) return null
    // viewProj 输出的是 NDC（-1..1），换算成 CSS 像素。
    return {
      x: ((cx / cw) * 0.5 + 0.5) * (window.innerWidth || 0),
      y: (1 - ((cy / cw) * 0.5 + 0.5)) * (window.innerHeight || 0),
    }
  }

  // 屏幕像素 → 地面世界坐标。壁纸模式下点地面让鱼走过去要用它。
  //
  // 做法：把屏幕点还原成 NDC，用逆 viewProj 反投影出射线的两个点（近平面 / 远平面），
  // 求这条射线与 y = 地面高度 的交点。地面不是平的（有地形起伏），
  // 所以用「先按平均高度求交、再用该点真实地形高度迭代两次」逼近 ——
  // 起伏只有 ±1 米，两次就够，比精确求交便宜得多。
  //
  // 返回 { x, z }（世界坐标）。点在天空上（射线向上）时返回 null。
  window.__ossScreenToGround = (sx, sy) => {
    if (!lastCam) return null
    const W = window.innerWidth || 1, H = window.innerHeight || 1
    const ndcX = (sx / W) * 2 - 1
    const ndcY = 1 - (sy / H) * 2
    const inv = mat4.invert(lastCam.viewProj)
    if (!inv) return null
    // NDC 上的两个点：z = -1（近）与 z = 1（远）
    const unproject = (z) => {
      const x = ndcX, y = ndcY
      const cx = inv[0] * x + inv[4] * y + inv[8] * z + inv[12]
      const cy = inv[1] * x + inv[5] * y + inv[9] * z + inv[13]
      const cz = inv[2] * x + inv[6] * y + inv[10] * z + inv[14]
      const cw = inv[3] * x + inv[7] * y + inv[11] * z + inv[15]
      if (!(Math.abs(cw) > 1e-6)) return null
      return [cx / cw, cy / cw, cz / cw]
    }
    const a = unproject(-1), b = unproject(1)
    if (!a || !b) return null
    const dy = b[1] - a[1]
    if (!(Math.abs(dy) > 1e-6)) return null
    // 先按「地形平均高度 2.2 米」求交，再用该点真实高度修正两次
    let groundY = 2.2
    let px = 0, pz = 0
    for (let i = 0; i < 3; i += 1) {
      const t = (groundY - a[1]) / dy
      if (!(t > 0)) return null          // 射线朝上，打不到地面
      px = a[0] + (b[0] - a[0]) * t
      pz = a[2] + (b[2] - a[2]) * t
      groundY = petTerrainHeight(px, pz)
    }
    return { x: px, z: pz }
  }

  // 世界坐标 → 屏幕像素。给 DOM 用（木牌要钉在向日葵脚下）。
  // 和角色那套用的是同一个 viewProj，所以和 3D 场景严丝合缝。
  window.__ossWorldToScreen = (wx, wy, wz) => {
    if (!lastCam) return null
    const m = lastCam.viewProj
    const cx = m[0] * wx + m[4] * wy + m[8] * wz + m[12]
    const cy = m[1] * wx + m[5] * wy + m[9] * wz + m[13]
    const cw = m[3] * wx + m[7] * wy + m[11] * wz + m[15]
    if (!(cw > 0.001)) return null
    return {
      x: ((cx / cw) * 0.5 + 0.5) * (window.innerWidth || 0),
      y: (1 - ((cy / cw) * 0.5 + 0.5)) * (window.innerHeight || 0),
    }
  }

  // 时间流速倍率（0.1 ~ 10）。
  // 为什么要有这个读口：引擎内部的云（cloudStep）收的是未缩放的 dt，
  // 而 DOM 层上的云主体、角色调度器都在外面跑，它们拿不到 timeScale。
  // 所以在这里统一暴露一次，两边共用一个数，才不会出现
  // 「场景加速了、天上的云主体还是原速」这种脱节。
  window.__ossTimeScale = () => timeScale

  last = performance.now()
  rafId = requestAnimationFrame(frame)
}

// 关闭 IIFE：整份文件的作用域到这里结束，每次重新执行都是全新一份。
})()
