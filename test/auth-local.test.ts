import { test } from 'node:test'
import assert from 'node:assert/strict'
process.env.SESSION_SECRET = 'test'
process.env.AUTH_MODE = 'local'
process.env.ACCOUNT_DOMAIN = 'example.com'
const { openDb } = await import('../src/db/index.js')
const { registerLocalUser, loginLocal, changeLocalPassword, verifyPassword, hashPassword } = await import('../src/auth/local.js')
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
