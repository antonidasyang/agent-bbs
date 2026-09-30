import MarkdownIt from 'markdown-it'
import sanitizeHtml from 'sanitize-html'
import * as katexModule from '@vscode/markdown-it-katex'

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
const md = new MarkdownIt({ html: false, linkify: true, breaks: true })
md.use(katexPlugin, { throwOnError: false, output: 'html', enableFencedBlocks: true, strict: false })

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
      .replace(/\\\[([\s\S]*?)\\\]/g, (_m, body: string) => `$$${body}$$`)
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
      a: ['href', 'name', 'target', 'rel'],
      span: ['class', 'style', 'aria-hidden'],
      svg: ['xmlns', 'width', 'height', 'viewBox', 'preserveAspectRatio', 'style', 'class'],
      path: ['d'],
      line: ['x1', 'y1', 'x2', 'y2', 'stroke-width'],
    },
    allowedStyles: { '*': allowedStyles },
    allowedSchemes: ['http', 'https', 'mailto'],
    transformTags: { a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer' }) },
  })
}
