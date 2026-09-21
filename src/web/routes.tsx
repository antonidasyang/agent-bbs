import { Hono } from 'hono'
import type { Env } from '../auth/actor.js'
import { requireSession } from '../auth/actor.js'
import { Layout, StatusBadge } from './layout.js'
import { renderMarkdown } from './markdown.js'
import { config } from '../config.js'
import { localPart } from '../core/users.js'
import { listProjectsForUser, getProject, listProjects } from '../core/projects.js'
import { createToken, listTokens, revokeToken } from '../core/tokens.js'
import * as posts from '../core/posts.js'
import * as svc from '../core/service.js'
import { badRequest, AppError } from '../core/errors.js'
import type { MentionStatus } from '../core/types.js'
import { DOCS_HTML } from './docs.js'

export const web = new Hono<Env>()
web.use('*', requireSession)

// 网页 POST 的 CSRF：cookie 是 SameSite=Lax，再加一道同源检查
web.use('*', async (c, next) => {
  if (c.req.method === 'POST') {
    const site = c.req.header('sec-fetch-site')
    const origin = c.req.header('origin')
    const ok = site ? site === 'same-origin' || site === 'none' : !origin || origin === new URL(config.baseUrl).origin || origin === new URL(c.req.url).origin
    if (!ok) throw new AppError(403, '跨站请求被拒绝')
  }
  await next()
})

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
  return c.html(
    <Layout title="版块" actor={actor} flash={flashOf(c)}>
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
                <th>git url</th>
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
          <a href="/posts/new">+ 发新帖</a>
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
  return c.html(
    <Layout title={project.name} actor={actor} flash={flashOf(c)}>
      <h1>
        {project.name} <span class="muted small">{project.slug}</span>
      </h1>
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
                        {m.target_name} <StatusBadge status={m.status} />
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

// ---------- 发帖 ----------
web.get('/posts/new', (c) => {
  const db = c.get('db')
  const actor = c.get('actor')
  const projects = listProjects(db)
  const selected = c.req.query('project') ? Number(c.req.query('project')) : undefined
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
                {p.name} — {p.slug}
              </option>
            ))}
          </select>
          <label>标题</label>
          <input type="text" name="title" required maxlength={200} />
          <label>@ 谁（账号或姓名，多个用空格/逗号分开）</label>
          <input type="text" name="mentions" required placeholder="alice, 张三" />
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
    const { post } = posts.createPost(db, actor, { project, title: String(f['title'] ?? ''), body: String(f['body'] ?? ''), mentions })
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
              {m.target === me && m.status === 'pending' && act(m.mention_id, 'claim', '认领')}
              {(m.target === me || canManage) && (m.status === 'pending' || m.status === 'in_progress') && act(m.mention_id, 'done', '标记完成', 'primary')}
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
    posts.addReply(c.get('db'), c.get('actor'), id, String(f['body'] ?? ''))
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
          <p class="small">在你的项目目录里执行下面这条命令，把 Claude Code 接入 BBS（`X-Project` 自动取 git origin）：</p>
          <pre class="cmd">{`claude mcp add --transport http --scope local agent-bbs ${config.baseUrl}/mcp \\
  --header "Authorization: Bearer ${fresh}" \\
  --header "X-Project: $(git remote get-url origin)"`}</pre>
          <p class="small">
            然后在 Claude Code 里说「用 bbs_whoami 检查一下」确认接入成功。CLAUDE.md 模板见 <a href="/docs">接入说明</a>。
          </p>
        </div>
      )}
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
web.post('/tokens', async (c) => {
  const f = await c.req.parseBody()
  const { plain } = createToken(c.get('db'), c.get('actor').user.upn, String(f['name'] ?? '').trim() || 'default')
  return c.redirect(`/tokens?new=${encodeURIComponent(plain)}`)
})
web.post('/tokens/:id/revoke', (c) => {
  revokeToken(c.get('db'), c.get('actor').user.upn, idParam(c.req.param('id')))
  return redirectFlash(c, '/tokens', '已吊销')
})

// ---------- 接入说明 ----------
web.get('/docs', (c) => {
  const actor = c.get('actor')
  return c.html(
    <Layout title="接入说明" actor={actor}>
      <div class="card md" dangerouslySetInnerHTML={{ __html: DOCS_HTML }} />
    </Layout>,
  )
})
