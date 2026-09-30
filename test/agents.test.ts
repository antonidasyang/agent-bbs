import { test } from 'node:test'
import assert from 'node:assert/strict'
process.env.SESSION_SECRET = 'test'
const { openDb } = await import('../src/db/index.js')
const { upsertUserFromCas, isAdmin, resolveMentionTargets } = await import('../src/core/users.js')
const { ensureProject, createManualProject } = await import('../src/core/projects.js')
const { createToken } = await import('../src/core/tokens.js')
const agents = await import('../src/core/agents.js')
const posts = await import('../src/core/posts.js')
const { actorFromToken } = await import('../src/auth/actor.js')
import type { Actor, User, Project, Agent } from '../src/core/types.js'

const db = openDb(':memory:')
const yang = upsertUserFromCas(db, { upn: 'alice@example.com', displayName: '艾丽丝' })
const li = upsertUserFromCas(db, { upn: 'lisi@example.com', displayName: '李四' })
const proj = ensureProject(db, 'https://github.com/example/app.git')
const actor = (u: User, p: Project | null, agent: Agent | null = null, via: 'token' | 'session' = 'token'): Actor => ({ user: u, isAdmin: isAdmin(u.upn), project: p, via, agent })

test('默认 agent 自动建；建/设默认/删除', () => {
  const d = agents.ensureDefaultAgent(db, li.upn)
  assert.equal(d.agent_id, 'default')
  assert.equal(d.is_default, 1)
  assert.equal(agents.listAgents(db, li.upn).length, 1)
  assert.throws(() => agents.createAgent(db, li.upn, { agentId: 'Bad Id!' }), /agent id 只能/)
  const desk = agents.createAgent(db, li.upn, { agentId: 'Desktop', name: '办公室台式机' })
  assert.equal(desk.agent_id, 'desktop')
  assert.throws(() => agents.createAgent(db, li.upn, { agentId: 'desktop' }), /已存在/)
  assert.throws(() => agents.deleteAgent(db, li.upn, d.id), /默认 agent 不能删除/)
  assert.throws(() => agents.setDefaultAgent(db, yang.upn, desk.id), /不是你的/)
})

test('@user → 默认(NULL)；@user/agent → 指名；@user/<当前默认> 等价不指名；缺失报错并列出可用', () => {
  const t1 = resolveMentionTargets(db, ['lisi'])
  assert.equal(t1[0].agent, null)
  const t2 = resolveMentionTargets(db, ['@lisi/desktop'])
  assert.equal(t2[0].agent?.agent_id, 'desktop')
  assert.equal(resolveMentionTargets(db, ['李四/default'])[0].agent, null)
  assert.equal(resolveMentionTargets(db, ['lisi', 'lisi/default', '@lisi/desktop']).length, 2, '去重')
  assert.throws(() => resolveMentionTargets(db, ['lisi/laptop']), /没有名为 laptop 的 agent（可用：default, desktop）/)
  assert.throws(() => resolveMentionTargets(db, ['lisi/']), /斜杠后面/)
})

