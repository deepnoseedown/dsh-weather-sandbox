// ============================================================
//  VOXEL TERRAIN — 创世大陆
//
//  96 × 96 米的世界，0.5 米一格（192 × 128 × 192 格）。
//  底座铺在 y=0，向上留 64 米建造空间。
//
// ============================================================
//  【原则零 · 永不删除 · 创世模块总设计原则】
//
//  ─────────────────────────────────────────────────────────
//
//      一切以节省 token 为最高原则。
//
//      只有 token 省到极致，世界才能极致复杂。
//
//  ─────────────────────────────────────────────────────────
//
//  这不是一句口号，是这个世界能不能长大的唯一前提。
//
//  一个需要 AI 参与每一次建造的世界，复杂度受制于用户的余额：
//  每盖一栋楼都在扣钱，用户就会省着用；用得少，世界就一直是几栋楼。
//
//  反过来，当建造本身不消耗任何 AI 资源时，用户想盖多少盖多少 ——
//  一百栋、一千栋、一片城。复杂度才真正开始涌现。
//
//
//  一、怎么判断一件事该不该消耗 token
//
//  把功能拆成步骤，逐步问：
//
//      这个步骤用代码写死，会不会出错？
//
//      · 不会（纯计算）  → 代码做。0 token，且永远正确。
//      · 会（要判断）    → AI 做。这是它唯一擅长的事，token 花得值。
//
//  实例：
//
//      图片的每一格该用什么颜色   → 代码。最近邻匹配，纯算术。
//      「这张图放在哪里好看」     → AI。是审美判断，算不出来。
//      把 1600 块精确平移 99 格   → 代码。逐块改坐标，不会错。
//      「挪到最里面的左角」       → AI。需要理解「最里面」指什么。
//      按图纸复制一栋楼           → 代码。形状固定，复用即可。
//      「我想要一个哥特教堂」     → AI。需要把需求拆成结构。
//
//
//  二、由此得到的分工：AI 是设计顾问，不是施工队
//
//      人   ── 给意图（"把这张照片放到最里面"）
//      AI   ── 把意图翻译成参数，只在需要判断的地方出现
//      代码 ── 把参数变成方块，全程不消耗任何 AI 资源
//
//  「0 token 建造」不是省出来的 —— 是那条链路上根本不存在 AI。
//
//
//  三、常见做法为什么是错的
//
//  「AI 聪明，什么都让它做」听起来合理，实际是把确定性计算也派给 AI：
//  慢、贵、而且会算错（曾经让 AI 手算一个四合院的坐标，整个院子歪了）。
//
//  判断类的事硬写成代码同样错 —— 比如「自动摆得好看」的启发式，
//  通常又丑又僵。该交给 AI 的就交给 AI，别省这点 token。
//
//  分界线只有一条：能不能用确定的算式回答。
//
//
//  四、加新功能时怎么用这条原则
//
//  先把功能拆成步骤，逐步问「谁做」。
//  会发现大部分步骤根本不需要 AI —— 那些地方一旦写了 AI 调用，
//  就是在给自己制造成本、延迟、和不稳定。
//
//  任何「每次建造都要经过 AI」的设计，都是违反原则零的。
//
// ============================================================
//
//  设计要点（改之前先读）：
//
//  1. 相机固定方向和俯角，只允许推拉（滚轮改距离）。
//     目的：和海洋/草地保持同一地平线，看起来是同一个世界。
//     如果允许自由旋转，地平线会和主世界对不上，像两个拼贴的画面。
//     另外相机不监听鼠标，所以不会和界面抢 pointer-events。
//
//  2. 底座是【一整块平面】，砖缝在 shader 里用 fract() 算。
//     192×192=36864 块砖，如果每块都做几何会炸；砖缝在片元里算只有 5 行代码，
//     伪影来自「越远越密」——这正是纵深感的来源，也是它看起来像真地面的原因。
//
//  3. 一切都要能被主世界的光照着。
//     底座读主世界的太阳方向/颜色/天空色（由引擎每帧传进来），
//     不自己发明光照，否则它会和旁边的海/草像两个世界。
//
//  4. 24 色，不是六色。
//     六色全是高饱和鲜艳色，装不下照片 —— 深蓝头发 rgb(25,45,91) 到「蓝」的
//     距离 179，到「绿」只有 141，整幅人像会变成绿色。加了深色/浅色/灰阶之后
//     这类颜色才有归宿。改调色板要同时改四处（见下方 MATERIALS 的注释）。
//
//  重入保护：宿主可能把 <script> 重新插回页面，包 IIFE + 自杀旧实例。
// ============================================================
;(function () {
  'use strict'

  // ---- 重入保护：上一份实例先自杀 ----
  if (window.__voxelPass && typeof window.__voxelPass.dispose === 'function') {
    try { window.__voxelPass.dispose() } catch (error) { /* 上一份已经没了 */ }
  }
  window.__voxelPass = null

  // ============================================================
  //  一、世界参数
  // ============================================================
  // 底座尺寸 = 草地直径（96 米）。海洋 420 米、草地 96 米，
  // 方块大陆取和草地一样的占地面积，视觉上才像「同一块地上的第三样东西」。
  const SIZE = 96          // 米，X 和 Z 同宽
  // 米，向上留的建造空间。
  //
  // 【为什么从 32 加到 64】
  // 图片是竖着挂在世界里的，它的高度直接受 Y 轴格数限制。
  // 32 米 = 64 格，一张图最多 64 格高 —— 480×262 的照片只能做成 64×35，
  // 猫的耳朵和眼睛都被平均掉，只剩一团白。
  //
  // 加到 64 米 = 128 格，同样的图能做成 128×70，细节翻倍。
  // 相机不受影响（CAM_BASE_EYE 是固定值，不读 HEIGHT），
  // 只有世界边界、vkey、分桶上限跟着变，全都是动态算的。
  const HEIGHT = 64        // 米
  // 【格子大小】改这一个数，格数/桶/上限全部跟着变。
  //   1.0 米 → 96×96×32   格位 29 万，凉亭 689 块
  //   0.5 米 → 192×192×64 格位 236 万，凉亭约 5500 块
  // 用户要的是「同样面积放更多建筑」，所以取 0.5。
  // 代价是方块数 ×8、生成时间 ×8 —— 但这是 AI 建，不是人点，可接受。
  const CELL = 0.5         // 米/格

  // 底座铺在 y=0 平面，中心在原点。相机从 +Z 方向看过来。
  const HALF = SIZE * 0.5

  // 固定主视角：和海洋/草地同一套取景逻辑，只是站得更高更远，
  // 为的是能同时看到底板的近边和远边。
  //   俯角 ≈ 15°，FOV 55° → 地平线落在屏幕约 27%（和主世界一致）
  // 【相机距离可调，方向/俯角固定】
  // 滚轮只改 dist，不动 eye 的方向 —— 所以看得更近/更远，但不会转视角，
  // 相机不接受拖拽，所以不存在「拖不动」和「转到背面看见破绽」这两类问题。
  const CAM_BASE_EYE = [0, 14, 52]
  const CAM_TARGET = [0, 0, 0]
  const CAM_DIST_MIN = 12       // 最近：贴到胸前看一块砖
  const CAM_DIST_MAX = 160      // 最远：整块底板 + 外框全收进画面
  const CAM_DIST_DEFAULT = 54

  // 由 BASE_EYE 反推出的俯角（不随缩放变化），用于按 dist 反算 camera eye。
  //   pitch = atan2(eyeY - tgtY, 水平距离)
  const BASE_DX = CAM_BASE_EYE[0] - CAM_TARGET[0]
  const BASE_DY = CAM_BASE_EYE[1] - CAM_TARGET[1]
  const BASE_DZ = CAM_BASE_EYE[2] - CAM_TARGET[2]
  const BASE_R = Math.hypot(BASE_DX, BASE_DZ)          // 水平距离 = 52
  const BASE_PITCH = Math.atan2(BASE_DY, BASE_R)       // 俯角
  const BASE_LEN = Math.hypot(BASE_R, BASE_DY)         // 斜距

  let camDist = CAM_DIST_DEFAULT

  // 网格显示开关（默认开）。关掉后：外框线不画、砖缝不画 —— 底座还是那块地板。
  // 「看建筑」时玩家常要这个：辅助线会干扰判断形体。
  let showGrid = true

  // ============================================================
  //  二、状态
  // ============================================================
  let gl = null
  let ready = false
  // 【整个创世大陆的开关】
  // false = 这一层完全不存在（连底座带方块都不画，也不接管相机）
  let visible = false
  // 两个子开关：底座（大陆本身）和方块（建筑）
  //   只关底座 → 建筑悬在海面/草地上（降临效果）
  //   只关建筑 → 只剩空工地
  //   两个都关 → 整体也不算了（见 setPart）
  let showPlate = true
  let showBuild = true
  let disposed = false

  // 底座（平面）
  let groundVao = null
  let groundVbo = null
  let groundProg = null
  let uVP = null
  // 最后一帧的相机信息，供拾取用（客户端点击时不在 render 循环里，
  // 拿不到当帧的 cam，只能记住上一帧的）
  let lastVpInv = null
  let lastW = 1
  let lastH = 1
  let uEye = null
  let uSunDir = null
  let uSunColor = null
  let uSkyTop = null
  let uSkyHorizon = null
  let uFog = null
  let uTime = null
  let uGridOn = null

  // ============================================================
  //  三、着色器
  // ============================================================
  // 注意：GLSL 注释必须是纯 ASCII，且不能有反引号 —— 两者都会让编译失败。

  // 底座顶点：只传世界 XZ，Y 恒为 0。
  const VS_GROUND = `#version 300 es
precision highp float;
in vec2 aXZ;
uniform mat4 uViewProj;
out vec2 vXZ;
out vec3 vWorld;
void main() {
  vXZ = aXZ;
  vWorld = vec3(aXZ.x, 0.0, aXZ.y);
  gl_Position = uViewProj * vec4(vWorld, 1.0);
}`

  // 底座片元：白玉砖。
  // 砖缝用两套周期互质的网格叠出来，避免「整块板子一个方向重复」的假感。
  const FS_GROUND = `#version 300 es
precision highp float;

in vec2 vXZ;
in vec3 vWorld;

uniform vec3  uEye;
uniform vec3  uSunDir;
uniform vec3  uSunColor;
uniform vec3  uSkyTop;
uniform vec3  uSkyHorizon;
uniform float uFog;
uniform float uTime;
uniform float uGridOn;

out vec4 o;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

void main() {
  // ---- 1. Brick seams ----
  // In cell space, distance to the nearest edge. Below seam width = seam.
  vec2 cell = vXZ / 1.0;
  vec2 g = fract(cell);
  vec2 dEdge = min(g, 1.0 - g);
  float seamDist = min(dEdge.x, dEdge.y);

  // Seam width 0.035 m. fwidth keeps it from collapsing to one pixel
  // far away, where every cell would otherwise smear into flat grey.
  float w = max(fwidth(cell.x), fwidth(cell.y));
  float seamW = mix(0.035, 0.5, clamp(w * 2.0, 0.0, 1.0));
  float seam = 1.0 - smoothstep(0.0, seamW, seamDist);

  // ---- 2. Per-brick tonal variation ----
  // White jade is not pure white; a little depth between bricks
  // keeps the slab from reading as a sheet of plastic.
  float brick = hash21(floor(cell));
  vec3 base = vec3(0.93, 0.925, 0.90) * (0.94 + brick * 0.08);

  // ---- 3. Surface micro relief ----
  // Two sine layers, no texture fetch.
  float n = sin(vWorld.x * 3.7) * sin(vWorld.z * 4.3) * 0.5
          + sin(vWorld.x * 11.0 + 1.7) * sin(vWorld.z * 9.0) * 0.25;
  base *= 1.0 + n * 0.012;

  // ---- 4. Lighting: read the main world sun, invent nothing ----
  // The slab is horizontal, normal is always (0,1,0), so the diffuse term
  // is just the sun direction y component.
  float ndl = max(uSunDir.y, 0.0);
  vec3 sun = uSunColor * (0.35 + 0.65 * ndl);
  vec3 sky = mix(uSkyHorizon, uSkyTop, 0.85) * 0.55;
  vec3 col = base * (sun + sky);

  // ---- 5. Seams darkened ----
  // uGridOn gates the seams so the same shader serves both grid modes.
  col = mix(col, col * 0.55, seam * uGridOn);

  // ---- 6. Distance fog: same fog amount as the main world ----
  float dist = length(vWorld - uEye);
  float fogF = smoothstep(60.0, 190.0, dist) * (0.55 + uFog * 0.45);
  col = mix(col, uSkyHorizon, fogF);

  o = vec4(col, 1.0);
}`

  // ============================================================
  //  四、几何
  // ============================================================
  // 底座：只要两个三角形（一个大 quad），砖缝全在片元里算。
  function buildGround() {
    return new Float32Array([
      -HALF, -HALF,
       HALF, -HALF,
      -HALF,  HALF,
      -HALF,  HALF,
       HALF, -HALF,
       HALF,  HALF,
    ])
  }

  // ============================================================
  //  五、GL 资源
  // ============================================================
  function compile(type, source, tag) {
    const s = gl.createShader(type)
    gl.shaderSource(s, source)
    gl.compileShader(s)
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(s)
      gl.deleteShader(s)
      throw new Error('[voxel-terrain] ' + tag + ' compile failed: ' + log)
    }
    return s
  }

  function link(vsSrc, fsSrc, tag) {
    const vs = compile(gl.VERTEX_SHADER, vsSrc, tag + '.vert')
    const fs = compile(gl.FRAGMENT_SHADER, fsSrc, tag + '.frag')
    const p = gl.createProgram()
    gl.attachShader(p, vs)
    gl.attachShader(p, fs)
    gl.linkProgram(p)
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(p)
      gl.deleteProgram(p)
      throw new Error('[voxel-terrain] ' + tag + ' link failed: ' + log)
    }
    gl.deleteShader(vs)
    gl.deleteShader(fs)
    return p
  }

  function init(glCtx) {
    if (ready) return true
    if (!glCtx) return false
    gl = glCtx

    try {
      groundProg = link(VS_GROUND, FS_GROUND, 'ground')
    } catch (error) {
      console.warn(error && error.message ? error.message : error)
      groundProg = null
      return false
    }

    // ---- 底座 VAO ----
    const gData = buildGround()
    groundVao = gl.createVertexArray()
    groundVbo = gl.createBuffer()
    gl.bindVertexArray(groundVao)
    gl.bindBuffer(gl.ARRAY_BUFFER, groundVbo)
    gl.bufferData(gl.ARRAY_BUFFER, gData, gl.STATIC_DRAW)
    const aXZ = gl.getAttribLocation(groundProg, 'aXZ')
    gl.enableVertexAttribArray(aXZ)
    gl.vertexAttribPointer(aXZ, 2, gl.FLOAT, false, 0, 0)
    gl.bindVertexArray(null)
    gl.bindBuffer(gl.ARRAY_BUFFER, null)

    uVP = gl.getUniformLocation(groundProg, 'uViewProj')
    uEye = gl.getUniformLocation(groundProg, 'uEye')
    uSunDir = gl.getUniformLocation(groundProg, 'uSunDir')
    uSunColor = gl.getUniformLocation(groundProg, 'uSunColor')
    uSkyTop = gl.getUniformLocation(groundProg, 'uSkyTop')
    uSkyHorizon = gl.getUniformLocation(groundProg, 'uSkyHorizon')
    uFog = gl.getUniformLocation(groundProg, 'uFog')
    uTime = gl.getUniformLocation(groundProg, 'uTime')
    uGridOn = gl.getUniformLocation(groundProg, 'uGridOn')

    // 方块系统的 GL 资源。它挂了不影响底座和网格（各自独立）。
    try {
      buildVoxelGL()
    } catch (error) {
      console.warn('[voxel-terrain] voxel GL init failed, voxels disabled', error)
      voxProg = null
    }

    ready = true
    return true
  }

  // ============================================================
  //  六、方块系统：格子存储 + 分桶 + 实例化渲染
  // ============================================================
  //
  //  设计要点（改之前先读）：
  //
  //  1. 每块方块的开销是第一约束。
  //     存储用【整数键 Map】：字符串键每查一次要拼串+哈希，几万块时慢 3~5 倍。
  //     key = (x * GRID_Y + y) * GRID_Z + z，纯算术。
  //
  //  2. 分桶（bucket）：XZ 平面切 16 米一格，6x6 = 36 个桶。
  //     不分桶的话，改一块砖要重传整个实例缓冲（几万块 = 几百 KB）。
  //     分桶之后改一块只重建它所在的那个桶（最多 8192 格）。
  //
  //  3. 脏标记：没有修改就一帧都不重建。
  //     这是「不修改就零成本」的落点 —— 每帧只有一个 if。
  //
  //  4. 内部面剔除：邻居有方块的面不生成。
  //     实心建筑内部的面全部丢掉，6 万块只有约 9 千块进 GPU。
  //
  //  5. 背面剔除交给调用方开 CULL_FACE（drawScene 里开）。
  //     空心建筑靠它省一半面 —— 从外面看不见内壁，反之亦然。

  // ---- 世界格坐标 ----
  //
  // 【米 和 格 是两件事】
  // 之前这里写的是 GRID_X = SIZE —— 把"米数"直接当"格数"，
  // 只在 CELL=1 的时候碰巧成立。格子一改小就全错。
  //
  // 现在拆开：
  //   世界物理尺寸：SIZE 米 × SIZE 米 × HEIGHT 米（不变）
  //   格子大小：    CELL 米（0.5）
  //   格坐标范围：  格数 = 米数 / CELL
  //
  // 改 CELL 只需要动这一个数，格数、桶数、上限全部自动跟着派生。
  const GRID_X = Math.round(SIZE / CELL)      // 192（0.5 米格）
  const GRID_Y = Math.round(HEIGHT / CELL)    // 128
  const GRID_Z = Math.round(SIZE / CELL)      // 192

  // 全局硬上限。
  // 1 米格时 20 万够用；0.5 米格下格位总数是 236 万，
  // 提到 50 万 —— 够建好几栋大楼，又不会一次吃光内存。
  const MAX_VOXELS = 500000

  // 桶：按【米】切，不按格切。
  // 桶宽固定 16 米，所以每个桶装的格数会随 CELL 变（0.5 米格时每桶 32×32×64 格）。
  // 这样桶的物理尺寸恒定，分桶策略不随精度变化。
  const BUCKET_M = 16                                                     // 桶宽（米）
  const BUCKET_CELLS = Math.round(BUCKET_M / CELL)                        // 32 格
  const BUCKET_N = Math.round(SIZE / BUCKET_M)                            // 6
  const BUCKET_COUNT = BUCKET_N * BUCKET_N                                // 36
  const BUCKET_CAP = BUCKET_CELLS * GRID_Y * BUCKET_CELLS                 // 65536 格位/桶

  // 整数键
  // 坐标是否在世界内。5 处调用点原来各写一遍同样的表达式。
  function inBounds(x, y, z) {
    return x >= 0 && x < GRID_X && y >= 0 && y < GRID_Y && z >= 0 && z < GRID_Z
  }

  function vkey(x, y, z) {
    return (x * GRID_Y + y) * GRID_Z + z
  }
  // 桶编号（只按 XZ）
  function bucketOf(x, z) {
    return Math.floor(x / BUCKET_CELLS) + Math.floor(z / BUCKET_CELLS) * BUCKET_N
  }

  // 主存储：key → colorIdx（0..3）
  const voxels = new Map()
  // 建筑归属：buildId → Set<key>
  const buildings = new Map()

  // ============================================================
  //  建筑旋转表
  // ============================================================
  // 【为什么单独一张表，不改 buildings 的结构】
  // buildings 是 Map<buildId, Set<vkey>>，全文件有 21 处引用。
  // 想给它加旋转属性，就得把它改成 Map<buildId, {cells, rotY}>，
  // 21 处都要跟着改 —— 一次改这么散，必出错。
  //
  // 所以另开一张表：buildId -> 0 | 90 | 180 | 270。
  // 只有「渲染」和「拾取」需要查它，其他地方完全不用知道旋转的存在。
  //
  // 只允许 90 的倍数：方块是方的，转 45° 会露缝、方块变菱形，
  // 那就不像方块世界了。90° 一档是完美的 —— 转完还是整齐的方阵。
  const ROT_STEP = 90
  const buildingRot = new Map()   // buildId -> 0 | 90 | 180 | 270
  // 反查表：vkey -> buildId。
  // rebuildBucket 遍历的是全局 voxels，它不知道一块属于哪栋楼；
  // 要应用旋转就必须能反查。多存一张 Map 的代价远小于遍历 buildings。
  const voxelOwner = new Map()
  // 每栋建筑固定的旋转锚点（浮点，包围盒中心的原始位置）。
  // 第一次旋转时登记，之后每次都对齐到它 —— 这样误差不累积。
  const buildingAnchor = new Map()

  function normalizeRot(deg) {
    const n = Number(deg)
    if (!Number.isFinite(n)) return 0
    return ((Math.round(n / ROT_STEP) * ROT_STEP) % 360 + 360) % 360
  }

  function getBuildingRot(buildId) {
    return buildingRot.get(buildId) || 0
  }

  // 绕竖直轴旋转 90° 的倍数：先把点相对 pivot 化，转完再加回去。
  // 90° 的旋转矩阵是整数运算，取整无损 —— 这也是只允许 90° 倍数的原因之一。
  function rotateAroundPivot(x, z, pivot, deg) {
    const d = normalizeRot(deg)
    if (d === 0) return [Math.round(x), Math.round(z)]
    const dx = x - pivot[0]
    const dz = z - pivot[2]
    let rx, rz
    if (d === 90) { rx = pivot[0] - dz; rz = pivot[2] + dx }
    else if (d === 180) { rx = pivot[0] - dx; rz = pivot[2] - dz }
    else if (d === 270) { rx = pivot[0] + dz; rz = pivot[2] - dx }
    else return [Math.round(x), Math.round(z)]
    // 浮点中心 + 90° 时结果一定是整数（因为 dx/dz 的 .5 会互相抵消），
    // 但浮点加法可能有 0.9999 这种误差，统一 round 一次。
    return [Math.round(rx), Math.round(rz)]
  }

  // ---- 统一的包围盒计算（带缓存）----
  // 所有需要包围盒的地方都走这里，包括旋转轴、快照锚点、拾取范围和收纳。
  // 分散在多处各算一遍时，漏改一处就会读到过期的值。
  //
  // 现在只有这一份，结果缓存在 boundsCache。
  // 任何改动建筑方块的操作（setVoxel / removeVoxel / setBuildingRot /
  // setBuildingOffset）都必须调 invalidateBounds(buildId)。
  const boundsCache = new Map()

  function invalidateBounds(buildId) {
    boundsCache.delete(buildId)
  }

  function boundsOf(buildId) {
    if (boundsCache.has(buildId)) return boundsCache.get(buildId)
    const set = buildings.get(buildId)
    if (!set || !set.size) { boundsCache.set(buildId, null); return null }
    let minX = Infinity, minY = Infinity, minZ = Infinity
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
    for (const k of set) {
      const [x, y, z] = unkey(k)
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (z < minZ) minZ = z
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
      if (z > maxZ) maxZ = z
    }
    const b = {
      minX, maxX, minY, maxY, minZ, maxZ,
      cx: (minX + maxX) / 2,
      cy: (minY + maxY) / 2,
      cz: (minZ + maxZ) / 2,
      w: maxX - minX + 1,
      h: maxY - minY + 1,
      d: maxZ - minZ + 1,
    }
    boundsCache.set(buildId, b)
    return b
  }
  function setBuildingRot(buildId, deg) {
    if (!buildings.has(buildId)) return { ok: false, error: 'no such building' }
    const set = buildings.get(buildId)
    if (!set || !set.size) return { ok: false, error: 'empty building' }

    const before = getBuildingRot(buildId)
    const target = normalizeRot(deg)
    let delta = target - before
    if (delta === 0) return { ok: true, rotY: target, from: before, changed: false }
    if (delta < 0) delta += 360

    // 1. 包围盒中心当旋转轴（浮点，不取整）
    // 取整会让整栋偏半格，四次旋转就漂出去。
    const bb = boundsOf(buildId)
    if (!bb) return { ok: false, error: 'empty building' }
    const pivot = [bb.cx, 0, bb.cz]

    // 2. 取固定锚点。第一次旋转时登记，之后每次都对齐到它 ——
    // 对齐到「上一次的中心」会让误差累积。
    let anchor = buildingAnchor.get(buildId)
    if (!anchor) {
      anchor = [bb.cx, bb.cz]
      buildingAnchor.set(buildId, anchor)
    }
    const preCx = anchor[0]
    const preCz = anchor[1]

    let sx = 0, sz = 0

    // 3. 交给通用搬运，变换函数里做「旋转 + 整体对齐」
    const r = relocateBuilding(buildId, (raw) => {
      const items = raw.map((c) => {
        const p = rotateAroundPivot(c.x, c.z, pivot, delta)
        return { k: c.k, y: c.y, mat: c.mat, nx: p[0], nz: p[1] }
      })

      // 对齐：转完之后包围盒中心会偏半格（宽高互换时是几何必然），
      // 把它拉回锚点，保证误差不累积。
      if (items.length) {
        let rMinX = Infinity, rMaxX = -Infinity, rMinZ = Infinity, rMaxZ = -Infinity
        for (const it of items) {
          if (it.nx < rMinX) rMinX = it.nx
          if (it.nx > rMaxX) rMaxX = it.nx
          if (it.nz < rMinZ) rMinZ = it.nz
          if (it.nz > rMaxZ) rMaxZ = it.nz
        }
        sx = Math.round(preCx - (rMinX + rMaxX) / 2)
        sz = Math.round(preCz - (rMinZ + rMaxZ) / 2)
        for (const it of items) {
          it.nx += sx
          it.nz += sz
        }
      }
      return items
    })

    // 4. 记角度（relocateBuilding 已经刷过中心和脏标记）
    buildingRot.set(buildId, target)

    return {
      ok: true, rotY: target, from: before, changed: true,
      moved: r.moved, dropped: r.blocked, shift: [sx, sz],
    }
  }
  // ---- 通用：把一栋建筑的全部方块搬到新坐标 ----
  // 旋转和移动都要「读出全部方块 → 清空三张表 → 按新坐标写回」，
  // 只有坐标变换不同。这里只做搬运，变换由 planFn 传进来。
  //
  // mapFn(x, z) -> [nx, nz]
  // 返回 { moved, blocked }：blocked 是目标格被别的建筑占了、搬不过去的块数。
  // ---- 通用：把一栋建筑的全部方块搬到新坐标 ----
  // setBuildingRot 和 setBuildingOffset 原来是两段几乎一样的代码：
  // 读 → 清三张表 → 写。只有坐标变换不同。
  //
  // planFn(raw) 接收 [{x,y,z,mat}]，返回 [{x,y,z,mat,nx,nz}]。
  // 之所以要「整批」而不是「逐块」：旋转需要先算完所有目标坐标
  // 才能对齐包围盒中心，逐块算没法做对齐。
  function relocateBuilding(buildId, planFn) {
    const set = buildings.get(buildId)
    if (!set || !set.size) return { moved: 0, blocked: 0 }

    // 1. 先读出来
    const raw = []
    for (const k of set) {
      const [x, y, z] = unkey(k)
      const mat = voxels.get(k)
      if (mat === undefined) continue
      raw.push({ k: k, x: x, y: y, z: z, mat: mat })
    }

    // 2. 交给调用方算出目标坐标（可能带整体对齐）
    const items = planFn(raw)

    // 3. 原地清空，三张表一起清
    for (const it of items) {
      voxels.delete(it.k)
      voxelOwner.delete(it.k)
      set.delete(it.k)
    }

    // 4. 按新坐标写回
    let moved = 0
    let blocked = 0
    for (const it of items) {
      if (it.nx < 0 || it.nx >= GRID_X || it.nz < 0 || it.nz >= GRID_Z) { blocked++; continue }
      if (voxels.has(vkey(it.nx, it.y, it.nz))) { blocked++; continue }
      const nk = vkey(it.nx, it.y, it.nz)
      voxels.set(nk, it.mat)
      voxelOwner.set(nk, buildId)
      set.add(nk)
      moved++
    }

    invalidateBounds(buildId)
    for (let i = 0; i < BUCKET_COUNT; i++) bucketDirty[i] = 1
    anyDirty = true

    return { moved: moved, blocked: blocked }
  }



  // ============================================================
  //  移动一栋建筑
  // ============================================================
  // 和旋转是同一套做法：改方块坐标数据，不是渲染变换。
  //
  // 移动比旋转简单：
  //   - 没有宽高互换的问题（平移不改变形状）
  //   - 不需要锚点对齐（往哪走就是哪）
  // 所以就是纯平移：每个方块 (x, z) 变成 (x+dx, z+dz)。
  //
  // 三种目的地处理：
  //   ① 目标格是空的 -> 搬过去
  //   ② 目标格被自己占着（原地重叠部分）-> 也算成功
  //   ③ 目标格被别的建筑占着 -> 那一块搬不过去，计入 blocked
  //
  // 【为什么要「先读再清再写」】
  // 原地改写会让「搬到前面的方块」盖住「还没读的方块」。
  // 和旋转一样必须走缓冲。
  function setBuildingOffset(buildId, dx, dz) {
    if (!buildings.has(buildId)) return { ok: false, error: 'no such building' }
    const set = buildings.get(buildId)
    if (!set || !set.size) return { ok: false, error: 'empty building' }
    const ox = Math.trunc(Number(dx) || 0)
    const oz = Math.trunc(Number(dz) || 0)
    if (ox === 0 && oz === 0) return { ok: true, moved: 0, blocked: 0, changed: false }

    // 整体校验：任何一块越界就整栋拒绝。
    // 半栋搬过去、半栋留在原地，比搬不动更糟。
    for (const k of set) {
      const [x, , z] = unkey(k)
      const nx = x + ox
      const nz = z + oz
      if (nx < 0 || nx >= GRID_X || nz < 0 || nz >= GRID_Z) {
        return { ok: false, error: 'out of bounds', dx: ox, dz: oz }
      }
    }

    // 平移就是纯坐标偏移，交给通用搬运
    const r = relocateBuilding(buildId, (raw) => raw.map((c) => ({
      k: c.k, y: c.y, mat: c.mat, nx: c.x + ox, nz: c.z + oz,
    })))

    // 锚点跟着走，否则下次旋转会把它拽回旧位置
    const anc = buildingAnchor.get(buildId)
    if (anc) buildingAnchor.set(buildId, [anc[0] + ox, anc[1] + oz])

    return { ok: true, dx: ox, dz: oz, moved: r.moved, blocked: r.blocked, changed: true }
  }

  // 查一栋建筑能不能搬到某个位置（只检查，不改数据）。
  // AI 移动前先问一次，避免搬一半卡住。
  function canMoveBuilding(buildId, dx, dz) {
    const set = buildings.get(buildId)
    if (!set || !set.size) return { ok: false, error: 'no such building' }
    const ox = Math.trunc(Number(dx) || 0)
    const oz = Math.trunc(Number(dz) || 0)
    let outOfBounds = 0
    let collides = 0
    for (const k of set) {
      const [x, , z] = unkey(k)
      const nx = x + ox
      const nz = z + oz
      if (nx < 0 || nx >= GRID_X || nz < 0 || nz >= GRID_Z) { outOfBounds++; continue }
      const other = voxelOwner.get(vkey(nx, unkey(k)[1], nz))
      if (other !== undefined && other !== buildId) collides++
    }
    return {
      ok: outOfBounds === 0,
      outOfBounds: outOfBounds,
      collides: collides,
      dx: ox,
      dz: oz,
    }
  }

  // 桶的脏标记
  const bucketDirty = new Uint8Array(BUCKET_COUNT)
  let anyDirty = false

  // 6 个面：法线 + 明暗档
  // 明暗不存进实例（省 4 字节），在着色器里按 aNormal 算。
  const FACES = [
    [ 1, 0, 0], [-1, 0, 0],
    [ 0, 1, 0], [ 0,-1, 0],
    [ 0, 0, 1], [ 0, 0,-1],
  ]

  // ---- GL 资源 ----
  let voxProg = null
  let voxVao = null
  let voxCubeVbo = null
  let voxIndexCount = 0
  // 每个桶一套：实例 VBO + 实例数 + VAO
  const bucketVbo = new Array(BUCKET_COUNT).fill(null)
  const bucketVao = new Array(BUCKET_COUNT).fill(null)
  const bucketInst = new Uint32Array(BUCKET_COUNT)   // 每桶当前实例数
  let voxUVP = null
  let voxUSun = null
  let voxUFog = null

  // ---- 单位立方体的 6 个面（每面 2 三角 = 6 索引） ----
  // 顶点顺序不重要（不开背面剔除时都能画到），但为了 CULL_FACE 正确，
  // 这里按逆时针写。位置相对格子中心：±0.5。
  function buildCube() {
    const pos = []
    const nor = []
    const idx = []
    // 每个面：中心偏移 + 两个切向
    const faceDefs = [
      // +X
      { n: [ 1, 0, 0], c: [ 0.5, 0, 0], u: [0, 0, -1], v: [0, 1, 0] },
      // -X
      { n: [-1, 0, 0], c: [-0.5, 0, 0], u: [0, 0,  1], v: [0, 1, 0] },
      // +Y
      { n: [ 0, 1, 0], c: [0,  0.5, 0], u: [1, 0, 0], v: [0, 0, -1] },
      // -Y
      { n: [ 0,-1, 0], c: [0, -0.5, 0], u: [1, 0, 0], v: [0, 0,  1] },
      // +Z
      { n: [ 0, 0, 1], c: [0, 0,  0.5], u: [1, 0, 0], v: [0, 1, 0] },
      // -Z
      { n: [ 0, 0,-1], c: [0, 0, -0.5], u: [-1, 0, 0], v: [0, 1, 0] },
    ]
    let base = 0
    for (const f of faceDefs) {
      // 4 个角：(-u,-v) (+u,-v) (+u,+v) (-u,+v)
      const corners = [[-1,-1],[1,-1],[1,1],[-1,1]]
      for (const [su, sv] of corners) {
        pos.push(
          f.c[0] + f.u[0] * su * 0.5 + f.v[0] * sv * 0.5,
          f.c[1] + f.u[1] * su * 0.5 + f.v[1] * sv * 0.5,
          f.c[2] + f.u[2] * su * 0.5 + f.v[2] * sv * 0.5,
        )
        nor.push(f.n[0], f.n[1], f.n[2])
      }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3)
      base += 4
    }
    return { pos: new Float32Array(pos), nor: new Float32Array(nor), idx: new Uint16Array(idx) }
  }

  const VS_VOXEL = `#version 300 es
precision highp float;
in vec3 aPos;
in vec3 aNormal;
in vec3 aOffset;
in float aColor;
uniform mat4 uViewProj;
out vec3 vNormal;
out float vColor;
out vec3 vWorld;
out vec3 vLocal;   // -0.5..0.5 inside the unit cube, used for the edge outline
void main() {
  vec3 world = aOffset + aPos;
  vWorld = world;
  vNormal = aNormal;
  vColor = aColor;
  vLocal = aPos;
  gl_Position = uViewProj * vec4(world, 1.0);
}`

  const FS_VOXEL = `#version 300 es
precision highp float;
in vec3 vNormal;
in float vColor;
in vec3 vWorld;
in vec3 vLocal;     // position inside the unit cube, -0.5..0.5
uniform vec3 uSunColor;
uniform vec3 uCamPos;
uniform float uFog;
out vec4 o;

// 24 colours: the original six (Rubik's cube) plus light/dark/mid variants.
// Index order MUST match MATERIALS in the JS below. Change both together.
//
// Why 24 and not more: six saturated colours cannot represent a photograph.
// Dark hair (25,45,91) is closer to "green" than to "blue" in RGB distance,
// so a portrait turned entirely green. Adding darks and lights fixes that.
vec3 palette(int i) {
  if (i == 1) return vec3(0.95, 0.78, 0.10); //  1 yellow
  if (i == 2) return vec3(0.16, 0.58, 0.95); //  2 blue
  if (i == 3) return vec3(0.94, 0.94, 0.92); //  3 white
  if (i == 4) return vec3(0.95, 0.48, 0.10); //  4 orange
  if (i == 5) return vec3(0.20, 0.72, 0.34); //  5 green
  if (i == 6) return vec3(0.97, 0.62, 0.62); //  6 light red
  if (i == 7) return vec3(0.98, 0.90, 0.55); //  7 light yellow
  if (i == 8) return vec3(0.60, 0.78, 0.98); //  8 light blue
  if (i == 9) return vec3(0.65, 0.90, 0.68); //  9 light green
  if (i == 10) return vec3(0.62, 0.10, 0.12); // 10 dark red
  if (i == 11) return vec3(0.68, 0.52, 0.04); // 11 dark yellow
  if (i == 12) return vec3(0.05, 0.16, 0.42); // 12 dark blue
  if (i == 13) return vec3(0.06, 0.32, 0.14); // 13 dark green
  if (i == 14) return vec3(0.82, 0.68, 0.50); // 14 light tan
  if (i == 15) return vec3(0.45, 0.30, 0.16); // 15 brown
  if (i == 16) return vec3(0.72, 0.72, 0.72); // 16 light grey
  if (i == 17) return vec3(0.38, 0.38, 0.40); // 17 dark grey
  if (i == 18) return vec3(0.10, 0.10, 0.12); // 18 black
  if (i == 19) return vec3(0.85, 0.55, 0.80); // 19 pink
  if (i == 20) return vec3(0.15, 0.65, 0.68); // 20 teal
  if (i == 21) return vec3(0.45, 0.28, 0.65); // 21 purple
  if (i == 22) return vec3(0.52, 0.55, 0.22); // 22 olive
  if (i == 23) return vec3(0.88, 0.72, 0.62); // 23 skin
  return vec3(0.90, 0.18, 0.20);             //  0 red
}

void main() {
  int mi = int(vColor + 0.5);
  // Three-step shading by face normal. Cheap, and it is what makes a cube
  // read as a cube instead of a flat sticker.
  float shade = vNormal.y > 0.5 ? 1.0 : (vNormal.y < -0.5 ? 0.45 : 0.72);
  vec3 base = palette(mi);

  // ---- Edge outline ----
  // Blocks used to melt into one flat sheet because every pixel on a face
  // was the same colour: no seam between two adjacent cubes.
  // Fix: draw a dark border along the rim of each cube face.
  //
  // How: vLocal is this pixel's position inside the unit cube (-0.5..0.5).
  // For a face whose normal is along axis N, the two components that RUN
  // ACROSS that face are the other two axes. Those components go 0 -> 0.5
  // from the face centre out to the edge, so (0.5 - |component|) is the
  // distance from this pixel to that edge. Take the smaller of the two:
  // it drops to 0 at the rim and is 0.5 in the middle of the face.
  //
  // Getting these two axes Right Matters: picking the normal axis instead
  // of a across-axis gives |vLocal| on the fixed axis (always 0.5), which
  // paints the whole face as border. That bug shipped once already.
  vec3 an = abs(vNormal);
  // Which two axes run ACROSS the face, given which axis the normal is.
  float a1, a2;
  if (an.x > 0.5) {
    a1 = abs(vLocal.y); a2 = abs(vLocal.z);   // face normal is X -> across Y,Z
  } else if (an.y > 0.5) {
    a1 = abs(vLocal.x); a2 = abs(vLocal.z);   // face normal is Y -> across X,Z
  } else {
    a1 = abs(vLocal.x); a2 = abs(vLocal.y);   // face normal is Z -> across X,Y
  }
  float edgeDist = min(0.5 - a1, 0.5 - a2);

  // fwidth makes the border one pixel wide no matter the distance, so a
  // far-away wall still shows its grid instead of turning into fog.
  //
  // Width: keep it as a thin LINE, not a groove.
  // Earlier value 0.010 was 2% of a 1 m cube - close up it read as a dark
  // trench cut between blocks rather than an outline. 0.004 is ~4 mm,
  // which still resolves at this camera distance but reads as a drawn edge.
  float w = max(fwidth(edgeDist), 1e-5);
  float border = 1.0 - smoothstep(0.004, 0.004 + w * 1.2, edgeDist);

  vec3 col = base * shade * max(uSunColor, vec3(0.22));
  // Darken the rim to 0.55 (was 0.35).
  // 0.35 crushed the edge nearly to black, which reads as a gap between
  // blocks - like they are floating apart. 0.55 keeps the material colour
  // recognisable at the rim while the seam is still perfectly visible.
  col = mix(col, col * 0.55, border);

  // Distance fade so the far edge of a large build melts into the sky.
  float d = length(vWorld - uCamPos);
  float fogF = smoothstep(140.0, 300.0, d) * uFog;
  col = mix(col, vec3(0.80, 0.85, 0.90), fogF);
  o = vec4(col, 1.0);
}`

  function buildVoxelGL() {
    voxProg = link(VS_VOXEL, FS_VOXEL, 'voxel')
    const cube = buildCube()
    voxIndexCount = cube.idx.length

    // 立方体模板（所有实例共享）
    voxVao = gl.createVertexArray()
    voxCubeVbo = gl.createBuffer()
    gl.bindVertexArray(voxVao)
    gl.bindBuffer(gl.ARRAY_BUFFER, voxCubeVbo)

    const posVbo = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, posVbo)
    gl.bufferData(gl.ARRAY_BUFFER, cube.pos, gl.STATIC_DRAW)
    const aPos = gl.getAttribLocation(voxProg, 'aPos')
    gl.enableVertexAttribArray(aPos)
    gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0)
    gl.vertexAttribDivisor(aPos, 0)

    const norVbo = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, norVbo)
    gl.bufferData(gl.ARRAY_BUFFER, cube.nor, gl.STATIC_DRAW)
    const aNor = gl.getAttribLocation(voxProg, 'aNormal')
    gl.enableVertexAttribArray(aNor)
    gl.vertexAttribPointer(aNor, 3, gl.FLOAT, false, 0, 0)
    gl.vertexAttribDivisor(aNor, 0)

    const ibo = gl.createBuffer()
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo)
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, cube.idx, gl.STATIC_DRAW)

    gl.bindVertexArray(null)
    gl.bindBuffer(gl.ARRAY_BUFFER, null)

    voxUVP = gl.getUniformLocation(voxProg, 'uViewProj')
    voxUSun = gl.getUniformLocation(voxProg, 'uSunColor')
    voxUFog = gl.getUniformLocation(voxProg, 'uFog')
    // uCamPos 每帧传，见 drawVoxels

    // 每个桶：一个实例缓冲 + 一个 VAO（属性配置同模板，只是换实例缓冲）
    for (let i = 0; i < BUCKET_COUNT; i++) {
      const vbo = gl.createBuffer()
      bucketVbo[i] = vbo
      const vao = gl.createVertexArray()
      bucketVao[i] = vao
      gl.bindVertexArray(vao)

      // 静态几何（共用同一批 buffer）
      gl.bindBuffer(gl.ARRAY_BUFFER, posVbo)
      gl.enableVertexAttribArray(aPos)
      gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0)
      gl.vertexAttribDivisor(aPos, 0)
      gl.bindBuffer(gl.ARRAY_BUFFER, norVbo)
      gl.enableVertexAttribArray(aNor)
      gl.vertexAttribPointer(aNor, 3, gl.FLOAT, false, 0, 0)
      gl.vertexAttribDivisor(aNor, 0)
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo)

      // 实例属性：aOffset(3) + aColor(1)
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo)
      const aOff = gl.getAttribLocation(voxProg, 'aOffset')
      gl.enableVertexAttribArray(aOff)
      gl.vertexAttribPointer(aOff, 3, gl.FLOAT, false, 16, 0)
      gl.vertexAttribDivisor(aOff, 1)
      const aCol = gl.getAttribLocation(voxProg, 'aColor')
      gl.enableVertexAttribArray(aCol)
      gl.vertexAttribPointer(aCol, 1, gl.FLOAT, false, 16, 12)
      gl.vertexAttribDivisor(aCol, 1)

      gl.bindVertexArray(null)
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, null)
  }

  // ---- 写入 / 删除 ----
  // 只改数据、打脏标，不碰 GL。真正的重建在 flushVoxels() 里。
  function setVoxel(x, y, z, colorIdx, buildId) {
    if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(z)) return false
    if (!inBounds(x, y, z)) return false
    const k = vkey(x, y, z)
    if (voxels.has(k)) return false          // 已有方块，不覆盖（要改色请先删）
    if (voxels.size >= MAX_VOXELS) return false   // 硬上限

    voxels.set(k, colorIdx | 0)
    // 记进撤销栈：撤销这条「放置」= 把它删掉
    noteCell(x, y, z, colorIdx | 0, true)
    const bid = buildId || 'default'
    let set = buildings.get(bid)
    if (!set) { set = new Set(); buildings.set(bid, set) }
    set.add(k)
    // 反查表：渲染时靠它知道「这块属于哪栋楼、要不要跟着转」
    voxelOwner.set(k, bid)
    // 建筑变大了，包围盒中心可能移位 —— 让它下次用到时重算
    invalidateBounds(bid)

    // 打脏：自己和邻居所在的桶（邻居的面可能因此要重算）
    markDirtyAt(x, z)
    anyDirty = true
    return true
  }

  // 整数键 → 格坐标 [x, y, z]
  // 放在这里（而不是收纳那一节），因为拆除也要用。
  // 函数声明会提升，写在后面也能跑，但读代码的人会以为没用。
  function unkey(k) {
    const z = k % GRID_Z
    const t = (k - z) / GRID_Z
    const y = t % GRID_Y
    const x = (t - y) / GRID_Y
    return [x, y, z]
  }

  // 拆掉一块，并按材质回收到仓库。
  // 【所有拆除都必须走这里】—— 挖一块、拆一栋、一键清空，三条路统一在这收砖，
  // 否则就会出现「有的拆法给砖、有的不给」，玩家会觉得砖凭空消失。
  function removeVoxel(x, y, z) {
    if (!inBounds(x, y, z)) return false
    const k = vkey(x, y, z)
    const mat = voxels.get(k)
    if (mat === undefined) return false
    voxels.delete(k)
    voxelOwner.delete(k)
    // 回收入库（按材质计数，不记坐标）
    addStock(mat, 1)
    // 记进撤销栈：撤销这条「删除」= 把砖放回去
    noteCell(x, y, z, mat, false)
    // 从所有建筑里摘掉（一般只属于一个，但稳妥起见全扫）
    for (const set of buildings.values()) set.delete(k)

    markDirtyAt(x, z)
    anyDirty = true
    return true
  }

  // 清空世界，但【所有砖都回收到仓库】。
  // 注意和 clearVoxels 的区别：
  //   clearVoxels   = 无条件丢弃（用于重置场景、测试）
  //   demolishAll   = 拆除，砖进仓库（玩家按的那个「一键拆除」）
  // 一键拆除：世界拆干净，砖进仓库，【每栋建筑各存一份图纸】。
  //
    // 拆之前先把每栋建筑打包成图纸，再拆。
    // 顺序不能反：拆完 buildings 就被清空了，那时候已经没东西可打包。
  // 这栋建筑算不算「固化过的整体」。
  //
  // 判定只看一件事：它的 buildId 是不是一个【人起过名字】的 id。
  //   · 默认/临时 id（ai、user、testbox、macro:xxx、bp:xxx）→ 不算
  //   · voxel_merge 起的名字（整栋小楼、我的塔）→ 算
  //   · 建的时候给了 saveAs 的 → 算
  //
  // 这样拆世界时，只有真正被当成「一栋楼」对待过的才留图纸，
  // 施工残渣（分几次建出来的碎片）直接变散砖。
  // 这些 id 是「施工过程中的容器」，不是一栋被当成整体对待过的楼。
  //   ai / user / agent  —— 没给 buildId 时的默认值
  //   testbox / saved    —— 历史遗留
  //   pavilion / boat    —— 内置场景，样板东西，拆了不需要留图纸
  const TRANSIENT_IDS = new Set([
    'ai', 'user', 'agent', 'testbox', 'saved',
    'pavilion', 'boat',
  ])
  function isSolidified(buildId) {
    if (typeof buildId !== 'string' || !buildId) return false
    const id = buildId
    if (TRANSIENT_IDS.has(id)) return false
    if (id.startsWith('macro:')) return false
    if (id.startsWith('bp:')) return false
    // 图片工具/面板建的组：程序生成的临时容器，不是「一栋楼」
    if (id.startsWith('image:')) return false
    if (id.startsWith('图片-')) return false
    // 「整体-001」这种自动名算固化过（voxel_merge 给的）
    if (id.startsWith('整体-')) return true
    // 其余带名字的就算
    return true
  }

  function demolishAll() {
    const totalBefore = voxels.size
    // 1. 只给【固化过的】建筑存图纸，其余全变散砖
    //
    // 【为什么要有这个区分】
    // 搭一栋楼常常分成好几次指令建出来（地基一次、主体一次、细节一次），
    // 于是变成好几个独立 buildId。这些零散件不是「一栋楼」，
    // 它们是施工过程中的废料 —— 拆的时候不该每块都存一张图纸，
    // 否则仓库里堆满「agent」「user」「saved」这种谁都不想再用的东西。
    //
    // 判定标准：buildId 是【具名】的（不是默认的 ai/user/testbox 之类）
    // 并且用户在建的时候给了 saveAs —— 也就是说，它被当成一栋楼对待过。
    // 满足这两条的就是「固化过的」，拆掉时存一张完整图纸。
    const savedNames = []
    const looseOnly = []
    for (const bid of Array.from(buildings.keys())) {
      const set = buildings.get(bid)
      if (!set || !set.size) continue
      if (!isSolidified(bid)) { looseOnly.push(bid); continue }
      // 名字冲突就往后面加序号，别覆盖已有的图纸
      let name = bid
      let k = 2
      while (blueprints.has(name)) { name = bid + '-' + k; k++ }
      const r = collectBuilding(bid, name)
      if (r) savedNames.push(r.name)
    }
    // 没固化的那些：只把方块从建筑表里摘掉，砖进仓库，不存图纸
    for (const bid of looseOnly) {
      const set = buildings.get(bid)
      if (set) for (const k of set) voxels.delete(k)
      buildings.delete(bid)
      buildingRot.delete(bid)
      buildingAnchor.delete(bid)
      invalidateBounds(bid)
    }
    // 2. 再把剩下的砖全部回收（collectBuilding 已经把建筑里的砖删了，
    //    这里扫的是「不属于任何建筑」的零散方块）
    let n = 0
    for (const [k, mat] of voxels) {
      addStock(mat, 1)
      n++
      const [x, , z] = unkey(k)
      markDirtyAt(x, z)
    }
    voxels.clear()
    voxelOwner.clear()
    buildingAnchor.clear()
    buildingRot.clear()
    buildings.clear()
    boundsCache.clear()
    // 【全部标脏，不能只依赖上面那个循环】
    // 上面 markDirtyAt 只在「不属于任何建筑的零散方块」那一步调用。
    // 如果方块全在建筑里（最常见的情况），voxels 到这里已经是空的，
    // 那个循环一次都不跑 —— 分桶不会重建，画面就残留着已经删掉的方块：
    // 数据层 stats().total 是 0，渲染层 visible 还是几百块。
    // 所以这里无条件把 36 个桶全标脏，让下一帧统一重建。
    for (let i = 0; i < BUCKET_COUNT; i++) bucketDirty[i] = 1
    anyDirty = true
    // count 是【拆之前的总块数】，不是最后扫到的零散块数。
    // 因为建筑里的砖在 collectBuilding 阶段就被删光了，这里的 n 会是 0。
    // 界面提示要显示真实数量，所以用拆之前的值。
    return { count: totalBefore, saved: savedNames, loose: n }
  }

  function clearVoxels() {
    // 这个是不给砖的硬清空：切场景、跑测试用。
    // 玩家那边一律走 demolishAll。
    voxels.clear()
    voxelOwner.clear()
    buildingAnchor.clear()
    buildingRot.clear()
    buildings.clear()
    for (let i = 0; i < BUCKET_COUNT; i++) bucketDirty[i] = 1
    anyDirty = true
  }

  // ---- 重建一个桶 ----
  // 遍历这个桶里的所有格，对每格 6 个面查邻居。
  // 注意：邻居查询走全局 voxels，所以跨桶的接触面也能正确剔除。
  function rebuildBucket(bid) {
    const bx = bid % BUCKET_N
    const bz = Math.floor(bid / BUCKET_N)
    // 【桶边界必须用格数，不能用米数】
    // x 是格坐标（0~191），桶宽必须换算成格（BUCKET_CELLS）。
    // 用米数 bx * BUCKET_M 只在 CELL=1 时凑巧成立；
    // CELL=0.5 时除了 x<16 的方块，其余全被过滤掉，
    // 表现为「世界里有几千块，但一个都看不见」。
    const x0 = bx * BUCKET_CELLS, x1 = x0 + BUCKET_CELLS
    const z0 = bz * BUCKET_CELLS, z1 = z0 + BUCKET_CELLS

    const data = new Float32Array(BUCKET_CAP * 4)
    let n = 0
    for (const [k, color] of voxels) {
      // 还原坐标
      const z = k % GRID_Z
      const t = (k - z) / GRID_Z
      const y = t % GRID_Y
      const x = (t - y) / GRID_Y
      // 过滤：不属于这个桶就跳过
      // 【注意】桶的归属按【原始】坐标算，不是旋转后的。
      // 旋转是纯渲染变换，不改变方块在数据里的格坐标。
      // 如果按旋转后算，一个方块可能落在别的桶里，那个桶不会重建它 → 消失。
      if (x < x0 || x >= x1 || z < z0 || z >= z1) continue

      // 剔除：只要有一个面朝向空气，这块就在这个桶里出现一次
      let visible = false
      for (const f of FACES) {
        const nx = x + f[0], ny = y + f[1], nz = z + f[2]
        if (!voxels.has(vkey(nx, ny, nz))) { visible = true; break }
      }
      if (!visible) continue

      const o = n * 4

      // 【格坐标 → 世界米】
      // 乘 CELL：格子越小，同样格数占的米数越少。
      //   x=0   格 → -48 米（底板左边缘）
      //   x=96  格 → 0 米（正中，CELL=1 时；CELL=0.5 时是 x=192）
      data[o] = x * CELL + CELL * 0.5 - HALF
      // 抬高一点点：底面方块（y=0）的下表面正好落在 y=0 的底板上，
      // 两者共面会 z-fighting（一条一条闪的深度冲突）。
      // 抬高量跟着 CELL 缩，否则 0.5 米格时 1cm 会显得过高。
      data[o + 1] = y * CELL + CELL * 0.5 + CELL * 0.01
      data[o + 2] = z * CELL + CELL * 0.5 - HALF
      data[o + 3] = color
      n++
      if (n >= BUCKET_CAP) break
    }

    bucketInst[bid] = n
    const vbo = bucketVbo[bid]
    if (vbo) {
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo)
      gl.bufferData(gl.ARRAY_BUFFER, data.subarray(0, n * 4), gl.DYNAMIC_DRAW)
      gl.bindBuffer(gl.ARRAY_BUFFER, null)
    }
    bucketDirty[bid] = 0
  }

  // ---- 把脏桶全部重建 ----
  function flushVoxels() {
    if (!anyDirty) return   // ← 没修改就零成本
    for (let i = 0; i < BUCKET_COUNT; i++) {
      if (bucketDirty[i]) rebuildBucket(i)
    }
    anyDirty = false
    // 【改动之后自动存档】
    // 放在这里而不是每个 setVoxel 里：一次框选可能改几千块，
    // 逐块存档等于每块都写一次 localStorage，必卡死。
    // flush 每帧最多一次，而且只在真的有修改之后才走到这 —— 天然就是节流的。
    // 但连续拖动会每帧都存，所以再加一个时间窗：最长 2 秒存一次。
    maybeSave()
  }

  // 存档节流：距上次存档不足 2 秒就推迟，避免拖动时每帧写盘。
  let saveTimer = 0
  let lastSaveAt = 0
  function maybeSave() {
    const now = Date.now()
    if (now - lastSaveAt >= 2000) {
      lastSaveAt = now
      saveWorld()
      return
    }
    if (saveTimer) return
    saveTimer = window.setTimeout(() => {
      saveTimer = 0
      lastSaveAt = Date.now()
      saveWorld()
    }, 2000)
  }

  // ---- 画方块 ----
  function drawVoxels(cam, env) {
    // 【AI 队列和缓冲重建必须在渲染守卫之前】
    // 数据层和渲染层要分开：队列推进只管数据结构。
    // 如果写在 if (!voxProg) return 之后，一旦着色器创建失败
    // （低端显卡、驱动问题），队列就永远不会推进，指令会石沉大海且不报错。
    pumpAI()
    flushVoxels()

    if (!voxProg) return

    // 全部桶都空就直接返回（最常见的情况）
    let total = 0
    for (let i = 0; i < BUCKET_COUNT; i++) total += bucketInst[i]
    if (total === 0) return

    const e = env || {}
    const sun = e.sunColor || [1, 1, 1]
    gl.useProgram(voxProg)
    gl.uniformMatrix4fv(voxUVP, false, cam.viewProj)
    gl.uniform3fv(voxUSun, sun)
    gl.uniform1f(voxUFog, Number.isFinite(e.fog) ? e.fog : 0)
    gl.uniform3fv(gl.getUniformLocation(voxProg, 'uCamPos'), cam.eye)

    for (let i = 0; i < BUCKET_COUNT; i++) {
      if (bucketInst[i] === 0) continue
      gl.bindVertexArray(bucketVao[i])
      gl.drawElementsInstanced(gl.TRIANGLES, voxIndexCount, gl.UNSIGNED_SHORT, 0, bucketInst[i])
    }
    gl.bindVertexArray(null)
  }

  // ============================================================
  //  七、渲染
  // ============================================================
  // 调用方负责开 DEPTH_TEST / CULL_FACE，并在 finally 里还原到约定末态。
  // env 由引擎每帧传进来（太阳方向/颜色/天空色/雾），这里只读不改。
  function draw(cam, env) {
    if (!ready || !visible || disposed || !groundProg) return
    if (!cam || !cam.viewProj) return

    const e = env || {}
    const sunDir = e.sunDir || [0.0, 1.0, 0.0]
    const sunColor = e.sunColor || [1.0, 1.0, 1.0]
    const skyTop = e.zenith || [0.5, 0.6, 0.8]
    const skyHorizon = e.horizon || [0.8, 0.85, 0.9]
    const fog = Number.isFinite(e.fog) ? e.fog : 0
    // 记住这一帧的相机，供拾取用
    if (e.vpInv) lastVpInv = e.vpInv
    if (Number.isFinite(e.screenW) && e.screenW > 0) lastW = e.screenW
    if (Number.isFinite(e.screenH) && e.screenH > 0) lastH = e.screenH

    // ---- 底座（大陆）----
    // 【两个独立开关】showPlate / showBuild
    //   只关底座 → 建筑浮在海面/草地上 = 「降临」效果
    //   只关建筑 → 只剩一块空工地
    //   都关     → 这一层整个不画（创世大陆不存在）
    // 所以底座和方块必须各自判断，不能共用一个 visible。
    if (showPlate) {
      gl.useProgram(groundProg)
      gl.uniformMatrix4fv(uVP, false, cam.viewProj)
      gl.uniform3fv(uEye, cam.eye)
      gl.uniform3fv(uSunDir, sunDir)
      gl.uniform3fv(uSunColor, sunColor)
      gl.uniform3fv(uSkyTop, skyTop)
      gl.uniform3fv(uSkyHorizon, skyHorizon)
      gl.uniform1f(uFog, fog)
      gl.uniform1f(uTime, e.time || 0)
      gl.uniform1f(uGridOn, 1.0)
      gl.bindVertexArray(groundVao)
      gl.drawArrays(gl.TRIANGLES, 0, 6)
    }

    // 空间参考线默认不画。几何和着色器保留，需要调试网格时打开即可。

    // ---- 方块 ----
    // 放在最后：它是最「实体」的一层，前面的地板已经画完了。
    // 内部自己做脏标记判断，没有方块/没有修改时这一步几乎零成本。
    //
    // 【不开背面剔除】
    // WebGL 屏幕坐标系 y 轴朝下，投影后三角形绕序会翻一次，
    // 用 CULL_FACE + frontFace(CCW) 会把朝向相机的面误判成背面剔掉，
    // 表现为方块缺面、能看穿。
    //
    // 代价是多画背对相机的外表面；内部面在几何阶段已经剔除，量很小。
    // 换来的是确定性：不会因绕序约定不同而缺面。
    if (voxProg && showBuild) {
      gl.disable(gl.CULL_FACE)
      try { drawVoxels(cam, env) } finally {
        gl.disable(gl.CULL_FACE)
      }
    }

    gl.bindVertexArray(null)
  }

  // ============================================================
  //  七、相机（主视角固定方向，只有距离可调）
  // ============================================================
  // 俯角固定（BASE_PITCH），只按 camDist 改斜距 —— 所以是「推拉」，不是「旋转」。
  function eye() {
    const r = Math.cos(BASE_PITCH) * camDist
    const y = Math.sin(BASE_PITCH) * camDist
    // 水平方向保持 BASE_EYE 那个朝向（从 +Z 看过来），只缩放长度
    const ux = BASE_DX / BASE_R
    const uz = BASE_DZ / BASE_R
    return [CAM_TARGET[0] + ux * r, CAM_TARGET[1] + y, CAM_TARGET[2] + uz * r]
  }

  function target() {
    return CAM_TARGET
  }

  // ============================================================
  //  开关
  // ============================================================
  function setVisible(on) {
    const wasVisible = visible
    visible = !!on
    if (visible) attachWheel()
    else detachWheel()
    // 【从关到开的那一次，决定世界里有什么】
    // 优先级：已存档的世界 > 空世界内置的样板凉亭 > 玩家自己搭的（不动）
    //   1. 内存里有东西（同一次生命周期内切过地图）→ 不动，玩家的东西还在
    //   2. 内存空但 localStorage 有存档（刷新过页面）→ 读存档
    //   3. 都没有（第一次进）→ 搭一座凉亭当样板
    // 只在「从关到开」触发，来回切不会重复叠加。
    if (visible && !wasVisible) {
      if (voxels.size === 0) {
        const loaded = loadWorld()
        if (loaded === 0) {
          // 第一次进来：同时搭一艘船（南边）和一座凉亭（中心）
          // 两个样板互为对照 —— 一个是「协议写出来的」，一个是「一块块搭出来的」
          // 注意传 clearFirst=false：先搭的那一个不能把后搭的清掉
          try { buildPavilion(Math.floor(GRID_X / 2), Math.floor(GRID_Z / 2), true) } catch (error) { /* 放不出来也不影响空底板 */ }
          try { buildBoat() } catch (error) { /* 同上 */ }
        }
      }
    }
    return visible
  }
  // 引擎交进来的那张 canvas。滚轮是否接管相机要看它。


  // ---- 两个子开关 ----
  // part: "plate"（底座/大陆）或 "build"（建筑）
  //
  // 【两个都关 = 整个大陆关掉】
  // 这是用户定的规矩：底座和建筑都不显示了，那这层东西就等于不存在，
  // 不该还占着相机、还响应滚轮。
  // 反过来，只要有一个还开着，整层就活着。
  // 引擎在 init 之后会把 canvas 交进来。
  //
  // 【这个函数必须存在，即使什么都不做】
  // ocean-engine.js 里是这么调的：
  //     voxelPass.bindCanvas(canvas)
  //     if (!voxelPass.init(gl)) voxelPass = null
  // 两句在同一个 try 块里。如果 bindCanvas 不存在，第一句就抛 TypeError，
  // 被 catch 吞掉，init 永远不执行，ready 永远是 false ——
  // 表现就是「方块大陆整个不显示，而且控制台只有一条不显眼的警告」。
  //
  // 本版本相机不接受拖拽，不需要 pointer 事件，但接口形状要保持。
  // 引擎在 init 之后会把 canvas 交进来。
  //
  // 【为什么必须记住它】
  // 滚轮是否该接管相机，判据是「鼠标是不是落在这张 canvas 上」。
  // 不记下来就判断不了，只能退回「排除法」，而排除法会连对话框一起抢。
  //
  // 注意：这个函数必须存在，即使什么都不做 —— ocean-engine 里
  //   voxelPass.bindCanvas(canvas)
  //   if (!voxelPass.init(gl)) ...
  // 两句在同一个 try 里。函数不存在第一句就抛 TypeError，
  // init 永远不执行，整个方块大陆不显示。
  function bindCanvas() {
    // 不需要记住 canvas 了 —— 滚轮改用「光标是否在可滚区域」判断。
    // 但这个函数必须存在：ocean-engine 里 bindCanvas 和 init 在同一个 try 里，
    // 它不存在第一句就抛 TypeError，init 永远不执行，整个方块大陆不显示。
  }

  // 显示/隐藏辅助网格（砖缝）。底座本身永远在。
  // ocean-engine.js 每拍都会调它，接口必须存在 —— 少了这一句，
  // 那一次调用会抛 TypeError，和 bindCanvas 是同一类问题。
  function setGrid(on) {
    showGrid = !!on
    return showGrid
  }

  function setPart(part, on) {
    if (part === 'plate') showPlate = !!on
    else if (part === 'build') showBuild = !!on
    else return { showPlate, showBuild, visible }
    const anyOn = showPlate || showBuild
    if (!anyOn) {
      // 两个都关 → 整层退场（相机归还、滚轮摘掉）
      if (visible) setVisible(false)
    } else if (!visible) {
      // 有一个要开，但整层还是关的 → 打开整层
      setVisible(true)
    }
    return { showPlate, showBuild, visible }
  }

  function getParts() {
    return { showPlate, showBuild, visible }
  }

  // 滚轮缩放。
  // 只监听 wheel，不碰 pointerdown/move —— 拖拽类是「壁纸模式下点鱼和地面」
  // 那套交互的地盘（它挂在 document 捕获阶段），两者不能抢。
  let wheelEl = null
  let wheelHandler = null

  // 滚轮归谁？—— 光标在对话区里的时候，归对话区。
  //
  // 【判据只有一条】
  // 打开「看世界」后，光标第一个落点就在输入框里（要打字）。
  // 有字之后想在对话记录里上下翻，光标也还在那一块。
  // 所以只要光标在对话区域里，滚轮就该归它，不该跑去放大缩小地图。
  //
  // 反过来，光标在地图空白处时，滚轮才推拉相机。
  //
  // 【怎么认「对话区域」】
  // 不写死 DSH 的具体选择器（它随时会变），而是往上找：
  // 只要光标所在元素，或它的任意祖先，
  //   · 是可滚动容器（scrollHeight > clientHeight 且有 overflow）
  //   · 或者是输入类元素（input / textarea / contenteditable）
  // 就认为「这里能滚，别抢」。
  //
  // 这条判据不依赖任何具体类名，DSH 改版也不会失效。


  // 这个元素是不是「自己能滚」或「是输入框」
  function isScrollableOrInput(el) {
    if (!el || el.nodeType !== 1) return false
    const tag = el.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable) return true
    const style = window.getComputedStyle ? window.getComputedStyle(el) : null
    if (!style) return false
    const oy = style.overflowY
    if (oy === 'auto' || oy === 'scroll' || oy === 'overlay') {
      if (el.scrollHeight > el.clientHeight + 1) return true
    }
    return false
  }

  function attachWheel() {
    if (wheelHandler) return
    wheelHandler = (e) => {
      if (!visible) return

      // 从光标所在元素往上走，碰到「能滚的」或「输入框」就放手
      let node = e.target
      let depth = 0
      while (node && depth < 12) {
        if (isScrollableOrInput(node)) return
        node = node.parentElement
        depth++
      }

      // deltaY > 0 = 往下滚 = 拉远
      const k = e.deltaY > 0 ? 1.1 : 1 / 1.1
      camDist = Math.max(CAM_DIST_MIN, Math.min(CAM_DIST_MAX, camDist * k))
      e.preventDefault()
    }
    wheelEl = window
    wheelEl.addEventListener('wheel', wheelHandler, { passive: false })
  }
  function detachWheel() {
    if (wheelEl && wheelHandler) wheelEl.removeEventListener('wheel', wheelHandler)
    wheelEl = null
    wheelHandler = null
  }


  // ============================================================
  //  九、清理
  // ============================================================
  function dispose() {
    if (disposed) return
    disposed = true
    // 滚轮监听必须在这里摘掉：不摘的话，插件关掉后 window 上还挂着一个
    // 闭住了整个模块的 handler，重新打开会叠成两份，而且旧的还能改 camDist。
    detachWheel()
    try {
      if (groundVbo) gl && gl.deleteBuffer(groundVbo)
      if (groundVao) gl && gl.deleteVertexArray(groundVao)
      if (groundProg) gl && gl.deleteProgram(groundProg)
      // 方块系统：立方体模板 + 36 个桶的缓冲和 VAO
      if (voxCubeVbo) gl && gl.deleteBuffer(voxCubeVbo)
      if (voxVao) gl && gl.deleteVertexArray(voxVao)
      if (voxProg) gl && gl.deleteProgram(voxProg)
      for (let i = 0; i < BUCKET_COUNT; i++) {
        if (bucketVbo[i]) gl && gl.deleteBuffer(bucketVbo[i])
        if (bucketVao[i]) gl && gl.deleteVertexArray(bucketVao[i])
        bucketVbo[i] = null
        bucketVao[i] = null
        bucketInst[i] = 0
      }
    } catch (error) { /* 上下文已失效 */ }
    voxCubeVbo = null
    voxVao = null
    voxProg = null
    groundVbo = null
    groundVao = null
    groundProg = null
    // 【数据不清空】
    // 不在这里清空世界。
    // 地形切换只是「换个地方看」，退出再回来作品应该还在。
    //
    // 现在区分两种销毁：
    //   dispose()  —— 模块被卸载/重载（离开这块地形）。数据保留在模块里，
    //                 不过脚本重新执行时整个模块是新的，所以真正跨重启的
    //                 持久化要等以后做存档（localStorage）。
    //   clearVoxels() —— 显式清空（玩家按拆除，或者调用方要重置）
    //
    // 注意：这只解决「同一次页面生命周期内切换地形」。
    // 刷新页面 / 重启 DSH 还是会丢 —— 那需要存档，是下一步。
    anyDirty = false
    for (let i = 0; i < BUCKET_COUNT; i++) bucketDirty[i] = 0
    ready = false
    visible = false
  }

  // ============================================================
  //  材质表（索引必须和着色器 palette 的顺序一致）
  // ============================================================
  // 24 色。索引必须和着色器 palette() 的顺序一致。
  // 0 = 红，1 = 绿，2 = 蓝 —— 纯色块，做像素画/显示屏最直接。
  // 24 种颜色：魔方六色 + 浅/深/中间调。
  //
  // 【为什么从 6 扩到 24】
  // 六色全是高饱和的鲜艳色，装不下照片。实测：深蓝头发 rgb(25,45,91)
  // 到「蓝」的距离 179，到「绿」只有 141 —— 于是整幅人像变成绿色。
  // 加了深蓝、浅蓝、深绿、灰阶之后，这类颜色才有归宿。
  //
  // 【顺序必须和着色器 palette() 一致】两边各存一份没法避免
  //（GLSL 不能让 JS 注入常量表），改一边就必须改另一边。
  const MATERIALS = [
    { id: 0, name: '红', css: '#e62e33' },
    { id: 1, name: '黄', css: '#f2c71a' },
    { id: 2, name: '蓝', css: '#298cf2' },
    { id: 3, name: '白', css: '#f0f0ea' },
    { id: 4, name: '橙', css: '#f27a1a' },
    { id: 5, name: '绿', css: '#33b857' },
    { id: 6, name: '浅红', css: '#f79e9e' },
    { id: 7, name: '浅黄', css: '#fae68c' },
    { id: 8, name: '浅蓝', css: '#99c7fa' },
    { id: 9, name: '浅绿', css: '#a6e6ad' },
    { id: 10, name: '深红', css: '#9e1a1f' },
    { id: 11, name: '深黄', css: '#ad850a' },
    { id: 12, name: '深蓝', css: '#0d296b' },
    { id: 13, name: '深绿', css: '#0f5224' },
    { id: 14, name: '浅棕', css: '#d1ae80' },
    { id: 15, name: '棕', css: '#734d29' },
    { id: 16, name: '浅灰', css: '#b8b8b8' },
    { id: 17, name: '深灰', css: '#616166' },
    { id: 18, name: '黑', css: '#1a1a1f' },
    { id: 19, name: '粉', css: '#d98ccc' },
    { id: 20, name: '青', css: '#26a6ad' },
    { id: 21, name: '紫', css: '#7347a6' },
    { id: 22, name: '橄榄', css: '#858c38' },
    { id: 23, name: '肤色', css: '#e0b89e' },
  ]

  // ============================================================
  //  仓库：拆下来的砖按材质计数
  // ============================================================
  // 「拆出来的砖要能收起来」的最小实现：
  //   挖一块 / 拆除一片 → 按材质 +1 存进仓库
  //   仓库只记【数量】，不记坐标 —— 所以它是几个数字，不随建筑变大
  //
  // 这正是为什么拆楼不会让内存涨：砖的「个体」不重要，只有「有多少块」重要。
  // 每种材质一个计数槽。当前 24 种，数组留到 32 以防以后再加。
  const warehouse = new Array(32).fill(0)

  function stockOf(mat) {
    const i = mat | 0
    if (i < 0 || i >= warehouse.length) return 0
    return warehouse[i]
  }
  function addStock(mat, n) {
    const i = mat | 0
    if (i < 0 || i >= warehouse.length) return
    warehouse[i] += n
  }
  function warehouseSnapshot() {
    const out = []
    for (const m of MATERIALS) out.push({ id: m.id, name: m.name, count: warehouse[m.id] })
    return out
  }

  // ============================================================
  //  基础宏：用一条指令生成一片格子
  // ============================================================
  // 全部遵守同一条铁律：宏只产出「坐标列表」，落子在 setVoxel 统一做校验。
  // 这样宏写得再野，越界/超限也会被底层拦住，不会炸世界。
  //
  // 每个宏返回写入的块数，失败返回 0。

  // box：实心长方体。从 (x,y,z) 起，尺寸 sx,sy,sz。
  function macroBox(x, y, z, sx, sy, sz, mat, buildId) {
    let n = 0
    for (let ix = 0; ix < sx; ix++) {
      for (let iy = 0; iy < sy; iy++) {
        for (let iz = 0; iz < sz; iz++) {
          if (setVoxel(x + ix, y + iy, z + iz, mat, buildId)) n++
        }
      }
    }
    return n
  }

  // hollow：空心盒（只留六面壳）。这是建房子最常用的形状 ——
  // 实心 8x8x8 是 512 块，空心只要 296 块，而且内部面还会被剔除。
  function macroHollow(x, y, z, sx, sy, sz, mat, buildId) {
    let n = 0
    for (let ix = 0; ix < sx; ix++) {
      for (let iy = 0; iy < sy; iy++) {
        for (let iz = 0; iz < sz; iz++) {
          const shell = ix === 0 || ix === sx - 1
            || iy === 0 || iy === sy - 1
            || iz === 0 || iz === sz - 1
          if (!shell) continue
          if (setVoxel(x + ix, y + iy, z + iz, mat, buildId)) n++
        }
      }
    }
    return n
  }

  // line：从起点到终点的直线，带一个整数厚度。
  // 用「按最长轴等分取整」而不是三维 Bresenham ——
  // 后者写法多、边界容易错，而这里只需要一条视觉上连得起来的线。
  // steps = 最长轴的距离，每步在三个轴上按比例插值取整，格子一定连在一起。
  function macroLine(x1, y1, z1, x2, y2, z2, mat, buildId, thick) {
    const t = Math.max(1, thick | 0)
    const dx = x2 - x1, dy = y2 - y1, dz = z2 - z1
    const steps = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz))
    let n = 0
    // steps=0 表示起终点重合，只放一个点
    for (let i = 0; i <= steps; i++) {
      const k = steps === 0 ? 0 : i / steps
      const x = Math.round(x1 + dx * k)
      const y = Math.round(y1 + dy * k)
      const z = Math.round(z1 + dz * k)
      for (let ix = 0; ix < t; ix++) {
        for (let iy = 0; iy < t; iy++) {
          for (let iz = 0; iz < t; iz++) {
            if (setVoxel(x + ix, y + iy, z + iz, mat, buildId)) n++
          }
        }
      }
    }
    return n
  }

  // stairs：楼梯。从 (x,y,z) 起，steps 级，每级沿 +Z 前进一格、向上抬 rise 格。
  function macroStairs(x, y, z, steps, width, mat, buildId, rise) {
    const r = Math.max(1, rise | 0)
    let n = 0
    for (let s = 0; s < steps; s++) {
      for (let w = 0; w < width; w++) {
        if (setVoxel(x + w, y + s * r, z + s, mat, buildId)) n++
        // 每级下面垫实，否则楼梯是悬空的一排
        for (let k = 1; k < r; k++) {
          if (setVoxel(x + w, y + s * r - k, z + s, mat, buildId)) n++
        }
      }
    }
    return n
  }

  // sphere：球（空心壳）。半径 r，中心 (cx,cy,cz)。
  // 空心壳判定：点在球面上 —— 距离 <= r 且 > r-1。
  function macroSphere(cx, cy, cz, r, mat, buildId) {
    const rr = r * r
    const r0 = (r - 1) * (r - 1)
    let n = 0
    for (let ix = -r; ix <= r; ix++) {
      for (let iy = -r; iy <= r; iy++) {
        for (let iz = -r; iz <= r; iz++) {
          const d = ix * ix + iy * iy + iz * iz
          if (d > rr || d <= r0) continue
          if (setVoxel(cx + ix, cy + iy, cz + iz, mat, buildId)) n++
        }
      }
    }
    return n
  }

  // 施工高度：-1 = 自动（落在这一列顶上），0..31 = 固定层。
  // 这是「能盖架空建筑」的关键：凉亭的屋顶必须固定在 y=4 那一层，
  // 不能随着每列已有的高度乱跑。
  let buildY = -1

  // ============================================================
  //  射线拾取：屏幕坐标 → 世界格子
  // ============================================================
  // 三步：
  //   1. 屏幕像素 → NDC
  //   2. NDC 两点（近/远）反投影成世界射线
  //   3. 射线与 y=0 平面求交 → 世界 XZ → 格子坐标
  //
  // 只对 y=0 的底板求交，不做体素 DDA。
  // 理由：现在只有一层地面可点，DDA 穿方块是「往已有方块上叠」才需要的，
  // 那是下一步。这个版本点哪儿就在哪块地砖上放一块。
  //
  // 需要调用方提供 viewProj 和逆矩阵（引擎每帧有，传进来即可）。
  // planeY：射线要和哪个高度的水平面求交（米，默认 0 = 地面）。
  // 点建筑时必须能指定高度 —— 建筑有高度，鼠标点在屋顶上，
  // 用 y=0 求交会落到建筑外侧很远的空地上。
  function pickGroundGrid(sx, sy, viewProjInv, screenW, screenH, planeY) {
    if (!viewProjInv) return null
    // 【坐标必须用 CSS 像素，不能用渲染像素】
    // 引擎传进来的 screenW/H 是 canvas 的绘制尺寸（= window.innerWidth × devicePixelRatio）。
    // 而鼠标事件的 clientX/clientY 是 CSS 像素。直接拿它们去除，在 DPR≠1 的屏幕上
    // 会整体偏掉一半 —— 这就是「鼠标落点和砖块落点没对齐」的真正原因。
    // NDC 是归一化的，所以这里用 CSS 尺寸换算即可，和 canvas 实际分辨率无关。
    const cssW = (window.innerWidth || screenW || 1)
    const cssH = (window.innerHeight || screenH || 1)
    const ndcX = (sx / cssW) * 2 - 1
    const ndcY = 1 - (sy / cssH) * 2
    const m = viewProjInv

    const unproject = (z) => {
      const cx = m[0] * ndcX + m[4] * ndcY + m[8] * z + m[12]
      const cy = m[1] * ndcX + m[5] * ndcY + m[9] * z + m[13]
      const cz = m[2] * ndcX + m[6] * ndcY + m[10] * z + m[14]
      const cw = m[3] * ndcX + m[7] * ndcY + m[11] * z + m[15]
      if (!(Math.abs(cw) > 1e-9)) return null
      return [cx / cw, cy / cw, cz / cw]
    }
    const a = unproject(-1)
    const b = unproject(1)
    if (!a || !b) return null

    const dy = b[1] - a[1]
    if (!(Math.abs(dy) > 1e-9)) return null
    const plane = Number.isFinite(planeY) ? planeY : 0
    const t = (plane - a[1]) / dy     // 求与指定高度平面的交点
    if (!(t > 0)) return null          // 射线朝上，打不到地面
    const wx = a[0] + (b[0] - a[0]) * t
    const wz = a[2] + (b[2] - a[2]) * t

    // 世界坐标（米）→ 格坐标
    // 和渲染那边是同一套换算的逆运算：米 → 格要除以 CELL。
    // 米 → 格要除以 CELL。
    const gx = Math.floor((wx + HALF) / CELL)
    const gz = Math.floor((wz + HALF) / CELL)
    if (gx < 0 || gx >= GRID_X || gz < 0 || gz >= GRID_Z) return null
    return { x: gx, z: gz, wx, wz }
  }

  // 直接落地一座凉亭（和 scenePlan 共用 shapePavilion）
  function buildPavilion(cx, cz, clearFirst) {
    if (clearFirst !== false) clearVoxels()
    const X = Number.isInteger(cx) ? cx : Math.floor(GRID_X / 2)
    const Z = Number.isInteger(cz) ? cz : Math.floor(GRID_Z / 2)
    let n = 0
    shapePavilion(X, Z, (x, y, z, m) => {
      if (setVoxel(x, y, z, m, 'pavilion')) n++
    })
    return n
  }

  // ============================================================
  //  存档：把世界存进 localStorage
  // ============================================================
  // 只解决「刷新页面 / 重开 DSH 之后东西还在」。
  // 存法：一条 "x,y,z,m" 记录一个方块，用逗号拼起来。
  //   6 万块时大约 1.5MB —— localStorage 一般有 5MB 上限，够用。
  //   存之前先看块数，超过 30000 就只存建筑的包围盒提示（不存全量），
  //   避免把 localStorage 写爆导致整个页面功能挂掉。
  //
  // 这不是最终方案（最终该用 IndexedDB），但够把「刷新就没了」这个痛点解决掉。
  // v2：材质从「白玉/石头/木头」换成「红/绿/蓝」。
  // 键名也一起升版 —— 否则会读到旧存档里的材质编号，
  // 那批编号在旧方案里代表白玉，新方案里变成红色，看着像数据坏了。
  const SAVE_KEY = 'dsh-weather-sandbox/voxel-world-v2'
  const SAVE_MAX = 30000

  function saveWorld() {
    try {
      if (voxels.size > SAVE_MAX) return false
      const parts = []
      for (const [k, m] of voxels) {
        const [x, y, z] = unkey(k)
        parts.push(x + ',' + y + ',' + z + ',' + m)
      }
      const text = parts.join(';')
      window.localStorage.setItem(SAVE_KEY, text)
      return true
    } catch (error) {
      // 配额满了 / 隐私模式禁用了 localStorage，都安静失败
      return false
    }
  }

  function loadWorld() {
    try {
      const text = window.localStorage.getItem(SAVE_KEY)
      if (!text) return 0
      voxels.clear()
      voxelOwner.clear()
      buildingAnchor.clear()
      buildingRot.clear()
      buildings.clear()
      // boundsCache 也要清：它按 buildId 缓存包围盒，
      // 不清的话加载新存档后会读到上一份世界的包围盒 ——
      // 旋转轴、拾取范围、快照锚点全都会错。
      boundsCache.clear()
      let n = 0
      for (const rec of text.split(';')) {
        if (!rec) continue
        const p = rec.split(',')
        if (p.length < 4) continue
        const x = +p[0], y = +p[1], z = +p[2], m = +p[3]
        if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(z)) continue
        // 直接写 map（不走 setVoxel）：load 时要的是「重建」，不需要逐块触发脏标记逻辑
        voxels.set(vkey(x, y, z), Number.isInteger(m) ? m : 0)
        let set = buildings.get('saved')
        if (!set) { set = new Set(); buildings.set('saved', set) }
        set.add(vkey(x, y, z))
        n++
      }
      // 全部标脏，下一帧统一重建
      for (let i = 0; i < BUCKET_COUNT; i++) bucketDirty[i] = 1
      anyDirty = true
      return n
    } catch (error) {
      return 0
    }
  }

  function clearSave() {
    try { window.localStorage.removeItem(SAVE_KEY) } catch (error) { /* 忽略 */ }
  }

  // ============================================================
  //  撤销栈
  // ============================================================
  // 记录「每一次操作改了什么」，右键/撤销键回退一步。
  //
  // 为什么要它：鼠标太灵敏，稍微拖一下就连着放好几块，
  // 而之前唯一的办法是一块块挖掉 —— 放着容易、拆着费劲，手感很糟。
  //
  // 记录粒度是【一次操作】，不是一块方块：
  //   拖一下放 5 块 → 一条记录（含 5 个坐标）
  //   框选一次 81 块 → 一条记录（含 81 个坐标）
  //   所以撤销一次就回到操作之前，不用点 81 下。
  //
  // 每条记录：
  //   { type: 'add',    cells: [[x,y,z,mat], ...] }   ← 撤销 = 把这些块删掉
  //   { type: 'remove', cells: [[x,y,z,mat], ...] }   ← 撤销 = 把这些块放回去
  //
  // 上限 200 步：再旧的丢掉。200 步对建造够用，内存也可控
  // （最坏 200 × 4096 × 4 个数，但实际拖动一般几步而已）。
  const UNDO_MAX = 200
  const undoStack = []
  // 当前正在累积的操作。开工时 beginOp()，结束时 endOp()。
  // 拖动过程中每一块都进同一个 op，松手才提交 —— 这样「拖一下」= 一个撤销步。
  let pendingOp = null

  function beginOp() {
    // 上一个没提交就丢掉（一般不会发生，防御性）
    pendingOp = { cells: [] }
  }

  function noteCell(x, y, z, mat, isAdd) {
    if (!pendingOp) return
    pendingOp.cells.push([x, y, z, mat, isAdd ? 1 : 0])
  }

  function endOp() {
    if (!pendingOp) return null
    const cells = pendingOp.cells
    pendingOp = null
    if (!cells.length) return null
    undoStack.push(cells)
    if (undoStack.length > UNDO_MAX) undoStack.shift()
    return cells.length
  }

  // 撤销一步。返回 { type, count } 或 null（没东西可撤）
  function undo() {
    const cells = undoStack.pop()
    if (!cells) return null
    let n = 0
    // 【这里不能用 setVoxel / removeVoxel】
    // 那两个会调 noteCell 把撤销本身也记进新的操作里，导致撤销的撤销乱套。
    // 所以这里直接改 map + 标脏，走一条不记账的快路。
    for (const [x, y, z, mat, wasAdd] of cells) {
      const k = vkey(x, y, z)
      if (wasAdd) {
        // 「放」的逆操作是删，删掉的砖进仓库（和挖掉一致）
        const cur = voxels.get(k)
        if (cur !== undefined) {
          voxels.delete(k)
          voxelOwner.delete(k)
          addStock(cur, 1)
          for (const set of buildings.values()) set.delete(k)
          markDirtyAt(x, z)
          n++
        }
      } else {
        // 「删」的逆操作是放回
        if (!voxels.has(k)) {
          voxels.set(k, mat | 0)
          addStock(mat | 0, -1)
          const bid = 'undo'
          let set = buildings.get(bid)
          if (!set) { set = new Set(); buildings.set(bid, set) }
          set.add(k)
          markDirtyAt(x, z)
          n++
        }
      }
    }
    anyDirty = true
    return { count: n, remaining: undoStack.length }
  }

  function canUndo() { return undoStack.length > 0 }
  function undoDepth() { return undoStack.length }
  function clearUndo() { undoStack.length = 0; pendingOp = null }

  // 标一个格及其 6 个邻居所在的桶为脏（邻居的面可能因此要重算）。
  // 桶按 XZ 二维分，y 不影响归属，所以只查两个方向。
  function markDirtyAt(x, z) {
    bucketDirty[bucketOf(x, z)] = 1
    for (const f of FACES) {
      const nx = x + f[0], nz = z + f[2]
      if (nx >= 0 && nx < GRID_X && nz >= 0 && nz < GRID_Z) bucketDirty[bucketOf(nx, nz)] = 1
    }
  }

  // ============================================================
  //  AI 模式：文本指令 → 解析 → 分帧生成
  // ============================================================
  //
  // 设计契约（补丁 9）：
  //   AI 不吐坐标，只吐【一句话】。解析器把它展开成几千个方块指令，
  //   再分帧慢慢生成 —— 看得见方块一块块长出来，而且不卡。
  //
  //   一句话最多几十个 token，控住的是几万块的世界。
  //
  // 指令格式（故意做得极简，AI 不容易写错）：
  //   box x y z 宽 高 深 材质
  //   hollow x y z 宽 高 深 材质      空心盒
  //   line x1 y1 z1 x2 y2 z2 材质 [厚]
  //   stairs x y z 步数 宽 材质 [升]
  //   sphere cx cy cz 半径 材质
  //   clear                           清空
  //
  // 一句可以带多条，用分号或换行隔开：
  //   box 40 0 40 10 1 10 2; hollow 40 1 40 10 5 10 1
  //
  // 材质：0-5 红黄蓝白橙绿（魔方六色），6-9 浅色，10-13 深色，14-23 棕灰黑粉青紫橄榄肤色

  // ---- 分帧队列 ----
  // 每条任务 = 一个宏展开后的坐标数组 + 当前进度。
  // 每帧每个任务最多处理 PER_FRAME 块 —— 超过就留到下一帧。
  // 每帧预算（块）。用 let 而不是 const：UI 上的「生长速度」要能改它。
  // 60 是默认值 —— 60fps 下约 3600 块/秒，一块 500 块的房子 2~3 秒长完，
  // 既看得见生长过程，又不至于等太久。
  let PER_FRAME = 60
  let aiQueue = []        // [{ name, cells:[[x,y,z,mat],...], at:0 }]
  let aiDone = 0          // 本批已完成块数
  let aiTotal = 0         // 本批总块数
  let aiActive = false

  // 解析一段文本，产出任务列表（只解析，不生成）
  // ============================================================
  //  frame：先立轴，再说方位
  // ============================================================
  //
  // 【为什么要有这个】
  // 用 box 建楼，AI 必须自己算「南墙在 z 等于几」——
  // 六个数字错一个，整堵墙就歪。这不是 AI 不会推理，
  // 是一维数字流根本不适合表达三维关系。
  //
  // 所以把轴立起来：先说这块地是哪个矩形，然后所有指令用【方位词】。
  //   frame 88 88 111 103      ← 这块地 x 88..111，z 88..103
  //   wall 南 高8 厚2          ← 贴着南边立墙，AI 不用算 z 是多少
  //   door 南 中心 宽8 高6     ← 南墙正中间开门
  //
  // 坐标由这里算。AI 只说「要什么」。
  //
  // 【frame 是「最后一条 frame 指令」的当前值】
  // 它跟着指令流走：写一条 frame 之后，后面的方位指令都相对它。
  // 换一个 frame 就是换一块地。写完 frame off 回到纯坐标模式。

  // frame 当前值：{ x1, z1, x2, z2, y } —— y 是当前的施工高度
  // null 表示没有 frame，后面的方位指令会报错（而不是猜一个）
  let frameCur = null

  // 方位词 → 那条边的矩形
  // 返回 { x, z, w, d, axis }：
  //   axis='x' 表示这条边沿 X 方向延伸（南/北墙），厚在 Z 上加
  //   axis='z' 表示沿 Z 方向延伸（东/西墙），厚在 X 上加
  function frameEdge(side, thick) {
    if (!frameCur) return null
    const { x1, z1, x2, z2 } = frameCur
    const w = x2 - x1 + 1
    const d = z2 - z1 + 1
    const th = Math.max(1, thick | 0)
    switch (side) {
      case '南': return { x: x1, z: z2 - th + 1, w, d: th, axis: 'x' }
      case '北': return { x: x1, z: z1, w, d: th, axis: 'x' }
      case '西': return { x: x1, z: z1, w: th, d, axis: 'z' }
      case '东': return { x: x2 - th + 1, z: z1, w: th, d, axis: 'z' }
      default: return null
    }
  }

  // 在一条边上定位：offset 是「沿着边方向」的偏移，align 是 'left'|'center'|'right'
  // 返回起始坐标和长度。长度超过边长就截断（不报错，画得出来最重要）。
  function frameSpan(edge, offset, size, align) {
    const along = edge.axis === 'x' ? edge.w : edge.d
    const len = Math.max(1, Math.min(Math.max(1, size | 0), along))
    let start
    if (align === 'center') {
      start = Math.floor((along - len) / 2)
    } else if (align === 'right') {
      start = along - len - Math.max(0, offset | 0)
    } else {
      // 默认 left
      start = Math.max(0, offset | 0)
    }
    start = Math.max(0, Math.min(start, along - len))
    return { start, len }
  }

  // 把一条边 + 偏移 + 尺寸，换算成实际格坐标
  function framePlace(edge, offset, size, align) {
    const sp = frameSpan(edge, offset, size, align)
    if (edge.axis === 'x') {
      return { x: edge.x + sp.start, z: edge.z, w: sp.len, d: edge.d }
    }
    return { x: edge.x, z: edge.z + sp.start, w: edge.w, d: sp.len }
  }

  // 把「墙 + 门/窗」这类指令展开成 box 任务
  // cells 由调用方收集：这里是纯函数，产出 [{x,y,z,w,h,d,mat,hollow}]
  function frameWallBox(place, y, h, mat) {
    return { x: place.x, y, z: place.z, w: place.w, h: Math.max(1, h | 0), d: place.d, mat: mat | 0 }
  }

  function parseCommands(text) {
    const tasks = []
    const errors = []
    if (!text || typeof text !== 'string') return { tasks, errors: ['空指令'] }

    for (const raw of text.split(/[\n;]/)) {
      const line = raw.trim()
      if (!line) continue
      const p = line.split(/\s+/)
      const cmd = p[0].toLowerCase()
      const num = (i) => {
        const v = Number(p[i])
        return Number.isFinite(v) ? Math.trunc(v) : NaN
      }
      const okNums = (from, to) => {
        for (let i = from; i <= to; i++) if (!Number.isFinite(num(i))) return false
        return true
      }

      // ---- 键值对参数：让参数顺序无关，AI 不必记位置 ----
      //   wall 北 高8 厚2 材质1      ← 带名字，随便写
      //   wall 北 8 2 1             ← 也可以纯数字
      // 返回 { 高:8, 厚:2, 材质:1, _nums:[8,2,1] }
      // 中文名和英文名都认，避免 AI 记不住用哪种。
      const kv = (from) => {
        const out = { _nums: [] }
        for (let i = from; i < p.length; i++) {
          const tok = p[i]
          const m2 = tok.match(/^([\u4e00-\u9fa5a-zA-Z_]+)(-?\d+)$/)
          if (m2) {
            const key = m2[1].toLowerCase()
            out[key] = Number(m2[2])
          } else if (/^-?\d+$/.test(tok)) {
            out._nums.push(Number(tok))
          }
        }
        return out
      }
      // 取值：先按名字找（中英文都试），找不到就按顺序取第 n 个数字
      const pick = (obj, names, nth, dflt) => {
        for (const nm of names) {
          if (Number.isFinite(obj[nm])) return obj[nm]
        }
        if (Number.isFinite(obj._nums[nth])) return obj._nums[nth]
        return dflt
      }

      // ---- frame：立轴 ----
      if (cmd === 'frame') {
        // frame x1 z1 x2 z2   —— 立一块地
        // frame off            —— 取消，回到纯坐标模式
        if (p[1] === 'off' || p[1] === 'none') {
          frameCur = null
          continue
        }
        if (p.length < 5 || !okNums(1, 4)) {
          errors.push(line + ' <-- frame 需要 4 个坐标 x1 z1 x2 z2')
          continue
        }
        const ax = Math.min(num(1), num(3)), bx = Math.max(num(1), num(3))
        const az = Math.min(num(2), num(4)), bz = Math.max(num(2), num(4))
        frameCur = { x1: ax, z1: az, x2: bx, z2: bz, y: 0, top: 0 }
        continue
      }

      // ---- 方位指令：全部相对当前 frame ----
      // 这些指令的共同点：第一个参数是方位词，不是数字。
      if (cmd === 'floor' || cmd === 'ceil') {
        // floor 材质2 [y3]      铺满整块地
        // ceil  材质1 y10       盖一层顶
        if (!frameCur) { errors.push(line + ' <-- 先写 frame 立轴'); continue }
        const o = kv(1)
        const fm = pick(o, ['材质', 'mat', 'm'], 0, NaN)
        if (!Number.isFinite(fm)) { errors.push(line + ' <-- 需要材质 0/1/2'); continue }
        const fy = pick(o, ['y', '高', 'base'], 1, cmd === 'ceil' ? (frameCur.top | 0) : 0)
        const fw = frameCur.x2 - frameCur.x1 + 1
        const fd = frameCur.z2 - frameCur.z1 + 1
        tasks.push({ name: 'box', args: [frameCur.x1, Math.trunc(fy), frameCur.z1, fw, 1, fd, fm] })
        continue
      }

      if (cmd === 'wall') {
        // wall 南|北|东|西 高8 厚2 材质1 y0
        // 纯数字也行：wall 南 8 2
        const side = p[1]
        if (!frameCur) { errors.push(line + ' <-- 先写 frame 立轴'); continue }
        if (!['南', '北', '东', '西'].includes(side)) {
          errors.push(line + ' <-- 方位要写 南/北/东/西')
          continue
        }
        const o = kv(2)
        const wh = Math.max(1, pick(o, ['高', 'h', 'height'], 0, 8))
        const wt = Math.max(1, pick(o, ['厚', 't', 'thick'], 1, 2))
        const wm = pick(o, ['材质', 'mat', 'm'], 2, 1)
        const wy = pick(o, ['y', '底', 'base'], 3, frameCur.y | 0)
        const ed = frameEdge(side, wt)
        const wyT = Math.trunc(wy), whT = Math.trunc(wh)
        tasks.push({ name: 'box', args: [ed.x, wyT, ed.z, ed.w, whT, ed.d, wm] })
        // 记住墙顶：屋顶默认盖在这里，不用再让 AI 算 y
        if (wyT + whT > (frameCur.top | 0)) frameCur.top = wyT + whT
        continue
      }

      if (cmd === 'roof') {
        // roof 收分1 层4 每层1 材质2 y10
        // 纯数字：roof 1 4
        if (!frameCur) { errors.push(line + ' <-- 先写 frame 立轴'); continue }
        const o = kv(1)
        const inset = Math.max(0, pick(o, ['收分', 'inset', '缩'], 0, 1))
        const levels = Math.max(1, pick(o, ['层', '层数', 'levels', 'n'], 1, 3))
        const rh = Math.max(1, pick(o, ['每层', '每层高', 'step', 'h'], 2, 1))
        const rm = pick(o, ['材质', 'mat', 'm'], 3, 2)
        const ry = pick(o, ['y', '底', 'base'], 4, frameCur.top | 0)
        let rx = frameCur.x1, rz = frameCur.z1
        const rw = frameCur.x2 - frameCur.x1 + 1
        const rd = frameCur.z2 - frameCur.z1 + 1
        let ry2 = Math.trunc(ry)
        for (let k = 0; k < Math.trunc(levels); k++) {
          const cw = rw - Math.trunc(inset) * 2 * k
          const cd = rd - Math.trunc(inset) * 2 * k
          if (cw <= 0 || cd <= 0) break
          tasks.push({ name: 'box', args: [rx + Math.trunc(inset) * k, ry2, rz + Math.trunc(inset) * k, cw, Math.trunc(rh), cd, rm] })
          ry2 += Math.trunc(rh)
        }
        continue
      }

      if (cmd === 'door' || cmd === 'win') {
        // door 南|北|东|西 偏移 宽 高 [材质] [y]
        // win  同上，但默认开在墙中间高度
        // 偏移可以写 中心 / 左N / 右N
        const side = p[1]
        if (!frameCur) { errors.push(line + ' <-- 先写 frame 立轴'); continue }
        const isDoor = cmd === 'door'
        const edge = frameEdge(side, 2)
        if (!edge) { errors.push(line + ' <-- 方位要写 南/北/东/西'); continue }

        // 解析偏移：中心 / 左3 / 右2 / 数字
        let offset = 0
        let align = 'left'
        const offTok = p[2] || '中心'
        if (offTok === '中心' || offTok === 'center' || offTok === 'c') {
          align = 'center'
        } else if (offTok.startsWith('左')) {
          align = 'left'
          offset = Number(offTok.slice(1)) || 0
        } else if (offTok.startsWith('右')) {
          align = 'right'
          offset = Number(offTok.slice(1)) || 0
        } else {
          align = 'left'
          offset = Number(offTok) || 0
        }

        const dw = Math.max(1, num(3) || (isDoor ? 4 : 2))
        const dh = Math.max(1, num(4) || (isDoor ? 6 : 3))
        const dm = p.length >= 6 && Number.isFinite(num(5)) ? num(5) : 2
        const baseY = frameCur.y | 0
        const dy = p.length >= 7 && Number.isFinite(num(6)) ? num(6)
          : (isDoor ? baseY : baseY + 4)

        const place = framePlace(edge, offset, dw, align)
        // 门洞：挖空那块（用 box 在同样的位置无法「挖」，
        // 这里改成「在外墙上开一个缺口」—— 先画墙，再由调用方补。
        // 简化实现：直接生成一个薄片任务，标记为 cut，落子时跳过已有方块。
        tasks.push({
          name: 'cut',
          args: [place.x, dy, place.z, place.w, dh, place.d],
        })
        // 窗台 / 门框：在洞下方补一条
        if (!isDoor) {
          tasks.push({ name: 'box', args: [place.x, dy - 1, place.z, place.w, 1, place.d, dm] })
        }
        continue
      }

      if (cmd === 'col') {
        // col 南|北|东|西 间距 高 [材质] [y]
        if (!frameCur) { errors.push(line + ' <-- 先写 frame 立轴'); continue }
        const side = p[1]
        const edge = frameEdge(side, 1)
        if (!edge) { errors.push(line + ' <-- 方位要写 南/北/东/西'); continue }
        const gap = Math.max(1, num(2) || 4)
        const ch = Math.max(1, num(3) || 8)
        const cm = p.length >= 5 && Number.isFinite(num(4)) ? num(4) : 1
        const cy = p.length >= 6 && Number.isFinite(num(5)) ? num(5) : (frameCur.y | 0)
        const along = edge.axis === 'x' ? edge.w : edge.d
        for (let o = 0; o < along; o += gap) {
          const place = framePlace(edge, o, 1, 'left')
          tasks.push({ name: 'box', args: [place.x, cy, place.z, 1, ch, 1, cm] })
        }
        continue
      }

      if (cmd === 'clear') {
        tasks.push({ name: 'clear', cells: null })
        continue
      }

      if (cmd === 'box' || cmd === 'hollow') {
        // box x y z 宽 高 深 材质
        if (p.length < 8 || !okNums(1, 7)) { errors.push(line + ' ← 需要 8 个数字'); continue }
        tasks.push({ name: cmd, args: [num(1), num(2), num(3), num(4), num(5), num(6), num(7)] })
        continue
      }

      if (cmd === 'line') {
        // line x1 y1 z1 x2 y2 z2 材质 [厚]
        if (p.length < 8 || !okNums(1, 7)) { errors.push(line + ' ← 需要 8 个数字'); continue }
        const thick = p.length >= 9 ? num(8) : 1
        tasks.push({ name: 'line', args: [num(1), num(2), num(3), num(4), num(5), num(6), num(7), Number.isFinite(thick) ? thick : 1] })
        continue
      }

      if (cmd === 'stairs') {
        // stairs x y z 步数 宽 材质 [升]
        if (p.length < 7 || !okNums(1, 6)) { errors.push(line + ' ← 需要 7 个数字'); continue }
        const rise = p.length >= 8 ? num(7) : 1
        tasks.push({ name: 'stairs', args: [num(1), num(2), num(3), num(4), num(5), num(6), Number.isFinite(rise) ? rise : 1] })
        continue
      }

      if (cmd === 'sphere') {
        // sphere cx cy cz 半径 材质
        if (p.length < 6 || !okNums(1, 5)) { errors.push(line + ' ← 需要 6 个数字'); continue }
        tasks.push({ name: 'sphere', args: [num(1), num(2), num(3), num(4), num(5)] })
        continue
      }

      errors.push(line + ' ← 不认识的指令')
    }
    return { tasks, errors }
  }

  // 把一个宏任务展开成坐标数组（这一步很便宜，只是算坐标，不碰 GL）
  function expandTask(task) {
    if (task.name === 'clear') return null
    const a = task.args
    const cells = []
    const push = (x, y, z, m) => {
      if (!inBounds(x, y, z)) return
      cells.push([x, y, z, m])
    }
    // cut：把一片区域里的方块删掉（门洞、窗洞用）。
    // 它不产出方块，产出的是「要删的格子」，由 pumpAI 分派给 removeVoxel。
    if (task.name === 'cut') {
      for (let x = 0; x < a[3]; x++)
        for (let y = 0; y < a[4]; y++)
          for (let z = 0; z < a[5]; z++) {
            const cx = a[0] + x, cy = a[1] + y, cz = a[2] + z
            if (!inBounds(cx, cy, cz)) continue
            cells.push([cx, cy, cz, -1])   // -1 表示「删」
          }
      return cells
    }
    switch (task.name) {
      case 'box':
        for (let x = 0; x < a[3]; x++)
          for (let y = 0; y < a[4]; y++)
            for (let z = 0; z < a[5]; z++) push(a[0] + x, a[1] + y, a[2] + z, a[6])
        break
      case 'hollow':
        for (let x = 0; x < a[3]; x++)
          for (let y = 0; y < a[4]; y++)
            for (let z = 0; z < a[5]; z++) {
              const shell = x === 0 || x === a[3] - 1
                || y === 0 || y === a[4] - 1
                || z === 0 || z === a[5] - 1
              if (shell) push(a[0] + x, a[1] + y, a[2] + z, a[6])
            }
        break
      case 'line': {
        const [x1, y1, z1, x2, y2, z2, mat, thick] = a
        const dx = x2 - x1, dy = y2 - y1, dz = z2 - z1
        const steps = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz))
        for (let i = 0; i <= steps; i++) {
          const k = steps === 0 ? 0 : i / steps
          const bx = Math.round(x1 + dx * k)
          const by = Math.round(y1 + dy * k)
          const bz = Math.round(z1 + dz * k)
          for (let ox = 0; ox < thick; ox++)
            for (let oy = 0; oy < thick; oy++)
              for (let oz = 0; oz < thick; oz++) push(bx + ox, by + oy, bz + oz, mat)
        }
        break
      }
      case 'stairs': {
        const [x, y, z, steps, width, mat, rise] = a
        for (let s = 0; s < steps; s++)
          for (let w = 0; w < width; w++) {
            push(x + w, y + s * rise, z + s, mat)
            for (let k = 1; k < rise; k++) push(x + w, y + s * rise - k, z + s, mat)
          }
        break
      }
      case 'sphere': {
        const [cx, cy, cz, r, mat] = a
        const rr = r * r, r0 = (r - 1) * (r - 1)
        for (let dx = -r; dx <= r; dx++)
          for (let dy = -r; dy <= r; dy++)
            for (let dz = -r; dz <= r; dz++) {
              const d = dx * dx + dy * dy + dz * dz
              if (d <= rr && d > r0) push(cx + dx, cy + dy, cz + dz, mat)
            }
        break
      }
    }
    return cells
  }

  // 提交一段文本：解析 + 展开 + 入队。返回摘要。
  // saveAs：建完自动存成这张图纸（可省）。不给就不存。
  //   —— 存不存是唯一需要 AI 判断的事，其余（去重、版本、命名、清理）全自动。
  function submitAI(text, buildId, saveAs) {
    const { tasks, errors } = parseCommands(text)
    if (!tasks.length && errors.length) return { ok: false, errors }
    const bid = buildId || ('ai:' + Date.now())
    let total = 0
    const accepted = []
    for (const t of tasks) {
      if (t.name === 'clear') {
        aiQueue.push({ name: 'clear', cells: null, at: 0, buildId: bid })
        accepted.push({ name: 'clear', count: 0 })
        continue
      }
      const cells = expandTask(t)
      if (!cells || !cells.length) {
        errors.push(t.name + ' ← 展开为空（坐标越界？）')
        continue
      }
      aiQueue.push({ name: t.name, cells, at: 0, buildId: bid })
      total += cells.length
      accepted.push({ name: t.name, count: cells.length })
    }
    if (aiQueue.length) {
      aiActive = true
      aiTotal = total + aiDone
    }
    // 整批算一个撤销步
    if (aiQueue.length && typeof beginOp === 'function') beginOp()
    // 【记下「建完要存快照」的请求】
    // 存快照必须等方块真的长完 —— 队列还在跑的时候 buildings 里是半成品。
    // 所以这里只登记，等 pumpAI 把队列清空那一刻再执行。
    if (saveAs) {
      pendingSnapshot.push({ buildId: bid, name: String(saveAs).slice(0, 24) })
    }
    return { ok: true, accepted, errors, total, queued: aiQueue.length }
  }

  // 建完待存快照的请求。pumpAI 清空队列时统一处理。
  const pendingSnapshot = []
  let lastSnapshots = []   // 最近一次的结果，供调用方读

  // 每帧调一次：推进队列。
  // 返回 { active, done, total } 供 UI 显示进度。
  // 队列清空时的收尾：结束撤销步 + 存待办的快照 + 清理旧版本。
  // 这一段在 pumpAI 里原本出现两次（「进函数时队列已空」和「循环跑完清空」），
  // 现在只有一份。
  function onQueueDrained() {
    if (typeof endOp === 'function') endOp()
    aiActive = false
    if (!pendingSnapshot.length) return
    lastSnapshots = []
    for (const req of pendingSnapshot.splice(0, pendingSnapshot.length)) {
      try {
        const r = snapshotBuilding(req.buildId, req.name)
        if (r) lastSnapshots.push(r)
      } catch (error) { /* 存不下不影响已经建好的东西 */ }
    }
    // 存完顺手清一遍老版本（同名只保留最新几个），调用方不用管
    try { pruneBlueprints() } catch (error) { /* 忽略 */ }
  }

  function pumpAI() {
    if (!aiQueue.length) {
      if (aiActive) onQueueDrained()
      return { active: false, done: aiDone, total: aiTotal }
    }
    let budget = PER_FRAME
    while (budget > 0 && aiQueue.length) {
      const task = aiQueue[0]
      if (task.name === 'clear') {
        demolishAll()
        aiQueue.shift()
        continue
      }
      const cells = task.cells
      const take = Math.min(budget, cells.length - task.at)
      for (let i = 0; i < take; i++) {
        const c = cells[task.at + i]
        if (c[3] === -1) {
          // cut：删掉这一格（门洞/窗洞）
          if (removeVoxel(c[0], c[1], c[2])) aiDone++
        } else if (setVoxel(c[0], c[1], c[2], c[3], task.buildId)) {
          aiDone++
        }
      }
      task.at += take
      budget -= take
      if (task.at >= cells.length) aiQueue.shift()
    }
    if (!aiQueue.length) onQueueDrained()
    return { active: aiQueue.length > 0, done: aiDone, total: aiTotal }
  }

  function aiStatus() {
    return { active: aiQueue.length > 0, done: aiDone, total: aiTotal, queued: aiQueue.length }
  }

  function resetAI() {
    aiQueue = []
    aiDone = 0
    aiTotal = 0
    aiActive = false
  }

  // 直接落地一条船（和 scenePlan 共用 shapeBoat）
  function buildBoat(cx, cz) {
    const X = Number.isInteger(cx) ? cx : Math.floor(GRID_X / 2) - 6
    const Z = Number.isInteger(cz) ? cz : Math.floor(GRID_Z / 2) + 10
    let n = 0
    shapeBoat(X, Z, (x, y, z, m) => {
      if (setVoxel(x, y, z, m, 'boat')) n++
    })
    return n
  }

  // ============================================================
  //  宏仓库（升级版：带参数的封装）
  // ============================================================
  // 【旧版 vs 新版】
  //   旧版：存一段固定文本
  //         { name: "小船", text: "box 70 0 70 ..." }
  //         问题：位置写死在文本里，想建到别处就得另存一份
  //
  //   新版：存【模板 + 参数】
  //         { name: "凉亭", template: "box {cx} 0 {cz} ...", params: {cx:96, cz:96} }
  //         调用时把 {cx} 换掉 —— 同一个宏能做出一百个不同位置的凉亭
  //
  // 这是补丁 7 说的「共享宏原语」：
  //   · 引擎原语（box/hollow/line…）：人定，写死在代码里
  //   · 宏：AI/用户写，存进仓库，带参数，可重复调用
  //
  // 模板语法：`{参数名}` 会被替换成 params 里的值。
  //   例：template = "box {x} 0 {z} 10 1 10 0", params = {x:40, z:40}
  //       → "box 40 0 40 10 1 10 0"
  const MACRO_KEY = 'dsh-weather-sandbox/macro-lib-v2'
  const macros = new Map()   // name → { template, params, desc, uses, lastUsed }

  // ---- 内置骨架（随插件出厂，永远在）----
  // 8 个最通用的建筑元素。即使用户把 localStorage 清空、或者换一台机器，
  // 这几个也一定在 —— 新手打开就能用，不会面对一个空仓库。
  //
  // 每个都是「模板 + 默认参数」：换参数就能放到别处、改成别的大小。
  const BUILTIN_MACROS = [
    {
      name: '台基',
      desc: '两级收分台基，所有建筑的地面',
      template: 'box {x} 0 {z} {w} 1 {d} 2; box {x1} 1 {z1} {w1} 1 {d1} 2',
      params: { x: 80, z: 80, w: 20, d: 20, x1: 81, z1: 81, w1: 18, d1: 18 },
    },
    {
      name: '方墙',
      desc: '四面墙，墙厚 t，内部中空',
      template: 'box {x} {y} {z} {w} {h} {t} 1; box {x} {y} {z2} {w} {h} {t} 1; '
        + 'box {x} {y} {z1} {t} {h} {d1} 1; box {x2} {y} {z1} {t} {h} {d1} 1',
      params: { x: 80, y: 2, z: 80, w: 20, h: 8, t: 2, d: 20, z1: 82, z2: 98, d1: 16, x2: 98 },
    },
    {
      name: '柱列',
      desc: '一排柱子，用于廊/殿/亭的支撑',
      template: 'box {x} {y} {z} 1 {h} 1 1; box {x} {y} {z2} 1 {h} 1 1; '
        + 'box {x} {y} {z3} 1 {h} 1 1; box {x} {y} {z4} 1 {h} 1 1',
      params: { x: 88, y: 2, z: 88, h: 8, z2: 94, z3: 100, z4: 106 },
    },
    {
      name: '阶梯顶',
      desc: '四层收分屋顶，每层向内缩 1',
      template: 'box {x} {y} {z} {w} 1 {d} 2; box {x1} {y1} {z1} {w1} 1 {d1} 2; '
        + 'box {x2} {y2} {z2} {w2} 1 {d2} 2; box {x3} {y3} {z3} {w3} 1 {d3} 2',
      params: {
        x: 80, y: 10, z: 80, w: 20, d: 20,
        x1: 81, y1: 11, z1: 81, w1: 18, d1: 18,
        x2: 82, y2: 12, z2: 82, w2: 16, d2: 16,
        x3: 83, y3: 13, z3: 83, w3: 14, d3: 14,
      },
    },
    {
      name: '台阶',
      desc: '三级台阶，从 y1 下到 y3',
      template: 'box {x} {y1} {z} {w} 1 1 2; box {x} {y2} {z2} {w} 1 1 2; box {x} {y3} {z3} {w} 1 1 2',
      params: { x: 86, z: 80, w: 8, y1: 2, z2: 81, y2: 1, z3: 82, y3: 0 },
    },
    {
      name: '门洞',
      desc: '墙上开门洞，两侧加门柱',
      template: 'box {x} {y} {z} {w} {h} 1 0; box {x1} {y1} {z} 1 {h1} {d} 2; box {x2} {y1} {z} 1 {h1} {d} 2',
      params: { x: 88, y: 3, z: 80, w: 8, h: 6, x1: 87, x2: 96, y1: 3, h1: 6, d: 2 },
    },
    {
      name: '窗洞',
      desc: '墙上的窗洞 + 窗台',
      template: 'box {x} {y} {z} {w} 3 1 0; box {x1} {y1} {z1} {w1} 1 1 2',
      params: { x: 84, y: 6, z: 80, w: 4, x1: 83, y1: 5, z1: 80, w1: 6 },
    },
    {
      name: '院墙',
      desc: '四面院墙，比屋矮一层',
      template: 'box {x} {y} {z} {w} {h} 1 1; box {x} {y} {z2} {w} {h} 1 1; '
        + 'box {x} {y} {z1} 1 {h} {d1} 1; box {x2} {y} {z1} 1 {h} {d1} 1',
      params: { x: 70, y: 2, z: 70, w: 40, h: 4, z1: 71, z2: 109, d1: 38, x2: 109 },
    },
  ]

  // 把内置骨架装进仓库。同名的不覆盖 —— 用户改过的保持用户的版本。
  function seedBuiltinMacros() {
    let n = 0
    for (const m of BUILTIN_MACROS) {
      if (macros.has(m.name)) continue
      macros.set(m.name, {
        template: m.template,
        params: m.params,
        desc: m.desc,
        uses: 0,
        lastUsed: 0,
        builtin: true,
      })
      n++
    }
    return n
  }


  // 读存储里的用户宏，然后补上内置骨架。
  //
  // 【这个函数以前从来没被调用过】—— 定义了但没人调，
  // 所以每次刷新页面宏都会消失，只剩内存里那一次会话的。
  // 现在由 init 和第一次访问宏仓库时调用（见 ensureMacrosLoaded）。
  function loadMacroLib() {
    try {
      const raw = window.localStorage.getItem(MACRO_KEY)
      if (raw) {
        const arr = JSON.parse(raw)
        if (Array.isArray(arr)) {
          macros.clear()
          for (const m of arr) {
            if (!m || typeof m.name !== 'string') continue
            // 兼容：老版存的是 text，新版是 template
            const template = typeof m.template === 'string' ? m.template
              : (typeof m.text === 'string' ? m.text : null)
            if (!template) continue
            macros.set(m.name, {
              template,
              params: (m.params && typeof m.params === 'object') ? m.params : {},
              desc: typeof m.desc === 'string' ? m.desc : '',
              uses: Number.isFinite(m.uses) ? m.uses : 0,
              lastUsed: Number.isFinite(m.lastUsed) ? m.lastUsed : 0,
            })
          }
        }
      }
    } catch (error) {
      // 存储坏了也要有内置的，不能让用户面对一个空仓库
    }
    // 不管存储读没读到，内置骨架一定补上
    seedBuiltinMacros()
    macrosLoaded = true
    return macros.size
  }

  // 惰性加载：任何访问宏仓库的入口先调它。
  // 这样即使 init 里没加载（比如引擎只被读数据），也不会看到空仓库。
  let macrosLoaded = false
  function ensureMacrosLoaded() {
    if (!macrosLoaded) loadMacroLib()
  }

  function saveMacroLib() {
    try {
      const arr = []
      for (const [name, m] of macros) {
        arr.push({
          name,
          template: m.template,
          params: m.params,
          desc: m.desc,
          uses: m.uses,
          lastUsed: m.lastUsed,
        })
      }
      window.localStorage.setItem(MACRO_KEY, JSON.stringify(arr))
      return true
    } catch (error) { return false }
  }

  // 把模板里的 {名字} 替换成实际值。没给的参数用默认值。
  function expandTemplate(template, params) {
    return String(template).replace(/\{(\w+)\}/g, (whole, key) => {
      const v = params && Object.prototype.hasOwnProperty.call(params, key) ? params[key] : undefined
      if (v === undefined) return whole          // 没给值就原样留着，解析时会报错
      const n = Number(v)
      return Number.isFinite(n) ? String(Math.trunc(n)) : whole
    })
  }

  // 存一个宏。
  //   name      中文名（人看得懂）
  //   template  带 {参数} 的指令模板
  //   params    默认参数
  //   desc      一句话说明
  function saveMacro(name, template, params, desc) {
    ensureMacrosLoaded()
    const n = String(name || '').trim().slice(0, 24)
    const t = String(template || '').trim()
    if (!n || !t) return null

    // 存之前先展开一次验证 —— 存一个坏宏进仓库是给未来的自己埋雷
    const probe = expandTemplate(t, params || {})
    const { tasks, errors } = parseCommands(probe)
    if (!tasks.length) return { error: '无法解析', errors, expanded: probe }

    macros.set(n, {
      template: t,
      params: (params && typeof params === 'object') ? params : {},
      desc: String(desc || '').slice(0, 60),
      uses: 0,
      lastUsed: 0,
    })
    saveMacroLib()
    return { name: n, commands: tasks.length, params: Object.keys(params || {}) }
  }

  // 宏目录。
  // 【默认只给摘要，不给模板】
  // 模板是几百字符的指令文本，10 个宏就是几千 token ——
  // AI 每次会话都读一遍，光目录就把预算吃掉了。
  //
  // 所以分两级：
  //   目录（默认）：名字 + 说明 + 参数名 + 用过几次   每个约 20 字符
  //   详情（按需）：加上完整模板                     每个约几百字符
  // AI 要看哪个再单独查，不要一上来全拉。
  function listMacros(detail) {
    ensureMacrosLoaded()
    const out = []
    for (const [name, m] of macros) {
      const row = {
        name,
        desc: m.desc || '',
        params: Object.keys(m.params || {}),
        uses: m.uses || 0,
      }
      if (detail) {
        row.template = m.template
        row.defaults = m.params
      }
      out.push(row)
    }
    // 常用的排前面
    out.sort((a, b) => (b.uses - a.uses) || a.name.localeCompare(b.name))
    return out
  }

  // 单个宏的详情（AI 想用某个封装的完整信息时调）
  function macroDetail(name) {
    ensureMacrosLoaded()
    const m = macros.get(name)
    if (!m) return null
    return {
      name,
      desc: m.desc || '',
      template: m.template,
      defaults: m.params,
      uses: m.uses || 0,
    }
  }

  function removeMacro(name) {
    ensureMacrosLoaded()
    const ok = macros.delete(name)
    if (ok) saveMacroLib()
    return ok
  }

  // 调用宏。overrides 里的参数会覆盖默认值 —— 同一个宏建到不同位置。
  function runMacro(name, overrides, buildId) {
    ensureMacrosLoaded()
    const m = macros.get(name)
    if (!m) return null
    const params = { ...(m.params || {}), ...(overrides && typeof overrides === 'object' ? overrides : {}) }
    const text = expandTemplate(m.template, params)
    m.uses = (m.uses || 0) + 1
    m.lastUsed = Date.now()
    saveMacroLib()
    const r = submitAI(text, buildId || ('macro:' + name))
    // 把「用了哪个宏、什么参数」带回去 —— 大肥鱼头顶要显示这个
    if (r) r.macro = { name, params, desc: m.desc }
    return r
  }

  // ============================================================
  //  几何生成器（唯一实现）
  // ============================================================
  // 每个形状只写一次，用一个 emit 回调决定「直接落地」还是「收集成列表」：
  //   emit = (x, y, z, m) => setVoxel(x, y, z, m, id)       落地
  //   emit = (x, y, z, m) => { cells.push([x, y, z, m]) }   列表
  //
  // 原来 buildPavilion 和场景计划各写一遍同一套坐标（154 行），
  // 两边必须永远一致，改一处忘一处就会出现「直接建出来的形状和排队生成的不一样」。
  // 合并后几何只有一份。
  //
  // 坐标一律是相对中心的偏移，和格子精度无关：CELL 改大改小都不用动这里。

  // 中式凉亭：台基 → 柱 → 额枋 → 斗拱 → 攒尖顶 → 飞檐 → 宝顶 → 台阶
  function shapePavilion(cx, cz, emit) {
    const X = cx, Z = cz
    const p = (dx, y, dz, m) => emit(X + dx, y, Z + dz, m)

    for (let dx = -6; dx <= 6; dx++) for (let dz = -6; dz <= 6; dz++) p(dx, 0, dz, 2)
    for (let dx = -5; dx <= 5; dx++) for (let dz = -5; dz <= 5; dz++) p(dx, 1, dz, 2)
    for (let dx = -5; dx <= 5; dx++) for (let dz = -5; dz <= 5; dz++) p(dx, 2, dz, 0)

    const spots = [[-4, -4], [4, -4], [-4, 4], [4, 4]]
    for (let y = 3; y <= 6; y++) {
      for (const [px, pz] of spots) {
        p(px, y, pz, 0)
        if (y >= 4 && y <= 5) {
          p(px + 1, y, pz, 0); p(px - 1, y, pz, 0)
          p(px, y, pz + 1, 0); p(px, y, pz - 1, 0)
        }
      }
    }

    for (const [ax, az, bx, bz] of [
      [-4, -4, 4, -4], [4, -4, 4, 4], [4, 4, -4, 4], [-4, 4, -4, -4],
    ]) {
      const steps = Math.max(Math.abs(bx - ax), Math.abs(bz - az))
      for (let i = 0; i <= steps; i++) {
        const t = steps === 0 ? 0 : i / steps
        p(Math.round(ax + (bx - ax) * t), 6, Math.round(az + (bz - az) * t), 0)
      }
    }

    for (const [px, pz] of spots) {
      p(px, 7, pz, 2)
      p(px + 1, 7, pz, 2); p(px - 1, 7, pz, 2)
      p(px, 7, pz + 1, 2); p(px, 7, pz - 1, 2)
    }

    for (const [y, r] of [[8, 6], [9, 5], [10, 4], [11, 3], [12, 1]]) {
      for (let dx = -r; dx <= r; dx++)
        for (let dz = -r; dz <= r; dz++)
          if (Math.max(Math.abs(dx), Math.abs(dz)) === r) p(dx, y, dz, 1)
    }

    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      p(sx * 7, 8, sz * 7, 1)
      p(sx * 6, 9, sz * 6, 1)
    }

    p(0, 13, 0, 2); p(0, 14, 0, 2); p(0, 15, 0, 2)
    p(1, 14, 0, 2); p(-1, 14, 0, 2); p(0, 14, 1, 2); p(0, 14, -1, 2)

    for (let i = 0; i < 3; i++)
      for (let dx = -2; dx <= 2; dx++) p(dx, 2 - i, 7 + i, 2)
  }

  // 小船：龙骨 → 船底 → 船身 → 船舷 → 甲板 → 船舱 → 桅杆 → 帆 → 舵
  function shapeBoat(cx, cz, emit) {
    const X = cx, Z = cz
    const box = (x, y, z, w, h, d, m) => {
      for (let a = 0; a < w; a++) for (let b = 0; b < h; b++) for (let c = 0; c < d; c++)
        emit(X + x + a, y + b, Z + z + c, m)
    }
    const shell = (x, y, z, w, h, d, m) => {
      for (let a = 0; a < w; a++) for (let b = 0; b < h; b++) for (let c = 0; c < d; c++) {
        const s = a === 0 || a === w - 1 || b === 0 || b === h - 1 || c === 0 || c === d - 1
        if (s) emit(X + x + a, y + b, Z + z + c, m)
      }
    }
    box(6, 0, 2, 8, 1, 4, 2)
    box(3, 1, 1, 14, 1, 6, 2)
    box(1, 2, 0, 18, 1, 8, 2)
    box(0, 3, 0, 20, 1, 1, 0)
    box(0, 3, 9, 20, 1, 1, 0)
    box(0, 3, 1, 1, 1, 8, 0)
    box(19, 3, 1, 1, 1, 8, 0)
    box(1, 3, 1, 18, 1, 8, 1)
    box(-1, 3, 3, 1, 1, 4, 2)
    box(20, 3, 3, 1, 1, 4, 2)
    shell(7, 4, 2, 6, 3, 6, 0)
    box(9, 7, 4, 1, 6, 1, 2)
    box(8, 9, 1, 1, 3, 7, 1)
    box(20, 1, 3, 1, 4, 4, 2)
  }

  // ============================================================
  //  场景计划：把内置场景算成坐标列表，交给 AI 队列逐帧生长
  // ============================================================
  // buildPavilion / buildBoat 都是「调用时立刻 setVoxel 摆完」。
  // 这样没有生长动画 —— 一按就整栋出现，用户看不到一块块垒起来。
  //
  // scenePlan 把它拆成两步：
  //   1. 用一个假的 setVoxel 把坐标收集起来（不碰真实世界）
  //   2. 列表塞进 aiQueue，pumpAI 每帧只放 PER_FRAME 块
  //
  // 为什么不用「手写 box 指令」：
  //   buildPavilion 用的是相对中心的偏移，格子精度变了它自动适配。
  //   手写 box 就得把每个坐标按新格数翻倍，算错一次形状就歪了。
  //   让函数自己算，永远不会错。
  function scenePlan(name, cx, cz) {
    const X = Number.isFinite(cx) ? Math.trunc(cx) : Math.floor(GRID_X / 2)
    const Z = Number.isFinite(cz) ? Math.trunc(cz) : Math.floor(GRID_Z / 2)
    const cells = []

    // 假 put：只收集坐标，不写 voxels
    const collect = (x, y, z, m) => {
      if (!inBounds(x, y, z)) return false
      cells.push([x, y, z, m])
      return true
    }

    if (name === 'pavilion') {
      shapePavilion(X, Z, collect)
    } else if (name === 'boat') {
      shapeBoat(X, Z, collect)
    } else {
      return null
    }

    if (!cells.length) return { ok: false, error: 'nothing to build (out of bounds?)' }

    // 整批算一个撤销步
    if (typeof beginOp === 'function') beginOp()
    aiQueue.push({ name: 'scene:' + name, cells, at: 0, buildId: 'scene:' + name + ':' + Date.now() })
    aiActive = true
    aiTotal = aiDone + cells.length

    return { ok: true, commands: 1, total: cells.length }
  }



  // ============================================================
  //  快照：把一栋建筑【复制】成图纸，不拆它
  // ============================================================
  // collectBuilding 是「收纳」：存图纸 + 原地清空 + 砖进仓库。
  // 但「建完自动存档」要的是另一件事：【留个副本，建筑继续留在世界上】。
  // 两者目的相反，所以不能复用。
  //
  // 【去重逻辑全部在这里，AI 不用管】
  //   · 内容完全相同 → 跳过，不存
  //   · 同名但内容不同 → 存成 "名字 v2" / "名字 v3"
  //   · 名字不同 → 新建
  // 这样 AI 只需要给个名字，版本管理和去重由电脑做。
  function cellHash(cells) {
    // 简单稳定的哈希：坐标和材质揉进一个整数。
    // 不需要密码学强度，只要「一样的东西算出一样的值」。
    let h = 2166136261
    for (const c of cells) {
      h ^= (c[0] & 0x3ff)
      h = Math.imul(h, 16777619)
      h ^= (c[1] & 0x3f)
      h = Math.imul(h, 16777619)
      h ^= (c[2] & 0x3ff)
      h = Math.imul(h, 16777619)
      h ^= (c[3] & 0x7)
      h = Math.imul(h, 16777619)
    }
    return (h >>> 0)
  }

  function snapshotBuilding(buildId, name) {
    const set = buildings.get(buildId)
    if (!set || set.size === 0) return { ok: false, error: 'no such building' }

    // 包围盒 → 锚点 + 相对坐标
    const bb = boundsOf(buildId)
    if (!bb) return { ok: false, error: 'empty' }
    const minX = bb.minX, maxX = bb.maxX
    const minY = bb.minY, maxY = bb.maxY
    const minZ = bb.minZ, maxZ = bb.maxZ
    const cells = []
    for (const k of set) {
      const [x, y, z] = unkey(k)
      const m = voxels.get(k)
      if (m === undefined) continue
      cells.push([x - minX, y - minY, z - minZ, m])
    }
    if (!cells.length) return { ok: false, error: 'empty' }

    const hash = cellHash(cells)

    // ---- 去重 1：内容完全一样，不管叫什么名字 ----
    for (const [existingName, bp] of blueprints) {
      if (bp.hash === hash) {
        return {
          ok: true,
          skipped: true,
          reason: 'identical',
          existing: existingName,
          count: cells.length,
        }
      }
    }

    // ---- 去重 2：同名但内容不同 → 版本化 ----
    // 【版本号取「已有最大值 + 1」，不是「第一个空位」】
    // 版本号取「已有最大值 + 1」，不是「第一个空位」。
    // 清理逻辑会删掉老版本，空位会重新出现；复用空位会让最老的名字
    // 混进一堆 v3/v4 里，排序和「哪版最新」全乱。
    const base = String(name || '').trim().slice(0, 24) || autoName()
    let maxV = 0
    for (const [existingName, bp] of blueprints) {
      const b = bp.baseName || existingName
      if (b !== base) continue
      const m = /^.+ v(\d+)$/.exec(existingName)
      const n = m ? Number(m[1]) : 1
      if (n > maxV) maxV = n
    }
    const finalName = maxV === 0 ? base : (base + ' v' + (maxV + 1))

    blueprints.set(finalName, {
      name: finalName,
      baseName: base,
      anchor: [minX, minY, minZ],
      size: [maxX - minX + 1, maxY - minY + 1, maxZ - minZ + 1],
      cells,
      hash,
      at: Date.now(),
    })
    saveBlueprintLib()

    return {
      ok: true,
      saved: finalName,
      baseName: base,
      versioned: finalName !== base,
      count: cells.length,
      size: [maxX - minX + 1, maxY - minY + 1, maxZ - minZ + 1],
    }
  }

  // 没给名字时自动起一个 —— 电脑代劳，不花 AI 的 token
  let autoNameSeq = 0
  function autoName() {
    autoNameSeq += 1
    return '建筑-' + String(autoNameSeq).padStart(3, '0')
  }

  // ---- 清理：同名只留最新 3 个版本 ----
  // AI 不用管。每次存完自动跑一遍。
  const KEEP_VERSIONS = 3
  function pruneBlueprints() {
    ensureBlueprintsLoaded()
    const byBase = new Map()
    for (const [name, bp] of blueprints) {
      const base = bp.baseName || name
      if (!byBase.has(base)) byBase.set(base, [])
      byBase.get(base).push(bp)
    }
    let removed = 0
    for (const [, list] of byBase) {
      if (list.length <= KEEP_VERSIONS) continue
      // 最新的排前面
      list.sort((a, b) => (b.at || 0) - (a.at || 0))
      for (const old of list.slice(KEEP_VERSIONS)) {
        if (blueprints.delete(old.name)) removed++
      }
    }
    saveBlueprintLib()
    return removed
  }

  // ============================================================
  //  拾取：屏幕点 → 命中哪栋建筑
  // ============================================================
  // 拖拽旋转要先知道「你按住的是哪栋楼」。
  //
  // 【为什么不能只打地面】
  // 不能只打 y=0 平面：建筑有高度，鼠标点在屋顶时，从那个屏幕点发出的射线
  // 会打到建筑脚下跌之外的地面，落点偏离几十格。
  //
  // 所以按高度采样：从最高处往下逐层打，取第一个落在某栋建筑包围盒内的。
  // 从高打到低，因为人总是先看到屋顶。
  function pickBuilding(sx, sy, radius) {
    if (!lastVpInv) return null
    const rad = Number.isFinite(radius) ? radius : 16   // 格

    // 先收集每栋建筑的包围盒（XZ 矩形 + 高度上限）
    const boxes = []
    for (const bid of buildings.keys()) {
      const bb = boundsOf(bid)
      if (!bb) continue
      boxes.push({ bid, minX: bb.minX, minZ: bb.minZ, maxX: bb.maxX, maxZ: bb.maxZ, maxY: bb.maxY })
    }
    if (!boxes.length) return { building: null, cell: null }

    const maxTop = Math.max(...boxes.map((b) => b.maxY))

    // 从最高处往下扫。每一层打一次地面格，看落点在哪栋楼的包围盒里。
    // 步长 1 格（0.5 米）已经足够细；建筑最高也就 64 格。
    for (let y = maxTop; y >= 0; y--) {
      const g = pickGroundGrid(sx, sy, lastVpInv, lastW, lastH, y * CELL)
      if (!g) continue
      for (const b of boxes) {
        if (g.x < b.minX - rad || g.x > b.maxX + rad) continue
        if (g.z < b.minZ - rad || g.z > b.maxZ + rad) continue
        // 命中了。用「离包围盒中心最近」的优先，避免两个楼挨着时选错。
        return {
          building: b.bid,
          rotY: getBuildingRot(b.bid),
          cell: { x: g.x, z: g.z },
          atY: y,
          blocks: (buildings.get(b.bid) || new Set()).size,
        }
      }
    }

    // 没命中任何建筑 —— 退回纯地面拾取，给放置逻辑用
    const g0 = pickGroundGrid(sx, sy, lastVpInv, lastW, lastH)
    return { building: null, cell: g0 ? { x: g0.x, z: g0.z } : null }
  }

  function voxelStats() {
    let visible = 0
    for (let i = 0; i < BUCKET_COUNT; i++) visible += bucketInst[i]
    return { total: voxels.size, visible, buildings: buildings.size, blueprints: blueprints.size }
  }

  // ============================================================
  //  收纳：建筑 → 蓝图，原地清空
  // ============================================================
  // 这是补丁 5「资产机制」的核心，也是「搭好一栋楼就收起来」的基础。
  //
  //   采集：世界坐标 → 以包围盒最小角为锚点的局部坐标
  //   存放：蓝图库（名字 → { size, anchor, cells }）
  //   清空：从 voxels 删掉，标脏桶
  //
  // 为什么存相对坐标：世界坐标钉死在位置上，想摆到别处要整体运算；
  // 相对坐标是一个「素材」，放到哪儿都行 —— 这才是资产。
  //
  // 为什么 cells 用四元数组而不是对象：1000 块时省一半以上内存。
  // 图纸仓库。
  //
  // 【必须持久化】
  // 之前它是纯内存的 Map —— 程序完全退出再进来，所有图纸就没了。
  // 而图纸是这个世界最重要的资产（一栋楼盖一次，之后全靠它复用），
  // 丢了等于白干。所以和宏仓库一样存进 localStorage。
  const blueprints = new Map()
  const BP_KEY = 'dsh-weather-sandbox/blueprints-v1'
  let blueprintsLoaded = false

  function loadBlueprintLib() {
    try {
      const raw = window.localStorage.getItem(BP_KEY)
      if (raw) {
        const arr = JSON.parse(raw)
        if (Array.isArray(arr)) {
          for (const b of arr) {
            if (!b || typeof b.name !== 'string') continue
            if (!Array.isArray(b.cells) || !b.cells.length) continue
            blueprints.set(b.name, {
              name: b.name,
              anchor: Array.isArray(b.anchor) ? b.anchor : [0, 0, 0],
              cells: b.cells,
              count: Number.isFinite(b.count) ? b.count : b.cells.length,
              size: Array.isArray(b.size) ? b.size : null,
              at: Number.isFinite(b.at) ? b.at : 0,
            })
          }
        }
      }
    } catch (error) {
      // 存储坏了就当空仓库，不要因此起不来
    }
    blueprintsLoaded = true
    return blueprints.size
  }

  function ensureBlueprintsLoaded() {
    if (!blueprintsLoaded) loadBlueprintLib()
  }

  function saveBlueprintLib() {
    try {
      const arr = []
      for (const [, b] of blueprints) {
        arr.push({
          name: b.name,
          anchor: b.anchor,
          cells: b.cells,
          count: b.count,
          size: b.size,
          at: b.at,
        })
      }
      // 太多就只留最近的若干张，避免撑爆 localStorage（一般 5MB 上限）
      const MAX_BP = 60
      const trimmed = arr.length > MAX_BP
        ? arr.sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, MAX_BP)
        : arr
      if (trimmed.length !== arr.length) {
        blueprints.clear()
        for (const b of trimmed) blueprints.set(b.name, b)
      }
      window.localStorage.setItem(BP_KEY, JSON.stringify(trimmed))
      return true
    } catch (error) {
      // 存不下（配额满）：不影响本次会话，只是下次打开会丢
      return false
    }
  }

  // ---- 固化：把多个零散建筑合并成一个整体 ----
  //
  // 【为什么需要它】
  // 搭一栋楼时往往分成好几个 buildId（地基一个、主体一个、细节一个），
  // 因为它们是分几次指令建出来的。但「建筑」这个概念是整体的：
  // 拖动、旋转、拆掉存图纸，都该按整栋楼来算。
  // 不合并的话，拖地基只动地基，上面那一半留在原地。
  //
  // 【做什么】
  // 把 ids 里所有方块的主人改成 targetId，其余建筑清空。
  // 只改 voxelOwner 的指向，不动任何坐标 —— 所以零成本、零风险。
  //
  // 【名字】
  // 不给 targetId 就自动起一个：整体-001、整体-002……
  function mergeBuildings(ids, targetId, saveName) {
    const src = Array.isArray(ids) ? ids.filter((x) => typeof x === 'string' && x) : []
    if (!src.length) return { ok: false, error: 'no ids' }

    // 收集所有要合的方块
    const all = new Set()
    const found = []
    for (const id of src) {
      const set = buildings.get(id)
      if (!set || !set.size) continue
      found.push(id)
      for (const k of set) all.add(k)
    }
    if (!found.length) return { ok: false, error: 'nothing to merge' }
    if (!all.size) return { ok: false, error: 'no voxels' }

    // 目标 id：没给就生成一个不重名的
    let target = typeof targetId === 'string' && targetId ? targetId : null
    if (!target) {
      let n = 1
      while (buildings.has('整体-' + String(n).padStart(3, '0'))) n++
      target = '整体-' + String(n).padStart(3, '0')
    }

    // 改写归属：只动 voxelOwner 的指向
    for (const k of all) voxelOwner.set(k, target)

    // 清空源建筑，再把合并后的集合挂到目标上
    for (const id of found) {
      if (id !== target) {
        buildings.delete(id)
        buildingRot.delete(id)
        buildingAnchor.delete(id)
        invalidateBounds(id)
      }
    }
    buildings.set(target, all)
    invalidateBounds(target)
    // 目标原有的旋转角不再适用（合并后是一个新的整体）
    buildingRot.delete(target)
    buildingAnchor.delete(target)

    // 【固化同时存图纸】
    // 玩家点「固化」和 AI 调 voxel_merge 必须做同一件事 ——
    // 否则会出现「玩家固化后有图纸、AI 固化后没有」这种两套行为。
    // 所以存图纸放在引擎里做，saveName 传了就存。
    let snapshot = null
    if (typeof saveName === 'string' && saveName.trim()) {
      try { snapshot = snapshotBuilding(target, saveName.trim()) } catch (error) { snapshot = null }
    }

    return {
      ok: true,
      id: target,
      merged: found,
      blocks: all.size,
      snapshot,
      // 告诉调用方：这栋楼现在是一个整体了，可以整体移动/旋转/收纳
    }
  }

  function collectBuilding(buildId, name) {
    const set = buildings.get(buildId)
    if (!set || set.size === 0) return null

    // 包围盒 → 锚点
    const bb = boundsOf(buildId)
    if (!bb) return null
    const minX = bb.minX, maxX = bb.maxX
    const minY = bb.minY, maxY = bb.maxY
    const minZ = bb.minZ, maxZ = bb.maxZ

    // 转局部坐标
    const cells = []
    for (const k of set) {
      const [x, y, z] = unkey(k)
      cells.push([x - minX, y - minY, z - minZ, voxels.get(k) | 0])
    }

    const bp = {
      name: name || buildId,
      size: [maxX - minX + 1, maxY - minY + 1, maxZ - minZ + 1],
      anchor: [minX, minY, minZ],
      cells,
    }
    blueprints.set(bp.name, bp)
    saveBlueprintLib()

    // 原地清空：砖【进仓库】，图纸另外存
    // 【收纳不是销毁】砖要回到仓库，以后还能拿来建别的。
    // 漏掉 addStock 会让「图纸在、砖没了」，直觉上就是砖被吞了。
    for (const k of set) {
      const [x, y, z] = unkey(k)
      const mat = voxels.get(k)
      if (mat !== undefined) addStock(mat, 1)
      voxels.delete(k)
      voxelOwner.delete(k)
      markDirtyAt(x, z)
    }
    buildings.delete(buildId)
    anyDirty = true

    return { name: bp.name, count: cells.length, size: bp.size }
  }

  // 把蓝图放进世界。不给坐标就放回它原来的锚点。
  function placeBlueprint(name, atX, atY, atZ, buildId) {
    ensureBlueprintsLoaded()
    const bp = blueprints.get(name)
    if (!bp) return null
    const ax = Number.isInteger(atX) ? atX : bp.anchor[0]
    const ay = Number.isInteger(atY) ? atY : bp.anchor[1]
    const az = Number.isInteger(atZ) ? atZ : bp.anchor[2]
    const bid = buildId || ('bp:' + name + ':' + Date.now())

    // 【先整体校验，再写入】
    // 不然一部分落进去、一部分越界，会留下半栋楼。
    for (const c of bp.cells) {
      const x = ax + c[0], y = ay + c[1], z = az + c[2]
      if (!inBounds(x, y, z)) return null
      if (voxels.has(vkey(x, y, z))) return null
    }
    if (voxels.size + bp.cells.length > MAX_VOXELS) return null

    let n = 0
    for (const c of bp.cells) {
      if (setVoxel(ax + c[0], ay + c[1], az + c[2], c[3], bid)) n++
    }
    return { name: bp.name, count: n, at: [ax, ay, az] }
  }

  function listBlueprints() {
    ensureBlueprintsLoaded()
    const out = []
    for (const [name, bp] of blueprints) {
      out.push({ name, count: bp.cells.length, size: bp.size })
    }
    return out
  }

  function removeBlueprint(name) {
    ensureBlueprintsLoaded()
    const ok = blueprints.delete(name)
    if (ok) saveBlueprintLib()
    return ok
  }

  // 拆掉一整栋建筑。砖【全部回收到仓库】。
  // 必须走 removeVoxel，不能直接 voxels.delete ——
  // 直接删的话砖就凭空没了，而玩家的直觉是「拆下来的砖应该进仓库」。
  // 拆掉一整栋建筑。砖进仓库，【图纸也存下来】。
  //
  // 拆之前先打包图纸。全拆和单栋拆走同一条路，行为一致。
  // 只删方块不存图纸的话，「拆一栋」等于彻底没了，和「全拆」的做法对不上。
  function demolishBuilding(buildId) {
    const set = buildings.get(buildId)
    if (!set || !set.size) return { count: 0, saved: null }

    // 1. 先存图纸（此时方块还在，collectBuilding 能读到完整数据）
    let name = buildId
    let k = 2
    while (blueprints.has(name)) { name = buildId + '-' + k; k++ }
    const saved = collectBuilding(buildId, name)

    return {
      count: saved ? saved.count : 0,
      saved: saved ? saved.name : null,
    }
  }

  // ============================================================
  //  十一、对外句柄
  // ============================================================
  window.__voxelPass = {
    init,
    draw,
    bindCanvas,
    setGrid,
    eye,
    target,
    setVisible,
    // 两个子开关：底座（大陆）和建筑
    setPart,
    getParts,
    dispose,
    // 方块接口
    setVoxel,
    removeVoxel,
    clearVoxels,
    stats: voxelStats,
    // 材质表（索引 + 名字 + CSS 色，物品栏要用）
    materials: () => MATERIALS.map((m) => ({ id: m.id, name: m.name, css: m.css })),
    // 拾取：屏幕像素 → 地面格子。没有 viewProj 时返回 null。
    pick: (sx, sy) => pickGroundGrid(sx, sy, lastVpInv, lastW, lastH),
    // 点一下就在那块地砖上放一块（高度取该处已有的最高块 +1，堆起来用）
    // 点一下就在那块地砖上放一块（同位置往上叠）
    //
    // 【放置不消耗仓库】—— 这是设计决定，不是漏了。
    //   · 这是建造沙盒，不是生存游戏。限制「砖不够不能建」只会让人烦。
    //   · 仓库的作用是「拆下来的东西不消失，你能看见它去哪了」，
    //     不是「限制你能建多少」。
    //   · 如果以后要做资源平衡（补丁 13/14 那套梦力铸砖），
    //     在 setVoxel 前面插一句扣库存就行，接口已经留好（stockOf / addStock）。
    placeAt: (sx, sy, mat, buildId) => {
      const g = pickGroundGrid(sx, sy, lastVpInv, lastW, lastH)
      if (!g) return null
      // 【施工高度】
      // 放置位置按列的落点判断，不按柱高累加，否则会出现：
      // 只能从地面往上一层层堆，永远做不出架空的东西 ——
      // 想盖个凉亭的屋顶，屋顶下面每一列都得先被柱子填满，等于盖成型心柱。
      // 现在改成：放置发生在【当前施工高度】这一层。buildY = -1 表示自动（旧行为）。
      let ny
      if (buildY >= 0) {
        ny = buildY
      } else {
        let top = -1
        for (let y = 0; y < GRID_Y; y++) {
          if (voxels.has(vkey(g.x, y, g.z))) top = y
        }
        ny = top + 1
      }
      if (ny < 0 || ny >= GRID_Y) return null
      if (!setVoxel(g.x, ny, g.z, mat | 0, buildId || 'user')) return null
      return { x: g.x, y: ny, z: g.z }
    },
    // 施工高度：-1 = 自动（落在这一列顶上）；0..31 = 固定层
    setBuildY: (y) => {
      const v = Number(y)
      buildY = Number.isFinite(v) && v >= 0 ? Math.min(GRID_Y - 1, Math.floor(v)) : -1
      return buildY
    },
    getBuildY: () => buildY,
    // ---- 撤销 ----
    // 一次「操作」= 一次拖动 / 一次框选 / 一次点击。
    // 引擎侧不知道用户什么时候松手，所以由客户端调 beginOp / endOp 包起来。
    undoBegin: beginOp,
    undoEnd: endOp,
    undo,
    canUndo,
    undoDepth,
    clearUndo,
    // 收纳 / 资产
    mergeBuildings,
    collectBuilding,
    placeBlueprint,
    listBlueprints,
    removeBlueprint,
    demolishBuilding,
    // 一键拆除：整片世界拆干净，砖进仓库，每栋建筑先存一份图纸
    demolishAll,
    // 立方体填充：一片地面上立起 height 层。
    // 这是「一根柱子」或者「一面墙」的正确做法 —— 平面框选只能铺一层，
    // 而柱子和墙是要有高度的。
    // 起算高度：buildY >= 0 就用它，否则从地面 y=0 起。
    fillSolid: (sx1, sy1, sx2, sy2, height, mat, buildId) => {
      const a = pickGroundGrid(sx1, sy1, lastVpInv, lastW, lastH)
      const b = pickGroundGrid(sx2, sy2, lastVpInv, lastW, lastH)
      if (!a || !b) return null
      const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x)
      const z0 = Math.min(a.z, b.z), z1 = Math.max(a.z, b.z)
      const w = x1 - x0 + 1, d = z1 - z0 + 1
      const h = Math.max(1, Math.min(GRID_Y, height | 0))
      // 体积上限：和面积同一个思路，防止拖出整个世界
      if (w * d * h > 8192) return { error: 'too_big', w, d, h }
      const y0 = buildY >= 0 ? buildY : 0
      let n = 0
      for (let x = x0; x <= x1; x++) {
        for (let z = z0; z <= z1; z++) {
          for (let k = 0; k < h; k++) {
            const y = y0 + k
            if (y < 0 || y >= GRID_Y) continue
            if (setVoxel(x, y, z, mat | 0, buildId || 'user')) n++
          }
        }
      }
      return { count: n, w, d, h, y0 }
    },
    // 区域填充：屏幕上的两个点框出一片地面，一次填满 ----
    // 这是「搭房子」真正需要的东西：一整片 9x9 屋顶靠点 81 下不现实。
    // 两点都在底板平面上取格坐标，然后取它们的包围矩形。
    fillRect: (sx1, sy1, sx2, sy2, mat, buildId) => {
      const a = pickGroundGrid(sx1, sy1, lastVpInv, lastW, lastH)
      const b = pickGroundGrid(sx2, sy2, lastVpInv, lastW, lastH)
      if (!a || !b) return null
      const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x)
      const z0 = Math.min(a.z, b.z), z1 = Math.max(a.z, b.z)
      const w = x1 - x0 + 1, d = z1 - z0 + 1
      // 面积上限：防止一次拖出整个世界把帧率打死
      if (w * d > 4096) return { error: 'too_big', w, d }
      let n = 0
      for (let x = x0; x <= x1; x++) {
        for (let z = z0; z <= z1; z++) {
          // 高度：自动模式就落在这列顶上，固定模式就放指定层
          let ny = buildY
          if (ny < 0) {
            let top = -1
            for (let y = 0; y < GRID_Y; y++) if (voxels.has(vkey(x, y, z))) top = y
            ny = top + 1
          }
          if (ny < 0 || ny >= GRID_Y) continue
          if (setVoxel(x, ny, z, mat | 0, buildId || 'user')) n++
        }
      }
      return { count: n, x0, x1, z0, z1, w, d, y: buildY }
    },
    // 区域删除：同一片矩形，把每列最上面那块挖掉
    clearRect: (sx1, sy1, sx2, sy2) => {
      const a = pickGroundGrid(sx1, sy1, lastVpInv, lastW, lastH)
      const b = pickGroundGrid(sx2, sy2, lastVpInv, lastW, lastH)
      if (!a || !b) return null
      const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x)
      const z0 = Math.min(a.z, b.z), z1 = Math.max(a.z, b.z)
      if ((x1 - x0 + 1) * (z1 - z0 + 1) > 4096) return { error: 'too_big' }
      let n = 0
      for (let x = x0; x <= x1; x++) {
        for (let z = z0; z <= z1; z++) {
          for (let y = GRID_Y - 1; y >= 0; y--) {
            if (voxels.has(vkey(x, y, z))) {
              if (removeVoxel(x, y, z)) n++
              break
            }
          }
        }
      }
      return { count: n }
    },
    // 点一下就地删掉那一列最上面的块
    removeAt: (sx, sy) => {
      const g = pickGroundGrid(sx, sy, lastVpInv, lastW, lastH)
      if (!g) return null
      let top = -1
      for (let y = 0; y < GRID_Y; y++) {
        if (voxels.has(vkey(g.x, y, g.z))) top = y
      }
      if (top < 0) return null
      if (!removeVoxel(g.x, top, g.z)) return null
      return { x: g.x, y: top, z: g.z }
    },
    // 基础宏（引擎原语：直接给坐标的底层函数）
    // 叫 primitives 而不是 macros：这类是底层原语，
    // 宏仓库里存的是「用原语写成的指令文本」，两者不能共用一个键名。
    // 对象字面量里同名键会被后者覆盖，而且不报错。
    primitives: {
      box: macroBox,
      hollow: macroHollow,
      line: macroLine,
      stairs: macroStairs,
      sphere: macroSphere,
    },
    // 默认场景与存档
    buildPavilion,
    buildBoat,
    // 场景计划：把内置场景算成坐标列表，进 AI 队列逐帧生长
    // （buildPavilion 是瞬间摆完的；scenePlan 才有生长动画）
    scenePlan,
    // ---- 建筑旋转 ----
    // 只转建筑，不转世界。90° 一档，绕建筑包围盒中心的竖轴。
    setBuildingRot,
    getBuildingRot,
    // ---- 建筑移动 ----
    // 平移一栋建筑，dx/dz 是格数（1 格 = 0.5 米）。
    // 只动这一栋，其他建筑和世界都不受影响。
    setBuildingOffset,
    canMoveBuilding,
    // 所有建筑的旋转状态（UI 用）
    listBuildingRots: () => {
      const out = []
      for (const bid of buildings.keys()) {
        out.push({ id: bid, rotY: getBuildingRot(bid), blocks: (buildings.get(bid) || new Set()).size })
      }
      return out
    },
    // 屏幕点 → 命中哪栋建筑（拖拽旋转要用）
    pickBuilding,
    // 调试用：导出某栋建筑的所有方块坐标。
    // 旋转是不是真的改了坐标，只有把坐标打出来才能确认 ——
    // 光看总块数没变是不够的（丢一块补一块也是不变）。
    dumpBuilding: (buildId) => {
      const set = buildings.get(buildId)
      if (!set) return null
      const out = []
      for (const k of set) {
        const [x, y, z] = unkey(k)
        out.push([x, y, z, voxels.get(k)])
      }
      out.sort((a, b) => (a[1] - b[1]) || (a[0] - b[0]) || (a[2] - b[2]))
      return out
    },
    // AI 模式：文本指令 → 分帧生成
    submitAI,
    // 快照：只存档不拆。去重/版本/命名/清理全在这里，AI 不用管
    snapshotBuilding,
    pruneBlueprints,
    // 最近一次「建完自动存档」的结果，供 UI / 工具回执读取
    lastSnapshots: () => lastSnapshots,
    parseCommands,
    aiStatus,
    resetAI,
    // ---- 三个仓库 ----
    // 1. 砖头仓库：按材质计数
    warehouse: warehouseSnapshot,
    stockOf,
    // 2. 图纸仓库：拆下来的建筑（相对坐标）
    blueprints: () => listBlueprints(),
    // 3. 宏仓库：带参数的封装（不是固定文本）
    macros: {
      save: saveMacro,
      // list() 只给目录（名字+说明+参数名），list(true) 才带模板
      list: listMacros,
      // 单个封装的完整信息 —— 要用哪个再查哪个，省 token
      detail: macroDetail,
      remove: removeMacro,
      run: runMacro,
      load: loadMacroLib,
      // 展开预览：给定参数，看看会生成什么指令文本（不执行）
      expand: (name, overrides) => {
        const m = macros.get(name)
        if (!m) return null
        const params = { ...(m.params || {}), ...(overrides || {}) }
        return { text: expandTemplate(m.template, params), params }
      },
    },
    // 一键查看三个仓库
    allWarehouses: () => ({
      bricks: warehouseSnapshot(),
      blueprints: listBlueprints(),
      macros: listMacros(),
    }),
    // 每帧预算（块）。UI 上可以调，用来让生长动画更快/更慢
    setAiRate: (n) => {
      const v = Number(n)
      if (Number.isFinite(v) && v > 0) PER_FRAME = Math.min(2000, Math.floor(v))
      return PER_FRAME
    },
    getAiRate: () => PER_FRAME,
    saveWorld,
    loadWorld,
    clearSave,
    // 重置世界：清空 + 重新搭样板 + 清存档
    resetWorld: () => {
      clearSave()
      const n = buildPavilion()
      saveWorld()
      return n
    },
    world: () => ({
      size: SIZE, height: HEIGHT, cell: CELL,
      bricks: (SIZE / CELL) * (SIZE / CELL),
      // eye 是实时算的（随滚轮变），所以要调用，不能直接给常量
      camEye: eye(), camTarget: CAM_TARGET,
      camDist, camDistMin: CAM_DIST_MIN, camDistMax: CAM_DIST_MAX,
      gridX: GRID_X, gridY: GRID_Y, gridZ: GRID_Z,
      bucketCount: BUCKET_COUNT, bucketCap: BUCKET_CAP,
      maxVoxels: MAX_VOXELS,
    }),
    get ready() { return ready },
    get visible() { return visible },
  }
})()
