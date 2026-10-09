import crypto from 'node:crypto'
import type { DB } from '../db/index.js'
import type { Actor, Project } from './types.js'
import { normalizeGitUrl, normalizeManualKey, projectNameFromSlug, keyFromName, MANUAL_PREFIX } from './git-url.js'
import { badRequest, forbidden } from './errors.js'

export function getProject(db: DB, id: number): Project | undefined {
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Project | undefined
}

export function getProjectBySlug(db: DB, slug: string): Project | undefined {
  return db.prepare('SELECT * FROM projects WHERE slug = ?').get(slug) as Project | undefined
}

/** git 项目：按 url 找，不存在则自动注册。手动项目（bbs:key）必须已存在。 */
export function ensureProject(db: DB, rawUrl: string): Project {
  const manual = normalizeManualKey(rawUrl)
  if (manual) {
    const p = getProjectBySlug(db, manual)
    if (!p) throw badRequest(`手动项目 ${manual} 不存在`)
    return p
  }
  const slug = normalizeGitUrl(rawUrl)
  if (!slug) throw badRequest(`无法识别的项目标识: ${rawUrl}（git url 或 bbs:<key>）`)
  const existing = getProjectBySlug(db, slug)
  if (existing) return existing
  db.prepare("INSERT INTO projects(slug, raw_url, name, kind) VALUES (?,?,?,'git')").run(slug, rawUrl.trim(), projectNameFromSlug(slug))
  return getProjectBySlug(db, slug)!
}

/** 在网页上新建手动项目，创建者自动成为 owner 成员 */
export function createManualProject(db: DB, actor: Actor, input: { name: string; description?: string; key?: string }): Project {
  const name = input.name.trim()
  if (!name) throw badRequest('项目名不能为空')
  if (name.length > 60) throw badRequest('项目名过长')
  let slug: string
  if (input.key?.trim()) {
    // 用户自定义 key：必须合法且未被占用
    const k = normalizeManualKey(MANUAL_PREFIX + input.key.trim())
    if (!k) throw badRequest('key 只能用小写字母、数字、. _ -，且以字母或数字开头，最长 64')
    if (getProjectBySlug(db, k)) throw badRequest(`key ${k} 已被占用`)
    slug = k
  } else {
    const key = keyFromName(name, () => crypto.randomBytes(4).toString('hex'))
    slug = MANUAL_PREFIX + key
    for (let i = 2; getProjectBySlug(db, slug); i++) slug = `${MANUAL_PREFIX}${key}-${i}`
  }
  return db.transaction(() => {
    const r = db
      .prepare("INSERT INTO projects(slug, raw_url, name, kind, description, owner_upn) VALUES (?,?,?,'manual',?,?)")
      .run(slug, slug, name, input.description?.trim() || null, actor.user.upn)
    const id = Number(r.lastInsertRowid)
    db.prepare("INSERT INTO project_members(project_id, user_upn, role, status, joined_at) VALUES (?,?,'owner','joined',strftime('%Y-%m-%dT%H:%M:%SZ','now'))").run(id, actor.user.upn)
    return getProject(db, id)!
  })()
}

export function updateManualProject(db: DB, actor: Actor, projectId: number, input: { name?: string; description?: string }): Project {
  const p = getProject(db, projectId)
  if (!p || p.kind !== 'manual') throw badRequest('项目不存在')
  if (p.owner_upn !== actor.user.upn && !actor.isAdmin) throw forbidden('只有创建者可以修改项目')
  const name = input.name?.trim() || p.name
  db.prepare('UPDATE projects SET name = ?, description = ? WHERE id = ?').run(name, input.description?.trim() || null, p.id)
  return getProject(db, p.id)!
}