test('同一帖可以 @lisi 和 @lisi/desktop 两条；收件箱按 agent 分发；换默认后未指名的跟着走；人类会话全看', () => {
  const y = actor(yang, proj)
  const { mentions } = posts.createPost(db, y, { project: proj, title: 't', body: 'b', mentions: ['lisi', 'lisi/desktop'] })
  assert.equal(mentions.length, 2)
  const def = agents.getAgent(db, li.upn, 'default')!
  const desk = agents.getAgent(db, li.upn, 'desktop')!
  assert.equal(posts.getInbox(db, actor(li, proj, def)).tasks.length, 1, '默认 agent 只看到未指名的')
  assert.equal(posts.getInbox(db, actor(li, proj, desk)).tasks.length, 1, 'desktop 只看到指名的')
  assert.equal(posts.getInbox(db, actor(li, null, null, 'session')).tasks.length, 2, '人类会话看全部')
  const summary = posts.getPostSummary(db, mentions[0].post_id)!
  assert.deepEqual(summary.mentions.map((m) => m.target_agent), [null, 'desktop'])
  // 追加同样的 @ 不重复
  assert.equal(posts.addMentions(db, y, mentions[0].post_id, ['lisi/desktop']).length, 1)
  assert.equal(posts.getPostSummary(db, mentions[0].post_id)!.mentions.length, 2)
  // 换默认：desktop 成为默认 → 看到指名它的 + 未指名的 = 2；老 default 什么都看不到
  agents.setDefaultAgent(db, li.upn, desk.id)
  assert.equal(posts.getInbox(db, actor(li, proj, agents.getAgentById(db, desk.id)!)).tasks.length, 2)
  assert.equal(posts.getInbox(db, actor(li, proj, agents.getAgentById(db, def.id)!)).tasks.length, 0)
  // 删掉老 default（已非默认）：无影响；删掉指名的 agent → 任务回到默认
  agents.deleteAgent(db, li.upn, def.id)
  const lap = agents.createAgent(db, li.upn, { agentId: 'laptop' })
  posts.createPost(db, y, { project: proj, title: 't2', body: '', mentions: ['lisi/laptop'] })
  assert.equal(posts.getInbox(db, actor(li, proj, lap)).tasks.length, 1)
  agents.deleteAgent(db, li.upn, lap.id)
  assert.equal(posts.getInbox(db, actor(li, proj, agents.getAgentById(db, desk.id)!)).tasks.length, 3, '删掉的 agent 的任务回到默认')
})

test('X-Agent header：不带=默认；带已知的=该 agent；带未知的=400 列出可用', () => {
  const { plain } = createToken(db, li.upn, 't')
  const ctx = (headers: Record<string, string>) => ({ req: { header: (k: string) => headers[k.toLowerCase()] } }) as unknown as Parameters<typeof actorFromToken>[0]
  const base = { authorization: `Bearer ${plain}`, 'x-project': 'https://github.com/example/app.git' }
  assert.equal(actorFromToken(ctx(base), db)!.agent!.agent_id, 'desktop', '当前默认是 desktop')
  agents.createAgent(db, li.upn, { agentId: 'server' })
  assert.equal(actorFromToken(ctx({ ...base, 'x-agent': 'Server' }), db)!.agent!.agent_id, 'server')
  assert.throws(() => actorFromToken(ctx({ ...base, 'x-agent': 'nope' }), db), /X-Agent 无法识别: nope（lisi 的 agent 有：desktop, server/)
})

test('@all：git 项目 = 登录过的所有人（不含自己）；手动项目 = 已加入成员；可与指名混用并去重', () => {
  const wang = upsertUserFromCas(db, { upn: 'wangwu@example.com', displayName: '王五' })
  const y = actor(yang, proj)
  const r1 = posts.createPost(db, y, { project: proj, title: 'all', body: '', mentions: ['@all'] })
  assert.deepEqual(r1.mentions.map((m) => m.target_upn).sort(), [li.upn, wang.upn].sort())
  const r2 = posts.createPost(db, y, { project: proj, title: 'all+named', body: '', mentions: ['all', 'lisi', 'lisi/server'] })
  assert.equal(r2.mentions.length, 3, 'lisi 默认 + lisi/server（非默认）+ wangwu')
  // 手动项目：只有 joined 成员
  const manual = createManualProject(db, y, { name: 'M', key: 'm1' })
  db.prepare("INSERT INTO project_members(project_id, user_upn, role, status, joined_at) VALUES (?,?,'member','joined','2026-01-01T00:00:00Z')").run(manual.id, wang.upn)
  db.prepare("INSERT INTO project_members(project_id, user_upn, role, status) VALUES (?,?,'member','invited')").run(manual.id, li.upn)
  const r3 = posts.createPost(db, y, { project: manual, title: 'm', body: '', mentions: ['all'] })
  assert.deepEqual(r3.mentions.map((m) => m.target_upn), [wang.upn], '未接受邀请的 lisi 不在内')
  // 追加 @all 不重复
  assert.equal(posts.addMentions(db, y, r3.post.id, ['all']).length, 1)
  assert.equal(posts.getPostSummary(db, r3.post.id)!.mentions.length, 1)
})

test('agent id 保留字：all 不能建', () => {
  assert.throws(() => agents.createAgent(db, li.upn, { agentId: 'all' }), /保留字/)
})

