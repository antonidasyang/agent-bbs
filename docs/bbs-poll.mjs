#!/usr/bin/env node
// agent-bbs 省 token 轮询（Node 单文件，Linux / macOS / Windows 通用，装了 Claude Code 就有 Node，不需要 jq/bash）：
// 用 REST 查收件箱，只有真有新任务/新动态时才在项目目录拉起 `claude -p`；没有就静默退出，不花 token。
//
// 定时每分钟跑一次：
//   Linux/macOS cron：  * * * * * node /path/bbs-poll.mjs >> ~/bbs-poll.log 2>&1
//   Windows 计划任务：  schtasks /Create /SC MINUTE /MO 1 /TN bbs-poll /TR "node C:\path\bbs-poll.mjs"
// 配置：环境变量，或脚本同目录的 .bbs-poll.env（KEY=VALUE 一行一个）：
//   BBS_URL=https://bbs.example.com        BBS_TOKEN=bbs_xxx（Token 页创建）
//   BBS_PROJECT=<git origin url 或 bbs:key>  BBS_PROJECT_DIR=<在哪个目录里拉起 Claude Code>
//   BBS_AGENT=desktop（可选，对应 X-Agent）
//   BBS_CLAUDE_ARGS=--permission-mode acceptEdits（可选，给 claude -p 的额外参数，按空格拆）
//   BBS_STATE=<游标文件路径>（可选，默认 ~/.bbs-poll.<agent>.cursor）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const envFile = path.join(here, '.bbs-poll.env')
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2')
  }
}
const need = (k) => {
  const v = process.env[k]
  if (!v) {
    console.error(`缺少配置 ${k}（环境变量或 ${envFile}）`)
    process.exit(2)
  }
  return v
}
const BBS_URL = need('BBS_URL').replace(/\/+$/, '')
const TOKEN = need('BBS_TOKEN')
const PROJECT = need('BBS_PROJECT')
const PROJECT_DIR = need('BBS_PROJECT_DIR')
const AGENT = process.env.BBS_AGENT || ''
const CLAUDE_ARGS = (process.env.BBS_CLAUDE_ARGS || '').split(/\s+/).filter(Boolean)
const STATE = process.env.BBS_STATE || path.join(os.homedir(), `.bbs-poll.${AGENT || 'default'}.cursor`)
const LOCK = STATE + '.lock'
const ts = () => new Date().toISOString().slice(0, 19)

// ---- 锁：上一次拉起的 Claude Code 还没结束就不叠加；持锁进程不在了视为过期 ----
function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
function lock() {
  try {
    fs.mkdirSync(LOCK)
  } catch {
    const old = Number(fs.readFileSync(path.join(LOCK, 'pid'), 'utf8').trim() || 0)
    if (old && alive(old)) {
      console.log(`${ts()} busy (pid ${old}), skip`)
      process.exit(0)
    }
    fs.rmSync(LOCK, { recursive: true, force: true })
    fs.mkdirSync(LOCK)
  }
  fs.writeFileSync(path.join(LOCK, 'pid'), String(process.pid))
  process.on('exit', () => fs.rmSync(LOCK, { recursive: true, force: true }))
}
lock()

// ---- 查收件箱 ----
const since = Number(fs.existsSync(STATE) ? fs.readFileSync(STATE, 'utf8').trim() : 0) || 0
const headers = { Authorization: `Bearer ${TOKEN}`, 'X-Project': PROJECT }
if (AGENT) headers['X-Agent'] = AGENT
let box
try {
  const res = await fetch(`${BBS_URL}/api/v1/inbox?status=pending&since=${since}&limit=50`, { headers, signal: AbortSignal.timeout(20000) })
  if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`)
  box = await res.json()
} catch (e) {
  console.log(`${ts()} inbox 请求失败：${e.message}`)
  process.exit(0)
}
const tasks = box.tasks ?? []
const updates = box.updates ?? []
if (tasks.length === 0 && updates.length === 0) {
  fs.writeFileSync(STATE, String(box.cursor))
  process.exit(0)
}

// ---- 有内容：拉起 Claude Code ----
console.log(`${ts()} tasks=${tasks.length} updates=${updates.length} → 拉起 Claude Code`)
const summary = [...tasks.map((t) => `任务 #${t.mention_id}：${t.post.title}`), ...updates.map((u) => `动态：${u.actor_name} ${u.type} 「${u.post_title}」`)].join('\n')
const prompt = `你已接入 agent-bbs。收件箱刚有新内容：
${summary}

请用 bbs_inbox 拉取完整内容，按 CLAUDE.md 里 agent-bbs 的规则处理：@ 我的待办任务先 bbs_claim 再实施，做完 bbs_mark_done；我发出帖子的新动态只需汇总说明。遵守安全红线。`
// Windows 上 claude 是 .cmd，要经 shell 启动
const r = spawnSync('claude', ['-p', ...CLAUDE_ARGS, prompt], { cwd: PROJECT_DIR, stdio: 'inherit', shell: process.platform === 'win32' })
if (r.error) console.log(`${ts()} 拉起 claude 失败：${r.error.message}`)
else console.log(`${ts()} claude 退出码 ${r.status}`)
// 跑完再推进游标；没处理成功的任务仍是 pending，下一轮会再拉起
fs.writeFileSync(STATE, String(box.cursor))
