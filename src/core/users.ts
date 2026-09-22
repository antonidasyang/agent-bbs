import type { DB } from '../db/index.js'
import { now } from '../db/index.js'
import { config } from '../config.js'
import type { User } from './types.js'
import { badRequest } from './errors.js'

export function getUser(db: DB, upn: string): User | undefined {
  return db.prepare('SELECT * FROM users WHERE upn = ?').get(upn.toLowerCase()) as User | undefined
}

export function listUsers(db: DB): User[] {
  return db.prepare('SELECT * FROM users ORDER BY display_name').all() as User[]
}

export function upsertUserFromCas(
  db: DB,
  u: { upn: string; displayName: string; mail?: string | null; department?: string | null },
): User {
  const upn = u.upn.toLowerCase()
  db.prepare(
    `INSERT INTO users(upn, display_name, mail, department, last_login_at) VALUES (?,?,?,?,?)
     ON CONFLICT(upn) DO UPDATE SET display_name=excluded.display_name, mail=COALESCE(excluded.mail, users.mail),
       department=COALESCE(excluded.department, users.department), last_login_at=excluded.last_login_at`,
  ).run(upn, u.displayName, u.mail ?? null, u.department ?? null, now())
  return getUser(db, upn)!
}

export function isAdmin(upn: string): boolean {
  return config.adminUsers.includes(upn.toLowerCase())
}

export function localPart(upn: string): string {
  return upn.split('@')[0]
}

/**
 * 解析 @ 目标："@alice" / "alice" / "alice@example.com" / "@艾丽丝"。
 * 全部解析成功才返回；任一失败抛 400 并列出原因。
 */
export function resolveMentions(db: DB, inputs: string[]): User[] {
  const out = new Map<string, User>()
  const errors: string[] = []
  for (const rawIn of inputs) {
    const raw = rawIn.trim().replace(/^@/, '')
    if (!raw) continue
    let user: User | undefined
    if (raw.includes('@')) {
      user = getUser(db, raw)
    } else {
      user = getUser(db, `${raw}@${config.accountDomain}`)
      if (!user) {
        const byName = db.prepare('SELECT * FROM users WHERE display_name = ?').all(raw) as User[]
        if (byName.length > 1) {
          errors.push(`"${raw}" 有 ${byName.length} 个同名用户，请改用账号：${byName.map((x) => localPart(x.upn)).join(' / ')}`)
          continue
        }
        user = byName[0]
      }
    }
    if (!user) {
      errors.push(`"${raw}" 不存在（对方需要先登录过 BBS）`)
      continue
    }
    out.set(user.upn, user)
  }
  if (errors.length) throw badRequest(`@ 解析失败：${errors.join('；')}`)
  return [...out.values()]
}

/** 通知邮件收件地址：自定义 → CAS mail → UPN */
export function mailAddressOf(u: Pick<User, 'upn' | 'mail' | 'notify_email'>): string {
  return u.notify_email || u.mail || u.upn
}

export function setNotifyEmail(db: DB, upn: string, email: string | null) {
  const v = email?.trim() || null
  if (v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw badRequest('邮箱格式不对')
  db.prepare('UPDATE users SET notify_email = ? WHERE upn = ?').run(v, upn)
}
