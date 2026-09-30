import type { FC, PropsWithChildren } from 'hono/jsx'
import type { Actor } from '../core/types.js'
import { localPart } from '../core/users.js'

const CSS = `
:root{--bg:#f6f7f9;--card:#fff;--fg:#1f2328;--muted:#6b7280;--line:#e5e7eb;--accent:#2563eb;--ok:#16a34a;--warn:#d97706;--bad:#dc2626;--dis:#9ca3af}
@media(prefers-color-scheme:dark){:root{--bg:#0f1115;--card:#171a21;--fg:#e6e8eb;--muted:#9aa3ad;--line:#2a2f3a;--accent:#60a5fa}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 "PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC","Source Han Sans SC",system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
b,strong,h1,h2,h3,.brand{font-weight:600}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
header{background:var(--card);border-bottom:1px solid var(--line);padding:0 16px}
header .in{max-width:1100px;margin:0 auto;display:flex;align-items:center;gap:20px;height:52px}
header .brand{color:var(--fg)}header .sp{flex:1}header .me{color:var(--muted);font-size:13px}
main{max-width:1100px;margin:0 auto;padding:20px 16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:16px;margin-bottom:16px}
h1{font-size:22px;margin:0 0 12px}h2{font-size:17px;margin:0 0 10px}h3{font-size:15px;margin:16px 0 6px}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:8px 6px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-weight:500;font-size:13px}
.muted{color:var(--muted);font-size:13px}.small{font-size:13px}
.badge{display:inline-block;padding:1px 8px;border-radius:999px;font-size:12px;border:1px solid var(--line);color:var(--muted);white-space:nowrap}
.badge.pending{color:var(--warn);border-color:var(--warn)}.badge.in_progress{color:var(--accent);border-color:var(--accent)}
.badge.done{color:var(--ok);border-color:var(--ok)}.badge.disabled{color:var(--dis);text-decoration:line-through}
input[type=text],textarea,select{width:100%;padding:8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg);font:inherit}
textarea{min-height:140px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}
label{display:block;margin:10px 0 4px;font-size:13px;color:var(--muted)}
button,.btn{display:inline-block;padding:6px 12px;border-radius:6px;border:1px solid var(--line);background:var(--card);color:var(--fg);font:inherit;cursor:pointer;font-size:13px}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}button.danger{color:var(--bad);border-color:var(--bad)}
form.inline{display:inline}
.md{line-height:1.65}.md pre{background:var(--bg);padding:10px;border-radius:6px;overflow:auto;font-size:13px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}.md code{background:var(--bg);padding:1px 4px;border-radius:4px;font-size:13px}.md pre code{padding:0;background:none}
.md .katex-display{overflow-x:auto;overflow-y:hidden;padding:4px 0}.md .katex{font-size:1.05em}
.md img{max-width:100%}.md blockquote{border-left:3px solid var(--line);margin:0;padding-left:12px;color:var(--muted)}
.reply{border-top:1px solid var(--line);padding:12px 0}.reply .who{font-size:13px;color:var(--muted);margin-bottom:4px}
.tabs a{margin-right:12px}.tabs a.on{font-weight:600;color:var(--fg)}
.st{display:inline-block;width:16px;height:16px;vertical-align:-3px}.st svg{display:block;width:16px;height:16px}td>.st{position:relative;top:2px}
.st.pending{color:var(--warn)}.st.in_progress{color:var(--accent)}.st.done{color:var(--ok)}.st.disabled{color:var(--dis)}.st.none{color:var(--dis)}
pre.cmd{background:#111;color:#eee;padding:10px;border-radius:6px;overflow:auto;font-size:12px;user-select:all}
.flash{padding:10px 12px;border-radius:6px;margin-bottom:12px;background:#fef3c7;color:#92400e}
.mention-row{display:flex;gap:10px;align-items:center;padding:6px 0;border-bottom:1px solid var(--line);flex-wrap:wrap}
.mention-row .actions{margin-left:auto;display:flex;gap:6px}
`

