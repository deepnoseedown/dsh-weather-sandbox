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
import { decodePng, sampleToGrid } from './voxel/png-decoder.js'
import decodeJpeg from './voxel/jpeg-decoder.js'
import { detectBackground, backgroundMask, splitLayers } from './voxel/layer-split.js'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const name = 'dsh-weather-sandbox'

// ============================================================
//  技能自带安装
// ============================================================
// 【为什么需要这一步】
// DSH 的技能扫描器（@deepseek-ai/dsh-skill-filesystem）只扫三个根：
//   项目根 / 自定义目录 / 用户配置目录
// 它 **不扫描插件包内部**。所以把 SKILL.md 放进插件包里，
// 新用户装完插件也读不到 —— AI 会以为「详见 SKILL」是骗人的。
//
// 做法：插件启动时自己把技能写到用户能扫描到的位置。
//   用户级：C:\Users\<用户>\.dsh\skills\genesis-voxel\SKILL.md
//   这样不管用户的工作区叫什么，都能看见。
//
// 只在文件不存在时写，不覆盖用户手改过的版本。
const SKILL_NAME = 'genesis-voxel'

// 随插件打包的两份技能
//   genesis-voxel  操作手册（工具怎么用）
//   arch-axioms    建筑公理（建筑怎么推导）
// 前者教「怎么动手」，后者教「怎么想」。缺一个都只能干半件事。
const SKILLS = [
  {
    dir: 'genesis-voxel',
    // 【name 必须显式给，不能从文件名推】
    // 之前用 sourceFile 去推导，MANUAL.md 会变成
    // "skill-voxel-world" —— 和目录名 genesis-voxel 对不上，
    // 技能列表里就显示成一个谁都不认识的名字。
    name: 'genesis-voxel',
    file: 'voxel/MANUAL.md',
    // 写进工作区时用的文件名和标题（中文，用户一眼能看懂）
    manualName: '创世大陆-操作手册.md',
    manualTitle: '创世大陆 · 操作手册',
    description: '创世大陆——AI 原生方块世界的操作手册。当用户提到创世大陆、方块世界、建建筑、盖房子、凉亭、船舫、拆除、图纸、宏仓库、大肥鱼做梦，或你要调用 voxel_build / voxel_scene / voxel_demolish / voxel_query / voxel_rate / voxel_place / voxel_reset 时读这一份。',
  },
  {
    dir: 'arch-axioms',
    name: 'arch-axioms',
    file: 'voxel/AXIOMS.md',
    manualName: '建筑公理.md',
    manualTitle: '建筑公理',
    description: '建筑公理——用 7 条规则推导任意建筑，而不是记住具体建筑。当用户要建房子、塔、桥、城、宫殿、穹顶、街区，或你想不出某栋楼该怎么拆成方块时读这一份。读完你能把"一座哥特教堂"这种需求自己拆成可施工的步骤。',
  },
]

// 读插件目录里的 markdown 源，剥掉 frontmatter 和开头的一级标题。
// 写进工作区时用 —— 那边不是技能文件，不需要 frontmatter；
// 标题由调用方自己粘（文件名和标题分开控制）。
function bodyOf(sourceFile) {
  let text
  try {
    text = readFileSync(resolve(ROOT, sourceFile), 'utf8')
  } catch (error) {
    return null
  }
  if (text.startsWith('---')) {
    const end = text.indexOf('---', 3)
    if (end > 0) text = text.slice(end + 3)
  }
  text = text.replace(/^\s+/, '')
  // 剥掉开头第一个一级标题（调用方会自己粘一个）
  text = text.replace(/^#\s+[^\n]*\n+/, '')
  return text
}

// 把插件目录里那份 markdown 包装成带 frontmatter 的 SKILL.md。
// 【惰性读取】不能在模块顶层就读 —— ROOT 在下面才定义，
// 顶层读会撞上 TDZ（Cannot access 'ROOT' before initialization），
// 整个插件起不来。
function skillMarkdown(sourceFile, name, description) {
  const body = readFileSync(resolve(ROOT, sourceFile), 'utf8')
  // 如果源文件本身已经有 frontmatter 就原样用
  if (body.startsWith('---')) return body
  return '---\n'
    + 'name: ' + name + '\n'
    + 'description: ' + description + '\n'
    + '---\n\n'
    + body
}

function installSkill() {
  const results = []
  for (const skill of SKILLS) {
    try {
      // 用户级 skills 目录：DSH 的扫描根之一
      const userSkills = join(homedir(), '.dsh', 'skills')
      const dir = join(userSkills, skill.dir)
      const file = join(dir, 'SKILL.md')
      if (existsSync(file)) { results.push({ ok: true, skipped: true, path: file }); continue }
      mkdirSync(dir, { recursive: true })
      writeFileSync(file, skillMarkdown(skill.file, skill.name, skill.description), 'utf8')
      results.push({ ok: true, installed: true, path: file })
    } catch (error) {
      results.push({ ok: false, dir: skill.dir, error: error && error.message ? error.message : String(error) })
    }
  }
  return results
}


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
  // 方块大陆线条骨架。独立脚本，必须先于 ocean-engine.js 执行 ——
  // 它自己把 window.__voxelPass 挂上，引擎在主链路里取这个句柄（取不到就整层跳过）。
  // 所以新增一个静态资源 = 这里加一行 + 客户端 startVoxelModule() 里加一次请求，
  // 和 PET_ROUTES 同一个规矩：两边都要点名，不靠目录遍历。
  { path: '/dsh-weather-sandbox/voxel-terrain.js', type: 'text/javascript; charset=utf-8', file: resolve(STATIC, 'voxel-terrain.js') },
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
  // 壁纸模式下点鱼会随机播这五个之一
  '点击回应-挠痒咯咯笑', '点击回应-元气挥手', '点击回应-傲娇生气',
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
  // 从「点击回应-傲娇生气」1.9~2.9 秒截出来的转身背影，单独成片
  '背对看风景',
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
    // AI 指令通道
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-weather-sandbox/-voxel-cmd',
      handler: voxelCmdHandler,
    }))
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-weather-sandbox/-voxel-ack',
      handler: voxelAckHandler,
    }))
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'dsh-weather-sandbox: renderer routes')
}

