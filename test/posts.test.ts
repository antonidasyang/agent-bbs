import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
process.env.SESSION_SECRET = 'test'
const { openDb } = await import('../src/db/index.js')
const { upsertUserFromCas, isAdmin, resolveMentions } = await import('../src/core/users.js')
const { ensureProject } = await import('../src/core/projects.js')
const posts = await import('../src/core/posts.js')
const { createToken, authenticateToken, revokeToken } = await import('../src/core/tokens.js')
import type { Actor, User, Project } from '../src/core/types.js'

let db: ReturnType<typeof openDb>
let yang: User, li: User, wang: User
let client: Project, server: Project
const actor = (u: User, p: Project | null): Actor => ({ user: u, isAdmin: isAdmin(u.upn), project: p, via: 'token' })

beforeEach(() => {
  db = openDb(':memory:')
  yang = upsertUserFromCas(db, { upn: 'alice@example.com', displayName: '艾丽丝' })
  li = upsertUserFromCas(db, { upn: 'lisi@example.com', displayName: '李四' })
  wang = upsertUserFromCas(db, { upn: 'wangwu@example.com', displayName: '王五' })
  client = ensureProject(db, 'http://git.example.com/ai/client.git')
  server = ensureProject(db, 'git@git.example.com:ai/server.git')
})

test('ensureProject 幂等', () => {
  assert.equal(ensureProject(db, 'https://git.example.com/ai/client').id, client.id)
})

test('resolveMentions：handle / 姓名 / 全 upn / 重名拒绝 / 不存在', () => {
  assert.deepEqual(resolveMentions(db, ['@lisi', '王五', 'alice@example.com']).map((u) => u.upn), [li.upn, wang.upn, yang.upn])
  assert.throws(() => resolveMentions(db, ['nobody']), /不存在/)
  upsertUserFromCas(db, { upn: 'lisi2@example.com', displayName: '李四' })
  assert.throws(() => resolveMentions(db, ['李四']), /同名/)
  assert.equal(resolveMentions(db, ['lisi'])[0].upn, li.upn)
})

test('完整流程：发帖 → 收件箱 → 认领 → 完成 → 发起者看到动态', () => {
  const y = actor(yang, client)
  const l = actor(li, server)
  const { post, mentions } = posts.createPost(db, y, { project: server, title: 't', body: 'b', mentions: ['lisi'] })
  assert.equal(post.source_project_id, client.id)
  assert.equal(mentions.length, 1)

  // lisi 在 server 项目能看到，在别的项目看不到
  assert.equal(posts.getInbox(db, l).tasks.length, 1)
  assert.equal(posts.getInbox(db, actor(li, client)).tasks.length, 0)
  // 王五看不到这帖
  assert.throws(() => posts.requireVisiblePost(db, actor(wang, server), post.id), /无权/)
  // 超管看得到
  assert.ok(posts.requireVisiblePost(db, actor(yang, null), post.id))

  posts.claimMention(db, l, mentions[0].id)
  assert.equal(posts.getMention(db, mentions[0].id)!.status, 'in_progress')
  // 王五不能认领/完成
  assert.throws(() => posts.markDone(db, actor(wang, server), mentions[0].id), /无权|不存在/)

  posts.markDone(db, l, mentions[0].id, '搞定')
  const m = posts.getMention(db, mentions[0].id)!
  assert.equal(m.status, 'done')
  assert.equal(posts.listReplies(db, post.id).length, 1)
  // 完成后从 lisi 收件箱消失
  assert.equal(posts.getInbox(db, l, { status: 'open' }).tasks.length, 0)
  assert.equal(posts.getInbox(db, l, { status: 'all' }).tasks.length, 1)

  // 发起者在 client 项目看到 claimed + done 两条动态，且不包含自己的 mentioned
  const box = posts.getInbox(db, y)
  assert.deepEqual(box.updates.map((u) => u.type), ['done', 'claimed'])
  // since 游标
  assert.equal(posts.getInbox(db, y, { since: box.cursor }).updates.length, 0)

  // 只有发帖人能禁用/重开
  assert.throws(() => posts.disableMention(db, l, mentions[0].id), /发帖人/)
  posts.reopenMention(db, y, mentions[0].id)
  assert.equal(posts.getMention(db, mentions[0].id)!.status, 'pending')
  posts.disableMention(db, y, mentions[0].id, '不用了')
  assert.equal(posts.getMention(db, mentions[0].id)!.status, 'disabled')
  assert.equal(posts.getInbox(db, l, { status: 'open' }).tasks.length, 0)
})

