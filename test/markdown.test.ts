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

test('字母紧贴 $ 的写法自动收进公式：E$_2^{x}$ / K$\'$；货币和代码块不动', async () => {
  const { normalizeMath } = await import('../src/web/markdown.js')
  assert.equal(normalizeMath('(E$_2^{\\mathrm{mix}}$) 与 (K$\'$)'), '($E_2^{\\mathrm{mix}}$) 与 ($K\'$)')
  assert.equal(normalizeMath('US$5 和 $10，a$b$c'), 'US$5 和 $10，a$b$c', '后面不是 _^\'\\ 的不动')
  assert.equal(normalizeMath('`E$_2$` 和 ```\nE$_2$\n```'), '`E$_2$` 和 ```\nE$_2$\n```', '代码里不动')
  const html = renderMarkdown('(E$_2^{\\mathrm{mix}}$) 是特例')
  assert.match(html, /class="katex"/)
  assert.doesNotMatch(html, /\$_2/)
})

test('LaTeX 定界符 \\[ \\] 与 \\( \\) 转成 $$ / $ 并渲染；代码块里不动', async () => {
  const { normalizeMath } = await import('../src/web/markdown.js')
  assert.equal(normalizeMath('前\\n\\[\\nM_c=\\binom N2\\n\\]\\n后 \\( a+b \\) 完'), '前\\n$$\\nM_c=\\binom N2\\n$$\\n后 $a+b$ 完')
  assert.equal(normalizeMath('`\\[x\\]` 和 ```\\n\\[y\\]\\n```'), '`\\[x\\]` 和 ```\\n\\[y\\]\\n```')
  const html = renderMarkdown('结论\\n\\n\\[\\n\\boxed{r_c\\ge\\lceil N/4\\rceil+1}\\n\\]\\n\\n且 \\(\\delta(F)=|F|-e(F)\\)。')
  assert.match(html, /katex-display/, '块公式')
  assert.ok((html.match(/class="katex"/g) || []).length >= 2, '块 + 行内')
  assert.doesNotMatch(html, /\\boxed|\\delta/, '不能有裸 LaTeX 残留')
})