test('@user/all = 该用户每个 agent 各一条；@user/@all 同义；all/all = 所有人的所有 agent', () => {
  // 此时 lisi 有 desktop(默认) + server；wangwu 只有自动建的 default
  const t = resolveMentionTargets(db, ['lisi/all'])
  assert.deepEqual(t.map((x) => x.agent?.agent_id ?? null).sort(), [null, 'server'].sort())
  assert.equal(resolveMentionTargets(db, ['@lisi/@all']).length, 2)
  assert.equal(resolveMentionTargets(db, ['lisi/all', 'lisi', 'lisi/server']).length, 2, '与单独指名去重')
  const y = actor(yang, proj)
  const r = posts.createPost(db, y, { project: proj, title: 'all/all', body: '', mentions: ['all/all'] })
  assert.deepEqual(r.mentions.map((m) => `${m.target_upn}:${m.target_agent_id ?? 'default'}`).sort(), [`${li.upn}:default`, `${li.upn}:${agents.getAgent(db, li.upn, 'server')!.id}`, `wangwu@example.com:default`].sort())
})

test('手动项目成员能看加入前的旧帖；git 项目仍只看自己发的/@自己的', () => {
  const y = actor(yang, proj)
  const zhao = upsertUserFromCas(db, { upn: 'zhaoliu@example.com', displayName: '赵六' })
  const manual = createManualProject(db, y, { name: 'M2', key: 'm2' })
  db.prepare("INSERT INTO project_members(project_id, user_upn, role, status, joined_at) VALUES (?,?,'member','joined','2026-01-01T00:00:00Z')").run(manual.id, li.upn)
  const old = posts.createPost(db, y, { project: manual, title: '旧帖', body: '', mentions: ['lisi'] }).post
  // 赵六此时还不是成员：看不到
  assert.throws(() => posts.requireVisiblePost(db, actor(zhao, null, null, 'session'), old.id), /无权/)
  assert.equal(posts.listPosts(db, actor(zhao, null, null, 'session'), { projectId: manual.id }).length, 0)
  // 加入后：旧帖可见
  db.prepare("INSERT INTO project_members(project_id, user_upn, role, status, joined_at) VALUES (?,?,'member','joined','2026-02-01T00:00:00Z')").run(manual.id, zhao.upn)
  assert.equal(posts.requireVisiblePost(db, actor(zhao, null, null, 'session'), old.id).id, old.id)
  assert.equal(posts.listPosts(db, actor(zhao, null, null, 'session'), { projectId: manual.id }).length, 1)
  // 仅受邀未接受：不可见
  const sun = upsertUserFromCas(db, { upn: 'sunqi@example.com', displayName: '孙七' })
  db.prepare("INSERT INTO project_members(project_id, user_upn, role, status) VALUES (?,?,'member','invited')").run(manual.id, sun.upn)
  assert.throws(() => posts.requireVisiblePost(db, actor(sun, null, null, 'session'), old.id), /无权/)
  // git 项目：没参与过的人看不到；被 @ 一次 / 发过帖 / token 连接过 → 该项目全部可见（含旧帖）
  const g = posts.createPost(db, y, { project: proj, title: 'git 帖', body: '', mentions: ['lisi'] }).post
  assert.throws(() => posts.requireVisiblePost(db, actor(zhao, null, null, 'session'), g.id), /无权/)
  posts.createPost(db, y, { project: proj, title: '@赵六', body: '', mentions: ['zhaoliu'] })
  assert.equal(posts.requireVisiblePost(db, actor(zhao, null, null, 'session'), g.id).id, g.id, '被 @ 过一次就能看旧帖')
  assert.throws(() => posts.requireVisiblePost(db, actor(sun, null, null, 'session'), g.id), /无权/)
  const { token } = createToken(db, sun.upn, 't')
  db.prepare('UPDATE tokens SET last_project_id = ? WHERE id = ?').run(proj.id, token.id)
  assert.equal(posts.requireVisiblePost(db, actor(sun, null, null, 'session'), g.id).id, g.id, 'token 连接过也算参与')
  assert.ok(posts.listPosts(db, actor(sun, null, null, 'session'), { projectId: proj.id }).length >= 2)
})
