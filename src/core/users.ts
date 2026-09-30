import type { DB } from '../db/index.js'
import { now } from '../db/index.js'
import { config } from '../config.js'
import type { User, Agent } from './types.js'
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

export interface MentionTarget {
  user: User
  /** 指名的 agent；null = 默认 agent（@user 或 @user/<当前默认>） */
  agent: Agent | null
}

/**
 * 解析 @ 目标："@alice" / "alice" / "alice@example.com" / "@艾丽丝"，可带 "/agentid" 指名某个 agent。
 * 全部解析成功才返回；任一失败抛 400 并列出原因。
 */
export function resolveMentionTargets(db: DB, inputs: string[]): MentionTarget[] {
  const out = new Map<string, MentionTarget>()
  const errors: string[] = []
  for (const rawIn of inputs) {
    const whole = rawIn.trim().replace(/^@/, '')
    if (!whole) continue
    const slash = whole.indexOf('/')
    const raw = slash >= 0 ? whole.slice(0, slash).trim() : whole
    // 斜杠后允许写 @all / all
    const agentPart = slash >= 0 ? whole.slice(slash + 1).trim().replace(/^@/, '').toLowerCase() : null
    if (slash >= 0 && !agentPart) {
      errors.push(`"${whole}" 斜杠后面要跟 agent id`)
      continue
    }
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
    let agent: Agent | null = null
    if (agentPart === 'all') {
      // @user/all：该用户的每个 agent 各一条（默认的存 NULL）
      const mine = db.prepare('SELECT * FROM agents WHERE user_upn = ? ORDER BY is_default DESC, agent_id').all(user.upn) as Agent[]
      if (mine.length === 0) out.set(`${user.upn}/0`, { user, agent: null })
      for (const a of mine) out.set(`${user.upn}/${a.is_default ? 0 : a.id}`, { user, agent: a.is_default ? null : a })
      continue
    }
    if (agentPart) {
      const a = db.prepare('SELECT * FROM agents WHERE user_upn = ? AND agent_id = ?').get(user.upn, agentPart) as Agent | undefined
      if (!a) {
        const have = (db.prepare('SELECT agent_id FROM agents WHERE user_upn = ? ORDER BY is_default DESC, agent_id').all(user.upn) as { agent_id: string }[]).map((x) => x.agent_id)
        errors.push(`"${whole}"：${localPart(user.upn)} 没有名为 ${agentPart} 的 agent${have.length ? `（可用：${have.join(', ')}）` : `（对方还没建过 agent，直接 @${localPart(user.upn)} 即可）`}`)
        continue
      }
      // 指名的正好是默认 agent → 等价于不指名，存 NULL，默认 agent 换了任务跟着走
      agent = a.is_default ? null : a
    }
    out.set(`${user.upn}/${agent?.id ?? 0}`, { user, agent })
  }
  if (errors.length) throw badRequest(`@ 解析失败：${errors.join('；')}`)
  return [...out.values()]
}

/** 只要人（去重），给邀请等不关心 agent 的地方用 */
export function resolveMentions(db: DB, inputs: string[]): User[] {
  const seen = new Map<string, User>()
  for (const t of resolveMentionTargets(db, inputs)) seen.set(t.user.upn, t.user)
  return [...seen.values()]
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
