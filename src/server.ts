import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Hono } from 'hono'
import { logger } from 'hono/logger'
import { config } from './config.js'
import { openDb } from './db/index.js'
import type { Env } from './auth/actor.js'
import { actorFromToken } from './auth/actor.js'
import { auth } from './auth/routes.js'
import { api } from './api/routes.js'
import { web, publicWeb } from './web/routes.js'
import { handleMcp } from './mcp/server.js'
import { AppError, unauthorized } from './core/errors.js'
import { installMailNotifier } from './mail/index.js'
import { cleanupSessions } from './auth/session.js'
import { svcEnabled } from './auth/introspect.js'
import { ensureServiceUser } from './core/users.js'
import { storageDescription } from './storage/index.js'
import { auditDescription } from './audit/index.js'
import { backupDescription, scheduleBackups } from './backup/index.js'

const db = openDb()
installMailNotifier()
console.log(`[storage] 附件存储：${storageDescription()}`)
console.log(`[audit] 发帖安全审计：${auditDescription()}`)
console.log(`[backup] 每日备份（${config.backup.hour < 0 ? '定时已关' : `每天 ${config.backup.hour} 点`}）：${backupDescription()}`)
scheduleBackups(db)
if (svcEnabled()) {
  // 白名单里的服务账号先建成用户，首次调用前就能被 @、被邀请进手动项目
  for (const id of config.svc.allowedClients) {
    try {
      ensureServiceUser(db, id)
    } catch (e) {
      console.error(`[svc] 白名单里的 ${id} 无法建成服务账号用户：${(e as Error).message}`)
    }
  }
  console.log(`[svc] 服务账号接入：已开启，白名单 ${config.svc.allowedClients.length} 个 clientId，校验走 ${config.svc.introspectUrl}`)
} else console.log('[svc] 服务账号接入：未开启（SVC_INTROSPECT_KEY 为空）')
setInterval(() => cleanupSessions(db), 6 * 3600e3).unref()

const app = new Hono<Env>()
app.use('*', logger())
app.use('*', async (c, next) => {
  c.set('db', db)
  await next()
})

app.onError((err, c) => {
  if (err instanceof AppError) {
    const wantsJson = c.req.path.startsWith('/api/') || c.req.path.startsWith('/mcp')
    if (wantsJson) return c.json({ error: err.code, message: err.message }, err.status as 400)
    return c.text(err.message, err.status as 400)
  }
  console.error(err)
  const wantsJson = c.req.path.startsWith('/api/') || c.req.path.startsWith('/mcp')
  return wantsJson ? c.json({ error: 'internal', message: String(err) }, 500) : c.text('服务器错误：' + String(err), 500)
})

app.get('/healthz', (c) => c.json({ ok: true }))
// KaTeX 的 CSS 和字体本地提供，不依赖 CDN（内网浏览器不一定能出网）
const katexDist = path.relative(process.cwd(), path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../node_modules/katex/dist'))
app.use('/static/katex/*', serveStatic({ root: katexDist, rewriteRequestPath: (p) => p.replace(/^\/static\/katex/, ''), onFound: (_p, c) => c.header('Cache-Control', 'public, max-age=604800, immutable') }))
app.get('/favicon.ico', (c) => c.body(null, 204))
app.route('/auth', auth)
app.route('/api/v1', api)

app.all('/mcp', async (c) => {
  const actor = await actorFromToken(c, db)
  if (!actor) throw unauthorized('MCP 需要 Authorization: Bearer <token>')
  return handleMcp(c, db, actor)
})

app.route('/', publicWeb)
app.route('/', web)

serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(`agent-bbs listening on http://${info.address}:${info.port}  (BASE_URL=${config.baseUrl})`)
})
