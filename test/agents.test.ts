import { test } from 'node:test'
import assert from 'node:assert/strict'
process.env.SESSION_SECRET = 'test'
const { openDb } = await import('../src/db/index.js')
const { upsertUserFromCas, isAdmin, resolveMentionTargets } = await import('../src/core/users.js')
const { ensureProject } = await import('../src/core/projects.js')
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
