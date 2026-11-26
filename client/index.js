window.__ModuleLoader__.load({
  id: "dsh-weather-sandbox",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const PLUGIN = "dsh-weather-sandbox";
    // 版本号同时是引擎脚本的缓存键（ocean-engine.js?v=VERSION）。
    // 每次改 static/ocean-engine.js 都必须把这里加一，否则浏览器会拿旧引擎，
    // 表现为「改了代码但页面没变化」——闪电不闪、隐藏模式不生效都是这个原因。
    const VERSION = "1.210.0";
    const ASSET_BASE = "/dsh-weather-sandbox/";
    const STORE_KEY = "dsh-weather-sandbox/v1";

    // ======================================================================
    //  已知故障与修改约束
    //  下面每一条都是实际发生过的故障。动手改对应代码之前先看这一节，
    //  否则很容易把已经修好的问题改回去。
    //    错误改法              出现的现象                        涉及位置
    //    ─────────────────────────────────────────────────────────────────────
    //    VERSION 没递增        改了引擎但画面不变                本文件 VERSION
    //    太阳本体尺寸乘倍率    太阳放大数倍、光晕消失            pushSun
    //    每拍重复推送云量      引擎缓动被反复重启，云持续抖动    pushCloud 防抖
    //    把 storm 写成 1       clearSky 归零，月亮和星星全消失   pushCloud
    //    给 CLOUD.mask 加低通  云量从初值慢滑，夜空整片被云盖住  ocean-engine cloudStep
    //    雪沿用雨的 WIND_SCALE  雪片横向飞出画面                  windAt / SNOW_WIND_SCALE
    //    在早期流程里读 const  面板 500ms 定时器早于声明，抛 TDZ  vaporRef / pressureRef
    //    温度跟随 2 秒慢拍     面板数值长时间不变                fastMs 快拍
    //    雨速公式里带常数偏移  风向信息被常数盖掉，调风无效      gust
    //    SURFACE 定义在闭包内  setDrive 读不到，报未定义         SURFACE 模块级
    //    ---- 草地/花/天气联动（复盘后补录）----
    //    着色器注释含中文/全角  GLSL 编译失败，草整个消失        所有着色器须纯 ASCII
    //    着色器注释里写反引号    模板字符串提前闭合，JS 语法错     着色器内禁用 ` 符号
    //    花沿用草的顶点拓扑      草变成交叉乱线（两次）          花用独立 pass
    //    花盘只用 6 顶点却画 12 个  花盘读垃圾数据               缓冲区顶点数须与 draw 一致
    //    const L 写在地面赋值之后  TDZ，整个 draw 抛错            L 提到 draw 首段
    //    手动滑块与定时器各自推送  手动效果只闪一下就被覆盖       优先级只实现一次
    //    自演化时手动值仍优先    雪永远不化                     自演化开则手动禁用
    //    雨雪共用一个标志        下雪出水、下雨无水              原料与温度闸门分离
    //    雪沉降不设温度门限      不到 0°C 就积雪                  settleGate 须在 0°C 归零
    //    融化用极小常数           -8°C 的雪十分钟也化光           极值须算总量级
    //    硬阈值判雨雪            状态猛的一下切换                 smoothstep 全程过渡
    //    水写死为不透明+固定色    积水像贴图                     透明水：折射+Beer+菲涅尔
    //  另一条硬约束：驱动层只向引擎推送数值，从不修改用户的滑杆位置。
    //  用户动过的参数记录在 taken{} 里，联动逻辑必须绕开它们（见 pushCloud）。
    // ======================================================================

    // ======================================================================
    //  生态联动总图（改驱动层之前先读这一节）
    // ======================================================================
    //
    //  三个物理场 + 两条反馈回路，全部跑在 16×16 网格上（gridN），每格独立演化。
    //  每拍顺序固定：stepTemperature → stepVapor → stepPressure → publishWindField
    //    · 温度走快拍 500ms（昼夜 60 秒一轮，慢了面板数字看着不动）
    //    · 水汽 / 气压走慢拍 2000ms（都是慢变量）
    //
    //  ┌──────────── 主线：水循环 ────────────┐
    //
    //        [温度场 T]  ──容量由温度给──▶  [水汽场 V]
    //             ▲                            │
    //             │                            ├─(超过容量)▶ 凝结 [云滴 CD]
    //             │                            │                    │
    //             │                            │                    ▼
    //             │                            │              [降水 precip]
    //             │                            │                    │
    //             │                            │         ┌──────────┴──────────┐
    //             │                            │         ▼                     ▼
    //             │                            │    [雨→积水 wetMemory]   [雪→积雪 snowMemory]
    //             │                            │         │                     │
    //             │                            │         │        (融化 melt)    │
    //             │                            │         └────────┬────────────┘
    //             │                            │                  │
    //             │        ┌───────────────────┘                  │
    //             └────────┴── 潜热回授 latentOffset ◀────────────┘
    //                        （降水放热 → 温度升 → 容量大 → 蒸发多 → 更容易降水）
    //
    //  ┌──────────── 气压主轴：风从哪里来 ────────────┐
    //
    //        [温度场 T] ──热力项 (p0 - (T-0.5)*gain)──▶ [气压场 P]
    //                 (+ 低频噪声初差 + 相位漂移 + 风环弱反馈)
    //                                                        │
    //                     ┌──────────────────────────────────┼───────────────────┐
    //                     ▼                                  ▼                   ▼
    //         [梯度 → 主导风向]                    [中心偏离 × 对比度]      [逐格相对偏离]
    //                     │                                  │                   │
    //                     ▼                                  ▼                   ▼
    //         __ossWindDir → 引擎                drop / rise           有效容量 = capRaw×(1-pressMod)
    //         [风 → 云飘 / 草摆 / 海面 / 云影]           │                   │
    //                                              [云量 ±12]        [低压区更容易饱和]
    //                     │                            │                   │
    //                     └────── 风又反过来微弱影响气压（feedback）───────┘
    //
    //  ┌──────────── 形态判定：雨还是雪 ────────────┐
    //
    //        [温度场 T] ──▶ 平滑(τ=6s) ──▶ phaseTempC
    //                                          │
    //                              回滞状态机 snowPhase（±1.5°C 死区）
    //                                          │
    //                              连续曲线 snowToRain = smoothstep(-1.5..+1.5)
    //                                          │
    //                          snowGate = 1-p   rainGate = p   （互补，恒和=1）
    //
    //  ┌──────────── 联动方向速查 ────────────┐
    //
    //    气压 → 风      气压梯度张量主轴 → __ossWindDir → 引擎 stepWind 用它代替正弦曲线
    //    气压 → 云      中心偏离×对比度 → drop/rise → 云量 ±12（用户接管 amount 时失效）
    //    气压 → 降水    逐格(均值-P[i]) → 有效容量系数（低压更易饱和）
    //    温度 → 容量    温度越高空气装的水汽越多
    //    温度 → 形态    snowToRain 连续曲线 + 回滞
    //    温度 → 融雪    meltRateFor(tempC)
    //    降水 → 温度    潜热回授 latentOffset（唯一一条把水循环接回温度的线）
    //    降水 → 积水    rainIntensity × 0.45/s，蒸发 0.06 + 暖天 0.22
    //    积雪 → 积水    融化时 melt × 0.35 补进 wetMemory
    //    风   → 水汽    windX × transport（水汽沿风平移）
    //    风   → 气压    feedback：风强时按气压梯度反向微弱修正（弱耦合）
    //
    //  【为什么用「中心偏离」而不是「全场平均变化」】
    //    meanDelta（全场平均）在周期边界的气压场里必然正负抵消，
    //    实测只有 5e-5，乘任何系数都传不到画面。同理，全场梯度【直接求和】也精确为 0
    //    （流进来必然流出去），所以风向用的是【张量主轴】而不是矢量平均。
    //    凡是「场」的量，一律用偏离/方差/张量这类不会被平均掉的统计量。
    // ======================================================================

    const USER_DEFAULTS_KEY = "dsh-weather-sandbox/defaults";

    // ---- IDS 前缀收成一处
    const P = "__dsh-weather-sandbox";
    const IDS = Object.freeze({
      pane: P,
      weather: P + "-weather",
      fab: P + "-fab",
      panel: P + "-panel",
      glass: P + "-glass",
      ui: P + "-ui",
    });

    const DEFAULTS = Object.freeze({
      enabled: true,
      // 只控制海面那一次绘制。关掉后天空、日月、星星、云、天气全部保留，
      // 这块画面变成完整天空 —— 用来给其他地形/壁纸让位。
      seaVisible: true,
      // 草地：独立地形层，同样只影响自己那一次绘制。
      // 默认【关】：打开「其他地形」时草地默认不勾选，用户自己决定要不要加草。
      //   （之前误改成 true，导致一上来就铺满草，和设计相反。）
      // 密度 0..100：50 = 基础值（上一版翻倍后的量），100 = 基础值再翻一倍。
      // 详细映射见引擎 lodForDensity()。
      groundVisible: false,
      groundDensity: 50,
      // 花密度：和草密度同一档（0~100），默认 50。
      // 0 = 零星几朵，100 = 铺满（约 6000 朵 / 30m 圆盘 ≈ 2.1 朵/㎡）。
      flowerDensity: 50,
      // 积雪 / 湿润：手动覆盖滑杆（0~100）。
      // 默认 0 = 完全交给天气系统（weatherCover 每 2 秒推进一次）。
      // 拉起来就接管，拉回 0 再交还给天气。
      snowCover: 0,
      wetness: 0,
      // 海浪大小：默认 28（原来 45）。
      // 45 在风速默认 100% 时 seaValue≈1.17，波峰已经偏大、看着有点吓人。
      // 28 对应 seaValue≈0.85，是「有涌动但不吓人」的起步。
      // 滑杆上限保持 100 不动 —— 喜欢大浪的用户自己拉上去就是。
      sea: 15,
      time: 36,
      autoCycle: true,
      // 时间流逝：滑杆 0..100，统一控制所有自走动画的速度（太阳月亮星空、海浪、云、雨雪）。
      // 50 = 1.0x 正常速度。低端慢放、高端快进，用来快速验证调整效果。
      timeScale: 50,
      glass: 72,
      // 场景：不再是用户选的，而是由「湿度是否饱和 + 温度」算出来的结果
      //（rain / snow / none）。存它是为了让 paint() 只在真的变了才重建雨雪层。
      scene: "rain",
      // ---- 天气沙盒的三条规则滑杆 ----
      // 它们控制的不是「画什么」，而是「天气处在什么状态」：
      //   温度 → 决定降水形态（低于 0°C 下雪，高于下雨）
      //   湿度 → 决定下不下（到饱和才有降水）
      //   雾量 → 决定雾浓不浓
      // 效果是这三样算出来的结果，不是直接画出来的。
      //
      // 温度位置 0..100 → 实际温度 -10..40°C（换算在 tempAt()）。
      // 0°C 落在位置 20，面板会把这条线标出来。
      tempPos: 50,
      // 湿度 0..100，直接对应水汽目标值 0..1。
      // 70 表示把水汽推到 0.70 —— 但能不能下雨要看当时的容量（温度越高容量越大）。
      humidPos: 70,
      // 雾量 0..100，直接控制雾强度（不再等天气自动起）。
      fogPos: 60,
      lightning: false,
      // 闪电频率：滑杆 0..100，50 = 默认间隔（约 5~25 秒一次）
      lightningFreq: 50,
      // 闪电数量：单次闪击里并联几道闪电（主干），1 = 一条，最多 3 条
      lightningCount: 1,
      // 云自动：让云自己走「凝聚→稳定→消散→空」的循环。
      // 关掉后云停在当前浓度不再变化（滑块仍可手动调）。
      cloudAuto: true,
      // 云面板六项 + 星星亮度：全部走 SETTING_SCHEMA → v1 存储，重启不丢。
      cloudEnabled: true,
      cloudAmount: 40,
      cloudDensity: 0,
      cloudUnite: 0,
      cloudOpacity: 100,
      cloudWind: 100,
      starBright: 55,
      // 光效区四根滑杆的位置（0..100，不是真实值）。
      // 50 = 1.0 倍。sunBright 是太阳本体，moonBright 是月亮本体。
      sunBright: 50,
      moonBright: 50,
      glow: 6,
      radius: 100,
    });

    // ---- 自演化模式 ----
    // 打开后接管「除时间流速之外的所有滑块」：天气自己循环变化。
    // 时间流速不接——那是「看多快」，属于观察者的视角，不是天气本身。
    //
    // 每个滑块一组正弦漂移参数：周期（互质，避免整体同步呼吸）+ 幅度（占 0..100 的比例）。
    // 幅度按滑块语义定：需要大胆变化的（温度、云量）给大；不该乱跳的（光晕半径）给小。
    // 周期从 90 秒到 420 秒不等，肉眼看到的是「缓慢地变」，不是一起一伏。
    // 【自演化接管「天气本身」的那几个参数】
    // 规则：默认由系统推动；玩家或 AI 一旦拖动某个滑杆，那个参数立刻交还给那一方（记进 heldBy），
    // 之后系统不再改它，直到用户关掉自演化再打开（重新从头接管）。
    //
    // 接管的：温度（决定雨还是雪）、湿度（决定下不下雨）、
    //        闪电频率 / 闪电数量（雷雨的疏密）。
    // 不接管的：云、光、海浪 —— 那些是观感参数，用户往往有自己偏好的值，
    //          系统每拍去改它只会把调好的画面破坏掉。
    // （雾模块已经从插件里移除，所以 fogPos 不再参与。）
    const EVOLVE_TRACKS = Object.freeze({
      tempPos:        { period: 180, amp: 0.26, phase: 0.00 },
      humidPos:       { period: 240, amp: 0.30, phase: 0.62 },  // 约反相于温度
      lightningFreq:  { period: 280, amp: 0.30, phase: 0.20 },
      lightningCount: { period: 340, amp: 0.35, phase: 1.90 },
    });

    // 被「抢回去」的参数集合，按【谁抢的】分开记。
    //   为什么是二维而不是一个 Set：
    //   这一维原来只有「用户」。AI 接管要写同一个面板，但没有自己的那一维，
    //   于是 AI 一调参就被记成用户 —— 自演化当场被自己关掉。
    //   这不是 bug，是签名缺一维：调参的函数只说「调什么」，没说「谁调的」。
    //
    //   语义：某参数一旦被某方抢走，该方就压过自演化，之后自演化不再碰它。
    //   两方都抢过同一参数时，后抢的覆盖先抢的（同一个人反复拖也走这条路）。
    //   目前两方都写进同一份 settings，所以 effectiveSlider 只要「有人抢了」就返回设置值，
    //   不需要区分是谁 —— 区分在 commitLive 那一层做：谁写 heldBy，谁就是抢占方。
    const heldBy = Object.create(null);          // key → "user" | "ai"

    // 运行时状态（不存储）：active 时 base 记录用户打开前的值，t 持续推进。
    const evolveState = { active: false, t: 0, base: Object.create(null) };

    // 温度滑杆位置 0..100 ↔ 实际温度 -10..40°C。
    // 0°C 落在位置 20 —— 面板会把这条线标出来，用户一眼知道「往左就是下雪」。
    const TEMP_MIN_C = -20;
    const TEMP_MAX_C = 40;
    const tempAt = (pos) => TEMP_MIN_C + (TEMP_MAX_C - TEMP_MIN_C) * (clamp(pos, 0, 100, 50) / 100);
    const posAtTemp = (c) => ((c - TEMP_MIN_C) / (TEMP_MAX_C - TEMP_MIN_C)) * 100;
    const FREEZE_POS = posAtTemp(0);   // = 20

    // 下雪线：温度低于它就是雪。用 0°C —— 用户一眼就懂。
    // 这个值必须和 VAP_CFG.snowTemp（凝结走固态的门槛）完全一致，
    // 否则会出现「判定为雪但凝结成水」→ 雪看不见。snowTemp 定义在驱动层，
    // 这里只留一个说明；真正的一致性由下面 shapeFor 的调用方共用 VAP_CFG.snowTemp 保证。
    const SNOW_BELOW_C = 0;

    // 天气形态：由「降水率 + 温度」算出来，不由用户选。
    // 迟滞是关键：降水率会随凝结/回补在小范围内波动，用它逐拍重判会让
    // 雨雪「下一会就停、停一下又下」。所以起止用两个不同的阈值：
    //   没在下时，要超过 START 才起（不容易误触发）
    //   已经在下了，要跌到 STOP 以下才停（不容易被打断）
    // 降水起止阈值（回滞）。
    const PRECIP_START = 0.004;
    const PRECIP_STOP = 0.0012;
    let wasRaining = false;

    // ---- 雨/雪形态的温度去抖（这是「0°C 附近雨雪来回跳」的最终解法）----
    // 温度场每拍都在动，原始 tempC 在冰点附近微抖一下，
    // 「tempC < 0 ? 雪 : 雨」就会立刻翻一次 —— 表现就是「每涨一度变一个天气」。
    // 驱动层虽然也算了一份平滑温度（phaseTempC）给雨雪比例，但 shapeFor
    // 是【另一条独立的判定路径】，它必须自己也去抖，否则两边打架：
    //   雨雪比例在平滑，界面上的场景却按原始温度闪。
    // 这里用同样的手段：低通 + 回滞，且状态存在模块级（跨拍保留）。
    const SHAPE_TAU = 6.0;      // 秒，和驱动层 phaseTempC 一致
    const SHAPE_HYS = 1.2;      // °C，回滞半宽（比驱动层略窄，切换才不会太迟钝）
    let shapeTempC = NaN;       // 平滑后的温度
    let shapeIsSnow = false;    // 当前形态（回滞状态）
    let shapeLastMs = Date.now();
    function shapeTemperature(tempC) {
      if (!Number.isFinite(tempC)) return NaN;
      const now = Date.now();
      const dt = Math.min(2.5, Math.max(0.05, (now - shapeLastMs) / 1000));
      shapeLastMs = now;
      if (!Number.isFinite(shapeTempC)) {
        shapeTempC = tempC;
        shapeIsSnow = tempC < SNOW_BELOW_C;
        return shapeTempC;
      }
      shapeTempC += (tempC - shapeTempC) * (1 - Math.exp(-dt / SHAPE_TAU));
      // 回滞：从不下雪的角度看，必须明确低于 -HYS 才切换到雪；
      // 已经在下雪时，必须明确高于 +HYS 才切换到雨。中间保持原状。
      if (shapeIsSnow) {
        if (shapeTempC > SNOW_BELOW_C + SHAPE_HYS) shapeIsSnow = false;
      } else {
        if (shapeTempC < SNOW_BELOW_C - SHAPE_HYS) shapeIsSnow = true;
      }
      return shapeTempC;
    }

    function shapeFor(tempC, precip) {
      const threshold = wasRaining ? PRECIP_STOP : PRECIP_START;
      wasRaining = precip > threshold;
      if (!wasRaining) return "none";
      // 【不要再用原始 tempC 判形态】
      // 先喂给 shapeTemperature 做低通+回滞；这一步是决定「雨还是雪」的唯一依据。
      // 传 NaN（驱动层还没起来）时退回原始比较。
      const smoothC = shapeTemperature(tempC);
      if (!Number.isFinite(smoothC)) return tempC < SNOW_BELOW_C ? "snow" : "rain";
      return shapeIsSnow ? "snow" : "rain";
    }

    // 三档密度 {轻, 中, 暴}，索引 0 不用（scene 为 none 时不走预算）。
    // [0]=轻 30% 细雨 / [1]=中 175% 原暴雨量 / [2]=暴 340% 拉满。
    // 改这里要同时看 rainBudget / snowBudget 的 clamp 上限，上限低了会把高档削平。
    const DENSITY = [0, 0.30, 1.75, 3.40];

    // 强度滑杆 0..100 → 密度系数（连续量）。
    // 锚点：15 → 0.30（旧「轻」）、85 → 3.40（旧「暴」）。
    // 50 落在两锚点的正中，线性插值必然是 (0.30+3.40)/2 = 1.85，
    // 而旧「中」档是 1.75 —— 差 0.1，对应雨滴数约 3%，肉眼无差别。
    // 也就是说：滑杆让「轻」和「暴」完全保持原样，只有中间的「中」从 1.75
    // 平滑成 1.85，换来的是整段连续可调，这个代价值得。
    // 0..15 从 0 渐入 0.30（滑到最左是无雨，往右慢慢起雨）。
    // 85..100 再从 3.40 缓探到 4.20（暴以上留一点余量，但不至于失控）。
    function densityAt(pos) {
      const p = clamp(pos, 0, 100, 50);
      if (p <= 15) return 0.30 * (p / 15);
      if (p <= 85) return 0.30 + (p - 15) / 70 * (3.40 - 0.30);
      return 3.40 + (p - 85) / 15 * (4.20 - 3.40);
    }

    const LEGACY_JSON = ["dsh-theme-shelter/v2", "dsh-theme-rain/v2", "dsh-theme-shelter/v1", "dsh-theme-rain/v1"];
    const LEGACY_OPEN_SEA = {
      enabled: "ossEnabled", sea: "ossSea", time: "ossTime", glass: "ossGlass", autoCycle: "ossAutoCycle",
    };

    function clamp(value, min, max, fallback) {
      const number = Number(value);
      return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
    }

    function lerpNumber(a, b, t) {
      return a + (b - a) * Math.max(0, Math.min(1, t));
    }

    // ---- normalize 收成 schema
    const SETTING_SCHEMA = [
      { key: "enabled",   type: "bool",   boolDefault: true,  fallback: DEFAULTS.enabled },
      { key: "seaVisible", type: "bool",  boolDefault: true,  fallback: DEFAULTS.seaVisible },
      // 草地：独立地形层。默认关，勾上才画。
      { key: "groundVisible", type: "bool",   boolDefault: false, fallback: DEFAULTS.groundVisible },
      { key: "groundDensity", type: "number", min: 0, max: 100,   fallback: DEFAULTS.groundDensity },
      { key: "flowerDensity", type: "number", min: 0, max: 100,   fallback: DEFAULTS.flowerDensity },
      { key: "snowCover",     type: "number", min: 0, max: 100,   fallback: DEFAULTS.snowCover },
      { key: "wetness",       type: "number", min: 0, max: 100,   fallback: DEFAULTS.wetness },
      { key: "sea",       type: "number", min: 0,   max: 100, fallback: DEFAULTS.sea },
      { key: "time",      type: "number", min: 0,   max: 100, fallback: DEFAULTS.time },
      { key: "autoCycle", type: "bool",   boolDefault: true,  fallback: DEFAULTS.autoCycle },
      { key: "timeScale", type: "number", min: 0,  max: 100, fallback: DEFAULTS.timeScale },
      { key: "glass",     type: "number", min: 0,   max: 95,  fallback: DEFAULTS.glass },
      { key: "tempPos",   type: "number", min: 0, max: 100, round: true, fallback: DEFAULTS.tempPos },
      { key: "humidPos",  type: "number", min: 0, max: 100, round: true, fallback: DEFAULTS.humidPos },
      { key: "fogPos",    type: "number", min: 0, max: 100, round: true, fallback: DEFAULTS.fogPos },
      { key: "lightning", type: "bool",   boolDefault: false, fallback: DEFAULTS.lightning },
      { key: "lightningFreq", type: "number", min: 0, max: 100, fallback: DEFAULTS.lightningFreq },
      { key: "lightningCount", type: "number", min: 1, max: 5, round: true, fallback: DEFAULTS.lightningCount },
      { key: "cloudAuto", type: "bool",   boolDefault: true,  fallback: DEFAULTS.cloudAuto },
      // 云面板六项。范围和面板上的滑杆 min/max 保持一致，改一边必须改另一边。
      { key: "cloudEnabled", type: "bool",   boolDefault: true,  fallback: DEFAULTS.cloudEnabled },
      { key: "cloudAmount",  type: "number", min: 0, max: 150,  fallback: DEFAULTS.cloudAmount },
      { key: "cloudDensity", type: "number", min: 0, max: 100,  fallback: DEFAULTS.cloudDensity },
      { key: "cloudUnite",   type: "number", min: 0, max: 100,  fallback: DEFAULTS.cloudUnite },
      { key: "cloudOpacity", type: "number", min: 0, max: 100,  fallback: DEFAULTS.cloudOpacity },
      { key: "cloudWind",    type: "number", min: 0, max: 100,  fallback: DEFAULTS.cloudWind },
      { key: "starBright",   type: "number", min: 0, max: 100,  fallback: DEFAULTS.starBright },
      { key: "sunBright",    type: "number", min: 0, max: 100,  fallback: DEFAULTS.sunBright },
      { key: "moonBright",   type: "number", min: 0, max: 100,  fallback: DEFAULTS.moonBright },
      { key: "glow",         type: "number", min: 0, max: 100,  fallback: DEFAULTS.glow },
      { key: "radius",       type: "number", min: 0, max: 100,  fallback: DEFAULTS.radius },
    ];

    function normalize(raw) {
      const value = raw && typeof raw === "object" ? raw : {};
      // 旧存档迁移（历次版本：intensity 1..3 → intensityPos → rainPos/snowPos → humidPos）。
      // 一脉相承的那个数都表示「降水强度」，现在统一落到 humidPos（湿度目标）。
      if (value.humidPos === undefined) {
        let legacy = null;
        if (Number.isFinite(Number(value.rainPos))) legacy = Number(value.rainPos);
        else if (Number.isFinite(Number(value.intensityPos))) legacy = Number(value.intensityPos);
        else if (Number.isFinite(Number(value.intensity))) {
          const l = Math.round(Number(value.intensity));
          legacy = l >= 3 ? 85 : l <= 1 ? 15 : 50;
        }
        if (legacy !== null) value.humidPos = Math.max(0, Math.min(100, legacy));
      }
      const out = {};
      for (const field of SETTING_SCHEMA) {
        const v = value[field.key];
        switch (field.type) {
          case "bool":
            out[field.key] = field.boolDefault ? v !== false : v === true;
            break;
          case "number":
            out[field.key] = clamp(field.round ? Math.round(Number(v)) : v, field.min, field.max, field.fallback);
            break;
          case "enum":
            out[field.key] = field.values.indexOf(v) >= 0 ? v : field.fallback;
            break;
        }
      }
      return out;
    }

    function readLegacy() {
      const merged = {};
      try {
        for (const key in LEGACY_OPEN_SEA) {
          const text = window.localStorage.getItem(LEGACY_OPEN_SEA[key]);
          if (text === null) continue;
          merged[key] = key === "enabled" || key === "autoCycle" ? text !== "false" : Number(text);
        }
      } catch (error) { /* blocked store: carry-over only */ }
      for (const key of LEGACY_JSON) {
        try {
          const text = window.localStorage.getItem(key);
          if (!text) continue;
          const parsed = JSON.parse(text);
          if (parsed && typeof parsed === "object") {
            for (const field of ["scene", "intensity", "lightning"]) {
              if (parsed[field] !== undefined) merged[field] = parsed[field];
            }
          }
          break;
        } catch (error) { /* try the older key */ }
      }
      return merged;
    }

    let settings = null;
    const listeners = new Set();

    // 启动基准 = 用户冻结过的那一份（USER_DEFAULTS_KEY）。
    // 冻结之前每次调整都会写进 STORE_KEY，所以启动时必须让 defaults 压过它，
    // 否则改了代码里任何一个 fallback（比如 timeScale 从 36 改成 50），
    // 用户重启后看到的就是新 fallback 而不是他冻结的基准 —— 这就是
    // 「设为默认存不住」的真身：旧版 readSettings 只认 STORE_KEY，从不看 defaults。
    // 没有冻结过才回落到 STORE_KEY（让从没按过「设为默认」的用户保住当前滑杆），
    // 再没有才从旧插件的 key 迁移。
    function readStore() {
      let stored = null;
      try {
        const text = window.localStorage.getItem(STORE_KEY);
        if (text) stored = JSON.parse(text);
      } catch (error) { stored = null; }
      return stored && typeof stored === "object" ? stored : null;
    }

    function readDefaultsRaw() {
      let stored = null;
      try {
        const text = window.localStorage.getItem(USER_DEFAULTS_KEY);
        if (text) stored = JSON.parse(text);
      } catch (error) { stored = null; }
      return stored && typeof stored === "object" ? stored : null;
    }

    function readSettings() {
      if (settings) return { ...settings };
      const frozen = readDefaultsRaw();
      const live = readStore();
      settings = frozen
        ? normalize(frozen)
        : live
          ? normalize(live)
          : normalize(readLegacy());
      // 【草地开关不持久化】
      // 它是「临时看一眼草地」的开关，不是长期偏好 —— 上次开过、这次一进来
      // 就铺满草，会让人以为插件坏了（实测反馈就是「怎么默认勾选」）。
      // 所以读设置时无条件把它按回关；用户在本次会话里勾上照样有效，
      // 只是下次重新加载时不记它。
      settings.groundVisible = false;
      return { ...settings };
    }

    function writeSettings(patch) {
      const before = readSettings();
      settings = normalize({ ...before, ...patch });
      try {
        window.localStorage.setItem(STORE_KEY, JSON.stringify(settings));
      } catch (error) { /* keep the live value for this page */ }
      for (const listener of listeners) {
        try { listener({ ...settings }); } catch (error) { console.warn("[Open Sea Shelter] panel update failed", error); }
      }
      return { ...settings };
    }

    // 有效滑杆值：自演化时返回漂移出来的值，否则返回用户设置。
    // 面板渲染和驱动层读取全部走这里 —— 「谁在管这个滑块」只有这一个判断点，
    // 所以自演化能接管任意一条滑块而不用改读取方。
    // 湿度专用：脉冲式演化（不是正弦）。
    // 正弦的问题：在峰值只停留一瞬间，水汽刚要饱和就回落，雨永远起不来。
    // 脉冲把一轮分成四段，让「下雨」成为一段能看清的天气，而不是一个闪过的点：
    //   爬升 20s：从干升到饱和（天逐渐阴下来）
    //   保持 45s：停在饱和区（雨下起来，能看见）
    //   回落 10s：快速降下来（雨停）
    //   晴期 25s：停在低位（这一段没有雨，形成对比）
    // 一轮 100 秒，比一轮昼夜（60 秒）长，所以两种节奏不会同步。
    //
    // 旧分配是 35/25/12/45：爬升太慢（前 18 秒全在 93% 以下白抬）、晴期太长
    // （一轮里 45 秒没雨，占四成），体感就是「雨雪难促发」。
    // 现在把时间挪给「保持」，一轮 100 秒里有 45 秒在下，且 20 秒内必然起雨。
    const HUMID_PULSE = Object.freeze({
      ramp: 20, hold: 45, drop: 10, clear: 25,
      low: 0.28, high: 1.0,   // 占 0..100 的比例：低段 28%，峰值 100%
    });

    function humidPulseAt(t) {
      const P = HUMID_PULSE;
      const cycle = P.ramp + P.hold + P.drop + P.clear;
      const u = ((t % cycle) + cycle) % cycle;
      // 脉冲是 0..1 的「强度」，再按用户的基准湿度缩放：
      // 基准 70 → 峰值约 (0.28 + 0.72*1.0)*70 … 这样打开自演化时不会从 70 跳到 100。
      const base = evolveState.base.humidPos;
      const ref = Number.isFinite(base) ? Math.max(35, Math.min(100, base)) / 100 : 0.7;
      let k;
      if (u < P.ramp) {
        // 爬升：平滑曲线，天阴得自然一点
        const a = u / P.ramp;
        k = P.low + (P.high - P.low) * (a * a * (3 - 2 * a));
      } else if (u < P.ramp + P.hold) {
        k = P.high;
      } else if (u < P.ramp + P.hold + P.drop) {
        const a = (u - P.ramp - P.hold) / P.drop;
        k = P.high + (P.low - P.high) * (a * a * (3 - 2 * a));
      } else {
        k = P.low;
      }
      // 回到 0..100 的滑杆刻度。
      // 关键：峰值必须「超过基准」才能到达饱和区 —— 如果只是 base×1.0，
      // 基准 70 时峰值也就 70，永远下不了雨。这里把脉冲映射到
      //   base×0.35（低段）.. max(base×1.45, 80)（峰值，钳到 100）
      // 峰值不再被基准锁死：基准低的时候（比如 40），只乘 1.45 得到 58，
      // 换算成饱和度才 79%，永远冲不过 100%，雨雪就都不出来。
      // 所以峰值给一个 80 的地板 —— 不管基准多少，每个周期都有机会饱和。
      // 基准 70 → 低段 24、峰值 100（必定饱和）；
      // 基准 90 → 低段 31、峰值 100；
      // 基准 40 → 低段 14、峰值 80（饱和区，能下）。
      const lo = ref * 0.35 * 100;
      const hi = Math.min(100, Math.max(ref * 1.45 * 100, 80));
      return lo + (hi - lo) * k;
    }

    // 有效滑杆值：自演化且该参数【没被用户抢回去】时，返回系统算出来的值；
    // 否则返回用户设置。
    function effectiveSlider(key) {
      const s = readSettings();
      const track = EVOLVE_TRACKS[key];
      if (!evolveState.active || !track) return s[key];
      // 被任何一方抢走过这个滑杆 → 交还给那一方，系统不再改它
      if (heldBy[key]) return s[key];
      // 湿度走脉冲，不走正弦 —— 理由见 HUMID_PULSE 上面那段。
      if (key === "humidPos") return humidPulseAt(evolveState.t);
      const base = evolveState.base[key];
      if (!Number.isFinite(base)) return s[key];
      const w = Math.sin((evolveState.t / track.period) * Math.PI * 2 + track.phase);
      return clamp(base + w * track.amp * 100, 0, 100, s[key]);
    }

    // 开关自演化。打开时把每条被接管的滑块「当前值」记成起点 —— 不跳变。
    function setEvolve(on) {
      const s = readSettings();
      evolveState.active = !!on;
      if (evolveState.active) {
        evolveState.t = 0;
        evolveState.base = Object.create(null);
        for (const key of Object.keys(EVOLVE_TRACKS)) evolveState.base[key] = s[key];
        // 重新打开 = 重新接管：清掉「被抢回去」的记录，
        // 否则上次被抢走的参数会在下次开启时仍然归对方，和「重新开始演化」的直觉不符。
        for (const key of Object.keys(heldBy)) delete heldBy[key];
      } else {
        // 关掉时把当前漂移到的值冻结进设置，让用户从「看到的状态」接着调，
        // 而不是突然跳回打开前的旧值。
        // 注意顺序：必须先算出所有值，再清 base、再写入 —— 反过来会读到设置里的旧值。
        const snapshot = {};
        for (const key of Object.keys(EVOLVE_TRACKS)) {
          snapshot[key] = Math.round(effectiveSlider(key));
        }
        evolveState.base = Object.create(null);
        writeSettings(snapshot);
      }
    }

    // 把自演化接管的值合进一份设置快照。
    // paint() 和 render() 都走这里，保证「推进引擎的值」和「面板显示的值」始终一致。
    function withEvolved(settings) {
      if (!evolveState.active) return settings;
      const out = { ...settings };
      for (const key of Object.keys(EVOLVE_TRACKS)) {
        const v = effectiveSlider(key);
        // lightningCount 的合法区间是 1..5，和 0..100 的滑杆不是同一套刻度
        out[key] = key === "lightningCount"
          ? Math.max(1, Math.min(5, Math.round(1 + (v / 100) * 4)))
          : Math.round(v);
      }
      return out;
    }

    // 推进演化时间（由驱动慢拍调用，不依赖 rAF，关掉面板也在走）
    function stepEvolve(dtSeconds) {
      if (!evolveState.active) return;
      evolveState.t += dtSeconds;
    }

    // 「设为默认」：把当前设置整份冻结成基准。
    // 同时写回 STORE_KEY，保证两者一致：不然 STORE_KEY 还停在冻结前的旧值，
    // 下一次一拖滑杆，writeSettings 就会拿那份旧值当底去合并。
    // snapshot 可选：不传就是「把当前设置冻结成基准」；
    // 传了就是「把指定的一份冻结成基准」（出厂设置也能用它设为启动默认）。
    function saveUserDefaults(snapshot) {
      const snap = normalize(snapshot || readSettings());
      try {
        window.localStorage.setItem(USER_DEFAULTS_KEY, JSON.stringify(snap));
        window.localStorage.setItem(STORE_KEY, JSON.stringify(snap));
      } catch (error) { /* 存不进去就只在本次会话生效，下面的返回值仍然可用 */ }
      return snap;
    }

    // 「恢复默认」要回到的那一份：用户冻结过就用冻结的，没冻结过才用出厂 DEFAULTS。
    function readUserDefaults() {
      const stored = readDefaultsRaw();
      return stored ? normalize(stored) : normalize(DEFAULTS);
    }

    // ------------------------------------------------------------ glass sheet

    function alpha(value) {
      return Number(value.toFixed(2));
    }

    // 沉浸模式（纯壁纸）：把 DSH 的界面全部让出来，只留天气本身。
    // 用法：按 Ctrl+Shift+H 切换。保留天气悬浮按钮，否则用户无法退出。
    function immersiveCss(on) {
      if (!on) return "";
      // 沉浸态必须有一个「回到界面」的入口，否则用户被困在壁纸里。
      // 屏幕正中放一个大按钮，毛玻璃底 + 呼吸动画，一眼就能看到。
      return `
body .dshDesktopFrame,
body .dshDesktopSidebarSurface,
body .dshDesktopConversationSurface,
body .dshDesktopDetailsSurface,
body .dshDesktopMacCaptionRow,
body .dshDesktopWindowsCaptionRow,
body [data-slot="sidebar"],
body [data-slot="main.conversation"],
body [data-slot="main"],
body [data-rightbar-col],
body [data-shell-bottom],
body [data-shell-overlay] {
  display: none !important;
}
`;
    }

    function glassCss(glass) {
      const light = glass / 100;
      const dark = Math.min(0.95, light);
      // 深浅两套只是底色和 alpha 不同，结构完全一致 —— 收成一个生成器，
      // 改一处两边同时生效（原来各写一遍，改一边忘一边就会「深色玻璃失效」）。
      const themeVars = (base, layer1, layer2, layer3, platform, overlay, sidebar, selector) => `
  --dsw-alias-bg-base: ${base};
  --dsw-alias-bg-layer-1: ${layer1};
  --dsw-alias-bg-layer-2: ${layer2};
  --dsw-alias-bg-layer-3: ${layer3};
  --dsw-alias-bg-module-platform: ${platform};
  --dsw-alias-bg-multi-select: ${platform};
  --dsw-alias-bg-overlay: ${overlay};
  --dsw-specific-sidebar-fill: ${sidebar};
  --dsw-specific-selector: ${selector};`;
      const rgba = (r, g, b, a) => `rgba(${r}, ${g}, ${b}, ${alpha(a)}) !important`;
      const lightVars = themeVars(
        rgba(255, 255, 255, light), rgba(255, 255, 255, light), rgba(255, 255, 255, light), rgba(255, 255, 255, light),
        rgba(245, 246, 247, light + 0.02), "rgba(233, 236, 242, .97) !important",
        rgba(249, 250, 251, Math.max(0, light - 0.04)), rgba(245, 246, 247, light + 0.02));
      const darkVars = themeVars(
        rgba(9, 12, 16, dark), rgba(12, 16, 22, dark), rgba(16, 20, 27, dark), rgba(20, 25, 33, dark),
        rgba(13, 17, 23, dark + 0.02), "rgba(18, 22, 30, .97) !important",
        rgba(11, 15, 21, Math.max(0, dark - 0.05)), rgba(13, 17, 23, dark + 0.02));
      return `
:root, body {${lightVars}
}
:root[data-ds-dark-theme], body[data-ds-dark-theme] {${darkVars}
}
body:is([data-dsh-desktop-mode="advanced"], [data-dsh-desktop-mode="extended"]) .dshDesktopFrame {
  background: var(--dsw-alias-bg-base) !important;
}
body:is([data-dsh-desktop-mode="advanced"], [data-dsh-desktop-mode="extended"]) .dshDesktopSidebarSurface {
  --dsw-specific-sidebar-fill: transparent !important;
}
body:is([data-dsh-desktop-mode="advanced"], [data-dsh-desktop-mode="extended"]) :is(
  .dshDesktopSidebarSurface,
  .dshDesktopConversationSurface,
  .dshDesktopDetailsSurface,
  .dshDesktopMacCaptionRow,
  .dshDesktopWindowsCaptionRow,
  .dshDesktopConversationSurface > *,
  .dshDesktopConversationSurface [data-phase="hero"],
  .dshDesktopConversationSurface [data-phase="active"],
  .dshDesktopConversationSurface [data-phase="settling"],
  .dshDesktopDetailsSurface > *
) {
  background: transparent !important;
}
html:is([data-platform="darwin"], [data-windows-titlebar]) body #root div:has(> [data-shell-overlay]) {
  background: var(--dsw-alias-bg-base) !important;
}
html:is([data-platform="darwin"], [data-windows-titlebar]) body #root div:has(> [data-shell-overlay]) > :first-child [data-slot="sidebar"] {
  --dsw-specific-sidebar-fill: transparent !important;
}
html:is([data-platform="darwin"], [data-windows-titlebar]) body #root div:has(> [data-shell-overlay]) > :is(:first-child, :nth-child(2), [data-rightbar-col], [data-shell-bottom]),
html:is([data-platform="darwin"], [data-windows-titlebar]) body #root div:has(> [data-shell-overlay]) > :nth-child(2) [data-phase],
html:is([data-platform="darwin"], [data-windows-titlebar]) body #root [data-rightbar-col] [data-dockkit-host="dock"] > [data-dockkit-content] {
  background: transparent !important;
}
html[data-windows-titlebar] body #root div:has(> [data-shell-overlay])::before {
  background: transparent !important;
}
body [data-slot="main.conversation"] {
  --dsw-specific-input-major: var(--dsw-alias-bg-layer-1) !important;
  --dsw-specific-bubble: var(--dsw-alias-bg-layer-2) !important;
  --dsw-alias-markdown-code-block: var(--dsw-alias-bg-layer-1) !important;
  --dsw-alias-markdown-code-block-banner: var(--dsw-alias-bg-layer-2) !important;
}
body :is([data-shortcut-modal="settings"], [role="dialog"], [role="alertdialog"]):not(#${IDS.panel}) {
  background: rgba(250, 251, 253, .97) !important;
}
body[data-ds-dark-theme] :is([data-shortcut-modal="settings"], [role="dialog"], [role="alertdialog"]):not(#${IDS.panel}) {
  background: rgba(24, 28, 35, .97) !important;
}
.wSkVaW_root,
.pI_x6G_sidebarCol,
.hHd-Xa_root {
  background: transparent !important;
}`;
    }

    // ---------------------------------------------------------------- styles

    function uiCss() {
      // 面板内所有 .oss-* 规则都要带 #${IDS.panel} 前缀（54 处），
      // 正文统一写成 @@PN@@ 占位，返回前一次性替换成真实 id。
      // 好处：少打一半字、改动 id 不会漏、也不会误伤 #${IDS.fab}。
      const css = `
#${IDS.fab} {
  position: fixed; right: 14px; bottom: 14px; z-index: 2147480100;
  width: 30px; height: 30px; padding: 0; border-radius: 999px;
  display: grid; place-items: center; cursor: pointer;
  /* 金色流光：和「回到界面」按钮同一套金，插件门面统一风格。
     用 stroke 渐变（SVG 描边吃 currentColor），比 background-clip 更适合图标。 */
  color: #c9922a;

  background: color-mix(in srgb, var(--dsw-alias-bg-layer-3, #fff) 82%, transparent);
  border: 1px solid #d9a93c99;
  box-shadow: 0 2px 12px #00000033, 0 0 0 1px #d9a93c22; backdrop-filter: blur(10px);
  opacity: 1; transition: opacity 160ms ease, transform 160ms ease, color 160ms ease, box-shadow 160ms ease;
}
#${IDS.fab}:hover, #${IDS.fab}:focus-visible, #${IDS.fab}[aria-expanded="true"] {
  opacity: 1; color: #e8b64a; transform: translateY(-1px); box-shadow: 0 3px 16px #00000040, 0 0 0 1px #d9a93c66;
}
#${IDS.fab} svg { width: 17px; height: 17px; display: block; }
@@PN@@ {
  position: fixed; right: 14px; bottom: 50px; z-index: 2147480101;
  width: 268px; max-width: calc(100vw - 28px);
  padding: 10px 12px; border-radius: 14px;
  color: var(--dsw-alias-label-primary, #0f1115);
  /* 半透明磨砂底：能透出海面和天空，又保证文字可读。
     不跟随 --dsw-alias-bg-* 变量 —— 那几个被玻璃模块接管了，玻璃拉到 0 会连面板一起消失。 */
  background: rgba(252, 253, 255, 0.42);
  backdrop-filter: blur(18px) saturate(1.35);
  -webkit-backdrop-filter: blur(18px) saturate(1.35);
  border: 1px solid rgba(255, 255, 255, 0.35);
  box-shadow: 0 18px 44px #0000002e, inset 0 1px 0 rgba(255, 255, 255, 0.45);
  font: 12px/1.5 -apple-system, "Segoe UI", "PingFang SC", sans-serif;
  max-height: calc(100vh - 78px); overflow-y: auto; overscroll-behavior: contain;
}
/* 深色主题下的面板底 */
body[data-ds-dark-theme] @@PN@@ {
  color: var(--dsw-alias-label-primary, #e8eef5);
  background: rgba(16, 19, 25, 0.42);
  border-color: rgba(255, 255, 255, 0.14);
  box-shadow: 0 18px 44px #0000005e, inset 0 1px 0 rgba(255, 255, 255, 0.08);
}
@@PN@@[hidden] { display: none; }
@@PN@@ .oss-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
@@PN@@ .oss-title { font-size: 12.5px; font-weight: 600; }
@@PN@@ .oss-close {
  border: 0; background: transparent; color: var(--dsw-alias-label-tertiary, #66788b);
  font: inherit; font-size: 15px; line-height: 1; cursor: pointer; padding: 2px 5px; border-radius: 6px;
}
@@PN@@ .oss-close:hover { color: var(--dsw-alias-label-primary, #0f1115); }
@@PN@@ .oss-section {
  margin-top: 5px; padding-top: 4px; border-top: 1px solid var(--dsw-alias-border-l1, #0000000f);
}
@@PN@@ .oss-section-title {
  font-size: 11px; letter-spacing: .08em; text-transform: uppercase;
  /* 金色：与右下角圆纽的 #c9922a 同色系，深色主题下稍微提亮保证可读 */
  color: #c9922a; margin-bottom: 2px;
}
body[data-ds-dark-theme] @@PN@@ .oss-section-title { color: #e8b64a; }
@@PN@@ .oss-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 4px; }
/* 并排滑杆：两个各占一半，中间一条 8px 缝。用 grid 保证等宽，不等内容长度影响 */
@@PN@@ .oss-pair { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 2px; }
/* 三格并排：光效区最底一行（太阳亮度 / 月亮亮度 / 光晕半径）。
   面板太宽，这一行必须把滑块挤短才放得下三根；格距也比两格时小一点，
   否则三个标签只能截断。其它行继续用两格，不受影响。 */
@@PN@@ .oss-pair.oss-trio { grid-template-columns: 1fr 1fr 1fr; gap: 6px; }
@@PN@@ .oss-pair-item { min-width: 0; }
@@PN@@ .oss-pair-item .oss-row { margin-top: 0; gap: 4px; }
@@PN@@ .oss-pair-item .oss-label { overflow: hidden; text-overflow: ellipsis; }
/* 半格里的滑块与上方标签之间压缩到 3px，整块更紧凑 */
@@PN@@ .oss-pair-item input[type="range"] { margin-top: 3px; }
@@PN@@ .oss-label { color: var(--dsw-alias-label-secondary, #4a5a6b); font-size: 11.5px; white-space: nowrap; }
@@PN@@ .oss-value { font-size: 11.5px; font-variant-numeric: tabular-nums; }
@@PN@@ .oss-seg {
  display: inline-flex; gap: 2px; padding: 2px; border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2, #e8eef5);
}
@@PN@@ .oss-seg button {
  font: inherit; font-size: 11.5px; line-height: 1; padding: 4px 8px; border: 0; border-radius: 6px;
  background: transparent; color: var(--dsw-alias-label-secondary, #4a5a6b); cursor: pointer;
}
@@PN@@ .oss-seg button.is-on {
  background: var(--dsw-alias-bg-overlay, #fff); color: var(--dsw-alias-label-primary, #0f1115);
  box-shadow: 0 0 0 .5px var(--dsw-alias-border-l2, #0000001a);
}
@@PN@@ .oss-switch { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 2px; }
/* 开关放进半格时：外边距归零（由 oss-pair 统一控制），标签太长就省略 */
@@PN@@ .oss-pair-item.oss-switch { margin-top: 0; }
@@PN@@ .oss-pair-item.oss-switch label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 开关那一行下面紧跟滑块组，行距压到 2px */
@@PN@@ .oss-pair + .oss-pair { margin-top: 2px; }
/* 三格一行：[开关] [滑块] [滑块]。
   开关列和滑块列都贴底对齐，名字和滑杆标签在同一条水平线上，挤但不乱。
   开关列固定宽度，只放「闪电」两个字；剩下的宽度两个滑块平分。 */
@@PN@@ .oss-line {
  display: grid; grid-template-columns: auto 1fr 1fr; gap: 8px; align-items: end; margin-top: 7px;
}
/* 名字就是开关：关着描边，开了一整块点亮，一眼能看出状态 */
@@PN@@ .oss-flip {
  font: inherit; font-size: 11.5px; line-height: 1; white-space: nowrap;
  padding: 0 9px; height: 19px; border-radius: 6px; cursor: pointer;
  border: .5px solid var(--dsw-alias-border-l2, #0000001a);
  background: transparent; color: var(--dsw-alias-label-secondary, #4a5a6b);
  transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
}
@@PN@@ .oss-flip:hover { border-color: var(--dsw-alias-brand-primary, #8fe9e4); }
@@PN@@ .oss-flip.is-on {
  background: var(--dsw-alias-brand-primary, #8fe9e4); color: #0f1115; font-weight: 600;
  border-color: transparent;
}
@@PN@@ .oss-switch label { font-size: 11.5px; color: var(--dsw-alias-label-secondary, #4a5a6b); }
@@PN@@ .oss-switch input[type="checkbox"] {
  width: 15px; height: 15px; margin: 0; cursor: pointer; accent-color: var(--dsw-alias-brand-primary, #8fe9e4);
}
@@PN@@ input[type="range"] {
  appearance: none; -webkit-appearance: none; display: block; width: 100%;
  height: 14px; margin: 6px 0 0; padding: 0; background: transparent; cursor: pointer;
}
@@PN@@ input[type="range"]::-webkit-slider-runnable-track {
  height: 3px; border-radius: 2px; background: var(--dsw-alias-border-l2, #00000026);
}
@@PN@@ input[type="range"]::-webkit-slider-thumb {
  appearance: none; -webkit-appearance: none; width: 13px; height: 13px; margin-top: -5px;
  border: 0; border-radius: 50%; background: var(--dsw-alias-brand-primary, #8fe9e4);
  box-shadow: 0 0 0 2px var(--dsw-alias-bg-overlay, #fff);
}
@@PN@@ input[type="range"]::-moz-range-track {
  height: 3px; border-radius: 2px; background: var(--dsw-alias-border-l2, #00000026);
}
@@PN@@ input[type="range"]::-moz-range-thumb {
  width: 13px; height: 13px; border: 0; border-radius: 50%; background: var(--dsw-alias-brand-primary, #8fe9e4);
}
@@PN@@ input[type="range"]:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #8fe9e4); outline-offset: 3px; }
@@PN@@ .oss-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 11px; }
/* 一行极简提醒（闪电只在雨里出现）：最轻的视觉重量，不抢滑杆 */
@@PN@@ .oss-note {
  margin: 6px 0 0; font-size: 10.5px; line-height: 1.4; color: var(--dsw-alias-label-tertiary, #66788b);
}
@@PN@@ .oss-note.is-warn { color: #c08a2a; }
/* 两个模式按钮的旧样式已废弃：它们现在是 .oss-modes4 里的 .oss-mode-btn，
   尺寸/颜色统一由上面那组 .oss-mode-btn 规则管，这里不再重复定义尺寸。 */
/* 纯金流光：把金色渐变裁进文字，再让它缓慢流动。
   只做「渐变 + 位移」两层，不做粒子闪点——那会让 30px 的按钮过分抢眼。
   成本：8 行 CSS，0 JS，background-clip:text 由浏览器原生完成，几乎不花性能。 */
.oss-gold-shine {
  /* 纯金流光：五段金色渐变裁进文字，再让它缓慢流动。
     这是 CSS 能做到的、最接近真金的反光效果：静态是金，动态在流。
     成本：0 JS，background-clip:text 由浏览器原生合成，几乎不花性能。 */
  background: linear-gradient(100deg, #8f6a17 0%, #e8b64a 22%, #fff3c4 38%, #e8b64a 55%, #8f6a17 100%);
  background-size: 250% 100%;
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  animation: oss-gold-flow 5.5s linear infinite;
}

@keyframes oss-gold-flow {
  0% { background-position: 0% 50%; }
  100% { background-position: 250% 50%; }
}
/* 系统开启「减少动态效果」时停掉流动，保留静态金渐变 */
@media (prefers-reduced-motion: reduce) {
  .oss-gold-shine { animation: none; }
}

@@PN@@ .oss-hint { color: var(--dsw-alias-label-tertiary, #66788b); font-size: 10.5px; }
@@PN@@ .oss-reset {
  font: inherit; font-size: 10.5px; line-height: 1; padding: 3px 0; border: 0; background: transparent;
  color: var(--dsw-alias-label-tertiary, #66788b); cursor: pointer; text-decoration: underline;
}
@@PN@@ .oss-reset:hover { color: var(--dsw-alias-label-primary, #0f1115); }
/* 底部两个按钮：左边保存、右边恢复，靠右挤在一起 */
@@PN@@ .oss-foot-actions { display: inline-flex; align-items: center; gap: 12px; }
@@PN@@ .oss-save {
  font: inherit; font-size: 10.5px; line-height: 1; padding: 3px 0; border: 0; background: transparent;
  /* 「设为默认」标成金色、加粗、去掉下划线 —— 两个大面板 + 一个小面板底部都有这一个，
     它是这三个面板里唯一需要用户主动按的动作，用颜色把它从「恢复默认」里区分开。 */
  color: #c9922a; cursor: pointer; text-decoration: none; font-weight: 600;
}
@@PN@@ .oss-save:hover { color: #e8b64a; }
/* 保存成功时按钮短暂变一下，给个「已经存住了」的确认 */
@@PN@@ .oss-save.is-saved { color: var(--dsw-alias-brand-primary, #1aa39b); text-decoration: none; font-weight: 600; }

/* ============ 首层：四格模式小框 ============ */
/* 面板按钮在右下角，所有面板一律往上叠：
   FAB(bottom:14) → 四格框 → (展开的)滑块长条
   用 column-reverse 让 DOM 顺序保持「标题在前」，视觉上却是往上堆。 */
@@PN@@ .oss-modes4 {
  display: grid; grid-template-columns: 1fr 1fr; gap: 1mm;
  margin-top: 6px;
}
@@PN@@ .oss-mode-btn {
  display: flex; align-items: center; gap: 5px; justify-content: flex-start;
  font: inherit; font-size: 11px; line-height: 1.2;
  padding: 7px 8px; border-radius: 9px; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l1, #00000014);
  background: var(--dsw-alias-bg-layer-2, #f2f4f7);
  color: var(--dsw-alias-label-primary, #0f1115);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  transition: background .15s, color .15s, border-color .15s;
}
@@PN@@ .oss-mode-btn:hover { border-color: var(--dsw-alias-border-l2, #00000024); }
/* 已开启的开关型按钮 */
/* 不用 --dsw-alias-brand-primary —— 那个变量在不同主题下可能是白/透明，
   实测出现过「点了没变化」的观感。这里用固定的金色，和右下角圆纽 #c9922a 同系，
   激活一眼可辨，不依赖任何主题变量。 */
@@PN@@ .oss-mode-btn[aria-pressed="true"] {
  background: linear-gradient(180deg, #f0c14b, #d9a132);
  color: #2a1c00; border-color: #b8860b; font-weight: 600;
  box-shadow: 0 0 0 1px #b8860b55, inset 0 1px 0 #ffe9a8;
}
body[data-ds-dark-theme] @@PN@@ .oss-mode-btn[aria-pressed="true"] {
  background: linear-gradient(180deg, #f0c14b, #d9a132);
  color: #241700; border-color: #b8860b;
}
/* 展开型按钮（其他地形 / 调试模式）激活态 */
@@PN@@ .oss-mode-btn[aria-expanded="true"] { border-color: #c9922a; color: #c9922a; }
@@PN@@ .oss-mode-btn .oss-caret { margin-left: auto; font-size: 9px; opacity: .7; }

/* ============ 左侧子面板：其他地形 ============ */
/* 【为什么它需要单独一份样式】
   主面板的全部样式都写成「#主面板ID .oss-pair」这类后代选择器（@@PN@@ 展开成 #panelId）。
   这个子面板挂的是 body，不是主面板的子元素，所以那些规则一条都命中不了。
   又不能挂进主面板：主面板有 overflow-y:auto + backdrop-filter，
   子面板会被裁剪，或者定位参考系变成主面板。
   折中办法：子面板用【自己的】类名，下面逐条补全它需要的样式。
   改动主面板样式时，如果那几个控件也用在这个子面板里，记得同步这里。 */
/* 注意：本文件是模板字符串，CSS 注释里不能出现反引号，否则会提前闭合。
   上面那行特意写成「#主面板ID」而不是带反引号的形式。 */
.oss-subpanel {
  display: block;
  position: fixed; right: 296px; bottom: 50px; z-index: 2147480102;
  width: 212px; max-width: calc(100vw - 320px);
  padding: 9px 11px; border-radius: 12px;
  background: rgba(250, 251, 253, 0.88);
  backdrop-filter: blur(14px) saturate(1.3);
  -webkit-backdrop-filter: blur(14px) saturate(1.3);
  border: 1px solid rgba(255, 255, 255, 0.45);
  box-shadow: 0 14px 34px #0000002a, inset 0 1px 0 rgba(255, 255, 255, 0.4);
  font: 12px/1.5 -apple-system, "Segoe UI", "PingFang SC", sans-serif;
  color: var(--dsw-alias-label-primary, #0f1115);
  max-height: calc(100vh - 78px); overflow-y: auto; overscroll-behavior: contain;
}
body[data-ds-dark-theme] .oss-subpanel {
  color: var(--dsw-alias-label-primary, #e8eef5);
  background: rgba(16, 19, 25, 0.88);
  border-color: rgba(255, 255, 255, 0.16);
  box-shadow: 0 14px 34px #00000055, inset 0 1px 0 rgba(255, 255, 255, 0.08);
}
.oss-subpanel[hidden] { display: none !important; }
/* 子面板内部的控件样式（对应主面板里 @@PN@@ .oss-xxx 那一组，这里只补用到的） */
.oss-subpanel .oss-section { margin-top: 5px; padding-top: 4px; border-top: 1px solid var(--dsw-alias-border-l1, #0000000f); }
.oss-subpanel .oss-section-title {
  font-size: 11px; letter-spacing: .08em; text-transform: uppercase;
  color: #c9922a; margin-bottom: 2px;
}
body[data-ds-dark-theme] .oss-subpanel .oss-section-title { color: #e8b64a; }
.oss-subpanel .oss-switch,
.oss-subpanel .oss-row { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
.oss-subpanel .oss-switch { margin: 3px 0; }
.oss-subpanel .oss-label { font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.oss-subpanel .oss-value { font-size: 10.5px; color: var(--dsw-alias-label-tertiary, #66788b); font-variant-numeric: tabular-nums; }
.oss-subpanel .oss-pair { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 4px; }
.oss-subpanel .oss-pair-item { min-width: 0; }
.oss-subpanel .oss-pair-item .oss-label { overflow: hidden; text-overflow: ellipsis; }
.oss-subpanel input[type="range"] { width: 100%; margin: 2px 0 0; }
.oss-subpanel .oss-foot {
  display: flex; align-items: center; justify-content: space-between;
  gap: 8px; margin-top: 7px; padding-top: 5px;
  border-top: 1px solid var(--dsw-alias-border-l1, #0000000f);
}
.oss-subpanel .oss-foot-actions { display: inline-flex; align-items: center; gap: 10px; }
.oss-subpanel .oss-hint { color: var(--dsw-alias-label-tertiary, #66788b); font-size: 10.5px; }
.oss-subpanel .oss-save,
.oss-subpanel .oss-reset {
  font: inherit; font-size: 10.5px; line-height: 1; padding: 3px 0; border: 0; background: transparent;
  color: var(--dsw-alias-label-tertiary, #66788b); cursor: pointer; text-decoration: underline;
}
.oss-subpanel .oss-save:hover,
.oss-subpanel .oss-reset:hover { color: var(--dsw-alias-label-primary, #0f1115); }
.oss-subpanel .oss-save.is-saved { color: var(--dsw-alias-brand-primary, #1aa39b); text-decoration: none; font-weight: 600; }

/* ============ 调试滑块长条 ============ */
/* 不是新面板，而是主面板内部往上的第二个「块」，与四格框之间留 1mm 缝。
   放在主面板里，滚动和位置都跟主面板一起走，不会错位。 */
@@PN@@ .oss-debug {
  /* 与四格框之间保持 1mm 缝（这是用户要求的那个分隔），
     但【分组之间】贴紧，靠各自边框区分，不再留空隙。 */
  margin-top: 1mm;
  padding-top: 0;
  border-top: 0;
  display: flex; flex-direction: column; gap: 0;
}
@@PN@@ .oss-debug[hidden] { display: none; }
/* 调试长条里的每个分组收成一个可折叠块 */
@@PN@@ .oss-fold {
  border: 1px solid var(--dsw-alias-border-l1, #00000014);
  /* 相邻分组贴在一起：只保留外侧圆角，中间用一条边线分隔，不再有缝 */
  border-radius: 0;
  background: var(--dsw-alias-bg-layer-2, #f2f4f7);
  overflow: hidden;
}
@@PN@@ .oss-fold:first-child { border-radius: 9px 9px 0 0; }
@@PN@@ .oss-fold:last-child { border-radius: 0 0 9px 9px; }
@@PN@@ .oss-fold:only-child { border-radius: 9px; }
/* 中间的分隔线只留一条，避免两条边框叠成粗线 */
@@PN@@ .oss-fold + .oss-fold { border-top: 0; }
@@PN@@ .oss-fold > summary {
  list-style: none; cursor: pointer;
  padding: 5px 9px; font-size: 11px; font-weight: 600;
  color: #c9922a; letter-spacing: .04em;
  display: flex; align-items: center; gap: 4px;
}
/* 标题里的括号注解（如「闪电只在雨里出现」）：小而淡，不抢标题 */
@@PN@@ .oss-summary-note {
  font-size: 9.5px; font-weight: 400; letter-spacing: 0;
  color: var(--dsw-alias-label-tertiary, #66788b);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  min-width: 0;
}
/* 当前不是雨天时点亮：提示「闪电为什么没反应」 */
@@PN@@ .oss-summary-note.is-warn { color: #c08a2a; }
@@PN@@ .oss-fold > summary::-webkit-details-marker { display: none; }
@@PN@@ .oss-fold > summary::after { content: "▸"; margin-left: auto; flex: 0 0 auto; font-size: 9px; transition: transform .15s; }
@@PN@@ .oss-fold[open] > summary::after { transform: rotate(90deg); }
/* 分组内边距收窄：省掉上下多余的空白 */
@@PN@@ .oss-fold-body { padding: 2px 9px 6px; }
@@PN@@ button:focus-visible, #${IDS.fab}:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary, #8fe9e4); outline-offset: 2px;
}
#${IDS.weather} canvas.oss-canvas { position: absolute; inset: 0; display: block; pointer-events: none; }
#${IDS.weather} .oss-mist { position: absolute; inset: -12%; pointer-events: none; transition: opacity 600ms ease; }
#${IDS.weather} .oss-flash {
  position: absolute; inset: 0; opacity: 0; pointer-events: none;
  --oss-flash-x: 50%; --oss-peak: .85;
  /* 闪光时长由 JS 每次闪击时按该次寿命设置，不再固定 1100ms */
  --oss-flash-ms: 1100ms;
  /* 天光从云底亮起，不是从屏幕顶边。-12% → 14%（云底在屏幕约 13% 处） */
  background: radial-gradient(120% 85% at var(--oss-flash-x) 14%,
    rgba(230, 243, 255, var(--oss-peak)), rgba(198, 224, 250, calc(var(--oss-peak) * .33)) 46%, rgba(255, 255, 255, 0) 76%);
}
#${IDS.weather} .oss-flash[data-flashing="true"] { animation: oss-flash var(--oss-flash-ms) ease-out 1; }
@keyframes oss-flash {
  0% { opacity: 0; } 4% { opacity: .72; } 9% { opacity: .16; }
  14% { opacity: .5; } 27% { opacity: .08; } 45% { opacity: 0; } 100% { opacity: 0; }
}
@media (prefers-reduced-motion: reduce) {
  #${IDS.fab} { transition: none; }
  #${IDS.weather} .oss-flash[data-flashing="true"] { animation: none; }
}

/* ---- 梦境面板 ----
   鱼睡着时浮在它头顶的一小块控制面板。
   纯透明背景 + 一圈柔光边框：不挡住后面的草地，但边界清楚。
   定位由 JS 按「鱼头顶的世界坐标投影到屏幕」给出，这里只管外观和进出场。 */
.oss-dream {
  position: fixed; z-index: 2147480060;
  width: 148px; padding: 10px 12px 11px;
  border-radius: 14px;
  /* 背景几乎全透明，只留一层极淡的冷白，让文字有落点又不挡景 */
  background: rgba(255, 255, 255, .055);
  border: 1px solid rgba(255, 255, 255, .28);
  /* 双层光圈：内圈细、外圈散。这是「光晕边框」的全部实现 */
  box-shadow:
    0 0 0 1px rgba(255, 255, 255, .12) inset,
    0 0 18px rgba(200, 230, 255, .30),
    0 0 46px rgba(150, 200, 255, .16);
  -webkit-backdrop-filter: blur(3px) saturate(1.1);
  backdrop-filter: blur(3px) saturate(1.1);
  color: rgba(255, 255, 255, .92);
  font-size: 11px; line-height: 1.6;
  pointer-events: none;
  opacity: 0; transform: translate(-50%, -100%) scale(.94);
  transition: opacity 320ms ease, transform 320ms cubic-bezier(.2, .9, .3, 1);
}
.oss-dream.is-on {
  opacity: 1; transform: translate(-50%, -100%) scale(1);
  /* 玩家不能操作这块面板 —— 它是「鱼在做梦」的展示，手指才是唯一在动的手。
     允许 pointer-events 的话，玩家能直接拖滑杆，那就不是梦在操控了。 */
  pointer-events: none;
}
.oss-dream-title {
  margin-bottom: 6px; text-align: center;
  font-size: 10px; letter-spacing: .18em;
  color: rgba(255, 255, 255, .55);
}
.oss-dream-row { display: grid; grid-template-columns: 30px 1fr; align-items: center; gap: 8px; }
.oss-dream-row > span { color: rgba(255, 255, 255, .70); }
/* 滑杆：透明轨道 + 白色圆点，和整体一致，不引入第二种视觉语言 */
.oss-dream input[type="range"] {
  -webkit-appearance: none; appearance: none;
  width: 100%; height: 14px; background: transparent; cursor: default;
  pointer-events: none;
}
.oss-dream input[type="range"]::-webkit-slider-runnable-track {
  height: 2px; border-radius: 2px;
  background: rgba(255, 255, 255, .22);
  box-shadow: 0 0 8px rgba(200, 230, 255, .25);
}
.oss-dream input[type="range"]::-webkit-slider-thumb {
  -webkit-appearance: none; appearance: none;
  width: 10px; height: 10px; margin-top: -4px; border-radius: 999px;
  background: #fff;
  box-shadow: 0 0 8px rgba(200, 230, 255, .85), 0 0 16px rgba(150, 200, 255, .45);
}
.oss-dream input[type="range"]::-moz-range-track {
  height: 2px; border-radius: 2px; background: rgba(255, 255, 255, .22);
}
.oss-dream input[type="range"]::-moz-range-thumb {
  width: 10px; height: 10px; border: 0; border-radius: 999px; background: #fff;
  box-shadow: 0 0 8px rgba(200, 230, 255, .85);
}
/* 梦游的手指：一个很小的白点，带一圈呼吸光。
   位置由 JS 按滑杆的实际盒子算出来，所以用 transform 而不是 left/top。 */
.oss-dream-hand {
  position: absolute; left: 0; top: 0;
  width: 9px; height: 9px; margin: -4.5px 0 0 0;
  border-radius: 999px;
  background: rgba(255, 255, 255, .95);
  box-shadow: 0 0 10px rgba(210, 235, 255, .95), 0 0 22px rgba(150, 200, 255, .55);
  opacity: 0; pointer-events: none;
  transition: opacity 420ms ease, transform 60ms linear;
}
.oss-dream-hand.is-visible { opacity: .92; }
@media (prefers-reduced-motion: reduce) {
  .oss-dream { transition: none; }
  .oss-dream-hand { transition: opacity 200ms ease; }
}`;
      return css.replace(/@@PN@@/g, "#" + IDS.panel);
    }

    const ICONS = {
      rain: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M7 15.5a4 4 0 0 1-.4-8A5.5 5.5 0 0 1 17.4 8a3.8 3.8 0 0 1 .6 7.5"/><path d="M8 18.5 7 21M12 18.5 11 21M16 18.5 15 21"/></svg>',
      snow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M12 3v18M4.2 7.5l15.6 9M19.8 7.5l-15.6 9"/><path d="M9.4 5.3 12 7.4l2.6-2.1M9.4 18.7 12 16.6l2.6 2.1"/></svg>',
      none: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="7.5"/><path d="M7 17 17 7"/></svg>',
      wave: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M1.4 8.6c1.2-1.8 2.4-1.8 3.6 0s2.4 1.8 3.6 0 1.9-1.3 3-.6 2.4 1.3 3 .6"/><path d="M1.4 12.4c1.2-1.5 2.4-1.5 3.6 0s2.4 1.5 3.6 0 1.9-1.1 3-.5" opacity=".55"/></svg>',
      // 天气总图标：云 + 太阳（晴转多云）。整个插件的门面，不随场景变化。
      // 太阳在右上，云在左下压住它的一角——一眼是「天气」而不是「下雨」。
      weather: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">'
        + '<circle cx="16.6" cy="7.2" r="3.1" />'
        + '<path d="M16.6 1.9v1.5M16.6 10.9v1.5M11.3 7.2h1.5M20.2 7.2h1.5" opacity=".75" />'
        + '<path d="M4.4 18.4h8.2a3.2 3.2 0 0 0 .3-6.4 4.6 4.6 0 0 0-8.6 1.3 2.55 2.55 0 0 0 .1 5.1z" />'
        + '</svg>',

    };

    // -------------------------------------------------------- weather engine

    const RAIN_RGB = { dark: [186, 222, 250], light: [46, 78, 110] };
    const SNOW_RGB = { dark: [226, 240, 253], light: [96, 124, 158] };

    function random(min, max) {
      return min + Math.random() * (max - min);
    }

    function rgba(rgb, value) {
      return "rgba(" + rgb[0] + ", " + rgb[1] + ", " + rgb[2] + ", " + value.toFixed(3) + ")";
    }

    function sprite(size, paint) {
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      paint(canvas.getContext("2d"), size);
      return canvas;
    }

    // ---- 圆形柔光贴图（雪花用）
    function spritePaint(kind, rgb, hardness) {
      return (g, size) => {
        const c = size / 2;
        const gradient = g.createRadialGradient(c, c, 0, c, c, c);
        gradient.addColorStop(0, rgba(rgb, 1));
        gradient.addColorStop(hardness, rgba(rgb, 0.65));
        gradient.addColorStop(1, rgba(rgb, 0));
        g.fillStyle = gradient;
        g.beginPath();
        g.arc(c, c, c, 0, Math.PI * 2);
        g.fill();
      };
    }

    function glowSprite(rgb, hardness) {
      return sprite(64, spritePaint("glow", rgb, hardness));
    }

    // 雨雪消失线：1.0 = 屏幕底边。改成 <1 会让雨雪在半空断掉，观感像被一刀切。
    // ↓ 下面这几个必须放模块级，不能塞进 createRainScene：
    //   createSnowScene 也要用，塞进去就 ReferenceError（已经踩过两次）。
    const FLOOR_RATIO = 1.0;

    // 全局风：雨雪共用的唯一风源。分两级取，降级先行：
    //   1) 网格风 __ossWindField()（气压梯度给方向，每拍更新）—— 有则用
    //   2) 单值风 __ossWind()（云漂移给方向）—— 没有网格风时兜底
    //   3) 常量 (0.6, 1) —— 引擎还没加载时兜底，保证雨雪照常下
    // windTick 由 tick() 每帧递增，用来让缓存失效；一帧内雨和雪只向引擎问一次。
    let windTick = 0;
    let globalWindCache = null;

    // 网格风缓存：从 __ossWindField() 拿整块，按 uv 双线性采样。
    // 拿不到时返回 null，让调用方回退到单值风。
    let fieldCache = null;
    let fieldCacheTick = -1;

    function windFieldAt(u, v) {
      if (fieldCacheTick !== windTick) {
        fieldCacheTick = windTick;
        fieldCache = null;
        const api = (typeof window !== "undefined") ? window.__ossWindField : null;
        if (typeof api === "function") {
          try {
            const f = api();
            if (f && f.grid > 0 && f.data && f.data.length === f.grid * f.grid * 2) fieldCache = f;
          } catch (error) { fieldCache = null; }
        }
      }
      if (!fieldCache) return null;
      const n = fieldCache.grid, d = fieldCache.data;
      // 周期边界双线性：左右接、上下接
      const fx = Math.min(n - 1e-6, Math.max(0, u) * n), fy = Math.min(n - 1e-6, Math.max(0, v) * n);
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      const tx = fx - x0, ty = fy - y0;
      const x1 = (x0 + 1) % n, y1 = (y0 + 1) % n;
      const at = (yy, xx) => (yy * n + xx) * 2;
      const a = at(y0, x0), b = at(y0, x1), c = at(y1, x0), e = at(y1, x1);
      const wx = (d[a] * (1 - tx) + d[b] * tx) * (1 - ty) + (d[c] * (1 - tx) + d[e] * tx) * ty;
      const wy = (d[a + 1] * (1 - tx) + d[b + 1] * tx) * (1 - ty) + (d[c + 1] * (1 - tx) + d[e + 1] * tx) * ty;
      return { wx, wy };
    }

    function globalWind() {
      if (!globalWindCache || globalWindCache.tick !== windTick) {
        let w = null;
        const api = (typeof window !== "undefined") ? window.__ossWind : null;
        if (typeof api === "function") {
          try { w = api(); } catch (error) { w = null; }
        }
        globalWindCache = {
          tick: windTick,
          x: w && Number.isFinite(w.x) ? w.x : 0.6,
          speed: w && Number.isFinite(w.speed) ? w.speed : 1,
        };
      }
      return globalWindCache;
    }

    // 雨的落点表现：由地形「表面类型」标签决定 —— 地形只声明标签，这里自己分支。
    //   splash 海面：水花溅起 + 涟漪环，最张扬
    //   seep   沙地：没有水花，只有一圈很快消失的暗痕（水渗下去了）
    //   drip   森林：水珠挂在叶面再滴落，弹起低、次数少
    //   grass  草地：水珠挂在细叶上，不弹跳、只有极小的涟漪 —— 草是软的，雨打上去不会溅
    // 放在 createRainScene 外面：引擎对象的 setDrive 要写 surfaceMode，
    // 塞进场景闭包里 setDrive 读不到（报 SURFACE is not defined）。
    const SURFACE = { splash: 0, seep: 1, drip: 2, grass: 3 };
    let surfaceMode = SURFACE.splash;
    // heatRate 也按地形分档（每档按「每秒松弛速率」）：
    //   grass 0.14 —— 草层比森林(0.10)凉得快、比沙漠(0.22)慢
    const SURFACE_HEAT = { splash: 0.05, seep: 0.22, drip: 0.10, grass: 0.14 };

    // 雾模块已移除（2D 贴屏那套做不出纵深，见 docs/FOG.md 的说明）。
    // 面板上的「雾量」滑杆和 fogPos 设置保留：将来地形做好之后，
    // 雾会以能读地形高度的形式重做，那时直接复用这条滑杆。
    // smoothstep 留在原地 —— computeFog 还在用它算大气信号。

    const smoothstep = (edge0, edge1, x) => {
      const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0 || 1e-6)));
      return t * t * (3 - 2 * t);
    };


    function createRainScene(sprites) {
      const drops = [];
      const rings = [];
      const splashes = [];
      const streakCache = new Map();
      let width = 0;
      let height = 0;
      let depthDirty = true;

      // 雨量预算：强度决定基础量，云量再乘一个系数 ——
      // 云散的时候雨自然变小，云满的时候雨最密。这是「天气连着天」的最简单体现。
      // 下限 0.35 保证就算完全无云也还有一点雨，不会突然一滴不剩。
      // 闪电连锁 · 雨这一路：
      //   雷雨昏暗时云量被推到 150 → cloudMask 到 1 → cloudFactor 顶格，雨自然变密，
      //   这一级不需要额外代码，是「云满则雨密」白送的。
      //   雨量在这里是「每次 rebuild 的目标滴数」，改了下一帧就按新目标增减，
      //   不需要重启场景，也不影响闪电自己的排程。
      function rainBudget(state) {
        const cloud = typeof state.cloudMask === "number" ? state.cloudMask : 1;
        const cloudFactor = 0.35 + 0.65 * Math.max(0, Math.min(1, cloud));
        // 驱动层：气压降得越急，雨越密。0 → ×1.0，1 → ×1.4。
        // 不改变强度档位的语义，只是在档位之上叠一层「天气在压下来」的加成。
        const drop = typeof state.pressureDrop === "number" ? Math.max(0, Math.min(1, state.pressureDrop)) : 0;
        const dropFactor = 1 + drop * 0.4;
        // 水汽模块：云滴长大落地给出降水率。雨量在档位之上再乘一层水汽供给系数。
        // 水汽不够时只有一半量（干云），水汽足时给到顶格 —— 「没有水汽，云是空壳」。
        const vap = typeof state.vaporPrecip === "number" ? Math.max(0, Math.min(1, state.vaporPrecip)) : 0;
        const vaporFactor = 0.5 + vap * 0.5;
        // 温度放大：越极端越猛（画感知真实，不按物理真实）。
        // 雨：温度越高越猛（热带暴雨），15°C 是基准，40°C 时 ×1.55。
        // 这里只管雨；雪的对应放大在 snowBudget 里。
        const tempNorm = typeof state.temperature === "number" ? Math.max(0, Math.min(1, state.temperature)) : 0.5;
        const heatFactor = 0.75 + Math.max(0, (tempNorm - 0.5) / 0.5) * 0.8;
        const density = densityAt(state.precipPos) * heatFactor;
        // 上限放到 2000：热带的暴雨加上温度放大，原 1400 会削掉顶部。
        const budget = clamp(Math.round((width * height) / 6200 * density * cloudFactor * dropFactor * vaporFactor), 8, 2000, 24);
        // 雨势 0..1：把「当前滴数相对满档」归一化，给光模块用。
        state.downpour = Math.max(0, Math.min(1, budget / 2000));
        return budget;
      }

      const PIXELS_PER_METRE = 2200;
      const SHUTTER = 0.65;
      const GRAVITY = 9.8;
      const LEN_SIZES = [16, 32, 64, 128, 192];
      // 宽度档位：最大 3.0 对应近处雨丝，不再需要 5/7 那种粗档
      // 宽度档位恢复原版五档。档位越密，中段雨滴越容易被 bucket 向上取整变粗。
      const WIDTH_SIZES = [0.7, 1.0, 1.4, 1.9, 2.6];

      function bucket(sizes, value) {
        for (const size of sizes) if (size >= value) return size;
        return sizes[sizes.length - 1];
      }

      function terminalVelocity(diameter) {
        return 9.65 - 10.3 * Math.exp(-0.6 * diameter);
      }

      // 风场量级换算：气压梯度经中心差分 ×0.5 后，原生量级只有 0.001~0.1。
      // 直接喂给雨雪等于没风，所以乘一个放大系数。
      // WIND_SCALE 让「典型的满梯度」落到 ±1 附近 —— 这样下面可以按
      // 「风速 0..1 × 风向 ±1」来合，而不是拿一个常数偏移去糊。
      const WIND_SCALE = 16;

      function gust(clock, nx, ny) {
        // 风推动雨：返回雨丝的水平速度 vx（归一量）。
        // 旧实现是 0.35 + wx×4.5 —— 那个 0.35 是个固定偏移，
        // 意思是「不下雨也往右斜」。结果风的方向信息只有 0.15 那一小块，
        // 全被常数盖住了，看起来就是「风怎么调都吹不动雨」。
        // 现在改成：方向来自风场（可正可负），大小来自风速。
        // 没有风就是 0（雨直下），风往哪吹雨往哪斜。
        // 风切变（ny 是归一屏幕高度，0=顶 1=底）：
        //   高空风（ny 小）比地面风强。雨滴从高空下来时带着高空风的横向速度，
        //   落到低处才慢慢被地面风拉回 —— 于是同一根雨丝的上段更斜、下段更直。
        //   这是「风切变」在 2D 屏幕上唯一能被看见的形式，也是雷暴的判据之一。
        const field = (nx !== undefined && ny !== undefined) ? windFieldAt(nx, ny) : null;
        let wx, wy, speed;
        if (field) {
          wx = field.wx * WIND_SCALE;
          wy = field.wy * WIND_SCALE;
          speed = globalWind().speed;
        } else {
          const g = globalWind();
          wx = g.x;
          wy = 0;
          speed = g.speed;
        }
        // 切变剖面：ny=0（顶）→ 1.0 满速；ny=1（底）→ 0.45 地面风。
        // 越往上风越强，越往下越接近地面。
        const height = (ny === undefined) ? 0.5 : Math.max(0, Math.min(1, ny));
        const shear = 1.0 - 0.55 * height;
        // 合成：水平驱动 = 方向 × 速度 × 切变
        const drive = wx * (0.35 + 0.65 * speed) * shear;
        const cross = wy * 0.12 * (0.35 + 0.65 * speed) * shear;
        // 本地阵风：让雨有自己的节奏，不跟着风速一刀切
        const local = 0.18 * Math.sin(clock * 0.57 + 1.7);
        return drive + cross + local;
      }

      function responseTime(diameter) {
        return 0.12 + 0.14 * diameter;
      }

      function streakSprite(streakWidth, length, rgb) {
        const key = streakWidth + "|" + length + "|" + rgb[0];
        const hit = streakCache.get(key);
        if (hit) return hit;
        const pad = 3;
        const headWidth = streakWidth * 1.15;
        const tailWidth = streakWidth * 0.32;
        const canvas = document.createElement("canvas");
        canvas.width = Math.ceil(headWidth + pad * 2);
        canvas.height = length + pad * 2;
        const g = canvas.getContext("2d");
        const cx = canvas.width / 2;
        const top = pad;
        const bottom = pad + length;
        const fill = g.createLinearGradient(0, top, 0, bottom);
        fill.addColorStop(0, rgba(rgb, 0));
        fill.addColorStop(0.45, rgba(rgb, 0.45));
        fill.addColorStop(0.88, rgba(rgb, 0.95));
        fill.addColorStop(1, rgba(rgb, 0.6));
        g.fillStyle = fill;
        g.beginPath();
        g.moveTo(cx - tailWidth / 2, top);
        g.quadraticCurveTo(cx - headWidth / 2, bottom - length * 0.35, cx - headWidth / 2, bottom - headWidth / 2);
        g.arc(cx, bottom - headWidth / 2, headWidth / 2, Math.PI, 0);
        g.quadraticCurveTo(cx + headWidth / 2, bottom - length * 0.35, cx + tailWidth / 2, top);
        g.closePath();
        g.fill();
        const made = { canvas, width: canvas.width, height: canvas.height, length };
        streakCache.set(key, made);
        return made;
      }

      // 纵深驱动：z 远近 → d∈[0,1] 归一 → near=(1-d)^8 只在最近一小段有值。
      // 三个参数都从 near 派生，改纵深只动这里，别碰 width 公式。
      //   near 的 8 次幂很关键：降到 1.6 会让中段雨丝整体变粗，观感立刻不对。
      //   width 保持原版公式，是因为一旦重写，bucket() 会向上取整，整屏雨都粗一档。
      function makeDrop(scheme, fromTop) {
        const boost = scheme === "light" ? 1.25 : 1;
        const z = 1.2 + Math.pow(Math.random(), 1.9) * 32.8;
        const diameter = 0.35 + Math.pow(Math.random(), 2.2) * 2.15;
        const k = PIXELS_PER_METRE / z;
        const d = (z - 1.2) / 32.8;
        const near = Math.pow(1 - d, 8.0);
        return {
          z, k, diameter, d,
          vt: terminalVelocity(diameter),
          vx: 0,
          tau: responseTime(diameter),
          angle: 0,
          x: random(-0.08, 1.08) * width,
          y: fromTop ? -random(20, 160) : random(0, height),
          // 原版公式原样保留（含 clamp 上下限），纵深不加到宽度上
          width: clamp((diameter * 1.15 * k) / 900, 0.5, 2.4, 1),
          // 透明度承担主要纵深：原版 1/z 曲线 + 近处微提
          alpha: Math.min(0.62, (0.16 + 0.45 / z) * boost + 0.07 * near),
          // 近处拖影拉长，远处不拉
          lengthMul: 1 + 0.6 * near,
        };
      }

      function splash(x, z, k, impactSpeed, diameter) {
        if (splashes.length > 160) return;
        const floor = height * FLOOR_RATIO;
        // 渗：水不反弹，地面只留下一个迅速消失的暗点，不建环也不建水珠
        if (surfaceMode === SURFACE.seep) {
          if (rings.length > 40) return;
          rings.push({ x, y: floor + 2, r: 1.2, target: 3, life: 0.16, max: 0.16 });
          return;
        }
        rings.push({
          x, y: floor + 2, r: 1.5,
          target: clamp((0.006 + 0.006 * (impactSpeed / 9)) * k, 2.5, 26, 6),
          life: 0.3, max: 0.3,
        });
        // 滴：水珠挂在叶面，弹得低、数量少
        const dripMode = surfaceMode === SURFACE.drip;
        const eject = impactSpeed * (dripMode ? 0.07 : 0.16);
        const count = dripMode
          ? 2 + Math.floor(Math.random() * 2)
          : 4 + Math.floor(Math.random() * 4 + diameter * 1.4);
        for (let index = 0; index < count; index += 1) {
          const spread = random(-1.35, 1.35);
          const speed = eject * random(0.3, 1.2);
          splashes.push({
            x: x + random(-8, 8) * (k / 900),
            y: floor,
            vx: Math.sin(spread) * speed * k,
            vy: -Math.cos(spread) * speed * random(0.75, 1.25) * k,
            g: GRAVITY * k,
            life: random(0.45, 0.85),
            phase: random(0, Math.PI * 2),
            r: clamp((0.9 + Math.random() * 1.7 * (0.6 + diameter * 0.15)) * (k / 1100), 0.6, 3.2, 1),
          });
        }
      }

      return {
        reset(state) {
          width = state.w;
          height = state.h;
          drops.length = 0;
          depthDirty = true;
          rings.length = 0;
          splashes.length = 0;
          const budget = rainBudget(state);
          for (let index = 0; index < budget; index += 1) drops.push(makeDrop(state.scheme, false));
        },
        retune(state) {
          width = state.w;
          height = state.h;
          const budget = rainBudget(state);
          while (drops.length > budget) { drops.pop(); depthDirty = true; }
          while (drops.length < budget) { drops.push(makeDrop(state.scheme, false)); depthDirty = true; }
        },
        step(state, dt) {
          width = state.w;
          height = state.h;
          // 雨落到屏幕底部才消失（触发水花环）
          const floor = height * FLOOR_RATIO;
          for (let index = 0; index < drops.length; index += 1) {
            const drop = drops[index];
            // 每一滴按自己所在的位置取风：有网格风就各吹各的，没有就全屏同向
            const wind = gust(state.clock, drop.x / (width || 1), drop.y / (height || 1));
            drop.vx += (wind - drop.vx) * (1 - Math.exp(-dt / drop.tau));
            drop.angle = Math.atan2(drop.vx, drop.vt);
            const vyScreen = drop.vt * drop.k;
            const vxScreen = drop.vx * drop.k;
            const prevY = drop.y;
            drop.y += vyScreen * dt;
            drop.x += vxScreen * dt;
            if (prevY <= floor && drop.y > floor) {
              const hit = (floor - prevY) / Math.max(1e-6, drop.y - prevY);
              const hitX = drop.x - vxScreen * dt * (1 - hit);
              if (drop.z < 5.5 && Math.random() < 0.6) splash(hitX, drop.z, drop.k, drop.vt, drop.diameter);
              drops[index] = makeDrop(state.scheme, true);
              depthDirty = true;
            } else if (drop.y - 40 > height || drop.x < -140 || drop.x > width + 140) {
              drops[index] = makeDrop(state.scheme, true);
              depthDirty = true;
            }
          }
          for (let index = rings.length - 1; index >= 0; index -= 1) {
            const ring = rings[index];
            ring.life -= dt;
            if (ring.life <= 0) { rings.splice(index, 1); continue; }
            ring.r += (ring.target - ring.r) * Math.min(1, dt * 6);
          }
          for (let index = splashes.length - 1; index >= 0; index -= 1) {
            const drop = splashes[index];
            drop.life -= dt;
            drop.vy += drop.g * dt;
            drop.x += drop.vx * dt;
            drop.y += drop.vy * dt;
            if (drop.life <= 0 || drop.y > height - 3) splashes.splice(index, 1);
          }
        },
        draw(g, state) {
          const rgb = RAIN_RGB[state.scheme] || RAIN_RGB.light;
          const blurDt = clamp(state.dt || 1 / 60, 1 / 240, 1 / 12, 1 / 60);
          if (depthDirty) {
            drops.sort((a, b) => b.z - a.z);
            depthDirty = false;
          }
          for (const drop of drops) {
            // 长度上限 180：超过这个值贴图会被过度拉伸，看起来像一根细线而不是雨滴
            const length = clamp(Math.hypot(drop.vx * drop.k, drop.vt * drop.k) * blurDt * SHUTTER * (drop.lengthMul || 1), 4, 180, 6);
            const streak = streakSprite(bucket(WIDTH_SIZES, drop.width), bucket(LEN_SIZES, length), rgb);
            const scaleY = length / streak.length;
            g.save();
            g.globalAlpha = drop.alpha;
            g.translate(drop.x, drop.y);
            g.rotate(-drop.angle);
            g.drawImage(streak.canvas, -streak.width / 2, -streak.height * scaleY, streak.width, streak.height * scaleY);
            g.restore();
            if (drop.z < 3.2) {
              g.strokeStyle = rgba(rgb, drop.alpha * 0.16);
              g.lineWidth = drop.width * 2.6;
              g.beginPath();
              g.moveTo(drop.x, drop.y);
              g.lineTo(drop.x - Math.sin(drop.angle) * length * 0.9, drop.y - Math.cos(drop.angle) * length * 0.9);
              g.stroke();
            }
          }
          g.globalAlpha = 1;
          for (const ring of rings) {
            const fade = clamp(ring.life / ring.max, 0, 1, 1);
            g.strokeStyle = rgba(rgb, 0.26 * fade);
            g.lineWidth = 0.9;
            g.beginPath();
            g.ellipse(ring.x, ring.y, ring.r, ring.r * 0.26, 0, 0, Math.PI * 2);
            g.stroke();
          }
          for (const drop of splashes) {
            g.globalAlpha = clamp(drop.life * 2.6, 0, 1, 1);
            const base = clamp(1 - drop.r * 0.11, 0.7, 0.97, 0.9);
            const flatten = clamp(base * (1 + 0.12 * Math.sin(drop.life * 40 + drop.phase)), 0.66, 1, 1);
            const heading = Math.atan2(drop.vy, drop.vx);
            g.fillStyle = rgba(rgb, 0.55);
            g.save();
            g.translate(drop.x, drop.y);
            g.rotate(heading);
            g.beginPath();
            g.ellipse(0, 0, drop.r * flatten, drop.r, 0, 0, Math.PI * 2);
            g.fill();
            g.restore();
            g.fillStyle = "rgba(255, 255, 255, 0.6)";
            g.beginPath();
            g.arc(drop.x - drop.r * 0.28, drop.y - drop.r * 0.32, Math.max(0.4, drop.r * 0.45), 0, Math.PI * 2);
            g.fill();
          }
          g.globalAlpha = 1;
        },
      };
    }

    function createSnowScene(sprites) {
      const flakes = [];
      const glints = [];
      let width = 0;
      let height = 0;
      let glintBudget = 0;

      const PIXELS_PER_METRE = 1800;

      function baseWind(clock) {
        // 和云共用同一股风；本地只叠一点缓慢起伏，让雪飘得柔和。
        // 同样不夹正负 —— 风换向时雪片应该跟着换向。
        // 基准偏移 0.28 而雨是 0.35：雪更轻更慢，横漂不该比雨还急。
        const g = globalWind();
        const base = 0.28 + g.x * 0.85 * g.speed;
        return base + 0.3 * Math.sin(clock * 0.047 + 2.1);
      }

      function turbulence(x, y, clock) {
        return 0.28 * Math.sin(x * 0.004 + clock * 0.5)
          + 0.22 * Math.cos(y * 0.005 - clock * 0.37 + x * 0.001)
          + 0.16 * Math.sin((x + y) * 0.002 + clock * 0.83);
      }

      // 雪的风：用「温和放大」而不是雨用的 WIND_SCALE=16。
      // 雪片每帧横移 = vx × k × dt，k 高达 800；vx=0.6 时每帧横移 8px，
      // 几乎和下落一样快 —— 雪会横着飞出屏幕，看起来就是「雪没了」。
      // 所以雪只用一个小系数：风向变了它跟着缓慢漂，但不会被吹飞。
      const SNOW_WIND_SCALE = 3;

      function windAt(x, y, clock) {
        const field = windFieldAt(x / (width || 1), y / (height || 1));
        if (field) {
          const speed = 0.35 + 0.65 * globalWind().speed;
          const drive = field.wx * SNOW_WIND_SCALE * speed;
          const cross = field.wy * SNOW_WIND_SCALE * 0.2 * speed;
          // 网格风是「相对基准的扰动」，所以仍然要叠基准漂移，否则静风区雪会停住
          const g = globalWind();
          const base = 0.28 + g.x * 0.85 * g.speed;
          return base + drive + cross + 0.3 * Math.sin(clock * 0.047 + 2.1) + turbulence(x, y, clock);
        }
        return baseWind(clock) + turbulence(x, y, clock);
      }

      // 雪的纵深参数保持原版，不要「顺手增强」：
      // 雪靠 size(0.7~11px) + 速度差 + 全屏散布天然就有层次（绝对值差 17px），
      // 放大到 20 倍反而变成糊屏的大雪团。用户明确说过这版「挺好」。
      // 同理：r 的 clamp 上下限、alpha 的 0.25~0.95 也都别动。
      function seedFlake(target, scheme, fromTop) {
        const type = Math.random() < 0.68 ? 0 : 1;
        const size = type === 0 ? random(2.5, 7.5) : random(1.2, 3.5);
        const z = 2.2 + Math.pow(Math.random(), 1.4) * 4.3;
        const k = PIXELS_PER_METRE / z;
        target.type = type;
        target.size = size;
        target.z = z;
        target.k = k;
        target.vt = type === 0 ? random(0.55, 1.0) * (1 + size / 30) : random(1.1, 1.7);
        target.vy = target.vt;
        target.vx = 0;
        target.tau = type === 0 ? 0.9 : 0.45;
        target.r = clamp((size * k) / 1000, 0.7, 11, 1);
        target.x = random(0, width);
        target.y = fromTop ? -random(6, 40) : random(-20, height);
        target.phase = random(0, Math.PI * 2);
        target.rot = random(0, Math.PI * 2);
        target.rotSpeed = type === 0 ? random(-1.2, 1.2) : random(-0.4, 0.4);
        target.alpha = clamp((0.35 + 0.5 / z) * (scheme === "light" ? 0.9 : 1), 0.25, 0.95, 0.6);
        target.twinkle = scheme === "dark" && type === 0 && Math.random() < 0.22;
        return target;
      }

      function makeFlake(scheme, fromTop) {
        return seedFlake({}, scheme, fromTop);
      }

      // 雪量预算：和雨一样接云量。雪比雨更依赖云，下限给 0.3 更明显。
      // 驱动层：温度越低雪越容易积 —— 冷天雪量放大，暖天缩水（0 → ×0.6，1 → ×1.3）。
      // 水汽模块：冰晶量 snowDrop 是固态原料，有冰晶才积得起来（0 → ×0.7，1 → ×1.3）。
      function snowBudget(state) {
        const cloud = typeof state.cloudMask === "number" ? state.cloudMask : 1;
        const cloudFactor = 0.3 + 0.7 * Math.max(0, Math.min(1, cloud));
        const temp = typeof state.temperature === "number" ? Math.max(0, Math.min(1, state.temperature)) : 0.5;
        // 冷度放大：越冷雪越大（画感知真实）。
        //   0°C（temp≈0.20）→ ×1.0
        //  -10°C（temp≈0.08）→ ×1.7
        //  -20°C（temp≈0.00）→ ×2.2  ← 超级暴雪
        // 温度归一换算：0 = -10°C，1 = 40°C，所以 -20°C 已经低于 0，钳在底。
        const coldFactor = 0.55 + (1 - temp) * 1.65;
        const ice = typeof state.snowDrop === "number" ? Math.max(0, Math.min(1, state.snowDrop)) : 0;
        const iceFactor = 0.7 + ice * 0.6;
        // 上限放到 2200：超级暴雪要能真的糊满屏幕。
        return clamp(Math.round((width * height) / 11000 * densityAt(state.precipPos) * cloudFactor * coldFactor * iceFactor), 12, 2200, 30);
      }

      return {
        reset(state) {
          width = state.w;
          height = state.h;
          flakes.length = 0;
          glints.length = 0;
          glintBudget = 0;
          const budget = snowBudget(state);
          for (let index = 0; index < budget; index += 1) flakes.push(makeFlake(state.scheme, false));
        },
        retune(state) {
          width = state.w;
          height = state.h;
          const budget = snowBudget(state);
          while (flakes.length > budget) flakes.pop();
          while (flakes.length < budget) flakes.push(makeFlake(state.scheme, false));
        },
        step(state, dt) {
          width = state.w;
          height = state.h;
          const clock = state.clock;
          // 雪落到屏幕底部才消失
          const floor = height * FLOOR_RATIO;
          for (let index = 0; index < flakes.length; index += 1) {
            const flake = flakes[index];
            const target = windAt(flake.x, flake.y, clock);
            flake.vx += (target - flake.vx) * (1 - Math.exp(-dt / flake.tau));
            flake.vy = flake.vt * (1 + 0.12 * Math.sin(clock * 0.6 + flake.phase));
            flake.rot += flake.rotSpeed * dt;
            const prevY = flake.y;
            flake.y += flake.vy * flake.k * dt;
            flake.x += flake.vx * flake.k * dt + Math.sin(clock * 0.9 + flake.phase) * 4 * dt;
            if (prevY <= floor && flake.y > floor) { seedFlake(flake, state.scheme, true); continue; }
            if (flake.y - 30 > height) { seedFlake(flake, state.scheme, true); continue; }
            if (flake.x < -16) flake.x = width + 14;
            else if (flake.x > width + 16) flake.x = -14;
          }
          for (let index = glints.length - 1; index >= 0; index -= 1) {
            glints[index].life -= dt;
            if (glints[index].life <= 0) glints.splice(index, 1);
          }
          glintBudget += dt * 2.2;
          while (glintBudget >= 1) {
            glintBudget -= 1;
            const candidates = flakes.filter((flake) => flake.twinkle);
            if (!candidates.length) break;
            const flake = candidates[Math.floor(Math.random() * candidates.length)];
            glints.push({ flake, r: random(3, 7), life: random(0.4, 1.0), max: 1.0 });
          }
        },
        draw(g, state) {
          const rgb = SNOW_RGB[state.scheme] || SNOW_RGB.light;
          const png = state.scheme === "dark" ? sprites.flakeLight : sprites.flakeDark;
          for (const flake of flakes) {
            const size = flake.r * (flake.type === 0 ? 2.6 : 2.0) + 1.5;
            g.save();
            g.translate(flake.x, flake.y);
            g.globalAlpha = flake.alpha;
            g.drawImage(png, -size / 2, -size / 2, size, size);
            if (flake.type === 0 && flake.r > 1.5) {
              g.rotate(flake.rot);
              g.globalAlpha = flake.alpha * 0.85;
              g.strokeStyle = rgba(rgb, 0.9);
              g.lineWidth = Math.max(0.5, flake.r * 0.16);
              g.beginPath();
              const arm = flake.r * 1.35;
              for (let spoke = 0; spoke < 3; spoke += 1) {
                const angle = (Math.PI / 3) * spoke;
                g.moveTo(-Math.cos(angle) * arm, -Math.sin(angle) * arm);
                g.lineTo(Math.cos(angle) * arm, Math.sin(angle) * arm);
              }
              g.stroke();
            }
            g.restore();
          }
          g.globalAlpha = 1;
          for (const glint of glints) {
            const t = clamp(glint.life / glint.max, 0, 1, 1);
            const fade = Math.sin(Math.PI * t);
            const x = glint.flake.x;
            const y = glint.flake.y;
            const r = glint.r * (1.25 - 0.25 * t);
            g.strokeStyle = rgba(rgb, 0.75 * fade);
            g.lineWidth = 0.8;
            g.beginPath();
            g.moveTo(x - r, y);
            g.lineTo(x + r, y);
            g.moveTo(x, y - r);
            g.lineTo(x, y + r);
            g.stroke();
          }
        },
      };
    }

    function createWeatherEngine(layer) {
      const doc = layer.ownerDocument || document;
      // 闪电需要往 WebGL 层推状态，这里直接取 window。
      // 不能用外层 apply() 里的 win —— 那个变量在这个作用域看不到，引用会抛 ReferenceError。
      const win = (doc.defaultView || window);
      // 雨势变化的通知口：外层（pushSun）注册，天气引擎在雨势重算后喊一声。
      // 这样雨雪不再只是「被云牵」，它自己也成了驱动光的状态源。
      let onDownpour = null;

      const mist = doc.createElement("div");
      mist.className = "oss-mist";
      const canvas = doc.createElement("canvas");
      canvas.className = "oss-canvas";
      canvas.setAttribute("aria-hidden", "true");
      const flash = doc.createElement("div");
      flash.className = "oss-flash";
      layer.append(mist, canvas, flash);

      const g = canvas.getContext("2d", { alpha: true });
      const sprites = {
        flakeLight: glowSprite([236, 246, 255], 0.45),
        flakeDark: glowSprite([120, 150, 184], 0.45),
      };

      const state = {
        scene: "rain",
        // 雨和雪各自的强度滑杆位置 0..100（连续），densityAt() 换成密度系数。
        // 降水强度 0..100（雨和雪共用）。下的是雨还是雪由温度定，
        // 所以不再需要两条滑杆 —— 那两条会同时下雨下雪。
        // 0 表示不下；>0 时雨/雪层的目标密度由 densityAt 换算。
        precipPos: 50,
        scheme: "light",
        w: 1, h: 1, dpr: 1,
        clock: 0,
        dt: 1 / 60,
        lightning: false,
        // 闪电频率：0..100，由 scheduleStrike 换算成间隔
        lightningFreq: 50,
        // 闪电数量：1..5，单次闪击并联几道主干
        lightningCount: 1,
        // 云量 0..1，由引擎的 __ossCloud() 每帧读回来给雨量用。
        // 初始给 1（有云），拿不到引擎时雨量按满算，不会突然变稀。
        cloudMask: 1,
        // 驱动层给的两个效果读入（每拍由 drivePushEffects 写入）：
        //   pressureDrop 0..1 —— 气压降得越急，雨越密
        //   temperature  0..1 —— 温度越低，雪越容易积
        //   vaporPrecip  0..1 —— 水汽模块算出的降水率（云滴长大落地）
        //   snowDrop     0..1 —— 水汽模块算出的冰晶量（固态）
        pressureDrop: 0,
        temperature: 0.5,
        vaporPrecip: 0,
        snowDrop: 0,
        // 上升气流 0..1：气压降的时空变化率（max(0, -dP/dt)）。
        // 给雷定放电密度 —— 有上升气流才叫雷暴，只有雨叫下雨。
        updraft: 0,
        // 雾的几何基准（屏幕 uv，0 = 顶，1 = 底）：
        //   horizonUV  海平线高度，雾层从它往下铺
        //   cloudBase  云底高度，雾的上边界不越过它
        // 由半秒节拍从 __ossState() 同步；拿不到就用默认值退化。
        horizonUV: 0.5,
        // 雾的目标强度（0..1），由 setFog 写入；雾场景自己负责淡入淡出
        fogTarget: 0,
        cloudBase: -1,
      };

      // 雾图层已移除。scenes 里不再有 fog 项，setScene 收到 "fog" 会落到 null 分支。
      const scenes = {
        rain: createRainScene(sprites),
        snow: createSnowScene(sprites),
      };

      let current = null;
      let running = false;
      let frame = 0;
      let lastTime = 0;
      // 云量读取节流计数：每 30 帧读一次引擎云量并重调雨量
      let cloudTick = 0;
      let strikeTimer = 0;
      let bolt = null;

      // 注意：这不是雾模块，别误删。
      // 它是「雨/雪天整个画面压一层淡雾」的降水氛围层，跟随 current 的场景
      // （rain / snow）而不是雾滑杆；雾滑杆控的是独立的雾图层，那套已经移除。
      function paintMist() {
        let top;
        if (state.scene === "snow") {
          top = state.scheme === "dark" ? "rgba(150, 185, 220, 0.14)" : "rgba(226, 238, 250, 0.55)";
        } else if (state.scene === "rain") {
          top = state.scheme === "dark" ? "rgba(104, 152, 196, 0.14)" : "rgba(206, 228, 247, 0.35)";
        } else {
          top = "rgba(0, 0, 0, 0)";
        }
        mist.style.setProperty("--oss-mist-top", top);
        mist.style.background = "radial-gradient(150% 78% at 50% -20%, var(--oss-mist-top), transparent 74%)";
      }

      function resize() {
        const width = Math.max(1, window.innerWidth || doc.documentElement.clientWidth || 1);
        const height = Math.max(1, window.innerHeight || doc.documentElement.clientHeight || 1);
        const dpr = clamp(window.devicePixelRatio || 1, 1, 2, 1);
        state.w = width;
        state.h = height;
        state.dpr = dpr;
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
        canvas.style.width = width + "px";
        canvas.style.height = height + "px";
        if (g) g.setTransform(dpr, 0, 0, dpr, 0, 0);
        bolt = null;
        if (current) current.reset(state);
      }

      function handleResize() {
        resize();
        if (!running) start();
      }

      function renderOnce() {
        // 这层 Canvas 现在只画雨、雪和闪电。雾图层已移除。
        paintMist();
        if (!g) return;
        g.clearRect(0, 0, state.w, state.h);
        if (current) current.draw(g, state);
        drawStrike(g);
      }

      function tick(now) {
        if (!running) return;
        const elapsed = lastTime === 0 ? 16 : Math.min(64, now - lastTime);
        lastTime = now;
        const dt = elapsed / 1000;
        state.dt = dt;
        state.clock += dt;
        // 每帧让风的缓存失效一次，雨雪的 gust/baseWind 在本帧只向引擎问一次
        windTick += 1;
        // 从引擎读当前云量，雨量跟着云走（云散雨小、云满雨密）。
        // 云量缓动得慢，所以每 30 帧（约半秒）读一次并重新调雨量就够了。
        cloudTick += 1;
        if (cloudTick >= 30) {
          cloudTick = 0;
          if (typeof win.__ossCloud === "function") {
            try {
              const c = win.__ossCloud();
              if (c && typeof c.mask === "number") state.cloudMask = c.mask;
            } catch (error) { /* 引擎还没起来，保持上一次的值 */ }
          }
          // 雾的几何基准：海平线与云底（屏幕 uv）。半秒同步一次就够，
          // 相机是固定的，这两个值几乎不变；换分辨率 / 改 FOV 时会跟着更新。
          if (typeof win.__ossState === "function") {
            try {
              const s = win.__ossState();
              if (s && Number.isFinite(s.horizonUV)) state.horizonUV = s.horizonUV;
              if (s && Number.isFinite(s.cloudBase)) state.cloudBase = s.cloudBase;
            } catch (error) { /* 拿不到就用上一次的 */ }
          }
          if (current && typeof current.retune === "function") current.retune(state);
          // 雨反哺光：云量刚重调过雨量，雨势也变了 —— 把新的雨势推给光模块。
          // 挂在同一个半秒节拍上，既跟得上云的变化，又不会每帧都推 uniform。
          if (onDownpour) onDownpour();
        }
        if (current) current.step(state, dt);
        // 即使没有雨雪层（current 为 null），雾也要画 —— 它是独立图层。
        renderOnce();
        frame = window.requestAnimationFrame(tick);
      }

      function start() {
        // 只有一个 current 判断会让「不下雨时循环整个停掉」，雾就永远画不出来。
        // 条件改成：有雨雪层 或 有雾量，都要跑。
        if (running) return;
        if (!current && !(state.fogTarget > 0.01)) return;
        running = true;
        lastTime = 0;
        frame = window.requestAnimationFrame(tick);
        scheduleStrike();
      }

      function stop() {
        running = false;
        if (frame) window.cancelAnimationFrame(frame);
        frame = 0;
        // 这里绝对不碰 strikeTimer。
        // stop() 会被 setIntensity 在每次拖强度、每次 paint 里反复调用，
        // 只要在这里清桩，刚排上的闪电就永远等不到触发 —— 这就是「开关能点、从不闪」的病根之一。
        // 闪电的桩只由 clearStrike（切场景/关插件）和 scheduleStrike 自己来管。
        if (g) g.clearRect(0, 0, state.w, state.h);
        // 主循环停了，但闪电还在：交给补帧把它画完并淡出。
        if (bolt) pumpStrike();
      }

      function makeBoltPath(x0, y0, x1, y1) {
        let pts = [{ x: x0, y: y0 }, { x: x1, y: y1 }];
        for (let pass = 0; pass < 6; pass += 1) {
          const next = [pts[0]];
          for (let i = 1; i < pts.length; i += 1) {
            const p0 = pts[i - 1];
            const p1 = pts[i];
            const dx = p1.x - p0.x;
            const dy = p1.y - p0.y;
            const len = Math.hypot(dx, dy) || 1;
            const off = (Math.random() - 0.5) * len * 0.45;
            next.push({ x: (p0.x + p1.x) / 2 - (dy / len) * off, y: (p0.y + p1.y) / 2 + (dx / len) * off }, p1);
          }
          pts = next;
        }
        return pts;
      }

      // 闪电改为在 WebGL 里画（引擎的 boltPass）。
      // 这里不再往 2D canvas 上描线，只把「当前这一刻的闪电状态」推过去：
      //   · 路径点从 canvas 像素换算成屏幕 uv（0..1，y 向上）
      //   · 全屏闪光强度由剩余寿命算出
      // 好处：闪电和太阳光效同一条管线、同一套加法混合，能真正照亮天空和海面。
      function drawStrike(c) {
        const now = state.clock;
        if (!bolt) {
          if (typeof win.__ossBoltSet === "function") win.__ossBoltSet(null);
          return;
        }
        const t = (now - bolt.born) / bolt.life;
        if (t >= 1) {
          bolt = null;
          if (typeof win.__ossBoltSet === "function") win.__ossBoltSet(null);
          return;
        }
        // 亮度：回击（re-strike）。
        // 真实闪电在 0.1~0.2 秒内沿同一路径反复闪 2~4 次，不是一条平滑淡出的线。
        // 原来 a=(1-t)² 是单调衰减，看起来就是"亮一下然后慢慢暗下去"。
        // 现在把一个 life 切成 N 段，每段开头是一个尖峰、段内快速衰减：
        //   · 第一段最强（首次回击），后续递减
        //   · 段与段之间不完全归零（连续电流阶段有残余辉光）
        // 不改任何着色器，纯客户端调亮度曲线。
        const RESTRIKES = 3;
        const seg = t * RESTRIKES;                 // 0..RESTRIKES
        const segIdx = Math.min(RESTRIKES - 1, Math.floor(seg));
        const inSeg = seg - segIdx;                // 段内进度 0..1
        // 衰减放慢：首次 1.0，之后 0.75 / 0.56 —— 后两次回击要看得见，
        // 早先 0.62^n 配上 exp(-7x) 衰减，第二三次只剩不到 0.1，等于没闪。
        const peak = Math.pow(0.75, segIdx);
        const spike = Math.exp(-inSeg * 4.5);      // 段内快速衰减
        const tail = 0.12 * (1 - t);               // 连续电流的残余
        const a = Math.min(1, peak * spike + tail);

        // 路径同时推给 WebGL（引擎的 boltPass）。
        // 注意：下方的 2D 兜底已停用（见本函数末尾的说明），
        // 引擎那边如果没接上或已停用，闪电将不可见，需要先解开那段注释再排查。
        // 配色/线宽/透明度都照 2D 原版（无云版）搬过来，WebGL 层和 2D 兜底看起来是同一道闪电：
        //   主干  196,226,255 @ 2.4px，辉光 120,176,246 @ 5.4px，分支 186,218,255 @ 1.0px
        // 数量：mains 有 N 道主干就推 N 组「主干 + 辉光」，分支统一走一层。
        const toUV = (p) => [p.x / (state.w || 1), 1 - p.y / (state.h || 1)];
        if (typeof win.__ossBoltSet === "function") {
          const segments = [];
          // Distant bolts are thinner on screen. Distance is judged by how far
          // down the frame the strike sits, which `close` already encodes.
          const wScale = bolt.close ? 1.0 : 0.45;
          // 线宽单位是屏幕 uv，实际像素 = width × 屏幕宽（1080p 下 0.001 ≈ 1.9px）。
          // 原来 0.0022/0.005 在 1080p 上分别是 4.2px/9.6px，比真实闪电粗一倍，
          // 看着像一根白管子而不是电弧。收到 0.0012/0.0028（≈2.3px/5.4px）。
          for (const main of bolt.mains) {
            const uv = main.map(toUV);
            segments.push({ pts: uv, width: 0.0012 * wScale, intensity: 0.9 * a, color: [196 / 255, 226 / 255, 1] });
            segments.push({ pts: uv, width: 0.0028 * wScale, intensity: 0.30 * a, color: [120 / 255, 176 / 255, 246 / 255] });
          }
          for (const branch of bolt.branches) {
            segments.push({ pts: branch.map(toUV), width: 0.0006 * wScale, intensity: 0.70 * a, color: [186 / 255, 218 / 255, 1] });
          }
          const anchor = bolt.mains[0];
          win.__ossBoltSet({
            segments,
            flash: 0.55 * a,
            origin: toUV(anchor[Math.floor(anchor.length * 0.2)] || anchor[0]),
          });
        }

        // ------------------------------------------------------------------
        // 【已停用】2D 兜底绘制
        // 原逻辑：WebGL 闪电不可用时（__ossBoltActive 为 false），退回 2D canvas
        // 描线，至少还能看见闪电。闪电改用 WebGL boltPass 渲染后，这条路已经
        // 正常出画面，`__ossBoltActive` 恒为 true，所以下面整块永远走不进去，
        // 属于「活着但不起作用」的分支 —— 留着会让人误以为它仍在参与渲染。
        // 故整体注释掉，但代码原样保留：闪电模块若再次退回 2D（比如排查渲染
        // 问题时临时把引擎的 LIGHTNING_ENABLED 关掉），可以直接解开复用。
        // 彻底删除的时机：闪电模块稳定运行一段时间（建议跨若干次重启验证，
        // 且 WebGL 初始化失败的日志 `[shader_fail]` / `[init] bolt pass failed`
        // 再也没有出现过）之后，再整块删掉。
        // ------------------------------------------------------------------
        // if (!win.__ossBoltActive && c) {
        //   c.save();
        //   c.globalCompositeOperation = "lighter";
        //   c.lineCap = "round";
        //   for (const main of bolt.mains) {
        //     c.strokeStyle = rgba([196, 226, 255], 0.9 * a);
        //     c.lineWidth = 2.4;
        //     c.beginPath();
        //     c.moveTo(main[0].x, main[0].y);
        //     for (let i = 1; i < main.length; i += 1) c.lineTo(main[i].x, main[i].y);
        //     c.stroke();
        //     c.strokeStyle = rgba([120, 176, 246], 0.32 * a);
        //     c.lineWidth = 5.4;
        //     c.stroke();
        //   }
        //   for (const branch of bolt.branches) {
        //     c.strokeStyle = rgba([186, 218, 255], 0.75 * a);
        //     c.lineWidth = 1;
        //     c.beginPath();
        //     c.moveTo(branch[0].x, branch[0].y);
        //     for (let i = 1; i < branch.length; i += 1) c.lineTo(branch[i].x, branch[i].y);
        //     c.stroke();
        //   }
        //   c.restore();
        // }
      }

      function clearStrike() {
        bolt = null;
        if (strikeTimer) window.clearTimeout(strikeTimer);
        strikeTimer = 0;
        // 告诉 WebGL 层当前没有闪电，避免残留
        if (typeof win.__ossBoltSet === "function") win.__ossBoltSet(null);
      }

      // 闪电自己的补帧：只在主循环（running）没跑的时候接管，闪电画完就交还。
      // clock 在这里推进，drawStrike 才能算出淡出进度。
      let strikeFrame = 0;
      let strikeLast = 0;
      function pumpStrike() {
        if (running) return;            // 主循环在跑，不用管
        if (strikeFrame) return;        // 已经在补了
        strikeLast = 0;
        const step = (now) => {
          strikeFrame = 0;
          if (running || !current) return;
          const dt = strikeLast === 0 ? 0.016 : Math.min(0.05, (now - strikeLast) / 1000);
          strikeLast = now;
          state.dt = dt;
          state.clock += dt;
          renderOnce();
          if (bolt) strikeFrame = window.requestAnimationFrame(step);
        };
        strikeFrame = window.requestAnimationFrame(step);
      }

      // 强制重排：先撤掉已有桩，再按当前条件重新排。
      // 只在「条件真的变了」时调（开关翻转、切场景、销毁），
      // 日常的 paint() 走 scheduleStrike（它不会重置已排好的桩）。
      function rescStrike() {
        if (strikeTimer) window.clearTimeout(strikeTimer);
        strikeTimer = 0;
        scheduleStrike();
      }

      function scheduleStrike() {
        // 【关键：已有排期就不要重置】
        // 原来这里无条件 clearTimeout 再重排。而 setIntensity 在每次 paint() 里都会调，
        // paint 每 2 秒左右来一次，闪电间隔却是 5~25 秒 ——
        // 于是定时器永远在「排上 → 被清掉 → 重排」之间循环，一次都等不到触发。
        // 这就是「拉满频率也看不到闪电」的真正原因（不是间隔太长）。
        // 现在：只要已经有一个有效的桩在等，就不动它；只有条件变了才重排。
        if (strikeTimer) return;
        // 闪电只依赖三件事：开关、场景是雨、动画循环活着。
        // 不再依赖 running —— running 会被强度为 0 / 减少动效偏好关掉，
        // 那样闪电会永久静默。这里改成看 current 是否已经建好。
        if (!state.lightning || state.scene !== "rain" || !current) return;
        // 间隔：最短 5 秒，最长约 25 秒（强度满时）。
        // 用 Math.pow(rand,2) 把分布往短的一侧压，形成「隔几秒一闪、偶尔停久一点」的雷雨节奏。
        // 强度越高整体越快（大雨天雷更密），但不会低于 5 秒。
        // 间隔 = 频率系数 × 强度系数。
        //   freq 0   → 最慢，约 60 秒一次
        //   freq 50  → 默认，约 5~25 秒
        //   freq 100 → 最密，约 1.5~8 秒
        // 强度越高整体越快（大雨天雷更密）。
        const freq = Math.max(0, Math.min(100, state.lightningFreq || 50)) / 100;
        const freqFactor = freq < 0.5
          ? lerpNumber(12, 1, freq * 2)      // 0..0.5 → 12x..1x
          : lerpNumber(1, 0.3, (freq - 0.5) * 2); // 0.5..1 → 1x..0.3x
        // 强度越高整体越快（大雨天雷更密）。用当前场景自己那条强度：
        // 下雪时的闪电频率跟着雪量走，下雪时的雷本来也少。
        const ownPos = state.precipPos;
        const densityFactor = 0.55 + 0.35 * (densityAt(ownPos) / 1.75);
        // 驱动层：上升气流越强，雷打得越密（up 0..1 → 间隔 ×1.6..×0.45）。
        // 上升气流是「空气被抬起来」的强度，雷暴的本质就是它 —— 只有雨没有上升气流，
        // 按感知叫「下雨」；有上升气流才叫「打雷」。这条把两者接上了。
        const up = typeof state.updraft === "number" ? Math.max(0, Math.min(1, state.updraft)) : 0;
        const upFactor = 1.6 - up * 1.15;
        const gap = (5000 + Math.pow(Math.random(), 2) * 20000 / densityFactor) * freqFactor * upFactor;
        strikeTimer = window.setTimeout(() => {
          strikeTimer = 0;
          if (!state.lightning || state.scene !== "rain" || !current) return;
          // 数量：单次闪击并联几道主干（1..5）。
          const count = Math.max(1, Math.min(5, Math.round(state.lightningCount || 1)));
          const close = Math.random() < 0.45;
          const anchorX = state.w * random(0.12, 0.88);
          // 生命期要覆盖 3 次回击：每次约 0.09~0.13 秒，总计 0.30~0.42 秒。
          // 原来 0.2~0.32 秒塞 3 次回击太挤，看起来会像"抖了一下"而不是多次闪击。
          const lifeSec = random(0.30, 0.42);
          // 分布模式：每次闪击随机决定「聚在一起」还是「散开」。
          //   聚 → 几道挤在一小片天里，像一次雷劈下几股
          //   散 → 按三个节点铺开，一会儿一束一束地劈，不扎堆
          const spread = count > 1 && Math.random() < 0.62;
          // 散开用的落点槽位：左、中、右三个主节点（0.20 / 0.50 / 0.80），
          // 第 4、5 道落在相邻两点之间（0.35 / 0.65），五点均匀铺开，
          // 而不是像取模那样挤回左边。
          const SPREAD_SLOTS = [0.20, 0.50, 0.80, 0.35, 0.65];
          // `close` is remembered so the draw pass can scale line width: a
          // distant bolt must be thinner on screen, not just lower in frame.
          bolt = { mains: [], branches: [], born: state.clock, life: lifeSec, close };
          for (let m = 0; m < count; m += 1) {
            let bx;
            if (spread) {
              // 散开：按均匀槽位落点，再叠一点抖动，避免看起来像复制粘贴。
              const slot = SPREAD_SLOTS[m % SPREAD_SLOTS.length];
              bx = state.w * (slot + random(-0.05, 0.05));
            } else {
              // 聚合：围绕同一个锚点挤在一起
              bx = count === 1 ? anchorX : anchorX + (m - (count - 1) / 2) * state.w * 0.06;
            }
            // 兜底：别让闪电飞出屏幕边缘
            bx = Math.max(state.w * 0.08, Math.min(state.w * 0.92, bx));
            // Vertical placement decides whether the bolt reads as far away or
            // close. The horizon sits around 30-35% down the frame (camera at
            // y=5.5 looking at y=1.5), so anything whose top starts at 13%
            // looks like it is happening right overhead.
            //
            // 【远处闪电必须从「云」里出来，不能悬在空天里】
            // 云层由 shader 的 band 决定：band = smoothstep(0.015, 0.10, d.y) * ...
            // d.y 是仰角正弦。按相机（eye 5.5 / target 1.5 / FOV 55°）换算到屏幕：
            //   band=0.01 (d.y=0.020) -> 距顶 29.4%   云刚出现，几乎不可见
            //   band=0.54 (d.y=0.060) -> 距顶 33.4%   云明显可见
            //   band=1.00 (d.y=0.100) -> 距顶 37.4%   云最浓
            // 原来远处起点写 0.28~0.36，最低的那一截在 29% 附近，
            // 比云真正可见处还高，所以看起来像"从屏幕中间的空气里打出来"。
            // 现在按 band 反算落点：起点取 33%~38%，落点仍贴着海平线下方。
            //   far  : 云底（33~38%）打到海平线（40~46%）
            //   close: 云顶（8~14%）打到画面下方（55~78%）
            // 【落点绝不能进到海面上】
            // 按相机（eye 5.5 / target 1.5 / FOV 55°）算，海平线固定在屏幕距顶 27.4%，
            // 低于这条线的全部是海面。闪电是天空里的放电，终点必须在海平线之上，
            // 或者最多贴着它（远处雷击落在海平线附近，看起来像"远处海面上方"）。
            // 原来近处落点写 55%~78%、远处写 40%~46% —— 全都在海面里，
            // 等于闪电直接扎进水里，这就是"在海面上闪"的来源。
            //
            // 新的落点规则（全部 ≤ 27%）：
            //   远雷：起点 15~18%（云底），终点 24~27%（贴着海平线）
            //   近雷：起点 6~10%（云顶近处），终点 18~24%（海平线上方，更靠下更近）
            const HORIZON = 0.274;
            const startY = state.h * (close
              ? random(0.06, 0.10)
              : random(0.15, 0.18));
            const iy = state.h * (close
              ? random(0.18, HORIZON - 0.005)
              : random(0.24, HORIZON - 0.003));
            // Far bolts are also narrower on screen. Scaling the x offset
            // towards the anchor compresses them without touching the shader.
            const ix = close
              ? state.w * random(0.24, 0.76)
              : bx + random(-40, 40);
            const main = makeBoltPath(bx, startY, ix, iy);
            bolt.mains.push(main);
            // 分支：真实的枝状闪电是【多级树】，主干上每隔一段岔一根，分支还能再分。
            // 原来只有 1~2 根、且只岔一次，看起来就是"一根线加两根小刺"。
            // 现在按主干长度撒 3~6 根一级分支（每根长度随机 0.10~0.34 主干长），
            // 再让其中约一半各自再生一根短小的二级分支（长度再乘 0.45）。
            // 全部复用 makeBoltPath，形状风格一致。
            const growBranch = (base, at, len, level) => {
              const dir = Math.random() < 0.5 ? -1 : 1;
              // 分支方向偏"向下斜"，符合电荷从云底向地面扩散的感觉
              const tipX = at.x + dir * len * random(0.35, 0.75);
              const tipY = at.y + len * random(0.55, 1.0);
              const path = makeBoltPath(at.x, at.y, tipX, tipY);
              bolt.branches.push(path);
              if (level <= 1) return;
              // 二级分叉：从这根分支的中段再岔一小根
              const sub = path[Math.floor(path.length * random(0.35, 0.65))];
              growBranch(sub, sub, len * 0.45, level - 1);
            };
            const mainLen = Math.hypot(ix - bx, iy - startY);
            const branchCount = 3 + Math.floor(Math.random() * 4);   // 3~6 根
            for (let i = 0; i < branchCount; i += 1) {
              // 沿主干不均匀撒点：越靠上（云底）越密，越靠下越疏
              const pos = Math.pow(Math.random(), 1.6) * 0.75 + 0.05;
              const at = main[Math.floor(main.length * pos)];
              growBranch(main, at, mainLen * random(0.10, 0.34), 2);
            }
          }
          // 全屏闪光的中心跟着第一道走（散开时取三道的中点，光更均匀）
          const flashX = spread && bolt.mains.length > 1
            ? bolt.mains.reduce((sum, m) => sum + m[0].x, 0) / bolt.mains.length
            : anchorX;
          flash.style.setProperty("--oss-flash-x", ((flashX / state.w) * 100).toFixed(1) + "%");
          flash.style.setProperty("--oss-peak", close ? "0.95" : "0.6");
          // CSS 白闪时长 = 本次寿命 × 2.2，最短 300ms，最长 900ms。
          // 之前写死 1100ms，不管闪电多短都白一整秒，看起来就像「停留时间固定」。
          const flashMs = Math.round(Math.min(900, Math.max(300, lifeSec * 2200)));
          flash.style.setProperty("--oss-flash-ms", flashMs + "ms");
          // 重启动画：先摘标记，强制一次回流，再挂回去
          delete flash.dataset.flashing;
          void flash.offsetWidth;
          flash.dataset.flashing = "true";
          window.setTimeout(() => { if (flash.dataset) delete flash.dataset.flashing; }, flashMs + 60);
          // 闪电的寿命靠 state.clock 推进，而 clock 只在 tick（running）里走。
          // 强度被关掉或系统开了减少动效时 running 为假，这里必须自己补帧，
          // 否则闪电生成了也没有人画它、更不会淡出。
          pumpStrike();
          scheduleStrike();
        }, gap);
      }

      const onResize = () => { handleResize(); };
      window.addEventListener("resize", onResize);
      resize();
      paintMist();

      return {
        setScene(scene) {
          const next = scene === "none" ? "none" : scene;
          const target = next === "none" ? null : scenes[next];
          if (next === state.scene && target === current) return;
          clearStrike();
          state.scene = next;
          current = target;
          paintMist();
          if (!current) {
            stop();
            return;
          }
          current.reset(state);
          // 只有雨雪两种场景，强度滑杆为 0 时没必要跑 rAF。
          if (state.intensity > 0) start();
        },
        // 降水强度 0..100（雨雪共用一条）。下的是雨还是雪由温度决定，
        // 所以这里只有一个参数。0 表示不下。
        setIntensity(precipPosArg) {
          const nextPos = clamp(Number(precipPosArg) || 0, 0, 100, 50);
          // 旧代码的 0 表示「停」，这里沿用：强度 0 = 不画降水层
          const next = nextPos <= 0 ? 0 : nextPos <= 30 ? 1 : nextPos <= 70 ? 2 : 3;
          const changed = next !== state.intensity || nextPos !== state.precipPos;
          state.intensity = next;
          state.precipPos = nextPos;
          if (!current) return;
          if (!changed && running) {
            // 强度没变、引擎又在跑 —— 以前这里直接 return，导致下面那句
            // scheduleStrike() 永远走不到。而 paint() 每次都走这条路，
            // 于是闪电的桩从来没被重新排上过。先排桩再退出。
            scheduleStrike();
            return;
          }
          if (typeof current.retune === "function") current.retune(state);
          else current.reset(state);
          stop();
          // 强度为 0 就没有降水层，画一帧静态的即可，不必跑 rAF。
          if (next > 0) start();
          else renderOnce();
          // paint() 里本函数的调用排在 setLightning 之后，stop()/start() 可能把
          // 闪电的桩冲掉，这里必须再排一次，否则开着闪电的常规流程也永远不闪。
          scheduleStrike();
        },
        setScheme(scheme) {
          state.scheme = scheme === "dark" ? "dark" : "light";
          paintMist();
          if (!running) renderOnce();
        },
        setLightning(on) {
          const next = !!on;
          // 同样：值没变就不能重排，否则 paint() 每次调用都会把桩清掉重来
          if (next === state.lightning) return;
          state.lightning = next;
          if (state.lightning && current && !running && state.intensity > 0) start();
          // 开关变了必须重排：关掉要立刻撤桩，打开要立刻排新桩
          rescStrike();
        },
        // 闪电频率 0..100。改了立刻重排，不用等当前那一发走完。
        // 闪电频率 0..100。只在值真的变了时才重排 ——
        // 这个函数会被 paint() 每次调用（主题变化/任何设置改动/初始化），
        // 无条件调 scheduleStrike 会把已排好的桩反复清掉，
        // 一旦 paint 频率高于闪电间隔，闪电就永远等不到触发。
        setLightningFreq(freq) {
          const next = clamp(Number(freq) || 0, 0, 100, 50);
          if (next === state.lightningFreq) return;
          state.lightningFreq = next;
          scheduleStrike();
        },
        // 闪电数量 1..5。只影响下一次闪击，不用重排、不打断当前这一发。
        setLightningCount(count) {
          const next = Math.round(clamp(Number(count) || 1, 1, 5, 1));
          if (next === state.lightningCount) return;
          state.lightningCount = next;
        },
        // 驱动层每拍推一次：雨读气压降+水汽降水率，雪读温度+冰晶量，雷读上升气流。
        // 只写 state 字段，不触发任何重排 —— 下一帧 rainBudget/snowBudget 自会读到。
        setDrive(drop, temperature, vaporPrecip, snowDrop, updraft, surface) {
          if (Number.isFinite(drop)) state.pressureDrop = Math.max(0, Math.min(1, drop));
          if (Number.isFinite(temperature)) state.temperature = Math.max(0, Math.min(1, temperature));
          if (Number.isFinite(vaporPrecip)) state.vaporPrecip = Math.max(0, Math.min(1, vaporPrecip));
          if (Number.isFinite(snowDrop)) state.snowDrop = Math.max(0, Math.min(1, snowDrop));
          if (Number.isFinite(updraft)) state.updraft = Math.max(0, Math.min(1, updraft));
          // 地形表面类型：海面溅射 / 沙地渗 / 森林滴
          if (typeof surface === "string" && surface in SURFACE) surfaceMode = SURFACE[surface];
        },
        // 雾强度目标（0..1）。雾图层已移除，这里只记录目标值，
        // 保留接口是为了让驱动层不必改调用 —— 将来接回雾时直接在这里恢复绘制。
        setFog(value) {
          const v = Number(value);
          if (!Number.isFinite(v)) return;
          state.fogTarget = Math.max(0, Math.min(1, v));
        },
        // 侦契：雾的当前状态（只读）。无雾图层，恒为 null。
        getFogDebug() {
          return null;
        },
        // 当前雨势 0..1，由 rainBudget 每帧归一化写入。
        // 光模块（pushSun）读它做「雨幕柔化」——雨雪至此也成了状态源，不再只被云牵。
        getDownpour() {
          return state.downpour || 0;
        },
        // 注册「雨势变了」的回调。天气引擎每次重算雨量后调用一次。
        onDownpour(cb) {
          onDownpour = typeof cb === "function" ? cb : null;
        },
        renderOnce() { renderOnce(); },
        dispose() {
          // 先把闪电的补帧和桩彻底停掉，再拆 DOM，避免关插件后 rAF 还在跑。
          if (strikeFrame) window.cancelAnimationFrame(strikeFrame);
          strikeFrame = 0;
          clearStrike();
          stop();
          window.removeEventListener("resize", onResize);
          mist.remove();
          canvas.remove();
          flash.remove();
        },
      };
    }

    // ------------------------------------------------------------- copy/text

    // ---- COPY 收成一份
    const COPY_KEYS = [
      "title", "close", "ocean", "weather",
      "enable", "sea", "time", "autoCycle", "timeScale",
      "seaVisible",
      "glass", "temp", "humid", "fogLevel",
      "wallpaperMode", "evolveMode", "freezeHint", "stateDry", "stateNeed", "stateRain", "stateSnow", "stateSaturated",
      "lightning", "lightningFreq", "lightningCount",
      "lightningRainOnly",
      "hint", "reset", "saveDefault",
      "cloud", "cloudEnable", "cloudAmount", "cloudDensity", "cloudUnite", "cloudOpacity", "cloudWind", "cloudAuto",
      "sun", "sunEnable", "sunGlow", "moonBright", "sunGlowRadius", "starBright",
      "ground", "groundVisible", "groundDensity", "flowerDensity", "snowCover", "wetness",
      "debug", "otherTerrain",
    ];

    const COPY_TEXT = {
      zh: [
        "天气演化沙盒", "关闭", "海洋", "天气",
        "启用海洋与玻璃", "波浪大小", "天体位置", "自动昼夜", "时间流逝",
        "显示海面",
        "玻璃不透明度", "温度", "湿度", "雾量",
        "壁纸与交互", "纯自演化", "< 0°C 下雪 · > 0°C 下雨", "未饱和", "还差", "雨", "雪", "已饱和",
        "闪电", "闪电频率", "闪电数量",
        "闪电只在雨里出现",
        "v", "恢复默认", "设为默认",
        "云", "显示云", "云量", "凝聚度", "团结度", "透明度", "风速", "云自动",
        "光", "太阳光效", "太阳亮度", "月亮亮度", "光晕半径", "星星亮度",
        "草地", "显示草地", "草地密度", "花密度", "积雪", "积水",
        "调试模式", "其他地形",
      ],
      en: [
        "Weather Evolution Sandbox", "Close", "Ocean", "Weather",
        "Ocean and glass", "Sea state", "Celestial position", "Automatic day cycle", "Time flow",
        "Show sea",
        "Glass opacity", "Temperature", "Humidity", "Fog",
        "Wallpaper & play", "Auto evolve", "< 0°C snow · > 0°C rain", "Not saturated", "need", "Rain", "Snow", "Saturated",
        "Lightning", "Strike rate", "Bolts per strike",
        "Lightning only appears in rain",
        "v", "Reset to saved", "Set as default",
        "Cloud", "Show cloud", "Amount", "Condense", "Unite", "Opacity", "Wind", "Auto cloud",
        "Light", "Sun glow", "Sun brightness", "Moon brightness", "Glow radius", "Star brightness",
        "Grass", "Show grass", "Grass density", "Flower density", "Snow cover", "Puddles",
        "Tuning", "Terrain",
      ],
    };

    function copyObject(lang) {
      const out = {};
      for (let i = 0; i < COPY_KEYS.length; i++) out[COPY_KEYS[i]] = COPY_TEXT[lang][i];
      return out;
    }

    const COPY = { zh: copyObject("zh"), en: copyObject("en") };

    function pickCopy() {
      const lang = String((document.documentElement.getAttribute("lang") || navigator.language || "en")).toLowerCase();
      return lang.indexOf("zh") === 0 ? COPY.zh : COPY.en;
    }









    // ======================================================================
    //  大肥鱼 —— 只做一件事：把当前画面抠成一张带 alpha 的 canvas，交给引擎
    //
    //  引擎那半边（createPetPass）负责画进 3D 场景。这里不管画，只管「给素材」。
    //
    //  三层资源，全都不上屏：
    //    img   —— 立绘来源，本身有 alpha，直接缩进 canvas
    //    video —— 只当解码器（yuv420p 没有透明通道，得逐帧抠黑）
    //    cv    —— 抠好的那一帧，唯一交给 __ossPetTexture 的东西
    //
    //  抠图阈值来自 PET-INTEGRATION.md，别改：背景纯黑占 82%，角色最暗也亮于 25；
    //  取 max(r,g,b) 而不是平均 —— 深蓝头发平均下来会被误判成背景。
    // ======================================================================
    function createPetEntity() {
      const BASE = "/dsh-weather-sandbox/pet/";
      const CUT_LO = 18, CUT_HI = 60;

      const img = document.createElement("img");
      img.src = BASE + "side.png";
      img.alt = "";
      img.style.display = "none";

      const video = document.createElement("video");
      video.muted = true;
      video.loop = true;
      video.playsInline = true;
      video.preload = "auto";
      video.style.cssText = "position:absolute;width:0;height:0;opacity:0;pointer-events:none";

      // 尺寸必须等于素材原尺寸，写死。动态尺寸会和视频对不上、拉伸变形。
      const cv = document.createElement("canvas");
      cv.width = 256;
      cv.height = 144;
      const ctx = cv.getContext("2d", { willReadFrequently: true });

      let clip = null;       // 当前动作名；null = 立绘
      let active = true;     // 主体模块开关
      let raf = 0;
      let dead = false;
      // 把时间流速同步到当前这段视频的播放速度。每帧调用。
      // 【以浏览器里的真实值为准，不自己记缓存】
      // 原来记一个 appliedRate，设过一次就不再重试 —— 但 video.play()、换源、
      // 解码器就绪这些时机都可能把 playbackRate 重置回 1，一旦被重置，
      // 因为缓存里记的还是新值，就再也不会写回去，表现为「有时生效有时不生效」。
      // 现在每次读 video.playbackRate 比较：写失败了下帧自动重试，代价是一次属性读取。
      function syncRate() {
        const ts = typeof window.__ossTimeScale === "function" ? window.__ossTimeScale() : 1;
        const want = Math.max(0.25, Math.min(8, Number.isFinite(ts) && ts > 0 ? ts : 1));
        if (Math.abs(video.playbackRate - want) < 0.01) return;
        try { video.playbackRate = want; } catch (error) { /* 浏览器不接受就下帧再试 */ }
      }

      // ---- 出一帧：把源画进 canvas，再把黑底改成透明，交给引擎 ----
      function frame() {
        if (!ctx || !active || dead) return;
        ctx.clearRect(0, 0, 256, 144);
        if (clip) {
          if (video.readyState < 2) return;               // 还没解出帧
          ctx.drawImage(video, 0, 0, 256, 144);
        } else {
          if (!img.complete || !img.naturalWidth) return;
          // 立绘是竖图，按 contain 缩进 16:9 的框里会留边，所以居中缩放
          const s = Math.min(256 / img.naturalWidth, 144 / img.naturalHeight);
          const w = img.naturalWidth * s, h = img.naturalHeight * s;
          ctx.drawImage(img, (256 - w) / 2, (144 - h) / 2, w, h);
        }

        let data;
        try {
          data = ctx.getImageData(0, 0, 256, 144);
        } catch (error) {
          // 拿不到像素（跨域限制）：立绘本就有 alpha，直接给；视频没法救，跳过
          if (!clip) push();
          return;
        }
        const px = data.data;
        for (let i = 0; i < px.length; i += 4) {
          const m = px[i] > px[i + 1] ? (px[i] > px[i + 2] ? px[i] : px[i + 2])
                                      : (px[i + 1] > px[i + 2] ? px[i + 1] : px[i + 2]);
          px[i + 3] = m < CUT_LO ? 0 : m < CUT_HI ? ((m - CUT_LO) * 255 / (CUT_HI - CUT_LO)) | 0 : 255;
        }
        ctx.putImageData(data, 0, 0);
        push();
      }

      // ---- 交给引擎 ----
      // 宽高比随来源变（立绘 363:420，视频 256:144），引擎靠它决定四边形多宽。
      function push() {
        if (typeof window.__ossPetTexture !== "function") return;
        if (!window.__ossPetTexture(cv)) return;
        const aspect = clip ? 256 / 144 : (img.naturalWidth || 363) / (img.naturalHeight || 420);
        if (typeof window.__ossPetSet === "function") window.__ossPetSet({ aspect });
      }

      // ---- 帧循环：只在播动作时跑。立绘是静态的，出一帧就够 ----
      function tick() {
        if (dead || !clip) { raf = 0; return; }
        raf = requestAnimationFrame(tick);
        syncRate();
        frame();
      }
      function startTick() {
        if (!raf) raf = requestAnimationFrame(tick);
      }
      function stopTick() {
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
      }
      // 唯一的停播路径：清掉动作名、回到立绘、出最后一帧。
      function clear() {
        clip = null;
        stopTick();
        frame();
      }

      // ---- 切一段动作。done 在播完时调用；不传就回立绘 ----
      // opts.loop：播完一遍就回绕（用于「待得久一点」的动作，如撸猫、吹笛子）。
      //   回绕时不触发 done —— 由调度器自己的定时器决定什么时候收。
      function play(name, done, opts) {
        if (dead || !name) return;
        const looped = !!(opts && opts.loop);
        // hold：播完停在最后一帧，什么都不做。
        // 「转过去看风景」要的就是这个 —— 转身那 0.5 秒播完就冻在背面，
        // 不循环（循环会一直转身）、也不回立绘（那会转回来）。
        // 什么时候离开由调用方自己定（调度器挂一个 setTimeout 到点再 next）。
        const holdFrame = !!(opts && opts.hold);
        video.onended = () => {
          video.onended = null;
          if (dead) return;
          if (looped) {
            // 回到开头继续播，不通知调度器（它还不想收）
            video.currentTime = 0;
            video.play().then(() => syncRate()).catch(() => {});
            return;
          }
          if (holdFrame) return;      // 停在最后那一帧，画面不动
          if (typeof done === "function") done();
          else clear();
        };
        video.src = BASE + "clip/" + encodeURIComponent(name) + ".webm";
        video.loop = looped;
        video.currentTime = 0;
        // 时间流速作用到动作本身。倍率的实际写入在 syncRate() 里 ——
        // 那里每帧都会检查，所以播放中拖滑杆也会立刻跟上，不用等这一段播完。
        clip = name;
        syncRate();
        // play() 之后同步一次：部分浏览器会在真正开始播放时把 playbackRate 重置回 1。
        video.play().then(() => {
          syncRate();
          startTick();
        }).catch(() => {
          console.warn("[pet] clip autoplay blocked:", name);
          clear();
        });
      }

      // ---- 等引擎就绪再开工 ----
      // 引擎脚本异步插入，__ossPetTexture 出现前调用会被吞掉。超时 30 秒放弃。
      function boot(onReady) {
        let tries = 0;
        const tick = () => {
          if (dead) return;
          if (typeof window.__ossPetTexture !== "function") {
            if (++tries > 150) return;
            setTimeout(tick, 200);
            return;
          }
          frame();                                  // 先把立绘推过去
          if (typeof onReady === "function") onReady();
        };
        if (img.complete) tick();
        else img.addEventListener("load", tick, { once: true });
        img.addEventListener("error", tick, { once: true });   // 图挂了也别卡住
      }

      return {
        boot,
        play,
        // 朝向：flip = 1 面朝左（side.png 原样），-1 面朝右
        face(dir) {
          if (typeof window.__ossPetSet === "function") window.__ossPetSet({ flip: dir < 0 ? -1 : 1 });
        },
        // 走到 (x, z)，duration 秒内到位。z 是「离相机多少米」，越大越远。
        moveTo(x, z, duration) {
          if (typeof window.__ossPetMove !== "function") return false;
          window.__ossPetMove(x, z, duration);
          return true;
        },
        // 纯读：现在离相机多远（米）。只读，不改任何状态。
        // 必须用 __ossPetPos（读现状），不能用 __ossPetMove 去“读”——
        // 后者是下命令，调一次就把正在进行的定时位移取消掉。
        posZ() {
          if (typeof window.__ossPetPos !== "function") return NaN;
          const p = window.__ossPetPos();
          return p && Number.isFinite(p.z) ? p.z : NaN;
        },
        // 显隐：停止产帧并清空纹理源，屏幕上一点都不留
        setActive(on) {
          active = on !== false;
          if (!active) {
            stopTick();
            try { video.pause(); } catch (error) { /* 已经停了 */ }
            if (typeof window.__ossPetTexture === "function") window.__ossPetTexture(null);
          } else if (clip && video.readyState >= 2) {
            // 重新播放时也要把倍率写回去：play() 可能把它重置成 1。
            try { video.play().then(() => { syncRate(); startTick(); }).catch(() => {}); } catch (error) { /* 下一帧再说 */ }
          } else {
            frame();
          }
        },
        dispose() {
          dead = true;
          stopTick();
          video.onended = null;
          try { video.pause(); video.removeAttribute("src"); video.load(); } catch (error) { /* 已经停了 */ }
          img.removeAttribute("src");
          cv.width = 1;
          cv.height = 1;
        },
      };
    }

    // 大肥鱼的行为调度：单队列，播完一段抽下一段。
    // 抽签分两层（先抽组再抽组内）—— 平铺 50 个动作一起抽会变成杂耍。
    // onDream(show)：睡觉时的梦境面板回调。只有玩家点「睡觉与做梦」触发时才为 true。
    function createPetScheduler(pet, win, onDream) {
      const NEAR_Z = 4.8;
      const CLIP_SEC = 10.04;
      // 一次位移最多走多远（米）。原来远档能一下跳到 26~41 米，等于瞬移，
      // 落点太稀。现在每段走路只走一小步，落点密、看得见它在草地上挪。
      const STEP_MAX = 7;

      // ---- 动作表 ----
      // w    组内权重
      // hold 循环时长（秒，[min,max]）。没有 = 播一遍就切
      // walk 是否要配位移
      const GROUPS = {
        walk: { weight: 26, clips: ["漂浮踏步", "螃蟹走路", "左转奔跑"] },
        idle: { weight: 20, clips: ["东张西望", "哈欠连天", "超大伸懒腰"] },
        // 背对看风景：单独一组，权重 8。它不在 idle 里，因为 idle 那三个都只播一遍，
        // 而这个要靠 HOLD 循环 40~90 秒才成立。
        backview: { weight: 8, clips: ["背对看风景"] },
        daily: { weight: 7, clips: ["照镜子", "悠闲哼歌", "打瞌睡被惊醒"] },
        play: { weight: 16, clips: ["撸猫", "原地专心玩魔方", "下五子棋", "三球抛接", "扑克魔术", "荡秋千"] },
        season: { weight: 8, clips: ["被落叶淹没", "堆雪人", "摇扇纳凉", "玩水枪"] },
        talent: { weight: 8, clips: ["吹笛子", "小提琴演奏", "轻快摇摆舞", "可爱宅舞", "优雅女仆舞"] },
        eat: { weight: 5, clips: ["期待开饭", "吃饭·碗饭", "吃饭团", "吃早餐", "吃午餐", "吃晚餐", "吃西瓜", "大口吃零食", "偷吃零食被抓住"] },
        mood: { weight: 5, clips: ["点击回应-害羞惊讶", "深度思考碎碎念", "用鲸鱼尾巴拍打地面"] },
        rare: { weight: 3, clips: ["蝴蝶蜜蜂环绕头顶开花", "原地重力下蹲压缩"] },
        // 睡觉可以随机抽到（它自己的作息），也可以由玩家点「睡觉与做梦」触发。
        // 区别在于来源：用户点的才弹头顶那个梦境面板 —— 随机睡时弹面板会动用户界面，不可控。
        sleep: { weight: 5, clips: ["睡觉-开始"] },
      };

      // 需要循环播放、待久一点的动作。没列在这里的一律播一遍。
      const HOLD = {
        "撸猫": [20, 40],
        "吹笛子": [20, 30],
        "小提琴演奏": [20, 30],
        "悠闲哼歌": [30, 60],
        "原地专心玩魔方": [15, 35],
        // 转过去看风景要「看很久」：截出来的片子只有 1 秒转身，靠循环待够 40~90 秒。
        "背对看风景": [40, 90],
      };

      const GROUP_KEYS = Object.keys(GROUPS);
      const GROUP_TOTAL = GROUP_KEYS.reduce((s, k) => s + GROUPS[k].weight, 0);

      // 壁纸模式下点鱼本身会播的回应。五个都是素材库自带的「被摸」反应。
      const CLICK_REACTS = [
        "点击回应-害羞惊讶",
        "点击回应-开心跃动",
        "点击回应-挠痒咯咯笑",
        "点击回应-元气挥手",
        "点击回应-傲娇生气",
      ];

      let lastClip = "";
      let facing = -1;
      let disposed = false;
      let queueTimer = 0;
      let busy = false;          // 正在跑一段，期间的插队要排队
      // 这次睡觉是谁发起的：true = 玩家点了按钮，false = 队列随机抽到。
      // 只有玩家点的那种才弹头顶的梦境面板 —— 随机睡的时候弹面板等于动用户界面。
      let sleepByUser = false;
      // 睡着期间屏蔽天气反应。见 reactWeather() 里那条 clearTimeout 的说明。
      let sleeping = false;

      // 环境事件的冷却
      const lastTrigger = { rain: 0, thunder: 0, clear: 0, cold: 0, hot: 0 };

      const rand = (a, b) => a + Math.random() * (b - a);
      const now = () => Date.now();
      const roll = (prob) => Math.random() < prob;

      // 时间流速。倍率越快，等待越短、动作播放越快（playbackRate 在引擎侧同步）。
      function ts() {
        const v = typeof win.__ossTimeScale === "function" ? win.__ossTimeScale() : 1;
        return Number.isFinite(v) && v > 0 ? Math.min(v, 8) : 1;
      }
      const wait = (seconds) => (seconds * 1000) / ts();

      // 某个纵深下横向能走多远。只问引擎，不在客户端重算一遍。
      function halfWidth(z) {
        try {
          if (typeof win.__ossPetHalfWidth === "function") {
            const h = win.__ossPetHalfWidth(z);
            if (Number.isFinite(h) && h > 0) return h;
          }
        } catch (error) { /* 引擎没起来 */ }
        return 3;
      }

      // ---- 打雷抖屏 ----
      function shake() {
        const el = document.getElementById("__dsh-weather-sandbox");
        if (!el) return;
        const frames = [[3, -2], [-2, 3], [1, -1], [0, 0]];
        let i = 0;
        const tick = () => {
          if (i >= frames.length) { el.style.transform = ""; return; }
          el.style.transform = "translate(" + frames[i][0] + "px," + frames[i][1] + "px)";
          i++;
          setTimeout(tick, 55);
        };
        tick();
      }

      // ---- 抽签：先抽组，再抽组内 ----
      function pick() {
        for (let guard = 0; guard < 10; guard++) {
          let r = Math.random() * GROUP_TOTAL;
          let g = GROUP_KEYS[GROUP_KEYS.length - 1];
          for (const k of GROUP_KEYS) {
            r -= GROUPS[k].weight;
            if (r <= 0) { g = k; break; }
          }
          const list = GROUPS[g].clips;
          const clip = list[(Math.random() * list.length) | 0];
          if (clip !== lastClip) return { clip, group: g };
        }
        return { clip: GROUPS.idle.clips[0], group: "idle" };
      }

      // ---- 队列主体 ----
      // 每段结束都回到这里：挑一段、该走就走、播、播完再回来。
      function step() {
        if (disposed) return;
        busy = false;
        const { clip, group } = pick();
        lastClip = clip;

        // 走路配位移。落点密不密取决于「下一步离现在多远」，不是「绝对目标多随机」——
        // 所以先从整幅画面抽目标距离，再把单次位移钳到 STEP_MAX 以内，每段走一小步。
        if (group === "walk") {
          const r = Math.random();
          const tz = r < 0.05 ? NEAR_Z
                   : r < 0.30 ? rand(NEAR_Z, 11)
                   : rand(14, 30);
          const near = Number.isFinite(pet.posZ()) ? pet.posZ() : tz;
          const z = near + Math.max(-STEP_MAX, Math.min(STEP_MAX, tz - near));
          const hw = halfWidth(z);
          pet.moveTo(rand(-hw, hw), z, CLIP_SEC);
        }

        const hold = HOLD[clip];
        // 抽到睡觉：走三连流程，来源记成「队列」（不弹梦境面板）。
        if (clip === "睡觉-开始") {
          sleepByUser = false;
          sleepSequence();
          busy = true;
          return;
        }
        pet.play(clip, () => {
          if (disposed) return;
          if (hold) loopThenNext(clip, rand(hold[0], hold[1]));
          else next();
        }, hold ? { loopAfter: true } : undefined);
        busy = true;
      }

      // 播完一遍之后继续循环，循环到时间再收。
      // 引擎那边 loop 只影响视频是否回绕；这里用定时器控制「什么时候离开」。
      function loopThenNext(clip, seconds) {
        // 背对看风景是特例：它只有 0.5 秒的「转过去」，循环起来就一直在转。
        // 这段要的是转完冻住，所以走 hold，不走 loop。
        if (clip === "背对看风景") {
          pet.play(clip, null, { hold: true });
          clearTimeout(queueTimer);
          queueTimer = setTimeout(() => {
            if (disposed) return;
            next();
          }, wait(seconds));
          return;
        }
        pet.play(clip, next, { loopAfter: true, loop: true });
        clearTimeout(queueTimer);
        queueTimer = setTimeout(() => {
          if (disposed) return;
          next();
        }, wait(seconds));
      }

      // ---- 睡觉：走到角落 → 开始 → 循环几分钟 → 起来 → 走回来 ----
      // 三件事按顺序排，中间每一步都要等上一段播完。
      // 位置选画面左下的中景：那里有草、不挡画面，而且离相机不远，
      // 玩家能看清它真的躺下了 —— 这就是「看着自己的宠物睡觉」。
      // 睡觉地点：向日葵丛底下。世界 (4.3, 10.7)，固定不随机 —— 这是它的窝。
      // 对外接口的 z 是「离相机米数」，世界 z 10.7 对应约 6.3 米。
      const SLEEP_SPOT = { x: 4.3, z: 6.3 };

      // 睡觉三连：走到窝 → 躺下 → 循环 1~3 分钟 → 起来 → 伸懒腰 → 刷牙。
      // 走路用「漂浮踏步」配位移，不能边播「睡觉-开始」边位移（会变成躺着平移）。
      function sleepSequence() {
        if (disposed) return;
        sleeping = true;
        pet.moveTo(SLEEP_SPOT.x, SLEEP_SPOT.z, CLIP_SEC);
        pet.play("漂浮踏步", () => {
          if (disposed) return;
          pet.play("睡觉-开始", () => {
            if (disposed) return;
            pet.play("睡觉-循环", () => {}, { loop: true });
            // 躺稳了才弹 —— 此时鱼已经走到窝里、位置不再变，面板定位才准。
            if (sleepByUser && typeof onDream === "function") onDream(true);
            clearTimeout(queueTimer);
            // 睡 3~5 分钟（真实时间，不吃时间流速）
            queueTimer = setTimeout(() => {
              if (disposed) return;
              pet.play("睡觉-起来", () => {
                if (disposed) return;
                sleeping = false;
                if (typeof onDream === "function") onDream(false);
                // 4. 醒来伸个懒腰，再刷牙
                pet.play("超大伸懒腰", () => {
                  if (disposed) return;
                  pet.play("晨间刷牙", () => {
                    if (disposed) return;
                    // 5. 离开窝，回中景再回队列
                    pet.moveTo(rand(-1.5, 1.5), rand(9, 14), CLIP_SEC);
                    next();
                  });
                });
              });
            }, rand(180, 300) * 1000);
          });
        });
      }

      function next() {
        if (disposed) return;
        busy = false;
        clearTimeout(queueTimer);
        queueTimer = setTimeout(step, wait(rand(0.6, 2.4)));
      }

      // ---- 环境事件：插队 ----
      function sampleWeather() {
        if (typeof win.__openSeaShelter !== "object" || !win.__openSeaShelter) return null;
        let d;
        try { d = win.__openSeaShelter.drive(); } catch (error) { return null; }
        if (!d || !d.ready) return null;
        const precip = d.vaporPrecip || 0;
        const tempC = Number.isFinite(d.centerC) ? d.centerC : 20;
        return {
          rain: precip > 0.01,
          thunder: precip > 0.02 && d.updraft > 0.15,
          clear: precip < 0.002 && (d.humidityPct || 0) < 85,
          cold: tempC < 0,
          hot: tempC > 30,
        };
      }

      // 天气反应表。加一条新反应只要加一行。
      // 季节类动作（堆雪人/摇扇/玩水枪/被落叶淹没）挂在这里 —— 它们是「对环境有反应」，
      // 不是「随机抽到」。玩家看到它在雪地里堆雪人，那才像听懂了天气。
      const REACTIONS = [
        { key: "thunder", prob: 1.0,  cool: 15000, clip: "被吓一跳" },
        { key: "rain",    prob: 0.45, cool: 30000, clip: "鲸鱼吐泡泡特效" },
        { key: "clear",   prob: 0.5,  cool: 40000, clip: "点击回应-开心跃动" },
        { key: "cold",    prob: 0.6,  cool: 45000, clip: "原地小憩沉眠" },
        { key: "hot",     prob: 0.6,  cool: 60000, clip: "摇扇纳凉" },
      ];

      function reactWeather() {
        if (disposed) return;
        // 睡着的时候不搭理天气。
        // 这一条是「睡了没几秒就醒」的根因：reactWeather 每 660ms 跑一次，
        // 一旦触发就 clearTimeout(queueTimer) —— 而睡眠计时正是挂在 queueTimer 上，
        // 于是天一变它就被叫醒，3~5 分钟的睡眠变成几秒。
        if (sleeping) return;
        const s = sampleWeather();
        if (!s) return;
        const t = now();
        for (const r of REACTIONS) {
          if (s[r.key] && t - lastTrigger[r.key] > r.cool && roll(r.prob)) {
            lastTrigger[r.key] = t;
            if (r.key === "thunder") shake();
            // 打断当前这一段。被打断的那一段不会再回调，所以这里负责把队列接回来。
            clearTimeout(queueTimer);
            pet.play(r.clip, () => { if (!disposed) next(); });
            break;   // 一次只反应一件事，别在雷雨里连切四个动作
          }
        }
      }

      // ---- 换边：纯粹让侧脸换一边，不影响正在播的动作 ----
      function flipSide() {
        if (disposed) return;
        facing = -facing;
        pet.face(facing);
        setTimeout(flipSide, wait(rand(20, 55)));
      }

      let weatherTimer = 0;

      return {
        // 外部手动让它睡。面板上的「睡觉与做梦」按钮调这个。
        // 和队列抽签的区别：这个是玩家点的，立刻打断当前这段，并且会弹出梦境面板。
        sleepNow() {
          if (disposed) return false;
          clearTimeout(queueTimer);
          sleepByUser = true;
          sleepSequence();
          return true;
        },
        // 玩家点「看风景」：立刻转过去背对镜头，站一会儿再回队列。
        // 和自动抽到的区别只在于「立刻」，播的内容完全一样（背对看风景 + 循环）。
        sceneryNow() {
          if (disposed) return false;
          clearTimeout(queueTimer);
          lastClip = "背对看风景";
          // 播一遍（转身那 0.5 秒）后冻在最后一帧，站住不动。
          pet.play("背对看风景", null, { hold: true });
          const ms = rand(30, 60) * 1000;
          queueTimer = setTimeout(() => { if (!disposed) next(); }, ms);
          busy = true;
          return true;
        },
        // 玩家点了鱼本身（壁纸模式下）：播一个随机的「点击回应」，播完回队列。
        // 不碰队列当前那一段的定时器之外的东西 —— 打断是对的，点了就该有反应。
        react() {
          if (disposed) return false;
          const pool = CLICK_REACTS;
          const clip = pool[(Math.random() * pool.length) | 0];
          clearTimeout(queueTimer);
          lastClip = clip;
          pet.play(clip, () => { if (!disposed) next(); });
          busy = true;
          return true;
        },
        // 玩家点了地面（壁纸模式）：播走路动作。位移已经由调用方下过了。
        // 时长按位移距离给：走近处 2.2 秒，走远处也是 2.2 秒，动作对得上就行。
        reactWalk() {
          if (disposed) return false;
          clearTimeout(queueTimer);
          lastClip = "漂浮踏步";
          pet.play("漂浮踏步", () => { if (!disposed) next(); });
          busy = true;
          return true;
        },
        start() {
          if (disposed) return;
          pet.face(facing);
          step();                                        // 一进场就在动，才像活的
          setTimeout(flipSide, wait(rand(12, 30)));
          weatherTimer = setInterval(reactWeather, Math.max(100, 660 / ts()));
        },
        dispose() {
          disposed = true;
          clearTimeout(queueTimer);
          clearInterval(weatherTimer);
        },
      };
    }

    // ----------------------------------------------------------------- apply

    function apply(ctx) {
      if (typeof document === "undefined") return;
      const doc = document;
      const win = window;

      for (const id of [IDS.pane, IDS.fab, IDS.panel, IDS.ui, IDS.glass]) {
        for (const stale of doc.querySelectorAll("#" + id)) stale.remove();
      }

      const copy = pickCopy();
      const state = readSettings();

      // 系统「减少动态效果」：云主体照样画，只是把自主漂移和呼吸停掉。
      const motionQuery = typeof win.matchMedia === "function" ? win.matchMedia("(prefers-reduced-motion: reduce)") : null;
      const reduced = !!(motionQuery && motionQuery.matches);

      const pane = doc.createElement("div");
      pane.id = IDS.pane;
      pane.setAttribute("aria-hidden", "true");
      pane.style.cssText = "position:fixed;inset:0;z-index:2147480000;pointer-events:none;overflow:hidden";

      const weather = doc.createElement("div");
      weather.id = IDS.weather;
      weather.style.cssText = "position:absolute;inset:0;z-index:1;pointer-events:none";

      // 大肥鱼不占 DOM 层：它由引擎画进 3D 场景（见 createPetPass）。
      pane.append(weather);
      (doc.body || doc.documentElement).appendChild(pane);

      const petEntity = createPetEntity();
      // onDream 要等梦境面板建好后才能接（它在下面），先用一个转发变量。
      let dreamToggle = null;
      const petScheduler = createPetScheduler(petEntity, win, (show) => {
        if (typeof dreamToggle === "function") dreamToggle(show);
      });

      const uiStyle = doc.createElement("style");
      uiStyle.id = IDS.ui;
      uiStyle.setAttribute("data-plugin", PLUGIN);
      uiStyle.textContent = uiCss();
      (doc.head || doc.documentElement).appendChild(uiStyle);

      const engine = createWeatherEngine(weather);

      // ======================================================================
      //  联动总图 —— 雷雨昏暗（一级），雨雾柔化（独立链路）
      //
      //  ⚠ 完整的三场（温度/水汽/气压）循环图见文件头部「生态联动总图」。
      //    这一节只讲【效果层】怎么响应驱动层，不重复物理场的细节。
      //
      //    [闪电开 + 雨]                            ← 触发条件
      //         │
      //         └─(雷雨昏暗)────────────────────────────────────
      //               云: 量150 凝聚100 风100
      //               光: 太阳×0.3 光晕×0.35 光束0.75
      //               雨: 跟着云走（云满则雨密，无需额外代码）
      //    [雨势 downpour] ──▶ [光]                  ← 独立链路，与闪电无关
      //         太阳×(1-0.25w)  光晕×(1+2.2w)  光束×(1-0.2w)
      //         w = 当前雨量 / 1400，0..1
      //  驱动层（温度/水汽/气压）算出「天气本身」，通过 rainBudget / snowBudget /
      //  pushCloud 给这一层加成。分工是：驱动层决定「下不下、下多大」，这一层决定「怎么演」。
      //  旧的「数量+频率拉满触发超级暴雨」已删除 —— 暴雨该由气压骤降 + 水汽饱和
      //  自然产生，不该由闪电滑杆触发（因果反了，且会和水汽模块互相打架）。
      //  三条铁律：
      //    1. 只改「推给引擎的值」，绝不改用户的滑杆位置。关掉闪电立刻复原。
      //    2. 用户一动某个云/光滑杆，只有那一个参数归用户（taken），其余照常联动。
      //       接管标记只在「闪电关掉」或「离开雨场景」时清除。
      //    3. 只做「压暗」，不做「改形状」：雷雨天要一整片压下来的黑云。
      // ======================================================================
      // 雷暴压暗的强度 0..1，不是布尔。
      // 布尔的话「进入雷暴」和「离开雷暴」都是瞬间切换，画面直接闪一下黑/闪一下亮。
      // 改成数值 + 每拍逼近：压暗要一两秒才到位，也要一两秒才恢复 —— 和云聚集/散开同节奏。
      let stormDim = 0;
      // 上一次真正推给引擎的场景。驱动层每拍重算形态，只有真的变了才重绘 ——
      // setScene 会重建雨滴数组，每拍都调会让画面卡顿。
      let lastShape = "none";
      // 「用户接管」按参数分开记，不再一动手就整体停掉联动。
      const taken = { amount: false, density: false, unite: false, opacity: false, wind: false, sun: false };
      function clearTaken() {
        for (const k in taken) taken[k] = false;
      }

      let immersive = false;
      let glassSaved = null;
      let oceanState = "pending";
      const glass = doc.createElement("style");
      glass.id = IDS.glass;
      (doc.head || doc.documentElement).appendChild(glass);

      function paintGlass(value) {
        glass.textContent = glassCss(value) + immersiveCss(immersive);
        const targets = [doc.documentElement, doc.body].filter(Boolean);
        if (glassSaved === null) {
          glassSaved = targets.map((element) => ({
            element,
            value: element.style.getPropertyValue("background"),
            priority: element.style.getPropertyPriority("background"),
          }));
        }
        if (oceanState === "failed") {
          restorePageBackground();
        } else {
          for (const element of targets) element.style.setProperty("background", "transparent", "important");
        }
      }

      // 沉浸模式切换：Ctrl+Shift+H。只切一个变量再重画玻璃即可，
      // 沉浸态的内容由 immersiveCss() 决定。
      // 沉浸模式：隐藏 DSH 界面，并在屏幕正中放一个「回到界面」大按钮。
      // 没有这个按钮，用户进去就出不来 —— 快捷键不能作为唯一出口。
      let restoreBtn = null;
      let dpadHint = null;      // 「回到界面」左边的方向键提示
      function setImmersive(next) {
        immersive = !!next;
        paintGlass(readSettings().glass);
        if (immersive) {
          if (!restoreBtn) {
            restoreBtn = doc.createElement("button");
            restoreBtn.type = "button";
              restoreBtn.innerHTML = '<span class="oss-gold-shine">回到界面</span>';
            restoreBtn.title = "回到界面";
              restoreBtn.style.cssText = [
                // 与悬浮按钮（right:14px / bottom:14px / 30x30）并排：放在它左边 8px
                "position:fixed", "right:52px", "bottom:14px", "z-index:2147480099",
                "height:30px", "padding:0 12px", "border-radius:999px",
                "display:inline-flex", "align-items:center", "justify-content:center", "cursor:pointer",
                "font:inherit", "font-size:11.5px", "font-weight:600", "letter-spacing:.3px", "white-space:nowrap", "overflow:hidden",
                "background:color-mix(in srgb, var(--dsw-alias-bg-layer-3, #fff) 82%, transparent)",
                "border:1px solid #d9a93c99",
                "backdrop-filter:blur(10px)", "-webkit-backdrop-filter:blur(10px)",
                "box-shadow:0 2px 12px #00000033, 0 0 0 1px #d9a93c22",
                "transition:opacity 160ms ease, transform 160ms ease, color 160ms ease, box-shadow 160ms ease",
              ].join(";");
              restoreBtn.addEventListener("mouseenter", () => {
                if (restoreBtn.firstChild) restoreBtn.firstChild.style.filter = "brightness(1.15)";
                restoreBtn.style.transform = "translateY(-1px)";
                restoreBtn.style.boxShadow = "0 3px 16px #00000040, 0 0 0 1px #d9a93c66";
              });
              restoreBtn.addEventListener("mouseleave", () => {
                if (restoreBtn.firstChild) restoreBtn.firstChild.style.filter = "";
                restoreBtn.style.transform = "translateY(0)";
                restoreBtn.style.boxShadow = "0 2px 12px #00000033, 0 0 0 1px #d9a93c22";
              });
            restoreBtn.addEventListener("click", () => setImmersive(false));
            doc.body.appendChild(restoreBtn);
          }
          // 「回到界面」左边一个方形方向键提示。
          // 壁纸模式改名成「壁纸与交互」之后，玩家要知道自己能控制那条鱼 ——
          // 一个方向键图形比一句说明直观，也不占地方。
          if (!dpadHint) {
            dpadHint = doc.createElement("button");
            dpadHint.type = "button";
            dpadHint.title = "方向键移动";
            dpadHint.style.cssText = [
              "position:fixed", "right:148px", "bottom:14px", "z-index:2147480099",
              "width:30px", "height:30px", "padding:0", "border-radius:9px",
              "display:inline-flex", "align-items:center", "justify-content:center",
              "background:color-mix(in srgb, var(--dsw-alias-bg-layer-3, #fff) 82%, transparent)",
              "border:1px solid #d9a93c99", "color:#c9922a", "cursor:pointer",
              "backdrop-filter:blur(10px)", "-webkit-backdrop-filter:blur(10px)",
              "box-shadow:0 2px 12px #00000033, 0 0 0 1px #d9a93c22",
              "transition:opacity 160ms ease, transform 160ms ease, color 160ms ease",
            ].join(";");
            // 标准方向键布局：上面单独一个 ↑，下面一排 ← ↓ →。
            // 不画成「十字星」那种全面屏展开图标 —— 玩家要认的是键盘方向键。
            dpadHint.innerHTML = [
              '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"',
              ' stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">',
              // 上：一个向上箭头
              '<path d="M12 3.2 12 8.4M9.6 5.6 12 3.2l2.4 2.4"/>',
              // 下排三个：左、下、右
              '<path d="M4.2 16.6 6.6 16.6M5.4 15.4 4.2 16.6l1.2 1.2"/>',
              '<path d="M12 14.2 12 19.4M9.6 17 12 19.4l2.4-2.4"/>',
              '<path d="M19.8 16.6 17.4 16.6M18.6 15.4 19.8 16.6l-1.2 1.2"/>',
              '</svg>',
            ].join("");
            dpadHint.addEventListener("click", () => {
              // 点它不做事，只是一个提示 —— 但它得能吃掉点击，否则会穿透到世界上去
            });
            doc.body.appendChild(dpadHint);
          }
        } else if (restoreBtn) {
          restoreBtn.remove();
          restoreBtn = null;
          if (dpadHint) { dpadHint.remove(); dpadHint = null; }
        }
      }
      function restorePageBackground() {
        if (glassSaved === null) return;
        for (const entry of glassSaved) {
          if (entry.value) entry.element.style.setProperty("background", entry.value, entry.priority);
          else entry.element.style.removeProperty("background");
        }
      }

      function clearGlass() {
        glass.textContent = "";
        restorePageBackground();
        glassSaved = null;
      }

      let oceanStarted = false;
      let oceanScript = null;
      let oceanRun = 0;

      function oceanParams(settings) {
        return new URLSearchParams({
          sea: String(settings.sea),
          t: String(settings.time),
          // auto="1" = 自动昼夜开；"0" = 手动锁定
          auto: settings.autoCycle ? "1" : "0",
          // 时间流逝倍率，引擎按它统一缩放所有自走动画
          timeScale: String(timeScaleAt(settings.timeScale)),
          skin: "1",
        });
      }

      function postOcean(settings) {
        // ⚠ 自动模式下绝不推 t。
        // daylight 归引擎的循环管；这里推一次就会把循环刚算出的值覆盖回滑杆存的旧值。
        // 而 paint() 会因改设置 / 主题变化 / 窗口 resize 被频繁调用 —— 推 t 等于每帧清零，
        // 循环看起来就是「从没动过」（这个 bug 查了很久）。
        const patch = {
          sea: settings.sea,
          auto: settings.autoCycle,
          // 时间流逝倍率：引擎用它统一缩放所有自走动画（太阳月亮星空、海浪、云）。
          timeScale: timeScaleAt(settings.timeScale),
        };
        if (!settings.autoCycle) patch.t = settings.time;
        // 直连不需要等 oceanStarted：引擎脚本一加载完就会挂上 __ossSeaSet。
        if (typeof win.__ossSeaSet === "function") {
          win.__ossSeaSet(patch);
          return;
        }
        if (!oceanStarted) return;
        // 兜底：引擎还没挂上直连接口时走消息
        const event = new MessageEvent("message", {
          data: { type: "oss-set", sea: patch.sea, t: patch.t, auto: patch.auto },
          origin: win.location.origin,
        });
        // source 是原型上的 getter，只写 value 会把它挡住，必须定义 getter。
        Object.defineProperty(event, "source", { get() { return win; }, configurable: true });
        win.__ossDispatch = true;
        try {
          win.dispatchEvent(event);
        } finally {
          win.__ossDispatch = false;
        }
      }

      const onOceanMessage = (event) => {
        if (win.__ossDispatch) return;
        const data = event.data;
        if (!data || typeof data.type !== "string") return;
        if (data.type === "oss-ready") {
          oceanState = "ok";
          render(readSettings());
        } else if (data.type === "oss-failed") {
          oceanState = "failed";
          try {
            clearGlass();
          } catch (error) {
            console.warn("[Open Sea Shelter] glass restore failed", error);
          }
          render(readSettings());
        }
      };
      win.addEventListener("message", onOceanMessage);

      function startOcean(settings) {
        if (oceanStarted) return;
        oceanStarted = true;
        // 每次重新启动都重建 <script>：上一次 stopOcean() 可能已经把旧的摘掉了。
        // 参数必须在插入前写好，引擎是同步执行的（async=false），会立刻读 window.__ossParams。
        if (oceanScript && oceanScript.parentNode) oceanScript.parentNode.removeChild(oceanScript);
        oceanScript = doc.createElement("script");
        win.__ossParams = oceanParams(settings);
        // 加一个递增的 run 计数：浏览器对同一个 src 的 <script> 会吃缓存，
        // 关掉再打开时同一个 URL 不会重新执行，海就再也不出来了。每次都换 URL。
        oceanRun += 1;
        oceanScript.src = `${ASSET_BASE}ocean-engine.js?v=${VERSION}&run=${oceanRun}`;
        oceanScript.async = false;
        oceanScript.addEventListener("load", () => {
          // 参数只在本次加载生效，用完就撤，避免下一次重启读到旧值。
          try {
            delete win.__ossParams;
          } catch (error) {
            win.__ossParams = undefined;
          }
        });
        oceanScript.addEventListener("error", () => {
          oceanState = "failed";
          paint();
          render(readSettings());
        });
        (doc.head || doc.documentElement).appendChild(oceanScript);
      }

      function stopOcean() {
        // 先让引擎自己停掉 raf、摘掉监听、摘掉 canvas。
        // 只 remove <script> 是不够的：脚本里的循环和 canvas 还活着。
        if (typeof win.__ossDispose === "function") {
          try {
            win.__ossDispose();
          } catch (error) {
            console.warn("[Open Sea Shelter] ocean dispose failed", error);
          }
          try { delete win.__ossDispose; } catch (error) { win.__ossDispose = undefined; }
        }
        if (oceanScript) oceanScript.remove();
        oceanScript = null;
        // 兜底：引擎 dispose 失败时它自己的 canvas 会留在页面上，这里再摘一次。
        for (const stale of doc.querySelectorAll("canvas[data-oss-canvas]")) stale.remove();
        oceanStarted = false;
        // 停掉之后状态回到「还没起来」，这样再打开时面板显示的是加载中，而不是上一次的 ok。
        oceanState = "pending";
      }

      function findOceanCanvas() {
        // 只认引擎自己插的那块（带 data-oss-canvas 标记）。
        // 用 querySelector("canvas") 会抓到页面上任何一块 canvas —— 别家插件的、甚至雨雪层的。
        try {
          return doc.querySelector("canvas[data-oss-canvas]");
        } catch (error) {
          return null;
        }
      }

      function syncOcean(settings) {
        if (!settings.enabled) {
          // 取消勾选：真的把引擎停掉，而不是只把画布设成透明。
          // 以前这里只改 opacity，引擎的 raf 一直在跑、oceanStarted 仍是 true，
          // 再勾回来时 startOcean() 第一行就 return 了，海再也回不来。
          stopOcean();
          return;
        }
        startOcean(settings);
        const canvas = findOceanCanvas();
        if (canvas) canvas.style.opacity = "1";
        // 海面显隐：引擎可能还没起来（脚本异步加载），拿不到就等下一拍再推。
        // 这个开关只影响海面那一次绘制，天空和天气不受它影响。
        if (typeof win.__ossSeaVisible === "function") {
          try { win.__ossSeaVisible(settings.seaVisible !== false); } catch (error) { /* 下一拍重试 */ }
        }
        // 草地：每拍补推一次。引擎是异步加载的，第一拍常常还没挂上接口。
        pushGround(settings);
        postOcean(settings);
      }

      // 草地推送口。和 postOcean 对称。
      // 推三样：开关、密度、以及气压/雾这两个来自驱动层的共用场值。
      function pushGround(settings) {
        const current = settings || readSettings();
        const on = current.groundVisible === true;
        if (typeof win.__ossGroundVisible === "function") {
          try { win.__ossGroundVisible(on); } catch (error) { /* 下一拍重试 */ }
        }
        // ---- 天气联动：地形切换 ----
        // 草地开着时，天气驱动层改用 grass 那套标签（蒸发率/热容/凝结核/落点）。
        // 关掉就退回 ocean，和插件原本的行为完全一致。
        setDriveTerrain(on ? "grass" : "ocean");
        // 天气数值只在驱动层就绪后才读。
        // 原因：pushGround 可能在驱动层初始化之前被 paint() 调一次，
        // 那时 VAPOR / driveState / gridCount 还在 TDZ 里抛出 ReferenceError。
        // 用 driveReady 标记挡住，避免早期那一次把 wet/snow 推成 undefined。
        // ⚠ 这里读的是「上一次定时器算好的缓存」，不调用 weatherCover()：
        //    那个函数会推进 wetMemory/snowMemory，每拍只能调一次，
        //    否则两处都在累加，积雪会涨得飞快。
        //
        // 手动滑杆优先：用户把「积雪」或「湿润」拉起来就是要亲眼看效果，
        // 拉回 0 才把控制权交还给天气系统。
        // 优先级逻辑集中在 pushWeather() 一处，这里只调用，不重复实现。
        const wx = manualWeatherValues(current);
        if (typeof win.__ossGroundSet === "function") {
          try {
            win.__ossGroundSet({
              enabled: on,
              params: {
                density: Math.max(0, Math.min(1, current.groundDensity / 100)),
                flower: Math.max(0, Math.min(1, current.flowerDensity / 100)),
              },
              // 气压：引擎里 uPressure 是「0=低压趴倒」，而这里拿到的是「气压降」，
              // 所以取 1 - drop，语义才对得上。
              pressure: Math.max(0, Math.min(1, 1 - getPressureDrop())),
              fog: groundFogValue(),
              // 天气：积雪量 / 湿润度。手动滑杆优先，否则用天气系统的累积值。
              snow: wx.snow,
              wet: wx.wet,
            });
          } catch (error) { /* 下一拍重试 */ }
        }
      }

      // ---- 从天气状态算出「积雪量」和「湿润度」----
      //
      // 不另起一套天气模型，只读引擎已有的量：
      //   VAPOR.precip     降水率 0..1  —— 实际落下多少
      //   VAPOR.snowDrop   冰晶量 0..1  —— 落下来的是雪还是雨
      //   driveState.T     归一温度 0..1 —— 决定雪化不化
      //
      // 【温度是融雪的唯一开关】
      //   温度 ≥ 0°C → 雪落地就化，积雪只减不增
      //   温度 < 0°C → 雪能堆起来，越冷堆得越实、化得越慢
      // 0°C 在归一温度里是 (0 - displayMin) / (displayMax - displayMin)
      //   = (0 + 20) / (40 + 20) ≈ 0.333，和面板那条 0°C 刻度线是同一个位置。
      let wetMemory = 0;
      let snowMemory = 0;
      // ---- 雨雪形态判定的去抖状态 ----
      // phaseTempC：给「判雨还是判雪」用的平滑温度（低通，滤掉潜热引起的秒级抖动）
      // snowPhase ：上一次的形态判定（true=雪），配合回滞，避免在冰点附近来回翻
      // lastPhaseMs：上一次平滑的时间戳，用来算真实 dt
      let phaseTempC = NaN;
      let snowPhase = null;
      let lastPhaseMs = Date.now();
      // 用真实时间初始化：0 会让首拍算出 dt=0.5 的假步长，
      // 而首拍现在可能紧接着 refreshWeatherNow 就又来一次，两次叠在一起累积过快。
      let lastWeatherTick = Date.now();
      // 上一次算出并已推给引擎的天气数值。
      // weatherCover() 每拍只调一次（在 driveTimer 里），结果缓存在这里；
      // pushGround 只读这个缓存，不重复推进累积量。
      let lastWeather = { snow: 0, wet: 0 };
      // 驱动层是否已经初始化完（VAPOR / driveState / gridCount 都已就绪）。
      // 用 try 读一下 VAPOR 判断：TDZ 里的 const 会抛 ReferenceError。
      function driveReady() {
        try { return typeof VAPOR === "object" && VAPOR !== null && typeof gridCount === "number" }
        catch (e) { return false }
      }

      // ---- 统一的天气数值出口 ----
      //
      // 为什么需要这个函数：积雪/湿润有两个来源，
      //   ① 天气系统累积（weatherCover，每 2 秒推进）
      //   ② 用户手动滑杆（积雪 / 湿润，0~100）
      // 如果定时器和面板各推各的，后推的会把先推的覆盖掉 ——
      // 表现就是「手动拉起来的效果只闪一下，马上被天气值顶回去」。
      // 所以优先级只在这里写一次：
      //   手动值 > 0 就用手动值（用户要亲眼看），手动为 0 才用天气值。
      // 手动滑杆优先，但要给「自演化」让路。
      //
      // 规则：
      //   自演化关闭 → 手动值非 0 就是永久接管（用户要亲眼看效果，不能莫名消失）
      //   自演化开启 → 手动值一律忽略，积雪/积水 100% 由天气系统决定
      //
      // 为什么自演化必须盖过手动：自演化接管的是「天气本身」，
      // 雪该不该化、什么时候化，是温度和水汽算出来的结果。
      // 只要手动滑杆还压着，天气里雪化成 0 了，画面上却还是白的 ——
      // 看起来就是「纯自演化时雪不化」（用户实测）。
      function manualWeatherValues(settings, forceWeather) {
        const s = settings || readSettings()
        const weather = { snow: lastWeather.snow || 0, wet: lastWeather.wet || 0 }
        // 自演化开启、或调用方要求强制天气 → 完全交还天气
        if (forceWeather || evolveState.active) return weather
        const manualSnow = Math.max(0, Math.min(1, (s.snowCover || 0) / 100))
        const manualWet = Math.max(0, Math.min(1, (s.wetness || 0) / 100))
        return {
          snow: manualSnow > 0 ? manualSnow : weather.snow,
          wet: manualWet > 0 ? manualWet : weather.wet,
        }
      }

      function pushWeather() {
        if (typeof win.__ossGroundSet !== "function") return
        const wx = manualWeatherValues()
        try { win.__ossGroundSet({ snow: wx.snow, wet: wx.wet }) } catch (error) { /* 下一拍重试 */ }
      }

      // 立即重算一次天气并推送。
      //
      // 为什么需要：weatherCover 本来只挂在 2 秒的慢拍里。拖温度滑块后，
      // 驱动层的温度在下一拍（500ms）就到位了，但积雪/积水要再等最多 2 秒
      // 才重新评估 —— 用户反馈「拉到 -10°C 要好几秒才下雪，第一次尤其明显」。
      // 第一次更慢，是因为首拍还要等水汽场从零开始凝结。
      //
      // 这个函数在温度/湿度滑块变化后被调用，让响应跟手。
      // 它推进的是真实的时间步长（weatherCover 用 Date.now 算 dt），
      // 所以多调几次不会让累积量翻倍 —— dt 变小了，积分总量不变。
      function refreshWeatherNow() {
        try {
          if (!driveReady()) return
          stepVapor()
          lastWeather = weatherCover()
          pushWeather()
        } catch (error) { /* 驱动层还没就绪 */ }
      }
      // 融雪速率（每秒）。温度是唯一开关：
      //   <= -3C  几乎不化：0.0004/s → 十分钟只化 24%（升华级，符合物理）
      //   -3..0C  极慢
      //   0..5C   明显融化
      //   >5C     几分钟内化光
      // 之前这里只有一个常数 0.05，雪一旦积起来就几乎不消失 ——
      // 这就是「自演化时雪不化」的另一个原因。
      // 注意：冻住时的速率必须足够小。0.008/s 在十分钟里会累计 4.8，
      // 比雪量本身还大，-8C 的雪也会化光 —— 那是错的。
      function meltRateFor(tempC) {
        if (tempC <= -3) return 0.0004
        if (tempC <= 0) return 0.0004 + (tempC + 3) / 3 * 0.020     // 0.0004 -> 0.020
        if (tempC <= 5) return 0.020 + (tempC / 5) * 0.180          // 0.020 -> 0.200
        return 0.200 + Math.min(0.500, (tempC - 5) * 0.035)         // 0.200 -> 0.700
      }

      function weatherCover() {
        let precip = 0, ice = 0, tNorm = 0.5, rainDrop = 0;
        try { precip = typeof VAPOR.precip === "number" ? VAPOR.precip : 0 } catch (e) { precip = 0 }
        try {
          const mid = gridCount >> 1;
          ice = VAPOR.snowDrop ? (VAPOR.snowDrop[mid] || 0) : 0;
          // 液态云滴：雨的原料。之前只看了冰晶，所以分不清「在下雨」和「什么都没下」。
          rainDrop = VAPOR.cloudDrop ? (VAPOR.cloudDrop[mid] || 0) : 0;
          if (driveState.T) tNorm = driveState.T[mid];
        } catch (e) { /* 驱动层还没跑起来 */ }

        // 归一温度 → 摄氏，用来判断有没有到冰点
        const tempC = DRIVE_CONFIG.displayMin + (DRIVE_CONFIG.displayMax - DRIVE_CONFIG.displayMin) * tNorm;
        // 0 = 刚过冰点，1 = 10°C 以上（此时雪完全存不住）
        const aboveFreezing = Math.max(0, Math.min(1, tempC / 10));        // 低于冰点越多，雪化得越慢；-10°C 以下几乎不化
        const freeze = Math.max(0, Math.min(1, -tempC / 10));

        // 时间步长：这个函数被定时器每拍调用，按真实流逝时间算
        const now = Date.now();
        // 真实步长。下限 0.05s 只是为了挡住「同一毫秒内被调两次」导致的除零式停滞；
        // 上限 2.5s 防止标签页切回来时一下跳太多。因为 dt 是真的时间差，
        // 定时器 2 秒一拍和滑块拖动的密集调用积分出来是同一个总量。
        const dt = Math.min(2.5, Math.max(0.05, (now - lastWeatherTick) / 1000));
        lastWeatherTick = now;

        // ---- Rain vs snow: two independent inputs ----
        //
        // The old version had one `fallingSnow` flag and let snow also feed the
        // wetness accumulator, which is why snowing produced puddles and
        // raining produced nothing. Rain and snow are separate in the physics
        // too: rain comes from liquid cloud droplets, snow from ice crystals.
        // So measure both, and let each drive its own effect.
        // ---- Rain and snow as continuous intensities, not flags ----
        //
        // The hard `> 0.15` thresholds made the effect snap on and off: one
        // tick there is no snow, the next tick full snow. Real weather ramps.
        // Each intensity is now the product of two smooth ramps:
        //   material ramp    - how much ice / liquid cloud is present
        //   temperature ramp - whether it can fall as snow / rain at all
        // Multiplying two smoothsteps means there is no step edge anywhere.
        const iceAmt = smoothstep(0.02, 0.50, ice);
        const liquidAmt = smoothstep(0.02, 0.50, rainDrop);
        // The total-precipitation ramp has to be WIDE. At 0.005..0.08 any
        // meaningful precipitation pinned this at 1.0, so the additive
        // combination below jumped to 0.45 the moment anything started falling.
        const precipAmt = smoothstep(0.005, 0.45, precip);
        // 【雨雪来回跳 —— 真正的根因是温度在冰点附近抖动】
        // 上一版把 snowGate/rainGate 做成互补，消除了「两者同时>0」，
        // 但温度本身在 0°C 附近还会抖：潜热偏移（降水放热）会让温度升，
        // 温度升又改变降水形态，形成闭环；驱动层每拍只看网格中心【一个点】的温度，
        // 所以中心点一在 0°C 上下微动，雨/雪判定就整场翻一次。
        //
        // 正确做法是【回滞 + 温度平滑】，两样都要：
        //   ① 平滑：对用于判定形态的温度做低通，滤掉高频抖动。
        //      潜热引起的抖动是秒级的，时间常数 6 秒足以滤平而不会延迟昼夜变化。
        //   ② 回滞：记住上一次的形态判定，只有越过足够宽度才允许翻转。
        //      当前是雪 → 必须升到 +1.5°C 以上才切雨；当前是雨 → 必须掉到 -1.5°C 以下才切雪。
        //      中间那段保持原状，这就是"不再来回跳"的关键。
        const PHASE_TAU = 6.0;          // 秒
        const HYS = 1.5;                // °C，回滞半宽
        if (!Number.isFinite(phaseTempC)) phaseTempC = tempC;
        // 低通：按 dt 做指数平滑（
        // dt 已在下面算好，这里先用同一套时间差）
        const nowMs = Date.now();
        const dtSmooth = Math.min(2.5, Math.max(0.05, (nowMs - lastPhaseMs) / 1000));
        lastPhaseMs = nowMs;
        const kSmooth = 1 - Math.exp(-dtSmooth / PHASE_TAU);
        phaseTempC += (tempC - phaseTempC) * kSmooth;

        // 回滞状态机：snowPhase=true 表示「当前判为雪」
        if (typeof snowPhase !== "boolean") snowPhase = phaseTempC < 0;
        if (snowPhase) {
          // 当前是雪：只有明确升过 +HYS 才切雨
          if (phaseTempC > HYS) snowPhase = false;
        } else {
          // 当前是雨：只有明确掉到 -HYS 以下才切雪
          if (phaseTempC < -HYS) snowPhase = true;
        }
        // 用带记忆的温度做形态插值：雪的浓度 = 平滑温度离冰点的距离
        // 这里仍然给一个过渡带（snowPhase 决定方向，phaseTempC 决定强弱）
        // 【形态插值必须连续 —— 上一版还是跳了】
        // 上一版用 snowPhase 决定 center（雪-1.5 / 雨+1.5），再算 0.5+(T-center)/6。
        // 虽然式子本身连续，但 center 在切换那一刻从 -1.5 跳到 +1.5，
        // 整条曲线平移了 3°C，实测 T=2.7°C 时 snowToRain 从 0.996 掉到 0.512，跳了 0.48。
        //
        // 正确做法：【曲线只依赖平滑温度，不依赖状态】。
        //   回滞状态机只负责决定「当前是雪季还是雨季」这个大方向（用于积雪/融化），
        //   而雨/雪的比例用一条固定的、单值连续的函数，任何温度都有唯一输出，
        //   状态翻转时曲线不动，自然就不会跳。
        //   过渡区间 -1.5 ~ +1.5：低于此全雪，高于此全雨，中间平滑过渡（真实雨夹雪）。
        const T0 = -HYS, T1 = HYS;
        const u = Math.min(1, Math.max(0, (phaseTempC - T0) / (T1 - T0)));
        const snowToRain = u * u * (3 - 2 * u);   // smoothstep，两端导数为 0
        const snowGate = 1.0 - snowToRain;
        const rainGate = snowToRain;

        // Combine the material and total-precipitation signals additively
        // rather than with max(): max() jumps to the larger input the moment
        // either crosses its threshold, which is exactly the snap we are
        // removing. A soft union ramps continuously as either input rises.
        const snowAmt = Math.min(1, iceAmt * 0.85 + precipAmt * 0.45);
        const rainAmt = Math.min(1, liquidAmt * 0.85 + precipAmt * 0.45);
        const snowIntensity = Math.min(1, snowAmt * snowGate);
        const rainIntensity = Math.min(1, rainAmt * rainGate);
        const raining = rainIntensity > 0.001;
        const snowing = snowIntensity > 0.001;

        // ---- Wetness: driven by rain only ----
        // Rain soaks the ground. Snow does not - snow is a solid and only turns
        // into water when it melts, and that path is handled by the snow
        // accumulator below (melt feeds wetness at a trickle).
        //
        // 2.2 → 0.45：原来大雨下 0.49 秒积水就满，一出来就是一片水洼。
        // 地面吸水是个慢过程，现在满强度大雨也要约 3 秒才积起来，
        // 而小雨会拖到十几秒 —— 能看出"越下越湿"的过程。
        // 蒸发 0.15 → 0.06（基础）+ 0.5 → 0.22（暖天加成）：
        //   0.15 会把小雨完全抵掉（小雨永远积不起来）；
        //   0.5 的暖天加成又会让大雨也积不起来（暖天下大雨却不湿，不合常理）。
        //   现在：小雨(0.3) 约 13 秒积满，大雨(1.0) 约 3 秒；
        //   暖天蒸发更强，积水会在雨停后慢慢退去，但仍能在大雨时积起来。
        wetMemory = Math.max(0, Math.min(1,
          wetMemory + rainIntensity * 0.45 * dt - (0.06 + aboveFreezing * 0.22) * dt));

        // ---- Snow: driven by snow only, melted by temperature ----
        // Accumulation: what lays down is decided by the ground temperature,
        // not just by whether snow is falling.
        //
        // This is the fix for "snow covers the grass before it reaches 0C".
        // Above freezing, snow that lands melts on contact - it can fall (the
        // snow gate allows it up to 4C) but it cannot build up. The settle
        // factor has to reach zero at 0C, not at 4C.
        // settleGate reaches 0 AT freezing, not after it: snow that lands on
        // ground above 0C melts on contact, so it cannot build. Only below
        // freezing does anything lay down.
        //
        // 【0°C 附近太陡 →「凭空出现一片雪」】
        // 原来用 smoothstep(-1.5, 0.0)：-1.5°C 就已经是满速积雪，
        // 温度刚从 0 往下掉一点，雪就瞬间铺上来，看着像凭空变出来的。
        // 现在把过渡拉宽到 -6..0°C，并且用平方曲线让它在 0°C 附近非常缓慢地起步：
        //   -0.5°C → 几乎不积    -2°C → 开始有    -6°C → 满速
        const settleRaw = Math.max(0, Math.min(1, -tempC / 6.0));
        const settleGate = settleRaw * settleRaw;
        // 2.4 → 0.55：原来 0.42 秒就铺满，根本看不到「慢慢积起来」的过程。
        // 现在满速也要约 1.8 秒，而 0°C 附近（gate 很小）是十几秒级的缓慢累积。
        const settle = snowIntensity * settleGate * 0.55;
        // Melt: almost nothing below freezing; fast above it.
        const melt = meltRateFor(tempC);
        snowMemory = Math.max(0, Math.min(1, snowMemory + (settle - melt) * dt));
        // Melting snow turns to water - that is the one link between the two.
        if (melt > 0.01 && snowMemory > 0.01) {
          wetMemory = Math.min(1, wetMemory + melt * 0.35 * dt);
        }

        return {
          snow: Math.round(snowMemory * 1000) / 1000,
          wet: Math.round(wetMemory * 1000) / 1000,
          // 调试用：面板或控制台能看到现在到底在发生什么
          tempC: Math.round(tempC * 10) / 10,
          fallingSnow: snowing,
          raining,
        };
      }

      // 雾值：优先读驱动层已发布的 __ossAtmos，读不到退化为 0。
      // 草地不自己另算一遍雾 —— 那样会和在跑的天气系统各说各话。
      function groundFogValue() {
        if (typeof win.__ossAtmos !== "function") return 0;
        try {
          const a = win.__ossAtmos();
          if (a && Number.isFinite(a.fog)) return Math.max(0, Math.min(1, a.fog));
        } catch (error) { /* 下一拍重试 */ }
        return 0;
      }

      function paint() {
        // 和 render 一致：自演化时引擎收到的是系统算出来的值。
        const current = withEvolved(readSettings());
        try {
          if (current.enabled) paintGlass(current.glass);
          else clearGlass();
        } catch (error) {
          console.warn("[Open Sea Shelter] glass failed", error);
        }
        try {
          syncOcean(current);
        } catch (error) {
          console.warn("[Open Sea Shelter] ocean failed", error);
        }
        engine.setScheme(scheme());
        // 场景不再由用户选，而是「温度 + 湿度饱和」算出来的结果。
        // 计算所需的温度和降水率都由驱动层提供；驱动层还没跑第一拍时退化为 none。
        let shape = "none";
        try {
          const mid = gridCount >> 1;
          const tNorm = driveState.T ? driveState.T[mid] : NaN;
          const tempC = Number.isFinite(tNorm)
            ? DRIVE_CONFIG.displayMin + (DRIVE_CONFIG.displayMax - DRIVE_CONFIG.displayMin) * tNorm
            : NaN;
          shape = shapeFor(tempC, vaporRef.precip || 0);
        } catch (error) { shape = "none"; }
        // 闪电联动：雷雨昏暗 = 闪电开 + 正在下雨 + 气压在快速下降。
        // 第三个条件（updraft）是关键：只靠「闪电开 + 下雨」的话，
        // 玩家把湿度拉高、天气一直阴着，stormMood 就永久为真 ——
        // 云量被推满、太阳被压到 30%，整个屏幕一直是灰的（观感灾难，而且没法玩）。
        // 加上 updraft 之后，只有「气压正在崩」的那一段才是真雷雨，
        // 其余时候只是普通下雨，天该多大亮就多大亮。
        const rainingNow = shape === "rain";
        if (current.lightning !== true || !rainingNow) clearTaken();
        // 目标是 0 或 1，每拍逼近 18% —— 约 1 秒到位，不会闪。
        const stormWant = current.lightning === true && rainingNow && computeUpdraft() > 0.10 ? 1 : 0;
        stormDim += (stormWant - stormDim) * 0.18;
        if (Math.abs(stormWant - stormDim) < 0.01) stormDim = stormWant;
        if (shape === "none") {
          engine.setScene("none");
          engine.setIntensity(0);
          // 不下的时候也要把云和光恢复，不然昏暗状态会一直挂在那里
          pushCloud(true);
          pushSun();
          return;
        }
        engine.setScene(shape);
        engine.setLightning(current.lightning);
        engine.setLightningFreq(current.lightningFreq);
        engine.setLightningCount(current.lightningCount);
        // 联动：闪电状态变了就立刻重推云和光（stormMood 只在这里翻）。
        pushCloud(true);
        pushSun();
        // 系统开了「减少动态效果」时，原本把强度强制成 0 → 引擎不 running
        // → scheduleStrike 第一行 !running 直接 return → 闪电永远不出现，且完全静默。
        // 闪电是用户明确打开的开关，不该被系统的动效偏好一刀切掉：保留强度，
        // 只在极少数需要静止的场景（isReduced 且没开闪电）才退成一个静态帧。
        // 降水强度由「湿度滑杆」换算：湿度拉得越高，雨/雪越密。
        const precip = reduced && !current.lightning ? 0 : current.humidPos;
        engine.setIntensity(precip);
        if (reduced && !current.lightning && typeof engine.renderOnce === "function") engine.renderOnce();
      }

      function scheme() {
        try {
          return ctx.theme.getTheme().active.colorScheme === "dark" ? "dark" : "light";
        } catch (error) {
          return "dark";
        }
      }

      const fab = doc.createElement("button");
      fab.id = IDS.fab;
      fab.type = "button";
      fab.setAttribute("aria-label", copy.title);
      fab.setAttribute("aria-haspopup", "dialog");
      fab.setAttribute("aria-expanded", "false");
      fab.innerHTML = ICONS.weather;   // 固定天气图标，不再随场景变化

      const panel = doc.createElement("div");
      panel.id = IDS.panel;
      panel.className = "oss-panel";
      panel.setAttribute("role", "dialog");
      panel.setAttribute("aria-label", copy.title);
      panel.hidden = true;
      panel.innerHTML = [
        '<div class="oss-head"><span class="oss-title">' + copy.title + '</span>',
        '<button type="button" class="oss-close" aria-label="' + copy.close + '">×</button></div>',
        // ---- 首层：四格模式小框 ----
        // 上方两个是「开关」（点一下立即生效），下方两个是「展开」（往上展开更多内容）。
        //   纯壁纸模式 / 纯自演化：开关
        //   其他地形：往【左边】展开一个子面板（草地相关）
        //   调试模式：在本面板内往【上方】展开滑块长条
        '<div class="oss-modes4">',
        '<button type="button" class="oss-mode-btn oss-immersive" aria-pressed="false">☁ ' + copy.wallpaperMode + '</button>',
        '<button type="button" class="oss-mode-btn oss-evolve" aria-pressed="false">🌤 ' + copy.evolveMode + '</button>',
        '<button type="button" class="oss-mode-btn oss-terrain-btn" aria-expanded="false">🏔 ' + copy.otherTerrain + '<span class="oss-caret">◂</span></button>',
        '<button type="button" class="oss-mode-btn oss-debug-btn" aria-expanded="false">⚙ ' + copy.debug + '<span class="oss-caret">▴</span></button>',
        '</div>',
        // ---- 调试滑块长条（默认收起）----
        // 与四格框之间留 1mm 缝（CSS .oss-debug 的 margin-top:1mm）。
        // 每个分组是一个 <details>，默认全收起，点标题才展开各自的滑块。
        '<div class="oss-debug" hidden>',
        '<details class="oss-fold" open><summary>' + copy.ocean + '</summary><div class="oss-fold-body">',
        '<div class="oss-switch"><label for="oss-enabled">' + copy.enable + '</label>',
        '<input type="checkbox" id="oss-enabled" /></div>',
        // 只关海面：天空、日月、星星、云和天气全部保留，
        // 关掉后这块画面变成完整天空，可以把位置让给其他地形或壁纸。
        '<div class="oss-switch"><label for="oss-sea-visible">' + copy.seaVisible + '</label>',
        '<input type="checkbox" id="oss-sea-visible" /></div>',
        // 波浪 / 日光 一行平分
        '<div class="oss-pair">',
        '<div class="oss-pair-item">',
        '<div class="oss-row"><span class="oss-label" id="oss-sea-label">' + copy.sea + '</span>',
        '<span class="oss-value" id="oss-sea-value"></span></div>',
        '<input type="range" id="oss-sea" min="0" max="100" step="1" aria-labelledby="oss-sea-label" />',
        '</div>',
        '<div class="oss-pair-item">',
        '<div class="oss-row"><span class="oss-label" id="oss-time-label">' + copy.time + '</span></div>',
        '<input type="range" id="oss-time" min="0" max="100" step="1" aria-labelledby="oss-time-label" />',
        '</div>',
        '</div>',
        '<div class="oss-switch"><label for="oss-cycle">' + copy.autoCycle + '</label>',
        '<input type="checkbox" id="oss-cycle" /></div>',
        // 玻璃 + 时间流逝，各占半格
        '<div class="oss-pair">',
        '<div class="oss-pair-item">',
        '<div class="oss-row"><span class="oss-label" id="oss-glass-label">' + copy.glass + '</span>',
        '<span class="oss-value" id="oss-glass-value"></span></div>',
        '<input type="range" id="oss-glass" min="0" max="95" step="1" aria-labelledby="oss-glass-label" />',
        '</div>',
        '<div class="oss-pair-item">',
        '<div class="oss-row"><span class="oss-label" id="oss-time-scale-label">' + copy.timeScale + '</span>',
        '<span class="oss-value" id="oss-time-scale-value"></span></div>',
        '<input type="range" id="oss-time-scale" min="0" max="100" step="1" aria-labelledby="oss-time-scale-label" />',
        '</div>',
        '</div>',
        '</div></details>',
        // 「闪电只在雨里出现」并进标题括号里，省掉一整行。
        // 单独一行太占地方，而这句话本来就是对「天气」这个分组的注解。
        '<details class="oss-fold" open><summary>' + copy.weather
          + '<span class="oss-summary-note">（' + copy.lightningRainOnly + '）</span>'
          + '</summary><div class="oss-fold-body">',
        // ---- 天气沙盒的三条规则滑杆 ----
        // 它们调的不是「画面」，而是「天气状态」：
        //   温度 → 雨还是雪（0°C 是分界线，滑杆上标出来）
        //   湿度 → 到饱和才下雨
        //   雾量 → 雾浓不浓
        // 效果是这三样算出来的结果，所以下面有状态行告诉你「为什么没下雨」。
        '<div class="oss-pair">',
        '<div class="oss-pair-item">',
        '<div class="oss-row"><span class="oss-label" id="oss-temp-label">' + copy.temp + '</span>',
        '<span class="oss-value" id="oss-temp-value"></span></div>',
        '<input type="range" id="oss-temp" min="0" max="100" step="1" aria-labelledby="oss-temp-label" />',
        '</div>',
        '<div class="oss-pair-item">',
        '<div class="oss-row"><span class="oss-label" id="oss-humid-label">' + copy.humid + '</span>',
        '<span class="oss-value" id="oss-humid-value"></span></div>',
        '<input type="range" id="oss-humid" min="0" max="100" step="1" aria-labelledby="oss-humid-label" />',
        '</div>',
        '</div>',
        // 0°C 参照线：标在温度滑杆的 20% 处（-10..40 的区间里 0°C 正好是 20%）。
        // 用户一眼知道「往左就是下雪」。
        '<p class="oss-note" id="oss-freeze-note"></p>',
        // 「雾量」滑杆已移除：雾模块本身早就不在了（2D 贴屏做不出纵深），
        // 这根滑杆调了没有任何效果，留着只会让人以为能控雾。
        // fogPos 设置项保留 —— 将来雾改成能读地形高度的版本时直接复用。
        // 状态行：直接告诉用户「为什么没下雨」，这是沙盒的仪表盘。
        '<p class="oss-note" id="oss-weather-state"></p>',
        // 闪电：名字本身就是开关，挤在数量/频率两个滑块前面，同一行。
        // 三格布局：[闪电] [数量] [频率] —— 名字不再白占一行。
        '<div class="oss-line">',
        '<button type="button" class="oss-flip" id="oss-lightning-toggle" aria-pressed="false">' + copy.lightning + '</button>',
        '<div class="oss-pair-item">',
        '<div class="oss-row"><span class="oss-label" id="oss-lightning-count-label">' + copy.lightningCount + '</span>',
        '<span class="oss-value" id="oss-lightning-count-value"></span></div>',
        '<input type="range" id="oss-lightning-count" min="1" max="5" step="1" aria-labelledby="oss-lightning-count-label" />',
        '</div>',
        '<div class="oss-pair-item">',
        '<div class="oss-row"><span class="oss-label" id="oss-lightning-freq-label">' + copy.lightningFreq + '</span>',
        '<span class="oss-value" id="oss-lightning-freq-value"></span></div>',
        '<input type="range" id="oss-lightning-freq" min="0" max="100" step="1" aria-labelledby="oss-lightning-freq-label" />',
        '</div>',
        '</div>',
        // 原来这里有一行「闪电只在雨里出现」的独立提示，已并入分组标题的括号里。
        // ---- 云：一个开关 + 五个滑杆，两两并排（2 + 2 + 1） ----
        '</div></details>',
        '<details class="oss-fold" open><summary>' + copy.cloud + '</summary><div class="oss-fold-body">',
        // 「云自动」开关已移除：云的生命周期（凝聚→稳定→消散）由引擎常开，
        // 不再暴露给用户 —— 纯自演化已经在接管云量滑杆，再加一个开关只会让人困惑。
        '<div class="oss-switch"><label for="oss-cloud-enabled">' + copy.cloudEnable + '</label>',
        '<input type="checkbox" id="oss-cloud-enabled" /></div>',
        '<div class="oss-pair">',
        '<div class="oss-pair-item">',
        '<div class="oss-row"><span class="oss-label" id="oss-cloud-amount-label">' + copy.cloudAmount + '</span>',
        '<span class="oss-value" id="oss-cloud-amount-value"></span></div>',
        '<input type="range" id="oss-cloud-amount" min="0" max="150" step="1" aria-labelledby="oss-cloud-amount-label" />',
        '</div>',
        '<div class="oss-pair-item">',
        '<div class="oss-row"><span class="oss-label" id="oss-cloud-density-label">' + copy.cloudDensity + '</span>',
        '<span class="oss-value" id="oss-cloud-density-value"></span></div>',
        '<input type="range" id="oss-cloud-density" min="0" max="100" step="1" aria-labelledby="oss-cloud-density-label" />',
        '</div>',
        '</div>',
        '<div class="oss-pair">',
        '<div class="oss-pair-item">',
        '<div class="oss-row"><span class="oss-label" id="oss-cloud-unite-label">' + copy.cloudUnite + '</span>',
        '<span class="oss-value" id="oss-cloud-unite-value"></span></div>',
        '<input type="range" id="oss-cloud-unite" min="0" max="100" step="1" aria-labelledby="oss-cloud-unite-label" />',
        '</div>',
        '<div class="oss-pair-item">',
        '<div class="oss-row"><span class="oss-label" id="oss-cloud-opacity-label">' + copy.cloudOpacity + '</span>',
        '<span class="oss-value" id="oss-cloud-opacity-value"></span></div>',
        '<input type="range" id="oss-cloud-opacity" min="0" max="100" step="1" aria-labelledby="oss-cloud-opacity-label" />',
        '</div>',
        '</div>',
        // 第五个单独占半格，右半留空，保持和上面两行的宽度一致
        '<div class="oss-pair">',
        '<div class="oss-pair-item">',
        '<div class="oss-row"><span class="oss-label" id="oss-cloud-wind-label">' + copy.cloudWind + '</span>',
        '<span class="oss-value" id="oss-cloud-wind-value"></span></div>',
        '<input type="range" id="oss-cloud-wind" min="0" max="100" step="1" aria-labelledby="oss-cloud-wind-label" />',
        '</div>',
        '</div>',
        // ---- 光：一个开关 + 两个滑杆 ----
        // 光效本身是自动跟随太阳的：位置、颜色、地平线消失都由引擎每帧从 env.sunDir 取，
        // 面板不提供「让它跟着太阳走」的开关，因为那本来就不是用户该管的事。
        // 采样步数属于性能参数，散射密度范围太窄调不出差别，两者都不暴露给用户，
        // 走引擎内部默认值。
        '</div></details>',
        '<details class="oss-fold" open><summary>' + copy.sun + '</summary><div class="oss-fold-body">',
        // 第一行：太阳光效开关 + 星星亮度，各占一半。
        // 星星亮度不在光效开关的管辖范围内，但它在视觉上属于「天上的光」，
        // 放在同一行既省一行高度，也方便一起调。
        '<div class="oss-pair">',
        '<div class="oss-pair-item">',
        '<div class="oss-switch"><label for="oss-sun-enabled">' + copy.sunEnable + '</label>',
        '<input type="checkbox" id="oss-sun-enabled" /></div>',
        '</div>',
        '<div class="oss-pair-item">',
        '<div class="oss-row"><span class="oss-label" id="oss-star-bright-label">' + copy.starBright + '</span>',
        '<span class="oss-value" id="oss-star-bright-value"></span></div>',
        '<input type="range" id="oss-star-bright" min="0" max="100" step="1" aria-labelledby="oss-star-bright-label" />',
        '</div>',
        '</div>',
        // 第二行：太阳亮度 + 月亮亮度 + 光晕半径，三格并排。
        // 原来这里只有「太阳亮度 + 光晕半径」两格，太阳那根滑杆一拆为二：
        //   太阳亮度 → sunDiscScale（引擎里本来就是它）
        //   月亮亮度 → moonDiscScale（新增，原来月亮根本没有独立的亮度控制）
        // oss-trio 让这一行排三列，滑块自然变短 —— 面板太宽了，必须挤。
        '<div class="oss-pair oss-trio">',
        '<div class="oss-pair-item">',
        '<div class="oss-row"><span class="oss-label" id="oss-sun-bright-label">' + copy.sunGlow + '</span>',
        '<span class="oss-value" id="oss-sun-bright-value"></span></div>',
        '<input type="range" id="oss-sun-bright" min="0" max="100" step="1" aria-labelledby="oss-sun-bright-label" />',
        '</div>',
        '<div class="oss-pair-item">',
        '<div class="oss-row"><span class="oss-label" id="oss-moon-bright-label">' + copy.moonBright + '</span>',
        '<span class="oss-value" id="oss-moon-bright-value"></span></div>',
        '<input type="range" id="oss-moon-bright" min="0" max="100" step="1" aria-labelledby="oss-moon-bright-label" />',
        '</div>',
        '<div class="oss-pair-item">',
        '<div class="oss-row"><span class="oss-label" id="oss-sun-radius-label">' + copy.sunGlowRadius + '</span>',
        '<span class="oss-value" id="oss-sun-radius-value"></span></div>',
        '<input type="range" id="oss-sun-radius" min="0" max="100" step="1" aria-labelledby="oss-sun-radius-label" />',
        '</div>',
        '</div>',
        '</div></details>',   // 关闭光组的 fold-body + details
        // 草地相关控件已移到左侧独立子面板（见下方 grassPanel），
        // 这里不再占主面板空间。
        '</div>',   // 关闭 .oss-debug
        '<div class="oss-foot"><span class="oss-hint" id="oss-hint">v' + VERSION + '</span>',
        // 左：把当前参数存成一个命名配方；右：打开配方列表。
        // 「恢复默认」已移除 —— 它背后的 USER_DEFAULTS 从没被设置过，等于没用。
        // 恢复出厂值改成配方列表的第一项，永远在那儿。
        '<span class="oss-foot-actions">',
        '<button type="button" class="oss-save oss-recipe-save">保存配方</button>',
        '<button type="button" class="oss-reset oss-recipe-open">配方 ▾</button>',
        '</span></div>',
        // 纯壁纸 / 纯自演化 两个开关已移到面板顶部的四格小框里，这里不再重复。
      ].join("");

      // ---- 左侧子面板：其他地形（草地相关）----
      // 紧挨主面板左边缘弹出，不遮挡主面板。
      // 底部同样带「设为默认 / 恢复默认」，只针对草地这几项。
      const grassPanel = doc.createElement("div");
      grassPanel.className = "oss-subpanel";
      // 初始隐藏：用行内 display，不用 hidden 属性。
      // 全文件只有这一套状态（display 显式 "block"/"none"），不再让 hidden
      // 和 CSS 的 [hidden]{display:none!important} 一起参与判断 —— 两者各管一半
      // 就会互相打架，表现成「点开之后收不回去」。
      grassPanel.style.display = "none";
      grassPanel.innerHTML = [
        // ---- 草地 ----
        // 独立地形层：和海洋同一条管线、同一套日光与风，但自己管理自己的绘制。
        // 开关默认关，勾上才长草 —— 不偷改现有观感。
        '<div class="oss-section"><div class="oss-section-title">' + copy.ground + '</div>',
        '<div class="oss-switch"><label for="oss-ground-visible">' + copy.groundVisible + '</label>',
        '<input type="checkbox" id="oss-ground-visible" /></div>',
        // 草密度 / 花密度并排
        '<div class="oss-pair">',
        '<div class="oss-pair-item">',
        '<div class="oss-row"><span class="oss-label" id="oss-ground-density-label">' + copy.groundDensity + '</span>',
        '<span class="oss-value" id="oss-ground-density-value"></span></div>',
        '<input type="range" id="oss-ground-density" min="0" max="100" step="1" aria-labelledby="oss-ground-density-label" />',
        '</div>',
        '<div class="oss-pair-item">',
        '<div class="oss-row"><span class="oss-label" id="oss-flower-density-label">' + copy.flowerDensity + '</span>',
        '<span class="oss-value" id="oss-flower-density-value"></span></div>',
        '<input type="range" id="oss-flower-density" min="0" max="100" step="1" aria-labelledby="oss-flower-density-label" />',
        '</div>',
        '</div>',
        // 积雪 / 湿润：手动覆盖，用来直接看到效果，也可以拉回 0 交还给天气。
        '<div class="oss-pair">',
        '<div class="oss-pair-item">',
        '<div class="oss-row"><span class="oss-label" id="oss-snow-cover-label">' + copy.snowCover + '</span>',
        '<span class="oss-value" id="oss-snow-cover-value"></span></div>',
        '<input type="range" id="oss-snow-cover" min="0" max="100" step="1" aria-labelledby="oss-snow-cover-label" />',
        '</div>',
        '<div class="oss-pair-item">',
        '<div class="oss-row"><span class="oss-label" id="oss-wetness-label">' + copy.wetness + '</span>',
        '<span class="oss-value" id="oss-wetness-value"></span></div>',
        '<input type="range" id="oss-wetness" min="0" max="100" step="1" aria-labelledby="oss-wetness-label" />',
        '</div>',
        '</div>',
        '</div>',
        // ---- 主体模块（试验阶段）----
        // 默认开。关掉就回到纯天气沙盒 —— 没有人看着你。
        '<div class="oss-section"><div class="oss-section-title">主体模块 <span style="opacity:.55;font-weight:400">（试验阶段）</span></div>',
        '<div class="oss-switch"><label for="oss-pet-on">世界生灵</label>',
        '<input type="checkbox" id="oss-pet-on" checked /></div>',
        '<div class="oss-switch"><label></label>',
        '<button type="button" class="oss-save oss-pet-scenery" style="cursor:pointer">看风景</button>',
        '<button type="button" class="oss-save oss-pet-sleep" style="cursor:pointer">睡觉与做梦</button></div>',
        '<div class="oss-switch"><label></label>',
        '<button type="button" class="oss-save oss-pet-name" style="cursor:pointer">起个名字</button>',
        '<button type="button" class="oss-save oss-pet-diary" style="cursor:pointer">做梦日记</button></div>',
        '</div>',
        // 子面板不放保存按钮：配方统一在主面板底部。
        // 之前这里有一套独立的「设为默认 / 恢复默认」，只存草地那几项，
        // 和主面板的配方必然打架 —— 用户切配方时草地不动，看着就像「配方只生效了一半」。
        '<div class="oss-foot"><span class="oss-hint">' + copy.otherTerrain + '</span></div>',
      ].join("");

      const host = doc.body || doc.documentElement;
      // 子面板挂 body，不挂主面板内部：
      //   主面板有 overflow-y:auto + backdrop-filter，绝对/固定定位的子面板
      //   要么被裁剪、要么参考系错乱。
      // 代价是主面板那套 `#panelId .xxx` 的样式管不到它，
      // 所以下面单独给它补了一份完整样式（见 .oss-subpanel 那段 CSS）。
      host.append(fab, panel, grassPanel);

      // 草地控件已移到独立的左侧子面板，所以查询要同时在两个面板里找。
      // 先查主面板（绝大多数控件在这），查不到再查子面板。
      const q = (selector) => panel.querySelector(selector) || grassPanel.querySelector(selector);
      const enabledBox = q("#oss-enabled");
      const seaVisibleBox = q("#oss-sea-visible");
      const groundVisibleBox = q("#oss-ground-visible");
      const groundDensityRange = q("#oss-ground-density");
      const groundDensityValue = q("#oss-ground-density-value");
      const flowerDensityRange = q("#oss-flower-density");
      const flowerDensityValue = q("#oss-flower-density-value");
      const snowCoverRange = q("#oss-snow-cover");
      const snowCoverValue = q("#oss-snow-cover-value");
      const wetnessRange = q("#oss-wetness");
      const wetnessValue = q("#oss-wetness-value");
      const seaRange = q("#oss-sea");
      const seaValue = q("#oss-sea-value");
      const timeRange = q("#oss-time");
      const cycleBox = q("#oss-cycle");
      const glassRange = q("#oss-glass");
      const glassValue = q("#oss-glass-value");
      const timeScaleRange = q("#oss-time-scale");
      const timeScaleValue = q("#oss-time-scale-value");
      const tempRange = q("#oss-temp");
      const tempValue = q("#oss-temp-value");
      const humidRange = q("#oss-humid");
      const humidValue = q("#oss-humid-value");
      // 雾量滑杆已从面板移除，这里不再取它的 DOM 节点。
      const freezeNote = q("#oss-freeze-note");
      const weatherStateNote = q("#oss-weather-state");
      const lightningBox = q("#oss-lightning-toggle");
      const lightningFreqRange = q("#oss-lightning-freq");
      const lightningFreqValue = q("#oss-lightning-freq-value");
      const lightningCountRange = q("#oss-lightning-count");
      const lightningCountValue = q("#oss-lightning-count-value");

      // ---- 云控件：直接改引擎里的 CLOUD，不再走消息
      const cloudEnabledBox = q("#oss-cloud-enabled");
      const cloudAmount = q("#oss-cloud-amount");
      const cloudAmountValue = q("#oss-cloud-amount-value");
      const cloudDensity = q("#oss-cloud-density");
      const cloudDensityValue = q("#oss-cloud-density-value");
      const cloudUnite = q("#oss-cloud-unite");
      const cloudUniteValue = q("#oss-cloud-unite-value");
      const cloudOpacity = q("#oss-cloud-opacity");
      const cloudOpacityValue = q("#oss-cloud-opacity-value");
      const cloudWind = q("#oss-cloud-wind");
      const cloudWindValue = q("#oss-cloud-wind-value");

      // 引擎是异步加载的，两个推送口都要「等它起来再推」。
      // 这段等待/重试逻辑原来在 pushCloud 和 pushSun 里各抄了一份，收成一处。
      // 返回 true 表示引擎已就绪、可以继续推；false 表示还在等（已排好重试）。
      function waitForEngine(fn, retry) {
        if (typeof fn === "function") return true;
        // 最多等 5 秒（25 × 200ms），避免引擎真的失败时无限重试。
        if (retry.count < 25) {
          retry.count += 1;
          win.setTimeout(retry.fn, 200);
        }
        return false;
      }

      // 云面板的当前值，和 CLOUD 对象分开存：关掉云之后滑杆位置要留在原处
      // opacity：0 = 全透明，100 = 最实（与引擎里的映射一致，默认拉满才看得见云）
      // 初值一律从存储取，绝不能再写死 —— 写死就是「重启归零」的根。
      // 老用户第一次升级时 v1 里没有这几个键，normalize 会用 DEFAULTS 补上，
      // 补的正是原来写死的那组（150 / 0 / 0 / 100 / 100 / true），画面不变。
      function cloudFromSettings() {
        const s = readSettings();
        return {
          enabled: s.cloudEnabled,
          auto: s.cloudAuto,
          amount: s.cloudAmount,
          density: s.cloudDensity,
          unite: s.cloudUnite,
          opacity: s.cloudOpacity,
          wind: s.cloudWind,
        };
      }
      const cloudUI = cloudFromSettings();
      const cloudRetry = { count: 0, fn: () => pushCloud() };

      // 驱动层推云的平滑量：0..1，一阶低通。
      // 气压信号本身在 2 秒拍里就会抖动，直接把 (fall - rise)*30 推给云量，
      // 云量会每拍跳 ±30 → mask 跳 → 太阳透光跳 → 用户看到「太阳在闪」。
      // 这里把推拉量压成慢变量（每拍只走 15%），云量变成缓慢漂移而不是阶梯跳。
      let cloudDrivePush = 0;

      // 上一次推出去的云量目标。驱动层每 2 秒会调一次 pushCloud，
      // 如果每次都无脑 __ossCloudSet，引擎的 CLOUD.level 会不停重新缓动，
      // 整片云一直在「追目标」，天空持续微抖 —— 云背后的月亮星星就跟着时隐时现。
      // 目标没变就不推，让引擎自己跑完缓动后静止下来。
      let lastCloudAmount = NaN;

      function pushCloud(force) {
        if (!waitForEngine(win.__ossCloudSet, cloudRetry)) return;
        cloudRetry.count = 0;
        if (!cloudUI.enabled) {
          win.__ossCloudSet({ enabled: false });
          return;
        }
        // 闪电连锁 · 云这一路。
        //   平时 / 闪电关：原样推用户的值 + 气压升降微调（平滑后）
        //   雷雨昏暗    ：amount 150、density 100、wind 100、storm 1（云色压成铅灰）
        // 雷雨昏暗只「压暗」，不改形状：团结度/透明度保持用户设置。
        // 逐参数判断：被你接管的那个用你的值，其余照常联动。
        // 「!taken.x ? 联动值 : 用户值」—— 用户没碰过就按联动走。
        if (stormDim < 0.5) {
          // 驱动层接入：气压降 → 生云、气压升 → 散云。
          // 只加在「用户没接管 amount」时，幅度收敛到 ±12（原来是 ±30，那会让云量
          // 每拍跳一大截，太阳被闪）；再经 cloudDrivePush 低通过滤。
          const press = getPressureSignal();
          const target = taken.amount ? 0 : (press.fall - press.rise) * 12;
          // 平滑后再钳一次。
          // 没有上限的话，气压长期单向（比如一直上升）会让 cloudDrivePush 一路漂到
          // 负几十甚至上百，把用户的云量整个抵消掉 —— 表现就是「云完全没了」。
          // ±30 是「气压能把云推走多少」的合理范围，再多就该由用户滑杆决定。
          cloudDrivePush += (target - cloudDrivePush) * 0.15;
          cloudDrivePush = Math.max(-30, Math.min(30, cloudDrivePush));
          // 夜云衰减：入夜后天上的云淡下去，月亮和星星才有机会露出来。
          // 但只在用户「没接管云量」时生效 —— 用户拉过滑竿就说明他要的就是这个量，
          // 夜里悄悄把他设的 100 压成 55 是越权（铁律：不碰用户滑杆）。
          let nightFactor = 1;
          if (!taken.amount) {
            const day = readInput("__ossState", (s) => (s ? s.daylight / 100 : NaN));
            if (day.ok) {
              // 太阳低于 30% 开始让云变薄，10% 以下完全生效
              nightFactor = 0.55 + 0.45 * Math.min(1, Math.max(0, (day.value - 0.10) / 0.20));
            }
          }
          const nextAmount = Math.min(150, Math.max(0, (cloudUI.amount + cloudDrivePush) * nightFactor));
          // 目标没变（<0.5 的差异）就不重复推：引擎那边的缓动已经到位，再推只会让它一直抖
          if (force !== true && Math.abs(nextAmount - lastCloudAmount) < 0.5) return;
          lastCloudAmount = nextAmount;
          win.__ossCloudSet({
            ...cloudUI,
            amount: nextAmount,
            storm: 0,
          });
          return;
        }
        win.__ossCloudSet({
          ...cloudUI,
          amount: taken.amount ? cloudUI.amount : 150,
          density: taken.density ? cloudUI.density : 100,
          wind: taken.wind ? cloudUI.wind : 100,
          // storm 必须保持 0。
          // 引擎里 clearSky = 1 - uCloudStorm 同时乘在星星和月亮上：
          //   col += starField(d, uv, dark * clearSky)
          //   col += moonLight(d, clearSky) * uMoonDiscScale
          // 一旦 storm 变 1，clearSky = 0，月亮和星星直接乘没了 ——
          // 而且雷雨状态是常驻的（闪电开 + 雨），整段夜晚都没有天体。
          // 所以「雷雨昏暗」只用光效那一路（pushSun 里 dim 压太阳），不碰 storm。
          // storm 只在真正的雷暴态才该亮，那由驱动层的上升气流另行判断。
          storm: 0,
        });
      }

      function renderCloud() {
        if (cloudEnabledBox) cloudEnabledBox.checked = cloudUI.enabled;
        if (cloudAmount) cloudAmount.value = String(cloudUI.amount);
        if (cloudAmountValue) cloudAmountValue.textContent = String(cloudUI.amount);
        if (cloudDensity) cloudDensity.value = String(cloudUI.density);
        if (cloudDensityValue) cloudDensityValue.textContent = String(cloudUI.density);
        if (cloudUnite) cloudUnite.value = String(cloudUI.unite);
        if (cloudUniteValue) cloudUniteValue.textContent = String(cloudUI.unite);
        if (cloudOpacity) cloudOpacity.value = String(cloudUI.opacity);
        if (cloudOpacityValue) cloudOpacityValue.textContent = String(cloudUI.opacity);
        if (cloudWind) cloudWind.value = String(cloudUI.wind);
        if (cloudWindValue) cloudWindValue.textContent = String(cloudUI.wind);
      }

      function bindCloud(node, key, type) {
        if (!node) return;
        node.addEventListener(type || "input", () => {
          cloudUI[key] = Number(node.value);
          // 只接管这一个参数，其余照常联动
          if (key in taken) taken[key] = true;
          // 立刻落盘：这是原来缺的那一句。没有它，滑杆只改内存，重启就没了。
          commit({ ["cloud" + key.charAt(0).toUpperCase() + key.slice(1)]: cloudUI[key] });
          pushCloud(true);
          renderCloud();
        });
      }
      bindCloud(cloudAmount, "amount");
      bindCloud(cloudDensity, "density");
      bindCloud(cloudUnite, "unite");
      bindCloud(cloudOpacity, "opacity");
      bindCloud(cloudWind, "wind");
      if (cloudEnabledBox) {
        cloudEnabledBox.addEventListener("change", () => {
          cloudUI.enabled = cloudEnabledBox.checked;
          // 显隐也要落盘：不然你关掉云，重启后它又自己冒出来
          commit({ cloudEnabled: cloudUI.enabled });
          pushCloud(true);
          renderCloud();
        });
      }
      // 「云自动」UI 已移除（见渲染处的说明）。cloudUI.auto 仍从设置读，
      // 恒为默认 true，引擎那边的云生命周期照常跑。

      // ---- 光控件：只保留开关 + 光晕强度 + 光晕半径 ----
      // 滑杆统一 0..100，推给引擎前按各自区间换算；引擎侧 __ossSunSet 还会再钳一次。
      // 散射密度 / 采样步数不再暴露：前者范围窄调不出差别，后者是性能参数不该给用户。
      const sunEnabledBox = q("#oss-sun-enabled");
      const sunGlow = q("#oss-sun-glow");
      const sunGlowValue = q("#oss-sun-glow-value");
      // 太阳亮度：直接控制太阳本体（sunDiscScale），原来没有独立滑杆
      const sunBrightRange = q("#oss-sun-bright");
      const sunBrightValue = q("#oss-sun-bright-value");
      // 月亮亮度：控制月亮本体 + 月光反光（moonDiscScale），新增
      const moonBrightRange = q("#oss-moon-bright");
      const moonBrightValue = q("#oss-moon-bright-value");
      // 星星亮度滑杆：独立于太阳那一路
      const starBrightRange = q("#oss-star-bright");
      const starBrightValue = q("#oss-star-bright-value");
      const sunRadius = q("#oss-sun-radius");
      const sunRadiusValue = q("#oss-sun-radius-value");

      // 滑杆位置（0..100）与真实值分开存：开关关掉后位置要留在原处
      // radius 区间 0..0.3，位置 33 就是 0.099；0.1 落在位置 33.33，取 33 最接近实测最佳。
      // 默认值：亮度滑杆 50 → sunDiscScale 1.0（标准），半径滑杆 67 → 0.012。
      // 半径上限 0.018 —— 再大光晕就占半个屏幕，不像太阳了。
      // 亮度别设低于 15（=0.3），太阳会淹没在天空底色里看不见。
      // sunBright / moonBright 是滑杆位置 0..100，换算成 0..2 倍。
      // 50 = 1.0 倍（标准）。太阳本体 1.0 就是引擎默认；月亮 1.0 是原样。
      // 四根滑杆的位置全部从存储取，不再写死。老用户第一次升级时 v1 里没有
      // 这几个键，normalize 会补成 DEFAULTS（50 / 50 / 6 / 100），和原来一致。
      const _sunSaved = readSettings();
      const sunUI = {
        enabled: true,
        glow: _sunSaved.glow,
        radius: _sunSaved.radius,
        sunBright: _sunSaved.sunBright,
        moonBright: _sunSaved.moonBright,
      };
      // 「太阳亮度」滑杆 = 在原有的 sunDiscScale 上乘一个倍率（0..2，50 = 1.0）。
      // 注意：sunDiscScale 的取值仍然沿用历史写法（接光晕值），不要替换它，
      // 只允许乘倍率。替换过一次，太阳直接放大 8~11 倍、光晕消失。
      // glowIntensity 一律不推，让引擎保留默认 1.0，光晕才和原来一样。
      const sunRetry = { count: 0, fn: () => pushSun() };
      // 雨雾柔化的平滑值：0..1，一阶低通。太阳只跟它的慢趋势，不跟单拍噪声。
      let wetSmooth = 0;

      const SUN_MAP = {
        glow: [0, 2],
        radius: [0, 0.018],
        sunBright: [0, 2],
        moonBright: [0, 2],
      };
      // 半开区间换算：pos/100 取到 0.99 时，radius 得 0.297，不会越界
      function sunReal(key, pos) {
        const range = SUN_MAP[key];
        const t = Math.min(100, Math.max(0, Number(pos) || 0)) / 100;
        return range[0] + (range[1] - range[0]) * t;
      }
      // 千分位取整，避免浮点算出 0.09900000000000001 这类值显示成异常数字
      const sunRadiusLabel = (pos) => (Math.round(sunReal("radius", pos) * 1000) / 1000).toFixed(3);

      // 地形反射率的读口。pushSun 在 apply 早期就会被 paint() 调用，
      // 那时 TERRAIN_LABELS / driveTerrain 还没声明（const/let 的 TDZ 会直接抛错）。
      // 用 var 占位提前给出默认值，等驱动层落地后再由 syncTerrainReflect 填充。
      var terrainReflectRef = { reflectivity: 1.0, terrain: "ocean" };
      function syncTerrainReflect() {
        const labels = TERRAIN_LABELS[driveTerrain];
        if (labels && Number.isFinite(labels.reflectivity)) {
          terrainReflectRef.reflectivity = labels.reflectivity;
          terrainReflectRef.terrain = driveTerrain;
        }
      }

      function pushSun() {
        if (!waitForEngine(win.__ossSunSet, sunRetry)) return;
        sunRetry.count = 0;
        // 闪电连锁 · 光这一路（完整链路见 paint 上方的大段注释）。
        // 雷雨昏暗时太阳钻进云里：本体 ×0.3、光晕 ×0.35、光束 ×0.35。
        // 光效开关（sunUI.enabled）始终由用户说了算，昏暗态只乘系数，不强行关掉。
        // 雷暴压暗强度 0..1（已平滑）。0 = 不压，1 = 压到最暗。
        const dim = stormDim;
        // 雨反哺光：雨大时空气里全是水，太阳被雨幕「柔化」而不是「吞掉」——
        //   光晕变大变弥散（水滴散射，不是云遮挡），
        //   本体和光束略降，但保留轮廓。
        // 这和闪电的「压没」是两种氛围：雨是朦胧，闪电是吞噬。
        // 光晕仍然锁在面板滑杆的 0.018 上限内（那是原作者划的「再大就占半个屏幕」），
        // 雨雾只把它推到上限，不突破。
        // ⚠ 必须平滑：downpour 是雨量预算除以 2800 的瞬时值，会随云量、气压降
        // 甚至一帧的滴数重建而抖动。直接拿它乘光效 = 太阳每秒闪好几次。
        // 这里用一阶低通把 wet 压成慢变量（约 1.5 秒跟到位），太阳只随雨势的
        // 大趋势变化，不随单拍噪声跳。
        const rawWet = Math.max(0, Math.min(1, engine.getDownpour()));
        wetSmooth += (rawWet - wetSmooth) * 0.12;
        if (Math.abs(rawWet - wetSmooth) < 0.002) wetSmooth = rawWet;
        const wet = wetSmooth;
        const baseGlow = sunReal("glow", sunUI.glow);
        const baseRadius = sunReal("radius", sunUI.radius);
        // 「太阳亮度」滑杆的倍率（0..2，50 = 1.0）。
        // 它同时作用于太阳本体（sunDiscScale）和环境光（effectGlobalScale），
        // 这样拉高才会「整个场景亮起来」，而不是只有太阳变刺眼。
        const lightK = sunReal("sunBright", sunUI.sunBright);
        // 地形反射率（光读地形标签）：反射率高的地面把光打回来，光效更亮；
        // 沙漠吸光，光就压下去。系数只作用在光晕与光束上，不动太阳本体尺寸
        // （本体尺寸动一次就会穿帮，见下面 sunDiscScale 的说明）。
        const reflectivity = terrainReflectRef.reflectivity;
        // 0..1 → 0.72..1.10：海面(1.0)略亮、森林(0.6)中性、沙漠(0.35)压暗
        const reflectK = 0.72 + reflectivity * 0.38;
        // 先在「用户值」上叠雨雾柔化，再叠闪电的吞没，两者不互相覆盖
        // 【雨不再压暗】暗不暗只由云量决定。
        // 原来这里乘了 (1 - 0.25*wet)：下雨就压光晕、压环境光，雨一停立刻弹亮 ——
        // 那就是「阴天一瞬间变晴」的来源。湿度和亮度是两条独立的物理量，
        // 不该让雨势直接拧灯泡。云多了自然就暗，那是云该管的事。
        // 保留的只有「雨雾柔化」：光晕变大变弥散（水滴散射），这是可见的物理现象，
        // 而且它只改形状不改亮度，不会让画面忽明忽暗。
        const glowAfterRain = baseGlow * reflectK;
        const radiusAfterRain = Math.min(0.018, baseRadius * (1 + 2.2 * wet));
        // 光效开关是用户明确的指令，联动不能把它压到「看着像没开」。
        // 原来的 0.35 在昏暗画面里几乎不可见，用户会以为勾选框坏了。
        // 打开时给 0.75：依然明显弱于晴天，但一眼能看出「开了」。
        // 光晕半径也不归零（原来直接设 0），保留一个小半径，开关才有可见的落点。
        win.__ossSunSet({
          // 原样保留：太阳本体接的是光晕值（历史如此），别动它。
          // 动过一版会直接把太阳放大 8 倍、光晕消失，肉眼立刻能看出穿帮。
          // 「太阳亮度」滑杆只是在它上面乘一个倍率（默认 1.0 = 完全不变），
          // 不再是替换值。这样默认状态下和改动之前逐像素一致。
          // 压暗改成按 dim 插值：0 时原样，1 时压到 60%（原来直接 30%，太狠了）。
          sunDiscScale: glowAfterRain * (1 - 0.4 * dim) * sunReal("sunBright", sunUI.sunBright),
          glowRadius: baseRadius * (1 - 0.25 * dim) * (1 + 2.2 * wet),
          // 月亮亮度：0..2 倍，50 = 1.0（原样）。
          // 引擎在 moonLight 的调用处乘它，整体缩放月盘 / 月晕 / 大气辉光，
          // 不碰月亮的几何计算，所以既不会糊，也不会消失。
          moonDiscScale: sunReal("moonBright", sunUI.moonBright),
          // 开关只关光晕和光束，太阳本体不受影响 ——
          // 太阳是本来就该在天上的天体，不该被一个「光效」开关抹掉。
          //
          // 【环境光也受「太阳亮度」影响 —— 这是「环境光不够给力」的正解】
          // effectGlobalScale 在着色器里就是 uLightGlobal，它是：
          //   · 天光项 skyLight * 0.85 * (0.45 + 0.55 * uLightGlobal)
          //   · 草/地面的 shadeLight
          // 也就是说【只有它能整体提亮环境】，而太阳亮度滑杆原来只作用于太阳本体
          // （sunDiscScale），所以拉高只会让太阳刺眼，草和地面还是暗的。
          // 现在把太阳亮度的倍率（0..2，默认 1.0）也乘进来：
          //   50 → 1.0 倍（和以前完全一致）
          //   100 → 2 倍环境光（引擎侧 clamp 到 1.8，防止草地过曝）
          // 环境光不再随雨势变化：只由用户滑杆和雷暴压暗决定。
          effectGlobalScale: sunUI.enabled ? lightK * (1 - 0.35 * dim) : 0,
        });
      }

      function renderSun() {
        if (sunEnabledBox) sunEnabledBox.checked = sunUI.enabled;
        if (sunGlow) sunGlow.value = String(sunUI.glow);
        if (sunGlowValue) sunGlowValue.textContent = sunReal("glow", sunUI.glow).toFixed(2);
        if (sunBrightRange) sunBrightRange.value = String(sunUI.sunBright);
        if (sunBrightValue) sunBrightValue.textContent = sunReal("sunBright", sunUI.sunBright).toFixed(2);
        if (moonBrightRange) moonBrightRange.value = String(sunUI.moonBright);
        if (moonBrightValue) moonBrightValue.textContent = sunReal("moonBright", sunUI.moonBright).toFixed(2);
        if (sunRadius) sunRadius.value = String(sunUI.radius);
        // 半径区间是 0..0.3，用千分位取整后固定三位显示，33 → 0.099
        if (sunRadiusValue) sunRadiusValue.textContent = sunRadiusLabel(sunUI.radius);
      }

      function bindSun(node, key) {
        if (!node) return;
        node.addEventListener("input", () => {
          sunUI[key] = Number(node.value);
          // 光滑杆归用户管：动了就接管这一路（云那边照常联动）
          taken.sun = true;
          // 落盘：太阳亮度和月亮亮度都要记住，不然重启归零。
          // 光晕和半径本来就没存，这次一并存上，面板上所有滑杆总算都在 v1 里了。
          commit({ [key]: sunUI[key] });
          pushSun();
          renderSun();
        });
      }
      bindSun(sunGlow, "glow");
      bindSun(sunRadius, "radius");
      bindSun(sunBrightRange, "sunBright");
      bindSun(moonBrightRange, "moonBright");

      // ---- 星星亮度：独立一路，不受太阳联动（雷雨昏暗、用户接管）影响 ----
      // 位置 0..100 直接映射成引擎里 0..1 的稠密度，默认 55。
      // 初值从存储取（和云那批一样），不然每次重启都回到 55，用户调好的亮度白调。
      const starUI = { bright: readSettings().starBright };
      const starRetry = { count: 0, fn: () => pushStar() };
      function pushStar() {
        if (!waitForEngine(win.__ossStarSet, starRetry)) return;
        starRetry.count = 0;
        win.__ossStarSet(starUI.bright / 100);
      }
      function renderStar() {
        if (starBrightRange) starBrightRange.value = String(starUI.bright);
        if (starBrightValue) starBrightValue.textContent = String(starUI.bright) + "%";
      }
      if (starBrightRange) {
        starBrightRange.addEventListener("input", () => {
          starUI.bright = Number(starBrightRange.value);
          // 落盘：这是原来缺的那一句，星星滑杆以前只改内存。
          commit({ starBright: starUI.bright });
          pushStar();
          renderStar();
        });
      }
      renderStar();
      pushStar();
      if (sunEnabledBox) {
        sunEnabledBox.addEventListener("change", () => {
          sunUI.enabled = sunEnabledBox.checked;
          // 勾选框也算用户自己动手，交给用户
          taken.sun = true;
          pushSun();
          renderSun();
        });
      }

      // ======================================================================
      //  驱动层 · 第 1 场：温度
      //  设计原则：以观感为准，不做完整物理模拟。
      //  温度 = 辐射/昼夜（直读 daylight）− 云遮（直读 mask）+ 地形热容（一阶松弛）
      //  刻意不做的两项：
      //    T⁴ 长波辐射  —— ±5°C 范围内与线性的差异 <2%，肉眼不可见
      //    2~3 小时热惯性 —— 60 秒一轮的昼夜循环下没有可观察意义
      //  错误处理：坏输入返回 NaN 并打 [drive_bad_input]，不静默填默认值；
      //            连坏 3 拍降级、连好 2 拍恢复；探针 DRIVE_DEBUG 默认 null（零注入）。
      // ======================================================================

      const DRIVE_LOG = "[dsh-weather-sandbox:drive]";
      const DRIVE_DEBUG = null;   // null = 不注入探针；调试改成 "TEMP"

      const DRIVE_CONFIG = Object.freeze({
        grid: 16,                 // 数组按 grid*grid 动态生成，降级到 8 无需改这里
        slowMs: 2000,             // 水汽/气压/效果推送的慢拍
        fastMs: 500,              // 温度快拍：昼夜 60 秒一轮时温度 0.83°C/秒，2 秒拍太糙
        kCool: 0.18,              // 云量满时的降温幅度（归一温标）
        edgeWarm: 0.06,           // 周期边界回暖：贴边格比中心暖一点（海岸效应，给网格造梯度）
        // 地形热容三档。数值是「每秒」的松弛速率，在 stepTemperature 里乘 dt 使用，
        // 所以快拍改成 500ms 时实际松弛速度不变（否则会突然快 4 倍）。
        heatRate: { ocean: 0.05, desert: 0.22, forest: 0.10, grass: 0.14 },
        displayMin: -20, displayMax: 40,                        // 归一 0..1 → °C
        degradeAfter: 3, recoverAfter: 2,
      });

      // 当前地形。「ocean」是插件原本的地面；用户勾上「显示草地」后切到「grass」，
      // 于是天气驱动层的蒸发率/热容/凝结核/落点表现全部跟着换一套。
      // ⚠ 用 let 而不是 const：地形可切换。
      let driveTerrain = "ocean";
      // 由 pushGround 每拍更新（见下方 syncTerrain）
      function setDriveTerrain(name) {
        if (name === driveTerrain) return
        if (!TERRAIN_LABELS[name]) return
        driveTerrain = name
        try { driveSignal("ui", { step: "terrain_switch", terrain: name }) } catch (e) { /* 日志不影响运行 */ }
      }
      const gridN = DRIVE_CONFIG.grid;
      const gridCount = gridN * gridN;

      // 状态：T 是场，rate 是每拍变化率；降级计数与用户参数分离（照抄 sunPass）
      const driveState = {
        T: null, rate: null, tick: 0,
        bad: 0, good: 0, degraded: false,
      };
      // 潜热偏移：降水放出的热量累加在这里，再加到温度目标上。
      // 单独存是为了它能「累加后缓慢衰减」—— 直接改 T 会被下一拍的松弛抹掉。
      let latentOffset = 0;

      // 分层存活信号：四层 [load] → [factory] → [apply] → [ui]，全部可 grep
      function driveSignal(layer, detail) {
        console.info(DRIVE_LOG, "[" + layer + "]", detail);
      }

      // 归一 0..1，坏值给 NaN（绝不回退默认值）
      const unit = (v) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : NaN);

      // 输入读取统一模板：存在性 → 调用异常 → 取值 NaN，三种坏法都给可读 reason
      function readInput(fnName, pick) {
        if (typeof win[fnName] !== "function") return { ok: false, reason: fnName + "_missing" };
        let raw;
        try { raw = win[fnName](); } catch (error) { return { ok: false, reason: fnName + "_threw" }; }
        const value = pick(raw);
        if (!Number.isFinite(value)) return { ok: false, reason: fnName + "_nan" };
        return { ok: true, value: value };
      }

      // 环境输入：一次读取，三场共用。
      // 原来温度、水汽、气压各自 readInput("__ossState") 和 ("__ossCloud")，
      // 同一个拍里读 3 遍同样的东西 —— 收成一次，坏输入也只记一次账。
      function readEnv() {
        const day = readInput("__ossState", (s) => (s ? s.daylight / 100 : NaN));
        const cloud = readInput("__ossCloud", (c) => (c ? c.mask : NaN));
        return { day, cloud, ok: day.ok && cloud.ok, reason: !day.ok ? day.reason : cloud.reason };
      }

      // 容量函数归温度场：温度越高空气装的水汽越多（感知版指数，不做克劳修斯-克拉佩龙）
      const saturationCapacity = (t) => (Number.isFinite(t) ? 0.35 + 0.65 * Math.pow(unit(t), 1.6) : NaN);

      // 降级状态机：连坏 degradeAfter 拍降、连好 recoverAfter 拍恢复，只报两次
      function trackInput(ok, reason) {
        const S = driveState;
        if (ok) {
          S.bad = 0; S.good += 1;
          if (S.degraded && S.good >= DRIVE_CONFIG.recoverAfter) {
            S.degraded = false;
            console.info(DRIVE_LOG, "[drive_recovered]", { tick: S.tick });
          }
          return true;
        }
        S.good = 0; S.bad += 1;
        if (S.bad === 1 || S.bad === DRIVE_CONFIG.degradeAfter) {
          console.warn(DRIVE_LOG, "[drive_bad_input]", { reason: reason, consecutive: S.bad, hasField: S.T !== null });
        }
        if (S.bad >= DRIVE_CONFIG.degradeAfter && !S.degraded) {
          S.degraded = true;
          console.warn(DRIVE_LOG, "[drive_degraded]", { reason: reason, tick: S.tick });
        }
        return false;
      }

      // 一拍：读两路输入 → 降级判定 → 地形热容 → 一阶松弛 → 变化率
      // 温度场：整个生态的源头。容量（水汽能装多少）、雨雪形态、融雪速度都从它派生。
      // 完整依赖关系见文件头部「生态联动总图」。
      function stepTemperature() {
        const env = readEnv();
        if (!trackInput(env.ok, env.reason)) return false;
        const day = env.day, cloud = env.cloud;

        let heat = DRIVE_CONFIG.heatRate[driveTerrain];
        if (!Number.isFinite(heat)) {
          console.warn(DRIVE_LOG, "[terrain_unknown]", { terrain: driveTerrain, fellBackTo: "forest" });
          heat = DRIVE_CONFIG.heatRate.forest;
        }
        // 目标温：由「温度滑杆」决定，不再直接跟随 daylight。
        // 滑杆是用户显式设置的天气状态，驱动层向它松弛（约几百毫秒到位），
        // 所以拉滑杆能看到温度「追过去」，而不是瞬间跳变。
        // 云遮仍会让实际温度略低于目标 —— 这是保留的一点点真实感。
        // 潜热偏移：凝结放出的热量累加在目标之上，然后缓慢散去（否则会无限升温）。
        // 这就是「降水 → 放热 → 温度升 → 容量增 → 蒸发多」那条闭环的耦合点。
        const sliderNorm = effectiveSlider("tempPos") / 100;
        latentOffset *= 0.94;      // 每拍散掉 6%，约 8 秒衰减完
        const base = unit(sliderNorm) - unit(cloud.value) * DRIVE_CONFIG.kCool + latentOffset;

        if (!driveState.T) {
          driveState.T = new Float32Array(gridCount);
          driveState.rate = new Float32Array(gridCount);
          for (let i = 0; i < gridCount; i += 1) driveState.T[i] = base;
        } else {
          const T = driveState.T, R = driveState.rate, prev = new Float32Array(T);
          // 一阶松弛按真实时间走：heat 是「每秒」的速率，乘本次间隔秒数后钳到 0..1。
          // 这样快拍 500ms / 慢拍 2s 切换时，温度追赶目标的速度保持不变。
          const dtSec = Math.min(1, Math.max(0.05, DRIVE_CONFIG.fastMs / 1000));
          const step = Math.min(1, heat * dtSec * 20);
          for (let i = 0; i < gridCount; i += 1) {
            // 周期边界：左右接、上下接 —— 网格两侧的温差沿最短路径传递（列环绕）。
            const x = i % gridN;
            const wrap = Math.min(x, gridN - x) / gridN;   // 0（贴边）..0.5（居中）
            const target = base + (1 - wrap) * DRIVE_CONFIG.edgeWarm;
            T[i] = unit(T[i] + (target - T[i]) * step);
            R[i] = T[i] - prev[i];
          }
        }
        driveState.tick += 1;

        if (DRIVE_DEBUG === "TEMP") {
          const mid = driveState.T[gridCount >> 1];
          console.info(DRIVE_LOG, "[probe:TEMP]", {
            tick: driveState.tick, daylight: unit(day.value), cloud: unit(cloud.value),
            target: base, center: mid,
            displayC: Math.round(DRIVE_CONFIG.displayMin + (DRIVE_CONFIG.displayMax - DRIVE_CONFIG.displayMin) * mid),
          });
        }
        return true;
      }
      // ======================================================================
      //  驱动层 · 第 2 场：水汽
      //  水汽不是单个标量，而是一个循环中的主动量。三态并存：
      //    vapor     （气态，看不见）
      //    cloudDrop （液态，云的原料）
      //    snowDrop  （固态，雪的原料）
      //  温度决定凝结走向哪一态：低温走固态，高温走液态。
      //  本模块承担的职责：
      //    ①三态     三块数组并存，按温度分流
      //    ②输送     读风场网格（有则按格取，无则退回单值风）
      //    ③饱和     cap = saturationCapacity(T)；凝结核降低凝结门槛（地形给）
      //    ④循环     蒸发 → 凝结 → 降水 → 回地面，闭合
      //    ⑤接口     读温度（定容）、风场（输送）；产出云（原料）与雨（前身）
      //    ⑥守恒     每拍核算 total，漂移超阈值打 [vapor_drift]
      //  已知的模型局限（按此设计，不是缺陷）：
      //    静风时靠扩散、有凝结核时低饱和也凝结、封闭系统无蒸发源时循环耗尽。
      // ======================================================================
      // ② 成核位点分布：一次性生成的稳定噪声场（0..1）。
      // 表示「尘埃/核在空间上的疏密」：密的地方云先长出来，疏的地方一直干净。
      // 不随时间变 —— 尘埃不会自己乱飘；换地形时只在密度上缩放，分布不变。
      const nucleiField = (() => {
        const a = new Float32Array(gridCount);
        let seed = 20251028;
        const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
        const raw = new Float32Array(gridCount);
        for (let i = 0; i < gridCount; i += 1) raw[i] = rand();
        // 3×3 平滑两遍，变成低频的一团团「核密集区」
        for (let pass = 0; pass < 2; pass += 1) {
          for (let y = 0; y < gridN; y += 1) {
            for (let x = 0; x < gridN; x += 1) {
              let sum = 0, n = 0;
              for (let dy = -1; dy <= 1; dy += 1) {
                for (let dx = -1; dx <= 1; dx += 1) {
                  const xx = (x + dx + gridN) % gridN;
                  const yy = (y + dy + gridN) % gridN;
                  sum += raw[yy * gridN + xx]; n += 1;
                }
              }
              a[y * gridN + x] = sum / n;
            }
          }
          raw.set(a);
        }
        return a;
      })();

      const VAPOR = {
        vapor: null,      // 气态水汽 0..1（原 H）
        cloudDrop: null,  // 液态云滴 0..1（成云原料）
        snowDrop: null,   // 固态冰晶 0..1（成雪原料）
        nuclei: null,     // 凝结核 0..1（地形给，全场恒定值按格铺开）
        Ha: null,         // 整层水汽 0..1（柱累计）
        sat: null,        // 饱和布尔网格
        precip: 0,        // 本拍降水率 0..1（给雨）
        total: 0,         // 守恒核算：三态总量
        drift: 0,         // 相对初始总量的漂移
        latentHeat: 0,    // 本拍回授给温度场的潜热（归一温度增量）
        tick: 0,
      };

      // 地形四标签（海/沙/森）—— 只声明，不写配合逻辑；天气模块读标签自己分支。
      // nuclei：凝结核密度。海面空气干净（低）、沙地尘埃多（高）、森林居中。
      // evap：蒸发率。海边水汽必须能「顶到容量以上」才谈得上饱和成云，
      //       所以海面给得足够高（0.035），沙漠给得很低（0.004）——「沙漠少蒸发」。
      // reflect：反射率。光读它 —— 海面反光强（光柱更亮），沙地几乎不反光（吸热压亮）。
      //          归一成 0..1 数值，光模块按这个系数缩放太阳光效。
      const TERRAIN_LABELS = Object.freeze({
        ocean:  { reflect: "high",   reflectivity: 1.0,  evap: 0.035,  surface: "splash", heatCap: "high",   nuclei: 0.15 },
        desert: { reflect: "low",    reflectivity: 0.35, evap: 0.004,  surface: "seep",  heatCap: "low",    nuclei: 0.70 },
        forest: { reflect: "medium", reflectivity: 0.60, evap: 0.018,  surface: "drip",  heatCap: "medium", nuclei: 0.40 },
        // 草地地形（本插件的地形层）。数值按草地的物理特性取：
        //   reflectivity 0.55   草的反射率介于沙漠(0.35)和森林(0.60)之间
        //   evap 0.020          比森林略高：草地蒸腾强但不如林地遮阴
        //   heatCap "medium"    草层有热惯性，不如水面但比沙地大
        //   nuclei 0.35         花粉和尘土，凝结核比海面多
        //   surface "grass"     新的落点表现（雨成水珠、雪成堆积），见 SURFACE
        grass:  { reflect: "medium", reflectivity: 0.55, evap: 0.020,  surface: "grass", heatCap: "medium", nuclei: 0.35 },
      });

      const VAP_CFG = Object.freeze({
        transport: 0.004,   // 风送率：每拍输送量
        dryRate: 0.35,      // 降水扣气态水汽的速率
        condenseRate: 0.6,  // 超容量部分每拍凝结成云滴的比例（凝结是主力，不能太小）
        returnRate: 0.30,   // 降水落地后回补气态水汽的比例（闭合循环）
        // 0°C 对应的归一温度：区间 -20..40，所以 0°C = (0+20)/60 ≈ 0.333。
        // 必须和 SNOW_BELOW_C 完全一致 —— 两处阈值不一样会出现「判定为雪但凝结成水」，
        // 表现就是雪看不见（这正是之前的 bug）。
        snowTemp: 1 / 3,
        precipThreshold: 0.12, // 云滴超过此值就降水（沙盒要「拉满湿度必下雨」，门槛不能太高）
        nucleiGain: 0.5,    // 凝结核把有效容量拉低多少：cap_eff = cap * (1 - nuclei*nucleiGain)
        driftWarn: 0.5,     // 总量漂移超过它才告警（避免刷屏）
      });

      // 水汽读数占位对象（var 提升、无 TDZ）：panel 的 500ms 状态刷新可能在
      // 首拍之前就调用 driveRead，直接读 const 的 VAPOR 会抛 ReferenceError。
      var vaporRef = { vapor: null, cloudDrop: null, snowDrop: null, nuclei: null, sat: null, Ha: null, precip: 0 };

      // 水汽场：蒸发 → 凝结 → 降水 → 回地面，闭环。
      // 输入：温度场（给容量）、气压场（给每格的易饱和系数）、风（横向平移）。
      // 输出：precip（降水率）、cloudDrop（云滴）、snowDrop（冰晶）、latentHeat（潜热回授）。
      // 完整依赖关系见文件头部「生态联动总图」。
      function stepVapor() {
        const env = readEnv();
        const wind = readInput("__ossWind", (w) => (w && Number.isFinite(w.x) && Number.isFinite(w.speed) ? w.x * w.speed : NaN));
        // 气压场给降水用：本格气压 + 全场均值（相对偏离才是有效信号）。
        //
        // 【⚠ TDZ 陷阱：不能直接写 PRESSURE / PRES_CFG / typeof PRESSURE】
        // stepVapor（4018 行）早于 PRESSURE（4224 行）/ PRES_CFG（4230 行）的 const 声明。
        // const 在声明前处于 TDZ，任何访问 —— 包括 typeof —— 都会抛 ReferenceError。
        // （typeof 只能挡住「完全没声明」的变量，挡不住 TDZ。）
        // 一旦抛错，整个 stepVapor 中断，雨雪就完全不下，而外层 try/catch 只留一行警告。
        //
        // 【正解】用 pressureRef —— 它是 var 声明（4221 行），有变量提升，
        // 提前访问只是 undefined，不会抛错；气压场就绪后 stepPressure 会填好 .field。
        // 查 .field 就能知道「气压场到底起来了没有」。
        const pr = pressureRef;
        const PRESS_P = pr && pr.field ? pr.field : null;
        // rainGain 从 DEFAULTS 侧的常量读不到（同为 const），这里直接写死同一个值。
        // 改 PRES_CFG.rainGain 时记得同步这里 —— 目前两处都是 0.8。
        const rainGain = 0.8;
        let PRES_MEAN = 0;
        if (PRESS_P) {
          let psum = 0;
          for (let i = 0; i < gridCount; i += 1) psum += PRESS_P[i];
          PRES_MEAN = psum / gridCount;
        }
        if (!VAPOR.vapor) {
          const labels0 = TERRAIN_LABELS[driveTerrain] || TERRAIN_LABELS.forest;
          VAPOR.vapor = new Float32Array(gridCount).fill(0.5);
          VAPOR.cloudDrop = new Float32Array(gridCount);
          VAPOR.snowDrop = new Float32Array(gridCount);
          VAPOR.nuclei = new Float32Array(gridCount).fill(labels0.nuclei);
          VAPOR.Ha = new Float32Array(gridCount).fill(0.35);
          VAPOR.sat = new Uint8Array(gridCount);
          VAPOR.total = 0.5 * gridCount;
        }
        if (!env.ok || !wind.ok) {
          VAPOR.tick += 1;
          trackInput(false, env.ok ? wind.reason : env.reason);
          return false;
        }
        trackInput(true, null);

        const labels = TERRAIN_LABELS[driveTerrain] || TERRAIN_LABELS.forest;
        const evap = labels.evap;
        const V = VAPOR.vapor, CD = VAPOR.cloudDrop, SD = VAPOR.snowDrop;
        // ② 成核位点：凝结核不是全场均匀，而是按空间分布聚成「位点」。
        // 均匀的核会让整片天空同时凝结（云一起长、一起散），很不真实；
        // 有疏有密的位点才会让云「一处一处地长出来」。
        // 分布用一次性生成的稳定噪声场 × 地形给的密度，不随时间变（尘埃不该乱飘）。
        const baseNuclei = labels.nuclei;
        for (let i = 0; i < gridCount; i += 1) {
          VAPOR.nuclei[i] = baseNuclei * (0.35 + 0.65 * nucleiField[i]);
        }
        const NN = VAPOR.nuclei, S = VAPOR.sat;
        const windX = wind.value;
        // 湿度滑杆 = 相对饱和度的位置。
        // 映射必须让「滑杆 70」真的下起雨来，否则用户拉 70 看不到雨会以为坏了。
        // 曲线（容量的百分比）：
        //   0   → 40%   明显干
        //   30  → 72%   有点湿，不饱和
        //   50  → 92%   接近饱和
        //   70  → 108%  已饱和（下）
        //   100 → 140%  下得很猛
        // 用幂函数：低段平缓，越过 50 之后迅速冲过饱和线。
        const slidedNorm = Math.max(0, Math.min(1, effectiveSlider("humidPos") / 100));
        const humidRatio = 0.40 + Math.pow(slidedNorm, 1.6) * 1.00;

        let sum = 0, precipSum = 0;
        for (let i = 0; i < gridCount; i += 1) {
          const temp = driveState.T ? driveState.T[i] : 0.5;
          // ③ 饱和律：容量由温度给；凝结核降低有效容量（有核时低饱和也能凝结）
          const capRaw = saturationCapacity(temp);
          const cap = capRaw * (1 - NN[i] * VAP_CFG.nucleiGain);

          // ① 湿度滑杆接管：目标 = 本格容量 × 滑杆比例。
          // 这样无论温度多少（容量大小不同），滑杆 100 都必定饱和，
          // 用户拉满就一定能看到降水 —— 这是沙盒必须保证的「所见即所得」。
          //
          // 【生态联动：气压决定这一格有多容易饱和】
          // 物理上低压 = 上升气流 = 空气被抬升冷却 = 更容易凝结成雨；
          // 高压 = 下沉气流 = 空气被压缩增温 = 抑制凝结。
          // 所以按本格气压相对全场均值的偏离，给容量乘一个系数：
          //   低压格 → 有效容量变小 → 同样水汽更容易越过饱和 → 下雨
          //   高压格 → 有效容量变大 → 需要更多水汽才饱和 → 更干
          // 【为什么这里能吃到气压而云量那里吃不到】
          // 云量用的是【全场平均变化】(meanDelta)，正负抵消后几乎为 0；
          // 这里用的是【逐格相对偏离】，是场内的结构，不会被平均掉。
          let pressMod = 0;
          // 用上面算好的 rainGain（常量，无 TDZ），不用 PRES_CFG
          if (PRESS_P && PRES_MEAN > 0 && rainGain > 0) {
            pressMod = (PRES_MEAN - PRESS_P[i]) * rainGain;   // 低压为正
            pressMod = Math.max(-0.35, Math.min(0.35, pressMod));      // 钳住，别把滑杆语义盖掉
          }
          // 【⚠ capEff 必须基于 cap，不是 capRaw】
          // cap 已经含了凝结核的衰减（capRaw * (1 - nuclei*gain)）。
          // 之前写成 capRaw * (1 - pressMod)，把凝结核那部分丢掉，
          // 有效容量凭空大了约 18% —— 结果同样湿度更难饱和，降水变少。
          // 这是「改了气压之后不下雨」的直接原因之一。
          const capEff = cap * (1 - pressMod);
          const target = Math.min(1, capEff * humidRatio);
          const drive = (target - V[i]) * (0.35 + evap * 2);
          let v = V[i] + drive + windX * VAP_CFG.transport;

          // ③ 凝结：超容量部分按温度走液态或固态。
          // 关键：凝结是「超出容量多少就搬走多少」，不是按比例慢慢搬 ——
          // 按比例搬的话每拍只搬一小口，蒸发马上又补回来，云滴永远长不到降水阈值。
          const excess = v - capEff;
          if (excess > 0) {
            const move = excess;                      // 超出的部分整个搬走
            if (temp < VAP_CFG.snowTemp) { SD[i] = Math.min(1, SD[i] + move); }
            else { CD[i] = Math.min(1, CD[i] + move); }
            v -= move;
          }
          // 相态迁移：温度跨过冰点后，已有的液态云滴会冻结成冰晶（不是凭空消失）。
          // 这是三态律「温度是开关」的补全 —— 开关要同时作用于新凝结和已有存量。
          if (temp < VAP_CFG.snowTemp && CD[i] > 0) {
            const freeze = Math.min(CD[i], 0.08);
            CD[i] -= freeze;
            SD[i] = Math.min(1, SD[i] + freeze);
          }

          // ④ 降水：云滴/冰晶长大超过阈值 → 落地；落地后一部分回补气态（闭合循环）
          // 注意要把两种相态都算进去：低温时凝结走的是固态（SD），
          // 只看 CD 会让「冬天拉满湿度却不下雪」，那是错的。
          let precip = 0;
          const liquid = CD[i];
          const solid = SD[i];
          if (liquid > VAP_CFG.precipThreshold) {
            precip += (liquid - VAP_CFG.precipThreshold) * 0.5;
            CD[i] = Math.max(0, liquid - precip);
          }
          if (solid > VAP_CFG.precipThreshold) {
            const snowOut = (solid - VAP_CFG.precipThreshold) * 0.5;
            precip += snowOut;
            SD[i] = Math.max(0, solid - snowOut);
          }
          if (precip > 0) {
            v += precip * VAP_CFG.returnRate;          // 回地面再蒸发
            precipSum += precip;
          }
          // 雪滴融化/升华：温度回暖时固态回退成气态
          if (SD[i] > 0 && temp > VAP_CFG.snowTemp + 0.15) {
            const melt = Math.min(SD[i], 0.05);
            SD[i] -= melt; v += melt;
          }

          V[i] = unit(v);
          S[i] = V[i] >= cap ? 1 : 0;
          // 整层水汽：地面之上较干，随风缓变
          VAPOR.Ha[i] = Math.min(1, Math.max(0, VAPOR.Ha[i] * 0.995 + V[i] * 0.005));
          sum += V[i] + CD[i] + SD[i];
        }

        VAPOR.precip = Math.min(1, precipSum / gridCount * 4);

        // ---- ③ 潜热回授 ----
        // 凝结放热（约 2500 kJ/kg），所以「降水越多，空气越暖」。
        // 这条把一个单向的链变成了闭环：
        //   降水 → 放热 → 温度升 → 容量增大 → 蒸发变多 → 水汽更多 → 更容易降水
        // 回路转起来之后，天气会自己振荡，不需要外部正弦去「演」。
        // 系数 0.06：一个满量降水（precip=1）约让归一温度升 0.06（约 3°C），
        // 再多会自我放大到失控，再少就感受不到。
        if (VAPOR.precip > 0 && driveState.T) {
          const heat = VAPOR.precip * 0.06;
          // 累加到偏移上，由温度场下一拍读入；直接改 T 会被同一拍的松弛抹掉。
          latentOffset = Math.min(0.25, latentOffset + heat);
          VAPOR.latentHeat = heat;
        } else {
          VAPOR.latentHeat = 0;
        }

        // ⑥ 守恒核算：总量应大致守恒（蒸发加、降水减、输送搬）
        const prevTotal = VAPOR.total;
        VAPOR.total = sum;
        VAPOR.drift = Math.abs(VAPOR.total - prevTotal) / Math.max(1e-6, VAPOR.total);
        if (VAPOR.drift > VAP_CFG.driftWarn) {
          console.warn(DRIVE_LOG, "[vapor_drift]", { drift: VAPOR.drift.toFixed(4), prev: prevTotal.toFixed(3), now: VAPOR.total.toFixed(3) });
        }
        VAPOR.tick += 1;
        // 同步给占位对象：面板/外部脚本随时可读，不受 TDZ 影响
        vaporRef.vapor = VAPOR.vapor;
        vaporRef.cloudDrop = VAPOR.cloudDrop;
        vaporRef.snowDrop = VAPOR.snowDrop;
        vaporRef.nuclei = VAPOR.nuclei;
        vaporRef.sat = VAPOR.sat;
        vaporRef.Ha = VAPOR.Ha;
        vaporRef.precip = VAPOR.precip;

        if (DRIVE_DEBUG === "VAPOR") {
          const mid = gridCount >> 1;
          console.info(DRIVE_LOG, "[probe:VAPOR]", {
            tick: VAPOR.tick, vapor: V[mid].toFixed(3), cloudDrop: CD[mid].toFixed(3),
            snowDrop: SD[mid].toFixed(3), nuclei: NN[mid], precip: VAPOR.precip.toFixed(3),
            drift: VAPOR.drift.toFixed(4), total: VAPOR.total.toFixed(2),
          });
        }
        return true;
      }

      // 兼容别名：驱动层内部有些地方仍叫 stepHumidity
      const stepHumidity = stepVapor;

      // 降压 / 升压信号（给云、给雨）。用 var 提前占位：pushCloud 可能在气压场
      // 落地之前就被调用来问「现在气压在升还是在降」，这时读到的就是全 0。
      // 同时缓存中心格读数，让面板读值时不必碰 PRESSURE（避免 TDZ）。
      var pressureRef = { rise: 0, fall: 0, initDegraded: true, center: NaN, field: null };

      // ======================================================================
      //  驱动层 · 第 3 场：气压
      //  气压是整条链的驱动源，所以要最后落地 —— 上游（温度、水汽）就位它才有意义。
      //  本模块的七项职责：
      //    ①生成气压差      噪声给初差 + 方差判据（全场均匀即视为死场）
      //    ②风向            风由高压吹向低压，V ∝ -∇P
      //    ③热力作用        读温度场，热处气压低
      //    ④初始化          按温度算；温度不可用时退化为 P=0.5 均匀场并标记 initDegraded
      //    ⑤边界            周期边界，左右接、上下接
      //    ⑥风环弱反馈      |V| 低于阈值时断开，避免静风区自激
      //    ⑦演化            相位漂移，高压东移、低压西进
      //  对外输出三件：getWindField / getPressureSignal / getPressureDrop
      // ======================================================================
      const PRESSURE = {
        P: null, Prev: null,
        drop: 0, rise: 0, phase: 0,
        initDegraded: false, tick: 0,
      };

      const PRES_CFG = Object.freeze({
        p0: 0.5,
        thermalGain: 0.22,
        driftSpeed: 0.006,
        feedback: 0.004,
        feedbackCut: 0.02,
        deadThreshold: 0.002,
        // 气压对降水的调制强度：气压偏离全场均值 0.1 时，有效容量变化 rainGain*0.1。
        // 0.8 意味着「明显低压」大约让饱和门槛降 20~30% —— 够看得出来，又不会盖过湿度滑杆。
        rainGain: 0.8,
      });

      // 独立噪声：只给气压造初差用，不污染云的 noise。
      // 预生成一张低频噪声场（一次算好，每拍按相位滚动），周期边界平滑。
      let pressNoiseSeed = 1337;
      const pressRand = () => {
        pressNoiseSeed = (pressNoiseSeed * 1103515245 + 12345) & 0x7fffffff;
        return pressNoiseSeed / 0x7fffffff;
      };
      const pressNoise = (() => {
        const a = new Float32Array(gridCount);
        const raw = new Float32Array(gridCount);
        for (let i = 0; i < gridCount; i += 1) raw[i] = pressRand() - 0.5;
        for (let pass = 0; pass < 2; pass += 1) {
          for (let y = 0; y < gridN; y += 1) {
            for (let x = 0; x < gridN; x += 1) {
              let sum = 0, n = 0;
              for (let dy = -1; dy <= 1; dy += 1) {
                for (let dx = -1; dx <= 1; dx += 1) {
                  const xx = (x + dx + gridN) % gridN;
                  const yy = (y + dy + gridN) % gridN;
                  sum += raw[yy * gridN + xx]; n += 1;
                }
              }
              a[y * gridN + x] = sum / n;
            }
          }
          raw.set(a);
        }
        return a;
      })();

      // 气压场：热力项（温度合成） + 噪声初差 + 相位漂移 + 风环弱反馈。
      // 输出三条：drop/rise（给云量）、逐格 P（给降水容量）、梯度场（给风向）。
      // 【统计量选择】不要用全场平均变化 —— 周期边界下必然抵消。见文件头部总图。
      function stepPressure() {
        const mid = gridCount >> 1;
        const T = driveState.T;
        // ④ 初始化：主路径按温度算；温度场还没起来 → P=0.5 均匀 + 标记
        if (!PRESSURE.P) {
          PRESSURE.P = new Float32Array(gridCount);
          PRESSURE.Prev = new Float32Array(gridCount);
          if (T) {
            for (let i = 0; i < gridCount; i += 1) {
              PRESSURE.P[i] = Math.min(1, Math.max(0, PRES_CFG.p0 - (T[i] - 0.5) * PRES_CFG.thermalGain));
            }
            PRESSURE.initDegraded = false;
          } else {
            PRESSURE.P.fill(PRES_CFG.p0);
            PRESSURE.initDegraded = true;
            console.warn(DRIVE_LOG, "[pressure_init_degraded]", { reason: "temperature_absent", P: PRES_CFG.p0 });
          }
          PRESSURE.Prev.set(PRESSURE.P);
        }

        PRESSURE.Prev.set(PRESSURE.P);
        PRESSURE.phase += PRES_CFG.driftSpeed;
        const drift = Math.sin(PRESSURE.phase) * 0.01;   // 高压东移、低压西进

        // ⑥ 风环弱反馈：风弱了就不喂（|V| 低于阈值 → 0）
        const wind = readInput("__ossWind", (w) => (w && Number.isFinite(w.x) ? w.x * (w.speed || 1) : NaN));
        const windX = wind.ok && Math.abs(wind.value) >= PRES_CFG.feedbackCut ? wind.value : 0;

        const P = PRESSURE.P, Tnext = driveState.T;
        for (let y = 0; y < gridN; y += 1) {
          for (let x = 0; x < gridN; x += 1) {
            const i = y * gridN + x;
            const xw = (x - 1 + gridN) % gridN, xe = (x + 1) % gridN;
            const yw = (y - 1 + gridN) % gridN, ye = (y + 1) % gridN;
            // ③ 热力项：温度变，气压跟着变
            const thermal = Tnext ? -(Tnext[i] - 0.5) * PRES_CFG.thermalGain : 0;
            // ① 噪声初差 + ⑦ 相位漂移
            const noise = pressNoise[i] * Math.cos(PRESSURE.phase) + drift;
            // ⑥ 风环弱反馈：中心差分取梯度
            const gradX = P[y * gridN + xe] - P[y * gridN + xw];
            const localWind = windX * gradX * PRES_CFG.feedback;
            const next = PRES_CFG.p0 + thermal + noise + localWind;
            P[i] = Math.min(1, Math.max(0, P[i] + (next - P[i]) * 0.12));
          }
        }

        // 升降信号：从「全场平均变化」改成「结构量」。
        // 【为什么原来的算法无效】meanDelta 是全场平均，气压场里高低压成对出现，
        // 涨的和跌的互相抵消，实测只有 5e-5，乘 50 再乘 12 之后云量只变 0.05，
        // 面板滑杆范围是 0..150 —— 完全看不见。
        // 【现在用什么】用两个不会被平均掉的量：
        //   · 中心偏离：中心格气压 - 全场均值。中心是低压（<0）说明这片天在酝酿降水。
        //   · 场对比度：全场标准差。对比度越大 = 高低压差越明显 = 天气越活跃。
        // 两者合成 drop / rise：
        //   drop（升云、酝酿降水）= 中心低压程度
        //   rise（散云）           = 中心高压程度
        let pmean = 0;
        for (let i = 0; i < gridCount; i += 1) pmean += P[i];
        pmean /= gridCount;
        let pvar = 0;
        for (let i = 0; i < gridCount; i += 1) pvar += (P[i] - pmean) * (P[i] - pmean);
        pvar /= gridCount;
        const pstd = Math.sqrt(pvar);
        // 中心偏离（负 = 中心低压）
        const centerDev = P[mid] - pmean;
        // 对比度归一：pstd 实测约 0.1 量级，除以 0.1 后钳到 0..1
        const contrast = Math.min(1, pstd / 0.1);
        // 中心低压 → drop（生云）；中心高压 → rise（散云）。都乘上对比度：
        // 场太平（没高低压结构）时即使中心偏低也不该生云。
        // 放大系数 20 → 60：实测中心偏离约 -0.04、对比度 0.46，乘 20 只得 0.37，
        // 再乘 12 进云量才 4.4（滑杆 0..150），还是太弱。乘 60 后到约 1.0，
        // 云量能调 ±12 —— 这是看得出来的量级，同时不会盖过用户滑杆。
        const dropRaw = Math.max(0, -centerDev) * contrast * 60;
        const riseRaw = Math.max(0, centerDev) * contrast * 60;
        PRESSURE.drop = Math.min(1, dropRaw);
        PRESSURE.rise = Math.min(1, riseRaw);
        // 同步到占位对象：云/雨随时可读，不依赖气压场是否已初始化
        pressureRef.rise = PRESSURE.rise;
        pressureRef.fall = PRESSURE.drop;
        pressureRef.initDegraded = PRESSURE.initDegraded;
        pressureRef.center = P[mid];
        pressureRef.field = P;
        PRESSURE.tick += 1;

        // 死场判据：全场方差过低 = 没有高差，风无从生
        if (PRESSURE.tick === 1 || PRESSURE.tick % 30 === 0) {
          let mean = 0;
          for (let i = 0; i < gridCount; i += 1) mean += P[i];
          mean /= gridCount;
          let varSum = 0;
          for (let i = 0; i < gridCount; i += 1) varSum += (P[i] - mean) * (P[i] - mean);
          const variance = varSum / gridCount;
          if (variance < PRES_CFG.deadThreshold) {
            console.warn(DRIVE_LOG, "[pressure_dead]", { variance: variance, note: "field too uniform, no gradient" });
          }
          if (DRIVE_DEBUG === "PRES") {
            console.info(DRIVE_LOG, "[probe:PRES]", {
              tick: PRESSURE.tick, variance: variance, center: P[mid],
              drop: PRESSURE.drop, rise: PRESSURE.rise, initDegraded: PRESSURE.initDegraded,
            });
          }
        }
        return true;
      }

      // 气压三件套之一：风场（每格一个方向，由气压梯度给方向）
      function getWindField() {
        const P = PRESSURE.P;
        if (!P) return null;
        const out = new Float32Array(gridCount * 2);
        for (let y = 0; y < gridN; y += 1) {
          for (let x = 0; x < gridN; x += 1) {
            const xw = (x - 1 + gridN) % gridN, xe = (x + 1) % gridN;
            const yw = (y - 1 + gridN) % gridN, ye = (y + 1) % gridN;
            const i = y * gridN + x;
            // 风从高压吹向低压：V ∝ -∇P
            out[i * 2] = -(P[y * gridN + xe] - P[y * gridN + xw]) * 0.5;
            out[i * 2 + 1] = -(P[ye * gridN + x] - P[yw * gridN + x]) * 0.5;
          }
        }
        return out;
      }

      // 气压梯度 → 一个「主导风向」。
      // 完整链路见文件头部「生态联动总图」的【气压主轴】一节。
      // 【第一版失败：全场梯度直接平均必然归零】
      // 周期边界的气压场，梯度是闭合的（流进来必然流出去），
      // 全场求和 x=1.7e-18, y=0 —— 精确抵消，等于没算。
      //
      // 改用【强度加权 + 平方法】：风向本质上在 0~360° 上讲，直接矢量相加会互相抵消，
      // 所以把每个梯度矢量视为对「两个主轴方向」的贡献，按 |∇P|² 加权：
      //   · 强梯度处说了算（弱噪声被平方压掉）
      //   · 用张量（dx*dx, dx*dy, dy*dy）累加，等价于求主导方向的主轴，
      //     正反方向不再抵消（因为是平方量）
      // 这样得到的是「整片区域最主要的风向」，符合直觉。
      function dominantPressureWind() {
        const F = getWindField();
        if (!F) return null;
        let sxx = 0, sxy = 0, syy = 0;
        for (let i = 0; i < gridCount; i += 1) {
          const gx = F[i * 2], gy = F[i * 2 + 1];
          const w = gx * gx + gy * gy;      // |∇P|²
          if (w < 1e-18) continue;
          sxx += gx * gx;   // 张量分量（已含平方权重）
          sxy += gx * gy;
          syy += gy * gy;
        }
        const tr = sxx + syy;
        if (!(tr > 1e-14)) return null;
        // 2x2 对称张量的主轴：用解析解求最大特征值对应的特征向量
        const diff = sxx - syy;
        const disc = Math.sqrt(diff * diff + 4 * sxy * sxy);
        const lambda1 = 0.5 * (tr + disc);          // 主方向能量
        if (!(lambda1 > 1e-14)) return null;
        // 特征向量
        let ex, ey;
        if (Math.abs(sxy) > 1e-18) {
          ex = lambda1 - syy;
          ey = sxy;
        } else {
          // 对角情形：主轴就是 x 或 y
          if (sxx >= syy) { ex = 1; ey = 0; } else { ex = 0; ey = 1; }
        }
        const len = Math.hypot(ex, ey);
        if (!(len > 1e-12)) return null;
        // 主轴只确定到「正负」两个方向，取哪个都不会让视觉反转（风往两头吹都是同一道风），
        // 这里固定取 ex 为正，保证风向连续、不跳 180°。
        if (ex < 0 || (ex === 0 && ey < 0)) { ex = -ex; ey = -ey; }
        return [ex / len, ey / len];
      }

      // 气压三件套之二：升降信号（给云：气压降→生云，气压升→散云）
      // ⚠ pushCloud 在 apply 早期就会被调用，那时气压场（PRESSURE）可能还没初始化。
      // 用 pressureRef 这个 var 对象提前占位（var 提升、无 TDZ），气压场落地后再填充，
      // 避免 ReferenceError 让整个插件挂载失败（浏览器里表现为「插件整个不出现」）。
      function getPressureSignal() {
        const S = pressureRef;
        return { rise: S.rise, fall: S.fall, initDegraded: S.initDegraded };
      }

      // 气压三件套之三：气压降信号（给雨：雨量随压降增大）
      function getPressureDrop() {
        return pressureRef.fall;
      }

      // 上升气流（给雷）：气压降的「加速度」，不是降本身。
      // 气压在降 = 空气在被抽走；降得越来越快 = 空气在被猛抽起来 = 上升气流强。
      // 用 drop 的时间变化率，平滑后钳到 0..1。没有它，雷只是「雨大所以闪得多」，
      // 接上它之后，雷才会「在气压崩下来的时候炸开」。
      let updraftSmooth = 0;
      function computeUpdraft() {
        const drop = pressureRef.fall;
        // 一阶低通，避免 2 秒拍的单点噪声被放大成雷的频率抖动
        updraftSmooth += (drop - updraftSmooth) * 0.35;
        return Math.max(0, Math.min(1, updraftSmooth * 1.4));
      }

      // 风场输出口：雨雪按位置采样它（globalWind 里 windFieldAt 读的就是这个）。
      // 返回结构 { grid, data }，data 是 N*N*2 的 [u0,v0,u1,v1,...]。
      // 每拍重算一次并写入 window，雨雪在下一帧就能读到新风。
      function publishWindField() {
        const field = getWindField();
        if (!field) {
          win.__ossWindField = null;
          return;
        }
        win.__ossWindField = () => ({ grid: gridN, data: field });
        // ---- 气压 → 风向 ----
        // 把全场气压梯度的主导方向推给引擎，让它【替代】内置的正弦风向曲线。
        // 于是风、云、草、海面、云影全部由同一个气压场驱动 —— 这就是「生态联动」。
        // 用 __ossWindDir（不是 __ossWindField，那个名字已被上面占用）。
        if (typeof win.__ossWindDir === "function") {
          const w = dominantPressureWind();
          try {
            if (w) win.__ossWindDir(w[0], w[1]);
            else win.__ossWindDir(null, null);
          } catch (error) { /* 引擎没起来就跳过 */ }
        }
      }

      // 唯一读口（只读，无写入口）
      // 所有字段都从 var 占位对象读：面板的 500ms 定时器可能在驱动层首拍之前
      // 就调用这里，直接读 const 的 VAPOR / PRESSURE 会撞 TDZ 报错。
      // 唯一读口（只读，无写入口）。
      // 只暴露确实有人在用的字段：面板读 centerC/humidityPct/pressureHPa/updraft，
      // 效果层读 windField/vaporPrecip/snowDrop，调试读 tick/degraded。
      // 其余（三态网格、守恒量、预留槽）按需通过 __openSeaShelter.drive() 拿整块，
      // 不在这里堆成一面没人看的墙。全部从 var 占位读，避免早期调用的 TDZ。
      function driveRead() {
        const has = driveState.T !== null;
        const mid = gridCount >> 1;
        const center = has ? driveState.T[mid] : NaN;
        const vaporCenter = vaporRef.vapor ? vaporRef.vapor[mid] : NaN;
        return {
          ready: has && !driveState.degraded, degraded: driveState.degraded, grid: gridN,
          tick: driveState.tick,
          // 温度
          T: driveState.T, rate: driveState.rate, center: center,
          centerC: Number.isFinite(center)
            ? DRIVE_CONFIG.displayMin + (DRIVE_CONFIG.displayMax - DRIVE_CONFIG.displayMin) * center
            : NaN,
          // 水汽
          vapor: vaporRef.vapor,
          nuclei: vaporRef.nuclei,
          vaporCenter: vaporCenter,
          humidity: vaporCenter,
          // 面板显示「相对饱和度」，不是水汽绝对值。
          // 原因：水汽一旦超过容量就凝结掉，所以绝对值永远贴着容量走，
          // 用户会看到「湿度卡在 51% 上不去」。饱和度（水汽/容量）才是
          // 有意义的读数：100% = 饱和 = 正在降水。
          humidityPct: (() => {
            if (!Number.isFinite(vaporCenter)) return NaN;
            const cap = saturationCapacity(center);
            if (!Number.isFinite(cap) || cap <= 0.01) return NaN;
            return Math.min(160, Math.round((vaporCenter / cap) * 100));
          })(),
          saturated: vaporRef.sat ? vaporRef.sat[mid] === 1 : false,
          vaporPrecip: vaporRef.precip,
          // 潜热回授：本拍降水给温度加了多少，以及累积偏移。
          // 调试时看这两个数就知道「自组织回路有没有在转」。
          latentHeat: latentOffset,
          cloudDrop: vaporRef.cloudDrop,
          snowDrop: vaporRef.snowDrop,
          // 气压 / 风
          P: pressureRef.field,
          pressure: pressureRef.center,
          pressureHPa: Number.isFinite(pressureRef.center) ? Math.round(960 + pressureRef.center * 80) : NaN,
          windField: pressureRef.field ? getWindField() : null,
          pressureSignal: getPressureSignal(),
          pressureDrop: getPressureDrop(),
          updraft: computeUpdraft(),
          terrain: driveTerrain,
        };
      }

      // ======================================================================
      //  雾强度与大气信号
      //
      //  雾 = 湿度足够 × 温度够低 × 风小
      //  三个因子都乘在一起，任何一项为 0 就不起雾 —— 这样「为什么没雾」
      //  可以直接从三个因子看出来，不用猜。
      //
      //  同时产出 visibility（能见度）给未来的地形 / 远景模块复用：
      //  雾只是「大气层」的第一个写入方，不是它的所有者。
      // ======================================================================
      let fogSmooth = 0;

      function computeFog() {
        const mid = gridCount >> 1;
        const temp = driveState.T ? driveState.T[mid] : 0.5;
        const vapor = vaporRef.vapor ? vaporRef.vapor[mid] : 0.5;
        // ① 湿度：按水汽的真实工作区间标定。
        // 水汽不是 0.5~0.9，而是「从很低到容量上限」：
        // 温度 -6°C 时容量只剩 0.33，水汽就卡在 0.33 不动；
        // 温度 30°C 时容量接近 1.0，水汽能到 0.9。
        // 所以阈值取 0.22~0.80：低于 22% 确实干得没边，80% 以上已接近饱和。
        const humidFactor = smoothstep(0.22, 0.80, vapor);
        // ② 温度：低温更容易起雾，但热天也不是完全没有（那是平流雾/霾）。
        // 区间放宽到 0.15..0.95：-20°C 时 1.0，40°C 时仍有 0.05 的底。
        const tempFactor = 1 - smoothstep(0.15, 0.95, temp) * 0.95;
        // ③ 风抑制：风大把雾吹散
        const wind = readInput("__ossWind", (w) => (w && Number.isFinite(w.speed) ? w.speed : 0));
        const windSuppress = 1 - (wind.ok ? Math.max(0, Math.min(1, wind.value)) : 0) * 0.75;
        const raw = humidFactor * tempFactor * windSuppress;
        // 大雨抑制雾：真实的大雨天不起雾。
        // 但用户手动把雨量拉满时以用户为准（手滑杆 > 自动联动），
        // 所以这里只在雨势大、且用户没接管雨量时才打折。
        const downpour = (typeof engine.getDownpour === "function") ? engine.getDownpour() : 0;
        const rainBrake = downpour > 0.6 && !taken.amount ? 0.5 : 1;
        const fog = Math.max(0, Math.min(1, raw * rainBrake));
        // 雾图层已移除，这个值目前只喂 engine.setFog（内部只记录目标值）。
        // __ossAtmos 仍然发布它，将来地形模块要用「能见度」时可以读。
        fogSmooth = fog;
        return { fog, humidFactor, tempFactor, windSuppress, rainBrake };
      }

      function publishAtmos() {
        const f = computeFog();
        win.__ossAtmos = () => {
          const geom = readInput("__ossState", (s) => (s ? 1 : NaN));
          let horizonUV = 0.5, cloudBase = -1;
          if (geom.ok && typeof win.__ossState === "function") {
            try {
              const s = win.__ossState();
              if (s && Number.isFinite(s.horizonUV)) horizonUV = s.horizonUV;
              if (s && Number.isFinite(s.cloudBase)) cloudBase = s.cloudBase;
            } catch (error) { /* 用默认值 */ }
          }
          return {
            visibility: 1 - f.fog,       // 能见度：1 = 全清，0 = 白茫茫
            fog: f.fog,
            // 三个因子分开暴露：调试时能直接看出「为什么没起雾」
            humidFactor: f.humidFactor,
            tempFactor: f.tempFactor,
            windSuppress: f.windSuppress,
            horizonUV, cloudBase,
          };
        };
        return f;
      }

      // ---- 慢拍定时器：必须成对清理（挂什么清什么）
      // 两级节拍：
      //   快拍 fastMs=500ms —— 只跑温度。
      //     原因：昼夜一轮 60 秒、整天温差约 50°C，即 0.83°C/秒。
      //     如果温度也走 2 秒慢拍，面板每次采样之间温度已经跳了 1.7°C，
      //     再取整显示就成了「半天不动的数字」——用户会以为温度场没跑。
      //   慢拍 slowMs=2000ms —— 水汽（蒸发凝结慢）、气压（慢变量）、效果层推送。
      //     这几样确实是慢变量，2 秒一拍是对的。
      let driveTimer = 0;
      let fastTimer = 0;
      function startDrive() {
        if (driveTimer) return;
        if (typeof win.setInterval !== "function") {
          console.warn(DRIVE_LOG, "[drive_no_timer]", "setInterval unavailable");
          return;
        }
        driveSignal("ui", { step: "drive_timer_start", slowMs: DRIVE_CONFIG.slowMs, fastMs: DRIVE_CONFIG.fastMs, grid: gridN });
        // 先跑一拍，不等 2 秒：面板一打开就能看到温度
        syncTerrainReflect();
        stepTemperature();
        stepVapor();
        stepPressure();
        publishWindField();
        // 快拍：温度 + 自演化推进。
        // 【自演化为什么挪到快拍】
        // 原来只在 2 秒慢拍里 stepEvolve + paint()，等于每 2 秒把
        // 太阳亮度、月亮亮度、云量、海况【一次性硬跳】到新值 ——
        // 而 sunPass.params 是直接赋值、没有缓动（见引擎 __ossSunSet），
        // 所以观感就是「太阳月亮一卡一卡的」。
        // 现在按 500ms 推进、每次只走 1/4 步，同样的演化速度，
        // 但参数变化被切成四小段，视觉上连续得多。
        fastTimer = win.setInterval(() => {
          stepTemperature();
          if (evolveState.active) {
            stepEvolve(DRIVE_CONFIG.fastMs / 1000);
            // 【只推轻量的光/云参数，不调 paint()】
            // paint() 里会走 setScene()：那会重建雨滴实例数组、重新分配缓冲区，
            // 是整套流程里最重的一步。放进 500ms 快拍照样会拖帧。
            // 而「太阳月亮卡顿」只跟 pushSun/pushCloud 推的参数有关，
            // 场景（下不下雨、雨还是雪）是 2 秒级的慢变量，留在慢拍重判就够。
            try { pushSun(); } catch (error) { /* 引擎还没起来 */ }
            try { pushCloud(true); } catch (error) { /* 同上 */ }
          }
        }, DRIVE_CONFIG.fastMs);
        driveTimer = win.setInterval(() => {
          // 自演化时每拍做完整重绘：场景判定、雨雪强度、地面推送都在这里，
          // 这些是慢变量，2 秒一拍正合适。
          // 引擎的光/云参数已由上面的快拍平滑推进，所以这里不会出现跳变。
          if (evolveState.active) {
            try { paint(); } catch (error) { console.warn(DRIVE_LOG, "[evolve_paint_failed]", error.message); }
            try { render(readSettings()); } catch (error) { /* 面板没开时忽略 */ }
          }
          stepVapor();
          stepPressure();
          // 风场对外发布：雨雪下一帧就能按位置采样到新的气压梯度风
          publishWindField();
          // ---- 天气联动：每拍推进并推送积雪/湿润 ----
          // 必须在这里推（而不是只在 paint 里），因为 paint 只在设置变化时跑，
          // 而积雪/湿润是随时间累积的 —— 靠 paint 推就永远不会累积。
          // 这是 weatherCover() 唯一的调用点：它推进内部累积量，
          // 每拍只能调一次，否则累积量会双倍增长。
          try {
            lastWeather = weatherCover();
            pushWeather();
          } catch (error) { /* 引擎还没起来，下一拍再来 */ }
          // 形态每拍重判一次：降水率是这一拍才刚算出来的，
          // 只在设置变化时判会导致「湿度拉上去了，但场景还是 none」。
          // 只有真的变了才重绘（setScene 会重建雨滴数组）。
          try {
            const mid0 = gridCount >> 1;
            const t0 = driveState.T ? driveState.T[mid0] : NaN;
            const tC = Number.isFinite(t0)
              ? DRIVE_CONFIG.displayMin + (DRIVE_CONFIG.displayMax - DRIVE_CONFIG.displayMin) * t0
              : NaN;
            const shape = shapeFor(tC, VAPOR.precip);
            if (shape !== lastShape) {
              lastShape = shape;
              paint();
              driveSignal("ui", { step: "shape_change", shape: shape, temp: Number((tC || 0).toFixed(1)), precip: Number(VAPOR.precip.toFixed(4)) });
            }
          } catch (error) { console.warn(DRIVE_LOG, "[shape_auto_failed]", error.message); }
          // 效果层读驱动：雨读气压降+水汽降水率、雪读温度+冰晶量、雷读上升气流
          try {
            const mid = gridCount >> 1;
            const temp = driveState.T ? driveState.T[mid] : NaN;
            const labels = TERRAIN_LABELS[driveTerrain] || TERRAIN_LABELS.forest;
            engine.setDrive(getPressureDrop(), temp, VAPOR.precip, VAPOR.snowDrop ? VAPOR.snowDrop[mid] : 0, computeUpdraft(), labels.surface);
          } catch (error) { console.warn(DRIVE_LOG, "[drive_push_failed]", error.message); }
          // 云读气压升降信号 + 水汽（原料）：气压降→生云、气压升→散云
          try { pushCloud(); } catch (error) { console.warn(DRIVE_LOG, "[cloud_push_failed]", error.message); }
          // 雾：用户拉多少就是多少（受温湿度压一档，干热时拉满也不该起）。
          // 同时发布 __ossAtmos（能见度 + 三个因子）供未来地形模块复用。
          try {
            publishAtmos();
            const fp = Math.max(0, Math.min(1, effectiveSlider("fogPos") / 100));
            // 雾量滑杆是主控：拉多少就起多少。
            // 温湿度只做「轻微抑制」而不是乘法打折 —— 乘法会把滑杆 60 打到 0.08 以下，
            // 用户会觉得「拉了没反应」。下限保 55%，干热时最多压到一半左右。
            const f = computeFog();
            const damp = 0.55 + 0.25 * f.humidFactor + 0.20 * f.tempFactor;
            engine.setFog(fp * damp);
          } catch (error) { console.warn(DRIVE_LOG, "[fog_failed]", error.message); }
        }, DRIVE_CONFIG.slowMs);
      }
      function stopDrive() {
        if (fastTimer) { win.clearInterval(fastTimer); fastTimer = 0; }
        if (!driveTimer) return;
        win.clearInterval(driveTimer);
        driveTimer = 0;
        // 风场输出口也要撤掉：挂什么清什么
        try { delete win.__ossWindField; } catch (error) { win.__ossWindField = undefined; }
        try { delete win.__ossAtmos; } catch (error) { win.__ossAtmos = undefined; }
        driveSignal("ui", { step: "drive_timer_stop", tick: driveState.tick });
      }

      // 雨反哺光：天气引擎每半秒重算雨量后喊一声，这里把新雨势推给光。
      // 雨大到一定程度，太阳就会被雨幕柔化（光晕变大变弥散、本体略暗）。
      engine.onDownpour(pushSun);

      // 时间流逝 → 速度倍率。滑杆 50 = 1.0x（正常），100 = 10x 快进，0 = 0.1x 慢放。
      // 几何插值，且以 50 为中点对称：中点必须正好是 1.0，
      // 否则升级后默认值一上来就不是正常速度，用户会以为「变快了」。
      const TIME_SCALE_FAST = 10;    // 滑杆 100 的倍率
      const TIME_SCALE_SLOW = 0.1;   // 滑杆 0 的倍率
      function timeScaleAt(pos) {
        const t = Math.max(0, Math.min(100, Number(pos) || 0)) / 100;
        if (t >= 0.5) {
          // 0.5..1 → 1x..10x
          const u = (t - 0.5) * 2;
          return Math.pow(TIME_SCALE_FAST, u);
        }
        // 0..0.5 → 0.1x..1x（反向几何，保证中点连续）
        const u = 1 - t * 2;
        return Math.pow(TIME_SCALE_SLOW, u);
      }
      function formatTimeScale(pos) {
        const v = timeScaleAt(pos);
        return (v < 1 ? v.toFixed(2) : v.toFixed(1)) + "×";
      }

      function render(settings) {
        // 自演化时，面板显示的是「系统算出来的值」，不是设置里的值 ——
        // 否则会出现「滑杆不动但天气在变」，用户看不出是系统在接管。
        const current = withEvolved(settings);
        enabledBox.checked = current.enabled;
        if (seaVisibleBox) seaVisibleBox.checked = current.seaVisible !== false;
        if (groundVisibleBox) groundVisibleBox.checked = current.groundVisible === true;
        if (groundDensityRange) groundDensityRange.value = String(current.groundDensity);
        if (groundDensityValue) groundDensityValue.textContent = current.groundDensity + "%";
        if (flowerDensityRange) flowerDensityRange.value = String(current.flowerDensity);
        if (flowerDensityValue) flowerDensityValue.textContent = current.flowerDensity + "%";
        if (snowCoverRange) snowCoverRange.value = String(current.snowCover);
        // 自演化开启时，积雪/积水滑杆禁用：那两个值完全由天气系统决定，
        // 滑杆还能拖会让用户以为手动有效，实际不生效。
        const wxLocked = evolveState.active;
        if (snowCoverRange) snowCoverRange.disabled = wxLocked;
        if (wetnessRange) wetnessRange.disabled = wxLocked;
        if (snowCoverValue) snowCoverValue.textContent = current.snowCover + "%";
        if (wetnessRange) wetnessRange.value = String(current.wetness);
        if (wetnessValue) wetnessValue.textContent = current.wetness + "%";
        seaRange.value = String(current.sea);
        seaValue.textContent = String(current.sea).padStart(2, "0");
        timeRange.value = String(current.time);
        cycleBox.checked = current.autoCycle;
        glassRange.value = String(current.glass);
        glassValue.textContent = current.glass + "%";
        // 日夜速度：显示实际的一轮时长。滑杆 50 = 60 秒一轮。
        if (timeScaleRange) timeScaleRange.value = String(current.timeScale);
        if (timeScaleValue) timeScaleValue.textContent = formatTimeScale(current.timeScale);
        // ---- 天气沙盒：三条规则滑杆 ----
        // 温度显示实际 °C（滑杆位置没有意义，温度才有）
        if (tempRange) tempRange.value = String(current.tempPos);
        if (tempValue) tempValue.textContent = tempAt(current.tempPos).toFixed(0) + "°C";
        if (humidRange) humidRange.value = String(current.humidPos);
        if (humidValue) humidValue.textContent = current.humidPos + "%";
        // 0°C 参照线：让用户知道往左就下雪
        if (freezeNote) {
          freezeNote.textContent = copy.freezeHint;
        }
        // 状态行：告诉用户「现在在下什么 / 为什么没下」
        if (weatherStateNote) {
          weatherStateNote.textContent = describeWeather(current);
        }
        const on = current.lightning === true;
        // 名字就是开关：文案始终是「闪电」，状态全靠 is-on 的底色 + aria-pressed 表达，
        // 不再在「闪电 / 关」之间换字（换字会让名字时隐时现，反而不好认）。
        if (lightningBox) {
          lightningBox.setAttribute("aria-pressed", on ? "true" : "false");
          lightningBox.classList.toggle("is-on", on);
        }
        if (lightningFreqRange) lightningFreqRange.value = String(current.lightningFreq);
        if (lightningFreqValue) lightningFreqValue.textContent = current.lightningFreq + "%";
        if (lightningCountRange) lightningCountRange.value = String(current.lightningCount);
        if (lightningCountValue) lightningCountValue.textContent = "×" + current.lightningCount;
        // 「闪电只在雨里出现」现在写在天气分组标题的括号里（.oss-summary-note）。
        // 当前不是雨时把它点亮，提示「闪电为什么没反应」。
        // 场景不再由用户选，这里看驱动层算出来的实际形态（precip>0 且温度 >= 0 即下雨）。
        const rainNote = panel.querySelector(".oss-summary-note");
        if (rainNote) {
          const tMid = driveState.T ? driveState.T[gridCount >> 1] : NaN;
          const tC = Number.isFinite(tMid)
            ? DRIVE_CONFIG.displayMin + (DRIVE_CONFIG.displayMax - DRIVE_CONFIG.displayMin) * tMid
            : NaN;
          const rainingNow = (vaporRef.precip || 0) > 0.004 && Number.isFinite(tC) && tC >= 0;
          rainNote.classList.toggle("is-warn", !rainingNow);
        }
      }

      let open = false;
      let previousFocus = null;
      // 面板开着时每 500ms 把版本号和自动昼夜状态显示在底部。
      // 自动昼夜这种「几秒才变一点」的状态靠肉眼盯太阳很难确认。
      // 一行小字：v1.6.5  day 55 auto
      // 温度/水汽/气压那三个读数已按需求移除 —— 面板够乱了，不需要再显示驱动层调试值。
      // 关掉面板就停，不占开销。
      let statusTimer = 0;
      function updateStatus() {
        const el = q("#oss-hint");
        tickDayCount();               // 先推进天数计数，label 才拿得到最新值
        if (!el) return;
        let head = "v" + VERSION;
        if (typeof win.__ossState === "function") {
          try {
            const s = win.__ossState();
            // 累计天数：每走完一轮昼夜 +1。和「昼夜相位」是两回事 ——
            // 相位 day 55 是「现在是下午」，累计天数才是「这个世界过了多少天」。
            head = "v" + VERSION + "  " + dayLabel();
          } catch (error) { /* 引擎没起来就只显示版本 */ }
        }
        el.textContent = head;
      }

      // ---- 累计天数 ----
      // 每走完一轮昼夜算一天。计数落盘，重启不清零。
      // 时间流速快的时候天数涨得也快 —— 那是「游戏时间」，不是真实时间。
      const DAY_COUNT_KEY = "dsh-weather-sandbox/dayCount";
      const DAYS_PER_YEAR = 365;
      function readDayCount() {
        try {
          const v = Number(window.localStorage.getItem(DAY_COUNT_KEY));
          return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
        } catch (e) { return 0; }
      }
      let dayCount = readDayCount();
      let lastPhase = null;          // 上一次采到的昼夜相位（0..100）
      function tickDayCount() {
        let phase = null;
        try {
          if (typeof win.__ossState === "function") {
            const s = win.__ossState();
            if (s && Number.isFinite(s.daylight)) phase = s.daylight;
          }
        } catch (e) { /* 引擎没起来 */ }
        if (phase === null) return;
        // 相位从 ~100 掉回 ~0 就是跨过了一天（自动昼夜才会回绕）
        if (lastPhase !== null && lastPhase > 70 && phase < 30) {
          dayCount += 1;
          try { window.localStorage.setItem(DAY_COUNT_KEY, String(dayCount)); } catch (e) { /* 存不下就只在本次会话记 */ }
        }
        lastPhase = phase;
      }
      // 「1年128天」这种写法。不满一年只写天数。
      function dayLabel() {
        const years = Math.floor(dayCount / DAYS_PER_YEAR);
        const days = dayCount % DAYS_PER_YEAR;
        if (years <= 0) return "第 " + dayCount + " 天";
        return years + " 年 " + days + " 天";
      }

      // ---- 鱼的日记 ----
      // 它的名字。没起名之前叫「它」，起过之后所有地方都用这个名字。
      const PET_NAME_KEY = "dsh-weather-sandbox/petName";
      function readPetName() {
        try { return window.localStorage.getItem(PET_NAME_KEY) || ""; } catch (e) { return ""; }
      }
      function writePetName(n) {
        try {
          if (n) window.localStorage.setItem(PET_NAME_KEY, n);
          else window.localStorage.removeItem(PET_NAME_KEY);
        } catch (e) { /* 存不下就只在本次会话生效 */ }
      }
      // 每次「睡觉与做梦」完整走完（梦里把五根滑杆都推过一遍）记一条。
      // 最多 50 条，旧的自动丢 —— 用户未必会看，但不能无限涨。
      const DIARY_KEY = "dsh-weather-sandbox/diary";
      const DIARY_MAX = 50;
      const DIARY_LABEL = { flower: "花", grass: "草", sun: "天色", sea: "海浪", humid: "湿气" };

      function readDiary() {
        try {
          const raw = window.localStorage.getItem(DIARY_KEY);
          if (!raw) return [];
          const arr = JSON.parse(raw);
          return Array.isArray(arr) ? arr : [];
        } catch (e) { return []; }
      }
      function writeDiary(list) {
        try {
          window.localStorage.setItem(DIARY_KEY, JSON.stringify(list.slice(-DIARY_MAX)));
          return true;
        } catch (e) { return false; }
      }
      // 每种「梦里动作」有多个说法。同一种意思换着说，读起来才不像模板。
      // 数值分档：小幅 / 中幅 / 大幅，用词也跟着变重。
      const ACT_WORDS = {
        flower: {
          up: [
            ["花开了几朵", "花开得多了一点", "花铺满了整片坡", "把花全催开了，一层压一层"],
            ["草尖上冒了新芽", "冒出一小片新芽", "新芽窜得比草还高"],
          ],
          down: [
            ["花落了", "把花收回去一些", "让花全谢了"],
          ],
        },
        grass: {
          up: [["草长高了一点", "草长得更旺", "草一直长到看不见脚"]],
          down: [["草矮了下去", "把草压平了"]],
        },
        sun: {
          up: [["天色往后推了一点", "把太阳往后挪了挪", "把整片天推到了傍晚"]],
          down: [["天色往回拨了一点", "把太阳往前拉了一截", "把夜也拉过来了"]],
        },
        sea: {
          up: [["海起了些波纹", "海翻起了浪", "海整个立了起来"]],
          down: [["海静了下来", "海面平得像一块铜", "把海按住了，一点声都没有"]],
        },
        humid: {
          up: [["空气里多了点水汽", "空气潮了起来", "空气浓得能拧出水"]],
          down: [["空气干了一点", "把空气吹得很干"]],
        },
      };
      // 变化幅度 → 用第几档说法（0 小 / 1 中 / 2 大）
      function magnitude(diff) {
        const a = Math.abs(diff);
        if (a >= 55) return 2;
        if (a >= 30) return 1;
        return 0;
      }
      function pickFrom(arr) { return arr[(Math.random() * arr.length) | 0]; }
      // 把梦里推的峰值翻译成人话。返回「每一根滑杆的句子」和强度统计。
      function describeDream(peaks) {
        const out = [];
        let intensity = 0;
        for (const k of Object.keys(DIARY_LABEL)) {
          const d = peaks[k];
          if (!d) continue;
          const diff = d.peak - d.home;
          if (Math.abs(diff) < 12) continue;
          const pool = ACT_WORDS[k];
          if (!pool) continue;
          const dir = diff > 0 ? "up" : "down";
          const bands = pool[dir];
          if (!bands || !bands.length) continue;
          const band = bands[Math.min(magnitude(diff), bands.length - 1)];
          out.push(pickFrom(band));
          intensity += 1 + magnitude(diff);
        }
        return { parts: out, intensity };
      }
      // 天气在正文里的呼应 —— 让「昨晚下雪了」和正文连起来。
      const WEATHER_ECHO = {
        "晴": ["醒来光很足。", "醒来天是透亮的。", "醒来日头晒在背上。"],
        "多云": ["醒来云还在慢慢挪。", "醒来云压得不高。"],
        "阴": ["醒来天是灰的。", "醒来云把光都吞了。"],
        "雨": ["醒来还听见雨。", "醒来雨没停。", "醒来身上是湿的。"],
        "雷雨": ["醒来远处还在响。", "醒来空气里有雷电留下的味道。"],
        "雪": ["醒来雪积了厚厚一层。", "醒来脚边是雪。", "醒来天地都是白的。"],
      };
      // 跨年时的额外一句。只在刚过整年时出现，所以每次看到都像件事。
      function yearLine(day) {
        if (day <= 0) return "";
        const y = Math.floor(day / DAYS_PER_YEAR);
        if (y <= 0) return "";
        const rest = day % DAYS_PER_YEAR;
        if (rest > 3) return "";      // 只在刚跨年的头几天说
        if (y === 1) return "这是第二个年头的开头。第一个年头怎么过的，记不太清了。";
        if (y === 2) return "又过了一整年。这是第三年。";
        return "第" + (y + 1) + "个年头开始了。已经不太去数了。";
      }
      function addDiaryEntry(peaks) {
        const dd = describeDream(peaks || {});
        const acts = dd.parts;
        if (!acts.length) return false;

        const weather = currentWeatherWord();
        const lines = [];

        // ① 梦的主体。一句里放不下就拆成两句，别堆成长句。
        if (acts.length === 1) {
          lines.push("梦里" + acts[0] + "。");
        } else if (acts.length === 2) {
          lines.push("梦里" + acts[0] + "，又" + acts[1] + "。");
        } else {
          lines.push("梦里先是" + acts[0] + "，又" + acts[1] + "。");
          lines.push("后来" + acts[2] + "。");
        }

        // ② 强度决定梦留下的余味
        if (dd.intensity >= 7) {
          lines.push(pickFrom(["醒来得花了一阵才认得出这是哪。", "醒来手还在动，像没离开过。", "醒来觉得梦比醒着更长。"]));
        } else if (dd.intensity >= 4) {
          lines.push(pickFrom(["醒来还记得那个样子。", "醒来愣了一下才回过神。"]));
        } else {
          lines.push(pickFrom(["醒来做的东西没留下什么痕迹。", "醒来不太确定是梦还是走神。"]));
        }

        // ③ 天气呼应：只有读到天气时才写，读不到就跳过（不编）
        const echo = WEATHER_ECHO[weather];
        if (echo) lines.push(pickFrom(echo));

        // ④ 跨年那句
        const yl = yearLine(dayCount);
        if (yl) lines.push(yl);

        const entry = {
          day: dayCount,
          time: Date.now(),
          weather,
          text: lines.join(""),
        };
        const list = readDiary();
        list.push(entry);
        return writeDiary(list);
      }

      // 睡觉那一刻的天气，从驱动层的实际读数推出来 —— 不看用户滑杆，看天真的样子。
      function currentWeatherWord() {
        let w = null;
        try {
          if (typeof win.__openSeaShelter === "object" && win.__openSeaShelter) {
            w = win.__openSeaShelter.drive();
          }
        } catch (e) { w = null; }
        if (!w || !w.ready) return "";
        const precip = w.vaporPrecip || 0;
        const tempC = Number.isFinite(w.centerC) ? w.centerC : 20;
        if (precip > 0.01) {
          if (tempC < 0) return "雪";
          if ((w.updraft || 0) > 0.15) return "雷雨";
          return "雨";
        }
        const humid = w.humidityPct || 0;
        if (humid > 85) return "阴";
        if (humid > 70) return "多云";
        return "晴";
      }

      function setOpen(next) {
        open = !!next;
        panel.hidden = !open;
        fab.setAttribute("aria-expanded", open ? "true" : "false");
        if (open) {
          // 子面板默认收起（display="none"），由「其他地形」按钮打开。
          // 这里不动它 —— 主面板重开时子面板保持收起是符合直觉的。
          previousFocus = doc.activeElement;
          const first = panel.querySelector("input, button");
          if (first instanceof HTMLElement) first.focus();
          updateStatus();
          if (!statusTimer) statusTimer = win.setInterval(updateStatus, 500);
        } else {
          if (statusTimer) { win.clearInterval(statusTimer); statusTimer = 0; }
          // 主面板关掉时，左侧的草地子面板也要一起收起，
          // 否则会留一个没有归属的悬浮框挂在屏幕上。
          //
          // 只用一个状态：行内 display。不再碰 hidden 属性。
          grassPanel.style.display = "none";
          const tb = panel.querySelector(".oss-terrain-btn");
          if (tb) tb.setAttribute("aria-expanded", "false");
          if (previousFocus instanceof HTMLElement) {
            previousFocus.focus();
            previousFocus = null;
          }
        }
      }

      const listeners = new Set();

      // 状态行文案：直接告诉用户「现在在下什么、为什么没下」。
      // 沙盒的滑杆调的是状态而不是画面，所以必须有个仪表盘解释结果，
      // 否则用户拉高湿度却没雨时会以为滑杆坏了。
      function describeWeather(current) {
        const mid = gridCount >> 1;
        const tNorm = driveState.T ? driveState.T[mid] : NaN;
        const hNorm = vaporRef.vapor ? vaporRef.vapor[mid] : NaN;
        const precip = vaporRef.precip || 0;
        if (!Number.isFinite(tNorm) || !Number.isFinite(hNorm)) return "";
        const tempC = DRIVE_CONFIG.displayMin + (DRIVE_CONFIG.displayMax - DRIVE_CONFIG.displayMin) * tNorm;
        const cap = saturationCapacity(tNorm);
        const shape = shapeFor(tempC, precip);
        // 显示饱和度（水汽/容量），不是绝对水汽 —— 绝对值会永远贴着容量走，
        // 用户看到「卡在 51%」会以为滑杆坏了。
        const satPct = Number.isFinite(cap) && cap > 0.01 ? Math.round((hNorm / cap) * 100) : NaN;
        if (shape === "none") {
          const need = Number.isFinite(satPct) ? Math.max(0, 100 - satPct) : NaN;
          return copy.stateDry + "  " + satPct + "%  " + copy.stateNeed + need + "%";
        }
        const label = shape === "snow" ? copy.stateSnow : copy.stateRain;
        return label + "  " + satPct + "%  " + copy.stateSaturated;
      }

      function commit(patch) {
        writeSettings(patch);
        paint();
        for (const listener of listeners) listener(readSettings());
      }

      // ---- 天气配方 ----
      // 只存「天气参数」，不存主体设置 —— 鱼的状态不属于天气。
      // 列表第一项永远是「出厂设置」（来自 DEFAULTS），删不掉。
      const RECIPES_KEY = "dsh-weather-sandbox/recipes";
      // 这些字段组成一份配方。全部是 SETTING_SCHEMA 里有的键。
      const RECIPE_KEYS = [
        "seaVisible", "sea", "time", "autoCycle", "timeScale", "glass",
        "tempPos", "humidPos", "fogPos", "lightning", "lightningFreq", "lightningCount",
        "cloudEnabled", "cloudAuto", "cloudAmount", "cloudDensity", "cloudUnite",
        "cloudOpacity", "cloudWind", "starBright",
        "sunBright", "moonBright", "glow", "radius",
        // 地形也算天气的一部分：「雪后草原」这种配方没草就不成立。
        // 草地子面板那个独立的「设为默认」已经删掉了 —— 两套存储并存必然打架，
        // 一个配方就该是「整片世界长什么样」的完整快照。
        "groundVisible", "groundDensity", "flowerDensity", "snowCover", "wetness",
      ];

      function readRecipes() {
        try {
          const raw = window.localStorage.getItem(RECIPES_KEY);
          if (!raw) return [];
          const arr = JSON.parse(raw);
          if (!Array.isArray(arr)) return [];
          // 只保留有名字、有参数的条目；旧格式坏了就当没有
          return arr.filter((r) => r && typeof r.name === "string" && r.params && typeof r.params === "object");
        } catch (error) {
          return [];
        }
      }
      function writeRecipes(list) {
        try {
          window.localStorage.setItem(RECIPES_KEY, JSON.stringify(list));
          return true;
        } catch (error) {
          return false;
        }
      }
      function snapshotRecipe() {
        const s = readSettings();
        const out = {};
        for (const k of RECIPE_KEYS) out[k] = s[k];
        return out;
      }
      // 保存一个命名配方。同名就覆盖（用户想改那个名字）。
      function saveRecipe(name) {
        const trimmed = String(name || "").trim();
        if (!trimmed) return false;
        const list = readRecipes();
        const item = { id: String(Date.now()), name: trimmed.slice(0, 24), params: snapshotRecipe() };
        const idx = list.findIndex((r) => r.name === item.name);
        if (idx >= 0) list[idx] = item;
        else list.push(item);
        return writeRecipes(list);
      }
      function deleteRecipe(id) {
        const list = readRecipes().filter((r) => r.id !== id);
        return writeRecipes(list);
      }
      // 应用一个配方：把参数写回设置。用 commit 而不是 commitLive ——
      // 后者会记 heldBy，等于「用户接管」，把自演化永久挡住。
      function applyRecipe(params) {
        const patch = {};
        for (const k of RECIPE_KEYS) {
          if (params[k] !== undefined) patch[k] = params[k];
        }
        commit(patch);
      }
      // 哪个配方被设成了「启动默认」。存在 localStorage 里，重启后还在。
      const DEFAULT_RECIPE_KEY = "dsh-weather-sandbox/defaultRecipe";
      function readDefaultRecipeId() {
        try { return window.localStorage.getItem(DEFAULT_RECIPE_KEY) || ""; } catch (e) { return ""; }
      }
      function setDefaultRecipeId(id) {
        try {
          if (id) window.localStorage.setItem(DEFAULT_RECIPE_KEY, id);
          else window.localStorage.removeItem(DEFAULT_RECIPE_KEY);
        } catch (e) { /* 存不下就只在本次会话生效 */ }
      }


      let sliderFrame = 0;
      let pendingSlider = null;
      // 【by 是必填的】调参必须说明是谁在调。
      //   重蹈的覆辙：这个函数原来只有「调什么」，没有「谁调」，于是 AI 走这条路
      //   也会被记成用户，自演化被自己的调参关掉（见 heldBy 上面的注释）。
      //   没有默认值 —— 默认值正是这道缺口当初能藏住的原因。
      //   AI 走这里同样会抢走参数，这是对的：AI 调过就没收，和自己调过是一个规矩。
      function commitLive(patch, by) {
        if (by !== "user" && by !== "ai") {
          console.warn("[Open Sea Shelter] commitLive 缺来源，参数被丢弃", patch);
          return;
        }
        // 【谁调，谁就抢回控制权】
        // 自演化正在推动的某个参数，只要有一方亲手动了，就记进 heldBy，
        // 之后 effectiveSlider 不再返回系统值，而是老老实实返回设置里的值。
        // 这样「系统演化」和「玩家 / AI 随时能调」几件事可以共存：
        // 没人碰的时候天气自己走，一动手就完全听那一方的。
        //
        // 【玩家一动就退出自演化】
        // 原来只记 heldBy：自演化还开着，但那一项归玩家 —— 结果是「半接管」：
        // 按钮亮着、系统还在跑，可温度永远不动了，玩家也搞不清现在到底谁在管。
        // 自演化和手动调参本来就是互斥的两个意图，拖滑杆等于说「这个我自己来」，
        // 那就把开关关掉，语义最干净。只对玩家生效：AI 调参不该关掉玩家开的自演化。
        if (evolveState.active && by === "user") {
          let ownsTrack = false;
          for (const key of Object.keys(patch)) {
            if (EVOLVE_TRACKS[key]) ownsTrack = true;
          }
          if (ownsTrack) {
            setEvolve(false);
            const btn = document.querySelector(".oss-evolve");
            if (btn) btn.setAttribute("aria-pressed", "false");
          }
        }
        pendingSlider = patch;
        const fresh = normalize({ ...readSettings(), ...patch });
        render(fresh);
        if (sliderFrame) return;
        sliderFrame = window.requestAnimationFrame(() => {
          sliderFrame = 0;
          if (!pendingSlider) return;
          const value = pendingSlider;
          pendingSlider = null;
          commit(value);
        });
      }
      function clearSliderFrame() {
        if (sliderFrame) window.cancelAnimationFrame(sliderFrame);
        sliderFrame = 0;
        if (pendingSlider) {
          const value = pendingSlider;
          pendingSlider = null;
          commit(value);
        }
      }

      listeners.add(render);

      const onFab = () => setOpen(!open);
      fab.addEventListener("click", onFab);
      q(".oss-close").addEventListener("click", () => setOpen(false));
      // ---- 配方：保存 / 列表 / 删除 ----
      // 「保存配方」→ 弹命名框 → 确定就存进列表；点 ✕ 取消就什么都不存。
      // 「配方 ▾」→ 展开列表，第一项「出厂设置」（来自 DEFAULTS），
      //            下面是用户存的配方，每项右边一个 ✕ 可以删。
      const recipeSaveBtn = q(".oss-recipe-save");
      const recipeOpenBtn = q(".oss-recipe-open");

      // 命名框：一个浮在主面板底部的小输入条。
      const recipeNamer = doc.createElement("div");
      recipeNamer.className = "oss-recipe-namer";
      recipeNamer.style.cssText = [
        // 必须比面板高：面板是 2147480101、草地子面板 2147480102。
        // 写 99 的时候输入框被面板整个盖住 —— 用户看到的就是「没有浮在面板之上」。
        "display:none", "position:fixed", "z-index:2147480110",
        "align-items:center", "gap:6px",
        // 只留这一层：外面的框。输入框自己不再画边框/背景，否则就是双夹层。
        "padding:4px 8px", "border-radius:8px",
        "background:color-mix(in srgb, var(--dsw-alias-bg-layer-3, #fff) 92%, transparent)",
        "border:1px solid #d9a93c99",
        "backdrop-filter:blur(10px)", "-webkit-backdrop-filter:blur(10px)",
        "box-shadow:0 2px 12px #00000033",
        "font:inherit", "font-size:11px",
      ].join(";");
      recipeNamer.innerHTML = [
        '<input class="oss-recipe-input" type="text" maxlength="24" placeholder="起个名字"',
        ' style="width:104px;padding:2px 0;border:0;background:transparent;',
        'color:inherit;font:inherit;outline:none" />',
        '<button type="button" class="oss-recipe-ok" style="border:0;background:transparent;color:#c9922a;',
        'font:inherit;font-weight:600;cursor:pointer;padding:2px 3px">确定</button>',
        '<button type="button" class="oss-recipe-cancel" style="border:0;background:transparent;color:#888;',
        'font:inherit;cursor:pointer;padding:2px 3px">✕</button>',
      ].join("");
      (doc.body || doc.documentElement).appendChild(recipeNamer);
      const recipeInput = recipeNamer.querySelector(".oss-recipe-input");
      const hideNamer = () => { recipeNamer.style.display = "none"; };
      const showNamer = () => {
        const r = recipeSaveBtn.getBoundingClientRect();
        // 右对齐到「保存配方」按钮的右边缘，再往左收一点点。
        // 之前是 left = 按钮左 - 40，结果整条伸到屏幕右边去，「确定」点不到。
        recipeNamer.style.display = "inline-flex";   // 先显示，才量得到宽度
        const w = recipeNamer.offsetWidth || 180;
        const rightEdge = r.right;
        recipeNamer.style.left = Math.max(8, rightEdge - w) + "px";
        recipeNamer.style.top = (r.top - 44) + "px";
        recipeInput.value = "";
        win.setTimeout(() => { try { recipeInput.focus(); } catch (e) { /* 忽略 */ } }, 0);
      };

      // 配方列表：一个浮层，点「配方 ▾」展开。
      const recipeList = doc.createElement("div");
      recipeList.className = "oss-recipe-list";
      recipeList.style.cssText = [
        // 同上：列表也要压在面板之上
        "display:none", "position:fixed", "z-index:2147480110",
        "min-width:190px", "max-width:240px", "max-height:320px", "overflow:auto",
        "padding:6px", "border-radius:10px",
        "background:color-mix(in srgb, var(--dsw-alias-bg-layer-3, #fff) 94%, transparent)",
        "border:1px solid #d9a93c99",
        "backdrop-filter:blur(12px)", "-webkit-backdrop-filter:blur(12px)",
        "box-shadow:0 4px 18px #00000040",
        "font:inherit", "font-size:11.5px",
      ].join(";");
      (doc.body || doc.documentElement).appendChild(recipeList);

      const closeRecipeList = () => { recipeList.style.display = "none"; };
      const renderRecipeList = () => {
        const rows = [];
        const defId = readDefaultRecipeId();
        // 第一项永远是出厂设置。它也要能「设为默认」——
        // 用户调乱了想回到干净状态当启动基准，这条路必须留着。
        // 出厂设置的默认标记用空字符串表示（id 为空 = 默认就是出厂值）。
        const builtinIsDefault = !defId;
        rows.push(
          '<div class="oss-recipe-item oss-recipe-builtin" data-builtin="1" style="display:flex;align-items:center;gap:6px;',
          'padding:5px 7px;border-radius:6px;cursor:pointer">',
          '<span style="flex:1;font-weight:600;color:' + (builtinIsDefault ? "#e8b64a" : "#fff") + '">出厂设置</span>',
          '<button type="button" class="oss-recipe-def" data-def="__builtin__"',
          ' style="display:none;border:0;background:transparent;color:#c9922a;cursor:pointer;',
          'font:inherit;font-size:10px;padding:0 3px;white-space:nowrap">设为默认</button>',
          '</div>'
        );
        const list = readRecipes();
        for (const r of list) {
          // 当前启动默认的那一条标黄
          const isDef = defId && r.id === defId;
          const nameColor = isDef ? "#e8b64a" : "#fff";
          rows.push(
            '<div class="oss-recipe-item" data-id="' + r.id + '" style="display:flex;align-items:center;gap:6px;',
            'padding:5px 7px;border-radius:6px;cursor:pointer;position:relative">',
            '<span style="flex:1;color:' + nameColor + '">' + String(r.name).replace(/[<>&]/g, "") + '</span>',
            // 悬停才出现的小字「设为默认」。mouseenter/mouseleave 控制显隐。
            '<button type="button" class="oss-recipe-def" data-def="' + r.id + '"',
            ' style="display:none;border:0;background:transparent;color:#c9922a;cursor:pointer;',
            'font:inherit;font-size:10px;padding:0 3px;white-space:nowrap">设为默认</button>',
            '<button type="button" class="oss-recipe-del" data-del="' + r.id + '" title="删除"',
            ' style="border:0;background:transparent;color:#999;cursor:pointer;font:inherit;padding:0 2px">✕</button>',
            '</div>'
          );
        }
        if (!list.length) {
          rows.push('<div style="padding:6px 8px;color:#888;font-size:10.5px">还没有保存过配方</div>');
        }
        recipeList.innerHTML = rows.join("");
        // 悬停显示 / 隐藏「设为默认」
        for (const item of recipeList.querySelectorAll(".oss-recipe-item")) {
          const btn = item.querySelector(".oss-recipe-def");
          if (!btn) continue;
          item.addEventListener("mouseenter", () => { btn.style.display = "inline-block"; });
          item.addEventListener("mouseleave", () => { btn.style.display = "none"; });
        }
      };

      const openRecipeList = () => {
        renderRecipeList();
        const r = recipeOpenBtn.getBoundingClientRect();
        recipeList.style.left = Math.max(8, r.right - 200) + "px";
        recipeList.style.top = Math.max(8, r.top - 8 - 320) + "px";
        recipeList.style.display = "block";
      };

      if (recipeSaveBtn) {
        recipeSaveBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          showNamer();
        });
      }
      recipeNamer.querySelector(".oss-recipe-cancel").addEventListener("click", hideNamer);
      recipeNamer.querySelector(".oss-recipe-ok").addEventListener("click", () => {
        if (saveRecipe(recipeInput.value)) {
          hideNamer();
          if (recipeSaveBtn) {
            recipeSaveBtn.classList.add("is-saved");
            win.setTimeout(() => recipeSaveBtn.classList.remove("is-saved"), 1200);
          }
        } else {
          hideNamer();      // 名字空着就等于取消
        }
      });
      recipeInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { recipeNamer.querySelector(".oss-recipe-ok").click(); }
        if (e.key === "Escape") { hideNamer(); }
        e.stopPropagation();   // 别让方向键/回车跑到世界那边去
      });

      if (recipeOpenBtn) {
        recipeOpenBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          if (recipeList.style.display === "block") closeRecipeList();
          else openRecipeList();
        });
      }
      recipeList.addEventListener("click", (e) => {
        // 「设为默认」优先：把这个配方冻结成启动默认，然后应用它、关面板、关列表。
        const def = e.target.closest && e.target.closest("[data-def]");
        if (def) {
          e.stopPropagation();
          const id = def.getAttribute("data-def");
          if (id === "__builtin__") {
            // 把出厂值冻结成启动基准。id 记成空 = 「默认就是出厂值」。
            setDefaultRecipeId("");
            commit(normalize(DEFAULTS));
            saveUserDefaults(normalize(DEFAULTS));
          } else {
            const rec = readRecipes().find((r) => r.id === id);
            if (!rec) return;
            setDefaultRecipeId(id);
            applyRecipe(rec.params);
            saveUserDefaults();        // 把当前（刚应用的）参数写进启动基准
          }
          renderRecipeList();          // 让名字立刻变黄
          closeRecipeList();
          setOpen(false);              // 主面板也收起来
          return;
        }
        const del = e.target.closest && e.target.closest("[data-del]");
        if (del) {
          e.stopPropagation();
          const id = del.getAttribute("data-del");
          deleteRecipe(id);
          // 删掉的正好是启动默认那条：把默认标记也清掉
          if (readDefaultRecipeId() === id) setDefaultRecipeId("");
          renderRecipeList();
          return;
        }
        const item = e.target.closest && e.target.closest(".oss-recipe-item");
        if (!item) return;
        e.stopPropagation();
        if (item.getAttribute("data-builtin") === "1") {
          commit(normalize(DEFAULTS));
        } else {
          const id = item.getAttribute("data-id");
          const rec = readRecipes().find((r) => r.id === id);
          if (rec) applyRecipe(rec.params);
        }
        closeRecipeList();
      });
      // 点别处收起列表
      doc.addEventListener("pointerdown", (e) => {
        if (recipeList.style.display !== "block") return;
        if (recipeList.contains(e.target) || (recipeOpenBtn && recipeOpenBtn.contains(e.target))) return;
        closeRecipeList();
      }, true);

      // 纯壁纸模式：进入后屏幕中央会有「回到界面」按钮
      q(".oss-immersive").addEventListener("click", () => {
        setOpen(false);
        setImmersive(true);
      });
      // 纯自演化：系统接管三条规则滑杆，天气自己循环。
      // 打开时以当前滑杆为起点；滑杆变灰表示「现在不归你管」，但仍能看到数值在动。
      const evolveBtn = q(".oss-evolve");
      evolveBtn.addEventListener("click", () => {
        const next = !evolveState.active;
        // 【先更新按钮外观，再做重活】
        // setEvolve / paint / render 里任何一处抛异常，都会让后面的 setAttribute
        // 执行不到，表现就是「点了按钮但没高亮」。先改外观最稳。
        evolveBtn.setAttribute("aria-pressed", next ? "true" : "false");
        try {
          setEvolve(next);
        } catch (error) {
          console.warn("[Open Sea Shelter] evolve toggle failed", error);
          // 状态没切成功就把按钮外观回退，避免显示与实际不一致
          evolveBtn.setAttribute("aria-pressed", evolveState.active ? "true" : "false");
          return;
        }
        // 自演化不接管任何滑块，所以这里也不加任何「变灰」的 class ——
        // 用户随时都能调任何参数。
        // 打开：立刻重绘，让系统算出的值马上生效。
        // 关闭：setEvolve 已经把当前值冻结进设置，这里再重绘一次让面板对齐。
        // 重绘失败不该影响按钮状态，所以各自包一层。
        try { paint(); } catch (error) { console.warn("[Open Sea Shelter] paint failed", error); }
        try { render(readSettings()); } catch (error) { console.warn("[Open Sea Shelter] render failed", error); }
      });

      // ---- 四格按钮里的两个「展开」型按钮 ----
      // 其他地形：往左侧展开子面板（草地）。再点一次收起。
      const terrainBtn = q(".oss-terrain-btn");
      terrainBtn.addEventListener("click", () => {
        // 【只认一个状态，不玩 hidden 和 display 的配合】
        // 原来两个都写：hidden 属性 + 行内 display。expand 时只清 display 不碰 hidden，
        // collapse 时只设 hidden 不碰 display —— 两边各管一半，中间任何一处
        // （比如 setOpen 里的兜底写法）插一脚，状态就错位，表现为「点不动」。
        // 现在唯一的真相是 grassPanel.style.display：
        //   显示 = "block"，隐藏 = "none"。hidden 属性不再参与。
        const showing = grassPanel.style.display === "block";
        grassPanel.style.display = showing ? "none" : "block";
        terrainBtn.setAttribute("aria-expanded", showing ? "false" : "true");
      });
      // 调试模式：在本面板内部往上展开滑块长条。再点一次收起。
      const debugBtn = q(".oss-debug-btn");
      const debugPane = panel.querySelector(".oss-debug");
      debugBtn.addEventListener("click", () => {
        const next = debugPane.hidden;
        debugPane.hidden = !next;
        debugBtn.setAttribute("aria-expanded", next ? "true" : "false");
      });
      // 草地子面板不再有自己的保存按钮 —— 配方统一在主面板底部，
      // 一个配方包含天气 + 地形（见 RECIPE_KEYS）。
      enabledBox.addEventListener("change", () => commit({ enabled: enabledBox.checked }));
      // 只切海面：立刻把开关推给引擎，不等下一拍 —— 用户点了就想看到反应。
      if (seaVisibleBox) {
        seaVisibleBox.addEventListener("change", () => {
          commit({ seaVisible: seaVisibleBox.checked });
          if (typeof win.__ossSeaVisible === "function") {
            try { win.__ossSeaVisible(seaVisibleBox.checked); } catch (error) { /* 下一拍 syncOcean 会补 */ }
          }
        });
      }
      // 草地：立刻推给引擎，不等下一拍。引擎侧 grassPass 可能还没 init，
      // 拿不到接口时静默跳过，下一拍 syncOcean 会补。
      if (groundVisibleBox) {
        groundVisibleBox.addEventListener("change", () => {
          commit({ groundVisible: groundVisibleBox.checked });
          pushGround();
        });
      }
      if (groundDensityRange) {
        groundDensityRange.addEventListener("input", () => {
          commitLive({ groundDensity: Number(groundDensityRange.value) }, "user");
          if (groundDensityValue) groundDensityValue.textContent = groundDensityRange.value + "%";
          pushGround();
        });
        groundDensityRange.addEventListener("change", () => clearSliderFrame());
      }
      // 花密度：和草密度一样，拖动时连续推送
      if (flowerDensityRange) {
        flowerDensityRange.addEventListener("input", () => {
          commitLive({ flowerDensity: Number(flowerDensityRange.value) }, "user");
          if (flowerDensityValue) flowerDensityValue.textContent = flowerDensityRange.value + "%";
          pushGround();
        });
        flowerDensityRange.addEventListener("change", () => clearSliderFrame());
      }
      // 积雪 / 湿润：手动覆盖。拖动即推，松手停拍。
      if (snowCoverRange) {
        snowCoverRange.addEventListener("input", () => {
          commitLive({ snowCover: Number(snowCoverRange.value) }, "user");
          if (snowCoverValue) snowCoverValue.textContent = snowCoverRange.value + "%";
          pushGround();
        });
        snowCoverRange.addEventListener("change", () => clearSliderFrame());
      }
      if (wetnessRange) {
        wetnessRange.addEventListener("input", () => {
          commitLive({ wetness: Number(wetnessRange.value) }, "user");
          if (wetnessValue) wetnessValue.textContent = wetnessRange.value + "%";
          pushGround();
        });
        wetnessRange.addEventListener("change", () => clearSliderFrame());
      }
      seaRange.addEventListener("input", () => commitLive({ sea: Number(seaRange.value) }, "user"));
      seaRange.addEventListener("change", () => clearSliderFrame());
      // 太阳位置滑杆与自动昼夜是互斥的两个模式，这是产品意图，不是 bug：
      //   拖滑杆 → 强制 autoCycle=false（「我要固定看夕阳」）
      //   开开关 → 引擎接管 daylight 循环（「我要看太阳自己动」）
      // 别把 input 里的 autoCycle:false 去掉，那样拖完松手太阳会立刻跑走。
      timeRange.addEventListener("input", () => commitLive({ time: Number(timeRange.value), autoCycle: false }, "user"));
      timeRange.addEventListener("change", () => clearSliderFrame());
      cycleBox.addEventListener("change", () => commit({ autoCycle: cycleBox.checked }));
      glassRange.addEventListener("input", () => commitLive({ glass: Number(glassRange.value) }, "user"));
      glassRange.addEventListener("change", () => clearSliderFrame());
      if (timeScaleRange) {
        timeScaleRange.addEventListener("input", () => commitLive({ timeScale: Number(timeScaleRange.value) }, "user"));
        timeScaleRange.addEventListener("change", () => clearSliderFrame());
      }
      lightningBox.addEventListener("click", () => commit({ lightning: lightningBox.getAttribute("aria-pressed") !== "true" }));
      if (lightningFreqRange) {
        lightningFreqRange.addEventListener("input", () => commitLive({ lightningFreq: Number(lightningFreqRange.value) }, "user"));
        lightningFreqRange.addEventListener("change", () => clearSliderFrame());
      }
      if (lightningCountRange) {
        lightningCountRange.addEventListener("input", () => commitLive({ lightningCount: Number(lightningCountRange.value) }, "user"));
        lightningCountRange.addEventListener("change", () => clearSliderFrame());
      }
      // ---- 沙盒三条规则滑杆 ----
      // 温度：改的是驱动层的目标温度（驱动层向它松弛，不会瞬间跳变）
      if (tempRange) {
        tempRange.addEventListener("input", () => {
          commitLive({ tempPos: Number(tempRange.value) }, "user");
          // 温度一改就重算一次天气，否则积雪/积水要等最多 2 秒才响应
          refreshWeatherNow();
        });
        tempRange.addEventListener("change", () => clearSliderFrame());
      }
      // 湿度：改的是水汽目标值。到饱和才下雨 —— 这是硬规则。
      if (humidRange) {
        humidRange.addEventListener("input", () => {
          commitLive({ humidPos: Number(humidRange.value) }, "user");
          // 湿度一改就重算，否则「拉到下雨」也要等 2 秒
          refreshWeatherNow();
        });
        humidRange.addEventListener("change", () => clearSliderFrame());
      }
      // 雾量滑杆已移除（雾模块本身不在了），这里不再绑事件。
      const onPointer = (event) => {
        if (!open) return;
        // 【必须把左侧子面板也算进来】
        // 只判断 panel.contains 的话，点子面板里的任何控件都会被当成「点在面板外」，
        // 于是立刻 setOpen(false) —— 表现为「子面板一弹出来，点一下就整个消失」。
        if (panel.contains(event.target) || fab.contains(event.target) || grassPanel.contains(event.target)) return;
        setOpen(false);
      };
      const onKey = (event) => {
        if (!open || event.key !== "Escape") return;
        event.preventDefault();
        setOpen(false);
      };
      doc.addEventListener("pointerdown", onPointer, true);
      doc.addEventListener("keydown", onKey);

      const offTheme = ctx.on("theme/change", () => { paint(); });
      const onPageHide = () => { postOcean(readSettings()); };
      win.addEventListener("pagehide", onPageHide);

      render(readSettings());
      // 启动时把存储里的云参数整套同步进 cloudUI（cloudUI 是面板态的本地副本）。
      // 以前这里只同步 auto 一个字段，其余五项每次都是写死的初值。
      Object.assign(cloudUI, cloudFromSettings());
      // 云面板初始值推给引擎（引擎可能还没加载，pushCloud 里会检查）
      renderCloud();
      pushCloud();
      // 光面板同理：引擎加载完才有 __ossSunSet，pushSun 内部会重试
      renderSun();
      pushSun();
      paint();

      // ---- 驱动层启动（温度场第一版）
      // 挂在 paint() 之后：此时引擎的 __ossState/__ossCloud 可能还没就绪，
      // 没关系 —— 第一拍照常走坏输入分支，打 [drive_bad_input] 而不抛错，
      // 等引擎起来后下一拍自动恢复。
      startDrive();
      driveSignal("ui", { step: "drive_started", grid: gridN, terrain: driveTerrain });

      // ---- 大肥鱼启动 ----
      // 等引擎就绪再开始：纹理入口 __ossPetTexture 是引擎脚本里定义的，
      // 脚本没加载前调用会被静默吞掉，鱼会一直停在「没纹理」状态。
      // 轮询只在 petEntity.boot 里做一处 —— 这里只交出「就绪后要做什么」。
      petEntity.boot(() => petScheduler.start());

      // ---- 主体模块开关（试验阶段）----
      // 关掉：停止产帧、清掉引擎里的纹理，Pass 什么都不画。
      // 不做销毁重建 —— 重建要重新等引擎、重新加载图，切一下会闪。
      const petOnBox = q("#oss-pet-on");
      if (petOnBox) {
        petOnBox.addEventListener("change", () => {
          const on = petOnBox.checked;
          try { petEntity.setActive(on); } catch (error) { /* 生灵没起来 */ }
        });
      }

      // ---- 手动让它睡 ----
      // 调调度器暴露的 sleepNow()，它会打断当前这段、走完整的「开始→循环→起来」三连。
      // 只有这条路会弹头顶的梦境面板（sleepByUser = true）。
      const petSleepBtn = q(".oss-pet-sleep");
      if (petSleepBtn) {
        petSleepBtn.addEventListener("click", () => {
          try { petScheduler.sleepNow(); } catch (error) { /* 调度器没起来 */ }
        });
      }
      const petSceneryBtn = q(".oss-pet-scenery");
      if (petSceneryBtn) {
        petSceneryBtn.addEventListener("click", () => {
          try { petScheduler.sceneryNow(); } catch (error) { /* 调度器没起来 */ }
        });
      }

      // ---- 日记浮层 ----
      // 点「日记」展开的一列文字。不做翻页动画 —— 用户未必会看，先让它存在。
      const diaryPanel = doc.createElement("div");
      diaryPanel.className = "oss-diary";
      diaryPanel.style.cssText = [
        "display:none", "position:fixed", "z-index:2147480110",
        // 固定高度，只装得下三条。多了用滚动条拖 —— 不固定的话
        // 条目堆到 50 条时这个框会一直往下长，盖住半个画面。
        // 一行头（10px）+ 正文一行（约 19px）+ 内边距，一条约 44px；
        // 三条 + 标题 + 上下内边距 ≈ 170px。
        "width:260px", "height:170px", "overflow-y:auto", "overflow-x:hidden",
        // 细一点的滚动条，别喧宾夺主
        "scrollbar-width:thin",
        "padding:10px 12px", "border-radius:10px",
        "background:color-mix(in srgb, var(--dsw-alias-bg-layer-3, #fff) 94%, transparent)",
        "border:1px solid #d9a93c99",
        "backdrop-filter:blur(12px)", "-webkit-backdrop-filter:blur(12px)",
        "box-shadow:0 4px 18px #00000040",
        "font:inherit", "font-size:11.5px", "line-height:1.65",
      ].join(";");
      (doc.body || doc.documentElement).appendChild(diaryPanel);

      const renderDiary = () => {
        const list = readDiary();
        const nm = readPetName();
        const titleText = nm ? (nm + "的做梦日记") : "它的做梦日记";
        const title = '<div style="font-size:10px;letter-spacing:.16em;color:#c9922a;'
          + 'margin-bottom:6px">' + titleText.replace(/[<>&]/g, "") + '</div>';
        if (!list.length) {
          diaryPanel.innerHTML = title
            + '<div style="color:#888;font-size:10.5px">还没有做过梦。点「睡觉与做梦」，等它睡一觉。</div>';
          return;
        }
        const rows = list.slice().reverse().map((e) => {
          const day = Number.isFinite(e.day) ? e.day : 0;
          const y = Math.floor(day / DAYS_PER_YEAR);
          const stamp = y > 0 ? (y + " 年 " + (day % DAYS_PER_YEAR) + " 天") : ("第 " + day + " 天");
          const wx = e.weather ? (" · " + String(e.weather).replace(/[<>&]/g, "")) : "";
          return '<div style="padding:5px 0;border-top:1px solid #00000010">'
            + '<div style="color:#c9922a;font-size:10px">' + stamp + wx + '</div>'
            + '<div>' + String(e.text || "").replace(/[<>&]/g, "") + '</div></div>';
        });
        diaryPanel.innerHTML = title + rows.join("");
      };

      const petDiaryBtn = q(".oss-pet-diary");
      if (petDiaryBtn) {
        petDiaryBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          if (diaryPanel.style.display === "block") { diaryPanel.style.display = "none"; return; }
          renderDiary();
          const r = petDiaryBtn.getBoundingClientRect();
          diaryPanel.style.left = Math.max(8, Math.min(window.innerWidth - 270, r.right - 260)) + "px";
          diaryPanel.style.top = Math.max(8, r.top - 12 - 320) + "px";
          diaryPanel.style.display = "block";
        });
      }
      // 点别处收起
      doc.addEventListener("pointerdown", (e) => {
        if (diaryPanel.style.display !== "block") return;
        if (diaryPanel.contains(e.target) || (petDiaryBtn && petDiaryBtn.contains(e.target))) return;
        diaryPanel.style.display = "none";
      }, true);

      // ---- 给它起名 ----
      // 起过名之后日记标题变成「小南的日记」。没起名保持「它的日记」。
      const petNameBtn = q(".oss-pet-name");
      const nameBox = doc.createElement("div");
      nameBox.className = "oss-pet-namer";
      nameBox.style.cssText = [
        "display:none", "position:fixed", "z-index:2147480110",
        "align-items:center", "gap:6px", "padding:4px 8px", "border-radius:8px",
        "background:color-mix(in srgb, var(--dsw-alias-bg-layer-3, #fff) 94%, transparent)",
        "border:1px solid #d9a93c99",
        "backdrop-filter:blur(12px)", "-webkit-backdrop-filter:blur(12px)",
        "box-shadow:0 2px 12px #00000033",
        "font:inherit", "font-size:11px",
      ].join(";");
      nameBox.innerHTML = [
        '<input class="oss-pet-name-input" type="text" maxlength="12" placeholder="给它起个名字"',
        ' style="width:96px;padding:2px 0;border:0;background:transparent;color:inherit;',
        'font:inherit;outline:none" />',
        '<button type="button" class="oss-pet-name-ok" style="border:0;background:transparent;',
        'color:#c9922a;font:inherit;font-weight:600;cursor:pointer;padding:2px 3px">确定</button>',
        '<button type="button" class="oss-pet-name-cancel" style="border:0;background:transparent;',
        'color:#888;font:inherit;cursor:pointer;padding:2px 3px">✕</button>',
      ].join("");
      (doc.body || doc.documentElement).appendChild(nameBox);
      const nameInput = nameBox.querySelector(".oss-pet-name-input");
      const hideNameBox = () => { nameBox.style.display = "none"; };
      if (petNameBtn) {
        petNameBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          if (nameBox.style.display === "inline-flex") { hideNameBox(); return; }
          nameBox.style.display = "inline-flex";
          const w = nameBox.offsetWidth || 180;
          const r = petNameBtn.getBoundingClientRect();
          nameBox.style.left = Math.max(8, r.right - w) + "px";
          nameBox.style.top = (r.top - 44) + "px";
          nameInput.value = readPetName();
          win.setTimeout(() => { try { nameInput.focus(); nameInput.select(); } catch (err) { /* 忽略 */ } }, 0);
        });
      }
      nameBox.querySelector(".oss-pet-name-cancel").addEventListener("click", hideNameBox);
      nameBox.querySelector(".oss-pet-name-ok").addEventListener("click", () => {
        writePetName(String(nameInput.value || "").trim().slice(0, 12));
        hideNameBox();
        if (diaryPanel.style.display === "block") renderDiary();
      });
      nameInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { nameBox.querySelector(".oss-pet-name-ok").click(); }
        if (e.key === "Escape") { hideNameBox(); }
        e.stopPropagation();
      });

      // ---- 壁纸模式下点鱼 / 点地面 ----
      // 点在身上 → 播随机「点击回应」；点在别处 → 走过去。
      // 只在沉浸态（壁纸与交互）生效：其他模式玩家在调参，不该被误触。
      let lastPetScreen = null;      // 每帧由 place 之外的地方更新太贵，这里按需取
      const onSkyClick = (e) => {
        // 诊断用：确认这个监听到底有没有被调用、immersive 是什么值
        console.log("[sky] click", { immersive, tx: e.clientX, ty: e.clientY, target: e.target && e.target.tagName });
        if (!immersive) return;
        // 点在面板 / 按钮上就不算（它们自己有处理）
        if (e.target && e.target.closest && e.target.closest("button, input, .oss-dream, .oss-panel, .oss-subpanel")) return;
        let pt = null;
        try {
          if (typeof win.__ossPetScreen === "function") pt = win.__ossPetScreen(1.0);
        } catch (error) { /* 引擎没起来 */ }
        if (!pt) return;
        // 鱼在屏幕上大约 2.5 米高、宽高比 0.86 —— 用一个保守的矩形判命中。
        let scale = 0.2;
        try {
          const pos = win.__ossPetPos ? win.__ossPetPos() : null;
          if (pos && Number.isFinite(pos.z)) scale = Math.max(0.08, Math.min(0.45, 2.4 / Math.max(1, pos.z)));
        } catch (error) { /* 用默认 */ }
        const h = (window.innerHeight || 800) * scale;
        const w = h * 0.86 * 0.6;      // 身子大概占屏幕上的这个宽度
        const dx = Math.abs(e.clientX - pt.x);
        const dy = Math.abs(e.clientY - (pt.y + h * 0.15));
        if (dx < w && dy < h * 0.6) {
          try { petScheduler.react(); } catch (error) { /* 调度器没起来 */ }
          return;
        }
        // 点别处：让它走到鼠标落点正下方的地面上。
        // 精确做法是反投影射线求地面交点（引擎里的 __ossScreenToGround），
        // 拿到的是世界坐标，再换算成鱼用的「横向偏移 + 离相机米数」。
        try {
          if (typeof win.__ossScreenToGround !== "function") return;
          const g = win.__ossScreenToGround(e.clientX, e.clientY);
          if (!g || !Number.isFinite(g.x) || !Number.isFinite(g.z)) return;
          // 世界 z → 对外「离相机的米数」：dist = 8.5 - (worldZ - 8.5) = 17 - worldZ
          const dist = 17 - g.z;
          const z = Math.max(4.8, Math.min(40, dist));
          let halfW = 3;
          try {
            if (typeof win.__ossPetHalfWidth === "function") halfW = win.__ossPetHalfWidth(z);
          } catch (error) { /* 用默认 */ }
          const tx = Math.max(-halfW, Math.min(halfW, g.x));
          // 走多远决定走多久：6 米以内 1.2 秒，越远越久，上限 3 秒
          let cur = { x: 0, z: 8.5 };
          try {
            const pos = win.__ossPetPos ? win.__ossPetPos() : null;
            if (pos) cur = { x: pos.x || 0, z: Number.isFinite(pos.z) ? pos.z : 8.5 };
          } catch (error) { /* 用默认 */ }
          const travel = Math.hypot(tx - cur.x, z - cur.z);
          const dur = Math.max(0.9, Math.min(3.0, travel / 4));
          petEntity.moveTo(tx, z, dur);
          petScheduler.reactWalk();
        } catch (error) { /* 引擎没起来 */ }
      };
      doc.addEventListener("pointerdown", onSkyClick, true);

      // ---- 壁纸模式下的方向键 ----
      // ↑ 往画面里走（远离镜头），↓ 走近，← → 横向。
      // 只管鱼，不碰天气。和其他模式的按键不冲突：只在沉浸态响应。
      const onArrowKey = (e) => {
        if (!immersive) return;
        const t = e.target;
        // 焦点在输入框里就不拦 —— 那是用户真在打字
        if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
        const k = e.key;
        if (k !== "ArrowUp" && k !== "ArrowDown" && k !== "ArrowLeft" && k !== "ArrowRight") return;
        e.preventDefault();
        let x = 0, z = 8.5;
        try {
          const pos = win.__ossPetPos ? win.__ossPetPos() : null;
          if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.z)) { x = pos.x; z = pos.z; }
        } catch (error) { /* 用默认 */ }
        const STEP_X = 1.4, STEP_Z = 1.6;
        if (k === "ArrowUp") z += STEP_Z;        // 远离镜头 = 往画面里
        if (k === "ArrowDown") z -= STEP_Z;      // 走近
        if (k === "ArrowLeft") x -= STEP_X;
        if (k === "ArrowRight") x += STEP_X;
        let halfW = 3;
        try {
          if (typeof win.__ossPetHalfWidth === "function") halfW = win.__ossPetHalfWidth(z);
        } catch (error) { /* 用默认 */ }
        x = Math.max(-halfW, Math.min(halfW, x));
        z = Math.max(4.8, Math.min(40, z));
        try {
          petEntity.moveTo(x, z, 0.5);
          petScheduler.reactWalk();
        } catch (error) { /* 引擎没起来 */ }
      };
      doc.addEventListener("keydown", onArrowKey);

      // ---- 梦境面板 ----
      // 鱼睡着时浮在它头顶的一小块控制面板。纯透明 + 一圈柔光边框。
      // 它操控的是真实的天气参数（走 commitLive，和主面板同一条通道），
      // 所以「在梦里控住天气」不是特效，是真的生效。
      //
      // 定位：鱼睡在固定的窝里，所以屏幕坐标只需要在显示时取一次。
      // 不做逐帧跟随 —— 它睡着不动，跟着动只会让数字抖。
      const dream = ((onDreamDone) => {
        const wrap = doc.createElement("div");
        wrap.className = "oss-dream";
        wrap.setAttribute("data-plugin", PLUGIN);
        wrap.innerHTML = [
          '<div class="oss-dream-title">梦中操控</div>',
          '<label class="oss-dream-row"><span>花</span>',
          '<input type="range" min="0" max="100" step="1" data-k="flower" /></label>',
          '<label class="oss-dream-row"><span>草</span>',
          '<input type="range" min="0" max="100" step="1" data-k="grass" /></label>',
          '<label class="oss-dream-row"><span>天体</span>',
          '<input type="range" min="0" max="100" step="1" data-k="sun" /></label>',
          '<label class="oss-dream-row"><span>海浪</span>',
          '<input type="range" min="0" max="100" step="1" data-k="sea" /></label>',
          '<label class="oss-dream-row"><span>湿度</span>',
          '<input type="range" min="0" max="100" step="1" data-k="humid" /></label>',
          '<div class="oss-dream-hand" aria-hidden="true"></div>',
        ].join("");
        const inputs = {};
        for (const el of wrap.querySelectorAll("input[data-k]")) inputs[el.dataset.k] = el;
        const hand = wrap.querySelector(".oss-dream-hand");

        // 梦境面板只是「镜子」：面板上这几根滑杆都不能被玩家拖。
        // 真正在动的是那个手指（纯动画），实际效果由它去操纵主面板的滑杆实现。
        for (const el of Object.values(inputs)) {
          el.addEventListener("mousedown", (e) => e.preventDefault());
          el.addEventListener("touchstart", (e) => e.preventDefault(), { passive: false });
        }

        const MAX = { flower: 100, grass: 100, sun: 100, sea: 100, humid: 100 };

        // 梦境开始前的原始值。收起面板时原样写回。
        let before = null;
        let handTimer = 0;
        let stopWalk = false;

        const readAll = () => {
          const s = readSettings();
          return {
            flower: s.flowerDensity,
            grass: s.groundDensity,
            sun: s.time,
            sea: s.sea,
            humid: s.humidPos,
          };
        };
        const fillInputs = (v) => {
          for (const k of Object.keys(inputs)) {
            if (inputs[k] && v[k] !== undefined) inputs[k].value = String(v[k]);
          }
        };

        // ---- 把值真正推给系统 ----
        // 同时改主面板那根滑杆的显示值（用户看得见联动），再走它原本的通道。
        // 节流 200ms：手指是每帧动的，但推设置不需要每帧 ——
        // 每帧推一次会连带 paint() 里重推整个场景，那就是「一卡一卡」的来源。
        let pending = null;
        let flushTimer = 0;
        const flush = () => {
          flushTimer = 0;
          const p = pending;
          pending = null;
          if (!p) return;
          if (p.flower !== undefined) {
            if (flowerDensityRange) flowerDensityRange.value = String(p.flower);
            commit({ flowerDensity: p.flower });
            pushGround();
          }
          if (p.grass !== undefined) {
            if (groundDensityRange) groundDensityRange.value = String(p.grass);
            commit({ groundDensity: p.grass });
            pushGround();
          }
          if (p.sun !== undefined) {
            if (timeRange) timeRange.value = String(p.sun);
            commit({ time: p.sun, autoCycle: false });
          }
          if (p.sea !== undefined) {
            if (seaRange) seaRange.value = String(p.sea);
            commit({ sea: p.sea });
          }
          if (p.humid !== undefined) {
            if (humidRange) humidRange.value = String(p.humid);
            commit({ humidPos: p.humid });
          }
        };
        const queuePush = (k, v) => {
          pending = pending || {};
          pending[k] = v;
          if (!flushTimer) flushTimer = setTimeout(flush, 200);
        };

        host.append(wrap);

        const place = () => {
          let pt = null;
          try {
            if (typeof win.__ossPetScreen === "function") pt = win.__ossPetScreen(1.6);
          } catch (error) { /* 引擎没起来 */ }
          if (pt && Number.isFinite(pt.x) && Number.isFinite(pt.y)) {
            wrap.style.left = Math.round(pt.x) + "px";
            wrap.style.top = Math.round(pt.y) + "px";
          } else {
            wrap.style.left = "18%";
            wrap.style.top = "62%";
          }
        };
        let followTimer = 0;
        const startFollow = () => {
          stopFollow();
          place();
          followTimer = setInterval(place, 120);
        };
        const stopFollow = () => {
          if (followTimer) clearInterval(followTimer);
          followTimer = 0;
        };

        // ---- 滑杆在面板上的位置：显示时量一次，之后只读缓存 ----
        let trackBoxes = {};
        const measureTracks = () => {
          const wrapBox = wrap.getBoundingClientRect();
          trackBoxes = {};
          for (const [k, el] of Object.entries(inputs)) {
            const b = el.getBoundingClientRect();
            trackBoxes[k] = { x: b.left - wrapBox.left, y: b.top - wrapBox.top, w: b.width, h: b.height };
          }
        };
        const moveHandTo = (k, ratio) => {
          const tb = trackBoxes[k];
          if (!tb || !hand) return;
          const pad = 6;
          const x = tb.x + pad + (tb.w - pad * 2) * ratio;
          const y = tb.y + tb.h / 2;
          hand.style.transform = "translate(" + x + "px," + y + "px)";
          hand.classList.add("is-visible");
        };

        // ---- 一根滑杆的滑动动画 ----
        // 每帧：手指位置 + 梦境滑杆显示值（纯 DOM 属性，不触发 input 事件）。
        // 真正推设置走 queuePush，200ms 一次。
        const glide = (k, target) => new Promise((resolve) => {
          const el = inputs[k];
          if (!el) { resolve(); return; }
          const from = Number(el.value);
          const max = MAX[k] || 100;
          // 天体走得最慢：太阳一跳一大截，眼睛跟不上。
          const dur = k === "sun" ? (5000 + Math.random() * 2000)
                                  : (2600 + Math.random() * 1000);
          const t0 = performance.now();
          const tick = (now) => {
            if (stopWalk || !wrap.classList.contains("is-on")) { resolve(); return; }
            const u = Math.min(1, (now - t0) / dur);
            const e = 0.5 - 0.5 * Math.cos(Math.PI * u);   // easeInOutSine
            const v = from + (target - from) * e;
            el.value = String(v);                            // 只改显示，不派发事件
            moveHandTo(k, Math.max(0, Math.min(1, v / max)));
            queuePush(k, Math.round(v));
            if (u < 1) requestAnimationFrame(tick);
            else resolve();
          };
          requestAnimationFrame(tick);
        });

        // ---- 一次梦境：五根滑杆挨个玩一遍，每根推出去再拉回来 ----
        const dreamWalk = async () => {
          stopWalk = false;
          const order = Object.keys(inputs);
          for (let i = order.length - 1; i > 0; i -= 1) {
            const j = (Math.random() * (i + 1)) | 0;
            [order[i], order[j]] = [order[j], order[i]];
          }
          const pick = (k) => {
            if (k === "flower" || k === "grass") return Math.round(20 + Math.random() * 70);
            if (k === "sun") return Math.round(20 + Math.random() * 60);
            return Math.round(15 + Math.random() * 70);      // sea / humid
          };
          // 梦里把每根滑杆推到过什么值 —— 日记要写这个。
          // 注意：推出去之后会拉回 home，所以「最终值」没变化；
          // 有意义的是「它梦里想调成什么」，记录的就是那个峰值。
          const dreamPeaks = {};
          for (const k of order) {
            if (stopWalk || !wrap.classList.contains("is-on")) return;
            const home = Number(inputs[k].value);
            moveHandTo(k, home / (MAX[k] || 100));
            await new Promise((r) => setTimeout(r, 260));
            const peak = pick(k);
            dreamPeaks[k] = { home, peak };
            await glide(k, peak);
            await new Promise((r) => setTimeout(r, 220));
            await glide(k, home);
            await new Promise((r) => setTimeout(r, 220));
          }
          if (typeof onDreamDone === "function") onDreamDone(dreamPeaks);
          if (wrap.classList.contains("is-on")) toggleDream(false);
        };

        // 面板显示 / 收起。dreamWalk 玩完之后要自己调它收面板。
        const toggleDream = (show) => {
          if (show) {
            before = readAll();
            fillInputs(before);
            startFollow();
            wrap.classList.add("is-on");
            clearTimeout(handTimer);
            requestAnimationFrame(() => {
              measureTracks();
              handTimer = setTimeout(() => { dreamWalk(); }, 1200);
            });
          } else {
            stopWalk = true;
            stopFollow();
            wrap.classList.remove("is-on");
            clearTimeout(handTimer);
            if (hand) hand.classList.remove("is-visible");
            // ---- 还原 ----
            // 收起面板就把五个值写回梦境开始前的快照。
            // 手指只是动画，用户设置不能被梦改坏。
            if (before) {
              commit({
                flowerDensity: before.flower,
                groundDensity: before.grass,
                time: before.sun,
                sea: before.sea,
                humidPos: before.humid,
              });
              pushGround();
              fillInputs(before);
              before = null;
            }
          }
        };

        return {
          toggle: toggleDream,
          dispose() {
            stopWalk = true;
            clearTimeout(handTimer);
            if (flushTimer) clearTimeout(flushTimer);
            stopFollow();
            wrap.remove();
          },
        };
      })((peaks) => { addDiaryEntry(peaks); });
      dreamToggle = dream.toggle;      // 接上调度器的 onDream

      win.__openSeaShelter = {
        get settings() { return readSettings(); },
        set: (patch) => commit(patch),
        // 恢复 = 回到用户保存过的默认（没保存过才是出厂值）
        reset: () => commit(readUserDefaults()),
        saveDefault: () => saveUserDefaults(),
        open: () => setOpen(true),
        close: () => setOpen(false),
        // 驱动层只读快照（唯一通道，不给写口）：控制台调试用
        drive: () => driveRead(),
      };

      ctx.effect(() => () => {
        listeners.clear();
        clearSliderFrame();
        // 驱动层成对清理：挂什么清什么
        stopDrive();
        stopOcean();
        win.removeEventListener("message", onOceanMessage);
        doc.removeEventListener("pointerdown", onPointer, true);
        doc.removeEventListener("pointerdown", onSkyClick, true);
        doc.removeEventListener("keydown", onKey);
        doc.removeEventListener("keydown", onArrowKey);
        win.removeEventListener("pagehide", onPageHide);
        if (typeof offTheme === "function") offTheme();
        engine.dispose();
        // 云主体自己管着自己的 rAF 和 resize 监听，必须单独收 ——
        // 它的 canvas 也在 pane 里，pane.remove() 之后 rAF 还在跑就白烧 CPU。
        try { petEntity.dispose(); } catch (error) { /* 同上 */ }
        try { petScheduler.dispose(); } catch (error) { /* 同上 */ }
        try { dream.dispose(); } catch (error) { /* 同上 */ }
        clearGlass();
        fab.remove();
        panel.remove();
        uiStyle.remove();
        pane.remove();
        try { delete win.__openSeaShelter; } catch (error) { win.__openSeaShelter = undefined; }
      }, "dsh-weather-sandbox: window, panel and glass");
      return () => {
        stopDrive();
        try { petEntity.dispose(); } catch (error) { /* 同上 */ }
        try { petScheduler.dispose(); } catch (error) { /* 同上 */ }
        try { dream.dispose(); } catch (error) { /* 同上 */ }
        for (const node of [fab, panel, pane]) if (node.parentNode) node.parentNode.removeChild(node);
        if (uiStyle.parentNode) uiStyle.parentNode.removeChild(uiStyle);
        clearGlass();
      };
    }

    exports.name = PLUGIN;
    exports.inject = ["theme"];
    exports.apply = apply;
    return module.exports;
  },
});
