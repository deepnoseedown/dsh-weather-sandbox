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
    const disposers = ROUTES.map((route) => ctx.webServer.register({
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
