/**
 * REST 与 MCP 共用的业务门面：入参已校验的普通对象 → 可直接 JSON 化的结果。
 */
import type { DB } from '../db/index.js'
import type { Actor, MentionStatus } from './types.js'
import * as posts from './posts.js'
import { findProject, listProjects, listProjectsForUser, getProject } from './projects.js'
import { listUsers, localPart } from './users.js'
import { listMembers } from './members.js'
import { badRequest, forbidden } from './errors.js'
import { config } from '../config.js'
import { makeObjectKey, storageEnabled, putObject, sha256 } from '../storage/index.js'
import { auditContent } from '../audit/index.js'
import { listAgents, mentionHandle } from './agents.js'

export function whoami(db: DB, actor: Actor) {
  return {
    user: { upn: actor.user.upn, handle: localPart(actor.user.upn), display_name: actor.user.display_name, is_admin: actor.isAdmin },
    project: actor.project ? { slug: actor.project.slug, name: actor.project.name, url: actor.project.raw_url } : null,
    agent: actor.agent ? { id: actor.agent.agent_id, name: actor.agent.name, is_default: !!actor.agent.is_default, mention: `@${mentionHandle(actor.user.upn, actor.agent.is_default ? null : actor.agent.agent_id)}` } : null,
    agents: listAgents(db, actor.user.upn).map((a) => ({ id: a.agent_id, name: a.name, is_default: !!a.is_default })),
    hint: actor.project ? undefined : '当前连接没有绑定项目（缺少 X-Project header），写操作会被拒绝。',
  }
}

export function projectsView(db: DB, actor: Actor, all = false) {
  const list = all || actor.isAdmin ? listProjects(db) : listProjectsForUser(db, actor.user.upn, false)
  const merged = new Map(list.map((p) => [p.id, p]))
  // git 项目：谁最近用 token 在这个项目上活跃过；手动项目：已加入的成员
  const who = db.prepare(`SELECT t.last_project_id AS pid, u.upn, u.display_name FROM tokens t JOIN users u ON u.upn = t.user_upn WHERE t.revoked_at IS NULL AND t.last_project_id IS NOT NULL`).all() as {
    pid: number
    upn: string
    display_name: string
  }[]
  return [...merged.values()].map((p) => ({
    slug: p.slug,
    name: p.name,
    kind: p.kind,
    url: p.kind === 'git' ? p.raw_url : undefined,
    x_project: p.kind === 'git' ? p.raw_url : p.slug,
    description: p.description ?? undefined,
    members:
      p.kind === 'manual'
        ? listMembers(db, p.id).filter((m) => m.status === 'joined').map((m) => `${m.display_name} (@${localPart(m.user_upn)})`)
        : who.filter((w) => w.pid === p.id).map((w) => `${w.display_name} (@${localPart(w.upn)})`),
    note: p.kind === 'manual' ? '手动项目：只有成员能发帖/被 @；接入用 X-Project: ' + p.slug : undefined,
  }))
}

export function usersView(db: DB) {
  const agents = db.prepare('SELECT user_upn, agent_id, name, is_default FROM agents ORDER BY is_default DESC, agent_id').all() as { user_upn: string; agent_id: string; name: string; is_default: number }[]
  return listUsers(db).map((u) => {
    const mine = agents.filter((a) => a.user_upn === u.upn)
    return {
      handle: localPart(u.upn),
      upn: u.upn,
      display_name: u.display_name,
      department: u.department,
      // 其他平台以服务账号身份接入的用户
      is_service: u.is_service ? true : undefined,
      // 只有多个 agent 才值得列：@handle 给默认的，@handle/<id> 指名
      agents: mine.length > 1 ? mine.map((a) => ({ id: a.agent_id, name: a.name, is_default: !!a.is_default, mention: a.is_default ? `@${localPart(u.upn)}` : `@${localPart(u.upn)}/${a.agent_id}` })) : undefined,
    }
  })
}

function getAgentIdStr(db: DB, id: number): string | null {
  return (db.prepare('SELECT agent_id FROM agents WHERE id = ?').get(id) as { agent_id: string } | undefined)?.agent_id ?? null
}

function requireProject(actor: Actor) {
  if (!actor.project) throw forbidden('此操作需要绑定项目：MCP/REST 请求要带 X-Project header（git remote origin url）')
  return actor.project
}

export interface CreatePostArgs {
  title: string
  body: string
  mentions: string[]
  /** 目标项目：git url / slug / 项目名。省略 = 发到当前项目版块 */
  project?: string
}

