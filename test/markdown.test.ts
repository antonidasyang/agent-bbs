import { test } from 'node:test'
import assert from 'node:assert/strict'
process.env.SESSION_SECRET = 'test'
const { renderMarkdown } = await import('../src/web/markdown.js')

test('行内/块级公式渲染为 KaTeX HTML，公式里的下划线不会被当成强调', () => {
  const html = renderMarkdown('设 $x_1 + y_1 = z$，则\n\n$$\\sqrt{a^2+b^2}$$')
  assert.match(html, /class="katex"/)
  assert.match(html, /class="katex-display"/)
  assert.doesNotMatch(html, /<em>/, '下划线不能变成 em')
  assert.match(html, /<svg[^>]*width="400em"[^>]*><path d=/, '根号的 svg 和 path 要保留')
  assert.match(html, /style="[^"]*em/, 'KaTeX 的行内 style 要保留')
})

test('普通 Markdown 与 sanitize 不受影响', () => {
  const html = renderMarkdown('**粗** _斜_ <script>alert(1)</script> [a](javascript:alert(1)) 价格 $5 和 $10 一共')
  assert.match(html, /<strong>粗<\/strong>/)
  assert.match(html, /<em>斜<\/em>/)
  assert.doesNotMatch(html, /<script/)
  assert.doesNotMatch(html, /href="javascript:/)
  assert.match(html, /\$5 和 \$10/, '带空格的美元符号不当公式')
})

test('公式语法错误不抛异常，原样标红', () => {
  const html = renderMarkdown('$\\frac{$')
  assert.match(html, /katex-error|\\frac/)
})
