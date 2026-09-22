/**
 * 把各种写法的 git remote url 归一化成 "host/path"（小写、无 scheme、无用户、无 .git、无尾斜杠）。
 * http://git.example.com/ai/agent-bbs.git、git@git.example.com:ai/agent-bbs.git、ssh://git@git.example.com:2222/ai/agent-bbs
 * 都得到 git.example.com/ai/agent-bbs
 */
export const MANUAL_PREFIX = 'bbs:'

/** 手动项目的标识：bbs:<key>，归一化成小写 */
export function normalizeManualKey(raw: string): string | null {
  const s = raw.trim().toLowerCase()
  if (!s.startsWith(MANUAL_PREFIX)) return null
  const key = s.slice(MANUAL_PREFIX.length)
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(key) ? MANUAL_PREFIX + key : null
}

/** 由项目名生成 key；非 ASCII 字符丢弃，空了就用随机串 */
export function keyFromName(name: string, random: () => string): string {
  const k = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
    .slice(0, 40)
  return k || random()
}

export function normalizeGitUrl(raw: string): string | null {
  let s = raw.trim()
  if (!s) return null
  if (s.toLowerCase().startsWith(MANUAL_PREFIX)) return null
  let host: string
  let p: string
  const scp = /^([^@\/:]+@)?([^:\/]+):(?!\/\/)(.+)$/.exec(s)
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    let u: URL
    try {
      u = new URL(s)
    } catch {
      return null
    }
    host = u.hostname
    p = u.pathname
  } else if (scp) {
    host = scp[2]
    p = scp[3]
  } else {
    // 裸的 host/path
    const i = s.indexOf('/')
    if (i <= 0) return null
    host = s.slice(0, i)
    p = s.slice(i)
  }
  p = p.replace(/\/+$/, '').replace(/\.git$/i, '').replace(/^\/+/, '')
  if (!host || !p) return null
  return `${host.toLowerCase()}/${p.toLowerCase()}`
}

export function projectNameFromSlug(slug: string): string {
  const parts = slug.split('/')
  return parts[parts.length - 1] || slug
}
