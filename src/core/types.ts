export interface User {
  upn: string
  display_name: string
  mail: string | null
  department: string | null
  /** 用户自己填的通知邮箱，优先于 CAS 的 mail 和 UPN */
  notify_email: string | null
  /** AUTH_MODE=local 时的 scrypt 密码哈希；CAS 用户和占位用户为 null */
  password_hash: string | null
  created_at: string
  last_login_at: string | null
}

export type ProjectKind = 'git' | 'manual'

export interface Project {
  id: number
  slug: string
  raw_url: string
  name: string
  kind: ProjectKind
  description: string | null
  owner_upn: string | null
  created_at: string
}

export type MemberRole = 'owner' | 'member'
export type MemberStatus = 'invited' | 'joined'

export interface ProjectMember {
  id: number
  project_id: number
  user_upn: string
  role: MemberRole
  status: MemberStatus
  invited_by: string | null
  invite_token: string | null
  invited_at: string
  joined_at: string | null
}

export interface Token {
  id: number
  user_upn: string
  name: string
  hash: string
  prefix: string
  created_at: string
  last_used_at: string | null
  last_project_id: number | null
  revoked_at: string | null
}

export type MentionStatus = 'pending' | 'in_progress' | 'done' | 'disabled'

export interface Post {
  id: number
  project_id: number
  author_upn: string
  source_project_id: number | null
  title: string
  body: string
  created_at: string
  updated_at: string
}

export interface Mention {
  id: number
  post_id: number
  target_upn: string
  status: MentionStatus
  claimed_at: string | null
  done_at: string | null
  note: string | null
  updated_at: string
}

export interface Reply {
  id: number
  post_id: number
  author_upn: string
  source_project_id: number | null
  body: string
  created_at: string
}

export interface Attachment {
  id: number
  post_id: number
  reply_id: number | null
  uploader_upn: string
  filename: string
  size: number
  mime: string
  sha256: string
  object_key: string
  created_at: string
}

export type EventType = 'mentioned' | 'claimed' | 'done' | 'disabled' | 'replied' | 'attached'

export interface Event {
  id: number
  post_id: number
  mention_id: number | null
  reply_id: number | null
  type: EventType
  actor_upn: string
  target_upn: string | null
  created_at: string
}

/** 一次请求的身份：谁 + 在哪个项目（人类会话没有项目） */
export interface Actor {
  user: User
  isAdmin: boolean
  project: Project | null
  via: 'session' | 'token'
  tokenId?: number
}
