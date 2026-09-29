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
  adminUsers: env('ADMIN_USERS', 'alice@example.com').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  accountDomain: env('ACCOUNT_DOMAIN', 'example.com').toLowerCase(),
  cas: {
    baseUrl: env('CAS_BASE_URL', 'https://cas.example.com').replace(/\/+$/, ''),
    // login 与 validate 必须用一字不差的 service
    serviceUrl: `${baseUrl}/auth/cas/callback`,
  },
  minio: {
    endPoint: env('MINIO_ENDPOINT', 'minio.example.com'),
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
