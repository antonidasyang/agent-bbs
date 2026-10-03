import crypto from 'node:crypto'
import type { DB } from '../db/index.js'
import { now } from '../db/index.js'
import type { Token, User } from './types.js'
import { getUser } from './users.js'
import { unauthorized } from './errors.js'

function hashToken(plain: string): string {
  return crypto.createHash('sha256').update(plain).digest('hex')
}

/** ttlHours 为空/0 = 永久；否则是临时 token，到期后自动失效 */
export function createToken(db: DB, userUpn: string, name: string, ttlHours?: number | null): { token: Token; plain: string } {
  const plain = 'bbs_' + crypto.randomBytes(24).toString('hex')
  const prefix = plain.slice(0, 12)
  const expiresAt = ttlHours && ttlHours > 0 ? new Date(Date.now() + ttlHours * 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z') : null
  const r = db
    .prepare('INSERT INTO tokens(user_upn, name, hash, prefix, expires_at) VALUES (?,?,?,?,?)')
    .run(userUpn, name || 'default', hashToken(plain), prefix, expiresAt)
  const token = db.prepare('SELECT * FROM tokens WHERE id = ?').get(r.lastInsertRowid) as Token
  return { token, plain }
}

export function listTokens(db: DB, userUpn: string): Token[] {
  return db.prepare('SELECT * FROM tokens WHERE user_upn = ? ORDER BY id DESC').all(userUpn) as Token[]
}

export function revokeToken(db: DB, userUpn: string, id: number): boolean {
  const r = db.prepare('UPDATE tokens SET revoked_at = ? WHERE id = ? AND user_upn = ? AND revoked_at IS NULL').run(now(), id, userUpn)
  return r.changes > 0
}

export function authenticateToken(db: DB, plain: string): { token: Token; user: User } | null {
  if (!plain.startsWith('bbs_')) return null
  const token = db.prepare('SELECT * FROM tokens WHERE hash = ? AND revoked_at IS NULL').get(hashToken(plain)) as Token | undefined
  if (!token) return null
  if (tokenExpired(token)) throw unauthorized(`token 已于 ${token.expires_at} 过期，请在网页 Token 页新建`)
  const user = getUser(db, token.user_upn)
  if (!user) return null
  return { token, user }
}

export function tokenExpired(t: Token): boolean {
  return !!t.expires_at && t.expires_at <= now()
}

/**
 * 服务账号没有 bbs_ token（凭据是账号服务签发的 JWT），给它挂一条不可能被匹配到的占位记录，
 * 好沿用 last_project_id 这套"以哪个项目身份连接过"的口径（git 项目可见性、项目列表里的活跃成员）。
 */
export function ensureServiceToken(db: DB, userUpn: string): Token {
  const hash = `svc:${userUpn}`
  const cur = db.prepare('SELECT * FROM tokens WHERE hash = ?').get(hash) as Token | undefined
  if (cur) return cur
  const r = db.prepare('INSERT INTO tokens(user_upn, name, hash, prefix) VALUES (?,?,?,?)').run(userUpn, '服务账号令牌', hash, 'svc')
  return db.prepare('SELECT * FROM tokens WHERE id = ?').get(r.lastInsertRowid) as Token
}

export function touchToken(db: DB, id: number, projectId: number | null) {
  db.prepare('UPDATE tokens SET last_used_at = ?, last_project_id = COALESCE(?, last_project_id) WHERE id = ?').run(now(), projectId, id)
}
