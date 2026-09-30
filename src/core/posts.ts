import type { DB } from '../db/index.js'
import { now } from '../db/index.js'
import type { Actor, Attachment, Event, EventType, Mention, MentionStatus, Post, Project, Reply, User } from './types.js'
import { badRequest, forbidden, notFound } from './errors.js'
import { resolveMentionTargets } from './users.js'
import { requireMembership, requireTargetsAreMembers } from './members.js'
import { getProject } from './projects.js'

// ---------- 事件通知（邮件等）挂在这里，core 不直接依赖 mail ----------
export type EventListener = (db: DB, ev: Event) => void
const listeners: EventListener[] = []
export function onEvent(l: EventListener) {
  listeners.push(l)
}
function emit(db: DB, ev: Omit<Event, 'id' | 'created_at'>): Event {
  const r = db
    .prepare('INSERT INTO events(post_id, mention_id, reply_id, type, actor_upn, target_upn) VALUES (?,?,?,?,?,?)')
    .run(ev.post_id, ev.mention_id, ev.reply_id, ev.type, ev.actor_upn, ev.target_upn)
  const full = db.prepare('SELECT * FROM events WHERE id = ?').get(r.lastInsertRowid) as Event
  // 监听器在事务提交后异步跑，失败不影响主流程
  setImmediate(() => {
    for (const l of listeners) {
      try {
        l(db, full)
      } catch (e) {
        console.error('[event listener]', e)
      }
    }
  })
  return full
}

// ---------- 读取 ----------
export function getPost(db: DB, id: number): Post | undefined {
  return db.prepare('SELECT * FROM posts WHERE id = ?').get(id) as Post | undefined
}
export function getMention(db: DB, id: number): Mention | undefined {
  return db.prepare('SELECT * FROM mentions WHERE id = ?').get(id) as Mention | undefined
}
export function listMentions(db: DB, postId: number): Mention[] {
  return db.prepare('SELECT * FROM mentions WHERE post_id = ? ORDER BY id').all(postId) as Mention[]
}
export function listReplies(db: DB, postId: number): Reply[] {
  return db.prepare('SELECT * FROM replies WHERE post_id = ? ORDER BY id').all(postId) as Reply[]
}
export function listAttachments(db: DB, postId: number): Attachment[] {
  return db.prepare('SELECT * FROM attachments WHERE post_id = ? ORDER BY id').all(postId) as Attachment[]
}
export function getAttachment(db: DB, id: number): Attachment | undefined {
  return db.prepare('SELECT * FROM attachments WHERE id = ?').get(id) as Attachment | undefined
}

// ---------- 可见性 ----------
/**
 * "参与过某项目"（2026-09-30 放开，参与过就能看该项目全部帖子，含参与前的旧帖）：
 * 手动项目 = 已加入成员；git 项目 = 在该项目发过帖 / 被 @ 过 / 用 token 以该项目身份连接过。
 * SQL 片段，参数 @upn，项目 id 用 @pid 占位（调用方替换成列名或参数）。
 */
const PARTICIPATED_SQL = (pid: string) => `EXISTS (
  SELECT 1 FROM projects pv WHERE pv.id = ${pid} AND (
    (pv.kind = 'manual' AND EXISTS (SELECT 1 FROM project_members pmv WHERE pmv.project_id = pv.id AND pmv.user_upn = @upn AND pmv.status = 'joined'))
    OR (pv.kind = 'git' AND (
      EXISTS (SELECT 1 FROM posts pp WHERE pp.project_id = pv.id AND pp.author_upn = @upn)
      OR EXISTS (SELECT 1 FROM mentions mm JOIN posts pm2 ON pm2.id = mm.post_id WHERE pm2.project_id = pv.id AND mm.target_upn = @upn)
      OR EXISTS (SELECT 1 FROM tokens tk WHERE tk.user_upn = @upn AND tk.last_project_id = pv.id)
    ))
  ))`

