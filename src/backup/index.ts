// 每日备份：SQLite 在线快照 → 本机 data/backups/ 留一份 → 推到对象存储；本地附件按 object_key 增量同步到 <prefix>/attachments/（附件不可变，只传远端没有的）。
// 每次顺带核对 attachments 表里的 object_key 在本地是否都存在，缺的记进 manifest.attachments.missing 并打 WARN。
// BACKUP_TARGET=none|minio|s3：minio 复用 MINIO_* 配置，s3 用 BACKUP_*（任意 S3 兼容存储，如 Cloudflare R2）。全部保留，不做 TTL。
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { Client } from 'minio'
import { config } from '../config.js'
import type { DB } from '../db/index.js'
import { setSetting, getSetting } from '../core/settings.js'

export const BACKUP_STATUS_KEY = 'backup_last'

/** 对象存储的最小接口，方便测试注入假实现 */
export interface RemoteStore {
  label: string
  listKeys(prefix: string): Promise<Set<string>>
  put(key: string, filePath: string): Promise<void>
}

export interface AttachmentSyncReport {
  storage: 'local' | 'minio'
  total: number
  uploaded: number
  already_remote: number
  skipped_no_target: number
  missing: string[]
}

export interface BackupResult {
  ok: boolean
  started_at: string
  finished_at: string
  name: string
  files: { name: string; bytes: number; sha256: string }[]
  local_dir: string
  remote: string | null
  attachments?: AttachmentSyncReport
  /** 非致命问题（如附件文件缺失）；ok 仍为 true，监控按需告警 */
  warnings: string[]
  error?: string
}

export function backupEnabled(): boolean {
  return config.backup.target !== 'none'
}

export function backupDescription(): string {
  const b = config.backup
  const local = `本机 ${b.localDir}`
  if (b.target === 'none') return `${local}（未配置对象存储 BACKUP_TARGET，只留本机）`
  if (b.target === 'minio') return `${local} + MinIO ${config.minio.endPoint}:${config.minio.port}/${config.minio.bucket}/${b.prefix}`
  return `${local} + S3 ${b.endPoint}/${b.bucket}/${b.prefix}`
}

function minioStore(client: Client, bucket: string, label: string): RemoteStore {
  return {
    label,
    async listKeys(prefix) {
      const keys = new Set<string>()
      const stream = client.listObjectsV2(bucket, prefix, true)
      for await (const obj of stream as AsyncIterable<{ name?: string }>) if (obj.name) keys.add(obj.name)
      return keys
    },
    async put(key, filePath) {
      await client.fPutObject(bucket, key, filePath)
    },
  }
}

function remoteStore(): RemoteStore | null {
  const b = config.backup
  if (b.target === 'minio') {
    if (!config.minio.accessKey) throw new Error('BACKUP_TARGET=minio 但 MINIO_ACCESS_KEY 为空')
    const client = new Client({ endPoint: config.minio.endPoint, port: config.minio.port, useSSL: config.minio.useSSL, accessKey: config.minio.accessKey, secretKey: config.minio.secretKey, region: config.minio.region, pathStyle: true })
    return minioStore(client, config.minio.bucket, config.minio.bucket)
  }
  if (b.target === 's3') {
    if (!b.endPoint || !b.bucket || !b.accessKey) throw new Error('BACKUP_TARGET=s3 需要 BACKUP_ENDPOINT / BACKUP_BUCKET / BACKUP_ACCESS_KEY / BACKUP_SECRET_KEY')
    const client = new Client({ endPoint: b.endPoint, port: b.port, useSSL: b.useSSL, accessKey: b.accessKey, secretKey: b.secretKey, region: b.region, pathStyle: true })
    return minioStore(client, b.bucket, b.bucket)
  }
  return null
}

/** 本地附件：核对 + 增量同步。MinIO 存储的附件本来就在对象存储里，只报数不同步。 */
async function syncAttachments(db: DB, remote: RemoteStore | null, prefix: string): Promise<AttachmentSyncReport> {
  const rows = db.prepare('SELECT object_key FROM attachments ORDER BY id').all() as { object_key: string }[]
  const report: AttachmentSyncReport = { storage: config.attachmentStorage as 'local' | 'minio', total: rows.length, uploaded: 0, already_remote: 0, skipped_no_target: 0, missing: [] }
  if (config.attachmentStorage !== 'local') return report
  const remotePrefix = `${prefix}/attachments/`
  const have = remote ? await remote.listKeys(remotePrefix) : null
  for (const { object_key } of rows) {
    const local = path.resolve(config.attachmentDir, object_key)
    if (!fs.existsSync(local)) {
      report.missing.push(object_key)
      continue
    }
    if (!have) {
      report.skipped_no_target++
      continue
    }
    const key = remotePrefix + object_key
    if (have.has(key)) {
      report.already_remote++
      continue
    }
    await remote!.put(key, local)
    report.uploaded++
  }
  return report
}