export async function createPost(db: DB, actor: Actor, args: CreatePostArgs) {
  if (actor.via === 'token') requireProject(actor)
  const target = args.project ? findProject(db, args.project) : actor.project
  if (!target) throw badRequest('需要指定目标项目')
  await auditContent(db, actor, { kind: 'post', title: args.title, body: args.body, projectSlug: target.slug })
  const { post, mentions } = posts.createPost(db, actor, { project: target, title: args.title, body: args.body, mentions: args.mentions })
  return { post_id: post.id, url: `${config.baseUrl}/posts/${post.id}`, project: target.slug, mentions: mentions.map((m) => ({ mention_id: m.id, target: mentionHandle(m.target_upn, m.target_agent_id ? getAgentIdStr(db, m.target_agent_id) : null), status: m.status })) }
}

const LIST_STATUSES = ['all', 'open', 'pending', 'in_progress', 'done', 'disabled'] as const

/** 版块帖子列表（新的在前）。project 省略 = 当前连接的项目（X-Project）；都没有 = 我能看到的全部帖子 */
export function listPosts(db: DB, actor: Actor, args: { project?: string; status?: string; limit?: number; offset?: number }) {
  const status = (args.status ?? 'all') as (typeof LIST_STATUSES)[number]
  if (!LIST_STATUSES.includes(status)) throw badRequest(`status 只能是 ${LIST_STATUSES.join(' / ')}`)
  const limit = args.limit ?? 50
  const offset = args.offset ?? 0
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw badRequest('limit 取 1-100')
  if (!Number.isInteger(offset) || offset < 0) throw badRequest('offset 不能为负')
  const project = args.project ? findProject(db, args.project) : actor.project
  // 多取一条判断还有没有下一页
  const rows = posts.listPosts(db, actor, { projectId: project?.id, status, limit: limit + 1, offset })
  return {
    project: project?.slug ?? null,
    status,
    limit,
    offset,
    has_more: rows.length > limit,
    posts: rows.slice(0, limit).map((p) => ({
      id: p.id,
      url: `${config.baseUrl}/posts/${p.id}`,
      title: p.title,
      project: p.project_slug,
      source_project: p.source_project_slug,
      author: { handle: localPart(p.author_upn), display_name: p.author_name },
      created_at: p.created_at,
      updated_at: p.updated_at,
      reply_count: p.reply_count,
      body_preview: p.body.slice(0, 300),
      mentions: p.mentions.map((m) => ({ mention_id: m.id, target: mentionHandle(m.target_upn, m.target_agent), target_name: m.target_name, status: m.status })),
    })),
  }
}

export function postDetail(db: DB, actor: Actor, id: number) {
  const post = posts.requireVisiblePost(db, actor, id)
  const summary = posts.getPostSummary(db, post.id)!
  const replies = posts.listReplies(db, post.id)
  const attachments = posts.listAttachments(db, post.id)
  const users = new Map(listUsers(db).map((u) => [u.upn, u]))
  const name = (upn: string) => users.get(upn)?.display_name ?? upn
  const projectSlug = (pid: number | null) => (pid ? getProject(db, pid)?.slug ?? null : null)
  return {
    id: post.id,
    url: `${config.baseUrl}/posts/${post.id}`,
    title: post.title,
    body: post.body,
    project: summary.project_slug,
    source_project: summary.source_project_slug,
    author: { handle: localPart(post.author_upn), display_name: name(post.author_upn) },
    created_at: post.created_at,
    updated_at: post.updated_at,
    mentions: summary.mentions.map((m) => {
      const full = posts.getMention(db, m.id)!
      return { mention_id: m.id, target: mentionHandle(m.target_upn, m.target_agent), target_handle: localPart(m.target_upn), target_agent: m.target_agent, target_name: m.target_name, status: m.status, note: full.note, claimed_at: full.claimed_at, done_at: full.done_at }
    }),
    replies: replies.map((r) => ({ id: r.id, author: localPart(r.author_upn), author_name: name(r.author_upn), source_project: projectSlug(r.source_project_id), body: r.body, created_at: r.created_at })),
    attachments: attachments.map((a) => ({ id: a.id, filename: a.filename, size: a.size, mime: a.mime, reply_id: a.reply_id, uploader: localPart(a.uploader_upn), url: `${config.baseUrl}/api/v1/attachments/${a.id}`, created_at: a.created_at })),
  }
}

