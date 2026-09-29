import { Hono } from 'hono'
import type { Env } from './actor.js'
import { sameOriginPost } from './actor.js'
import { config } from '../config.js'
import { casLoginUrl, casLogoutUrl, casValidate } from './cas.js'
import { createSession, destroySession, popReturnTo, setReturnTo } from './session.js'
import { upsertUserFromCas } from '../core/users.js'
import { loginLocal, registerLocalUser, loginThrottle, loginFailed, loginSucceeded } from './local.js'
import { AppError } from '../core/errors.js'
import { LoginPage, RegisterPage } from '../web/auth-pages.js'

export const auth = new Hono<Env>()
const isLocal = config.authMode === 'local'

/** 统一登录入口：cas 模式跳 CAS，local 模式出表单 */
auth.get('/login', (c) => {
  const rt = c.req.query('returnTo')
  if (rt) setReturnTo(c, rt)
  if (!isLocal) return c.redirect(casLoginUrl())
  return c.html(<LoginPage flash={c.req.query('flash')} />)
})

auth.get('/logout', (c) => {
  destroySession(c, c.get('db'))
  return c.redirect(isLocal ? '/' : casLogoutUrl())
})

// ---------- CAS ----------
auth.get('/cas/login', (c) => {
  if (isLocal) return c.redirect('/auth/login')
  const rt = c.req.query('returnTo')
  if (rt) setReturnTo(c, rt)
  return c.redirect(casLoginUrl())
})

auth.get('/cas/callback', async (c) => {
  if (isLocal) return c.redirect('/auth/login')
  const ticket = c.req.query('ticket')
  if (!ticket) return c.text('缺少 ticket', 400)
  try {
    const id = await casValidate(ticket)
    const user = upsertUserFromCas(c.get('db'), { upn: id.upn, displayName: id.displayName, mail: id.mail, department: id.department })
    createSession(c, c.get('db'), user)
    return c.redirect(popReturnTo(c))
  } catch (e) {
    console.error('[cas]', e)
    return c.text(`登录失败：${(e as Error).message}`, 401)
  }
})

// ---------- 本地账号 ----------
function clientKey(c: { req: { header: (k: string) => string | undefined } }): string {
  return c.req.header('x-forwarded-for')?.split(',')[0].trim() || c.req.header('x-real-ip') || 'unknown'
}

auth.post('/login', sameOriginPost, async (c) => {
  if (!isLocal) return c.redirect('/auth/login')
  const f = await c.req.parseBody()
  const username = String(f['username'] ?? '')
  const password = String(f['password'] ?? '')
  const keys = [`ip:${clientKey(c)}`, `user:${username.trim().toLowerCase()}`]
  try {
    keys.forEach(loginThrottle)
    const user = loginLocal(c.get('db'), username, password)
    keys.forEach(loginSucceeded)
    createSession(c, c.get('db'), user)
    return c.redirect(popReturnTo(c))
  } catch (e) {
    if (e instanceof AppError) {
      keys.forEach(loginFailed)
      return c.html(<LoginPage flash={e.message} username={username} />, 401)
    }
    throw e
  }
})

auth.get('/register', (c) => {
  if (!isLocal) return c.redirect('/auth/login')
  return c.html(<RegisterPage flash={c.req.query('flash')} />)
})

auth.post('/register', sameOriginPost, async (c) => {
  if (!isLocal || config.localSignup !== 'open') return c.redirect('/auth/register')
  const f = await c.req.parseBody()
  const username = String(f['username'] ?? '')
  const displayName = String(f['display_name'] ?? '')
  try {
    const user = registerLocalUser(c.get('db'), { username, displayName, password: String(f['password'] ?? '') })
    createSession(c, c.get('db'), user)
    return c.redirect(popReturnTo(c))
  } catch (e) {
    if (e instanceof AppError) return c.html(<RegisterPage flash={e.message} username={username} displayName={displayName} />, 400)
    throw e
  }
})
