// 本地账号密码登录（AUTH_MODE=local）：密码 scrypt 哈希存 users.password_hash
import crypto from 'node:crypto'
import type { DB } from '../db/index.js'
import { now } from '../db/index.js'
import { config } from '../config.js'
import { getUser } from '../core/users.js'
import { badRequest, unauthorized } from '../core/errors.js'
import type { User } from '../core/types.js'

const SCRYPT_N = 16384
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,31}$/

export function hashPassword(pw: string): string {
  const salt = crypto.randomBytes(16).toString('base64url')
  const hash = crypto.scryptSync(pw, salt, 32, { N: SCRYPT_N }).toString('base64url')
  return `scrypt$${SCRYPT_N}$${salt}$${hash}`
}

export function verifyPassword(pw: string, stored: string | null | undefined): boolean {
  if (!stored) return false
  const [algo, n, salt, hash] = stored.split('$')
  if (algo !== 'scrypt' || !salt || !hash) return false
  const got = crypto.scryptSync(pw, salt, 32, { N: Number(n) })
  const want = Buffer.from(hash, 'base64url')
  return got.length === want.length && crypto.timingSafeEqual(got, want)
}

function checkPassword(pw: string) {
  if (pw.length < 8) throw badRequest('密码至少 8 位')
  if (pw.length > 128) throw badRequest('密码太长')
}

export function normalizeUsername(raw: string): string {
  const u = raw.trim().toLowerCase().replace(/@.*$/, '')
  if (!USERNAME_RE.test(u)) throw badRequest('账号只能是 2-32 位小写字母、数字、. _ -，且以字母或数字开头')
  return u
}

/** 注册：占位用户（被邀请但没登录过）可以直接认领；已有密码的账号拒绝 */
export function registerLocalUser(db: DB, args: { username: string; displayName: string; password: string }): User {
  const username = normalizeUsername(args.username)
  const displayName = args.displayName.trim() || username
  if (displayName.length > 64) throw badRequest('姓名太长')
  checkPassword(args.password)
  const upn = `${username}@${config.accountDomain}`
  const existing = getUser(db, upn)
  if (existing?.password_hash) throw badRequest('该账号已注册，请直接登录')
  const hash = hashPassword(args.password)
  if (existing) {
    db.prepare('UPDATE users SET display_name = ?, password_hash = ?, last_login_at = ? WHERE upn = ?').run(displayName, hash, now(), upn)
  } else {
    db.prepare('INSERT INTO users(upn, display_name, mail, password_hash, last_login_at) VALUES (?,?,NULL,?,?)').run(upn, displayName, hash, now())
  }
  return getUser(db, upn)!
}

/** 超管建号：初始密码由超管转告对方 */
export function adminCreateLocalUser(db: DB, args: { username: string; displayName: string; password: string }): User {
  return registerLocalUser(db, args)
}

export function loginLocal(db: DB, username: string, password: string): User {
  let upn: string
  try {
    upn = `${normalizeUsername(username)}@${config.accountDomain}`
  } catch {
    throw unauthorized('账号或密码错误')
  }
  const user = getUser(db, upn)
  if (!user || !verifyPassword(password, user.password_hash)) throw unauthorized('账号或密码错误')
  db.prepare('UPDATE users SET last_login_at = ? WHERE upn = ?').run(now(), upn)
  return getUser(db, upn)!
}

export function changeLocalPassword(db: DB, upn: string, oldPw: string, newPw: string) {
  const user = getUser(db, upn)
  if (!user || !verifyPassword(oldPw, user.password_hash)) throw badRequest('原密码不对')
  checkPassword(newPw)
  db.prepare('UPDATE users SET password_hash = ? WHERE upn = ?').run(hashPassword(newPw), upn)
}

// ---- 登录失败限速：同一 key（IP 或账号）15 分钟内最多 10 次失败 ----
const WINDOW_MS = 15 * 60e3
const MAX_FAILS = 10
const fails = new Map<string, number[]>()

export function loginThrottle(key: string): void {
  const t = Date.now()
  const arr = (fails.get(key) ?? []).filter((x) => t - x < WINDOW_MS)
  fails.set(key, arr)
  if (arr.length >= MAX_FAILS) throw unauthorized('失败次数太多，请 15 分钟后再试')
}
export function loginFailed(key: string): void {
  const arr = fails.get(key) ?? []
  arr.push(Date.now())
  fails.set(key, arr)
}
export function loginSucceeded(key: string): void {
  fails.delete(key)
}
