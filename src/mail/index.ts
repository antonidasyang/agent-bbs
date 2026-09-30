import nodemailer from 'nodemailer'
import type { Transporter } from 'nodemailer'
import { config } from '../config.js'
import type { DB } from '../db/index.js'
import type { Event } from '../core/types.js'
import { getPost, getMention, listMentions, onEvent } from '../core/posts.js'
import { getUser, localPart, mailAddressOf } from '../core/users.js'

let transporter: Transporter | null = null

export function mailEnabled(): boolean {
  return !!config.smtp.host
}

function getTransporter(): Transporter {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
    })
  }
  return transporter
}

/** 发送失败抛错（注册验证邮件这类必须送达的场景用） */
export async function sendMailOrThrow(to: string[], subject: string, text: string): Promise<void> {
  if (!mailEnabled()) throw new Error('SMTP 未配置')
  await getTransporter().sendMail({ from: config.smtp.from, to: to.join(', '), subject, text })
}

export async function sendMail(to: string[], subject: string, text: string): Promise<void> {
  if (!mailEnabled() || to.length === 0) return
  try {
    await sendMailOrThrow(to, subject, text)
  } catch (e) {
    console.error('[mail] send failed', to, subject, e)
  }
}

/** 三种事件即时发：被 @、完成/禁用、回帖。不合并。 */
function recipientsFor(db: DB, ev: Event): { to: string[]; subject: string; body: string } | null {
  const post = getPost(db, ev.post_id)
  if (!post) return null
  const actor = getUser(db, ev.actor_upn)
  const actorName = actor ? `${actor.display_name}(@${localPart(actor.upn)})` : ev.actor_upn
  const link = `${config.baseUrl}/posts/${post.id}`
  const tail = `\n\n查看：${link}\n\n—— agent-bbs 自动邮件`
  // 服务账号（其他平台）没有信箱，不发
  const mailOf = (upn: string): string | null => {
    const u = getUser(db, upn)
    if (u?.is_service) return null
    return u ? mailAddressOf(u) : upn
  }
  const add = (to: Set<string>, upn: string) => {
    const a = mailOf(upn)
    if (a) to.add(a)
  }

  switch (ev.type) {
    case 'mentioned': {
      if (!ev.target_upn) return null
      const m = ev.mention_id ? getMention(db, ev.mention_id) : undefined
      const agentId = m?.target_agent_id ? (db.prepare('SELECT agent_id FROM agents WHERE id = ?').get(m.target_agent_id) as { agent_id: string } | undefined)?.agent_id : undefined
      const who = agentId ? `你的 agent「${agentId}」` : '你'
      const addr = mailOf(ev.target_upn)
      if (!addr) return null
      return {
        to: [addr],
        subject: `[agent-bbs] ${actorName} @ 了${who}：${post.title}`,
        body: `${actorName} 在帖子「${post.title}」中 @ 了${who}，${agentId ? `以 X-Agent: ${agentId} 接入的` : '你的'} AI 编程助手在对应项目里执行 bbs_inbox 即可看到。\n\n${post.body.slice(0, 2000)}${tail}`,
      }
    }
    case 'done':
    case 'disabled': {
      const mention = ev.mention_id ? getMention(db, ev.mention_id) : undefined
      const who = mention ? getUser(db, mention.target_upn) : undefined
      const label = ev.type === 'done' ? '已完成' : '已禁用'
      // 完成通知发帖人；禁用通知被 @ 的人和发帖人
      const to = new Set<string>()
      if (post.author_upn !== ev.actor_upn) add(to, post.author_upn)
      if (ev.type === 'disabled' && mention && mention.target_upn !== ev.actor_upn) add(to, mention.target_upn)
      return {
        to: [...to],
        subject: `[agent-bbs] ${label}：${post.title}`,
        body: `${actorName} 将「${post.title}」中给 ${who ? who.display_name : '?'} 的任务标记为${label}。${mention?.note ? `\n\n说明：\n${mention.note}` : ''}${tail}`,
      }
    }
    case 'replied': {
      const reply = ev.reply_id ? (db.prepare('SELECT body FROM replies WHERE id = ?').get(ev.reply_id) as { body: string } | undefined) : undefined
      // 帖子相关的所有人（发帖人 + 被 @ 的人），除了回帖者自己
      const to = new Set<string>()
      if (post.author_upn !== ev.actor_upn) add(to, post.author_upn)
      for (const m of listMentions(db, post.id)) if (m.target_upn !== ev.actor_upn && m.status !== 'disabled') add(to, m.target_upn)
      return {
        to: [...to],
        subject: `[agent-bbs] ${actorName} 回复了：${post.title}`,
        body: `${reply?.body.slice(0, 3000) ?? ''}${tail}`,
      }
    }
    default:
      return null
  }
}

export function installMailNotifier() {
  if (!mailEnabled()) {
    console.log('[mail] SMTP_HOST 未配置，邮件通知关闭')
    return
  }
  onEvent((db, ev) => {
    const m = recipientsFor(db, ev)
    if (m && m.to.length) void sendMail(m.to, m.subject, m.body)
  })
}

/** 邀请邮件：由调用方（网页）在邀请成功后触发 */
export function sendInviteMails(db: DB, inviter: { display_name: string; upn: string }, project: { name: string; description: string | null }, invited: { user: { upn: string; mail: string | null; notify_email: string | null }; token: string }[]) {
  for (const { user, token } of invited) {
    const link = `${config.baseUrl}/invite/${token}`
    void sendMail(
      [mailAddressOf(user)],
      `[agent-bbs] ${inviter.display_name} 邀请你加入项目「${project.name}」`,
      `${inviter.display_name}(@${localPart(inviter.upn)}) 邀请你加入 agent-bbs 项目「${project.name}」。${project.description ? `\n\n${project.description}` : ''}\n\n加入后你和你的 Claude Code 就可以在这个项目里互相 @ 对方派任务。点击链接接受（需要用公司账号登录）：\n${link}\n\n—— agent-bbs 自动邮件`,
    )
  }
}
