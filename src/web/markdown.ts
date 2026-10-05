import MarkdownIt from 'markdown-it'
import sanitizeHtml from 'sanitize-html'
import * as katexModule from '@vscode/markdown-it-katex'
import hljs from 'highlight.js/lib/common'

// 该包是 CJS 打包，ESM 下默认导出可能是 { default: fn } 的嵌套对象，运行时找到真正的函数
type MdPlugin = (md: InstanceType<typeof MarkdownIt>, opts?: unknown) => void
function resolvePlugin(m: unknown): MdPlugin {
  let cur: unknown = m
  for (let i = 0; i < 3 && cur && typeof cur !== 'function'; i++) cur = (cur as { default?: unknown }).default
  if (typeof cur !== 'function') throw new Error('@vscode/markdown-it-katex 导出形态不认识')
  return cur as MdPlugin
}
const katexPlugin = resolvePlugin(katexModule)

// 数学公式：$...$ 行内、$$...$$ 块级、```math 围栏。服务端用 KaTeX 渲染成 HTML（不出 MathML），CSS/字体由 /static/katex/ 本地提供
// 代码块：服务端 highlight.js 着色（只认带语言标注且 hljs 认识的，不猜语言），配色在 layout.tsx
const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  highlight: (code, lang) => {
    const l = lang.toLowerCase()
    if (!l || !hljs.getLanguage(l)) return ''
    try { return hljs.highlight(code, { language: l, ignoreIllegals: true }).value } catch { return '' }
  },
})
md.use(katexPlugin, { throwOnError: false, output: 'html', enableFencedBlocks: true, strict: false })

// Mermaid 图：```mermaid 围栏，或没写语言但首行是 Mermaid 图类型关键字的围栏。服务端只输出转义后的源码
// <pre class="mermaid">，浏览器端由 /static/mermaid/ 本地脚本渲染成 SVG（securityLevel strict），渲染失败就保留源码
const MERMAID_FIRST_LINE_RE = /^\s*(flowchart|graph|sequenceDiagram|classDiagram(-v2)?|stateDiagram(-v2)?|erDiagram|journey|gantt|pie|quadrantChart|requirementDiagram|gitGraph|C4Context|C4Container|C4Component|C4Dynamic|C4Deployment|mindmap|timeline|sankey(-beta)?|xychart(-beta)?|block(-beta)?|packet(-beta)?|kanban|architecture(-beta)?|radar(-beta)?|treemap(-beta)?)\b/
const defaultFence = md.renderer.rules.fence!
md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const t = tokens[idx]
  const lang = t.info.trim().split(/\s+/)[0].toLowerCase()
  if (lang === 'mermaid' || (!lang && MERMAID_FIRST_LINE_RE.test(t.content.replace(/^\s*%%.*\n/gm, '')))) {
    return `<pre class="mermaid">${md.utils.escapeHtml(t.content)}</pre>\n`
  }
  return defaultFence(tokens, idx, options, env, self)
}

// KaTeX 输出只会用到这些标签/属性；style 只放行它会写的几类
const KATEX_STYLE_RE = /^(margin|padding)(-\w+)?$|^(top|bottom|left|right|height|width|min-width|vertical-align|border-\w+(-\w+)?|color|position|transform|display|font-size|line-height|white-space|text-align)$/
const KATEX_STYLE_VALUE_RE = /^[\w\s.%(),#-]+$/
const allowedStyles = Object.fromEntries(
  ['margin', 'margin-left', 'margin-right', 'margin-top', 'margin-bottom', 'padding', 'padding-left', 'padding-right', 'top', 'bottom', 'left', 'right', 'height', 'width', 'min-width', 'vertical-align', 'border-bottom-width', 'border-top-width', 'border-right-width', 'border-left-width', 'border-bottom-style', 'border-top-style', 'color', 'position', 'transform', 'display', 'font-size', 'line-height', 'white-space', 'text-align'].filter((k) => KATEX_STYLE_RE.test(k)).map((k) => [k, [KATEX_STYLE_VALUE_RE]]),
)

/**
 * 把几种常见但插件不认的写法归一成 $ / $$（代码块、行内代码里不动）：
 * 1. LaTeX 定界符：\\[ … \\] → $$ … $$，\\( … \\) → $ … $（Markdown 会把 \\[ 当转义方括号吃掉反斜杠）。
 * 2. 字母紧贴 $：E$_2^{x}$、K$'$ —— 插件把紧贴字母的 $ 当普通字符（防 US$5 误判），但 $ 后面紧跟 _ ^ ' \\ 时不可能是货币，
 *    把前面那个字母收进公式：E$_2$ → $E_2$。
 */
export function normalizeMath(src: string): string {
  const parts = src.split(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/)
  for (let i = 0; i < parts.length; i += 2) {
    parts[i] = parts[i]
      // 紧跟在行内公式的收尾 $ 后面（$n$\\[…\\]）要隔一个空格，否则拼出 $$$ 两种公式都认不出
      .replace(/(\$?)\\\[([\s\S]*?)\\\]/g, (_m, pre: string, body: string) => `${pre ? '$ ' : ''}$$${body}$$`)
      .replace(/\\\(([\s\S]*?)\\\)/g, (_m, body: string) => `$${body.trim()}$`)
      .replace(/(?<![\w$\\])([A-Za-z])\$(?=[_^'\\])/g, '$$$1')
  }
  return parts.join('')
}

export function renderMarkdown(src: string): string {
  return sanitizeHtml(md.render(normalizeMath(src ?? '')), {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img', 'h1', 'h2', 'del', 'input', 'span', 'svg', 'path', 'line']),
    allowedAttributes: {
      ...sanitizeHtml.defaults.allowedAttributes,
      img: ['src', 'alt'],
      input: ['type', 'checked', 'disabled'],
      code: ['class'],
      pre: ['class'],
      a: ['href', 'name', 'target', 'rel'],
      span: ['class', 'style', 'aria-hidden'],
      svg: ['xmlns', 'width', 'height', 'viewBox', 'preserveAspectRatio', 'style', 'class'],
      path: ['d'],
      line: ['x1', 'y1', 'x2', 'y2', 'stroke-width'],
    },
    allowedClasses: { pre: ['mermaid'] },
    allowedStyles: { '*': allowedStyles },
    allowedSchemes: ['http', 'https', 'mailto'],
    transformTags: { a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer' }) },
  })
}