test('token 创建 / 认证 / 吊销', () => {
  const { plain } = createToken(db, yang.upn, 'mac')
  assert.ok(plain.startsWith('bbs_'))
  assert.equal(authenticateToken(db, plain)!.user.upn, yang.upn)
  assert.equal(authenticateToken(db, 'bbs_wrong'), null)
  assert.equal(revokeToken(db, li.upn, 1), false) // 别人不能吊销
  assert.equal(revokeToken(db, yang.upn, 1), true)
  assert.equal(authenticateToken(db, plain), null)
})

test('listPosts 状态筛选与可见性', () => {
  const y = actor(yang, client)
  posts.createPost(db, y, { project: server, title: 'a', body: '', mentions: ['lisi'] })
  const p2 = posts.createPost(db, y, { project: server, title: 'b', body: '', mentions: ['wangwu'] })
  posts.markDone(db, actor(wang, server), p2.mentions[0].id)
  const l = actor(li, null)
  assert.deepEqual(posts.listPosts(db, l, { projectId: server.id }).map((p) => p.title), ['a'])
  assert.deepEqual(posts.listPosts(db, actor(wang, null), { projectId: server.id, status: 'done' }).map((p) => p.title), ['b'])
  assert.equal(posts.listPosts(db, y, { projectId: server.id }).length, 2)
})

test('手动项目：成员制、邀请、接受、非成员拒绝', async () => {
  const members = await import('../src/core/members.js')
  const { createManualProject, ensureProject: ensure } = await import('../src/core/projects.js')
  const y = actor(yang, null)
  const p = createManualProject(db, y, { name: 'Q4 市场活动', description: 'desc' })
  assert.equal(p.kind, 'manual')
  assert.equal(p.slug, 'bbs:q4')
  assert.equal(p.owner_upn, yang.upn)
  assert.ok(members.isJoined(db, p.id, yang.upn))

  // 未登录过的人也能按账号邀请（建占位用户）；姓名只能匹配已存在的
  const r = members.inviteMembers(db, y, p.id, ['zhaoliu', '李四'])
  assert.equal(r.invited.length, 2)
  assert.equal(members.getMember(db, p.id, 'zhaoliu@example.com')!.status, 'invited')
  assert.throws(() => members.inviteMembers(db, y, p.id, ['不存在的人']), /不存在/)

  // 非成员不能发帖；@ 未加入的人被拒
  const li0 = actor(li, p)
  assert.throws(() => posts.createPost(db, li0, { project: p, title: 't', body: '', mentions: ['alice'] }), /不是项目/)
  assert.throws(() => posts.createPost(db, actor(yang, p), { project: p, title: 't', body: '', mentions: ['lisi'] }), /不是项目.*成员/)

  // 别人不能用李四的邀请 token
  const liInvite = r.invited.find((i) => i.user.upn === li.upn)!
  assert.throws(() => members.acceptInvite(db, actor(wang, null), liInvite.token), /发给/)
  members.acceptInvite(db, actor(li, null), liInvite.token)
  assert.ok(members.isJoined(db, p.id, li.upn))
  assert.equal(members.pendingInvites(db, li.upn).length, 0)

  // 加入后可以互相 @
  const created = posts.createPost(db, actor(yang, p), { project: p, title: 't', body: '', mentions: ['lisi'] })
  assert.equal(posts.getInbox(db, actor(li, p)).tasks.length, 1)
  assert.equal(created.mentions.length, 1)

  // 成员也能邀请；X-Project bbs:key 对非成员拒绝
  members.inviteMembers(db, actor(li, p), p.id, ['wangwu'])
  assert.throws(() => members.requireMembership(db, actor(wang, null), ensure(db, p.slug)), /不是项目/)
  assert.throws(() => ensure(db, 'bbs:nope'), /不存在/)

  // owner 才能移除；owner 不能退出
  assert.throws(() => members.removeMember(db, actor(li, null), p.id, wang.upn), /创建者/)
  members.removeMember(db, y, p.id, li.upn)
  assert.equal(members.getMember(db, p.id, li.upn), undefined)
  assert.throws(() => members.leaveProject(db, y, p.id), /不能退出/)
})

test('手动项目自定义 key', async () => {
  const { createManualProject } = await import('../src/core/projects.js')
  const y = actor(yang, null)
  assert.equal(createManualProject(db, y, { name: '双十一', key: 'D11-Promo' }).slug, 'bbs:d11-promo')
  assert.throws(() => createManualProject(db, y, { name: 'x', key: 'd11-promo' }), /占用/)
  assert.throws(() => createManualProject(db, y, { name: 'x', key: '中文' }), /key/)
  assert.match(createManualProject(db, y, { name: '双十一' }).slug, /^bbs:[0-9a-f]{8}$/)
})
