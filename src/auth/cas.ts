import { config } from '../config.js'

export interface CasIdentity {
  upn: string
  displayName: string
  mail: string | null
  department: string | null
}

export function casLoginUrl(): string {
  return `${config.cas.baseUrl}/login?service=${encodeURIComponent(config.cas.serviceUrl)}`
}

export function casLogoutUrl(): string {
  return `${config.cas.baseUrl}/logout?service=${encodeURIComponent(config.baseUrl + '/')}`
}

function first(v: unknown): string | null {
  if (Array.isArray(v)) return v.length ? String(v[0]) : null
  if (v === undefined || v === null || v === '') return null
  return String(v)
}

/** 用 ticket 换身份。优先 JSON，失败时退回解析 XML。 */
export async function casValidate(ticket: string): Promise<CasIdentity> {
  const url = `${config.cas.baseUrl}/p3/serviceValidate?service=${encodeURIComponent(config.cas.serviceUrl)}&ticket=${encodeURIComponent(ticket)}&format=JSON`
  const res = await fetch(url, { headers: { Accept: 'application/json, text/xml' } })
  const text = await res.text()
  if (!res.ok) throw new Error(`CAS validate HTTP ${res.status}`)

  let user: string | null = null
  let attrs: Record<string, unknown> = {}
  let failure: string | null = null
  try {
    const json = JSON.parse(text)
    const sr = json.serviceResponse ?? json
    if (sr.authenticationFailure) failure = `${sr.authenticationFailure.code ?? ''} ${sr.authenticationFailure.description ?? ''}`.trim()
    else if (sr.authenticationSuccess) {
      user = first(sr.authenticationSuccess.user)
      attrs = sr.authenticationSuccess.attributes ?? {}
    }
  } catch {
    // XML 兜底
    const fail = /<cas:authenticationFailure[^>]*code=["']([^"']+)["'][^>]*>([\s\S]*?)<\/cas:authenticationFailure>/.exec(text)
    if (fail) failure = `${fail[1]} ${fail[2].trim()}`
    else {
      user = /<cas:user>([^<]*)<\/cas:user>/.exec(text)?.[1]?.trim() ?? null
      const attrBlock = /<cas:attributes>([\s\S]*?)<\/cas:attributes>/.exec(text)?.[1] ?? ''
      for (const m of attrBlock.matchAll(/<cas:(\w+)>([^<]*)<\/cas:\1>/g)) attrs[m[1]] = m[2].trim()
    }
  }
  if (failure) throw new Error(`CAS 校验失败: ${failure}`)
  if (!user) throw new Error(`CAS 响应无法识别: ${text.slice(0, 200)}`)

  let upn = user.trim().toLowerCase()
  if (!upn.includes('@')) upn = `${upn}@${config.accountDomain}`
  // LDAP 查不到时 displayName/cn 都可能缺失
  const displayName = first(attrs.displayName) ?? first(attrs.cn) ?? upn.split('@')[0]
  return {
    upn,
    displayName,
    mail: first(attrs.mail),
    department: first(attrs.department),
  }
}
