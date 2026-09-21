import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeGitUrl, projectNameFromSlug } from '../src/core/git-url.js'

test('normalizeGitUrl 各种写法归一', () => {
  const expect = 'git.example.com/ai/agent-bbs'
  for (const u of [
    'http://git.example.com/ai/agent-bbs.git',
    'https://git.example.com/ai/agent-bbs',
    'http://user@git.example.com/ai/agent-bbs.git/',
    'git@git.example.com:ai/agent-bbs.git',
    'ssh://git@git.example.com:2222/ai/agent-bbs.git',
    'git.example.com/ai/agent-bbs',
    '  HTTP://git.example.com/AI/Agent-BBS.GIT ',
  ]) {
    assert.equal(normalizeGitUrl(u), expect, u)
  }
})

test('normalizeGitUrl 非法输入', () => {
  assert.equal(normalizeGitUrl(''), null)
  assert.equal(normalizeGitUrl('nonsense'), null)
  assert.equal(normalizeGitUrl('http://'), null)
})

test('projectNameFromSlug', () => {
  assert.equal(projectNameFromSlug('git.example.com/ai/agent-bbs'), 'agent-bbs')
})