// ============================================================
//  AI 指令通道
// ============================================================
// 为什么需要它：
//   方块世界跑在浏览器页面的内存里，而 AI 跑在 Host 进程里。
//   两边没有任何直接连接 —— 于是 AI 只能「写指令给用户，让用户粘贴」，
//   这不叫 AI 原生沙盒，这叫 AI 写文档。
//
// 通道设计（故意做得极简）：
//   Host 侧维护一个队列，AI 用 HTTP 往里塞命令：
//     POST /dsh-weather-sandbox/-voxel-cmd   { op, ... }  → 入队，返回 id
//     GET  /dsh-weather-sandbox/-voxel-cmd                → 取出待执行的（Client 轮询）
//     POST /dsh-weather-sandbox/-voxel-ack   { id, ok, result }  → Client 回写结果
//     GET  /dsh-weather-sandbox/-voxel-ack                → AI 读回执
//   Client 侧每 400ms 拉一次队列，有就执行，执行完回执。
//
// 为什么用 HTTP 而不是 WebSocket：
//   webServer.register 已经有现成的精确路由机制，零新增基建。
//   400ms 的延迟对「发一句话等方块长出来」完全够用。
//
// 安全：
//   队列只活在这个插件的内存里，进程重启就清空（世界本身有自己的存档）。
//   单次最多排队 64 条，防止被灌爆。

const CMD_QUEUE_MAX = 64
const cmdQueue = []          // [{ id, op, payload, at }]
const ackList = []           // [{ id, ok, result, at }]
let cmdSeq = 0

function readBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 1 << 20) { resolve(''); req.destroy(); return }   // 1MB 上限
      raw += chunk
    })
    req.on('end', () => resolve(raw))
    req.on('error', () => resolve(''))
  })
}

function json(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.byteLength),
    'cache-control': 'no-store',
  })
  res.end(body)
}

async function voxelCmdHandler(req, res) {
  if (req.method === 'POST') {
    const raw = await readBody(req)
    let payload = null
    try { payload = JSON.parse(raw) } catch (error) { payload = null }
    if (!payload || typeof payload.op !== 'string') {
      json(res, 400, { ok: false, error: 'body must be JSON with an "op" field' })
      return
    }
    if (cmdQueue.length >= CMD_QUEUE_MAX) {
      json(res, 429, { ok: false, error: 'queue full, wait for the page to drain it' })
      return
    }
    cmdSeq += 1
    const item = { id: 'c' + cmdSeq, op: payload.op, payload, at: Date.now() }
    cmdQueue.push(item)
    json(res, 200, { ok: true, id: item.id, queued: cmdQueue.length })
    return
  }
  if (req.method === 'GET') {
    // Client 来取：一次把队列清空交出去
    const out = cmdQueue.splice(0, cmdQueue.length)
    json(res, 200, { ok: true, commands: out })
    return
  }
  json(res, 405, { ok: false })
}

async function voxelAckHandler(req, res) {
  if (req.method === 'POST') {
    const raw = await readBody(req)
    let payload = null
    try { payload = JSON.parse(raw) } catch (error) { payload = null }
    if (!payload) { json(res, 400, { ok: false }); return }
    ackList.push({
      id: String(payload.id || ''),
      ok: payload.ok !== false,
      result: payload.result ?? null,
      at: Date.now(),
    })
    // 只留最近 64 条回执
    while (ackList.length > 64) ackList.shift()
    json(res, 200, { ok: true })
    return
  }
  if (req.method === 'GET') {
    const out = ackList.splice(0, ackList.length)
    json(res, 200, { ok: true, acks: out })
    return
  }
  json(res, 405, { ok: false })
}

/**
 * 把两份手册写进【当前工作区】。
 *
 * 为什么不能只靠用户级 skills 目录：
 *   · 插件装在 C 盘，工作区可能在 D 盘
 *   · 有些 AI 会话的工具清单里根本没有 skill 工具，只有 read
 *   · 所以手册必须在工作区里，AI 才一定读得到
 *
 * 写之前先看文件在不在：已存在就跳过，不覆盖用户可能改过的版本。
 * 返回 [{ name, ok, installed|skipped, error }]，调用方打日志用。
 */
function exportManualToWorkspace(dir) {
  const results = []
  if (!dir || typeof dir !== 'string') return results
  for (const skill of SKILLS) {
    const target = join(dir, skill.manualName)
    try {
      if (existsSync(target)) { results.push({ name: skill.manualName, ok: true, skipped: true }); continue }
      const body = bodyOf(skill.file)
      if (!body) { results.push({ name: skill.manualName, ok: false, error: 'source missing' }); continue }
      writeFileSync(target, '# ' + skill.manualTitle + '\n\n'
        + '> 给创世 AI 读的操作手册。由创世大陆插件自动放置，可以删。\n\n'
        + body, 'utf8')
      results.push({ name: skill.manualName, ok: true, installed: true, path: target })
    } catch (error) {
      results.push({ name: skill.manualName, ok: false, error: error && error.message ? error.message : String(error) })
    }
  }
  return results
}

export function apply(ctx) {
  // 第一层：装进用户级 skills 目录（有 skill 工具的 AI 走这条路）
  const installed = installSkill()
  for (const r of installed) {
    if (r.installed) console.log('[dsh-weather-sandbox] 技能已安装: ' + r.path)
    else if (!r.ok) console.warn('[dsh-weather-sandbox] 技能安装失败 (' + r.dir + '): ' + r.error)
  }

  // 第二层：把同样的内容写一份到当前工作区（没有 skill 工具、只能 read 的 AI 走这条路）
  //
  // 为什么要两套：插件在 C 盘，工作区可能在 D 盘；有些会话只给了 read。
  // 只在工作区里放一份，才能保证任何 AI 都读得到。
  const exportManuals = (ctxArg) => {
    try {
      const wd = ctxArg && ctxArg.workingDirectory
      const dir = wd && typeof wd.defaultDirectory === 'string' ? wd.defaultDirectory : null
      if (!dir) return
      for (const r of exportManualToWorkspace(dir)) {
        if (r.installed) console.log('[dsh-weather-sandbox] 手册已放入工作区: ' + r.path)
        else if (!r.ok) console.warn('[dsh-weather-sandbox] 手册写入失败 (' + r.name + '): ' + r.error)
      }
    } catch (error) {
      // 拿不到工作区不算错：技能那一层还在
    }
  }

  // workingDirectory 可能已经在 ctx 上，也可能要等 inject 之后
  exportManuals(ctx)

  if (typeof ctx.inject === 'function') {
    // 【依赖要声明全】
    // registerAgentTools 要用 ctx.tools，但 inject 列表里没有 'tools' ——
    // 结果函数在守卫那里静默返回，工具永远注册不上，而且不报错。
    // 现在把 tools 也声明进来。
    // workingDirectory 是独立服务，单独 inject 一次（拿不到也不影响其余功能）
    try {
      ctx.inject(['workingDirectory'], (c) => { exportManuals(c) })
    } catch (error) { /* 没有这个服务就算了 */ }
    ctx.inject(['webServer', 'tools'], (c) => {
      registerRoutes(c)
      registerAgentTools(c)
    })
    return
  }
  if (ctx.webServer) {
    registerRoutes(ctx)
    registerAgentTools(ctx)
  }
}

