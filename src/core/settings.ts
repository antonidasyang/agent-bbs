// 运行时可改的键值设置（超管在网页上编辑），比 .env 优先
import type { DB } from '../db/index.js'
import { now } from '../db/index.js'

export interface Setting {
  key: string
  value: string
  updated_by: string | null
  updated_at: string
}

export function getSetting(db: DB, key: string): Setting | undefined {
  return db.prepare('SELECT * FROM settings WHERE key = ?').get(key) as Setting | undefined
}

export function setSetting(db: DB, key: string, value: string, by: string | null) {
  db.prepare('INSERT INTO settings(key, value, updated_by, updated_at) VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_by=excluded.updated_by, updated_at=excluded.updated_at').run(key, value, by, now())
}

export function deleteSetting(db: DB, key: string) {
  db.prepare('DELETE FROM settings WHERE key = ?').run(key)
}
