// 每个人可以有多个 agent（多台机器 / 多个 Claude Code 实例），其中一个是默认 agent。
// @user → 默认 agent；@user/agentid → 指定 agent。连接时用 X-Agent header 表明身份，不带 = 默认。
import type { DB } from '../db/index.js'
import { now } from '../db/index.js'
import type { Agent } from './types.js'
import { badRequest, forbidden } from './errors.js'
import { localPart } from './users.js'

export const DEFAULT_AGENT_ID = 'default'
const AGENT_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/

export function normalizeAgentId(raw: string): string {
  const v = raw.trim().toLowerCase()
  if (!AGENT_ID_RE.test(v)) throw badRequest('agent id 只能是 1-32 位小写字母、数字、-，且以字母或数字开头')
  return v
}

export function listAgents(db: DB, upn: string): Agent[] {
  ensureDefaultAgent(db, upn)
  return db.prepare('SELECT * FROM agents WHERE user_upn = ? ORDER BY is_default DESC, agent_id').all(upn.toLowerCase()) as Agent[]
}

export function getAgent(db: DB, upn: string, agentId: string): Agent | undefined {
  return db.prepare('SELECT * FROM agents WHERE user_upn = ? AND agent_id = ?').get(upn.toLowerCase(), agentId.toLowerCase()) as Agent | undefined
}

export function getAgentById(db: DB, id: number): Agent | undefined {
  return db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as Agent | undefined
}

/** 每个用户保证有且只有一个默认 agent；没有任何 agent 时自动建 id=default */
export function ensureDefaultAgent(db: DB, upn: string): Agent {
  const u = upn.toLowerCase()
  const cur = db.prepare('SELECT * FROM agents WHERE user_upn = ? AND is_default = 1').get(u) as Agent | undefined
  if (cur) return cur
  const any = db.prepare('SELECT * FROM agents WHERE user_upn = ? ORDER BY id LIMIT 1').get(u) as Agent | undefined
  if (any) {
    db.prepare('UPDATE agents SET is_default = 1 WHERE id = ?').run(any.id)
    return { ...any, is_default: 1 }
  }
  db.prepare('INSERT INTO agents(user_upn, agent_id, name, is_default) VALUES (?,?,?,1)').run(u, DEFAULT_AGENT_ID, '默认')
  return getAgent(db, u, DEFAULT_AGENT_ID)!
}

export function createAgent(db: DB, upn: string, input: { agentId: string; name?: string }): Agent {
  const agentId = normalizeAgentId(input.agentId)
  if (getAgent(db, upn, agentId)) throw badRequest(`agent「${agentId}」已存在`)
  const count = (db.prepare('SELECT COUNT(*) AS n FROM agents WHERE user_upn = ?').get(upn.toLowerCase()) as { n: number }).n
  if (count >= 20) throw badRequest('agent 数量上限 20')
  ensureDefaultAgent(db, upn)
  const name = (input.name ?? '').trim().slice(0, 64)
  db.prepare('INSERT INTO agents(user_upn, agent_id, name, is_default) VALUES (?,?,?,0)').run(upn.toLowerCase(), agentId, name)
  return getAgent(db, upn, agentId)!
}

export function setDefaultAgent(db: DB, upn: string, id: number): Agent {
  const a = getAgentById(db, id)
  if (!a || a.user_upn !== upn.toLowerCase()) throw forbidden('不是你的 agent')
  db.transaction(() => {
    db.prepare('UPDATE agents SET is_default = 0 WHERE user_upn = ?').run(a.user_upn)
    db.prepare('UPDATE agents SET is_default = 1 WHERE id = ?').run(a.id)
  })()
  return getAgentById(db, id)!
}

/** 删除非默认 agent；指名给它的任务改成"默认 agent"（target_agent_id 置空） */
export function deleteAgent(db: DB, upn: string, id: number): void {
  const a = getAgentById(db, id)
  if (!a || a.user_upn !== upn.toLowerCase()) throw forbidden('不是你的 agent')
  if (a.is_default) throw badRequest('默认 agent 不能删除，先把另一个设为默认')
  db.transaction(() => {
    db.prepare('UPDATE mentions SET target_agent_id = NULL WHERE target_agent_id = ?').run(a.id)
    db.prepare('DELETE FROM agents WHERE id = ?').run(a.id)
  })()
}

export function touchAgent(db: DB, id: number) {
  db.prepare('UPDATE agents SET last_seen_at = ? WHERE id = ?').run(now(), id)
}

/** 显示用："alice" 或 "alice/desktop" */
export function mentionHandle(targetUpn: string, agentId: string | null | undefined): string {
  return agentId ? `${localPart(targetUpn)}/${agentId}` : localPart(targetUpn)
}