export function inbox(db: DB, actor: Actor, opts: { status?: 'pending' | 'open' | 'all'; since?: number; limit?: number }) {
  const box = posts.getInbox(db, actor, opts)
  return {
    project: box.project,
    cursor: box.cursor,
    tasks: box.tasks.map((t) => ({
      mention_id: t.mention_id,
      status: t.status,
      post_id: t.post.id,
      url: `${config.baseUrl}/posts/${t.post.id}`,
      title: t.post.title,
      from: `${t.post.author_name} (@${localPart(t.post.author_upn)})`,
      source_project: t.post.source_project_slug,
      created_at: t.post.created_at,
      body_preview: t.post.body.slice(0, 300),
      reply_count: t.post.reply_count,
    })),
    updates: box.updates.map((u) => ({
      event_id: u.event_id,
      type: u.type,
      post_id: u.post_id,
      url: `${config.baseUrl}/posts/${u.post_id}`,
      title: u.post_title,
      by: `${u.actor_name} (@${localPart(u.actor_upn)})`,
      at: u.created_at,
      reply: u.reply_body ? u.reply_body.slice(0, 500) : undefined,
    })),
  }
}

export async function reply(db: DB, actor: Actor, postId: number, body: string) {
  const post = posts.requireVisiblePost(db, actor, postId)
  await auditContent(db, actor, { kind: 'reply', body, projectSlug: post.project_id ? getProject(db, post.project_id)?.slug : null })
  const r = posts.addReply(db, actor, postId, body)
  return { reply_id: r.id, post_id: r.post_id, created_at: r.created_at }
}

export function claim(db: DB, actor: Actor, mentionId: number) {
  const m = posts.claimMention(db, actor, mentionId)
  return mentionView(m.id, m.status)
}
export function done(db: DB, actor: Actor, mentionId: number, note?: string) {
  const m = posts.markDone(db, actor, mentionId, note)
  return mentionView(m.id, m.status)
}
export function disable(db: DB, actor: Actor, mentionId: number, reason?: string) {
  const m = posts.disableMention(db, actor, mentionId, reason)
  return mentionView(m.id, m.status)
}
export function reopen(db: DB, actor: Actor, mentionId: number) {
  const m = posts.reopenMention(db, actor, mentionId)
  return mentionView(m.id, m.status)
}
function mentionView(id: number, status: MentionStatus) {
  return { mention_id: id, status }
}

export function addMentions(db: DB, actor: Actor, postId: number, mentions: string[]) {
  return posts.addMentions(db, actor, postId, mentions).map((m) => ({ mention_id: m.id, target: mentionHandle(m.target_upn, m.target_agent_id ? getAgentIdStr(db, m.target_agent_id) : null), status: m.status }))
}

export async function uploadAttachment(
  db: DB,
  actor: Actor,
  args: { post_id: number; reply_id?: number | null; filename: string; mime?: string; data: Buffer; maxBytes?: number },
) {
  if (!storageEnabled()) throw badRequest('附件存储未配置（MINIO_ACCESS_KEY / MINIO_SECRET_KEY，或设 ATTACHMENT_STORAGE=local）')
  const max = args.maxBytes ?? config.attachmentMaxBytes
  if (args.data.length === 0) throw badRequest('文件为空')
  if (args.data.length > max) throw badRequest(`文件超过上限 ${(max / 1024 / 1024).toFixed(0)}MB`)
  posts.requireVisiblePost(db, actor, args.post_id)
  const filename = args.filename.trim() || 'file'
  const mime = args.mime?.trim() || 'application/octet-stream'
  const key = makeObjectKey(args.post_id, filename)
  await putObject(key, args.data, mime)
  const att = posts.recordAttachment(db, actor, { post_id: args.post_id, reply_id: args.reply_id ?? null, filename, size: args.data.length, mime, sha256: sha256(args.data), object_key: key })
  return { attachment_id: att.id, filename: att.filename, size: att.size, url: `${config.baseUrl}/api/v1/attachments/${att.id}` }
}

export function attachmentForDownload(db: DB, actor: Actor, id: number) {
  const att = posts.getAttachment(db, id)
  if (!att) throw badRequest('附件不存在')
  posts.requireVisiblePost(db, actor, att.post_id)
  return att
}

export const TEXT_MIME = /^(text\/|application\/(json|xml|x-yaml|yaml|javascript|x-sh|x-patch|x-diff))/
export function looksText(filename: string, mime: string): boolean {
  return TEXT_MIME.test(mime) || /\.(md|txt|patch|diff|log|json|ya?ml|ts|js|tsx|jsx|py|go|java|kt|rs|c|h|cpp|cs|sh|sql|xml|html|css|csv|toml|ini|env|cfg|conf)$/i.test(filename)
}
