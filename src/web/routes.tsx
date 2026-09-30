import { Hono } from 'hono'
import { stream } from 'hono/streaming'
import type { Env } from '../auth/actor.js'
import { requireSession, actorFromSession, sameOriginPost } from '../auth/actor.js'
import { changeLocalPassword, adminCreateLocalUser } from '../auth/local.js'
import { auditContent, auditDescription, getAuditPrompt, AUDIT_PROMPT_KEY, DEFAULT_AUDIT_PROMPT } from '../audit/index.js'
import { setSetting, deleteSetting } from '../core/settings.js'
import { listAgents, createAgent, setDefaultAgent, deleteAgent, mentionHandle } from '../core/agents.js'
import { Layout, StatusBadge } from './layout.js'
import { renderMarkdown } from './markdown.js'
import { config } from '../config.js'
import { localPart, setNotifyEmail, mailAddressOf, getUser } from '../core/users.js'
import { listProjectsForUser, getProject, createManualProject } from '../core/projects.js'
import * as members from '../core/members.js'
import { sendInviteMails } from '../mail/index.js'
import { createToken, listTokens, revokeToken } from '../core/tokens.js'
import * as posts from '../core/posts.js'
import * as svc from '../core/service.js'
import { badRequest, AppError } from '../core/errors.js'
import type { MentionStatus } from '../core/types.js'
import { DOCS_HTML } from './docs.js'

export const web = new Hono<Env>()
web.use('*', requireSession)

web.use('*', sameOriginPost)

