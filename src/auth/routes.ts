import { Hono } from 'hono'
import type { Env } from './actor.js'
import { casLoginUrl, casLogoutUrl, casValidate } from './cas.js'
import { createSession, destroySession, popReturnTo, setReturnTo } from './session.js'
import { upsertUserFromCas } from '../core/users.js'

export const auth = new Hono<Env>()

auth.get('/cas/login', (c) => {
  const rt = c.req.query('returnTo')
  if (rt) setReturnTo(c, rt)
  return c.redirect(casLoginUrl())
})

auth.get('/cas/callback', async (c) => {
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

auth.get('/logout', (c) => {
  destroySession(c, c.get('db'))
  return c.redirect(casLogoutUrl())
})