export function hasParticipated(db: DB, upn: string, projectId: number): boolean {
  return !!db.prepare(`SELECT 1 WHERE ${PARTICIPATED_SQL('@pid')}`).get({ upn, pid: projectId })
}

/** 可见：超管 / 自己发的 / @ 自己的 / 参与过该项目 */
export function canSeePost(db: DB, actor: Actor, post: Post): boolean {
  if (actor.isAdmin) return true
  if (post.author_upn === actor.user.upn) return true
  const m = db.prepare('SELECT 1 FROM mentions WHERE post_id = ? AND target_upn = ?').get(post.id, actor.user.upn)
  if (m) return true
  return hasParticipated(db, actor.user.upn, post.project_id)
}
export function requireVisiblePost(db: DB, actor: Actor, id: number): Post {
  const post = getPost(db, id)
  if (!post || !canSeePost(db, actor, post)) throw notFound('帖子不存在或无权查看')
  return post
}

/** SQL 片段：帖子对 actor 可见。参数名 @upn */
const VISIBLE_SQL = `(p.author_upn = @upn OR EXISTS (SELECT 1 FROM mentions mv WHERE mv.post_id = p.id AND mv.target_upn = @upn) OR ${PARTICIPATED_SQL('p.project_id')})`

export interface PostSummary extends Post {
  author_name: string
  project_slug: string
  project_name: string
  source_project_slug: string | null
  reply_count: number
  mentions: { id: number; target_upn: string; target_name: string; target_agent: string | null; status: MentionStatus }[]
}

function attachSummaries(db: DB, posts: (Post & Record<string, unknown>)[]): PostSummary[] {
  const mentionStmt = db.prepare(
    `SELECT m.id, m.target_upn, u.display_name AS target_name, a.agent_id AS target_agent, m.status FROM mentions m JOIN users u ON u.upn = m.target_upn LEFT JOIN agents a ON a.id = m.target_agent_id WHERE m.post_id = ? ORDER BY m.id`,
  )
  return posts.map((p) => ({ ...(p as unknown as PostSummary), mentions: mentionStmt.all(p.id) as PostSummary['mentions'] }))
}

const SUMMARY_SELECT = `SELECT p.*, au.display_name AS author_name, pr.slug AS project_slug, pr.name AS project_name, sp.slug AS source_project_slug,
    (SELECT COUNT(*) FROM replies r WHERE r.post_id = p.id) AS reply_count
   FROM posts p JOIN users au ON au.upn = p.author_upn JOIN projects pr ON pr.id = p.project_id
   LEFT JOIN projects sp ON sp.id = p.source_project_id`

export function listPosts(
  db: DB,
  actor: Actor,
  opts: { projectId?: number; status?: MentionStatus | 'open' | 'all'; limit?: number; offset?: number } = {},
): PostSummary[] {
  const where: string[] = []
  const params: Record<string, unknown> = { upn: actor.user.upn, limit: opts.limit ?? 50, offset: opts.offset ?? 0 }
  if (!actor.isAdmin) where.push(VISIBLE_SQL)
  if (opts.projectId) {
    where.push('p.project_id = @projectId')
    params.projectId = opts.projectId
  }
  const status = opts.status ?? 'all'
  if (status === 'open') where.push(`EXISTS (SELECT 1 FROM mentions ms WHERE ms.post_id = p.id AND ms.status IN ('pending','in_progress'))`)
  else if (status !== 'all') {
    where.push(`EXISTS (SELECT 1 FROM mentions ms WHERE ms.post_id = p.id AND ms.status = @status)`)
    params.status = status
  }
  const sql = `${SUMMARY_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY p.id DESC LIMIT @limit OFFSET @offset`
  return attachSummaries(db, db.prepare(sql).all(params) as (Post & Record<string, unknown>)[])
}