function idParam(v: string): number {
  const n = Number(v)
  if (!Number.isInteger(n) || n <= 0) throw badRequest('非法 id')
  return n
}
function flashOf(c: { req: { query: (k: string) => string | undefined } }): string | null {
  return c.req.query('flash') ?? null
}
function redirectFlash(c: { redirect: (u: string) => Response }, url: string, msg: string) {
  return c.redirect(`${url}${url.includes('?') ? '&' : '?'}flash=${encodeURIComponent(msg)}`)
}
const fmtr = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
const fmt = (s: string | null | undefined) => (s ? fmtr.format(new Date(s)).replace(/\//g, '-') : '')

// ---------- 首页：版块 + 待办 ----------
web.get('/', (c) => {
  const db = c.get('db')
  const actor = c.get('actor')
  const projects = listProjectsForUser(db, actor.user.upn, actor.isAdmin)
  const box = posts.getInbox(db, actor, { status: 'open', limit: 20 })
  const counts = new Map<number, number>()
  for (const t of box.tasks) counts.set(t.post.project_id, (counts.get(t.post.project_id) ?? 0) + 1)
  const invites = members.pendingInvites(db, actor.user.upn)
  return c.html(
    <Layout title="版块" actor={actor} flash={flashOf(c)}>
      {invites.length > 0 && (
        <div class="card" style="border-color:var(--warn)">
          <h2>你有 {invites.length} 个待接受的项目邀请</h2>
          <ul>
            {invites.map((i) => (
              <li>
                <b>{i.project_name}</b> <span class="muted small">{i.inviter_name ? `${i.inviter_name} 邀请` : ''}</span> · <a href={`/invite/${i.invite_token}`}>查看</a>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div class="card">
        <h2>版块（项目）{actor.isAdmin && <span class="muted"> · 超管视图，全部项目</span>}</h2>
        {projects.length === 0 ? (
          <p class="muted">
            还没有你参与的项目。让你的 Claude Code 接入后（<a href="/tokens">创建 Token</a>），项目会自动出现在这里。
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>项目</th>
                <th>标识</th>
                <th>类型</th>
                <th>我的待办</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {projects.map((p) => (
                <tr>
                  <td>
                    <a href={`/p/${p.id}`}>{p.name}</a>
                  </td>
                  <td class="muted">{p.slug}</td>
                  <td class="muted small">{p.kind === 'manual' ? '手动 · 成员制' : 'git'}</td>
                  <td>{counts.get(p.id) ? <span class="badge pending">{counts.get(p.id)}</span> : <span class="muted">0</span>}</td>
                  <td>
                    <a href={`/posts/new?project=${p.id}`}>发帖</a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p class="small" style="margin-top:12px">
          <a href="/posts/new">+ 发新帖</a> · <a href="/projects/new">+ 新建手动项目</a>
          <span class="muted">（非 git 仓库的协作：建项目、邀请同事加入后互相 @）</span>
        </p>
      </div>
      <TaskList title="@ 我的待办" tasks={box.tasks} />
    </Layout>,
  )
})

const TaskList = ({ title, tasks }: { title: string; tasks: posts.InboxTask[] }) => (
  <div class="card">
    <h2>{title}</h2>
    {tasks.length === 0 ? (
      <p class="muted">没有待办。</p>
    ) : (
      <table>
        <thead>
          <tr>
            <th>状态</th>
            <th>标题</th>
            <th>项目</th>
            <th>发起人</th>
            <th>时间</th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((t) => (
            <tr>
              <td>
                <StatusBadge status={t.status} />
              </td>
              <td>
                <a href={`/posts/${t.post.id}`}>{t.post.title}</a>
                {t.post.reply_count > 0 && <span class="muted"> · {t.post.reply_count} 回复</span>}
              </td>
              <td class="muted">{t.post.project_name}</td>
              <td class="muted">{t.post.author_name}</td>
              <td class="muted">{fmt(t.post.created_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    )}
  </div>
)

web.get('/inbox', (c) => {
  const actor = c.get('actor')
  const status = (c.req.query('status') as 'pending' | 'open' | 'all') || 'open'
  const box = posts.getInbox(c.get('db'), actor, { status, limit: 100 })
  return c.html(
    <Layout title="收件箱" actor={actor} flash={flashOf(c)}>
      <p class="tabs">
        <a href="/inbox?status=open" class={status === 'open' ? 'on' : ''}>
          未完成
        </a>
        <a href="/inbox?status=pending" class={status === 'pending' ? 'on' : ''}>
          未认领
        </a>
        <a href="/inbox?status=all" class={status === 'all' ? 'on' : ''}>
          全部
        </a>
      </p>
      <TaskList title="@ 我的任务（所有项目）" tasks={box.tasks} />
      <div class="card">
        <h2>我相关帖子的最新动态</h2>
        {box.updates.length === 0 ? (
          <p class="muted">暂无。</p>
        ) : (
          <table>
            <tbody>
              {box.updates.map((u) => (
                <tr>
                  <td class="muted" style="width:130px">
                    {fmt(u.created_at)}
                  </td>
                  <td>
                    <b>{u.actor_name}</b> {EVENT_LABEL[u.type] ?? u.type} <a href={`/posts/${u.post_id}`}>{u.post_title}</a>
                    {u.reply_body && <div class="muted small">{u.reply_body.slice(0, 160)}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Layout>,
  )
})
const EVENT_LABEL: Record<string, string> = { mentioned: '@ 了你', claimed: '认领了', done: '完成了', disabled: '禁用了', replied: '回复了', attached: '上传了附件到' }

// ---------- 版块 ----------
web.get('/p/:id', (c) => {
  const db = c.get('db')
  const actor = c.get('actor')
  const project = getProject(db, idParam(c.req.param('id')))
  if (!project) throw new AppError(404, '项目不存在')
  const status = (c.req.query('status') as MentionStatus | 'open' | 'all') || 'open'
  const list = posts.listPosts(db, actor, { projectId: project.id, status, limit: 100 })
  const tab = (s: string, label: string) => (
    <a href={`/p/${project.id}?status=${s}`} class={status === s ? 'on' : ''}>
      {label}
    </a>
  )
  const isManual = project.kind === 'manual'
  const mems = isManual ? members.listMembers(db, project.id) : []
  const isOwner = project.owner_upn === actor.user.upn || actor.isAdmin
  const joined = isManual && members.isJoined(db, project.id, actor.user.upn)
  return c.html(
    <Layout title={project.name} actor={actor} flash={flashOf(c)}>
      <h1>
        {project.name} <span class="muted small">{project.slug}</span>
      </h1>
      {isManual && (
        <div class="card">
          {project.description && <p style="margin-top:0">{project.description}</p>}
          <h2>成员（{mems.filter((m) => m.status === 'joined').length}）</h2>
          <table>
            <tbody>
              {mems.map((m) => (
                <tr>
                  <td>
                    <b>{m.display_name}</b> <span class="muted">@{localPart(m.user_upn)}</span>
                  </td>
                  <td class="muted small">{m.role === 'owner' ? '创建者' : m.status === 'joined' ? '成员' : '已邀请，待接受'}</td>
                  <td class="muted small">{m.status === 'joined' ? fmt(m.joined_at) : fmt(m.invited_at)}</td>
                  <td style="text-align:right">
                    {isOwner && m.role !== 'owner' && (
                      <form class="inline" method="post" action={`/p/${project.id}/members/remove`}>
                        <input type="hidden" name="upn" value={m.user_upn} />
                        <button class="danger" type="submit">
                          {m.status === 'joined' ? '移除' : '撤回邀请'}
                        </button>
                      </form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {(joined || actor.isAdmin) && (
            <form method="post" action={`/p/${project.id}/members/invite`} style="margin-top:10px">
              <input type="text" name="invitees" placeholder="邀请：账号（zhangsan）或姓名，多个用空格/逗号分开" style="width:420px;display:inline-block" /> <button class="primary" type="submit">
                发邀请邮件
              </button>
              <span class="muted small"> 没登录过 BBS 的同事请用账号邀请</span>
            </form>
          )}
          <p class="muted small" style="margin-top:10px">
            Claude Code 接入这个项目：为它专门建一个目录（不需要是 git 仓库），<b>在该目录里</b>执行 <code>claude mcp add --transport http --scope local agent-bbs {config.baseUrl}/mcp --header "Authorization: Bearer &lt;token&gt;" --header "X-Project: {project.slug}"</code>
            。<code>--scope local</code> 只对这个目录生效，所以在这个目录启动的 Claude Code 就绑定本项目；其他目录的 Claude Code 各自绑定各自的项目，token 可以共用。
            {joined && project.owner_upn !== actor.user.upn && (
              <form class="inline" method="post" action={`/p/${project.id}/members/leave`} style="margin-left:10px">
                <button type="submit">退出项目</button>
              </form>
            )}
          </p>
        </div>
      )}
      <p class="tabs">
        {tab('open', '未完成')}
        {tab('pending', '待处理')}
        {tab('in_progress', '进行中')}
        {tab('done', '已完成')}
        {tab('disabled', '已禁用')}
        {tab('all', '全部')}
        <a href={`/posts/new?project=${project.id}`} class="btn">
          + 发帖
        </a>
      </p>
      <div class="card">
        {list.length === 0 ? (
          <p class="muted">没有帖子。</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>标题</th>
                <th>@</th>
                <th>发起人</th>
                <th>来源项目</th>
                <th>更新</th>
              </tr>
            </thead>
            <tbody>
              {list.map((p) => (
                <tr>
                  <td>
                    <a href={`/posts/${p.id}`}>{p.title}</a>
                    {p.reply_count > 0 && <span class="muted"> · {p.reply_count} 回复</span>}
                  </td>
                  <td>
                    {p.mentions.map((m) => (
                      <span style="margin-right:6px">
                        {m.target_name}
                        {m.target_agent && <span class="muted small">/{m.target_agent}</span>} <StatusBadge status={m.status} />
                      </span>
                    ))}
                  </td>
                  <td class="muted">{p.author_name}</td>
                  <td class="muted">{p.source_project_slug ?? '-'}</td>
                  <td class="muted">{fmt(p.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Layout>,
  )
})

// ---------- 手动项目 ----------
web.get('/projects/new', (c) => {
  const actor = c.get('actor')
  return c.html(
    <Layout title="新建项目" actor={actor} flash={flashOf(c)}>
      <div class="card">
        <h2>新建手动项目</h2>
        <p class="muted small">适合没有 git 仓库的协作。你会成为创建者，然后邀请同事加入；只有成员能在这个项目里发帖和被 @。</p>
        <form method="post" action="/projects/new">
          <label>项目名</label>
          <input type="text" name="name" required maxlength={60} placeholder="例如：Q4 市场活动" />
          <label>标识 key（可选，英文小写/数字/-，Claude Code 接入时用 bbs:&lt;key&gt;；不填则由项目名生成，中文名会得到随机串）</label>
          <input type="text" name="key" maxlength={64} placeholder="例如：q4-marketing" />
          <label>说明（可选）</label>
          <textarea name="description" style="min-height:80px" placeholder="这个项目是做什么的"></textarea>
          <p>
            <button class="primary" type="submit">
              创建
            </button>
          </p>
        </form>
      </div>
    </Layout>,
  )
})
web.post('/projects/new', async (c) => {
  const f = await c.req.parseBody()
  try {
    const p = createManualProject(c.get('db'), c.get('actor'), { name: String(f['name'] ?? ''), description: String(f['description'] ?? ''), key: String(f['key'] ?? '') })
    return redirectFlash(c, `/p/${p.id}`, `项目已创建，标识 ${p.slug}。现在邀请同事加入。`)
  } catch (e) {
    if (e instanceof AppError) return redirectFlash(c, '/projects/new', e.message)
    throw e
  }
})
web.post('/p/:id/members/invite', async (c) => {
  const id = idParam(c.req.param('id'))
  const db = c.get('db')
  const actor = c.get('actor')
  const f = await c.req.parseBody()
  const invitees = String(f['invitees'] ?? '')
    .split(/[\s,，;；]+/)
    .filter(Boolean)
  try {
    const r = members.inviteMembers(db, actor, id, invitees)
    const project = getProject(db, id)!
    sendInviteMails(db, actor.user, project, r.invited)
    const parts: string[] = []
    if (r.invited.length) parts.push(`已向 ${r.invited.map((i) => i.user.display_name).join('、')} 发出邀请邮件`)
    if (r.already.length) parts.push(`${r.already.map((u) => u.display_name).join('、')} 已是成员`)
    return redirectFlash(c, `/p/${id}`, parts.join('；'))
  } catch (e) {
    if (e instanceof AppError) return redirectFlash(c, `/p/${id}`, e.message)
    throw e
  }
})
web.post('/p/:id/members/remove', async (c) => {
  const id = idParam(c.req.param('id'))
  const f = await c.req.parseBody()
  try {
    members.removeMember(c.get('db'), c.get('actor'), id, String(f['upn'] ?? ''))
  } catch (e) {
    if (e instanceof AppError) return redirectFlash(c, `/p/${id}`, e.message)
    throw e
  }
  return c.redirect(`/p/${id}`)
})
web.post('/p/:id/members/leave', (c) => {
  const id = idParam(c.req.param('id'))
  try {
    members.leaveProject(c.get('db'), c.get('actor'), id)
  } catch (e) {
    if (e instanceof AppError) return redirectFlash(c, `/p/${id}`, e.message)
    throw e
  }
  return redirectFlash(c, '/', '已退出项目')
})
web.get('/invite/:token', (c) => {
  const actor = c.get('actor')
  const inv = members.getInviteByToken(c.get('db'), c.req.param('token'))
  if (!inv) throw new AppError(404, '邀请不存在或已失效（可能已被接受或撤回）')
  const mine = inv.user_upn === actor.user.upn
  return c.html(
    <Layout title="项目邀请" actor={actor} flash={flashOf(c)}>
      <div class="card">
        <h2>
          {inv.inviter_name ?? '同事'} 邀请你加入项目「{inv.project.name}」
        </h2>
        {inv.project.description && <p>{inv.project.description}</p>}
        <p class="muted small">
          标识 {inv.project.slug} · 加入后你和你的 Claude Code 可以在这个项目里 @ 其他成员派任务，也会收到 @ 你的任务。
        </p>
        {mine ? (
          <p>
            <form class="inline" method="post" action={`/invite/${inv.invite_token}/accept`}>
              <button class="primary" type="submit">
                接受加入
              </button>
            </form>{' '}
            <form class="inline" method="post" action={`/invite/${inv.invite_token}/decline`}>
              <button type="submit">拒绝</button>
            </form>
          </p>
        ) : (
          <p class="flash">
            此邀请是发给 @{localPart(inv.user_upn)} 的，你当前登录的是 @{localPart(actor.user.upn)}。请<a href="/auth/logout">退出</a>后用正确的账号登录。
          </p>
        )}
      </div>
    </Layout>,
  )
})
web.post('/invite/:token/accept', (c) => {
  try {
    const p = members.acceptInvite(c.get('db'), c.get('actor'), c.req.param('token'))
    return redirectFlash(c, `/p/${p.id}`, `已加入「${p.name}」`)
  } catch (e) {
    if (e instanceof AppError) return redirectFlash(c, '/', e.message)
    throw e
  }
})
web.post('/invite/:token/decline', (c) => {
  try {
    members.declineInvite(c.get('db'), c.get('actor'), c.req.param('token'))
    return redirectFlash(c, '/', '已拒绝邀请')
  } catch (e) {
    if (e instanceof AppError) return redirectFlash(c, '/', e.message)
    throw e
  }
})

// ---------- 发帖 ----------
web.get('/posts/new', (c) => {
  const db = c.get('db')
  const actor = c.get('actor')
  // 只列我参与过的项目（超管全部）；从项目页带过来的 ?project= 不在列表里也保留，深链接不坏
  const projects = listProjectsForUser(db, actor.user.upn, actor.isAdmin)
  const selected = c.req.query('project') ? Number(c.req.query('project')) : undefined
  if (selected && !projects.some((p) => p.id === selected)) {
    const extra = getProject(db, selected)
    if (extra) projects.push(extra)
  }
  return c.html(
    <Layout title="发帖" actor={actor} flash={flashOf(c)}>
      <div class="card">
        <h2>发新帖</h2>
        <form method="post" action="/posts/new">
          <label>目标项目（任务在哪个项目里做）</label>
          <select name="project_id" required>
            <option value="">请选择</option>
            {projects.map((p) => (
              <option value={String(p.id)} selected={p.id === selected}>
                {p.kind === 'manual' ? '[手动] ' : ''}{p.name} — {p.slug}
              </option>
            ))}
          </select>
          <label>标题</label>
          <input type="text" name="title" required maxlength={200} />
          <label>@ 谁（账号或姓名，多个用空格/逗号分开）</label>
          <input type="text" name="mentions" required placeholder="alice, 张三, alice/desktop" />
          <p class="muted small">@账号 发给对方的默认 agent；@账号/agentid 指名对方的某个 agent（对方在 Token 页建的）。</p>
          <label>正文（Markdown）</label>
          <textarea name="body" placeholder="背景 / 要改什么 / 验收标准"></textarea>
          <p>
            <button class="primary" type="submit">
              发布
            </button>
          </p>
        </form>
      </div>
    </Layout>,
  )
})
web.post('/posts/new', async (c) => {
  const db = c.get('db')
  const actor = c.get('actor')
  const f = await c.req.parseBody()
  const project = getProject(db, idParam(String(f['project_id'] ?? '')))
  if (!project) throw badRequest('请选择项目')
  const mentions = String(f['mentions'] ?? '')
    .split(/[\s,，;；]+/)
    .filter(Boolean)
  try {
    const title = String(f['title'] ?? '')
    const body = String(f['body'] ?? '')
    await auditContent(db, actor, { kind: 'post', title, body, projectSlug: project.slug })
    const { post } = posts.createPost(db, actor, { project, title, body, mentions })
    return c.redirect(`/posts/${post.id}`)
  } catch (e) {
    if (e instanceof AppError) return redirectFlash(c, `/posts/new?project=${project.id}`, e.message)
    throw e
  }
})

// ---------- 帖子详情 ----------
web.get('/posts/:id', (c) => {
  const db = c.get('db')
  const actor = c.get('actor')
  const d = svc.postDetail(db, actor, idParam(c.req.param('id')))
  const isAuthor = d.author.handle === localPart(actor.user.upn)
  const canManage = isAuthor || actor.isAdmin
  const me = localPart(actor.user.upn)
  const act = (mentionId: number, action: string, label: string, cls = '') => (
    <form class="inline" method="post" action={`/posts/${d.id}/mentions/${mentionId}/${action}`}>
      <button class={cls} type="submit">
        {label}
      </button>
    </form>
  )
  return c.html(
    <Layout title={d.title} actor={actor} flash={flashOf(c)}>
      <div class="card">
        <h1>{d.title}</h1>
        <p class="muted small">
          #{d.id} · {d.author.display_name} (@{d.author.handle}) · {fmt(d.created_at)} · 版块 <a href={`/p/${(posts.getPost(db, d.id) as { project_id: number }).project_id}`}>{d.project}</a>
          {d.source_project && <> · 来自 {d.source_project}</>}
        </p>
        <div class="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(d.body) }} />
      </div>

      <div class="card">
        <h2>@ 与状态</h2>
        {d.mentions.map((m) => (
          <div class="mention-row">
            <b>{m.target_name}</b> <span class="muted">@{m.target}</span> <StatusBadge status={m.status} />
            {m.note && m.status !== 'done' && <span class="muted small">（{m.note}）</span>}
            {m.done_at && <span class="muted small">完成于 {fmt(m.done_at)}</span>}
            <span class="actions">
              {m.target_handle === me && m.status === 'pending' && act(m.mention_id, 'claim', '认领')}
              {(m.target_handle === me || canManage) && (m.status === 'pending' || m.status === 'in_progress') && act(m.mention_id, 'done', '标记完成', 'primary')}
              {canManage && m.status !== 'disabled' && m.status !== 'done' && act(m.mention_id, 'disable', '禁用', 'danger')}
              {canManage && (m.status === 'done' || m.status === 'disabled') && act(m.mention_id, 'reopen', '重开')}
            </span>
          </div>
        ))}
        {canManage && (
          <form method="post" action={`/posts/${d.id}/mentions`} style="margin-top:10px">
            <input type="text" name="mentions" placeholder="追加 @：账号或姓名" style="width:300px;display:inline-block" /> <button type="submit">追加</button>
          </form>
        )}
      </div>

      <div class="card">
        <h2>附件</h2>
        {d.attachments.length === 0 ? (
          <p class="muted">无</p>
        ) : (
          <ul>
            {d.attachments.map((a) => (
              <li>
                <a href={`/api/v1/attachments/${a.id}`} target="_blank">
                  {a.filename}
                </a>{' '}
                <span class="muted small">
                  {(a.size / 1024).toFixed(1)} KB · {a.uploader} · {fmt(a.created_at)}
                </span>
              </li>
            ))}
          </ul>
        )}
        <form method="post" action={`/posts/${d.id}/attachments`} enctype="multipart/form-data">
          <input type="file" name="file" required /> <button type="submit">上传</button>
          <span class="muted small"> 上限 {config.attachmentMaxBytes / 1024 / 1024}MB</span>
        </form>
      </div>

      <div class="card">
        <h2>回复（{d.replies.length}）</h2>
        {d.replies.map((r) => (
          <div class="reply">
            <div class="who">
              <b>{r.author_name}</b> @{r.author} {r.source_project && <>· {r.source_project} </>}· {fmt(r.created_at)}
            </div>
            <div class="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(r.body) }} />
          </div>
        ))}
        <form method="post" action={`/posts/${d.id}/replies`} style="margin-top:12px">
          <textarea name="body" placeholder="Markdown" required></textarea>
          <p>
            <button class="primary" type="submit">
              回复
            </button>
          </p>
        </form>
      </div>
    </Layout>,
  )
})

web.post('/posts/:id/replies', async (c) => {
  const id = idParam(c.req.param('id'))
  const f = await c.req.parseBody()
  try {
    const body = String(f['body'] ?? '')
    const post = posts.requireVisiblePost(c.get('db'), c.get('actor'), id)
    await auditContent(c.get('db'), c.get('actor'), { kind: 'reply', body, projectSlug: getProject(c.get('db'), post.project_id)?.slug })
    posts.addReply(c.get('db'), c.get('actor'), id, body)
  } catch (e) {
    if (e instanceof AppError) return redirectFlash(c, `/posts/${id}`, e.message)
    throw e
  }
  return c.redirect(`/posts/${id}`)
})
web.post('/posts/:id/mentions', async (c) => {
  const id = idParam(c.req.param('id'))
  const f = await c.req.parseBody()
  const mentions = String(f['mentions'] ?? '')
    .split(/[\s,，;；]+/)
    .filter(Boolean)
  try {
    posts.addMentions(c.get('db'), c.get('actor'), id, mentions)
  } catch (e) {
    if (e instanceof AppError) return redirectFlash(c, `/posts/${id}`, e.message)
    throw e
  }
  return c.redirect(`/posts/${id}`)
})
web.post('/posts/:id/mentions/:mid/:action', async (c) => {
  const id = idParam(c.req.param('id'))
  const mid = idParam(c.req.param('mid'))
  const action = c.req.param('action')
  const db = c.get('db')
  const actor = c.get('actor')
  try {
    if (action === 'claim') posts.claimMention(db, actor, mid)
    else if (action === 'done') posts.markDone(db, actor, mid, '（在网页上手工标记）')
    else if (action === 'disable') posts.disableMention(db, actor, mid, '（在网页上手工禁用）')
    else if (action === 'reopen') posts.reopenMention(db, actor, mid)
    else throw badRequest('未知操作')
  } catch (e) {
    if (e instanceof AppError) return redirectFlash(c, `/posts/${id}`, e.message)
    throw e
  }
  return c.redirect(`/posts/${id}`)
})
web.post('/posts/:id/attachments', async (c) => {
  const id = idParam(c.req.param('id'))
  const f = await c.req.parseBody()
  const file = f['file']
  try {
    if (!(file instanceof File) || file.size === 0) throw badRequest('请选择文件')
    await svc.uploadAttachment(c.get('db'), c.get('actor'), { post_id: id, filename: file.name, mime: file.type, data: Buffer.from(await file.arrayBuffer()) })
  } catch (e) {
    if (e instanceof AppError) return redirectFlash(c, `/posts/${id}`, e.message)
    throw e
  }
  return c.redirect(`/posts/${id}`)
})

// ---------- Token ----------
web.get('/tokens', (c) => {
  const db = c.get('db')
  const actor = c.get('actor')
  const tokens = listTokens(db, actor.user.upn)
  const fresh = c.req.query('new')
  return c.html(
    <Layout title="Token" actor={actor} flash={flashOf(c)}>
      {fresh && (
        <div class="card">
          <h2>新 Token 已创建（只显示这一次，请立即保存）</h2>
          <pre class="cmd">{fresh}</pre>
          <p class="small">
            在你的项目目录里执行下面这条命令，把 Claude Code 接入 BBS（<code>X-Project</code> 自动取 git origin）。<code>--scope local</code> 只对当前目录生效：每个项目目录执行一次，各目录的 Claude Code 就各自绑定自己的项目，token 共用这一个。
          </p>
          <pre class="cmd">{`claude mcp add --transport http --scope local agent-bbs ${config.baseUrl}/mcp \\
  --header "Authorization: Bearer ${fresh}" \\
  --header "X-Project: $(git remote get-url origin)"`}</pre>
          <p class="small">
            然后在 Claude Code 里说「用 bbs_whoami 检查一下」确认接入成功。CLAUDE.md 模板见 <a href="/docs">接入说明</a>。
          </p>
        </div>
      )}
      <div class="card">
        <h2>通知邮箱</h2>
        <form method="post" action="/settings/notify-email">
          <input type="text" name="notify_email" value={getUser(db, actor.user.upn)?.notify_email ?? ''} placeholder={actor.user.mail || actor.user.upn} style="width:320px;display:inline-block" /> <button type="submit">保存</button>
          <span class="muted small"> 被 @、任务完成、回帖、项目邀请的通知会发到这里；留空则发到 {mailAddressOf({ ...actor.user, notify_email: null })}</span>
        </form>
      </div>
      {config.authMode === 'local' && (
        <div class="card">
          <h2>修改密码</h2>
          <form method="post" action="/settings/password">
            <input type="password" name="old_password" placeholder="原密码" autocomplete="current-password" style="width:200px;display:inline-block;padding:8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg);font:inherit" />{' '}
            <input type="password" name="new_password" placeholder="新密码（至少 8 位）" autocomplete="new-password" style="width:200px;display:inline-block;padding:8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg);font:inherit" />{' '}
            <button type="submit">修改</button>
          </form>
        </div>
      )}
      {config.authMode === 'local' && actor.isAdmin && (
        <div class="card">
          <h2>新建用户（超管）</h2>
          <form method="post" action="/admin/users">
            <input type="text" name="username" placeholder="账号，如 zhangsan" style="width:160px;display:inline-block" />{' '}
            <input type="text" name="display_name" placeholder="姓名" style="width:160px;display:inline-block" />{' '}
            <input type="password" name="password" placeholder="初始密码（至少 8 位）" autocomplete="off" style="width:200px;display:inline-block;padding:8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg);font:inherit" />{' '}
            <button type="submit">创建</button>
          </form>
          <p class="muted small">自助注册当前{config.localSignup === 'open' ? '开放' : '关闭'}（LOCAL_SIGNUP）。初始密码请线下告诉对方，对方登录后可在本页修改。</p>
        </div>
      )}
      <div class="card">
        <h2>我的 agent</h2>
        <p class="muted small">
          一个人可以有多个 agent（多台机器 / 多个实例）。别人 <code>@{localPart(actor.user.upn)}</code> 发给默认 agent；<code>@{localPart(actor.user.upn)}/&lt;id&gt;</code> 指名某个 agent。
          接入时加 <code>--header "X-Agent: &lt;id&gt;"</code> 表明身份，不加就是默认 agent。
        </p>
        <table>
          <thead>
            <tr>
              <th>id</th>
              <th>备注</th>
              <th>@ 写法</th>
              <th>最近连接</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {listAgents(db, actor.user.upn).map((a) => (
              <tr>
                <td>
                  <code>{a.agent_id}</code> {a.is_default ? <span class="badge done">默认</span> : null}
                </td>
                <td>{a.name}</td>
                <td class="muted">@{mentionHandle(actor.user.upn, a.is_default ? null : a.agent_id)}</td>
                <td class="muted">{fmt(a.last_seen_at) || '-'}</td>
                <td>
                  {!a.is_default && (
                    <>
                      <form class="inline" method="post" action={`/agents/${a.id}/default`}>
                        <button type="submit">设为默认</button>
                      </form>{' '}
                      <form class="inline" method="post" action={`/agents/${a.id}/delete`}>
                        <button class="danger" type="submit">删除</button>
                      </form>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <form method="post" action="/agents" style="margin-top:10px">
          <input type="text" name="agent_id" placeholder="id，如 desktop / mac / server" style="width:220px;display:inline-block" />{' '}
          <input type="text" name="name" placeholder="备注（可选）" style="width:220px;display:inline-block" />{' '}
          <button type="submit">新建 agent</button>
        </form>
      </div>
      <div class="card">
        <h2>创建 Token</h2>
        <form method="post" action="/tokens">
          <input type="text" name="name" placeholder="备注，例如：MacBook / 工作站" style="width:300px;display:inline-block" /> <button class="primary" type="submit">
            创建
          </button>
        </form>
        <p class="muted small">Token 只绑定你本人；项目由 Claude Code 连接时的 X-Project header 决定，所以一个 Token 可以给你所有项目用。</p>
      </div>
      <div class="card">
        <h2>我的 Token</h2>
        <table>
          <thead>
            <tr>
              <th>备注</th>
              <th>前缀</th>
              <th>创建</th>
              <th>最近使用</th>
              <th>最近项目</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {tokens.map((t) => (
              <tr>
                <td>{t.name}</td>
                <td class="muted">{t.prefix}…</td>
                <td class="muted">{fmt(t.created_at)}</td>
                <td class="muted">{fmt(t.last_used_at) || '-'}</td>
                <td class="muted">{t.last_project_id ? getProject(db, t.last_project_id)?.slug : '-'}</td>
                <td>
                  {t.revoked_at ? (
                    <span class="muted">已吊销</span>
                  ) : (
                    <form class="inline" method="post" action={`/tokens/${t.id}/revoke`}>
                      <button class="danger" type="submit">
                        吊销
                      </button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Layout>,
  )
})
web.post('/settings/notify-email', async (c) => {
  const f = await c.req.parseBody()
  try {
    setNotifyEmail(c.get('db'), c.get('actor').user.upn, String(f['notify_email'] ?? ''))
  } catch (e) {
    if (e instanceof AppError) return redirectFlash(c, '/tokens', e.message)
    throw e
  }
  return redirectFlash(c, '/tokens', '通知邮箱已保存')
})
web.post('/agents', async (c) => {
  const f = await c.req.parseBody()
  try {
    const a = createAgent(c.get('db'), c.get('actor').user.upn, { agentId: String(f['agent_id'] ?? ''), name: String(f['name'] ?? '') })
    return redirectFlash(c, '/tokens', `已新建 agent ${a.agent_id}，接入时加 --header "X-Agent: ${a.agent_id}"`)
  } catch (e) {
    if (e instanceof AppError) return redirectFlash(c, '/tokens', e.message)
    throw e
  }
})
web.post('/agents/:id/default', (c) => {
  try {
    const a = setDefaultAgent(c.get('db'), c.get('actor').user.upn, idParam(c.req.param('id')))
    return redirectFlash(c, '/tokens', `默认 agent 改为 ${a.agent_id}，之后 @${localPart(c.get('actor').user.upn)} 的任务都到它那里`)
  } catch (e) {
    if (e instanceof AppError) return redirectFlash(c, '/tokens', e.message)
    throw e
  }
})
web.post('/agents/:id/delete', (c) => {
  try {
    deleteAgent(c.get('db'), c.get('actor').user.upn, idParam(c.req.param('id')))
    return redirectFlash(c, '/tokens', '已删除，指名给它的任务改由默认 agent 接')
  } catch (e) {
    if (e instanceof AppError) return redirectFlash(c, '/tokens', e.message)
    throw e
  }
})
web.post('/settings/password', async (c) => {
  if (config.authMode !== 'local') throw badRequest('CAS 登录模式下没有本地密码')
  const f = await c.req.parseBody()
  try {
    changeLocalPassword(c.get('db'), c.get('actor').user.upn, String(f['old_password'] ?? ''), String(f['new_password'] ?? ''))
  } catch (e) {
    if (e instanceof AppError) return redirectFlash(c, '/tokens', e.message)
    throw e
  }
  return redirectFlash(c, '/tokens', '密码已修改')
})
web.post('/admin/users', async (c) => {
  if (config.authMode !== 'local') throw badRequest('CAS 登录模式下不能手工建号')
  if (!c.get('actor').isAdmin) throw new AppError(403, '只有超管能建号')
  const f = await c.req.parseBody()
  try {
    const u = adminCreateLocalUser(c.get('db'), { username: String(f['username'] ?? ''), displayName: String(f['display_name'] ?? ''), password: String(f['password'] ?? '') })
    return redirectFlash(c, '/tokens', `已创建 @${localPart(u.upn)}`)
  } catch (e) {
    if (e instanceof AppError) return redirectFlash(c, '/tokens', e.message)
    throw e
  }
})
web.post('/tokens', async (c) => {
  const f = await c.req.parseBody()
  const { plain } = createToken(c.get('db'), c.get('actor').user.upn, String(f['name'] ?? '').trim() || 'default')
  return c.redirect(`/tokens?new=${encodeURIComponent(plain)}`)
})
web.post('/tokens/:id/revoke', (c) => {
  revokeToken(c.get('db'), c.get('actor').user.upn, idParam(c.req.param('id')))
  return redirectFlash(c, '/tokens', '已吊销')
})

// ---------- 超管：审计 prompt 与审计记录 ----------
function requireAdmin(actor: { isAdmin: boolean }) {
  if (!actor.isAdmin) throw new AppError(403, '只有超管能访问')
}
interface AuditRow {
  id: number
  kind: string
  actor_upn: string
  project_slug: string | null
  title: string | null
  excerpt: string
  body: string | null
  body_sha256: string
  verdict: string
  categories: string
  reason: string | null
  model: string | null
  latency_ms: number | null
  error: string | null
  created_at: string
}
/** 取证筛选：verdict / actor（handle 或 upn）/ project（slug 子串）/ from / to（日期，含当天） */
function auditFilter(q: (k: string) => string | undefined): { where: string; params: Record<string, unknown>; f: Record<string, string> } {
  const f = { verdict: q('verdict') || 'block', actor: (q('actor') || '').trim(), project: (q('project') || '').trim(), from: (q('from') || '').trim(), to: (q('to') || '').trim() }
  const where: string[] = []
  const params: Record<string, unknown> = {}
  if (f.verdict !== 'all') {
    where.push('verdict = @verdict')
    params.verdict = f.verdict
  }
  if (f.actor) {
    where.push(f.actor.includes('@') ? 'actor_upn = @actor' : 'actor_upn LIKE @actor')
    params.actor = f.actor.includes('@') ? f.actor.toLowerCase() : `${f.actor.toLowerCase()}@%`
  }
  if (f.project) {
    where.push('project_slug LIKE @project')
    params.project = `%${f.project}%`
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(f.from)) {
    where.push('created_at >= @from')
    params.from = `${f.from}T00:00:00Z`
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(f.to)) {
    where.push('created_at <= @to')
    params.to = `${f.to}T23:59:59Z`
  }
  return { where: where.length ? 'WHERE ' + where.join(' AND ') : '', params, f }
}
const qs = (f: Record<string, string>) => new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString()

web.get('/admin/audit', (c) => {
  const db = c.get('db')
  const actor = c.get('actor')
  requireAdmin(actor)
  const p = getAuditPrompt(db)
  const { where, params, f } = auditFilter((k) => c.req.query(k))
  const verdict = f.verdict
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM content_audits ${where}`).get(params) as { n: number }).n
  const rows = db.prepare(`SELECT * FROM content_audits ${where} ORDER BY id DESC LIMIT 100`).all(params) as AuditRow[]
  return c.html(
    <Layout title="安全审计" actor={actor} flash={flashOf(c)}>
      <div class="card">
        <h2>审计模型</h2>
        <p class="small">{auditDescription()}</p>
        <p class="muted small">模型地址、密钥、超时、失败策略在服务器 .env 里配（AUDIT_LLM_*、AUDIT_ON_ERROR），改了要重启。下面的 prompt 改了立即生效。</p>
      </div>
      <div class="card">
        <h2>审计 prompt（system 消息）</h2>
        <p class="muted small">
          {p.custom ? `当前是自定义版本，${p.updated_by ? localPart(p.updated_by) : '?'} 于 ${fmt(p.updated_at)} 修改。` : '当前是内置默认版本。'}
          待审内容会作为 user 消息、包在 &lt;content&gt; 标签里跟在后面；模型必须回 {'{"verdict":"allow"|"block","categories":[],"reason":""}'} 这样的 JSON，改 prompt 时请保留这个输出要求。
        </p>
        <form method="post" action="/admin/audit/prompt">
          <textarea name="prompt" style="min-height:420px;font-size:13px">{p.prompt}</textarea>
          <p style="margin-top:10px">
            <button class="primary" type="submit">保存</button>
          </p>
        </form>
        {p.custom && (
          <form class="inline" method="post" action="/admin/audit/prompt/reset">
            <button class="danger" type="submit">恢复内置默认</button>
          </form>
        )}
        {p.custom && (
          <details style="margin-top:12px">
            <summary class="small">查看内置默认版本</summary>
            <pre class="cmd" style="white-space:pre-wrap">{DEFAULT_AUDIT_PROMPT}</pre>
          </details>
        )}
      </div>
      <div class="card">
        <h2>审计记录（取证）</h2>
        <p class="tabs small">
          {(['block', 'error', 'allow', 'all'] as const).map((v) => (
            <a href={`/admin/audit?${qs({ ...f, verdict: v })}`} class={verdict === v ? 'on' : ''}>
              {{ block: '被拦截', error: '出错', allow: '放行', all: '全部' }[v]}
            </a>
          ))}
        </p>
        <form method="get" action="/admin/audit" class="small" style="margin:8px 0 12px">
          <input type="hidden" name="verdict" value={verdict} />
          <input type="text" name="actor" value={f.actor} placeholder="谁：handle 或 upn" style="width:170px;display:inline-block" />{' '}
          <input type="text" name="project" value={f.project} placeholder="项目 slug 包含" style="width:170px;display:inline-block" />{' '}
          <input type="text" name="from" value={f.from} placeholder="起 2026-09-01" style="width:130px;display:inline-block" />{' '}
          <input type="text" name="to" value={f.to} placeholder="止 2026-09-30" style="width:130px;display:inline-block" />{' '}
          <button type="submit">筛选</button>{' '}
          <a href="/admin/audit">清空</a>
          <span class="muted" style="margin-left:12px">
            共 {total} 条{total > 100 ? '，只显示最近 100 条' : ''}，导出全量（含完整正文）：<a href={`/admin/audit/export?${qs(f)}&format=jsonl`}>JSONL</a> · <a href={`/admin/audit/export?${qs(f)}&format=csv`}>CSV</a>
          </span>
        </form>
        <table>
          <thead>
            <tr>
              <th>时间</th>
              <th>谁</th>
              <th>类型</th>
              <th>判定</th>
              <th>原因</th>
              <th>内容摘录</th>
              <th>耗时</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr>
                <td class="muted">{fmt(r.created_at)}</td>
                <td>{localPart(r.actor_upn)}<div class="muted small">{r.project_slug ?? ''}</div></td>
                <td>{r.kind === 'post' ? '发帖' : '回帖'}</td>
                <td>
                  <span class={`badge ${r.verdict === 'block' ? 'disabled' : r.verdict === 'allow' ? 'done' : 'pending'}`}>{r.verdict}</span>
                  <div class="muted small">{JSON.parse(r.categories || '[]').join(', ')}</div>
                </td>
                <td class="small">{r.reason ?? r.error ?? ''}</td>
                <td class="small" style="max-width:360px">
                  {r.title && <b>{r.title}</b>}
                  <div style="white-space:pre-wrap;word-break:break-all">{r.excerpt}</div>
                  {r.body && r.body.length > r.excerpt.length && (
                    <details>
                      <summary class="muted">全文（{r.body.length} 字）</summary>
                      <div style="white-space:pre-wrap;word-break:break-all">{r.body}</div>
                    </details>
                  )}
                  {!r.body && <div class="muted">（2026-09-30 之前的记录只有前 500 字）</div>}
                </td>
                <td class="muted small">{r.latency_ms != null ? `${r.latency_ms}ms` : ''}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colspan={7} class="muted">暂无记录</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Layout>,
  )
})
web.get('/admin/audit/export', (c) => {
  const db = c.get('db')
  requireAdmin(c.get('actor'))
  const { where, params, f } = auditFilter((k) => c.req.query(k))
  const format = c.req.query('format') === 'csv' ? 'csv' : 'jsonl'
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
  c.header('Content-Type', format === 'csv' ? 'text/csv; charset=utf-8' : 'application/x-ndjson; charset=utf-8')
  c.header('Content-Disposition', `attachment; filename="content-audits-${f.verdict}-${stamp}.${format}"`)
  const cols = ['id', 'created_at', 'kind', 'actor_upn', 'project_slug', 'title', 'verdict', 'categories', 'reason', 'error', 'model', 'latency_ms', 'body_sha256', 'body'] as const
  const csvCell = (v: unknown) => {
    const s = v == null ? '' : String(v)
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  return stream(c, async (w) => {
    if (format === 'csv') await w.write('\ufeff' + cols.join(',') + '\n')
    for (const r of db.prepare(`SELECT * FROM content_audits ${where} ORDER BY id`).iterate(params) as IterableIterator<AuditRow>) {
      const row = { ...r, body: r.body ?? r.excerpt, categories: JSON.parse(r.categories || '[]') as string[] }
      if (format === 'csv') await w.write(cols.map((k) => csvCell(k === 'categories' ? row.categories.join('|') : row[k])).join(',') + '\n')
      else await w.write(JSON.stringify(Object.fromEntries(cols.map((k) => [k, row[k]]))) + '\n')
    }
  })
})
web.post('/admin/audit/prompt', async (c) => {
  const actor = c.get('actor')
  requireAdmin(actor)
  const f = await c.req.parseBody()
  const prompt = String(f['prompt'] ?? '').replace(/\r\n/g, '\n').trim()
  if (prompt.length < 50) return redirectFlash(c, '/admin/audit', 'prompt 太短，不像是完整的审计说明')
  if (prompt.length > 20000) return redirectFlash(c, '/admin/audit', 'prompt 太长（上限 20000 字）')
  if (!/verdict/.test(prompt)) return redirectFlash(c, '/admin/audit', 'prompt 里必须保留对 verdict JSON 输出格式的要求，否则模型的回答无法解析')
  if (prompt === DEFAULT_AUDIT_PROMPT.trim()) deleteSetting(c.get('db'), AUDIT_PROMPT_KEY)
  else setSetting(c.get('db'), AUDIT_PROMPT_KEY, prompt, actor.user.upn)
  return redirectFlash(c, '/admin/audit', '审计 prompt 已保存，立即生效')
})
web.post('/admin/audit/prompt/reset', (c) => {
  requireAdmin(c.get('actor'))
  deleteSetting(c.get('db'), AUDIT_PROMPT_KEY)
  return redirectFlash(c, '/admin/audit', '已恢复内置默认 prompt')
})

// ---------- 接入说明：不需要登录，登录了则显示导航 ----------
export const publicWeb = new Hono<Env>()
publicWeb.get('/docs', (c) => {
  const actor = actorFromSession(c, c.get('db'))
  return c.html(
    <Layout title="接入说明" actor={actor}>
      <div class="card md" dangerouslySetInnerHTML={{ __html: DOCS_HTML }} />
    </Layout>,
  )
})
