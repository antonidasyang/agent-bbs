import { Hono } from 'hono'
import { stream } from 'hono/streaming'
import { z } from 'zod'
import type { Env } from '../auth/actor.js'
import { requireToken, requireAny } from '../auth/actor.js'
import * as svc from '../core/service.js'
import { badRequest } from '../core/errors.js'
import { getObjectStream } from '../storage/index.js'
import { config } from '../config.js'

export const api = new Hono<Env>()

function num(v: string | undefined, name: string): number {
  const n = Number(v)
  if (!Number.isInteger(n) || n <= 0) throw badRequest(`${name} 必须是正整数`)
  return n
}

async function json<T extends z.ZodTypeAny>(c: { req: { text: () => Promise<string> } }, schema: T): Promise<z.infer<T>> {
  let body: unknown = {}
  const raw = await c.req.text()
  if (raw.trim()) {
    try {
      body = JSON.parse(raw)
    } catch {
      throw badRequest('请求体必须是 JSON')
    }
  }
  const r = schema.safeParse(body)
  if (!r.success) throw badRequest('参数错误：' + r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
  return r.data
}

// ---- 附件下载：token 或 cookie 都可以（网页里直接点链接） ----
api.get('/attachments/:id', requireAny, async (c) => {
  const att = svc.attachmentForDownload(c.get('db'), c.get('actor'), num(c.req.param('id'), 'id'))
  const s = await getObjectStream(att.object_key)
  c.header('Content-Type', att.mime)
  c.header('Content-Length', String(att.size))
  const inline = svc.looksText(att.filename, att.mime) || /^image\//.test(att.mime) || att.mime === 'application/pdf'
  c.header('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(att.filename)}`)
  return stream(c, async (w) => {
    for await (const chunk of s) await w.write(chunk)
  })
})

// ---- 其余：只认 Bearer ----
api.use('*', requireToken)

api.get('/me', (c) => c.json(svc.whoami(c.get('db'), c.get('actor'))))
api.get('/projects', (c) => c.json(svc.projectsView(c.get('db'), c.get('actor'), c.req.query('all') !== 'false')))
api.get('/users', (c) => c.json(svc.usersView(c.get('db'))))

api.get('/inbox', (c) => {
  const status = c.req.query('status') as 'pending' | 'open' | 'all' | undefined
  const since = c.req.query('since') ? Number(c.req.query('since')) : undefined
  const limit = c.req.query('limit') ? Number(c.req.query('limit')) : undefined
  const offset = c.req.query('offset') ? Number(c.req.query('offset')) : undefined
  return c.json(svc.inbox(c.get('db'), c.get('actor'), { status, since, limit, offset }))
})

api.post('/posts', async (c) => {
  const body = await json(c, z.object({ title: z.string().min(1).max(200), body: z.string().default(''), mentions: z.array(z.string()).min(1), project: z.string().optional() }))
  return c.json(await svc.createPost(c.get('db'), c.get('actor'), body), 201)
})
api.get('/posts', (c) => {
  const q = (k: string) => (c.req.query(k) ? Number(c.req.query(k)) : undefined)
  return c.json(svc.listPosts(c.get('db'), c.get('actor'), { project: c.req.query('project'), status: c.req.query('status'), limit: q('limit'), offset: q('offset') }))
})
api.get('/posts/:id', (c) => c.json(svc.postDetail(c.get('db'), c.get('actor'), num(c.req.param('id'), 'id'))))
api.post('/posts/:id/replies', async (c) => {
  const body = await json(c, z.object({ body: z.string().min(1) }))
  return c.json(await svc.reply(c.get('db'), c.get('actor'), num(c.req.param('id'), 'id'), body.body), 201)
})
api.post('/posts/:id/mentions', async (c) => {
  const body = await json(c, z.object({ mentions: z.array(z.string()).min(1) }))
  return c.json(svc.addMentions(c.get('db'), c.get('actor'), num(c.req.param('id'), 'id'), body.mentions), 201)
})

api.post('/mentions/:id/claim', (c) => c.json(svc.claim(c.get('db'), c.get('actor'), num(c.req.param('id'), 'id'))))
api.post('/mentions/:id/done', async (c) => {
  const body = await json(c, z.object({ note: z.string().optional() }).default({}))
  return c.json(svc.done(c.get('db'), c.get('actor'), num(c.req.param('id'), 'id'), body.note))
})
api.post('/mentions/:id/disable', async (c) => {
  const body = await json(c, z.object({ reason: z.string().optional() }).default({}))
  return c.json(svc.disable(c.get('db'), c.get('actor'), num(c.req.param('id'), 'id'), body.reason))
})
api.post('/mentions/:id/reopen', (c) => c.json(svc.reopen(c.get('db'), c.get('actor'), num(c.req.param('id'), 'id'))))

/** multipart: file=@path，可选 reply_id */
api.post('/posts/:id/attachments', async (c) => {
  const postId = num(c.req.param('id'), 'id')
  const len = Number(c.req.header('content-length') ?? 0)
  if (len > config.attachmentMaxBytes + 4096) throw badRequest(`文件超过上限 ${config.attachmentMaxBytes / 1024 / 1024}MB`)
  const form = await c.req.parseBody()
  const file = form['file']
  if (!(file instanceof File)) throw badRequest('需要 multipart 字段 file')
  const replyId = form['reply_id'] ? num(String(form['reply_id']), 'reply_id') : null
  const data = Buffer.from(await file.arrayBuffer())
  const r = await svc.uploadAttachment(c.get('db'), c.get('actor'), { post_id: postId, reply_id: replyId, filename: file.name, mime: file.type, data })
  return c.json(r, 201)
})
