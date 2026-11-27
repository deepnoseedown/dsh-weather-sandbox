# voxel/ —— 创世大陆的配套文件

这个文件夹是「创世大陆」模块的附属物。引擎本体不在这里
（它在 `static/voxel-terrain.js`，因为要由宿主路由以固定 URL 提供，不能挪）。

## 里面有什么

| 文件 | 是什么 | 谁读 |
|---|---|---|
| `MANUAL.md` | AI 操作手册：frame 语法、24 色、仓库、固化 | 创世 AI（技能 `genesis-voxel` 的源） |
| `AXIOMS.md` | 建筑公理：七条规则，把任意需求拆成可施工步骤 | 创世 AI（技能 `arch-axioms` 的源） |
| `png-decoder.js` | 零依赖 PNG 解码器 + 图片转方块网格 | `index.js`（`voxel_image` 工具） |
| `jpeg-decoder.js` | JPEG 解码器（jpeg-js 0.4.4，MIT/Apache） | `index.js`（`voxel_image` 工具） |
| `layer-split.js` | 抠图：检测背景色 + 洪水填充 + 拆背景/人物两张图 | `index.js`（`voxel_layered` 工具） |

## 图片 → 方块 的完整链路

```
用户给一张图（本地路径）
      ↓
index.js 按文件头判断格式
  89 50 …  → PNG   → png-decoder.js
  FF D8 …  → JPEG  → jpeg-decoder.js
      ↓
两个解码器都返回 { width, height, data: Uint8Array(RGB) }
      ↓
sampleToGrid(img, cols, rows, CUBE_PALETTE)
  每格取中心 60% 区域的平均色，按 RGB 欧氏距离匹配最近的调色板项
      ↓
gridToCommands(grid, {...})
  同一行连续同色合并成一条 box 指令（640 格 → 约 350 条）
      ↓
走正常建造通道进世界
```

## 抠图算法有两份，都在用

```
voxel/layer-split.js        给 AI 的 voxel_layered 工具用（Node 侧）
client/index.js 里的那一份   给界面面板用（浏览器侧）
```

**同样的逻辑写两遍，因为跑在不同进程里，没法共享。**
改一边必须改另一边 —— 判定条件是「从四条边找背景色、洪水填充、连通区域才算背景」。

## 24 色调色板 —— 三处必须同步

```
引擎着色器 palette()      GLSL vec3（不能从 JS 注入，只能各存一份）
引擎 MATERIALS            名字 + CSS 色
index.js CUBE_PALETTE     图片匹配用的 [r,g,b]
client 兜底表             引擎没起来时显示用
```

**改一处就必须改全部。** 顺序也不能变 —— 材质号是这三处的公共契约。

**为什么从 6 色扩到 24**：六色全是高饱和鲜艳色，装不下照片。
实测深蓝头发 `rgb(25,45,91)` 到「蓝」的距离 179，到「绿」只有 141，
整幅人像会变成绿色。加了深蓝/浅蓝/深绿/灰阶之后才有归宿。

## 两份文档是怎么到达 AI 手里的

插件启动时做两件事（`index.js` 的 `apply`）：

1. **装成技能** → `~/.dsh/skills/genesis-voxel/SKILL.md` 和 `arch-axioms/SKILL.md`
   —— 有 `skill` 工具的会话走这条
2. **写进工作区** → `<当前工作区>/创世大陆-操作手册.md` 和 `建筑公理.md`
   —— 只有 `read` 工具的会话走这条（插件在 C 盘、工作区可能在 D 盘）

同一份内容两次落地，是为了让任何配置下的 AI 都读得到。

## 改文档的规矩

`MANUAL.md` 和 `AXIOMS.md` 是**源文件**。改它们之后：

- 已经在用户目录里的 `SKILL.md` **不会自动更新**（安装时判断「已存在就跳过」）
- 想让别人拿到新版，得手动删掉 `~/.dsh/skills/genesis-voxel/` 再重启

## AXIOMS 是活的

它是给后来者用的：摸索出一条能反复用、不绑定具体建筑的规则，就接着编号往下写。
**不要往里加「怎么建某个具体建筑」** —— 那是例子，不是公理。
具体建筑沉淀在图纸仓库和宏仓库里。
