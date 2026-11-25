/**
 * dsh-weather-sandbox — host half.
 *
 * The merge of two plugins that each owned exactly one stage of the window:
 * Open Sea Skin (the WebGL ocean, glass fill, daylight clock) and
 * dsh-theme-shelter (rain, snow and lightning above the interface). This half
 * serves the browser the two renderer assets; every pixel, setting
 * and cached value lives in the Client module.
 *
 * Three exact routes, no path parsing. A previous version registered one
 * `prefix` route and derived the file from `req.url`; whatever the server
 * actually handed that handler made every resource but the specially-cased
 * script answer 400. Exact routes leave the matching to the server, so there
 * is nothing left to get wrong: the path is hard-coded on both sides.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-weather-sandbox'

const ROOT = resolve(fileURLToPath(new URL('./', import.meta.url)))
const STATIC = resolve(ROOT, 'static')
const PET = resolve(ROOT, 'assets', 'pet')

/**
 * The services this half exposes to the browser: the ORIGINAL Open Sea Skin
 * engine, with exactly one line adapted so it reads the host's settings
 * instead of its own URL. Everything else — every shader, every wave table,
 * the render loop — is the shipped file unchanged. A hand-written rewrite
 * drifted from those shader sources once already; this one cannot, because
 * `ocean-engine.js` is generated from the original by a single replacement.
 */
const ROUTES = Object.freeze([
  { path: '/dsh-weather-sandbox/ocean-engine.js', type: 'text/javascript; charset=utf-8', file: resolve(STATIC, 'ocean-engine.js') },
])

/**
 * The pet assets. These are a FIXED whitelist, not a directory walk:
 * a `prefix` route that derives a path from `req.url` is exactly the bug this
 * file was rewritten to escape (see the header). Every asset the browser may
 * ask for is named here once, on both sides. Adding a clip means adding a line
 * here and a line in the client's CLIP map — deliberate, not forgetful.
 *
 * Clips keep their Chinese file names because renaming them would silently
 * break the client's CLIP map, which is keyed by the same names.
 */
const CLIP_NAMES = Object.freeze([
  '待机呼吸休闲', '东张西望', '哈欠连天', '超大伸懒腰',
  '原地小憩沉眠', '睡觉-开始', '睡觉-循环', '睡觉-起来',
  '漂浮踏步', '螃蟹走路', '左转奔跑',
  '开心小跑', '侧身急躁跑', '被吓一跳',
  '点击回应-开心跃动', '点击回应-害羞惊讶', '深度思考碎碎念',
  '用鲸鱼尾巴拍打地面', '蓝鲸现世', '鲸鱼吐泡泡特效',
  '吃饭·碗饭', '吃饭团', '期待开饭',
  // 起居
  '晨间刷牙', '照镜子', '悠闲哼歌', '打瞌睡被惊醒', '原地重力下蹲压缩',
  // 娱乐
  '撸猫', '原地专心玩魔方', '下五子棋', '三球抛接', '扑克魔术', '荡秋千',
  // 季节
  '被落叶淹没', '堆雪人', '摇扇纳凉', '玩水枪',
  // 才艺
  '吹笛子', '小提琴演奏', '轻快摇摆舞', '可爱宅舞', '优雅女仆舞',
  // 吃
  '吃早餐', '吃午餐', '吃晚餐', '吃西瓜', '大口吃零食', '偷吃零食被抓住',
  // 杂
  '蝴蝶蜜蜂环绕头顶开花',
])

const PET_ROUTES = Object.freeze([
  ...CLIP_NAMES.map((name) => ({
    path: '/dsh-weather-sandbox/pet/clip/' + encodeURIComponent(name) + '.webm',
    type: 'video/webm',
    file: resolve(PET, 'clips', name + '.webm'),
  })),
  { path: '/dsh-weather-sandbox/pet/front.png', type: 'image/png', file: resolve(PET, 'front.png') },
  { path: '/dsh-weather-sandbox/pet/side.png', type: 'image/png', file: resolve(PET, 'side.png') },
  { path: '/dsh-weather-sandbox/pet/back.png', type: 'image/png', file: resolve(PET, 'back.png') },
])

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 */
function finish(res, status) {
  res.writeHead(status, { 'cache-control': 'no-cache' })
  res.end()
}

/**
 * Answer one exact resource request.
 * @param {{ type: string, file?: string, script?: () => string }} route
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void}
 */
function handler(route) {
  return (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' })
      res.end()
      return
    }
    let body
    try {
      body = route.script ? Buffer.from(route.script(), 'utf8') : readFileSync(route.file)
    } catch (error) {
      finish(res, 500)
      return
    }
    res.writeHead(200, {
      'cache-control': 'no-cache',
      'content-length': String(body.byteLength),
      'content-type': route.type,
      'x-content-type-options': 'nosniff',
    })
    res.end(req.method === 'HEAD' ? undefined : body)
  }
}

/** Register the two exact routes for as long as the plugin runs. */
function registerRoutes(ctx) {
  if (typeof ctx.effect !== 'function') return
  ctx.effect(() => {
    const disposers = [...ROUTES, ...PET_ROUTES].map((route) => ctx.webServer.register({
      kind: 'exact',
      path: route.path,
      handler: handler(route),
    }))
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'dsh-weather-sandbox: renderer routes')
}

export function apply(ctx) {
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], registerRoutes)
    return
  }
  if (ctx.webServer) registerRoutes(ctx)
}
