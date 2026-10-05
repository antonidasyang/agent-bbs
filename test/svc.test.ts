import { test, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'
process.env.SESSION_SECRET = 'test'
process.env.ACCOUNT_DOMAIN = 'example.com'
process.env.SVC_INTROSPECT_URL = 'http://account.test/oauth/introspect'
process.env.SVC_INTROSPECT_KEY = 'shared-key'
process.env.SVC_ALLOWED_CLIENTS = 'svc_demo, SVC_Other'
// 服务账号即使被写进超管名单也不是超管
process.env.ADMIN_USERS = 'root1@example.com,svc_demo@example.com'
process.env.AUDIT_LLM_BASE_URL = ''
process.env.AUDIT_LLM_MODEL = ''
process.env.SMTP_HOST = ''
const { Hono } = await import('hono')
const { openDb } = await import('../src/db/index.js')
const { api } = await import('../src/api/routes.js')
const { AppError } = await import('../src/core/errors.js')
const { introspect, resetIntrospectCache } = await import('../src/auth/introspect.js')
const { upsertUserFromCas, ensureServiceUser, getUser } = await import('../src/core/users.js')
const { createToken } = await import('../src/core/tokens.js')
const { createManualProject } = await import('../src/core/projects.js')
const members = await import('../src/core/members.js')
const posts = await import('../src/core/posts.js')
import type { Actor } from '../src/core/types.js'

// ---- 假的 账号服务：按令牌字符串返回预设结果 ----
type Answer = Record<string, unknown> | 'down' | 'http500'
let answers: Record<string, Answer> = {}
let calls: { url: string; key: string | null; token: string }[] = []
const exp = () => Math.floor(Date.now() / 1000) + 3600
const svcToken = (sub: string, name = '订单同步服务') => ({ active: true, sub, type: 'client_credentials', name, exp: exp() })
globalThis.fetch = (async (url: string, init: RequestInit) => {
  const token = JSON.parse(String(init.body)).token as string
  calls.push({ url: String(url), key: new Headers(init.headers).get('x-introspect-key'), token })
  const a = answers[token] ?? { active: false }
  if (a === 'down') throw new Error('connect ECONNREFUSED')
  if (a === 'http500') return new Response('oops', { status: 500 })
  return Response.json(a)
}) as typeof fetch

let db: ReturnType<typeof openDb>
let app: InstanceType<typeof Hono>
const GIT = 'https://git.example.com/demo/app.git'
const call = (path: string, token: string | null, init: { method?: string; body?: unknown; project?: string } = {}) =>
  app.request('/api/v1' + path, {
    method: init.method ?? (init.body ? 'POST' : 'GET'),
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init.project ? { 'X-Project': init.project } : {}), ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
  })

beforeEach(() => {
  resetIntrospectCache()
  answers = { 'jwt-demo': svcToken('svc_demo'), 'jwt-other': svcToken('svc_other', '另一个平台') }
  calls = []
  db = openDb(':memory:')
  upsertUserFromCas(db, { upn: 'zhangsan@example.com', displayName: '张三' })
  app = new Hono()
  app.use('*', async (c, next) => {
    c.set('db' as never, db as never)
    await next()
  })
  app.onError((err, c) => (err instanceof AppError ? c.json({ error: err.code, message: err.message }, err.status as 400) : c.json({ error: 'internal', message: String(err) }, 500)))
  app.route('/api/v1', api)
})

test('introspect：带共享密钥远程校验；正/负结果都缓存', async () => {
  const r = await introspect('jwt-demo')
  assert.equal(r.result, 'active')
  assert.equal(r.result === 'active' && r.claims.sub, 'svc_demo')
  assert.deepEqual(calls[0], { url: 'http://account.test/oauth/introspect', key: 'shared-key', token: 'jwt-demo' })
  await introspect('jwt-demo')
  assert.equal(calls.length, 1, '正缓存')
  assert.equal((await introspect('bad')).result, 'inactive')
  assert.equal((await introspect('bad')).result, 'inactive')
  assert.equal(calls.length, 2, '负缓存')
})

