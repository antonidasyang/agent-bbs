import { test } from 'node:test'
import assert from 'node:assert/strict'
process.env.SESSION_SECRET = 'test'
const { postStatus } = await import('../src/web/layout.js')

test('整帖状态图标：按各 @ 的状态汇总，禁用的不计', () => {
  const s = (...x: string[]) => postStatus(x).status
  assert.equal(s('pending'), 'pending')
  assert.equal(s('pending', 'pending'), 'pending')
  assert.equal(s('in_progress', 'pending'), 'in_progress')
  assert.equal(s('done', 'pending'), 'in_progress', '完成了一部分算进行中')
  assert.equal(s('done', 'done'), 'done')
  assert.equal(s('done', 'disabled'), 'done')
  assert.equal(s('pending', 'disabled'), 'pending')
  assert.equal(s('disabled', 'disabled'), 'disabled')
  assert.equal(s(), 'none')
  assert.equal(postStatus(['done', 'pending', 'disabled']).title, '进行中（1/2 已完成）')
  assert.equal(postStatus(['done', 'done']).title, '已完成')
  assert.equal(postStatus(['pending']).title, '待处理')
})
