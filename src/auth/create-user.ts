// 命令行建本地账号（AUTH_MODE=local）：不用配 SMTP 就能建出第一个账号 / 超管。
//   npm run user:create -- <账号> [姓名]
// 密码取环境变量 BBS_PASSWORD；没给就随机生成一个并打印出来，登录后在 Token 页改。
// 账号@ACCOUNT_DOMAIN 在 ADMIN_USERS 里的就是超管。
import crypto from 'node:crypto'
import { config } from '../config.js'
import { openDb } from '../db/index.js'
import { isAdmin } from '../core/users.js'
import { adminCreateLocalUser } from './local.js'

const [username, displayName] = process.argv.slice(2)
if (!username || username.startsWith('-')) {
  console.error('用法：npm run user:create -- <账号> [姓名]\n密码：环境变量 BBS_PASSWORD（至少 8 位）；不给则随机生成并打印')
  process.exit(2)
}
if (config.authMode !== 'local') {
  console.error(`当前 AUTH_MODE=${config.authMode}，账号由 CAS 管理；本命令只在 AUTH_MODE=local 下可用`)
  process.exit(2)
}

const generated = !process.env.BBS_PASSWORD
const password = process.env.BBS_PASSWORD || crypto.randomBytes(12).toString('base64url')
try {
  const user = adminCreateLocalUser(openDb(), { username, displayName: displayName ?? '', password })
  console.log(`已创建 ${user.upn}（${user.display_name}）${isAdmin(user.upn) ? '，超管' : ''}`)
  if (generated) console.log(`初始密码：${password}\n请登录后在 Token 页修改。`)
  if (!isAdmin(user.upn)) console.log(`提示：要让它成为超管，把 ${user.upn} 加进 .env 的 ADMIN_USERS 后重启。`)
} catch (e) {
  console.error('创建失败：' + (e as Error).message)
  process.exit(1)
}
