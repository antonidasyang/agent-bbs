import type { Context, MiddlewareHandler } from 'hono'
import type { DB } from '../db/index.js'
import type { Actor } from '../core/types.js'
import { authenticateToken, touchToken } from '../core/tokens.js'
import { ensureProject } from '../core/projects.js'
import { requireMembership } from '../core/members.js'
import { isAdmin, localPart } from '../core/users.js'
import { ensureDefaultAgent, getAgent, listAgents, touchAgent } from '../core/agents.js'
import { sessionUser } from './session.js'
import { unauthorized, badRequest, AppError } from '../core/errors.js'
import { config } from '../config.js'

export type Env = { Variables: { actor: Actor; db: DB } }

export const PROJECT_HEADER = 'x-project'
export const AGENT_HEADER = 'x-agent'

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
  // X-Agent：这个连接是我的哪个 agent；不带 = 默认 agent（存量用户无感）
  const agentHeader = c.req.header(AGENT_HEADER)?.trim().toLowerCase()
  let agent
  if (agentHeader) {
    agent = getAgent(db, r.user.upn, agentHeader)
    if (!agent) {
      const have = listAgents(db, r.user.upn).map((a) => a.agent_id)
      throw badRequest(`X-Agent 无法识别: ${agentHeader}（${localPart(r.user.upn)} 的 agent 有：${have.join(', ')}；先在网页 Token 页新建）`)
    }
  } else {
    agent = ensureDefaultAgent(db, r.user.upn)
  }
  const actor: Actor = { user: r.user, isAdmin: isAdmin(r.user.upn), project, via: 'token', tokenId: r.token.id, agent }
  // 手动项目：非成员不能以该项目身份连接
  if (project) requireMembership(db, actor, project)
  touchToken(db, r.token.id, project?.id ?? null)
  touchAgent(db, agent.id)
  return actor
}

export function actorFromSession(c: Context, db: DB): Actor | null {
  const user = sessionUser(c, db)
  if (!user) return null
  return { user, isAdmin: isAdmin(user.upn), project: null, via: 'session', agent: null }
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
    // 只记页面导航；浏览器自动发的 favicon.ico 之类带扩展名的请求不能当返回地址
    if (c.req.method === 'GET' && !/\.[a-z0-9]+$/i.test(c.req.path)) {
      const { setReturnTo } = await import('./session.js')
      setReturnTo(c, c.req.path + (c.req.url.includes('?') ? '?' + c.req.url.split('?')[1] : ''))
    }
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
