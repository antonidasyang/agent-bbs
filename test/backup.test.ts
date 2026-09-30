import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bbs-backup-'))
process.env.SESSION_SECRET = 'test'
process.env.DATA_DIR = tmp
process.env.ATTACHMENT_STORAGE = 'local'
process.env.ATTACHMENT_DIR = path.join(tmp, 'attachments')
process.env.BACKUP_TARGET = 'none'
process.env.BACKUP_HOUR = '-1'
const { openDb } = await import('../src/db/index.js')
const { runBackup, lastBackup, backupEnabled } = await import('../src/backup/index.js')
const { config } = await import('../src/config.js')

test('本机快照：sqlite 一致快照 + 附件 tar + manifest 校验和 + 状态记录', async () => {
  const db = openDb(path.join(tmp, 'agent-bbs.sqlite'))
  db.prepare("INSERT INTO users(upn, display_name) VALUES ('a@x.com','A')").run()
  fs.mkdirSync(config.attachmentDir, { recursive: true })
  fs.writeFileSync(path.join(config.attachmentDir, 'f.txt'), 'hello')
  assert.equal(backupEnabled(), false)
  const r = await runBackup(db, { reason: 'test' })
  assert.equal(r.ok, true)
  assert.equal(r.remote, null)
  assert.deepEqual(r.files.map((f) => f.name).sort(), ['agent-bbs.sqlite', 'attachments.tar.gz'])
  const snap = new (await import('better-sqlite3')).default(path.join(r.local_dir, 'agent-bbs.sqlite'), { readonly: true })
  assert.equal((snap.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n, 1, '快照里有数据')
  snap.close()
  const manifest = JSON.parse(fs.readFileSync(path.join(r.local_dir, 'manifest.json'), 'utf8'))
  assert.equal(manifest.reason, 'test')
  assert.ok(manifest.schema_version >= 9)
  assert.equal(lastBackup(db)?.name, r.name)
})

test('对象存储配置不全：失败写进状态并抛错，本机快照仍在', async () => {
  const db = openDb(path.join(tmp, 'agent-bbs2.sqlite'))
  ;(config.backup as { target: string }).target = 's3'
  await assert.rejects(runBackup(db), /BACKUP_ENDPOINT/)
  const last = lastBackup(db)!
  assert.equal(last.ok, false)
  assert.match(last.error!, /BACKUP_ENDPOINT/)
  assert.ok(fs.existsSync(path.join(last.local_dir, 'agent-bbs.sqlite')))
  ;(config.backup as { target: string }).target = 'none'
})