export function getPostSummary(db: DB, id: number): PostSummary | undefined {
  const rows = db.prepare(`${SUMMARY_SELECT} WHERE p.id = ?`).all(id) as (Post & Record<string, unknown>)[]
  return attachSummaries(db, rows)[0]
}

// ---------- 写入 ----------
export interface CreatePostInput {
  project: Project
  title: string
  body: string
  mentions: string[]
}

/**
 * @all → 版块里所有能被 @ 的人（git 项目：登录过的所有人；手动项目：已加入的成员），排除发帖人自己，各自落到默认 agent。
 * 其余输入原样保留，之后仍走 resolveMentionTargets。
 */
export function expandAll(db: DB, actor: Actor, project: Project, inputs: string[]): string[] {
  // all → 每人默认 agent；all/all（或 all/@all）→ 每人的每个 agent
  const isAll = (s: string) => /^@?all$/i.test(s.trim())
  const isAllAll = (s: string) => /^@?all\/@?all$/i.test(s.trim())
  if (!inputs.some((s) => isAll(s) || isAllAll(s))) return inputs
  const upns =
    project.kind === 'manual'
      ? (db.prepare(`SELECT user_upn AS upn FROM project_members WHERE project_id = ? AND status = 'joined'`).all(project.id) as { upn: string }[]).map((r) => r.upn)
      : // git 项目谁都能被 @，但 @all 不该把所有接入的平台（服务账号）都拉上；要 @ 平台就指名
        (db.prepare('SELECT upn FROM users WHERE is_service = 0').all() as { upn: string }[]).map((r) => r.upn)
  const everyone = upns.filter((u) => u !== actor.user.upn)
  if (everyone.length === 0) throw badRequest('@all 没有可 @ 的人（版块里除了你没有别人）')
  const expanded: string[] = []
  if (inputs.some(isAll)) expanded.push(...everyone)
  if (inputs.some(isAllAll)) expanded.push(...everyone.map((u) => `${u}/all`))
  return [...inputs.filter((s) => !isAll(s) && !isAllAll(s)), ...expanded]
}

export function createPost(db: DB, actor: Actor, input: CreatePostInput): { post: Post; mentions: Mention[] } {
  const title = input.title.trim()
  if (!title) throw badRequest('标题不能为空')
  if (title.length > 200) throw badRequest('标题过长')
  const targets = resolveMentionTargets(db, expandAll(db, actor, input.project, input.mentions))
  if (targets.length === 0) throw badRequest('至少要 @ 一个人')
  // 手动项目：发帖人和被 @ 的人都必须是成员
  requireMembership(db, actor, input.project)
  requireTargetsAreMembers(db, input.project, targets.map((t) => t.user))
  const result = db.transaction(() => {
    const r = db
      .prepare('INSERT INTO posts(project_id, author_upn, source_project_id, title, body) VALUES (?,?,?,?,?)')
      .run(input.project.id, actor.user.upn, actor.project?.id ?? null, title, input.body ?? '')
    const post = getPost(db, Number(r.lastInsertRowid))!
    const mentions: Mention[] = []
    for (const t of targets) {
      const mr = db.prepare('INSERT INTO mentions(post_id, target_upn, target_agent_id) VALUES (?,?,?)').run(post.id, t.user.upn, t.agent?.id ?? null)
      const m = getMention(db, Number(mr.lastInsertRowid))!
      mentions.push(m)
      emit(db, { post_id: post.id, mention_id: m.id, reply_id: null, type: 'mentioned', actor_upn: actor.user.upn, target_upn: t.user.upn })
    }
    return { post, mentions }
  })()
  return result
}

