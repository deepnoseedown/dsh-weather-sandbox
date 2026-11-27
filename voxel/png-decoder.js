/**
 * 最小 PNG 解码器（零依赖，只用 node:zlib）。
 *
 * 为什么自己写：插件是零依赖的，装 sharp / pngjs 会破坏这个约束，
 * 而且用户机器上不一定装得上（native 模块要编译）。
 *
 * 支持范围（覆盖截图和大多数图片）：
 *   · PNG 8 位深度
 *   · 颜色类型 0（灰度）、2（RGB）、3（调色板）、4（灰度+alpha）、6（RGBA）
 *   · 非隔行
 *   不支持：16 位深度、隔行（Adam7）。遇到就返回 null，调用方降级。
 *
 * 不是 JPEG —— JPEG 需要完整的霍夫曼解码，那就不该自己写了。
 * 调用方要把「只支持 PNG」这个限制说清楚。
 */

import { inflateSync } from 'node:zlib'

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * 解码 PNG。
 * @param {Buffer} buf 原始文件字节
 * @returns {{width:number, height:number, data:Uint8Array} | null}
 *          data 是 RGB 三通道（每像素 3 字节），解码失败返回 null
 */
export function decodePng(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8) return null
  if (!buf.subarray(0, 8).equals(PNG_SIG)) return null

  let off = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  let interlace = 0
  let palette = null
  let trns = null
  const idat = []

  // ---- 读所有 chunk ----
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('ascii', off + 4, off + 8)
    const dataStart = off + 8
    const dataEnd = dataStart + len
    if (dataEnd + 4 > buf.length) break

    if (type === 'IHDR') {
      width = buf.readUInt32BE(dataStart)
      height = buf.readUInt32BE(dataStart + 4)
      bitDepth = buf[dataStart + 8]
      colorType = buf[dataStart + 9]
      interlace = buf[dataStart + 12]
    } else if (type === 'PLTE') {
      palette = buf.subarray(dataStart, dataEnd)
    } else if (type === 'tRNS') {
      trns = buf.subarray(dataStart, dataEnd)
    } else if (type === 'IDAT') {
      idat.push(buf.subarray(dataStart, dataEnd))
    } else if (type === 'IEND') {
      break
    }

    off = dataEnd + 4 // 跳过 CRC
  }

  // 只处理能处理的格式
  if (!width || !height) return null
  if (bitDepth !== 8) return null
  if (interlace !== 0) return null

  const channels = colorType === 0 ? 1
    : colorType === 2 ? 3
      : colorType === 3 ? 1
        : colorType === 4 ? 2
          : colorType === 6 ? 4
            : 0
  if (!channels) return null
  if (colorType === 3 && !palette) return null

  let raw
  try {
    raw = inflateSync(Buffer.concat(idat))
  } catch (error) {
    return null
  }

  const stride = width * channels
  if (raw.length < (stride + 1) * height) return null

  // ---- 反滤波（PNG 的 5 种滤波，逐行还原）----
  const out = Buffer.alloc(stride * height)
  let pos = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[pos]
    pos += 1
    const rowStart = y * stride
    const prevStart = (y - 1) * stride
    for (let x = 0; x < stride; x++) {
      const cur = raw[pos + x]
      const left = x >= channels ? out[rowStart + x - channels] : 0
      const up = y > 0 ? out[prevStart + x] : 0
      const upLeft = (y > 0 && x >= channels) ? out[prevStart + x - channels] : 0
      let val
      switch (filter) {
        case 0: val = cur; break
        case 1: val = cur + left; break
        case 2: val = cur + up; break
        case 3: val = cur + ((left + up) >> 1); break
        case 4: {
          // Paeth 预测器
          const p = left + up - upLeft
          const pa = Math.abs(p - left)
          const pb = Math.abs(p - up)
          const pc = Math.abs(p - upLeft)
          val = cur + (pa <= pb && pa <= pc ? left : (pb <= pc ? up : upLeft))
          break
        }
        default: return null
      }
      out[rowStart + x] = val & 0xff
    }
    pos += stride
  }

  // ---- 统一转成 RGB ----
  const rgb = new Uint8Array(width * height * 3)
  for (let i = 0; i < width * height; i++) {
    let r = 0, g = 0, b = 0, a = 255
    const si = i * channels
    if (colorType === 0) {              // 灰度
      r = g = b = out[si]
    } else if (colorType === 2) {       // RGB
      r = out[si]; g = out[si + 1]; b = out[si + 2]
    } else if (colorType === 3) {       // 调色板
      const idx = out[si]
      const pi = idx * 3
      r = palette[pi]; g = palette[pi + 1]; b = palette[pi + 2]
      if (trns && idx < trns.length) a = trns[idx]
    } else if (colorType === 4) {       // 灰度+alpha
      r = g = b = out[si]; a = out[si + 1]
    } else if (colorType === 6) {       // RGBA
      r = out[si]; g = out[si + 1]; b = out[si + 2]; a = out[si + 3]
    }
    // 透明像素按白色处理：方块世界里没有「透明」，白底最不突兀
    if (a < 128) { r = 240; g = 240; b = 234 }
    rgb[i * 3] = r
    rgb[i * 3 + 1] = g
    rgb[i * 3 + 2] = b
  }

  return { width, height, data: rgb }
}

/**
 * 把图片采样成 cols×rows 的颜色索引网格。
 *
 * @param {{width:number,height:number,data:Uint8Array}} img decodePng 的结果
 * @param {number} cols
 * @param {number} rows
 * @param {Array<[number,number,number]>} palette RGB 数组，按索引排列
 * @returns {number[][]} rows 行 × cols 列的调色板索引
 */
export function sampleToGrid(img, cols, rows, palette) {
  const grid = []
  const cw = img.width / cols
  const ch = img.height / rows
  // 每格只取中心 60% 的区域做平均，避开格线和边缘杂色
  const inset = 0.2

  for (let ry = 0; ry < rows; ry++) {
    const row = []
    for (let rx = 0; rx < cols; rx++) {
      const x0 = Math.floor((rx + inset) * cw)
      const x1 = Math.max(x0 + 1, Math.floor((rx + 1 - inset) * cw))
      const y0 = Math.floor((ry + inset) * ch)
      const y1 = Math.max(y0 + 1, Math.floor((ry + 1 - inset) * ch))

      let sr = 0, sg = 0, sb = 0, n = 0
      for (let y = y0; y < y1; y++) {
        if (y < 0 || y >= img.height) continue
        for (let x = x0; x < x1; x++) {
          if (x < 0 || x >= img.width) continue
          const i = (y * img.width + x) * 3
          sr += img.data[i]; sg += img.data[i + 1]; sb += img.data[i + 2]
          n++
        }
      }
      if (!n) { row.push(0); continue }
      const r = sr / n, g = sg / n, b = sb / n

      // 最近邻匹配
      let best = 0
      let bestD = Infinity
      for (let k = 0; k < palette.length; k++) {
        const p = palette[k]
        const d = (r - p[0]) ** 2 + (g - p[1]) ** 2 + (b - p[2]) ** 2
        if (d < bestD) { bestD = d; best = k }
      }
      row.push(best)
    }
    grid.push(row)
  }
  return grid
}
