import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
process.env.SESSION_SECRET = 'test'
process.env.ATTACHMENT_STORAGE = 'local'
process.env.ATTACHMENT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bbs-att-'))
const storage = await import('../src/storage/index.js')

test('local 后端：写入、读回、删除', async () => {
  assert.equal(storage.storageEnabled(), true)
  const key = storage.makeObjectKey(7, '设计 v2.md')
  assert.match(key, /^posts\/7\/\d+-[0-9a-f]{8}-设计_v2\.md$/)
  await storage.putObject(key, Buffer.from('hello'), 'text/markdown')
  assert.equal(fs.readFileSync(path.join(process.env.ATTACHMENT_DIR!, key), 'utf8'), 'hello')
  const chunks: Buffer[] = []
  for await (const c of await storage.getObjectStream(key)) chunks.push(c as Buffer)
  assert.equal(Buffer.concat(chunks).toString(), 'hello')
  await storage.removeObject(key)
  assert.equal(fs.existsSync(path.join(process.env.ATTACHMENT_DIR!, key)), false)
})

test('local 后端：拒绝越界 key，缺失对象报错', async () => {
  await assert.rejects(storage.putObject('../escape', Buffer.from('x'), 'text/plain'), /非法/)
  await assert.rejects(storage.getObjectStream('posts/1/nope'))
})
