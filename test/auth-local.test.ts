import { test } from 'node:test'
import assert from 'node:assert/strict'
process.env.SESSION_SECRET = 'test'
process.env.AUTH_MODE = 'local'
process.env.ACCOUNT_DOMAIN = 'example.com'
const { openDb } = await import('../src/db/index.js')
const localAuth = await import('../src/auth/local.js')
const { registerLocalUser, loginLocal, changeLocalPassword, verifyPassword, hashPassword } = localAuth
const { getUser } = await import('../src/core/users.js')

test('密码哈希：正确/错误密码', () => {
  const h = hashPassword('s3cret-pass')
  assert.ok(h.startsWith('scrypt$'))
  assert.equal(verifyPassword('s3cret-pass', h), true)
  assert.equal(verifyPassword('wrong', h), false)
  assert.equal(verifyPassword('x', null), false)
})

test('注册 → 登录 → 改密码；重复注册被拒', () => {
  const db = openDb(':memory:')
  const u = registerLocalUser(db, { username: 'ZhangSan', displayName: '张三', password: 'password1' })
  assert.equal(u.upn, 'zhangsan@example.com')
  assert.equal(u.display_name, '张三')
  assert.equal(loginLocal(db, 'zhangsan', 'password1').upn, 'zhangsan@example.com')
  assert.equal(loginLocal(db, 'zhangsan@example.com', 'password1').upn, 'zhangsan@example.com')
  assert.throws(() => loginLocal(db, 'zhangsan', 'nope'), /账号或密码错误/)
  assert.throws(() => loginLocal(db, 'nobody', 'password1'), /账号或密码错误/)
  assert.throws(() => registerLocalUser(db, { username: 'zhangsan', displayName: 'x', password: 'password2' }), /已注册/)
  assert.throws(() => changeLocalPassword(db, u.upn, 'bad', 'password2'), /原密码/)
  changeLocalPassword(db, u.upn, 'password1', 'password2')
  assert.equal(loginLocal(db, 'zhangsan', 'password2').upn, u.upn)
})

test('校验：非法账号、短密码；占位用户可认领', () => {
  const db = openDb(':memory:')
  assert.throws(() => registerLocalUser(db, { username: 'a', displayName: '', password: 'password1' }), /账号只能/)
  assert.throws(() => registerLocalUser(db, { username: 'lisi', displayName: '', password: 'short' }), /至少 8 位/)
  // 被邀请但没登录过的人：占位行没有密码
  db.prepare('INSERT INTO users(upn, display_name, mail) VALUES (?,?,?)').run('lisi@example.com', 'lisi', 'lisi@example.com')
  assert.equal(getUser(db, 'lisi@example.com')!.password_hash, null)
  const u = registerLocalUser(db, { username: 'lisi', displayName: '李四', password: 'password1' })
  assert.equal(u.display_name, '李四')
  assert.equal(loginLocal(db, 'lisi', 'password1').upn, 'lisi@example.com')
})

test('自助注册两段式：邮箱验证后才建号；过期/重复被拒', () => {
  const { beginSignup, completeSignup } = localAuth
  const db = openDb(':memory:')
  assert.throws(() => beginSignup(db, { username: 'wangwu', displayName: '', email: 'not-an-email', password: 'password1' }), /邮箱格式/)
  const s = beginSignup(db, { username: 'WangWu', displayName: '王五', email: 'WangWu@Example.org', password: 'password1' })
  assert.equal(s.upn, 'wangwu@example.com')
  assert.equal(s.email, 'wangwu@example.org')
  assert.equal(getUser(db, s.upn), undefined, '验证前不建用户')
  assert.throws(() => completeSignup(db, 'bogus'), /无效或已过期/)
  const u = completeSignup(db, s.token)
  assert.equal(u.display_name, '王五')
  assert.equal(u.mail, 'wangwu@example.org')
  assert.equal(loginLocal(db, 'wangwu', 'password1').upn, u.upn)
  assert.throws(() => completeSignup(db, s.token), /无效|已注册/, 'token 用过即失效')
  assert.throws(() => beginSignup(db, { username: 'wangwu', displayName: '', email: 'x@example.org', password: 'password1' }), /已注册/)
  assert.throws(() => beginSignup(db, { username: 'zhaoliu', displayName: '', email: 'wangwu@example.org', password: 'password1' }), /邮箱已被/)
  // 过期
  const s2 = beginSignup(db, { username: 'zhaoliu', displayName: '', email: 'zhaoliu@example.org', password: 'password1' })
  db.prepare('UPDATE signup_verifications SET expires_at = ? WHERE token = ?').run('2000-01-01T00:00:00Z', s2.token)
  assert.throws(() => completeSignup(db, s2.token), /无效或已过期/)
})

test('图形验证码：对/错/重放/过期', async () => {
  const { newCaptcha, checkCaptcha, renderCaptchaSvg } = await import('../src/auth/captcha.js')
  const t = newCaptcha()
  const svg = renderCaptchaSvg(t)
  assert.match(svg, /^<svg/)
  const answer = [...svg.matchAll(/<text[^>]*>([A-Z2-9])<\/text>/g)].map((m) => m[1]).join('')
  assert.equal(answer.length, 5)
  assert.throws(() => checkCaptcha(t, 'WRONG'), /验证码不对/)
  assert.throws(() => checkCaptcha(t, answer), /已使用/, '答错即作废')
  const t2 = newCaptcha()
  const a2 = [...renderCaptchaSvg(t2).matchAll(/<text[^>]*>([A-Z2-9])<\/text>/g)].map((m) => m[1]).join('')
  checkCaptcha(t2, a2.toLowerCase())
  assert.throws(() => checkCaptcha(t2, a2), /已使用/, '重放')
  assert.throws(() => checkCaptcha('garbage', 'X'), /已过期/)
})
