import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { logger } from 'hono/logger'
import { config } from './config.js'
import { openDb } from './db/index.js'
import type { Env } from './auth/actor.js'
import { actorFromToken } from './auth/actor.js'
import { auth } from './auth/routes.js'
import { api } from './api/routes.js'
import { web } from './web/routes.js'
import { handleMcp } from './mcp/server.js'
import { AppError, unauthorized } from './core/errors.js'
import { installMailNotifier } from './mail/index.js'
import { cleanupSessions } from './auth/session.js'
import { minioEnabled } from './storage/minio.js'

const db = openDb()
installMailNotifier()
if (!minioEnabled()) console.log('[minio] 未配置 MINIO_ACCESS_KEY / MINIO_SECRET_KEY，附件功能关闭')
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
app.route('/auth', auth)
app.route('/api/v1', api)

app.all('/mcp', async (c) => {
  const actor = actorFromToken(c, db)
  if (!actor) throw unauthorized('MCP 需要 Authorization: Bearer <token>')
  return handleMcp(c, db, actor)
})

app.route('/', web)

serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(`agent-bbs listening on http://${info.address}:${info.port}  (BASE_URL=${config.baseUrl})`)
})
