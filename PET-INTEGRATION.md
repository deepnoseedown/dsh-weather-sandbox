# 角色素材接入 · 技术交底

> 给接手的人（不管是人还是 AI）。
> 这份文档只讲**怎么做、为什么这样做**。照做就能跑通，别自己发明。

---

## 一、核心结论先说

**视频素材的"抠图"和图片的"抠图"是两件完全不同的事。**

| 素材 | 有 alpha 通道吗 | 怎么处理 |
|---|---|---|
| `front.png` / `side.png` / `back.png` | ✅ **有** | 直接 `<img>` 显示，什么都不用做 |
| `clips/*.webm`（25 个动作） | ❌ **没有**（`yuv420p`） | **必须每帧用 canvas 把黑底转成透明** |

**这就是上一版失败的原因**：把 `<video>` 直接贴在页面上，
视频里 82% 的纯黑背景就原样显示出来了 —— 看起来是一个黑色大方块里的人。

**别试图给视频"加" alpha。** 浏览器不支持运行时给视频加透明通道，
VP9 的 alpha 版本在浏览器里兼容性极差，ffmpeg 9.1 默认也编不出来。
**唯一可靠的路：canvas 逐帧取像素、改 alpha、写回去。**

---

## 二、素材是什么样

```
assets/pet/
├── front.png     291×423   RGBA，四角透明
├── side.png      363×420   RGBA，四角透明   ← 现在用的是这张当待机
├── back.png      295×420   RGBA，四角透明
└── clips/*.webm  256×144   25 个，VP9，24fps，10 秒，**纯黑底 yuv420p**
```

实测数据（别猜，这是量出来的）：

- 视频背景是 **`(0,0,0)` 纯黑，占 82.1% 的像素**
- 四角全是 `(0,0,0)`
- 角色本体最暗的部分亮度也在 25 以上

**所以"亮度 < 18 就是背景"这个判断是安全的。**

---

## 三、抠图的正确算法

### 别用二值化

```js
// ❌ 错：会留下黑边
if (r < 30 && g < 30 && b < 30) alpha = 0;
else alpha = 255;
```

角色轮廓有一圈抗锯齿产生的**灰边**（亮度介于黑和角色之间）。
二值化会把这圈灰边判成"角色"，结果就是角色外面套着一圈黑描边。

### 正确做法：三段式

```js
const m = Math.max(r, g, b);     // 取三通道最大值当亮度

if (m < 18)        alpha = 0;                              // 纯黑 → 全透明
else if (m < 60)   alpha = ((m - 18) * 255 / 42) | 0;      // 过渡带 → 半透明
else               alpha = 255;                             // 角色本体 → 不透明
```

**中间那段 18~60 的渐变是关键**：让灰边变成半透明，视觉上就融进背景了。

### 为什么取 max(r,g,b) 而不是平均

角色有深蓝色的头发和衣服，平均会被拉低，容易误判成背景。
取最大值能保住这些暗色区域。

---

## 四、完整实现

### 结构：三层，各司其职

```
wrap (定位容器)
├── img   <img>     立绘，有 alpha，直接显示
├── video <video>   只当解码器，永远 opacity:0
└── cv    <canvas>  显示抠好的视频帧
```

### 关键代码

```js
// ---- 1. video 只解码，不显示 ----
const video = document.createElement("video");
video.muted = true;
video.loop = true;
video.playsInline = true;
video.preload = "auto";
video.style.cssText = "position:absolute;width:0;height:0;opacity:0;pointer-events:none";

// ---- 2. canvas 负责显示 ----
const cv = document.createElement("canvas");
cv.width = 256;    // 素材原尺寸，必须和视频一致
cv.height = 144;
const ctx2d = cv.getContext("2d", { willReadFrequently: true });
//                                    ↑ 这个参数很重要，不加的话每帧 getImageData
//                                      会触发 GPU→CPU 回读，性能差 5~10 倍

// ---- 3. 抠图函数 ----
const CUT_LO = 18;
const CUT_HI = 60;

function keyOut() {
  if (!ctx2d) return;
  if (video.readyState < 2) return;          // 还没解出帧，跳过

  ctx2d.clearRect(0, 0, cv.width, cv.height);
  ctx2d.drawImage(video, 0, 0, cv.width, cv.height);

  let data;
  try {
    data = ctx2d.getImageData(0, 0, cv.width, cv.height);
  } catch (error) {
    // 跨域等安全限制取不到像素 → 退回原样显示，至少不是黑的
    cv.style.opacity = "1";
    return;
  }

  const px = data.data;
  for (let i = 0; i < px.length; i += 4) {
    const m = px[i] > px[i+1]
      ? (px[i] > px[i+2] ? px[i] : px[i+2])
      : (px[i+1] > px[i+2] ? px[i+1] : px[i+2]);
    if (m < CUT_LO)      px[i+3] = 0;
    else if (m < CUT_HI) px[i+3] = ((m - CUT_LO) * 255 / (CUT_HI - CUT_LO)) | 0;
    else                 px[i+3] = 255;
  }
  ctx2d.putImageData(data, 0, 0);
}

// ---- 4. 循环只在播放时跑 ----
let keyRaf = 0;
function keyLoop() {
  keyRaf = requestAnimationFrame(keyLoop);
  keyOut();
}
function startKey() {
  if (keyRaf) return;
  keyRaf = requestAnimationFrame(keyLoop);
}
function stopKey() {
  if (keyRaf) cancelAnimationFrame(keyRaf);
  keyRaf = 0;
}
```

