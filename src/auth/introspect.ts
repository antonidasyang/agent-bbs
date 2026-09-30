// 服务账号令牌校验：远程调 账号服务 的 /oauth/introspect，不在本地验签（签名密钥不该扩散到业务服务）。
// 口径照《服务账号令牌校验实现说明》情况 B：正缓存 ≤5 分钟、负缓存 1 分钟、缓存条数有上限；
// 账号服务 不可用时，只对 10 分钟内验过 active 的令牌降级放行，其余 503。
import crypto from 'node:crypto'
import { config } from '../config.js'

export interface IntrospectClaims {
  /** client_credentials 时是 clientId（svc_xxx）；authorization_code 时是员工账号 */
  sub: string
  type: string
  name?: string
  /** 过期时间，epoch 秒 */
  exp?: number
}
export type IntrospectResult = { result: 'active'; claims: IntrospectClaims; degraded?: true } | { result: 'inactive' } | { result: 'unavailable' }

const POS_TTL = 5 * 60_000
const NEG_TTL = 60_000
const FAIL_OPEN = 10 * 60_000
const TIMEOUT = 3000
const MAX = 10_000

const cache = new Map<string, { expireAt: number; claims?: IntrospectClaims }>()
const lastOk = new Map<string, { at: number; claims: IntrospectClaims }>()

// 明文令牌不进内存里的 key
const keyOf = (t: string) => crypto.createHash('sha256').update(t).digest('hex').slice(0, 32)

/** 校验密钥和 clientId 白名单两项都填了才开启；任何一项空着，服务账号令牌一律不认（也不去打 账号服务） */
export function svcEnabled(): boolean {
  return !!config.svc.introspectKey && config.svc.allowedClients.length > 0
}

/** 超上限时裁掉最早的一半，防止被大量随机令牌把内存打满 */
function trim<V>(m: Map<string, V>, age: (v: V) => number) {
  if (m.size <= MAX) return
  for (const [k] of [...m.entries()].sort((a, b) => age(a[1]) - age(b[1])).slice(0, Math.floor(m.size / 2))) m.delete(k)
}

export async function introspect(token: string): Promise<IntrospectResult> {
  const k = keyOf(token)
  const t = Date.now()
  const hit = cache.get(k)
  if (hit && hit.expireAt > t) return hit.claims ? { result: 'active', claims: hit.claims } : { result: 'inactive' }

  try {
    const resp = await fetch(config.svc.introspectUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Introspect-Key': config.svc.introspectKey },
      body: JSON.stringify({ token }),
      signal: AbortSignal.timeout(TIMEOUT),
    })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const body = (await resp.json()) as { active?: unknown; error?: unknown; sub?: unknown; type?: unknown; name?: unknown; exp?: unknown }
    // key 不对 / 对端没配 key 时所有令牌都是 inactive+unauthorized：这是我们的配置问题，不能当成"令牌无效"缓存下来
    if (body.active !== true && body.error === 'unauthorized') throw new Error('X-Introspect-Key 被拒（SVC_INTROSPECT_KEY 不对，或 账号服务 未配置 introspect-key）')
    if (body.active === true && typeof body.sub !== 'string') throw new Error('introspect 返回 active 但没有 sub')

    trim(cache, (v) => v.expireAt)
    if (body.active !== true) {
      cache.set(k, { expireAt: t + NEG_TTL })
      lastOk.delete(k)
      return { result: 'inactive' }
    }
    const claims: IntrospectClaims = { sub: body.sub as string, type: String(body.type ?? ''), name: typeof body.name === 'string' ? body.name : undefined, exp: typeof body.exp === 'number' ? body.exp : undefined }
    const ttl = claims.exp ? Math.min(POS_TTL, claims.exp * 1000 - t) : POS_TTL
    cache.set(k, { expireAt: t + Math.max(ttl, 1000), claims })
    trim(lastOk, (v) => v.at)
    lastOk.set(k, { at: t, claims })
    return { result: 'active', claims }
  } catch (e) {
    const last = lastOk.get(k)
    const notExpired = !last?.claims.exp || last.claims.exp * 1000 > t
    if (last && t - last.at < FAIL_OPEN && notExpired) {
      console.warn(`[svc] introspect 不可用（${(e as Error).message}），对 ${last.claims.sub} 降级放行`)
      return { result: 'active', claims: last.claims, degraded: true }
    }
    console.error(`[svc] introspect 失败：${(e as Error).message}`)
    return { result: 'unavailable' }
  }
}

/** 测试用 */
export function resetIntrospectCache() {
  cache.clear()
  lastOk.clear()
}