/** 给已有帖子追加 @（作者或超管） */
export function addMentions(db: DB, actor: Actor, postId: number, inputs: string[]): Mention[] {
  const post = requireVisiblePost(db, actor, postId)
  if (post.author_upn !== actor.user.upn && !actor.isAdmin) throw forbidden('只有发帖人可以追加 @')
  const project = getProject(db, post.project_id)!
  const targets = resolveMentionTargets(db, expandAll(db, actor, project, inputs))
  requireTargetsAreMembers(db, project, targets.map((t) => t.user))
  return db.transaction(() => {
    const out: Mention[] = []
    for (const t of targets) {
      const agentId = t.agent?.id ?? null
      const exists = db.prepare('SELECT * FROM mentions WHERE post_id = ? AND target_upn = ? AND COALESCE(target_agent_id, 0) = COALESCE(?, 0)').get(post.id, t.user.upn, agentId) as Mention | undefined
      if (exists) {
        out.push(exists)
        continue
      }
      const mr = db.prepare('INSERT INTO mentions(post_id, target_upn, target_agent_id) VALUES (?,?,?)').run(post.id, t.user.upn, agentId)
      const m = getMention(db, Number(mr.lastInsertRowid))!
      out.push(m)
      emit(db, { post_id: post.id, mention_id: m.id, reply_id: null, type: 'mentioned', actor_upn: actor.user.upn, target_upn: t.user.upn })
    }
    db.prepare('UPDATE posts SET updated_at = ? WHERE id = ?').run(now(), post.id)
    return out
  })()
}

export function addReply(db: DB, actor: Actor, postId: number, body: string): Reply {
  const post = requireVisiblePost(db, actor, postId)
  const text = body.trim()
  if (!text) throw badRequest('回复内容不能为空')
  return db.transaction(() => {
    const r = db
      .prepare('INSERT INTO replies(post_id, author_upn, source_project_id, body) VALUES (?,?,?,?)')
      .run(post.id, actor.user.upn, actor.project?.id ?? null, text)
    const reply = db.prepare('SELECT * FROM replies WHERE id = ?').get(r.lastInsertRowid) as Reply
    db.prepare('UPDATE posts SET updated_at = ? WHERE id = ?').run(now(), post.id)
    emit(db, { post_id: post.id, mention_id: null, reply_id: reply.id, type: 'replied', actor_upn: actor.user.upn, target_upn: null })
    return reply
  })()
}

function requireMention(db: DB, actor: Actor, mentionId: number): { mention: Mention; post: Post } {
  const mention = getMention(db, mentionId)
  if (!mention) throw notFound('任务不存在')
  const post = requireVisiblePost(db, actor, mention.post_id)
  return { mention, post }
}

function setStatus(db: DB, mentionId: number, status: MentionStatus, extra: Partial<Mention> = {}) {
  db.prepare('UPDATE mentions SET status = ?, claimed_at = COALESCE(?, claimed_at), done_at = COALESCE(?, done_at), note = COALESCE(?, note), updated_at = ? WHERE id = ?').run(
    status,
    extra.claimed_at ?? null,
    extra.done_at ?? null,
    extra.note ?? null,
    now(),
    mentionId,
  )
}

/** 被 @ 的人声明"我开始做了" */
export function claimMention(db: DB, actor: Actor, mentionId: number): Mention {
  const { mention, post } = requireMention(db, actor, mentionId)
  if (mention.target_upn !== actor.user.upn && !actor.isAdmin) throw forbidden('只有被 @ 的人可以认领')
  if (mention.status === 'in_progress') return mention
  if (mention.status !== 'pending') throw badRequest(`任务当前状态为 ${mention.status}，不能认领`)
  return db.transaction(() => {
    setStatus(db, mention.id, 'in_progress', { claimed_at: now() })
    db.prepare('UPDATE posts SET updated_at = ? WHERE id = ?').run(now(), post.id)
    emit(db, { post_id: post.id, mention_id: mention.id, reply_id: null, type: 'claimed', actor_upn: actor.user.upn, target_upn: post.author_upn })
    return getMention(db, mention.id)!
  })()
}