### 播放动作时

```js
play(name) {
  video.src = BASE + "clip/" + encodeURIComponent(name) + ".webm";
  video.loop = false;
  video.currentTime = 0;

  const done = () => {
    video.removeEventListener("ended", done);
    stopKey();              // ← 必须停，否则白跑 CPU
    cv.style.opacity = "0";
    img.style.opacity = "1";
  };
  video.addEventListener("ended", done);

  img.style.opacity = "0";
  video.style.opacity = "0";   // video 永远不显示
  cv.style.opacity = "1";      // 显示的是 canvas

  video.play().then(startKey).catch(() => {
    cv.style.opacity = "0";    // 播放被拦就退回立绘
    img.style.opacity = "1";
  });
}
```

### 记住 stopKey

`dispose()` 里也要调 `stopKey()`，否则组件卸载后 rAF 还在跑，一直吃 CPU。

---

## 五、性能实测

| 项 | 数值 |
|---|---|
| 每帧像素 | 256 × 144 = **36,864** |
| 帧率 | 24 fps |
| 每帧处理量 | 36,864 次循环（改 alpha） |
| **结论** | **完全可以接受**，不到 1ms |

**不要用 640×360 的原素材**：像素量是 4 倍，没必要。
**不要预先导出 PNG 序列**：25 个动作 × 240 帧 = 6000 张图，体积爆炸。

---

## 六、常见错误（都踩过）

| 错误 | 后果 | 正确做法 |
|---|---|---|
| 把 `<video>` 直接显示 | 黑方块 | video 永远 `opacity:0`，显示 canvas |
| 二值化抠图 | 角色带黑描边 | 用 18~60 三段式过渡 |
| 忘记 `willReadFrequently` | 每帧 GPU 回读，卡顿 | getContext 时加上 |
| 抠图循环一直跑 | 立绘待机也吃 CPU | 只在 play 时 start，ended/dispose 时 stop |
| canvas 尺寸写成动态的 | 和视频不匹配，拉伸变形 | 固定 256×144，用 CSS 放大 |
| 用平均亮度判断 | 深蓝头发被误判成背景 | 用 `max(r,g,b)` |

---

## 七、Host 端路由（这部分已经做对了）

白名单方式，**不要改成按路径遍历**：

```js
const CLIP_NAMES = Object.freeze([
  '待机呼吸休闲', '东张西望', /* ...共 25 个... */
]);

const PET_ROUTES = Object.freeze([
  ...CLIP_NAMES.map((name) => ({
    path: '/dsh-weather-sandbox/pet/clip/' + encodeURIComponent(name) + '.webm',
    type: 'video/webm',
    file: resolve(PET, 'clips', name + '.webm'),
  })),
  { path: '/dsh-weather-sandbox/pet/front.png', type: 'image/png', file: resolve(PET, 'front.png') },
  { path: '/dsh-weather-sandbox/pet/side.png',  type: 'image/png', file: resolve(PET, 'side.png') },
  { path: '/dsh-weather-sandbox/pet/back.png',  type: 'image/png', file: resolve(PET, 'back.png') },
]);
```

**加新动作要改两处**：Host 的 `CLIP_NAMES` 和客户端的动作表。
文件名保留中文，因为两边按同样的名字对应。

---

## 八、验证方法（别只看代码）

**改完必须做的事：**

1. **语法检查**
   ```powershell
   node oss-syntax-check.cjs client/index.js
   ```

2. **升 VERSION**（`client/index.js` 第 12 行）
   **不升浏览器会拿缓存，改了看不到效果。**

3. **看浏览器 F12 → Console 有没有红字**

4. **肉眼看**：角色是站在草地上，还是浮在一个黑方块里

---

## 九、现在什么状态

| 项 | 状态 |
|---|---|
| 素材 | ✅ 齐全（3 张 PNG + 25 个 webm，共 2 MB） |
| Host 路由 | ✅ 正确 |
| 角色定位/缩放 | ✅ 正确 |
| **抠图** | ✅ **已实现**（本文档第三、四节） |
| 动作调度 | ❌ 还没做（见下） |

### 还没做的：动作调度

现在是「一直显示 `side.png` 立绘」，`play()` 只在需要时调用。

要让它活起来，需要一个调度器：

```js
const IDLE   = ['待机呼吸休闲'];
const GLANCE = ['东张西望'];
const YAWN   = ['哈欠连天', '超大伸懒腰'];

// 每 30~60 秒插播一次东张西望
// 每 2~3 分钟插播一次打哈欠/伸懒腰
// 播完回到立绘
```

**建议**：先确认抠图效果对了，再接调度器。**一次只改一件事。**

---

## 十、一句话

**视频没有透明通道，只能每帧用 canvas 把黑色变成透明。**
**别想着给视频加 alpha，也别用二值化留黑边。**
