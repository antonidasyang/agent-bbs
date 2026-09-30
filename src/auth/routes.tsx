import { Hono } from 'hono'
import type { Env } from './actor.js'
import { sameOriginPost } from './actor.js'
import { config } from '../config.js'
import { casLoginUrl, casLogoutUrl, casValidate } from './cas.js'
import { createSession, destroySession, popReturnTo, setReturnTo } from './session.js'
import { upsertUserFromCas, localPart } from '../core/users.js'
import { loginLocal, beginSignup, completeSignup, beginPasswordReset, checkResetToken, completePasswordReset, loginThrottle, loginFailed, loginSucceeded } from './local.js'
import { mailEnabled, sendMail, sendMailOrThrow } from '../mail/index.js'
import { newCaptcha, checkCaptcha, renderCaptchaSvg } from './captcha.js'
import { AppError } from '../core/errors.js'
import { LoginPage, RegisterPage, VerifySentPage, ForgotPage, ResetSentPage, ResetPage } from '../web/auth-pages.js'

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
  return c.html(<RegisterPage flash={c.req.query('flash')} captcha={newCaptcha()} />)
})

auth.get('/captcha/:token{.+\\.svg}', (c) => {
  const token = c.req.param('token').replace(/\.svg$/, '')
  c.header('Cache-Control', 'no-store')
  return c.body(renderCaptchaSvg(token), 200, { 'Content-Type': 'image/svg+xml' })
})

auth.post('/register', sameOriginPost, async (c) => {
  if (!isLocal || config.localSignup !== 'open') return c.redirect('/auth/register')
  const f = await c.req.parseBody()
  const username = String(f['username'] ?? '')
  const displayName = String(f['display_name'] ?? '')
  const email = String(f['email'] ?? '')
  const fail = (msg: string, status: 400 | 429 | 503 = 400) => c.html(<RegisterPage flash={msg} username={username} displayName={displayName} email={email} captcha={newCaptcha()} />, status)
  const key = `signup:${clientKey(c)}`
  try {
    loginThrottle(key)
    checkCaptcha(String(f['captcha_token'] ?? ''), String(f['captcha'] ?? ''))
    if (!mailEnabled()) return fail('服务器没有配置邮件，无法完成邮箱验证，请联系管理员开通账号', 503)
    const s = beginSignup(c.get('db'), { username, displayName, email, password: String(f['password'] ?? '') })
    loginFailed(key) // 每次发送计一次，防止刷邮件
    const link = `${config.baseUrl}/auth/verify/${s.token}`
    try {
      await sendMailOrThrow(
        [s.email],
        '[agent-bbs] 验证你的邮箱',
        `${s.displayName}，你好：\n\n你正在注册 agent-bbs 账号 @${s.upn.split('@')[0]}，点下面的链接完成验证（24 小时内有效）：\n\n${link}\n\n如果不是你本人操作，忽略这封邮件即可。\n\n—— agent-bbs 自动邮件`,
      )
    } catch (e) {
      console.error('[mail] signup verification failed', s.email, e)
      return fail('验证邮件发送失败，请稍后再试或联系管理员', 503)
    }
    return c.html(<VerifySentPage email={s.email} />)
  } catch (e) {
    if (e instanceof AppError) return fail(e.message, e.status === 401 ? 429 : 400)
    throw e
  }
})

// ---------- 邮箱重置密码 ----------
auth.get('/forgot', (c) => {
  if (!isLocal) return c.redirect('/auth/login')
  return c.html(<ForgotPage flash={c.req.query('flash')} captcha={newCaptcha()} />)
})

auth.post('/forgot', sameOriginPost, async (c) => {
  if (!isLocal) return c.redirect('/auth/login')
  const f = await c.req.parseBody()
  const identifier = String(f['identifier'] ?? '').trim()
  const fail = (msg: string, status: 400 | 429 | 503 = 400) => c.html(<ForgotPage flash={msg} identifier={identifier} captcha={newCaptcha()} />, status)
  const key = `reset:${clientKey(c)}`
  try {
    loginThrottle(key)
    checkCaptcha(String(f['captcha_token'] ?? ''), String(f['captcha'] ?? ''))
    if (!identifier) return fail('请填写账号或邮箱')
    if (!mailEnabled()) return fail('服务器没有配置邮件，无法通过邮箱重置，请联系管理员', 503)
    loginFailed(key) // 每次申请计一次，防止刷邮件
    for (const r of beginPasswordReset(c.get('db'), identifier)) {
      const link = `${config.baseUrl}/auth/reset/${r.token}`
      // 不等发送结果：查不到账号时也是立刻返回同一页，响应时间上不泄露账号是否存在
      void sendMail(
        r.to,
        '[agent-bbs] 重置密码',
        `${r.user.display_name}，你好：\n\n有人申请重置 agent-bbs 账号 @${localPart(r.user.upn)} 的密码，点下面的链接设置新密码（1 小时内有效，用一次即失效）：\n\n${link}\n\n如果不是你本人操作，忽略这封邮件即可，密码不会变。\n\n—— agent-bbs 自动邮件`,
      )
    }
    return c.html(<ResetSentPage />)
  } catch (e) {
    if (e instanceof AppError) return fail(e.message, e.status === 401 ? 429 : 400)
    throw e
  }
})

auth.get('/reset/:token', (c) => {
  if (!isLocal) return c.redirect('/auth/login')
  c.header('Referrer-Policy', 'no-referrer')
  c.header('Cache-Control', 'no-store')
  const token = c.req.param('token')
  try {
    const user = checkResetToken(c.get('db'), token)
    return c.html(<ResetPage token={token} username={localPart(user.upn)} />)
  } catch (e) {
    if (e instanceof AppError) return c.html(<ForgotPage flash={e.message} captcha={newCaptcha()} />, 400)
    throw e
  }
})

auth.post('/reset/:token', sameOriginPost, async (c) => {
  if (!isLocal) return c.redirect('/auth/login')
  c.header('Referrer-Policy', 'no-referrer')
  c.header('Cache-Control', 'no-store')
  const token = c.req.param('token')
  const db = c.get('db')
  const f = await c.req.parseBody()
  const pw = String(f['new_password'] ?? '')
  let username: string
  try {
    username = localPart(checkResetToken(db, token).upn)
  } catch (e) {
    if (e instanceof AppError) return c.html(<ForgotPage flash={e.message} captcha={newCaptcha()} />, 400)
    throw e
  }
  const again = (msg: string) => c.html(<ResetPage token={token} username={username} flash={msg} />, 400)
  if (pw !== String(f['confirm_password'] ?? '')) return again('两次输入的密码不一致')
  try {
    completePasswordReset(db, token, pw)
  } catch (e) {
    if (e instanceof AppError) return again(e.message)
    throw e
  }
  loginSucceeded(`user:${username}`)
  destroySession(c, db) // 库里的会话已全部作废，这里清掉当前浏览器的 cookie
  return c.redirect('/auth/login?flash=' + encodeURIComponent('密码已重置，请用新密码登录'))
})

auth.get('/verify/:token', (c) => {
  if (!isLocal) return c.redirect('/auth/login')
  try {
    const user = completeSignup(c.get('db'), c.req.param('token'))
    createSession(c, c.get('db'), user)
    return c.redirect('/tokens?flash=' + encodeURIComponent('邮箱已验证，注册完成'))
  } catch (e) {
    if (e instanceof AppError) return c.html(<RegisterPage flash={e.message} captcha={newCaptcha()} />, 400)
    throw e
  }
})