/** 按 url / bbs:key / slug / 名字 找项目（只读，不注册）。名字模糊时列出候选。 */
export function findProject(db: DB, query: string): Project {
  const q = query.trim()
  const slug = normalizeManualKey(q) ?? normalizeGitUrl(q)
  if (slug) {
    const p = getProjectBySlug(db, slug)
    if (p) return p
  }
  const byName = db.prepare('SELECT * FROM projects WHERE name = ? COLLATE NOCASE').all(q) as Project[]
  if (byName.length === 1) return byName[0]
  if (byName.length > 1) throw badRequest(`项目名 "${q}" 有多个匹配，请用完整标识：${byName.map((p) => p.slug).join(' / ')}`)
  const like = db.prepare('SELECT * FROM projects WHERE slug LIKE ? LIMIT 5').all(`%${q.toLowerCase()}%`) as Project[]
  if (like.length === 1) return like[0]
  if (like.length > 1) throw badRequest(`项目 "${q}" 有多个匹配：${like.map((p) => p.slug).join(' / ')}`)
  throw badRequest(`项目 "${q}" 不存在。git 项目需要对方先在该项目里接入过 BBS；手动项目需要先在网页上创建（用 bbs_list_projects 查看已注册项目）`)
}

export function listProjects(db: DB): Project[] {
  return db.prepare('SELECT * FROM projects ORDER BY kind, name').all() as Project[]
}

/** 某人参与过的项目（发过帖、被 @ 过、作为来源项目、用 token 访问过、是成员） */
export function listProjectsForUser(db: DB, upn: string, admin: boolean): Project[] {
  if (admin) return listProjects(db)
  return db
    .prepare(
      `SELECT DISTINCT p.* FROM projects p
       WHERE p.id IN (SELECT project_id FROM posts WHERE author_upn = @upn)
          OR p.id IN (SELECT source_project_id FROM posts WHERE author_upn = @upn AND source_project_id IS NOT NULL)
          OR p.id IN (SELECT po.project_id FROM mentions m JOIN posts po ON po.id = m.post_id WHERE m.target_upn = @upn)
          OR p.id IN (SELECT last_project_id FROM tokens WHERE user_upn = @upn AND last_project_id IS NOT NULL)
          OR p.id IN (SELECT project_id FROM project_members WHERE user_upn = @upn AND status = 'joined')
       ORDER BY p.kind, p.name`,
    )
    .all({ upn }) as Project[]
}

/**
 * 超管删版块：连同帖子、@、回帖、附件记录、动态、成员/邀请一起删。
 * 别的版块里引用它作来源项目的帖子/回帖、token 的 last_project_id 置空。
 * content_audits 只存 slug 文本，不动（留证）。返回附件的 object_key，由调用方删存储里的对象。
 * git 项目删掉后，有人再以它的 url 连接会重新注册成一个空版块。
 */
export function deleteProject(db: DB, actor: Actor, projectId: number): { project: Project; posts: number; objectKeys: string[] } {
  if (!actor.isAdmin) throw forbidden('只有超管能删除版块')
  const p = getProject(db, projectId)
  if (!p) throw badRequest('项目不存在')
  return db.transaction(() => {
    const inPosts = 'SELECT id FROM posts WHERE project_id = @id'
    const objectKeys = (db.prepare(`SELECT object_key FROM attachments WHERE post_id IN (${inPosts})`).all({ id: p.id }) as { object_key: string }[]).map((r) => r.object_key)
    const postCount = (db.prepare('SELECT COUNT(*) AS n FROM posts WHERE project_id = ?').get(p.id) as { n: number }).n
    db.prepare(`DELETE FROM events WHERE post_id IN (${inPosts})`).run({ id: p.id })
    db.prepare(`DELETE FROM attachments WHERE post_id IN (${inPosts})`).run({ id: p.id })
    db.prepare(`DELETE FROM mentions WHERE post_id IN (${inPosts})`).run({ id: p.id })
    db.prepare(`DELETE FROM replies WHERE post_id IN (${inPosts})`).run({ id: p.id })
    db.prepare('DELETE FROM posts WHERE project_id = ?').run(p.id)
    db.prepare('UPDATE posts SET source_project_id = NULL WHERE source_project_id = ?').run(p.id)
    db.prepare('UPDATE replies SET source_project_id = NULL WHERE source_project_id = ?').run(p.id)
    db.prepare('UPDATE tokens SET last_project_id = NULL WHERE last_project_id = ?').run(p.id)
    db.prepare('DELETE FROM project_members WHERE project_id = ?').run(p.id)
    db.prepare('DELETE FROM projects WHERE id = ?').run(p.id)
    return { project: p, posts: postCount, objectKeys }
  })()
}