test('introspect：密钥被拒 / 5xx / 连不上 → unavailable，且不当成"令牌无效"缓存', async () => {
  answers['t'] = { active: false, error: 'unauthorized' }
  assert.equal((await introspect('t')).result, 'unavailable')
  answers['t'] = 'http500'
  assert.equal((await introspect('t')).result, 'unavailable')
  answers['t'] = 'down'
  assert.equal((await introspect('t')).result, 'unavailable')
  answers['t'] = svcToken('svc_demo')
  assert.equal((await introspect('t')).result, 'active', '恢复后立刻可用')
  assert.equal(calls.length, 4)
})

test('introspect 降级：账号服务 挂了，10 分钟内验过的令牌放行，之后拒绝；没验过的一律拒绝', async () => {
  mock.timers.enable({ apis: ['Date'], now: Date.now() })
  try {
    assert.equal((await introspect('jwt-demo')).result, 'active')
    answers['jwt-demo'] = 'down'
    answers['jwt-other'] = 'down'
    mock.timers.tick(6 * 60_000) // 正缓存（5 分钟）已过
    const r = await introspect('jwt-demo')
    assert.equal(r.result, 'active')
    assert.equal(r.result === 'active' && r.degraded, true)
    assert.equal((await introspect('jwt-other')).result, 'unavailable', '没验过的不放行')
    mock.timers.tick(5 * 60_000) // 距上次验过 11 分钟
    assert.equal((await introspect('jwt-demo')).result, 'unavailable')
  } finally {
    mock.timers.reset()
  }
})

test('introspect：被撤销后（对端返回 inactive）不再降级放行', async () => {
  mock.timers.enable({ apis: ['Date'], now: Date.now() })
  try {
    await introspect('jwt-demo')
    mock.timers.tick(6 * 60_000)
    answers['jwt-demo'] = { active: false }
    assert.equal((await introspect('jwt-demo')).result, 'inactive')
    mock.timers.tick(2 * 60_000)
    answers['jwt-demo'] = 'down'
    assert.equal((await introspect('jwt-demo')).result, 'unavailable')
  } finally {
    mock.timers.reset()
  }
})

test('REST 鉴权：没带 / 无效 / 校验服务不可用 / 个人令牌 / 不在白名单', async () => {
  assert.equal((await call('/me', null)).status, 401)
  assert.equal((await call('/me', 'garbage.jwt.token')).status, 401)
  answers['jwt-down'] = 'down'
  const down = await call('/me', 'jwt-down')
  assert.equal(down.status, 503)
  assert.equal(((await down.json()) as { error: string }).error, 'auth_unavailable')
  answers['jwt-human'] = { active: true, sub: 'zhangsan', type: 'authorization_code', name: '张三', exp: exp() }
  assert.equal((await call('/me', 'jwt-human')).status, 403)
  answers['jwt-stranger'] = svcToken('svc_stranger')
  const s = await call('/me', 'jwt-stranger')
  assert.equal(s.status, 403)
  assert.match(((await s.json()) as { message: string }).message, /不在本 BBS 的允许名单/)
  assert.equal(getUser(db, 'svc_stranger@example.com'), undefined, '白名单外的不建用户')
})

test('白名单内的服务账号 = 一个 BBS 用户：姓名取令牌里的 name，不是超管', async () => {
  const r = await call('/me', 'jwt-demo', { project: GIT })
  assert.equal(r.status, 200)
  const me = (await r.json()) as { user: { handle: string; display_name: string; is_admin: boolean }; project: { slug: string } }
  assert.deepEqual(me.user, { upn: 'svc_demo@example.com', handle: 'svc_demo', display_name: '订单同步服务', is_admin: false })
  assert.equal(me.project.slug, 'git.example.com/demo/app')
  assert.equal(getUser(db, 'svc_demo@example.com')!.is_service, 1)
  // 白名单大小写不敏感
  assert.equal((await call('/me', 'jwt-other')).status, 200)
})

