/**
 * REST 与 MCP 共用的业务门面：入参已校验的普通对象 → 可直接 JSON 化的结果。
 */
import type { DB } from '../db/index.js'
import type { Actor, MentionStatus } from './types.js'
import * as posts from './posts.js'
import { findProject, listProjects, listProjectsForUser, getProject } from './projects.js'
import { listUsers, localPart } from './users.js'
import { badRequest, forbidden } from './errors.js'
import { config } from '../config.js'
import { makeObjectKey, minioEnabled, putObject, sha256 } from '../storage/minio.js'

export function whoami(db: DB, actor: Actor) {
  return {
    user: { upn: actor.user.upn, handle: localPart(actor.user.upn), display_name: actor.user.display_name, is_admin: actor.isAdmin },
    project: actor.project ? { slug: actor.project.slug, name: actor.project.name, url: actor.project.raw_url } : null,
    hint: actor.project ? undefined : '当前连接没有绑定项目（缺少 X-Project header），写操作会被拒绝。',
  }
}

export function projectsView(db: DB, actor: Actor, all = false) {
  const list = all || actor.isAdmin ? listProjects(db) : listProjectsForUser(db, actor.user.upn, false)
  const merged = new Map(list.map((p) => [p.id, p]))
  // 谁在这个项目上活跃（最近用 token 访问过）
  const who = db.prepare(`SELECT t.last_project_id AS pid, u.upn, u.display_name FROM tokens t JOIN users u ON u.upn = t.user_upn WHERE t.revoked_at IS NULL AND t.last_project_id IS NOT NULL`).all() as {
    pid: number
    upn: string
    display_name: string
  }[]
  return [...merged.values()].map((p) => ({
    slug: p.slug,
    name: p.name,
    url: p.raw_url,
    members: who.filter((w) => w.pid === p.id).map((w) => `${w.display_name} (@${localPart(w.upn)})`),
  }))
}

export function usersView(db: DB) {
  return listUsers(db).map((u) => ({ handle: localPart(u.upn), upn: u.upn, display_name: u.display_name, department: u.department }))
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

export function createPost(db: DB, actor: Actor, args: CreatePostArgs) {
  if (actor.via === 'token') requireProject(actor)
  const target = args.project ? findProject(db, args.project) : actor.project
  if (!target) throw badRequest('需要指定目标项目')
  const { post, mentions } = posts.createPost(db, actor, { project: target, title: args.title, body: args.body, mentions: args.mentions })
  return { post_id: post.id, url: `${config.baseUrl}/posts/${post.id}`, project: target.slug, mentions: mentions.map((m) => ({ mention_id: m.id, target: localPart(m.target_upn), status: m.status })) }
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
      return { mention_id: m.id, target: localPart(m.target_upn), target_name: m.target_name, status: m.status, note: full.note, claimed_at: full.claimed_at, done_at: full.done_at }
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

export function reply(db: DB, actor: Actor, postId: number, body: string) {
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
  return posts.addMentions(db, actor, postId, mentions).map((m) => ({ mention_id: m.id, target: localPart(m.target_upn), status: m.status }))
}

export async function uploadAttachment(
  db: DB,
  actor: Actor,
  args: { post_id: number; reply_id?: number | null; filename: string; mime?: string; data: Buffer; maxBytes?: number },
) {
  if (!minioEnabled()) throw badRequest('附件存储未配置（MINIO_ACCESS_KEY / MINIO_SECRET_KEY）')
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