// ============================================================
//  给 Agent 的工具
// ============================================================
// 【为什么必须有这一层】
// 只注册 HTTP 路由的话，AI 得自己拼 URL、用 shell 发请求 —— 又绕又容易错。
// 注册成工具之后，任何接手的 Agent 在工具列表里直接看到 voxel_*，
// 照着 SKILL 一句话就能建东西。这才是「AI 原生」该有的样子。
//
// 工具跑在 Host，世界在浏览器。execute 做的事是：
//   1. 把命令塞进队列
//   2. 轮询回执（最长 8 秒）
//   3. 把结果原样返回给 Agent
//
// 如果浏览器没开着方块世界，会明确报错，而不是假装成功。

const ACK_WAIT_MS = 8000
const ACK_POLL_MS = 120

function waitAck(cmdId, signal) {
  return new Promise((resolve) => {
    const started = Date.now()
    const tick = () => {
      if (signal && signal.aborted) { resolve(null); return }
      const idx = ackList.findIndex((a) => a.id === cmdId)
      if (idx >= 0) {
        const [item] = ackList.splice(idx, 1)
        resolve(item)
        return
      }
      if (Date.now() - started > ACK_WAIT_MS) { resolve(null); return }
      setTimeout(tick, ACK_POLL_MS)
    }
    tick()
  })
}

function enqueue(op, payload) {
  if (cmdQueue.length >= CMD_QUEUE_MAX) return null
  cmdSeq += 1
  const item = { id: 'c' + cmdSeq, op, payload: { op, ...payload }, at: Date.now() }
  cmdQueue.push(item)
  return item
}

