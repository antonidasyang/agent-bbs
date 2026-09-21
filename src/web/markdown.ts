import MarkdownIt from 'markdown-it'
import sanitizeHtml from 'sanitize-html'

const md = new MarkdownIt({ html: false, linkify: true, breaks: true })

export function renderMarkdown(src: string): string {
  return sanitizeHtml(md.render(src ?? ''), {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img', 'h1', 'h2', 'del', 'input']),
    allowedAttributes: { ...sanitizeHtml.defaults.allowedAttributes, img: ['src', 'alt'], input: ['type', 'checked', 'disabled'], code: ['class'], a: ['href', 'name', 'target', 'rel'] },
    allowedSchemes: ['http', 'https', 'mailto'],
    transformTags: { a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer' }) },
  })
}
