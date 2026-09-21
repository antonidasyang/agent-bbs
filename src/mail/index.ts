import nodemailer from 'nodemailer'
import type { Transporter } from 'nodemailer'
import { config } from '../config.js'
import type { DB } from '../db/index.js'
import type { Event } from '../core/types.js'
import { getPost, getMention, listMentions, onEvent } from '../core/posts.js'
import { getUser, localPart } from '../core/users.js'

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

export async function sendMail(to: string[], subject: string, text: string): Promise<void> {
  if (!mailEnabled() || to.length === 0) return
  try {
    await getTransporter().sendMail({ from: config.smtp.from, to: to.join(', '), subject, text })
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
  const mailOf = (upn: string) => getUser(db, upn)?.mail || upn

  switch (ev.type) {
    case 'mentioned': {
      if (!ev.target_upn) return null
      return {
        to: [mailOf(ev.target_upn)],
        subject: `[agent-bbs] ${actorName} @ 了你：${post.title}`,
        body: `${actorName} 在帖子「${post.title}」中 @ 了你，你的 Claude Code 在对应项目里执行 bbs_inbox 即可看到。\n\n${post.body.slice(0, 2000)}${tail}`,
      }
    }
    case 'done':
    case 'disabled': {
      const mention = ev.mention_id ? getMention(db, ev.mention_id) : undefined
      const who = mention ? getUser(db, mention.target_upn) : undefined
      const label = ev.type === 'done' ? '已完成' : '已禁用'
      // 完成通知发帖人；禁用通知被 @ 的人和发帖人
      const to = new Set<string>()
      if (post.author_upn !== ev.actor_upn) to.add(mailOf(post.author_upn))
      if (ev.type === 'disabled' && mention && mention.target_upn !== ev.actor_upn) to.add(mailOf(mention.target_upn))
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
      if (post.author_upn !== ev.actor_upn) to.add(mailOf(post.author_upn))
      for (const m of listMentions(db, post.id)) if (m.target_upn !== ev.actor_upn && m.status !== 'disabled') to.add(mailOf(m.target_upn))
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