function registerAgentTools(ctx) {
  if (!ctx || typeof ctx.tools !== 'object' || typeof ctx.tools.register !== 'function') return

  const runOne = async (op, payload, signal) => {
    const item = enqueue(op, payload)
    if (!item) return { ok: false, error: 'command queue full' }
    const ack = await waitAck(item.id, signal)
    if (!ack) {
      return {
        ok: false,
        error: 'the voxel continent did not answer in time',
        hint: 'Open the voxel continent in the DSH page: 面板 → 其他地形 → 勾选「方块大陆」',
      }
    }
    return { ok: ack.ok, result: ack.result }
  }

  const disposeBuild = ctx.tools.register({
    name: 'voxel_build',
    description:
      'Build in the AI-native voxel world. Write macro commands instead of per-block coordinates; '
      + 'the backend expands them into thousands of blocks and grows them in frame order. '
      + 'Commands: box X Y Z w h d mat | hollow X Y Z w h d mat | line x1 y1 z1 x2 y2 z2 mat [thick] | '
      + 'stairs X Y Z steps width mat [rise] | sphere cx cy cz r mat | clear. '
      + 'Separate commands with ";" or newlines. Material: 0-5 red/yellow/blue/white/orange/green; 6-9 light; 10-13 dark; 14-23 tan/brown/grey/black/pink/teal/purple/olive/skin. '
      + 'World is 96x96x32 integer cells, origin at a corner, centre is (48,48), Y is up from 0 to 31.',
    parameters: {
      type: 'object',
      properties: {
        commands: { type: 'string', description: 'Macro commands, e.g. "box 40 0 40 10 1 10 0; hollow 40 1 40 10 4 10 1"' },
        buildId: { type: 'string', description: 'Optional group id; one batch is one undo step' },
        saveAs: {
          type: 'string',
          description:
            'Optional blueprint name (Chinese is fine). When set, the finished building is saved into the '
            + 'blueprint warehouse so later sessions can reuse it with voxel_place. '
            + 'Omit it for throwaway builds. Duplicate content is skipped automatically, '
            + 'a same-name-but-different building becomes "name v2" / "name v3", and only the newest 3 versions '
            + 'of each name are kept — you do not need to manage any of that.',
        },
      },
      required: ['commands'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render(args, value) {
        return [{ type: 'text', text: JSON.stringify(value) }]
      },
    },
    async execute(args, exec) {
      const a = args || {}
      return runOne('build', {
        commands: String(a.commands || ''),
        buildId: a.buildId || 'agent',
        saveAs: a.saveAs || null,
      }, exec && exec.signal)
    },
  })

  const disposeDemolish = ctx.tools.register({
    name: 'voxel_demolish',
    description:
      'Demolish voxels. which="all" demolishes the whole world: every building is archived as a blueprint '
      + 'and all bricks go back to the warehouse. which="building" needs an id.',
    parameters: {
      type: 'object',
      properties: {
        which: { type: 'string', enum: ['all', 'building'], description: 'Scope of demolition' },
        id: { type: 'string', description: 'buildId when which="building"' },
      },
      required: ['which'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render(args, value) {
        return [{ type: 'text', text: JSON.stringify(value) }]
      },
    },
    async execute(args, exec) {
      const a = args || {}
      return runOne('demolish', { which: a.which || 'all', id: a.id || '' }, exec && exec.signal)
    },
  })

  const disposeQuery = ctx.tools.register({
    name: 'voxel_query',
    description:
      'Read the voxel world state: block count, visible instances, the three warehouses '
      + '(bricks / blueprints / macros) and the AI build queue progress.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'object' },
      render(args, value) {
        return [{ type: 'text', text: JSON.stringify(value) }]
      },
    },
    async execute(args, exec) {
      return runOne('query', {}, exec && exec.signal)
    },
  })

  const disposePlace = ctx.tools.register({
    name: 'voxel_place',
    description: 'Place a stored blueprint back into the world at its original anchor.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Blueprint name from voxel_query' } },
      required: ['name'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render(args, value) {
        return [{ type: 'text', text: JSON.stringify(value) }]
      },
    },
    async execute(args, exec) {
      const a = args || {}
      return runOne('place', { name: String(a.name || '') }, exec && exec.signal)
    },
  })

  const disposeReset = ctx.tools.register({
    name: 'voxel_reset',
    description: 'Reset the voxel world: clear the save and rebuild the default scene (boat + pavilion).',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'object' },
      render(args, value) {
        return [{ type: 'text', text: JSON.stringify(value) }]
      },
    },
    async execute(args, exec) {
      return runOne('reset', {}, exec && exec.signal)
    },
  })

  // 宏仓库：存 / 列 / 执行。
  // 宏不是「一段固定指令」，是「带参数的模板」——
  // 同一个宏能建到任何位置、任何尺寸，这才是真正可复用的积累。
  // 固化：把多个零散建筑合成一个整体。
  //
  // 为什么需要：搭一栋楼常常分成几次指令建出来（地基一次、主体一次、细节一次），
  // 于是变成好几个独立的 buildId。但「建筑」在概念上是整体的 ——
  // 拖动、旋转、拆掉存图纸都该按整栋算。不合并的话，拖地基只动地基。
  //
  // 只改归属指向，不动任何坐标：零成本、零风险。
  // 合并之后拆掉它，整栋会存成一张图纸进仓库。
  // 图纸仓库的删除。引擎里一直有 removeBlueprint，但没有暴露成工具 ——
  // 结果 AI 建完试作品、或者自动存档堆了一堆废料时，它删不掉，只能干看着。
  // 图片 → 方块墙。
  //
  // 有它之前，「把这张画搭出来」意味着我在对话里写几百条 box 指令，
  // 每条六个数字，错一个就歪。现在只给路径，像素和指令都由这里算。
  //
  // 【只支持 PNG】插件是零依赖的，JPEG 需要完整的霍夫曼解码器，
  // 那不该自己写。PNG 用 node:zlib 就够（zlib 是 Node 内置的）。
  // 不是 PNG 就直接说清楚，不要让调用方猜。
  // 立体转换：把一张图拆成「背景层 + 人物层」，建成两面紧贴的墙。
  //
  // 单层墙只能看不能绕到后面。两层之后就有厚度了 —— 是浮雕。
  // 这是「照片打印成物体」的第一步，后面做多层、做真三维都是这个思路的延伸。
  //
  // 【抠图不用 AI】
  // 从四条边出发、按背景色洪水填充、连通区域才算背景 —— 纯数组操作。
  // 零 token，而且不会算错。
  //
  // 局限：只对背景比较干净的图有效（截图、像素画、纯色底）。
  // 真实照片的复杂背景需要分割模型，那是另一个量级的东西。
  const disposeLayered = ctx.tools.register({
    name: 'voxel_layered',
    description:
      'Turn an image into two stacked walls: a full background layer plus a cut-out '
      + 'foreground layer right in front of it. The result has real depth (a bas-relief) '
      + 'instead of being a flat poster. Background removal is colour-based flood fill '
      + 'from the image edges, so it works best on screenshots, pixel art and plain-background '
      + 'images; busy photo backgrounds will not cut cleanly. Both layers are sampled to the '
      + 'same grid, so they line up exactly.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'PNG or JPEG path, absolute or relative to the working directory' },
        x: { type: 'number', description: 'Left edge X in grid cells' },
        z: { type: 'number', description: 'Z of the BACKGROUND layer; the foreground sits 1 cell in front' },
        cols: { type: 'number', description: 'Grid columns (default 48)' },
        rows: { type: 'number', description: 'Grid rows (derived from the image aspect ratio if omitted)' },
        tol: { type: 'number', description: 'Background colour tolerance, 0-200 (default 40; raise for noisy backgrounds)' },
        fill: { type: 'string', description: 'Colour index used to fill the background layer behind the subject (default 3 = white)' },
        gap: { type: 'number', description: 'Distance in cells between the two layers (default 1)' },
        buildId: { type: 'string', description: 'Group id' },
        saveAs: { type: 'string', description: 'Also save the result as a blueprint' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render(args, value) {
        return [{ type: 'text', text: JSON.stringify(value) }]
      },
    },
    async execute(args, exec) {
      const a = args || {}
      const raw = String(a.path || '').trim()
      if (!raw) return { ok: false, error: 'path required' }

      let abs = raw
      try {
        if (!/^[a-zA-Z]:[\\/]/.test(raw) && !raw.startsWith('/')) {
          const wd = ctx.workingDirectory
          const dir = wd && typeof wd.defaultDirectory === 'string' ? wd.defaultDirectory : null
          if (dir) abs = join(dir, raw)
        }
      } catch (error) { /* 用原样路径 */ }

      let buf
      try {
        buf = readFileSync(abs)
      } catch (error) {
        return { ok: false, error: 'cannot read file: ' + abs }
      }

      // 解码（和 voxel_image 同一套）
      let img = null
      if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50) {
        img = decodePng(buf)
      } else if (buf.length > 2 && buf[0] === 0xff && buf[1] === 0xd8) {
        try {
          const r = decodeJpeg(buf, { useTArray: true, formatAsRGBA: false })
          img = r && r.width && r.height ? r : null
        } catch (error) {
          return { ok: false, error: 'JPEG decode failed: ' + (error && error.message ? error.message : String(error)) }
        }
      }
      if (!img) return { ok: false, error: 'unsupported or corrupt image (PNG / JPEG only)' }

      // 抠图
      const bgColors = detectBackground(img, 2)
      if (!bgColors.length) return { ok: false, error: 'cannot detect background colour' }
      const tol = Number.isFinite(a.tol) ? Math.max(0, Math.min(200, a.tol)) : 40
      const mask = backgroundMask(img, bgColors, tol)
      const layers = splitLayers(img, mask, CUBE_PALETTE[Number.isFinite(a.fill) ? a.fill : 3])

      let bgCount = 0
      for (let i = 0; i < mask.length; i++) bgCount += mask[i]

      // 网格
      let cols = Math.floor(a.cols || 0)
      let rows = Math.floor(a.rows || 0)
      if (!cols) cols = 48
      if (!rows) rows = Math.max(1, Math.round(cols * img.height / img.width))
      cols = Math.min(192, Math.max(2, cols))
      rows = Math.min(128, Math.max(2, rows))

      const gap = Math.max(1, Math.floor(a.gap || 1))
      const baseX = Math.floor(a.x != null ? a.x : 72)
      const bgZ = Math.floor(a.z != null ? a.z : 100)
      const fgZ = bgZ + gap
      const baseY = 0

      // 背景层：完整矩形（每一格都有颜色）
      const bgGrid = sampleToGrid(layers.background, cols, rows, CUBE_PALETTE)
      // 人物层：只有人物部分，其余为 -1（不放方块）
      const fgSampled = sampleToGrid(layers.foreground, cols, rows, CUBE_PALETTE)
      const fgGrid = fgSampled.map((row, ry) => row.map((mat, rx) => {
        // 该格四个角半径内只要大部分是不透明的，就当人物
        const sx = Math.min(img.width - 1, Math.floor((rx + 0.5) * img.width / cols))
        const sy = Math.min(img.height - 1, Math.floor((ry + 0.5) * img.height / rows))
        return layers.foreground.alpha[sy * img.width + sx] ? mat : -1
      }))

      const toCommands = (grid, z) => {
        const out = []
        for (let ry = 0; ry < rows; ry++) {
          const wy = baseY + (rows - 1 - ry)
          let runStart = -1
          let runMat = -2
          for (let rx = 0; rx <= cols; rx++) {
            const m = rx < cols ? grid[ry][rx] : -2
            if (m !== runMat) {
              if (runMat >= 0 && runStart >= 0 && rx > runStart) {
                out.push('box ' + (baseX + runStart) + ' ' + wy + ' ' + z + ' '
                  + (rx - runStart) + ' 1 1 ' + runMat)
              }
              runStart = m >= 0 ? rx : -1
              runMat = m
            }
          }
        }
        return out
      }

      const bgCmds = toCommands(bgGrid, bgZ)
      const fgCmds = toCommands(fgGrid, fgZ)
      const all = bgCmds.concat(fgCmds)

      let fgCells = 0
      for (const row of fgGrid) for (const m of row) if (m >= 0) fgCells++

      const result = await runOne('build', {
        commands: all.join('\n'),
        buildId: a.buildId || 'layered:' + Date.now(),
        saveAs: a.saveAs || null,
      }, exec && exec.signal)

      return {
        ok: result.ok,
        image: { width: img.width, height: img.height },
        grid: { cols, rows },
        background: {
          colors: bgColors.map((c) => 'rgb(' + c.join(',') + ')'),
          pixels: bgCount,
          percent: Math.round(bgCount / (img.width * img.height) * 100),
          blocks: bgCmds.length,
        },
        foreground: {
          cells: fgCells,
          percent: Math.round(fgCells / (cols * rows) * 100),
          blocks: fgCmds.length,
        },
        layers: [
          { name: 'background', z: bgZ },
          { name: 'foreground', z: fgZ, gap },
        ],
        total: result.result ? result.result.total : 0,
        result,
      }
    },
  })

  const disposeImage = ctx.tools.register({
    name: 'voxel_image',
    description:
      'Render an image into the voxel world as a wall of colourful blocks. '
      + 'Give a local PNG path (absolute, or relative to the working directory) and a '
      + 'position, and the image is sampled into a grid of cells, each cell becoming '
      + 'one block coloured by the nearest entry of the cube palette '
      + '(24 colours: 0-5 red/yellow/blue/white/orange/green, 6-9 light variants, '
      + '10-13 dark variants, 14-23 tan/brown/grey/black/pink/teal/purple/olive/skin). '
      + 'Supports PNG (8-bit) and JPEG (baseline and progressive). '
      + 'Runs of the same colour in a row are merged into one box, so a 24x32 image '
      + 'is a few hundred commands rather than a few thousand.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Image path (PNG or JPEG). Absolute, or relative to the session working directory.',
        },
        x: { type: 'number', description: 'Left edge X in grid cells (default 60)' },
        z: { type: 'number', description: 'Bottom edge Z in grid cells (default 60)' },
        baseY: { type: 'number', description: 'Bottom Y level in cells (default 0)' },
        cols: {
          type: 'number',
          description: 'Grid columns. Omit to derive from the image aspect ratio and rows.',
        },
        rows: {
          type: 'number',
          description: 'Grid rows. Omit to derive from the image aspect ratio and cols.',
        },
        scale: {
          type: 'number',
          description: 'Blocks per cell. 1 = one block per cell (finest). 2 doubles the size.',
        },
        axis: {
          type: 'string',
          enum: ['x', 'z'],
          description: 'Which way the picture runs. "x" faces along X (default).',
        },
        flipX: { type: 'boolean', description: 'Mirror left-right' },
        flipY: { type: 'boolean', description: 'Mirror top-bottom (default true)' },
        crop: {
          type: 'string',
          description:
            'Crop before sampling, as "x0,y0,x1,y1" in image pixels. '
            + 'Use this to cut away frames, borders or background. '
            + 'Omit to use the whole image.',
        },
        trim: {
          type: 'boolean',
          description:
            'Auto-trim: drop rows and columns whose colours are mostly white/background. '
            + 'Useful for photos of a framed panel. Combines with crop (crop runs first).',
        },
        buildId: { type: 'string', description: 'Group id for the result' },
        saveAs: { type: 'string', description: 'Also save the result as a blueprint under this name' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render(args, value) {
        return [{ type: 'text', text: JSON.stringify(value) }]
      },
    },
    async execute(args, exec) {
      const a = args || {}
      const raw = String(a.path || '').trim()
      if (!raw) return { ok: false, error: 'path required' }

      // 相对路径按当前工作目录解析
      let abs = raw
      try {
        if (!/^[a-zA-Z]:[\\/]/.test(raw) && !raw.startsWith('/')) {
          const wd = ctx.workingDirectory
          const dir = wd && typeof wd.defaultDirectory === 'string' ? wd.defaultDirectory : null
          if (dir) abs = join(dir, raw)
        }
      } catch (error) { /* 用原样路径 */ }

      let buf
      try {
        buf = readFileSync(abs)
      } catch (error) {
        return { ok: false, error: 'cannot read file: ' + abs }
      }

      // 按文件头判断格式：PNG 有 8 字节签名，JPEG 以 FFD8 开头。
      // 两个解码器的输出格式统一：{ width, height, data: Uint8Array(RGB) }
      let img = null
      let format = null
      if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50) {
        img = decodePng(buf)
        format = 'png'
      } else if (buf.length > 2 && buf[0] === 0xff && buf[1] === 0xd8) {
        try {
          const r = decodeJpeg(buf, { useTArray: true, formatAsRGBA: false })
          img = r && r.width && r.height ? r : null
          format = 'jpeg'
        } catch (error) {
          return {
            ok: false,
            error: 'JPEG decode failed: ' + (error && error.message ? error.message : String(error)),
            hint: 'Progressive JPEG is supported by this decoder. If it still fails the file may be corrupt.',
          }
        }
      }
      if (!img) {
        return {
          ok: false,
          error: 'unsupported or corrupt image',
          hint: 'Supported formats: PNG (8-bit, non-interlaced) and JPEG (baseline or progressive). '
            + 'Convert other formats (HEIC, WebP, GIF) to PNG or JPEG first.',
        }
      }

      // ---- 裁剪：先把框/边/背景切掉，再采样 ----
      // 一张实拍的照片里，画的四周是木框和桌面。
      // 不裁的话这些都会被当成画面内容，采样出来是一圈杂色。
      if (typeof a.crop === 'string' && a.crop.trim()) {
        const parts = a.crop.split(/[,，\s]+/).map(Number).filter(Number.isFinite)
        if (parts.length === 4) {
          const x0 = Math.max(0, Math.min(parts[0], parts[2]))
          const y0 = Math.max(0, Math.min(parts[1], parts[3]))
          const x1 = Math.min(img.width, Math.max(parts[0], parts[2]))
          const y1 = Math.min(img.height, Math.max(parts[1], parts[3]))
          if (x1 - x0 >= 2 && y1 - y0 >= 2) img = cropImage(img, x0, y0, x1, y1)
        }
      }
      if (a.trim === true) img = trimBackground(img)

      // 网格尺寸：给了就按给的，没给就按原图比例
      // X 和 Z 各有 192 格，Y 有 128 格。
      // 图片沿 X 展开、竖在 Y 上，所以：宽最多 192，高最多 128。
      const maxDim = 192
      let cols = Math.floor(a.cols || 0)
      let rows = Math.floor(a.rows || 0)
      if (!cols && !rows) {
        cols = Math.min(maxDim, Math.round(img.width / 8))
        rows = Math.max(1, Math.round(cols * img.height / img.width))
      } else if (!rows) {
        rows = Math.max(1, Math.round(cols * img.height / img.width))
      } else if (!cols) {
        cols = Math.max(1, Math.round(rows * img.width / img.height))
      }
      cols = Math.min(192, Math.max(1, cols))
      rows = Math.min(128, Math.max(1, rows))   // 世界 Y 只有 128 格

      const grid = sampleToGrid(img, cols, rows, CUBE_PALETTE)
      const commands = gridToCommands(grid, {
        x: a.x != null ? a.x : 60,
        z: a.z != null ? a.z : 60,
        baseY: a.baseY != null ? a.baseY : 0,
        scale: a.scale != null ? a.scale : 1,
        axis: a.axis,
        flipX: a.flipX,
        flipY: a.flipY,
      })
      if (!commands) return { ok: false, error: 'empty grid' }

      const result = await runOne('build', {
        commands,
        buildId: a.buildId || 'image',
        saveAs: a.saveAs || null,
      }, exec && exec.signal)

      return {
        ok: result.ok,
        format,
        image: { width: img.width, height: img.height },
        grid: { cols, rows },
        scale: a.scale != null ? a.scale : 1,
        commands: commands.split('\n').length,
        result,
      }
    },
  })

  const disposeBlueprint = ctx.tools.register({
    name: 'voxel_blueprint_remove',
    description:
      'Delete blueprints from the warehouse. Pass name to remove one, or all:true to clear '
      + 'the whole blueprint warehouse. Use this to clean up test builds or stale drafts '
      + 'so the warehouse stays useful for later sessions. Deleting a blueprint does not '
      + 'touch the world; it only removes the saved copy.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Exact blueprint name from voxel_query blueprints[]' },
        all: { type: 'boolean', description: 'Set true to remove every blueprint' },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render(args, value) {
        return [{ type: 'text', text: JSON.stringify(value) }]
      },
    },
    async execute(args, exec) {
      const a = args || {}
      const payload = {}
      if (a.all === true) payload.all = true
      if (a.name) payload.name = String(a.name)
      if (!payload.all && !payload.name) return { error: 'pass name, or all:true' }
      return runOne('blueprintRemove', payload, exec && exec.signal)
    },
  })

  // 24 色，和引擎 MATERIALS 一致（顺序不能变）
  const CUBE_PALETTE = [
    [0xe6, 0x2e, 0x33], //  0 红
    [0xf2, 0xc7, 0x1a], //  1 黄
    [0x29, 0x8c, 0xf2], //  2 蓝
    [0xf0, 0xf0, 0xea], //  3 白
    [0xf2, 0x7a, 0x1a], //  4 橙
    [0x33, 0xb8, 0x57], //  5 绿
    [0xf7, 0x9e, 0x9e], //  6 浅红
    [0xfa, 0xe6, 0x8c], //  7 浅黄
    [0x99, 0xc7, 0xfa], //  8 浅蓝
    [0xa6, 0xe6, 0xad], //  9 浅绿
    [0x9e, 0x1a, 0x1f], // 10 深红
    [0xad, 0x85, 0x0a], // 11 深黄
    [0x0d, 0x29, 0x6b], // 12 深蓝
    [0x0f, 0x52, 0x24], // 13 深绿
    [0xd1, 0xae, 0x80], // 14 浅棕
    [0x73, 0x4d, 0x29], // 15 棕
    [0xb8, 0xb8, 0xb8], // 16 浅灰
    [0x61, 0x61, 0x66], // 17 深灰
    [0x1a, 0x1a, 0x1f], // 18 黑
    [0xd9, 0x8c, 0xcc], // 19 粉
    [0x26, 0xa6, 0xad], // 20 青
    [0x73, 0x47, 0xa6], // 21 紫
    [0x85, 0x8c, 0x38], // 22 橄榄
    [0xe0, 0xb8, 0x9e], // 23 肤色
  ]

  /**
   * 把颜色网格转成 voxel_build 的指令文本。
   *
   * 【为什么要合并连续同色】
   * 24x32 的图逐格写就是 768 条 box 指令，光文本就 2 万字符。
   * 但实际图里大片同色（背景、额头），按行合并成长条之后
   * 通常只剩 200~300 条 —— 传输量和解析量都降一个数量级。
   *
   * @param {number[][]} grid   rows 行 x cols 列 的材质索引
   * @param {object} opt
   *   x, z     左下角（格子中心）
   *   baseY    从哪一层开始（默认 0）
   *   axis     'x' 表示画面沿 X 展开、贴在 Z 平面上；'z' 反之
   *   scale    每格几块（1 = 一格一块，方块世界的最小粒度）
   *   flipX    左右翻转
   *   flipY    上下翻转（图片 y 向下，世界 y 向上，通常要翻）
   */
  function gridToCommands(grid, opt) {
    const rows = grid.length
    const cols = grid[0] ? grid[0].length : 0
    if (!rows || !cols) return ''
    const o = opt || {}
    const scale = Math.max(1, Math.floor(o.scale || 1))
    const baseX = Math.floor(o.x || 0)
    const baseZ = Math.floor(o.z || 0)
    const baseY = Math.floor(o.baseY || 0)
    const axis = o.axis === 'z' ? 'z' : 'x'
    const flipX = o.flipX === true
    const flipY = o.flipY !== false // 默认翻转：图片从上到下，世界从下到上

    const lines = []
    for (let ry = 0; ry < rows; ry++) {
      // 图片第 0 行在最上面；世界 y 向上，所以默认把 ry 倒过来
      const wy = flipY ? (rows - 1 - ry) : ry
      let runStart = 0
      let runMat = grid[ry][0]
      const flush = (from, to, mat) => {
        if (to <= from) return
        const len = (to - from) * scale
        // 【画面是一个竖直的平面】
        // 沿 X 展开时：x 随列走，y 随行走（向上），z 固定在一个平面上。
        // 之前写成 z 也跟着行走，结果整幅画是斜的。
        const ly = baseY + wy * scale
        if (axis === 'x') {
          const cx = baseX + (flipX ? (cols - to) : from) * scale
          lines.push('box ' + cx + ' ' + ly + ' ' + baseZ + ' '
            + len + ' ' + scale + ' ' + scale + ' ' + mat)
        } else {
          const cz = baseZ + (flipX ? (cols - to) : from) * scale
          lines.push('box ' + baseX + ' ' + ly + ' ' + cz + ' '
            + scale + ' ' + scale + ' ' + len + ' ' + mat)
        }
      }
      for (let rx = 1; rx <= cols; rx++) {
        const m = rx < cols ? grid[ry][rx] : -1
        if (m !== runMat) {
          flush(runStart, rx, runMat)
          runStart = rx
          runMat = m
        }
      }
    }
    return lines.join('\n')
  }

  /**
   * 按像素矩形裁剪。返回新的 {width,height,data}。
   */
  function cropImage(img, x0, y0, x1, y1) {
    const w = x1 - x0
    const h = y1 - y0
    const out = new Uint8Array(w * h * 3)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const si = ((y + y0) * img.width + (x + x0)) * 3
        const di = (y * w + x) * 3
        out[di] = img.data[si]
        out[di + 1] = img.data[si + 1]
        out[di + 2] = img.data[si + 2]
      }
    }
    return { width: w, height: h, data: out }
  }

  /**
   * 自动裁掉四周的「背景色」边。
   *
   * 判据：一行/一列里超过 85% 的像素都在浅色范围（亮度 > 150 且接近中性灰/白）
   * 就从外往里吃掉。照片拍一块装框的画时，木框和桌面正好符合这个特征。
   *
   * 只从【外侧】吃，吃到第一行有内容就停 —— 不做内部挖空，
   * 因为画面里本来就有大片白色（原图顶部魔方还没拼满）。
   */
  function trimBackground(img) {
    const W = img.width
    const H = img.height
    const bright = (i) => {
      const r = img.data[i], g = img.data[i + 1], b = img.data[i + 2]
      const lum = (r + g + b) / 3
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b)
      return lum > 150 && (mx - mn) < 40
    }
    const rowIsBg = (y) => {
      let n = 0
      for (let x = 0; x < W; x++) if (bright((y * W + x) * 3)) n++
      return n > W * 0.85
    }
    const colIsBg = (x) => {
      let n = 0
      for (let y = 0; y < H; y++) if (bright((y * W + x) * 3)) n++
      return n > H * 0.85
    }
    let top = 0
    let bottom = H - 1
    let left = 0
    let right = W - 1
    while (top < bottom && rowIsBg(top)) top++
    while (bottom > top && rowIsBg(bottom)) bottom--
    while (left < right && colIsBg(left)) left++
    while (right > left && colIsBg(right)) right--
    // 至少留一半，否则说明判断失准，不要裁
    if ((bottom - top) < H * 0.5 || (right - left) < W * 0.5) return img
    return cropImage(img, left, top, right + 1, bottom + 1)
  }

  const disposeMerge = ctx.tools.register({
    name: 'voxel_merge',
    description:
      'Merge several separate buildings into one solid unit. Call this after building '
      + 'something in multiple steps, so the whole thing moves/rotates/gets saved as one. '
      + 'Pass ids (from voxel_query buildings[]) and optional targetId. '
      + 'Only rewrites ownership; no voxels are moved or changed. '
      + 'After merging, demolishing it saves one blueprint of the whole structure.',
    parameters: {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Building ids to merge, from voxel_query buildings[]',
        },
        targetId: {
          type: 'string',
          description: 'Name for the merged unit. Omit to auto-name (整体-001, 整体-002 ...).',
        },
        saveName: {
          type: 'string',
          description:
            'Also save the merged unit into the blueprint warehouse under this name. '
            + 'Same behaviour as the 「固化」 button in the UI: merge and archive in one step. '
            + 'Omit if you only want to merge without archiving.',
        },
      },
      required: ['ids'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render(args, value) {
        return [{ type: 'text', text: JSON.stringify(value) }]
      },
    },
    async execute(args, exec) {
      const a = args || {}
      const ids = Array.isArray(a.ids) ? a.ids.map(String) : []
      if (!ids.length) return { ok: false, error: 'ids required' }
      return runOne('merge', {
        ids,
        targetId: a.targetId ? String(a.targetId) : null,
        saveName: a.saveName ? String(a.saveName) : null,
      }, exec && exec.signal)
    },
  })

  const disposeMacro = ctx.tools.register({
    name: 'voxel_macro',
    description:
      'Manage the macro warehouse: reusable parameterized building elements. '
      + 'action="save" stores a template with {placeholders}; action="list" shows the catalogue; '
      + 'action="run" builds one with optional parameter overrides. '
      + 'A macro is a template string like "box {x} 0 {z} 12 1 12 2" plus default params {x:96, z:96}. '
      + 'Running with different params reuses the same geometry at a new place or size. '
      + 'Reuse what earlier sessions stored before writing your own.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['save', 'list', 'run'], description: 'Operation' },
        name: { type: 'string', description: 'Macro name (Chinese is fine), required for save/run' },
        template: { type: 'string', description: 'Command template with {placeholders}, for save' },
        params: { type: 'object', description: 'Default params for save, or overrides for run' },
        desc: { type: 'string', description: 'One-line description, for save' },
        buildId: { type: 'string', description: 'Optional group id when running' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render(args, value) {
        return [{ type: 'text', text: JSON.stringify(value) }]
      },
    },
    async execute(args, exec) {
      const a = args || {}
      const act = String(a.action || 'list')
      if (act === 'save') {
        return runOne('macroSave', {
          name: String(a.name || ''),
          template: String(a.template || ''),
          params: a.params || {},
          desc: String(a.desc || ''),
        }, exec && exec.signal)
      }
      if (act === 'run') {
        return runOne('macroRun', {
          name: String(a.name || ''),
          params: a.params || null,
          buildId: a.buildId || null,
        }, exec && exec.signal)
      }
      // list
      return runOne('catalog', {}, exec && exec.signal)
    },
  })

  const disposeRate = ctx.tools.register({
    name: 'voxel_rate',
    description:
      'Set how fast blocks grow. perFrame = blocks added each animation frame. '
      + 'At 60fps: 2 = 120 blocks/s (each block visibly placed, good for demos); '
      + '60 = 3600 blocks/s (default, looks instant). '
      + 'Blocks always grow one batch per frame; voxel_build never pops a whole building at once.',
    parameters: {
      type: 'object',
      properties: {
        perFrame: { type: 'number', description: 'Blocks per animation frame, 1 to 2000' },
      },
      required: ['perFrame'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render(args, value) {
        return [{ type: 'text', text: JSON.stringify(value) }]
      },
    },
    async execute(args, exec) {
      const a = args || {}
      return runOne('rate', { perFrame: Number(a.perFrame) }, exec && exec.signal)
    },
  })

  const disposeScene = ctx.tools.register({
    name: 'voxel_scene',
    description:
      'Build a built-in scene (pavilion / boat) with the CORRECT internal coordinates and per-frame growth. '
      + 'Use this instead of voxel_build box commands for these two scenes: their shapes use relative offsets '
      + 'that adapt to the current cell size, so hand-computed coordinates come out wrong. '
      + 'Blocks grow one batch per frame exactly like voxel_build.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', enum: ['pavilion', 'boat'], description: 'Which built-in scene' },
        x: { type: 'number', description: 'Centre cell X (default: world centre)' },
        z: { type: 'number', description: 'Centre cell Z (default: world centre)' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render(args, value) {
        return [{ type: 'text', text: JSON.stringify(value) }]
      },
    },
    async execute(args, exec) {
      const a = args || {}
      return runOne('scene', { name: a.name, x: a.x, z: a.z }, exec && exec.signal)
    },
  })

  const disposeRotate = ctx.tools.register({
    name: 'voxel_rotate',
    description:
      'Rotate ONE building around its own vertical axis. The world and the camera do not move; '
      + 'only that building turns. Angles snap to 90/180/270 (blocky worlds cannot rotate freely '
      + 'without leaving gaps in the grid, so 90-degree steps are the only clean option). '
      + 'This is a pure view transform: block coordinates are untouched, so rotation is reversible '
      + 'and costs no building blocks. Call voxel_query for building ids.',
    parameters: {
      type: 'object',
      properties: {
        building: { type: 'string', description: 'Building id, as listed by voxel_query / voxel_catalog' },
        degrees: { type: 'number', description: 'Target angle; snapped to the nearest multiple of 90' },
      },
      required: ['building', 'degrees'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render(args, value) {
        return [{ type: 'text', text: JSON.stringify(value) }]
      },
    },
    async execute(args, exec) {
      const a = args || {}
      return runOne('rotate', { building: String(a.building || ''), degrees: Number(a.degrees) }, exec && exec.signal)
    },
  })

  const disposeMove = ctx.tools.register({
    name: 'voxel_move',
    description:
      'Move ONE building across the ground by (dx, dz) cells. Only that building moves; '
      + 'the world, the camera and every other building stay put. '
      + '1 cell = 0.5 m, so dx=20 means 10 metres. '
      + 'Block coordinates are rewritten, so moving is permanent and costs no blocks. '
      + 'If any cell of the building would leave the world, the whole move is refused '
      + '(half a building moved is worse than none). '
      + 'Call voxel_query for building ids.',
    parameters: {
      type: 'object',
      properties: {
        building: { type: 'string', description: 'Building id from voxel_query' },
        dx: { type: 'number', description: 'Cells to move along X (may be negative)' },
        dz: { type: 'number', description: 'Cells to move along Z (may be negative)' },
        check: { type: 'boolean', description: 'Only test whether the move is possible; do not move' },
      },
      required: ['building', 'dx', 'dz'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render(args, value) {
        return [{ type: 'text', text: JSON.stringify(value) }]
      },
    },
    async execute(args, exec) {
      const a = args || {}
      return runOne('move', {
        building: String(a.building || ''),
        dx: Number(a.dx) || 0,
        dz: Number(a.dz) || 0,
        check: a.check === true,
      }, exec && exec.signal)
    },
  })

  const disposeCatalog = ctx.tools.register({
    name: 'voxel_catalog',
    description:
      'Browse the blueprint and macro warehouses WITHOUT spending tokens on full templates. '
      + 'With no arguments: returns the macro catalogue as names + one-line descriptions + parameter names only '
      + '(about 20 characters per macro), plus blueprint names. '
      + 'Pass name to fetch one macro\'s full template. '
      + 'Use this before building: reuse what earlier sessions left behind instead of rebuilding it.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Macro name; omit for the whole catalogue' },
        detail: { type: 'boolean', description: 'Include every template (expensive; prefer fetching one name)' },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render(args, value) {
        return [{ type: 'text', text: JSON.stringify(value) }]
      },
    },
    async execute(args, exec) {
      const a = args || {}
      return runOne('catalog', { name: a.name || null, detail: a.detail === true }, exec && exec.signal)
    },
  })

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      try { disposeBuild() } catch (error) { /* 已卸载 */ }
      try { disposeDemolish() } catch (error) { /* 已卸载 */ }
      try { disposeQuery() } catch (error) { /* 已卸载 */ }
      try { disposePlace() } catch (error) { /* 已卸载 */ }
      try { disposeReset() } catch (error) { /* 已卸载 */ }
      try { disposeRate() } catch (error) { /* 已卸载 */ }
      try { disposeMacro() } catch (error) { /* 已卸载 */ }
      try { disposeMerge() } catch (error) { /* 已卸载 */ }
      try { disposeBlueprint() } catch (error) { /* 已卸载 */ }
      try { disposeImage() } catch (error) { /* 已卸载 */ }
      try { disposeLayered() } catch (error) { /* 已卸载 */ }
      try { disposeScene() } catch (error) { /* 已卸载 */ }
      try { disposeCatalog() } catch (error) { /* 已卸载 */ }
      try { disposeRotate() } catch (error) { /* 已卸载 */ }
      try { disposeMove() } catch (error) { /* 已卸载 */ }
    }, 'dsh-weather-sandbox: agent tools')
  }
}
