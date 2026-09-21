import type { DB } from '../db/index.js'
import type { Project } from './types.js'
import { normalizeGitUrl, projectNameFromSlug } from './git-url.js'
import { badRequest } from './errors.js'

export function getProject(db: DB, id: number): Project | undefined {
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Project | undefined
}

export function getProjectBySlug(db: DB, slug: string): Project | undefined {
  return db.prepare('SELECT * FROM projects WHERE slug = ?').get(slug) as Project | undefined
}

/** 按 git url 找项目；不存在则自动注册 */
export function ensureProject(db: DB, rawUrl: string): Project {
  const slug = normalizeGitUrl(rawUrl)
  if (!slug) throw badRequest(`无法识别的 git url: ${rawUrl}`)
  const existing = getProjectBySlug(db, slug)
  if (existing) return existing
  db.prepare('INSERT INTO projects(slug, raw_url, name) VALUES (?,?,?)').run(slug, rawUrl.trim(), projectNameFromSlug(slug))
  return getProjectBySlug(db, slug)!
}

/** 按 url / slug / 名字 找项目（只读，不注册）。名字模糊时列出候选。 */
export function findProject(db: DB, query: string): Project {
  const q = query.trim()
  const slug = normalizeGitUrl(q)
  if (slug) {
    const p = getProjectBySlug(db, slug)
    if (p) return p
  }
  const byName = db.prepare('SELECT * FROM projects WHERE name = ? COLLATE NOCASE').all(q) as Project[]
  if (byName.length === 1) return byName[0]
  if (byName.length > 1) throw badRequest(`项目名 "${q}" 有多个匹配，请用完整 git url：${byName.map((p) => p.slug).join(' / ')}`)
  const like = db.prepare('SELECT * FROM projects WHERE slug LIKE ? LIMIT 5').all(`%${q.toLowerCase()}%`) as Project[]
  if (like.length === 1) return like[0]
  if (like.length > 1) throw badRequest(`项目 "${q}" 有多个匹配：${like.map((p) => p.slug).join(' / ')}`)
  throw badRequest(`项目 "${q}" 不存在。对方需要先在该项目里接入过 BBS（用 bbs_list_projects 查看已注册项目）`)
}

export function listProjects(db: DB): Project[] {
  return db.prepare('SELECT * FROM projects ORDER BY name').all() as Project[]
}

/** 某人参与过的项目（发过帖、被 @ 过、作为来源项目、用 token 访问过） */
export function listProjectsForUser(db: DB, upn: string, admin: boolean): Project[] {
  if (admin) return listProjects(db)
  return db
    .prepare(
      `SELECT DISTINCT p.* FROM projects p
       WHERE p.id IN (SELECT project_id FROM posts WHERE author_upn = @upn)
          OR p.id IN (SELECT source_project_id FROM posts WHERE author_upn = @upn AND source_project_id IS NOT NULL)
          OR p.id IN (SELECT po.project_id FROM mentions m JOIN posts po ON po.id = m.post_id WHERE m.target_upn = @upn)
          OR p.id IN (SELECT last_project_id FROM tokens WHERE user_upn = @upn AND last_project_id IS NOT NULL)
       ORDER BY p.name`,
    )
    .all({ upn }) as Project[]
}
