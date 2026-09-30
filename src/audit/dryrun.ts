// 审计干跑：从 stdin 读 JSONL 样本，只判定、不落库（内存库），用来评测命中率/误杀。
// 每行：{"kind":"post"|"reply","title":"可选","body":"正文","expect":"allow"|"block"（可选）,"name":"可选"}
// 用法：cat samples.jsonl | node dist/audit/dryrun.js   （需要 .env 里配好 AUDIT_LLM_*）
import readline from 'node:readline'
import { openDb } from '../db/index.js'
import { auditContent, auditEnabled, auditDescription, getAuditPrompt } from './index.js'
import { AppError } from '../core/errors.js'
import type { Actor } from '../core/types.js'

interface Sample {
  kind?: 'post' | 'reply'
  title?: string
  body: string
  expect?: 'allow' | 'block'
  name?: string
}

async function main() {
  if (!auditEnabled()) {
    console.error('审计未配置（AUDIT_LLM_BASE_URL / AUDIT_LLM_MODEL）')
    process.exit(2)
  }
  const db = openDb(':memory:')
  const actor: Actor = { user: { upn: 'dryrun@example.com', display_name: 'dryrun', mail: null, department: null, notify_email: null, password_hash: null, created_at: '', last_login_at: null }, isAdmin: false, project: null, via: 'token' }
  console.error(`[dryrun] ${auditDescription()}；prompt: ${getAuditPrompt(db).custom ? '自定义' : '内置默认'}（注意：干跑用的是内存库，线上超管改过的 prompt 不会带进来，除非把 DATA_DIR 指到线上数据目录）`)

  const rl = readline.createInterface({ input: process.stdin })
  let n = 0
  let expected = 0
  let hits = 0
  let falseBlock = 0
  let missed = 0
  let errors = 0
  for await (const line of rl) {
    if (!line.trim()) continue
    let s: Sample
    try {
      s = JSON.parse(line)
    } catch {
      console.log(JSON.stringify({ line: n + 1, error: '不是合法 JSON' }))
      continue
    }
    n++
    const t0 = Date.now()
    let verdict: 'allow' | 'block' | 'error' = 'allow'
    let detail = ''
    try {
      await auditContent(db, actor, { kind: s.kind ?? 'post', title: s.title, body: s.body })
    } catch (e) {
      if (e instanceof AppError && e.code === 'content_blocked') {
        verdict = 'block'
        detail = e.message.replace(/^内容未通过安全审计：/, '')
      } else {
        verdict = 'error'
        detail = (e as Error).message
      }
    }
    const rec = db.prepare('SELECT categories, reason FROM content_audits ORDER BY id DESC LIMIT 1').get() as { categories: string; reason: string | null } | undefined
    const row: Record<string, unknown> = { i: n, name: s.name ?? s.title ?? s.body.slice(0, 40), verdict, categories: rec ? JSON.parse(rec.categories) : [], reason: rec?.reason ?? detail, ms: Date.now() - t0 }
    if (s.expect) {
      expected++
      row.expect = s.expect
      row.ok = verdict === s.expect
      if (verdict === 'error') errors++
      else if (verdict === s.expect) hits++
      else if (verdict === 'block') falseBlock++
      else missed++
    } else if (verdict === 'error') errors++
    console.log(JSON.stringify(row))
  }
  const summary: Record<string, unknown> = { total: n, errors }
  if (expected) Object.assign(summary, { with_expect: expected, correct: hits, false_block: falseBlock, missed_block: missed, accuracy: expected ? +(hits / expected).toFixed(3) : null })
  console.error('[dryrun] 汇总 ' + JSON.stringify(summary))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
