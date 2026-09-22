import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
process.env.SESSION_SECRET = 'test'
const { openDb } = await import('../src/db/index.js')

test('全新库跑完所有迁移后重开不报错，schema_version 只有一行', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bbs-')), 'x.sqlite')
  openDb(file).close()
  const db = openDb(file)
  assert.deepEqual(db.prepare('SELECT version FROM schema_version').all().length, 1)
  assert.ok((db.prepare('SELECT version FROM schema_version').get() as { version: number }).version >= 2)
  db.close()
})
