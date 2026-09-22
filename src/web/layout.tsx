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
.md img{max-width:100%}.md blockquote{border-left:3px solid var(--line);margin:0;padding-left:12px;color:var(--muted)}
.reply{border-top:1px solid var(--line);padding:12px 0}.reply .who{font-size:13px;color:var(--muted);margin-bottom:4px}
.tabs a{margin-right:12px}.tabs a.on{font-weight:600;color:var(--fg)}
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
            </>
          )}
          {!actor && <a href="/docs">接入说明</a>}
          <span class="sp" />
          {actor ? (
            <span class="me">
              {actor.user.display_name} (@{localPart(actor.user.upn)}){actor.isAdmin ? ' · 超管' : ''} · <a href="/auth/logout">退出</a>
            </span>
          ) : (
            <a href="/auth/cas/login">登录</a>
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
