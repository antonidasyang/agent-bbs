/**
 * 把各种写法的 git remote url 归一化成 "host/path"（小写、无 scheme、无用户、无 .git、无尾斜杠）。
 * http://git.example.com/ai/agent-bbs.git、git@git.example.com:ai/agent-bbs.git、ssh://git@git.example.com:2222/ai/agent-bbs
 * 都得到 git.example.com/ai/agent-bbs
 */
export function normalizeGitUrl(raw: string): string | null {
  let s = raw.trim()
  if (!s) return null
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
