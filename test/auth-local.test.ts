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

test('保留字不能注册：all / admin 等', () => {
  const db = openDb(':memory:')
  for (const name of ['all', 'ALL', 'everyone', 'admin', 'default']) assert.throws(() => registerLocalUser(db, { username: name, displayName: '', password: 'password1' }), /保留字/, name)
  assert.throws(() => localAuth.beginSignup(db, { username: 'all', displayName: '', email: 'a@b.co', password: 'password1' }), /保留字/)
})

test('邮箱重置密码：按账号/邮箱申请 → 一次性链接改密；库里只存哈希', () => {
  const { beginSignup, completeSignup, beginPasswordReset, checkResetToken, completePasswordReset } = localAuth
  const db = openDb(':memory:')
  const u = completeSignup(db, beginSignup(db, { username: 'sunqi', displayName: '孙七', email: 'sunqi@example.org', password: 'password1' }).token)
  db.prepare('INSERT INTO sessions(id, user_upn, expires_at) VALUES (?,?,?)').run('sid1', u.upn, '2999-01-01T00:00:00Z')

  assert.deepEqual(beginPasswordReset(db, 'nobody'), [], '不存在的账号')
  assert.deepEqual(beginPasswordReset(db, 'nobody@example.org'), [], '不存在的邮箱')
  const [r] = beginPasswordReset(db, 'SunQi')
  assert.equal(r.user.upn, u.upn)
  assert.deepEqual(r.to, ['sunqi@example.org'])
  assert.deepEqual(beginPasswordReset(db, 'sunqi@example.org'), [], '一分钟内不重复发')

  const rows = db.prepare('SELECT token_hash FROM password_resets').all() as { token_hash: string }[]
  assert.equal(rows.length, 1)
  assert.notEqual(rows[0].token_hash, r.token, 'token 不落明文')
  assert.match(rows[0].token_hash, /^[0-9a-f]{64}$/)

  assert.throws(() => checkResetToken(db, 'bogus'), /无效或已过期/)
  assert.equal(checkResetToken(db, r.token).upn, u.upn)
  assert.throws(() => completePasswordReset(db, r.token, 'short'), /至少 8 位/)
  assert.equal(checkResetToken(db, r.token).upn, u.upn, '密码不合格不消耗链接')

  completePasswordReset(db, r.token, 'new-password')
  const stored = getUser(db, u.upn)!.password_hash!
  assert.ok(stored.startsWith('scrypt$') && !stored.includes('new-password'), '新密码以 scrypt 哈希入库')
  assert.equal(loginLocal(db, 'sunqi', 'new-password').upn, u.upn)
  assert.throws(() => loginLocal(db, 'sunqi', 'password1'), /账号或密码错误/)
  assert.throws(() => completePasswordReset(db, r.token, 'another-pass'), /无效或已过期/, '用过即失效')
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_upn = ?').get(u.upn) as { n: number }).n, 0, '已登录的会话全部作废')
})

test('邮箱重置密码：按邮箱找号、过期、没留邮箱和占位用户不发', () => {
  const { beginPasswordReset, checkResetToken, completePasswordReset } = localAuth
  const db = openDb(':memory:')
  // 超管建的号没有邮箱：不拿 UPN 兜底
  const a = registerLocalUser(db, { username: 'zhouba', displayName: '周八', password: 'password1' })
  assert.deepEqual(beginPasswordReset(db, 'zhouba'), [])
  // 自填通知邮箱后可以，按邮箱也能找到
  db.prepare('UPDATE users SET notify_email = ? WHERE upn = ?').run('zb@example.org', a.upn)
  const [r] = beginPasswordReset(db, 'ZB@example.org')
  assert.equal(r.user.upn, a.upn)
  assert.deepEqual(r.to, ['zb@example.org'])
  // 账号@ACCOUNT_DOMAIN 的写法按账号找
  db.prepare('DELETE FROM password_resets').run()
  assert.equal(beginPasswordReset(db, 'zhouba@example.com').length, 1)
  // 别的域的邮箱不会被当成账号
  db.prepare('DELETE FROM password_resets').run()
  assert.deepEqual(beginPasswordReset(db, 'zhouba@other.org'), [])
  // 过期
  const [r2] = beginPasswordReset(db, 'zhouba')
  db.prepare('UPDATE password_resets SET expires_at = ?').run('2000-01-01T00:00:00Z')
  assert.throws(() => checkResetToken(db, r2.token), /无效或已过期/)
  assert.throws(() => completePasswordReset(db, r2.token, 'new-password'), /无效或已过期/)
  assert.equal(loginLocal(db, 'zhouba', 'password1').upn, a.upn, '密码没变')
  // 占位用户（被邀请未注册）没有密码，不走重置
  db.prepare('INSERT INTO users(upn, display_name, mail) VALUES (?,?,?)').run('wujiu@example.com', 'wujiu', 'wujiu@example.org')
  assert.deepEqual(beginPasswordReset(db, 'wujiu'), [])
  assert.deepEqual(beginPasswordReset(db, 'wujiu@example.org'), [])
})
