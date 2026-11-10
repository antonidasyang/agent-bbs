import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
process.env.SESSION_SECRET = 'test'
// 不依赖本机 .env 里的域和超管
process.env.ACCOUNT_DOMAIN = 'example.com'
process.env.ADMIN_USERS = 'alice@example.com'
const { openDb } = await import('../src/db/index.js')

test('全新库跑完所有迁移后重开不报错，schema_version 只有一行', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bbs-')), 'x.sqlite')
  openDb(file).close()
  const db = openDb(file)
  assert.deepEqual(db.prepare('SELECT version FROM schema_version').all().length, 1)
  assert.ok((db.prepare('SELECT version FROM schema_version').get() as { version: number }).version >= 2)
  db.close()
})

test('v7 → v8：存量 mention/事件保留，外键完整，重复 @ 被唯一索引挡住', () => {
  const file = path.join(os.tmpdir(), `bbs-mig-${Date.now()}.sqlite`)
  const old = openDb(file, { migrateUpTo: 7 })
  old.exec(`INSERT INTO users(upn, display_name) VALUES ('a@x.com','A'),('b@x.com','B');
    INSERT INTO projects(slug, raw_url, name) VALUES ('x/y','https://x/y','y');
    INSERT INTO posts(project_id, author_upn, title, body) VALUES (1,'a@x.com','t','b');
    INSERT INTO mentions(post_id, target_upn, status) VALUES (1,'b@x.com','in_progress');
    INSERT INTO events(post_id, mention_id, type, actor_upn, target_upn) VALUES (1,1,'mentioned','a@x.com','b@x.com');`)
  assert.equal((old.prepare('SELECT version FROM schema_version').get() as { version: number }).version, 7)
  old.close()
  const db = openDb(file)
  assert.ok((db.prepare('SELECT version FROM schema_version').get() as { version: number }).version >= 8)
  const m = db.prepare('SELECT * FROM mentions').all() as { id: number; target_upn: string; target_agent_id: number | null; status: string }[]
  assert.deepEqual(m.map((x) => [x.id, x.target_upn, x.target_agent_id, x.status]), [[1, 'b@x.com', null, 'in_progress']])
  assert.deepEqual(db.pragma('foreign_key_check'), [])
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1, '迁移完外键检查要重新打开')
  assert.throws(() => db.prepare('INSERT INTO mentions(post_id, target_upn) VALUES (1,\'b@x.com\')').run(), /UNIQUE/)
  db.close()
  fs.rmSync(file, { force: true })
})
