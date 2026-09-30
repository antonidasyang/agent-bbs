import crypto from 'node:crypto'
import type { DB } from '../db/index.js'
import { now } from '../db/index.js'
import type { Actor, Project, ProjectMember, User } from './types.js'
import { badRequest, forbidden, notFound } from './errors.js'
import { getProject } from './projects.js'
import { getUser, localPart } from './users.js'
import { config } from '../config.js'

export interface MemberView extends ProjectMember {
  display_name: string
}

export function listMembers(db: DB, projectId: number): MemberView[] {
  return db
    .prepare(`SELECT m.*, u.display_name FROM project_members m JOIN users u ON u.upn = m.user_upn WHERE m.project_id = ? ORDER BY m.role, m.status, m.id`)
    .all(projectId) as MemberView[]
}

export function getMember(db: DB, projectId: number, upn: string): ProjectMember | undefined {
  return db.prepare('SELECT * FROM project_members WHERE project_id = ? AND user_upn = ?').get(projectId, upn) as ProjectMember | undefined
}

export function isJoined(db: DB, projectId: number, upn: string): boolean {
  return getMember(db, projectId, upn)?.status === 'joined'
}

/** 手动项目：actor 必须是已加入的成员（超管除外） */
export function requireMembership(db: DB, actor: Actor, project: Project) {
  if (project.kind !== 'manual' || actor.isAdmin) return
  if (!isJoined(db, project.id, actor.user.upn)) throw forbidden(`你不是项目「${project.name}」(${project.slug}) 的成员，请让项目成员邀请你`)
}

/** 手动项目：@ 的目标必须都是已加入成员 */
export function requireTargetsAreMembers(db: DB, project: Project, targets: User[]) {
  if (project.kind !== 'manual') return
  const outsiders = targets.filter((t) => !isJoined(db, project.id, t.upn))
  if (outsiders.length) throw badRequest(`${outsiders.map((u) => `${u.display_name}(@${localPart(u.upn)})`).join('、')} 不是项目「${project.name}」的成员（未邀请或尚未接受邀请），请在网页的项目页处理`)
}

/**
 * 解析邀请对象：handle / upn 可以是没登录过的人（会建占位用户，登录后自动补全姓名）；姓名只能匹配已登录过的人。
 */
function resolveInvitees(db: DB, inputs: string[]): User[] {
  const out = new Map<string, User>()
  const errors: string[] = []
  for (const rawIn of inputs) {
    const raw = rawIn.trim().replace(/^@/, '')
    if (!raw) continue
    let user: User | undefined
    if (/^[a-z0-9._-]+(@[a-z0-9.-]+)?$/i.test(raw)) {
      const upn = (raw.includes('@') ? raw : `${raw}@${config.accountDomain}`).toLowerCase()
      if (!upn.endsWith('@' + config.accountDomain)) {
        errors.push(`"${raw}" 不是 ${config.accountDomain} 的账号`)
        continue
      }
      user = getUser(db, upn)
      if (!user) {
        db.prepare('INSERT INTO users(upn, display_name, mail) VALUES (?,?,?)').run(upn, localPart(upn), upn)
        user = getUser(db, upn)
      }
    } else {
      const byName = db.prepare('SELECT * FROM users WHERE display_name = ?').all(raw) as User[]
      if (byName.length > 1) {
        errors.push(`"${raw}" 有 ${byName.length} 个同名用户，请改用账号：${byName.map((x) => localPart(x.upn)).join(' / ')}`)
        continue
      }
      user = byName[0]
      if (!user) {
        errors.push(`"${raw}" 不存在（没登录过的人请用账号邀请，如 zhangsan）`)
        continue
      }
    }
    out.set(user!.upn, user!)
  }
  if (errors.length) throw badRequest(`邀请对象解析失败：${errors.join('；')}`)
  return [...out.values()]
}

export interface InviteResult {
  invited: { user: User; token: string }[]
  already: User[]
  /** 服务账号（其他平台）点不了邀请链接，邀请即加入、不发邮件 */
  joined: User[]
}