/** 标记完成：被 @ 的人、发帖人、超管都可以。note 会自动作为回帖发出。 */
export function markDone(db: DB, actor: Actor, mentionId: number, note?: string): Mention {
  const { mention, post } = requireMention(db, actor, mentionId)
  const allowed = mention.target_upn === actor.user.upn || post.author_upn === actor.user.upn || actor.isAdmin
  if (!allowed) throw forbidden('只有被 @ 的人或发帖人可以标记完成')
  if (mention.status === 'done') return mention
  if (mention.status === 'disabled') throw badRequest('任务已被禁用')
  return db.transaction(() => {
    setStatus(db, mention.id, 'done', { done_at: now(), note: note?.trim() || null })
    let replyId: number | null = null
    if (note && note.trim()) {
      const r = db
        .prepare('INSERT INTO replies(post_id, author_upn, source_project_id, body) VALUES (?,?,?,?)')
        .run(post.id, actor.user.upn, actor.project?.id ?? null, `✅ 已完成：\n\n${note.trim()}`)
      replyId = Number(r.lastInsertRowid)
    }
    db.prepare('UPDATE posts SET updated_at = ? WHERE id = ?').run(now(), post.id)
    emit(db, { post_id: post.id, mention_id: mention.id, reply_id: replyId, type: 'done', actor_upn: actor.user.upn, target_upn: post.author_upn })
    return getMention(db, mention.id)!
  })()
}

/** 禁用：发帖人或超管。该 @ 作废，从对方 inbox 消失。 */
export function disableMention(db: DB, actor: Actor, mentionId: number, reason?: string): Mention {
  const { mention, post } = requireMention(db, actor, mentionId)
  if (post.author_upn !== actor.user.upn && !actor.isAdmin) throw forbidden('只有发帖人可以禁用')
  if (mention.status === 'disabled') return mention
  return db.transaction(() => {
    setStatus(db, mention.id, 'disabled', { note: reason?.trim() || null })
    db.prepare('UPDATE posts SET updated_at = ? WHERE id = ?').run(now(), post.id)
    emit(db, { post_id: post.id, mention_id: mention.id, reply_id: null, type: 'disabled', actor_upn: actor.user.upn, target_upn: mention.target_upn })
    return getMention(db, mention.id)!
  })()
}

/** 重新打开（发帖人/超管）：done/disabled → pending */
export function reopenMention(db: DB, actor: Actor, mentionId: number): Mention {
  const { mention, post } = requireMention(db, actor, mentionId)
  if (post.author_upn !== actor.user.upn && !actor.isAdmin) throw forbidden('只有发帖人可以重开')
  if (mention.status === 'pending') return mention
  db.prepare('UPDATE mentions SET status = ?, claimed_at = NULL, done_at = NULL, updated_at = ? WHERE id = ?').run('pending', now(), mention.id)
  emit(db, { post_id: post.id, mention_id: mention.id, reply_id: null, type: 'mentioned', actor_upn: actor.user.upn, target_upn: mention.target_upn })
  return getMention(db, mention.id)!
}

export function recordAttachment(
  db: DB,
  actor: Actor,
  a: { post_id: number; reply_id: number | null; filename: string; size: number; mime: string; sha256: string; object_key: string },
): Attachment {
  const post = requireVisiblePost(db, actor, a.post_id)
  return db.transaction(() => {
    const r = db
      .prepare('INSERT INTO attachments(post_id, reply_id, uploader_upn, filename, size, mime, sha256, object_key) VALUES (?,?,?,?,?,?,?,?)')
      .run(a.post_id, a.reply_id, actor.user.upn, a.filename, a.size, a.mime, a.sha256, a.object_key)
    db.prepare('UPDATE posts SET updated_at = ? WHERE id = ?').run(now(), post.id)
    const att = getAttachment(db, Number(r.lastInsertRowid))!
    emit(db, { post_id: post.id, mention_id: null, reply_id: a.reply_id, type: 'attached', actor_upn: actor.user.upn, target_upn: null })
    return att
  })()
}

