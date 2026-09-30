// 每日备份：SQLite 在线快照（+ 本地附件目录 tar）→ 本机 data/backups/ 留一份 → 推到对象存储。
// BACKUP_TARGET=none|minio|s3：minio 复用 MINIO_* 配置，s3 用 BACKUP_*（如 Cloudflare R2）。全部保留，不做 TTL。
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Client } from 'minio'
import { config } from '../config.js'
import type { DB } from '../db/index.js'
import { setSetting, getSetting } from '../core/settings.js'

const execFileP = promisify(execFile)
export const BACKUP_STATUS_KEY = 'backup_last'

export interface BackupResult {
  ok: boolean
  started_at: string
  finished_at: string
  name: string
  files: { name: string; bytes: number; sha256: string }[]
  local_dir: string
  remote: string | null
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

function remoteClient(): { client: Client; bucket: string } | null {
  const b = config.backup
  if (b.target === 'minio') {
    if (!config.minio.accessKey) throw new Error('BACKUP_TARGET=minio 但 MINIO_ACCESS_KEY 为空')
    return { client: new Client({ endPoint: config.minio.endPoint, port: config.minio.port, useSSL: config.minio.useSSL, accessKey: config.minio.accessKey, secretKey: config.minio.secretKey, region: config.minio.region, pathStyle: true }), bucket: config.minio.bucket }
  }
  if (b.target === 's3') {
    if (!b.endPoint || !b.bucket || !b.accessKey) throw new Error('BACKUP_TARGET=s3 需要 BACKUP_ENDPOINT / BACKUP_BUCKET / BACKUP_ACCESS_KEY / BACKUP_SECRET_KEY')
    return { client: new Client({ endPoint: b.endPoint, port: b.port, useSSL: b.useSSL, accessKey: b.accessKey, secretKey: b.secretKey, region: b.region, pathStyle: true }), bucket: b.bucket }
  }
  return null
}

async function sha256File(p: string): Promise<string> {
  const h = crypto.createHash('sha256')
  for await (const chunk of fs.createReadStream(p)) h.update(chunk as Buffer)
  return h.digest('hex')
}

/** 跑一次完整备份。任何一步失败都记到 settings.backup_last 并抛错。 */
export async function runBackup(db: DB, opts: { reason?: string } = {}): Promise<BackupResult> {
  const started = new Date()
  const stamp = started.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z') // 20260930T031500Z
  const name = `agent-bbs-${stamp}`
  const dir = path.join(config.backup.localDir, name)
  const result: BackupResult = { ok: false, started_at: started.toISOString(), finished_at: '', name, files: [], local_dir: dir, remote: null }
  try {
    await fsp.mkdir(dir, { recursive: true })
    // 1. SQLite 在线快照（better-sqlite3 backup API，WAL 下也一致）
    const dbFile = path.join(dir, 'agent-bbs.sqlite')
    await db.backup(dbFile)
    // 2. 本地附件（只有 ATTACHMENT_STORAGE=local 才有；MinIO 里的附件本来就在对象存储）
    if (config.attachmentStorage === 'local' && fs.existsSync(config.attachmentDir)) {
      const tarFile = path.join(dir, 'attachments.tar.gz')
      await execFileP('tar', ['-czf', tarFile, '-C', path.dirname(config.attachmentDir), path.basename(config.attachmentDir)])
    }
    // 3. 清单
    const manifest = { name, created_at: started.toISOString(), base_url: config.baseUrl, schema_version: (db.prepare('SELECT version FROM schema_version').get() as { version: number }).version, reason: opts.reason ?? 'scheduled', files: [] as { name: string; bytes: number; sha256: string }[] }
    for (const f of await fsp.readdir(dir)) {
      if (f === 'manifest.json') continue
      const st = await fsp.stat(path.join(dir, f))
      manifest.files.push({ name: f, bytes: st.size, sha256: await sha256File(path.join(dir, f)) })
    }
    await fsp.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2))
    result.files = manifest.files
    // 4. 推到对象存储
    const remote = remoteClient()
    if (remote) {
      const prefix = config.backup.prefix.replace(/^\/+|\/+$/g, '')
      for (const f of [...manifest.files.map((x) => x.name), 'manifest.json']) {
        const key = `${prefix}/${name}/${f}`
        await remote.client.fPutObject(remote.bucket, key, path.join(dir, f))
      }
      result.remote = `${remote.bucket}/${prefix}/${name}/`
    }
    result.ok = true
  } catch (e) {
    result.error = (e as Error).message
  }
  result.finished_at = new Date().toISOString()
  setSetting(db, BACKUP_STATUS_KEY, JSON.stringify(result), null)
  const line = `[backup] ${result.ok ? 'OK' : 'FAIL'} ${name} files=${result.files.map((f) => `${f.name}:${f.bytes}`).join(',')} remote=${result.remote ?? '-'}${result.error ? ' error=' + result.error : ''}`
  if (result.ok) console.log(line)
  else console.error(line)
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