test('平台发帖、看帖、回帖；bbs_ token 照常可用', async () => {
  const created = await call('/posts', 'jwt-demo', { project: GIT, body: { title: '订单导出超时', body: '详情……', mentions: ['zhangsan'] } })
  assert.equal(created.status, 201)
  const { post_id } = (await created.json()) as { post_id: number }
  // 没带 X-Project 的写操作照旧被拒
  assert.equal((await call('/posts', 'jwt-demo', { body: { title: 't', body: 'b', mentions: ['zhangsan'] } })).status, 403)

  const list = (await (await call('/posts', 'jwt-demo', { project: GIT })).json()) as { project: string; has_more: boolean; posts: { id: number; title: string; author: { handle: string }; mentions: { target: string; status: string }[] }[] }
  assert.equal(list.project, 'git.example.com/demo/app')
  assert.equal(list.has_more, false)
  assert.deepEqual(list.posts.map((p) => [p.id, p.title, p.author.handle]), [[post_id, '订单导出超时', 'svc_demo']])
  assert.deepEqual(list.posts[0].mentions.map((m) => [m.target, m.status]), [['zhangsan', 'pending']])
  assert.equal(((await (await call('/posts?status=done', 'jwt-demo', { project: GIT })).json()) as { posts: unknown[] }).posts.length, 0)
  assert.equal((await call('/posts?status=bogus', 'jwt-demo', { project: GIT })).status, 400)
  assert.equal((await call('/posts?limit=1000', 'jwt-demo', { project: GIT })).status, 400)

  // 真人用本站 token 回帖、@ 平台；平台在收件箱里看到
  const human = createToken(db, 'zhangsan@example.com', 't').plain
  assert.equal((await call(`/posts/${post_id}/replies`, human, { project: GIT, body: { body: '在看了' } })).status, 201)
  assert.equal((await call('/posts', human, { project: GIT, body: { title: '请平台重推一次', body: 'x', mentions: ['svc_demo'] } })).status, 201)
  const detail = (await (await call(`/posts/${post_id}`, 'jwt-demo', { project: GIT })).json()) as { replies: { author: string }[] }
  assert.deepEqual(detail.replies.map((r) => r.author), ['zhangsan'])
  const inbox = (await (await call('/inbox', 'jwt-demo', { project: GIT })).json()) as { tasks: { title: string }[] }
  assert.deepEqual(inbox.tasks.map((t) => t.title), ['请平台重推一次'])

  // 分页
  for (let i = 0; i < 3; i++) await call('/posts', 'jwt-demo', { project: GIT, body: { title: `p${i}`, body: 'b', mentions: ['zhangsan'] } })
  const page = (await (await call('/posts?limit=2', 'jwt-demo', { project: GIT })).json()) as { has_more: boolean; posts: { title: string }[] }
  assert.equal(page.has_more, true)
  assert.deepEqual(page.posts.map((p) => p.title), ['p2', 'p1'])
})

test('全局实例（token 不带 X-Project）：读跨全部参与项目；发帖必须显式传 project', async () => {
  const human = createToken(db, 'zhangsan@example.com', 't').plain
  const GIT2 = 'https://git.example.com/demo/web.git'
  await call('/posts', 'jwt-demo', { project: GIT, body: { title: 'A 项目的活', body: 'x', mentions: ['zhangsan'] } })
  await call('/posts', 'jwt-demo', { project: GIT2, body: { title: 'B 项目的活', body: 'x', mentions: ['zhangsan'] } })
  // 无 X-Project 连接：whoami 是全局模式；inbox / 列表跨两个项目
  const me = (await (await call('/me', human)).json()) as { project: null; hint?: string }
  assert.equal(me.project, null)
  assert.match(me.hint!, /全局模式/)
  const inbox = (await (await call('/inbox', human)).json()) as { project: null; tasks: { title: string }[] }
  assert.equal(inbox.project, null)
  assert.deepEqual(inbox.tasks.map((t) => t.title).sort(), ['A 项目的活', 'B 项目的活'])
  const list = (await (await call('/posts', human)).json()) as { posts: { title: string }[] }
  assert.deepEqual(list.posts.map((p) => p.title).sort(), ['A 项目的活', 'B 项目的活'])
  // 发帖：不指版块 → 403；显式传 project → 201（落在目标版块）
  const noTarget = await call('/posts', human, { body: { title: 't', body: 'b', mentions: ['svc_demo'] } })
  assert.equal(noTarget.status, 403)
  assert.match(((await noTarget.json()) as { message: string }).message, /指明版块/)
  assert.equal((await call('/posts', human, { body: { title: '跨版块', body: 'b', mentions: ['svc_demo'], project: GIT2 } })).status, 201)
  const inB = (await (await call('/posts?project=git.example.com/demo/web', human)).json()) as { posts: { title: string }[] }
  assert.equal(inB.posts[0].title, '跨版块')
})

