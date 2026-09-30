import { test } from 'node:test'
import assert from 'node:assert/strict'
process.env.SESSION_SECRET = 'test'
process.env.ACCOUNT_DOMAIN = 'example.com'
// 只填了密钥、白名单空着：整套服务账号接入必须是关的
process.env.SVC_INTROSPECT_KEY = 'shared-key'
process.env.SVC_ALLOWED_CLIENTS = ''
const { Hono } = await import('hono')
const { openDb } = await import('../src/db/index.js')
const { api } = await import('../src/api/routes.js')
const { AppError } = await import('../src/core/errors.js')
const { svcEnabled } = await import('../src/auth/introspect.js')

test('密钥和白名单没填全：服务账号令牌一律 401，且不去请求 账号服务', async () => {
  let called = 0
  globalThis.fetch = (async () => {
    called++
    return Response.json({ active: true, sub: 'svc_demo', type: 'client_credentials', exp: Math.floor(Date.now() / 1000) + 3600 })
  }) as typeof fetch
  const db = openDb(':memory:')
  const app = new Hono()
  app.use('*', async (c, next) => {
    c.set('db' as never, db as never)
    await next()
  })
  app.onError((err, c) => (err instanceof AppError ? c.json({ error: err.code, message: err.message }, err.status as 400) : c.json({ error: 'internal' }, 500)))
  app.route('/api/v1', api)
  assert.equal(svcEnabled(), false)
  for (const path of ['/me', '/posts', '/inbox']) {
    const r = await app.request('/api/v1' + path, { headers: { Authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.e30.sig', 'X-Project': 'https://git.example.com/a/b.git' } })
    assert.equal(r.status, 401, path)
  }
  assert.equal(called, 0)
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n, 0)
})