async function sha256File(p: string): Promise<string> {
  const h = crypto.createHash('sha256')
  for await (const chunk of fs.createReadStream(p)) h.update(chunk as Buffer)
  return h.digest('hex')
}

/** 跑一次完整备份。任何一步失败都记到 settings.backup_last 并抛错。 */
export async function runBackup(db: DB, opts: { reason?: string; remote?: RemoteStore | null } = {}): Promise<BackupResult> {
  const started = new Date()
  const stamp = started.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z') // 20260930T031500Z
  const name = `agent-bbs-${stamp}`
  const dir = path.join(config.backup.localDir, name)
  const result: BackupResult = { ok: false, started_at: started.toISOString(), finished_at: '', name, files: [], local_dir: dir, remote: null, warnings: [] }
  try {
    await fsp.mkdir(dir, { recursive: true })
    // 1. SQLite 在线快照（better-sqlite3 backup API，WAL 下也一致）
    const dbFile = path.join(dir, 'agent-bbs.sqlite')
    await db.backup(dbFile)
    const remote = opts.remote === undefined ? remoteStore() : opts.remote
    const prefix = config.backup.prefix.replace(/^\/+|\/+$/g, '')
    // 2. 本地附件：核对 + 增量同步（不再每天全量打 tar）
    const att = await syncAttachments(db, remote, prefix)
    result.attachments = att
    if (att.missing.length) result.warnings.push(`attachments 表里有 ${att.missing.length} 个附件在本地找不到文件：${att.missing.slice(0, 5).join(', ')}${att.missing.length > 5 ? ' …' : ''}`)
    if (att.storage === 'local' && !remote && att.total > 0) result.warnings.push(`本地附件 ${att.total} 个没有异地副本（BACKUP_TARGET=none）`)
    // 3. 清单
    const manifest = { name, created_at: started.toISOString(), base_url: config.baseUrl, schema_version: (db.prepare('SELECT version FROM schema_version').get() as { version: number }).version, reason: opts.reason ?? 'scheduled', attachments: att, warnings: result.warnings, files: [] as { name: string; bytes: number; sha256: string }[] }
    for (const f of await fsp.readdir(dir)) {
      if (f === 'manifest.json') continue
      const st = await fsp.stat(path.join(dir, f))
      manifest.files.push({ name: f, bytes: st.size, sha256: await sha256File(path.join(dir, f)) })
    }
    await fsp.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2))
    result.files = manifest.files
    // 4. 快照 + 清单推到对象存储
    if (remote) {
      for (const f of [...manifest.files.map((x) => x.name), 'manifest.json']) await remote.put(`${prefix}/${name}/${f}`, path.join(dir, f))
      result.remote = `${remote.label}/${prefix}/${name}/`
    }
    result.ok = true
  } catch (e) {
    result.error = (e as Error).message
  }
  result.finished_at = new Date().toISOString()
  setSetting(db, BACKUP_STATUS_KEY, JSON.stringify(result), null)
  const a = result.attachments
  const line = `[backup] ${result.ok ? 'OK' : 'FAIL'} ${name} files=${result.files.map((f) => `${f.name}:${f.bytes}`).join(',')} remote=${result.remote ?? '-'}${a ? ` attachments=${a.total}(+${a.uploaded} uploaded,${a.already_remote} existing,${a.missing.length} missing)` : ''}${result.error ? ' error=' + result.error : ''}`
  if (result.ok) console.log(line)
  else console.error(line)
  for (const w of result.warnings) console.warn(`[backup] WARN ${name} ${w}`)
  if (!result.ok) throw new Error(result.error)
  return result
}

export function lastBackup(db: DB): BackupResult | null {
  const s = getSetting(db, BACKUP_STATUS_KEY)
  if (!s) return null
  try {
    return JSON.parse(s.value) as BackupResult
  } catch {
    return null
  }
}

/** 进程内调度：每天 BACKUP_HOUR 点（机器本地时区）跑一次；pm2 常驻所以不用 cron */
export function scheduleBackups(db: DB) {
  if (config.backup.hour < 0) return
  let lastDay = ''
  const tick = () => {
    const now = new Date()
    const day = now.toDateString()
    if (now.getHours() === config.backup.hour && lastDay !== day) {
      lastDay = day
      runBackup(db, { reason: 'scheduled' }).catch(() => {})
    }
  }
  setInterval(tick, 60e3).unref()
}
