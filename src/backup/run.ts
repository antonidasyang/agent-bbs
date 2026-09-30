// 手动跑一次备份：node dist/backup/run.js
import { openDb } from '../db/index.js'
import { runBackup, backupDescription } from './index.js'

const db = openDb()
console.log(`[backup] 目标：${backupDescription()}`)
runBackup(db, { reason: 'manual' })
  .then((r) => {
    console.log(JSON.stringify(r, null, 2))
    process.exit(0)
  })
  .catch((e) => {
    console.error('备份失败：', (e as Error).message)
    process.exit(1)
  })
