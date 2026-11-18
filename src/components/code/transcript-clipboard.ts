import DOMPurify from 'dompurify'

export function transcriptClipboardHtml(content: HTMLElement) {
  const container = content.cloneNode(true) as HTMLElement
  container.querySelectorAll('.code-markdown-code-toolbar, [aria-hidden="true"]').forEach(node => node.remove())
  let hasWebLink = false
  for (const link of container.querySelectorAll('a[href]')) {
    const href = link.getAttribute('href') || ''
    if (!/^https?:\/\//i.test(href)) {
      link.removeAttribute('href')
      continue
    }
    hasWebLink = true
  }
  if (!hasWebLink) return null

  return DOMPurify.sanitize(container.innerHTML, {
    ALLOWED_TAGS: ['a', 'p', 'div', 'span', 'br', 'strong', 'em', 'b', 'i', 'del', 's', 'blockquote', 'ul', 'ol', 'li', 'pre', 'code', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr'],
    ALLOWED_ATTR: ['href', 'start'],
    ALLOW_ARIA_ATTR: false,
    ALLOW_DATA_ATTR: false,
  })
}
