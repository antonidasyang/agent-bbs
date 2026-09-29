import type { Context, MiddlewareHandler } from 'hono'
import type { DB } from '../db/index.js'
import type { Actor } from '../core/types.js'
import { authenticateToken, touchToken } from '../core/tokens.js'
import { ensureProject } from '../core/projects.js'
import { requireMembership } from '../core/members.js'
import { isAdmin } from '../core/users.js'
import { sessionUser } from './session.js'
import { unauthorized, badRequest, AppError } from '../core/errors.js'
import { config } from '../config.js'

export type Env = { Variables: { actor: Actor; db: DB } }

export const PROJECT_HEADER = 'x-project'

/** Bearer token → Actor；X-Project header 决定项目 */
export function actorFromToken(c: Context, db: DB): Actor | null {
  const auth = c.req.header('authorization') ?? ''
  const m = /^Bearer\s+(.+)$/i.exec(auth)
  if (!m) return null
  const r = authenticateToken(db, m[1].trim())
  if (!r) throw unauthorized('token 无效或已吊销')
  const projectHeader = c.req.header(PROJECT_HEADER)?.trim()
  let project = null
  if (projectHeader) {
    try {
      project = ensureProject(db, projectHeader)
    } catch (e) {
      throw badRequest(`X-Project 无法识别: ${projectHeader}（${(e as Error).message}）`)
    }
  }
  const actor: Actor = { user: r.user, isAdmin: isAdmin(r.user.upn), project, via: 'token', tokenId: r.token.id }
  // 手动项目：非成员不能以该项目身份连接
  if (project) requireMembership(db, actor, project)
  touchToken(db, r.token.id, project?.id ?? null)
  return actor
}

export function actorFromSession(c: Context, db: DB): Actor | null {
  const user = sessionUser(c, db)
  if (!user) return null
  return { user, isAdmin: isAdmin(user.upn), project: null, via: 'session' }
}

/** API / MCP：只认 Bearer */
export const requireToken: MiddlewareHandler<Env> = async (c, next) => {
  const actor = actorFromToken(c, c.get('db'))
  if (!actor) throw unauthorized('需要 Authorization: Bearer <token>')
  c.set('actor', actor)
  await next()
}

/** 网页 POST 的 CSRF：cookie 是 SameSite=Lax，再加一道同源检查 */
export const sameOriginPost: MiddlewareHandler<Env> = async (c, next) => {
  if (c.req.method === 'POST') {
    const site = c.req.header('sec-fetch-site')
    const origin = c.req.header('origin')
    const ok = site ? site === 'same-origin' || site === 'none' : !origin || origin === new URL(config.baseUrl).origin || origin === new URL(c.req.url).origin
    if (!ok) throw new AppError(403, '跨站请求被拒绝')
  }
  await next()
}

/** 网页：只认 session，没登录跳登录入口（cas 模式转 CAS，local 模式出表单） */
export const requireSession: MiddlewareHandler<Env> = async (c, next) => {
  const actor = actorFromSession(c, c.get('db'))
  if (!actor) {
    const { setReturnTo } = await import('./session.js')
    setReturnTo(c, c.req.path + (c.req.url.includes('?') ? '?' + c.req.url.split('?')[1] : ''))
    return c.redirect('/auth/login')
  }
  c.set('actor', actor)
  await next()
}

/** 附件下载：两种都行（网页点链接用 cookie，agent 用 token） */
export const requireAny: MiddlewareHandler<Env> = async (c, next) => {
  const db = c.get('db')
  const actor = actorFromToken(c, db) ?? actorFromSession(c, db)
  if (!actor) throw unauthorized()
  c.set('actor', actor)
  await next()
}
