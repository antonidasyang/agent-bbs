import crypto from 'node:crypto'
import type { Context } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import type { DB } from '../db/index.js'
import { config } from '../config.js'
import { getUser } from '../core/users.js'
import type { User } from '../core/types.js'

const COOKIE = 'bbs_sid'
const RETURN_COOKIE = 'bbs_return'
const TTL_DAYS = 7

function sign(id: string): string {
  return id + '.' + crypto.createHmac('sha256', config.sessionSecret).update(id).digest('base64url')
}
function verify(v: string | undefined): string | null {
  if (!v) return null
  const i = v.lastIndexOf('.')
  if (i <= 0) return null
  const id = v.slice(0, i)
  const expected = sign(id)
  if (expected.length !== v.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(v))) return null
  return id
}

const secure = config.baseUrl.startsWith('https://')

export function createSession(c: Context, db: DB, user: User) {
  const id = crypto.randomBytes(24).toString('base64url')
  const expires = new Date(Date.now() + TTL_DAYS * 86400e3)
  db.prepare('INSERT INTO sessions(id, user_upn, expires_at) VALUES (?,?,?)').run(id, user.upn, expires.toISOString())
  setCookie(c, COOKIE, sign(id), { httpOnly: true, sameSite: 'Lax', secure, path: '/', expires })
}

export function sessionUser(c: Context, db: DB): User | null {
  const id = verify(getCookie(c, COOKIE))
  if (!id) return null
  const row = db.prepare('SELECT user_upn, expires_at FROM sessions WHERE id = ?').get(id) as { user_upn: string; expires_at: string } | undefined
  if (!row || new Date(row.expires_at) < new Date()) return null
  return getUser(db, row.user_upn) ?? null
}

export function destroySession(c: Context, db: DB) {
  const id = verify(getCookie(c, COOKIE))
  if (id) db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
  deleteCookie(c, COOKIE, { path: '/' })
}

export function setReturnTo(c: Context, url: string) {
  if (url.startsWith('/') && !url.startsWith('//')) setCookie(c, RETURN_COOKIE, url, { httpOnly: true, sameSite: 'Lax', secure, path: '/', maxAge: 600 })
}
export function popReturnTo(c: Context): string {
  const v = getCookie(c, RETURN_COOKIE)
  deleteCookie(c, RETURN_COOKIE, { path: '/' })
  return v && v.startsWith('/') && !v.startsWith('//') ? v : '/'
}

export function cleanupSessions(db: DB) {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date().toISOString())
}