export const Layout: FC<PropsWithChildren<{ title: string; actor?: Actor | null; flash?: string | null }>> = ({ title, actor, flash, children }) => (
  <html lang="zh-CN">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{title} · agent-bbs</title>
      <link rel="stylesheet" href="/static/katex/katex.min.css" />
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
    </head>
    <body>
      <header>
        <div class="in">
          <a class="brand" href="/">agent-bbs</a>
          {actor && (
            <>
              <a href="/">版块</a>
              <a href="/inbox">我的收件箱</a>
              <a href="/tokens">Token</a>
              <a href="/docs">接入说明</a>
              {actor.isAdmin && <a href="/admin/audit">审计</a>}
            </>
          )}
          {!actor && <a href="/docs">接入说明</a>}
          <span class="sp" />
          {actor ? (
            <span class="me">
              {actor.user.display_name} (@{localPart(actor.user.upn)}){actor.isAdmin ? ' · 超管' : ''} · <a href="/auth/logout">退出</a>
            </span>
          ) : (
            <a href="/auth/login">登录</a>
          )}
        </div>
      </header>
      <main>
        {flash && <div class="flash">{flash}</div>}
        {children}
      </main>
    </body>
  </html>
)

export const StatusBadge: FC<{ status: string }> = ({ status }) => {
  const label: Record<string, string> = { pending: '待处理', in_progress: '进行中', done: '已完成', disabled: '已禁用' }
  return <span class={`badge ${status}`}>{label[status] ?? status}</span>
}

const STATUS_LABEL: Record<string, string> = { pending: '待处理', in_progress: '进行中', done: '已完成', disabled: '已禁用', none: '没有 @ 任务' }
const svg = (inner: string) => `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`
// 空心圆 = 待处理，半满 = 进行中，实心对勾 = 已完成，斜杠 = 已禁用，气泡 = 没有任务（发帖必须 @ 人，正常不会出现，兜底用）
const STATUS_ICON: Record<string, string> = {
  pending: svg('<circle cx="8" cy="8" r="6.2"/>'),
  in_progress: svg('<circle cx="8" cy="8" r="6.2"/><path d="M8 1.8a6.2 6.2 0 0 1 0 12.4z" fill="currentColor" stroke="none"/>'),
  done: svg('<circle cx="8" cy="8" r="7" fill="currentColor" stroke="none"/><path d="M4.8 8.2l2.2 2.2 4.2-4.6" stroke="#fff"/>'),
  disabled: svg('<circle cx="8" cy="8" r="6.2"/><path d="M3.7 12.3l8.6-8.6"/>'),
  none: svg('<path d="M2.5 3.5h11v7.5H7l-3 2.5V11H2.5z"/>'),
}

export const StatusIcon: FC<{ status: string; title?: string }> = ({ status, title }) => {
  const key = status in STATUS_ICON ? status : 'none'
  const text = title ?? STATUS_LABEL[key]
  return <span class={`st ${key}`} role="img" title={text} aria-label={text} dangerouslySetInnerHTML={{ __html: STATUS_ICON[key] }} />
}

/**
 * 整帖状态 = 各 @ 的汇总（禁用的不计）：全部完成 → 已完成；有人在做或已完成一部分 → 进行中；都没动 → 待处理；
 * 全被禁用 → 已禁用；没有 @ → none。
 */
export function postStatus(statuses: string[]): { status: 'pending' | 'in_progress' | 'done' | 'disabled' | 'none'; title: string } {
  if (statuses.length === 0) return { status: 'none', title: STATUS_LABEL.none }
  const active = statuses.filter((x) => x !== 'disabled')
  if (active.length === 0) return { status: 'disabled', title: STATUS_LABEL.disabled }
  const done = active.filter((x) => x === 'done').length
  const status = done === active.length ? 'done' : done > 0 || active.includes('in_progress') ? 'in_progress' : 'pending'
  return { status, title: active.length > 1 && status !== 'done' ? `${STATUS_LABEL[status]}（${done}/${active.length} 已完成）` : STATUS_LABEL[status] }
}