// ---------- 收件箱 ----------
export interface InboxTask {
  mention_id: number
  status: MentionStatus
  post: PostSummary
}
export interface InboxUpdate {
  event_id: number
  type: EventType
  actor_upn: string
  actor_name: string
  created_at: string
  post_id: number
  post_title: string
  reply_body: string | null
  mention_target: string | null
}
export interface Inbox {
  project: { slug: string; name: string } | null
  tasks: InboxTask[]
  updates: InboxUpdate[]
  cursor: number
}

/**
 * tasks：@我的、落在当前项目版块的任务（status 过滤）。
 *   token 连接还按 agent 过滤：指名给这个 agent 的 + （我是默认 agent 时）没指名的；人类会话看自己所有 agent 的。
 * updates：别人对"我发的（来源=当前项目）或 @我的（版块=当前项目）"帖子做的动作，since 之后的。
 * 没有绑定项目（人类会话 / 无 X-Project 的 token）时跨所有项目。
 */
export function getInbox(db: DB, actor: Actor, opts: { status?: 'pending' | 'open' | 'all'; since?: number; limit?: number } = {}): Inbox {
  const status = opts.status ?? 'open'
  const projectId = actor.project?.id ?? null
  const agent = actor.agent ?? null
  const params: Record<string, unknown> = { upn: actor.user.upn, projectId, since: opts.since ?? 0, limit: opts.limit ?? 50, agentId: agent?.id ?? null, agentIsDefault: agent?.is_default ? 1 : 0 }
  const statusSql = status === 'pending' ? `m.status = 'pending'` : status === 'open' ? `m.status IN ('pending','in_progress')` : '1=1'
  const agentSql = `(@agentId IS NULL OR m.target_agent_id = @agentId OR (m.target_agent_id IS NULL AND @agentIsDefault = 1))`
  const taskRows = db
    .prepare(
      `SELECT m.id AS mention_id, m.status, m.post_id FROM mentions m JOIN posts p ON p.id = m.post_id
       WHERE m.target_upn = @upn AND ${statusSql} AND (@projectId IS NULL OR p.project_id = @projectId) AND ${agentSql}
       ORDER BY m.id DESC LIMIT @limit`,
    )
    .all(params) as { mention_id: number; status: MentionStatus; post_id: number }[]
  const tasks: InboxTask[] = taskRows.map((t) => ({ mention_id: t.mention_id, status: t.status, post: getPostSummary(db, t.post_id)! }))

  const updateRows = db
    .prepare(
      `SELECT e.id AS event_id, e.type, e.actor_upn, au.display_name AS actor_name, e.created_at, e.post_id, p.title AS post_title,
              r.body AS reply_body, e.target_upn AS mention_target
       FROM events e JOIN posts p ON p.id = e.post_id JOIN users au ON au.upn = e.actor_upn LEFT JOIN replies r ON r.id = e.reply_id
       WHERE e.id > @since AND e.actor_upn != @upn
         AND (
           (p.author_upn = @upn AND (@projectId IS NULL OR p.source_project_id = @projectId OR p.project_id = @projectId))
           OR (e.type != 'mentioned' AND EXISTS (SELECT 1 FROM mentions mm WHERE mm.post_id = p.id AND mm.target_upn = @upn)
               AND (@projectId IS NULL OR p.project_id = @projectId))
         )
       ORDER BY e.id DESC LIMIT @limit`,
    )
    .all(params) as InboxUpdate[]
  const maxEvent = (db.prepare('SELECT COALESCE(MAX(id),0) AS m FROM events').get() as { m: number }).m
  return {
    project: actor.project ? { slug: actor.project.slug, name: actor.project.name } : null,
    tasks,
    updates: updateRows,
    cursor: maxEvent,
  }
}

export function displayUser(u: Pick<User, 'upn' | 'display_name'>): string {
  return `${u.display_name} (@${u.upn.split('@')[0]})`
}
