import type { Context, MiddlewareHandler } from 'hono'
import type { DB } from '../db/index.js'
import type { Actor } from '../core/types.js'
import { authenticateToken, ensureServiceToken, touchToken } from '../core/tokens.js'
import { ensureProject } from '../core/projects.js'
import { requireMembership } from '../core/members.js'
import { ensureServiceUser, isAdmin, localPart } from '../core/users.js'
import type { User } from '../core/types.js'
import { introspect, svcEnabled } from './introspect.js'
import { ensureDefaultAgent, getAgent, listAgents, touchAgent } from '../core/agents.js'
import { sessionUser } from './session.js'
import { unauthorized, badRequest, forbidden, AppError } from '../core/errors.js'
import { config } from '../config.js'

export type Env = { Variables: { actor: Actor; db: DB } }

export const PROJECT_HEADER = 'x-project'
export const AGENT_HEADER = 'x-agent'

/**
 * 其他平台：Bearer 是服务账号令牌（JWT），远程 introspect 校验。
 * 校验通过只证明"是某个已登记的服务账号"，能不能调 BBS 看 SVC_ALLOWED_CLIENTS 白名单。
 */
async function serviceIdentity(c: Context, db: DB, plain: string): Promise<{ user: User; tokenId: number }> {
  const r = await introspect(plain)
  if (r.result === 'unavailable') throw new AppError(503, '令牌校验服务暂时不可用，请稍后重试', 'auth_unavailable')
  if (r.result === 'inactive') throw unauthorized('令牌无效、已过期或已被撤销')
  if (r.claims.type !== 'client_credentials') throw forbidden('只接受服务账号令牌（client_credentials），不接受个人登录令牌')
  const clientId = r.claims.sub.toLowerCase()
  if (!config.svc.allowedClients.includes(clientId)) throw forbidden(`服务账号 ${clientId} 不在本 BBS 的允许名单里，请联系 BBS 管理员`)
  const user = ensureServiceUser(db, clientId, r.claims.name)
  console.log(`[svc] ${clientId}(${user.display_name}) ${c.req.method} ${c.req.path}${r.degraded ? ' [降级放行]' : ''}`)
  return { user, tokenId: ensureServiceToken(db, user.upn).id }
}

/** Bearer token → Actor；X-Project header 决定项目。bbs_ 开头是本站 token，其余（开了服务账号接入时）按服务账号令牌校验 */
export async function actorFromToken(c: Context, db: DB): Promise<Actor | null> {
  const auth = c.req.header('authorization') ?? ''
  const m = /^Bearer\s+(.+)$/i.exec(auth)
  if (!m) return null
  const plain = m[1].trim()
  let r: { user: User; tokenId: number }
  if (!plain.startsWith('bbs_') && svcEnabled()) r = await serviceIdentity(c, db, plain)
  else {
    const t = authenticateToken(db, plain)
    if (!t) throw unauthorized('token 无效或已吊销')
    r = { user: t.user, tokenId: t.token.id }
  }
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
  const actor: Actor = { user: r.user, isAdmin: !r.user.is_service && isAdmin(r.user.upn), project, via: 'token', tokenId: r.tokenId, agent }
  // 手动项目：非成员不能以该项目身份连接
  if (project) requireMembership(db, actor, project)
  touchToken(db, r.tokenId, project?.id ?? null)
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
  const actor = await actorFromToken(c, c.get('db'))
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
  const actor = (await actorFromToken(c, db)) ?? actorFromSession(c, db)
  if (!actor) throw unauthorized()
  c.set('actor', actor)
  await next()
}