/** 任何已加入成员都可以邀请。返回需要发邮件的名单。 */
export function inviteMembers(db: DB, actor: Actor, projectId: number, inputs: string[]): InviteResult {
  const project = getProject(db, projectId)
  if (!project || project.kind !== 'manual') throw notFound('项目不存在')
  requireMembership(db, actor, project)
  const users = resolveInvitees(db, inputs)
  if (!users.length) throw badRequest('请填写要邀请的人')
  const result: InviteResult = { invited: [], already: [], joined: [] }
  db.transaction(() => {
    for (const u of users) {
      const existing = getMember(db, project.id, u.upn)
      if (existing?.status === 'joined') {
        result.already.push(u)
        continue
      }
      if (u.is_service) {
        if (existing) db.prepare("UPDATE project_members SET status = 'joined', joined_at = ?, invite_token = NULL, invited_by = ? WHERE id = ?").run(now(), actor.user.upn, existing.id)
        else db.prepare("INSERT INTO project_members(project_id, user_upn, role, status, invited_by, joined_at) VALUES (?,?,'member','joined',?,?)").run(project.id, u.upn, actor.user.upn, now())
        result.joined.push(u)
        continue
      }
      const token = crypto.randomBytes(24).toString('base64url')
      if (existing) db.prepare('UPDATE project_members SET invite_token = ?, invited_by = ?, invited_at = ? WHERE id = ?').run(token, actor.user.upn, now(), existing.id)
      else db.prepare("INSERT INTO project_members(project_id, user_upn, role, status, invited_by, invite_token) VALUES (?,?,'member','invited',?,?)").run(project.id, u.upn, actor.user.upn, token)
      result.invited.push({ user: u, token })
    }
  })()
  return result
}

export function getInviteByToken(db: DB, token: string): (ProjectMember & { project: Project; inviter_name: string | null }) | undefined {
  const m = db.prepare('SELECT * FROM project_members WHERE invite_token = ?').get(token) as ProjectMember | undefined
  if (!m) return undefined
  const project = getProject(db, m.project_id)!
  const inviter = m.invited_by ? getUser(db, m.invited_by) : undefined
  return { ...m, project, inviter_name: inviter?.display_name ?? null }
}

/** 点邀请链接的人必须就是被邀请人本人 */
export function acceptInvite(db: DB, actor: Actor, token: string): Project {
  const inv = getInviteByToken(db, token)
  if (!inv) throw notFound('邀请不存在或已失效')
  if (inv.user_upn !== actor.user.upn) throw forbidden(`此邀请是发给 @${localPart(inv.user_upn)} 的，你当前登录的是 @${localPart(actor.user.upn)}`)
  if (inv.status !== 'joined') db.prepare("UPDATE project_members SET status = 'joined', joined_at = ?, invite_token = NULL WHERE id = ?").run(now(), inv.id)
  return inv.project
}

export function declineInvite(db: DB, actor: Actor, token: string): Project {
  const inv = getInviteByToken(db, token)
  if (!inv) throw notFound('邀请不存在或已失效')
  if (inv.user_upn !== actor.user.upn) throw forbidden('这不是发给你的邀请')
  if (inv.status === 'invited') db.prepare('DELETE FROM project_members WHERE id = ?').run(inv.id)
  return inv.project
}

/** 移除成员或撤回邀请：owner / 超管 */
export function removeMember(db: DB, actor: Actor, projectId: number, upn: string) {
  const project = getProject(db, projectId)
  if (!project || project.kind !== 'manual') throw notFound('项目不存在')
  if (project.owner_upn !== actor.user.upn && !actor.isAdmin) throw forbidden('只有创建者可以移除成员')
  if (upn === project.owner_upn) throw badRequest('不能移除创建者')
  db.prepare('DELETE FROM project_members WHERE project_id = ? AND user_upn = ?').run(project.id, upn)
}

/** 自己退出（owner 不能退） */
export function leaveProject(db: DB, actor: Actor, projectId: number) {
  const project = getProject(db, projectId)
  if (!project || project.kind !== 'manual') throw notFound('项目不存在')
  if (project.owner_upn === actor.user.upn) throw badRequest('创建者不能退出自己的项目')
  db.prepare('DELETE FROM project_members WHERE project_id = ? AND user_upn = ?').run(project.id, actor.user.upn)
}

export function pendingInvites(db: DB, upn: string): (ProjectMember & { project_name: string; inviter_name: string | null })[] {
  return db
    .prepare(
      `SELECT m.*, p.name AS project_name, u.display_name AS inviter_name FROM project_members m JOIN projects p ON p.id = m.project_id
       LEFT JOIN users u ON u.upn = m.invited_by WHERE m.user_upn = ? AND m.status = 'invited' ORDER BY m.id DESC`,
    )
    .all(upn) as (ProjectMember & { project_name: string; inviter_name: string | null })[]
}
