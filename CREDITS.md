# 第三方署名 / Third-party credits

本项目是三个 MIT 协议项目的衍生作品。
原作者的名字必须保留 —— **这是协议的要求，也是我们想做的事**。

如果拿本项目做自己的东西，请把这三个名字一起带走。

---

## 1. Open Sea Skin

- 作者：**d-dev0101**
- 仓库：https://github.com/d-dev0101/open-sea-skin （v1.2.7）
- Lab 分叉：https://github.com/BeckChiang/open-sea-skin-lab
- 许可：MIT License
- 用到什么：整个海洋与天空的渲染内核 —— Gerstner 波浪、日光散射、
  星空与流星、云层。本项目的图形基础来自这里。

## 2. 檐下 / dsh-theme-shelter

- 作者：**ifer47**
- 仓库：https://github.com/ifer47/dsh-theme-shelter （v0.7.3）
- 许可：MIT License
- 用到什么：沉浸式天气氛围的骨架 —— 雨雪雷的粒子系统、
  控制面板的交互结构与模式切换设计。

## 3. dsh-pet

- 作者：**PC2005-cloud**
- 仓库：https://github.com/PC2005-cloud/dsh-pet
- 许可：MIT License
- 用到什么：**角色立绘 + 角色动作视频**，两者都出自这个仓库。

  **静态立绘**
  - 原文件：`assets/main-character.png`（1920×1072 三视图）
  - 本项目改动：切成正面 / 侧面 / 背面三张，去除白色背景，裁掉留白
  - 产物：`assets/pet/front.png`、`side.png`、`back.png`

  **动作视频**
  - 原素材：`assets/webm/`，640×360 / 10 秒 / 平均 485 KB
  - 本项目改动：从中挑出 50 个动作，重压到 256×144，
    VP9 crf40，平均约 69 KB（总计 3.5 MB）
  - 产物：`assets/pet/clips/*.webm`

  **动作来源说明**
  - 本项目直接取自 **dsh-pet 原仓库**（动作全集 114 个），
    不经由任何转发包，因此不给转发包署名

---

## 许可原文

- 本项目自身的许可：[`LICENSE`](LICENSE)
- dsh-pet 的原始许可原文：[`LICENSES/dsh-pet-LICENSE.txt`](LICENSES/dsh-pet-LICENSE.txt)

MIT 许可证允许使用、修改、再分发与商业使用，
**条件是保留原始版权声明与许可声明**。
