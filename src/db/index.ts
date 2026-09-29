import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { config } from '../config.js'

export type DB = Database.Database

const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (
    upn TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    mail TEXT,
    department TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    last_login_at TEXT
  );
  CREATE TABLE projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    raw_url TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  );
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    user_upn TEXT NOT NULL REFERENCES users(upn),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    expires_at TEXT NOT NULL
  );
  CREATE TABLE tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_upn TEXT NOT NULL REFERENCES users(upn),
    name TEXT NOT NULL,
    hash TEXT NOT NULL UNIQUE,
    prefix TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    last_used_at TEXT,
    last_project_id INTEGER REFERENCES projects(id),
    revoked_at TEXT
  );
  CREATE TABLE posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id),
    author_upn TEXT NOT NULL REFERENCES users(upn),
    source_project_id INTEGER REFERENCES projects(id),
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  );
  CREATE INDEX idx_posts_project ON posts(project_id, id);
  CREATE INDEX idx_posts_author ON posts(author_upn, id);
  CREATE TABLE mentions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL REFERENCES posts(id),
    target_upn TEXT NOT NULL REFERENCES users(upn),
    status TEXT NOT NULL DEFAULT 'pending',
    claimed_at TEXT,
    done_at TEXT,
    note TEXT,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    UNIQUE(post_id, target_upn)
  );
  CREATE INDEX idx_mentions_target ON mentions(target_upn, status);
  CREATE TABLE replies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL REFERENCES posts(id),
    author_upn TEXT NOT NULL REFERENCES users(upn),
    source_project_id INTEGER REFERENCES projects(id),
    body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  );
  CREATE INDEX idx_replies_post ON replies(post_id, id);
  CREATE TABLE attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL REFERENCES posts(id),
    reply_id INTEGER REFERENCES replies(id),
    uploader_upn TEXT NOT NULL REFERENCES users(upn),
    filename TEXT NOT NULL,
    size INTEGER NOT NULL,
    mime TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    object_key TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  );
  CREATE INDEX idx_attachments_post ON attachments(post_id, id);
  CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL REFERENCES posts(id),
    mention_id INTEGER REFERENCES mentions(id),
    reply_id INTEGER REFERENCES replies(id),
    type TEXT NOT NULL,
    actor_upn TEXT NOT NULL,
    target_upn TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  );
  CREATE INDEX idx_events_post ON events(post_id, id);
  `,
  // v2：手动项目 + 成员/邀请
  `
  ALTER TABLE projects ADD COLUMN kind TEXT NOT NULL DEFAULT 'git';
  ALTER TABLE projects ADD COLUMN description TEXT;
  ALTER TABLE projects ADD COLUMN owner_upn TEXT REFERENCES users(upn);
  CREATE TABLE project_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id),
    user_upn TEXT NOT NULL REFERENCES users(upn),
    role TEXT NOT NULL DEFAULT 'member',
    status TEXT NOT NULL DEFAULT 'invited',
    invited_by TEXT REFERENCES users(upn),
    invite_token TEXT UNIQUE,
    invited_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    joined_at TEXT,
    UNIQUE(project_id, user_upn)
  );
  CREATE INDEX idx_members_user ON project_members(user_upn, status);
  `,
  // v3：用户自定义通知邮箱
  `ALTER TABLE users ADD COLUMN notify_email TEXT;`,
  // v4：本地登录的密码哈希（AUTH_MODE=local）
  `ALTER TABLE users ADD COLUMN password_hash TEXT;`,
  // v5：本地注册的邮箱验证（点链接前不建 users 行）
  `
  CREATE TABLE signup_verifications (
    token TEXT PRIMARY KEY,
    upn TEXT NOT NULL,
    display_name TEXT NOT NULL,
    mail TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    expires_at TEXT NOT NULL
  );
  `,
  // v6：发帖/回帖前的 LLM 安全审计记录（被拦的内容不会进 posts/replies，这里留个底）
  `
  CREATE TABLE content_audits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    actor_upn TEXT NOT NULL,
    project_slug TEXT,
    title TEXT,
    excerpt TEXT NOT NULL,
    body_sha256 TEXT NOT NULL,
    verdict TEXT NOT NULL,
    categories TEXT NOT NULL,
    reason TEXT,
    model TEXT,
    latency_ms INTEGER,
    error TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  );
  CREATE INDEX idx_content_audits_verdict ON content_audits(verdict, id);
  `,
]

export function openDb(file?: string): DB {
  const dbFile = file ?? path.join(config.dataDir, 'agent-bbs.sqlite')
  if (dbFile !== ':memory:') fs.mkdirSync(path.dirname(dbFile), { recursive: true })
  const db = new Database(dbFile)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')
  migrate(db)
  return db
}

function migrate(db: DB) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)`)
  // 表里始终只保留一行
  if (!db.prepare('SELECT 1 FROM schema_version').get()) db.prepare('INSERT INTO schema_version(version) VALUES (0)').run()
  const version = (db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v
  for (let i = version; i < MIGRATIONS.length; i++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[i])
      db.prepare('UPDATE schema_version SET version = ?').run(i + 1)
    })()
  }
}

/** 与 SQLite 默认值同格式的 UTC 时间：2026-09-21T14:21:35Z */
export function now(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}
