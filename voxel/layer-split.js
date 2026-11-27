/**
 * 立体转换：把一张图拆成「背景层 + 人物层」。
 *
 * 【为什么需要它】
 * 单层墙只能看不能绕到后面，是张海报。
 * 两层墙 —— 完整背景 + 前面贴着的人物镂空 —— 就有厚度了，是浮雕。
 *
 * 这是「照片打印成物体」的第一步：把画面按深度切开。
 * 再往后（多层、真三维）都是这个思路的延伸。
 *
 * 【抠图用的是纯色洪水填充，不是 AI】
 * 原则零：能在本地用确定的算法做的，不要调 AI。
 * 从四边出发、按背景色扩散、连通区域才是背景 —— 全是数组操作，零 token。
 *
 * 局限说清楚：只能处理背景色比较干净的图（截图、像素画、纯色底）。
 * 真实照片的复杂背景会抠不干净。那种情况需要分割模型，那是另一个量级的东西。
 */

/**
 * 从四条边统计出背景色（可能不止一种）。
 * @param {{width:number,height:number,data:Uint8Array}} img RGB 数据
 * @returns {Array<[number,number,number]>} 前若干种边缘颜色
 */
export function detectBackground(img, maxColors = 2) {
  const counts = new Map()
  const W = img.width
  const H = img.height
  const add = (x, y) => {
    const i = (y * W + x) * 3
    const key = (img.data[i] << 16) | (img.data[i + 1] << 8) | img.data[i + 2]
    counts.set(key, (counts.get(key) || 0) + 1)
  }
  for (let x = 0; x < W; x++) { add(x, 0); add(x, H - 1) }
  for (let y = 0; y < H; y++) { add(0, y); add(W - 1, y) }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxColors)
    .map(([key]) => [(key >> 16) & 255, (key >> 8) & 255, key & 255])
}

/**
 * 洪水填充出背景蒙版。
 *
 * @param {{width:number,height:number,data:Uint8Array}} img
 * @param {Array<[number,number,number]>} bgColors detectBackground 的结果
 * @param {number} tol 颜色容差（曼哈顿距离），越大越宽松
 * @returns {Uint8Array} 长度 W*H，1 = 背景，0 = 人物
 */
export function backgroundMask(img, bgColors, tol = 40) {
  const W = img.width
  const H = img.height
  const mask = new Uint8Array(W * H)
  if (!bgColors.length) return mask

  const matches = (i) => {
    const r = img.data[i]
    const g = img.data[i + 1]
    const b = img.data[i + 2]
    for (const c of bgColors) {
      if (Math.abs(r - c[0]) + Math.abs(g - c[1]) + Math.abs(b - c[2]) <= tol) return true
    }
    return false
  }

  // 用数组当队列（比 shift 快得多）
  const queue = new Int32Array(W * H)
  let head = 0
  let tail = 0

  const seed = (p) => {
    if (mask[p]) return
    if (!matches(p * 3)) return
    mask[p] = 1
    queue[tail++] = p
  }

  for (let x = 0; x < W; x++) { seed(x); seed((H - 1) * W + x) }
  for (let y = 0; y < H; y++) { seed(y * W); seed(y * W + W - 1) }

  while (head < tail) {
    const p = queue[head++]
    const x = p % W
    const y = (p - x) / W
    if (x > 0) seed(p - 1)
    if (x < W - 1) seed(p + 1)
    if (y > 0) seed(p - W)
    if (y < H - 1) seed(p + W)
  }

  return mask
}

/**
 * 按蒙版拆成两张图。
 *
 * @returns {{ background: {width,height,data}, foreground: {width,height,data,alpha} }}
 *   background —— 原图背景部分，其余位置填背景色（保持是张完整的矩形图）
 *   foreground —— 只有人物，其余位置 alpha = 0
 */
export function splitLayers(img, mask, fillColor) {
  const W = img.width
  const H = img.height
  const bg = new Uint8Array(W * H * 3)
  const fg = new Uint8Array(W * H * 3)
  const alpha = new Uint8Array(W * H)
  const fc = fillColor || [240, 240, 234]

  for (let p = 0; p < W * H; p++) {
    const i = p * 3
    if (mask[p]) {
      bg[i] = img.data[i]
      bg[i + 1] = img.data[i + 1]
      bg[i + 2] = img.data[i + 2]
      alpha[p] = 0
    } else {
      bg[i] = fc[0]
      bg[i + 1] = fc[1]
      bg[i + 2] = fc[2]
      fg[i] = img.data[i]
      fg[i + 1] = img.data[i + 1]
      fg[i + 2] = img.data[i + 2]
      alpha[p] = 255
    }
  }

  return {
    background: { width: W, height: H, data: bg },
    foreground: { width: W, height: H, data: fg, alpha },
  }
}
