import hljs from 'highlight.js/lib/common'

const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const escapeMarkdown = (text: string) => text.replace(/([\\`*_[\]<>])/g, '\\$1')
const codeLanguages = ['java', 'javascript', 'typescript', 'python', 'sql', 'bash', 'json', 'cpp']

// Adjacent blocks each supply a separator; merge their boundaries without
// collapsing blank lines inside code or other captured text.
const joinMarkdown = (parts: string[]) => parts.reduce((result, part) => {
  const trailing = result.match(/\n+$/)?.[0].length || 0
  const leading = part.match(/^\n+/)?.[0].length || 0
  return trailing && leading
    ? result + '\n'.repeat(Math.max(trailing, leading, 2) - trailing) + part.slice(leading)
    : result + part
}, '')

export function fencedComposerCode(text: string, language = '') {
  const fence = '`'.repeat(Array.from(text.matchAll(/`+/g)).reduce((length, match) => Math.max(length, match[0].length + 1), 3))
  return `${fence}${language}\n${text}${text.endsWith('\n') ? '' : '\n'}${fence}`
}

/** Convert only readable structure; never import source layout, CSS or executable HTML. */
export function readPastedMarkdown(text: string, html?: string): string | undefined {
  if (!html || html.length > 2_000_000 || typeof document === 'undefined') return undefined
  const template = document.createElement('template')
  template.innerHTML = html
  template.content.querySelectorAll('script,style,iframe,object,template,img,svg,button').forEach(node => node.remove())
  // Tables are not a supported Markdown conversion. Keep the authoritative
  // clipboard text, including its row/column separators, even with styled cells.
  if (template.content.querySelector('table')) return undefined
  const canonical = (value: string) => value.replace(/^\s*(?:[-*•]|\d+[.)])\s+/gm, '').replace(/\s/g, '')
  if (canonical(template.content.textContent || '') !== canonical(text)) return undefined
  const languageOf = (node: Element) => {
    const value = node.getAttribute('data-language') || node.className.match(/(?:language|lang)-([\w+-]+)/)?.[1] || ''
    return /^[\w+-]{1,40}$/.test(value) ? value.toLowerCase() : ''
  }
  const codeNode = template.content.querySelector('pre,code,[style*="font-family"]')
  if (codeNode && (codeNode.matches('pre') || (codeNode.matches('code') && text.includes('\n')) || /mono|consolas|menlo|courier/i.test(codeNode.getAttribute('style') || ''))
    && canonical(codeNode.textContent || '') === canonical(text)) {
    const markdown = fencedComposerCode(text, languageOf(codeNode.querySelector('code') || codeNode))
    return markdown.length <= 250_000 ? markdown : undefined
  }
  let visited = 0
  let structured = false
  const render = (node: Node, depth: number): string => {
    if (++visited > 30_000 || depth > 100) throw new Error('Formatting limit')
    if (node.nodeType === Node.TEXT_NODE) return escapeMarkdown(node.textContent || '')
    if (!(node instanceof HTMLElement)) return ''
    const children = () => joinMarkdown(Array.from(node.childNodes, child => render(child, depth + 1)))
    const tag = node.tagName
    if (tag === 'PRE') { structured = true; return `\n\n${fencedComposerCode(node.textContent || '', languageOf(node.querySelector('code') || node))}\n\n` }
    if (tag === 'CODE') { structured = true; const value = node.textContent || ''; const delimiter = '`'.repeat(Math.max(1, ...Array.from(value.matchAll(/`+/g), match => match[0].length + 1))); return `${delimiter} ${value} ${delimiter}` }
    if (tag === 'BR') return '\n'
    if (tag === 'UL' || tag === 'OL') {
      structured = true
      const start = Number(node.getAttribute('start')) || 1
      return '\n' + Array.from(node.children).filter(child => child.tagName === 'LI').map((child, index) => {
        const body = render(child, depth + 1).trim()
        const marker = tag === 'OL' ? `${start + index}. ` : '- '
        return marker + body.replace(/\n/g, '\n' + ' '.repeat(marker.length))
      }).join('\n') + '\n'
    }
    const body = children()
    if (tag === 'A') {
      const href = node.getAttribute('href') || ''
      if (/^(https?:\/\/|mailto:)/i.test(href)) { structured = true; return `[${body}](<${href.replace(/[<>\s]/g, character => encodeURIComponent(character))}>)` }
    }
    if (/^H[1-6]$/.test(tag)) { structured = true; return `\n\n${'#'.repeat(Number(tag[1]))} ${body}\n\n` }
    if (tag === 'BLOCKQUOTE') { structured = true; return '\n\n' + body.trim().replace(/^/gm, '> ') + '\n\n' }
    if (tag === 'B' || tag === 'STRONG' || /^(bold|[6-9]00)$/.test(node.style.fontWeight)) { structured = true; return `**${body}**` }
    if (tag === 'I' || tag === 'EM' || node.style.fontStyle === 'italic') { structured = true; return `*${body}*` }
    return tag === 'P' ? `\n\n${body}\n\n` : tag === 'DIV' ? `${body}\n` : body
  }
  try {
    const markdown = joinMarkdown(Array.from(template.content.childNodes, node => render(node, 0))).trim()
    return structured && markdown.length <= 250_000 ? markdown : undefined
  } catch { return undefined }
}

/** Bounded synchronous decoration; the native textarea remains the only editor. */
export function highlightComposerMarkdown(text: string): string | null {
  if (!text || text.length > 50_000 || !/(?:^|\n)\s*(?:`{3,}|~{3,}|[-*] |\d+\. |#{1,6} |> )|\*[^*\n]+\*|_[^_\n]+_|\[[^\]]+\]\(|`[^`]+`/.test(text)) return null
  const lines = text.split('\n')
  const output: string[] = []
  let prose: string[] = []
  let codeBudget = 12_000
  let blocks = 0
  const flushProse = () => {
    if (prose.length) output.push(hljs.highlight(prose.join('\n'), { language: 'markdown', ignoreIllegals: true }).value)
    prose = []
  }
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    const fence = line.match(/^\s{0,3}(`{3,}|~{3,})([\w+-]*)\s*$/)
    if (!fence) { prose.push(line); continue }
    flushProse()
    output.push(`<span class="hljs-meta">${escapeHtml(line)}</span>`)
    const content: string[] = []
    while (++index < lines.length && !new RegExp(`^\\s{0,3}${fence[1]![0]}{${fence[1]!.length},}\\s*$`).test(lines[index]!)) content.push(lines[index]!)
    const code = content.join('\n')
    const language = fence[2]!
    const decorate = ++blocks <= 64 && code.length <= codeBudget
    if (decorate) codeBudget -= code.length
    if (content.length) output.push(!decorate ? escapeHtml(code) : language && hljs.getLanguage(language)
      ? hljs.highlight(code, { language, ignoreIllegals: true }).value
      : language ? escapeHtml(code) : hljs.highlightAuto(code, codeLanguages).value)
    if (index < lines.length) output.push(`<span class="hljs-meta">${escapeHtml(lines[index]!)}</span>`)
  }
  flushProse()
  return output.join('\n')
}
