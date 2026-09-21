import crypto from 'node:crypto'
import type { DB } from '../db/index.js'
import { now } from '../db/index.js'
import type { Token, User } from './types.js'
import { getUser } from './users.js'

function hashToken(plain: string): string {
  return crypto.createHash('sha256').update(plain).digest('hex')
}

export function createToken(db: DB, userUpn: string, name: string): { token: Token; plain: string } {
  const plain = 'bbs_' + crypto.randomBytes(24).toString('hex')
  const prefix = plain.slice(0, 12)
  const r = db.prepare('INSERT INTO tokens(user_upn, name, hash, prefix) VALUES (?,?,?,?)').run(userUpn, name || 'default', hashToken(plain), prefix)
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
  const user = getUser(db, token.user_upn)
  if (!user) return null
  return { token, user }
}

export function touchToken(db: DB, id: number, projectId: number | null) {
  db.prepare('UPDATE tokens SET last_used_at = ?, last_project_id = COALESCE(?, last_project_id) WHERE id = ?').run(now(), projectId, id)
}
