import 'dotenv/config'
import path from 'node:path'

function env(name: string, def?: string): string {
  const v = process.env[name]
  if (v === undefined || v === '') {
    if (def !== undefined) return def
    throw new Error(`Missing required env: ${name}`)
  }
  return v
}

const baseUrl = env('BASE_URL', 'http://localhost:8000').replace(/\/+$/, '')

export const config = {
  baseUrl,
  port: Number(env('PORT', '8000')),
  host: env('HOST', '0.0.0.0'),
  dataDir: path.resolve(env('DATA_DIR', './data')),
  sessionSecret: env('SESSION_SECRET'),
  adminUsers: env('ADMIN_USERS', '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  accountDomain: env('ACCOUNT_DOMAIN', 'example.com').toLowerCase(),
  // 登录方式：cas（公司 CAS 单点登录）或 local（自建账号密码）
  authMode: (() => {
    const v = env('AUTH_MODE', 'cas')
    if (v !== 'cas' && v !== 'local') throw new Error(`AUTH_MODE 只能是 cas 或 local，得到 ${v}`)
    return v
  })(),
  // local 模式下是否开放自助注册：open | closed（closed 时只有超管能建号）
  localSignup: (() => {
    const v = env('LOCAL_SIGNUP', 'open')
    if (v !== 'open' && v !== 'closed') throw new Error(`LOCAL_SIGNUP 只能是 open 或 closed，得到 ${v}`)
    return v
  })(),
  cas: {
    baseUrl: env('CAS_BASE_URL', 'https://cas.example.com').replace(/\/+$/, ''),
    // login 与 validate 必须用一字不差的 service
    serviceUrl: `${baseUrl}/auth/cas/callback`,
  },
  // 其他平台用账号服务的「服务账号令牌」调 REST/MCP：远程 introspect 校验；KEY 为空 = 关闭。白名单是 clientId 列表
  svc: {
    introspectUrl: env('SVC_INTROSPECT_URL', `${env('CAS_BASE_URL', 'https://cas.example.com').replace(/\/+$/, '')}/oauth/introspect`),
    introspectKey: process.env.SVC_INTROSPECT_KEY ?? '',
    allowedClients: (process.env.SVC_ALLOWED_CLIENTS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  },
  minio: {
    endPoint: env('MINIO_ENDPOINT', 'localhost'),
    port: Number(env('MINIO_PORT', '9000')),
    useSSL: env('MINIO_USE_SSL', 'false') === 'true',
    region: env('MINIO_REGION', 'us-east-1'),
    bucket: env('MINIO_BUCKET', 'agent-bbs'),
    accessKey: process.env.MINIO_ACCESS_KEY ?? '',
    secretKey: process.env.MINIO_SECRET_KEY ?? '',
  },
  // 附件存储：minio（默认）或 local（直接落盘到 ATTACHMENT_DIR）
  attachmentStorage: (() => {
    const v = env('ATTACHMENT_STORAGE', 'minio')
    if (v !== 'minio' && v !== 'local') throw new Error(`ATTACHMENT_STORAGE 只能是 minio 或 local，得到 ${v}`)
    return v
  })(),
  attachmentDir: path.resolve(env('ATTACHMENT_DIR', path.join(path.resolve(env('DATA_DIR', './data')), 'attachments'))),
  // 发帖/回帖前的 LLM 安全审计（OpenAI 兼容接口）；BASE_URL 或 MODEL 为空则不审计
  audit: {
    baseUrl: (process.env.AUDIT_LLM_BASE_URL ?? '').replace(/\/+$/, ''),
    apiKey: process.env.AUDIT_LLM_API_KEY ?? '',
    model: process.env.AUDIT_LLM_MODEL ?? '',
    timeoutMs: Number(env('AUDIT_LLM_TIMEOUT_MS', '30000')),
    maxTokens: Number(env('AUDIT_LLM_MAX_TOKENS', '1024')),
    // 额外透传给 chat/completions 的 JSON 字段，例如 GLM 关思考：{"thinking":{"type":"disabled"}}
    extraBody: (() => {
      const raw = process.env.AUDIT_LLM_EXTRA_BODY ?? ''
      if (!raw.trim()) return {} as Record<string, unknown>
      try {
        const v = JSON.parse(raw)
        if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('不是对象')
        return v as Record<string, unknown>
      } catch (e) {
        throw new Error(`AUDIT_LLM_EXTRA_BODY 必须是 JSON 对象：${(e as Error).message}`)
      }
    })(),
    // 审计接口调用失败时：block（拒绝发帖，默认）| allow（放行并记录）
    onError: (() => {
      const v = env('AUDIT_ON_ERROR', 'block')
      if (v !== 'block' && v !== 'allow') throw new Error(`AUDIT_ON_ERROR 只能是 block 或 allow，得到 ${v}`)
      return v
    })(),
  },
  // 每日备份：none（只留本机 data/backups）| minio（复用 MINIO_* 配置）| s3（BACKUP_* 指向 S3 兼容存储，如 Cloudflare R2）
  backup: {
    target: (() => {
      const v = env('BACKUP_TARGET', 'none')
      if (v !== 'none' && v !== 'minio' && v !== 's3') throw new Error(`BACKUP_TARGET 只能是 none / minio / s3，得到 ${v}`)
      return v
    })(),
    localDir: path.resolve(env('BACKUP_LOCAL_DIR', path.join(path.resolve(env('DATA_DIR', './data')), 'backups'))),
    prefix: env('BACKUP_PREFIX', 'backups'),
    // 每天几点跑（机器本地时区，0-23）；-1 关闭定时，只能手动 node dist/backup/run.js
    hour: Number(env('BACKUP_HOUR', '3')),
    // 允许写成 https://host 或 host，SDK 只要主机名；写了 scheme 就按 scheme 定 SSL
    endPoint: (process.env.BACKUP_ENDPOINT ?? '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, ''),
    port: Number(env('BACKUP_PORT', '443')),
    useSSL: /^http:\/\//i.test((process.env.BACKUP_ENDPOINT ?? '').trim()) ? false : /^https:\/\//i.test((process.env.BACKUP_ENDPOINT ?? '').trim()) ? true : env('BACKUP_USE_SSL', 'true') === 'true',
    region: env('BACKUP_REGION', 'auto'),
    bucket: process.env.BACKUP_BUCKET ?? '',
    accessKey: process.env.BACKUP_ACCESS_KEY ?? '',
    secretKey: process.env.BACKUP_SECRET_KEY ?? '',
  },
  attachmentMaxBytes: Number(env('ATTACHMENT_MAX_MB', '100')) * 1024 * 1024,
  mcpAttachmentMaxBytes: 5 * 1024 * 1024,
  smtp: {
    host: process.env.SMTP_HOST ?? '',
    port: Number(env('SMTP_PORT', '465')),
    secure: env('SMTP_SECURE', 'true') === 'true',
    user: process.env.SMTP_USER ?? '',
    pass: process.env.SMTP_PASS ?? '',
    from: env('SMTP_FROM', 'agent-bbs <agent-bbs@example.com>'),
  },
}

export type Config = typeof config