test('可见性和普通用户一样：没接入过的 git 项目看不到帖子；手动项目要先被邀请，邀请即加入', async () => {
  const zhang: Actor = { user: getUser(db, 'zhangsan@example.com')!, isAdmin: false, project: null, via: 'session' }
  upsertUserFromCas(db, { upn: 'lisi@example.com', displayName: '李四' })
  const human = createToken(db, 'zhangsan@example.com', 't').plain
  await call('/posts', human, { project: GIT, body: { title: '内部帖', body: 'x', mentions: ['lisi'] } })
  // svc_other 没以这个项目身份连接过：按项目名查不到帖子
  await call('/me', 'jwt-other')
  assert.equal(((await (await call('/posts?project=git.example.com/demo/app', 'jwt-other')).json()) as { posts: unknown[] }).posts.length, 0)
  // 带 X-Project 连接 = 参与，和普通 token 同口径
  assert.equal(((await (await call('/posts', 'jwt-other', { project: GIT })).json()) as { posts: unknown[] }).posts.length, 1)

  const manual = createManualProject(db, zhang, { name: '对账', key: 'recon' })
  assert.equal((await call('/me', 'jwt-demo', { project: 'bbs:recon' })).status, 403, '非成员不能以手动项目身份连接')
  ensureServiceUser(db, 'svc_demo')
  const r = members.inviteMembers(db, zhang, manual.id, ['svc_demo', 'lisi'])
  assert.deepEqual(r.joined.map((u) => u.upn), ['svc_demo@example.com'])
  assert.deepEqual(r.invited.map((i) => i.user.upn), ['lisi@example.com'], '真人照旧走邀请邮件')
  assert.equal(members.isJoined(db, manual.id, 'svc_demo@example.com'), true)
  assert.equal((await call('/posts', 'jwt-demo', { project: 'bbs:recon', body: { title: '对账结果', body: 'x', mentions: ['zhangsan'] } })).status, 201)
})

test('服务账号用户：git 项目的 @all 不带它；先被邀请后成为服务账号则邀请直接生效；不顶替真人账号', () => {
  const zhang: Actor = { user: getUser(db, 'zhangsan@example.com')!, isAdmin: false, project: null, via: 'session' }
  const manual = createManualProject(db, zhang, { name: '对账', key: 'recon' })
  // 还没成为服务账号时被按账号邀请 → 占位用户、待接受
  assert.deepEqual(members.inviteMembers(db, zhang, manual.id, ['svc_demo']).joined, [])
  assert.equal(members.isJoined(db, manual.id, 'svc_demo@example.com'), false)
  const u = ensureServiceUser(db, 'SVC_Demo', '订单同步服务')
  assert.equal(u.upn, 'svc_demo@example.com')
  assert.equal(u.is_service, 1)
  assert.equal(u.mail, null)
  assert.equal(members.isJoined(db, manual.id, 'svc_demo@example.com'), true)
  assert.equal(ensureServiceUser(db, 'svc_demo').display_name, '订单同步服务', '不带 name 时保留原姓名')

  upsertUserFromCas(db, { upn: 'lisi@example.com', displayName: '李四' })
  const expanded = posts.expandAll(db, zhang, { kind: 'git' } as never, ['all'])
  assert.deepEqual(expanded, ['lisi@example.com'])

  assert.throws(() => ensureServiceUser(db, 'zhangsan'), /重名/)
  assert.throws(() => ensureServiceUser(db, 'bad id!'), /格式不支持/)
})
