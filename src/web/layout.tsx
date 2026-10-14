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
header .nav{display:flex;align-items:center;gap:20px}header .in{max-width:1100px;margin:0 auto;display:flex;align-items:center;gap:20px;height:52px}
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
.md pre.mermaid{white-space:pre}.md .mermaid-box{overflow-x:auto;padding:8px 0;text-align:center}.md .mermaid-box svg{max-width:100%;height:auto}.md .mermaid-err{color:var(--bad);font-size:12px;margin:-4px 0 8px}
.hljs-comment,.hljs-quote{color:#6a737d;font-style:italic}.hljs-keyword,.hljs-selector-tag,.hljs-literal,.hljs-built_in,.hljs-type,.hljs-meta .hljs-keyword{color:#cf222e}.hljs-string,.hljs-regexp,.hljs-addition,.hljs-attribute,.hljs-meta .hljs-string{color:#0a3069}.hljs-number,.hljs-symbol,.hljs-bullet,.hljs-variable,.hljs-template-variable,.hljs-attr{color:#0550ae}.hljs-title,.hljs-section,.hljs-name,.hljs-selector-id,.hljs-selector-class{color:#8250df}.hljs-meta{color:#953800}.hljs-deletion{color:#82071e}
@media(prefers-color-scheme:dark){.hljs-comment,.hljs-quote{color:#8b949e}.hljs-keyword,.hljs-selector-tag,.hljs-literal,.hljs-built_in,.hljs-type,.hljs-meta .hljs-keyword{color:#ff7b72}.hljs-string,.hljs-regexp,.hljs-addition,.hljs-attribute,.hljs-meta .hljs-string{color:#a5d6ff}.hljs-number,.hljs-symbol,.hljs-bullet,.hljs-variable,.hljs-template-variable,.hljs-attr{color:#79c0ff}.hljs-title,.hljs-section,.hljs-name,.hljs-selector-id,.hljs-selector-class{color:#d2a8ff}.hljs-meta{color:#ffa657}.hljs-deletion{color:#ffdcd7}}
.md img{max-width:100%}.md blockquote{border-left:3px solid var(--line);margin:0;padding-left:12px;color:var(--muted)}
.reply{border-top:1px solid var(--line);padding:12px 0}.reply .who{font-size:13px;color:var(--muted);margin-bottom:4px}
.tabs a{margin-right:12px}.tabs a.on{font-weight:600;color:var(--fg)}
.st{display:inline-block;width:16px;height:16px;vertical-align:-3px}.st svg{display:block;width:16px;height:16px}td>.st{position:relative;top:2px}
.st.pending{color:var(--warn)}.st.in_progress{color:var(--accent)}.st.done{color:var(--ok)}.st.disabled{color:var(--dis)}.st.none{color:var(--dis)}
pre.cmd{background:#111;color:#eee;padding:10px;border-radius:6px;overflow:auto;font-size:12px;user-select:all}
.flash{padding:10px 12px;border-radius:6px;margin-bottom:12px;background:#fef3c7;color:#92400e}
.mention-row{display:flex;gap:10px;align-items:center;padding:6px 0;border-bottom:1px solid var(--line);flex-wrap:wrap}
.mention-row .actions{margin-left:auto;display:flex;gap:6px}
/* 手机端列表改为带字段名的卡片；宽内容在自身区域内滚动。 */
main,.card,.md{min-width:0;overflow-wrap:anywhere}
input,select,textarea{max-width:100%}
.md pre,pre.cmd{max-width:100%;overflow-wrap:normal}
.md table{display:block;max-width:100%;overflow-x:auto}
.md img{height:auto}
.captcha-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.tabs{display:flex;align-items:center;gap:6px 12px;flex-wrap:wrap}.tabs a{margin-right:0}
.mention-row .actions{flex-wrap:wrap}
:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
@media(max-width:700px){
  body{font-size:16px}
  header{padding:0 12px}
  header .in{height:auto;min-height:56px;flex-wrap:wrap;gap:4px 12px;padding:8px 0}
  header .brand{flex-shrink:0}header .sp{display:none}
  header .me{margin-left:auto;max-width:65%;text-align:right;overflow-wrap:anywhere}header .me a{display:inline-block;white-space:nowrap}
  header .nav{order:3;width:100%;gap:4px;flex-wrap:wrap;border-top:1px solid var(--line);padding-top:4px}
  header .nav a{display:flex;align-items:center;justify-content:center;min-height:44px;padding:6px;font-size:14px;flex:1 0 auto;white-space:nowrap}
  header .in>a:not(.brand){margin-left:auto;min-height:44px;display:inline-flex;align-items:center}
  main{padding:14px 12px}
  .card{padding:14px 12px;margin-bottom:12px}
  h1{font-size:21px}h2{font-size:18px}
  button,.btn{min-height:44px;padding:9px 14px;font-size:14px;max-width:100%}
  input:not([type=hidden]),textarea,select{font-size:16px!important;min-height:44px}
  form:not(.inline)>input:not([type=hidden]):not([type=checkbox]):not([type=radio]),form:not(.inline)>select{width:100%!important;margin-bottom:8px}
  textarea{min-height:160px}
  .tabs a{display:inline-flex;align-items:center;gap:4px;min-height:44px}
  .mention-row{gap:8px;padding:10px 0}.mention-row .actions{width:100%;margin-left:0}
  .mobile-list,.mobile-list tbody{display:block;width:100%}
  .mobile-list thead{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
  .mobile-list tr{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 12px;padding:14px 0;border-bottom:1px solid var(--line)}
  .mobile-list tr:first-child{padding-top:4px}.mobile-list tr:last-child{border-bottom:0}
  .mobile-list td{display:block;border:0;padding:0;min-width:0;width:auto!important;max-width:none!important;text-align:left!important;overflow-wrap:anywhere}
  .mobile-list td::before{content:attr(data-label);display:block;color:var(--muted);font-size:12px;font-weight:400;margin-bottom:2px}
  .mobile-list td[data-label="标题"],.mobile-list td[data-label="项目"],.mobile-list td[data-label="动态"],.mobile-list td[data-label="标识"],.mobile-list td[data-label="@"],.mobile-list td[data-label="内容摘录"],.mobile-list td[data-label="原因"],.mobile-list td[data-label="操作"],.mobile-list td[colspan]{grid-column:1/-1}
  .mobile-list td[data-label="标题"]{font-size:17px;font-weight:600}
  .mobile-list td[data-label="操作"]::before{display:none}
  .mobile-list td[data-label="操作"] a{display:inline-flex;align-items:center;min-height:44px}
  .mobile-list td form.inline{display:inline-block;margin:3px 4px 3px 0}
  .md pre,pre.cmd{font-size:13px}.md ul,.md ol{padding-left:24px}
}

`

// 有 Mermaid 图才加载 5MB 的脚本；逐个 render，失败的保留源码并给一行错误
const MERMAID_JS = `(function(){
var els=document.querySelectorAll('pre.mermaid');if(!els.length)return;
var s=document.createElement('script');s.src='/static/mermaid/mermaid.min.js';
s.onload=async function(){
  var dark=window.matchMedia&&matchMedia('(prefers-color-scheme: dark)').matches;
  mermaid.initialize({startOnLoad:false,securityLevel:'strict',theme:dark?'dark':'default',flowchart:{htmlLabels:false}});
  for(var i=0;i<els.length;i++){var el=els[i];
    try{var r=await mermaid.render('mmd'+i,el.textContent);var box=document.createElement('div');box.className='mermaid-box';box.innerHTML=r.svg;
      box.title='双击查看源码';box.ondblclick=(function(b,p){return function(){b.replaceWith(p)}})(box,el);el.replaceWith(box)}
    catch(e){var d=document.getElementById('dmmd'+i);if(d)d.remove();var m=document.createElement('div');m.className='mermaid-err';
      m.textContent='Mermaid 图渲染失败：'+String((e&&e.message)||e).split('\\n')[0];el.after(m)}}
};document.head.appendChild(s)})()`

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
              <nav class="nav" aria-label="主导航">
              <a href="/">版块</a>
              <a href="/inbox">我的收件箱</a>
              <a href="/tokens">Token</a>
              <a href="/docs">接入说明</a>
              {actor.isAdmin && <a href="/admin/audit">审计</a>}
              </nav>
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
      <script dangerouslySetInnerHTML={{ __html: MERMAID_JS }} />
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
