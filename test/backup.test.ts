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
import type { RemoteStore } from '../src/backup/index.js'
const { config } = await import('../src/config.js')

function seed(db: ReturnType<typeof openDb>) {
  db.exec(`INSERT INTO users(upn, display_name) VALUES ('a@x.com','A');
    INSERT INTO projects(slug, raw_url, name) VALUES ('x/y','https://x/y','y');
    INSERT INTO posts(project_id, author_upn, title, body) VALUES (1,'a@x.com','t','b');
    INSERT INTO attachments(post_id, uploader_upn, filename, size, mime, sha256, object_key) VALUES
      (1,'a@x.com','ok.txt',5,'text/plain','s1','posts/1/1-ok.txt'),
      (1,'a@x.com','gone.txt',5,'text/plain','s2','posts/1/2-gone.txt');`)
  fs.mkdirSync(path.join(config.attachmentDir, 'posts/1'), { recursive: true })
  fs.writeFileSync(path.join(config.attachmentDir, 'posts/1/1-ok.txt'), 'hello')
}
function fakeRemote(): RemoteStore & { objects: Map<string, string> } {
  const objects = new Map<string, string>()
  return {
    label: 'fake',
    objects,
    async listKeys(prefix) {
      return new Set([...objects.keys()].filter((k) => k.startsWith(prefix)))
    },
    async put(key, filePath) {
      objects.set(key, fs.readFileSync(filePath, 'utf8'))
    },
  }
}

test('本机快照：sqlite 一致快照 + manifest 校验和 + 状态记录；无目标时附件只核对不同步并告警', async () => {
  const db = openDb(path.join(tmp, 'agent-bbs.sqlite'))
  seed(db)
  assert.equal(backupEnabled(), false)
  const r = await runBackup(db, { reason: 'test' })
  assert.equal(r.ok, true)
  assert.equal(r.remote, null)
  assert.deepEqual(r.files.map((f) => f.name), ['agent-bbs.sqlite'], '不再打 tar')
  assert.deepEqual(r.attachments, { storage: 'local', total: 2, uploaded: 0, already_remote: 0, skipped_no_target: 1, missing: ['posts/1/2-gone.txt'] })
  assert.equal(r.warnings.length, 2, '缺文件 + 没有异地副本')
  assert.match(r.warnings[0], /2-gone\.txt/)
  const snap = new (await import('better-sqlite3')).default(path.join(r.local_dir, 'agent-bbs.sqlite'), { readonly: true })
  assert.equal((snap.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n, 1, '快照里有数据')
  snap.close()
  const manifest = JSON.parse(fs.readFileSync(path.join(r.local_dir, 'manifest.json'), 'utf8'))
  assert.equal(manifest.reason, 'test')
  assert.ok(manifest.schema_version >= 9)
  assert.deepEqual(manifest.attachments.missing, ['posts/1/2-gone.txt'])
  assert.equal(lastBackup(db)?.name, r.name)
})

test('附件增量同步：第一次传缺的，第二次全部 already_remote；新增一个只传一个；快照和 manifest 也在远端', async () => {
  const db = openDb(path.join(tmp, 'agent-bbs3.sqlite'))
  seed(db)
  const remote = fakeRemote()
  const r1 = await runBackup(db, { remote })
  assert.equal(r1.ok, true)
  assert.equal(r1.remote, `fake/backups/${r1.name}/`)
  assert.deepEqual([r1.attachments!.uploaded, r1.attachments!.already_remote, r1.attachments!.missing.length], [1, 0, 1])
  assert.equal(remote.objects.get('backups/attachments/posts/1/1-ok.txt'), 'hello')
  assert.ok(remote.objects.has(`backups/${r1.name}/agent-bbs.sqlite`))
  assert.ok(remote.objects.has(`backups/${r1.name}/manifest.json`))
  assert.equal(r1.warnings.length, 1, '只剩缺文件的告警')
  const r2 = await runBackup(db, { remote })
  assert.deepEqual([r2.attachments!.uploaded, r2.attachments!.already_remote], [0, 1])
  db.prepare("INSERT INTO attachments(post_id, uploader_upn, filename, size, mime, sha256, object_key) VALUES (1,'a@x.com','n.txt',3,'text/plain','s3','posts/1/3-n.txt')").run()
  fs.writeFileSync(path.join(config.attachmentDir, 'posts/1/3-n.txt'), 'new')
  const r3 = await runBackup(db, { remote })
  assert.deepEqual([r3.attachments!.uploaded, r3.attachments!.already_remote], [1, 1], '新的传了，ok.txt 已在远端，gone.txt 仍缺')
  assert.equal([...remote.objects.keys()].filter((k) => k.startsWith('backups/attachments/')).length, 2)
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
