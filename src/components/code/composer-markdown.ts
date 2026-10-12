import hljs from 'highlight.js/lib/common'

const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const escapeMarkdown = (text: string) => text.replace(/([\\`*_[\]<>])/g, '\\$1')
const codeLanguages = ['java', 'javascript', 'typescript', 'python', 'sql', 'bash', 'json', 'cpp']
const isMonospace = (node: HTMLElement) => /mono|consolas|menlo|courier/i.test(node.style.fontFamily)

function inlineComposerCode(text: string) {
  const delimiter = '`'.repeat(Array.from(text.matchAll(/`+/g)).reduce((length, match) => Math.max(length, match[0].length + 1), 1))
  const padding = /^`|`$/.test(text) || (/^ .* $/.test(text) && text.trim()) ? ' ' : ''
  return `${delimiter}${padding}${text}${padding}${delimiter}`
}

function wrapEmphasis(body: string, delimiter: string) {
  // CommonMark delimiters cannot enclose leading/trailing whitespace. Keep
  // that whitespace outside the mark instead of losing word boundaries.
  const content = body.trim()
  if (!content) return body
  return body.slice(0, body.length - body.trimStart().length) + delimiter + content + delimiter
    + body.slice(body.trimEnd().length)
}

function finishPastedMarkdown(markdown: string) {
  // A closing fence must stay on its own line when the user continues typing.
  const editable = /\n`{3,}$/.test(markdown) ? markdown + '\n' : markdown
  return editable.length <= 250_000 ? editable : undefined
}

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
  template.content.querySelectorAll('script,style,iframe,object,template,img,svg,button,.code-markdown-code-toolbar').forEach(node => node.remove())
  // Tables are not a supported Markdown conversion. Keep the authoritative
  // clipboard text, including its row/column separators, even with styled cells.
  if (template.content.querySelector('table')) return undefined
  // textContent drops BR entirely, including inside mixed-message code blocks.
  template.content.querySelectorAll('br').forEach(node => node.replaceWith('\n'))
  const canonical = (value: string) => value.replace(/^\s*(?:[-*•]|\d+[.)])\s+/gm, '').replace(/\s+/g, ' ').trim()
  let inspected = 0
  const readableText = (node: Node, depth: number): string => {
    if (++inspected > 30_000 || depth > 100) throw new Error('Formatting limit')
    if (node.nodeType === Node.TEXT_NODE) return node.textContent || ''
    const body = Array.from(node.childNodes, child => readableText(child, depth + 1)).join('')
    return node instanceof HTMLElement && /^(P|DIV|PRE|LI|UL|OL|H[1-6]|BLOCKQUOTE)$/.test(node.tagName) ? '\n' + body + '\n' : body
  }
  // Normalize presentation whitespace, but never equate "one two" with
  // "onetwo". Mismatched HTML must leave the authoritative plain text intact.
  try { if (canonical(readableText(template.content, 0)) !== canonical(text)) return undefined }
  catch { return undefined }
  const languageOf = (node: Element) => {
    const value = node.getAttribute('data-language') || node.className.match(/(?:language|lang)-([\w+-]+)/)?.[1] || ''
    return /^[\w+-]{1,40}$/.test(value) ? value.toLowerCase() : ''
  }
  const codeNode = template.content.querySelector('pre,code,[style*="font-family"]')
  if (codeNode instanceof HTMLElement && (codeNode.matches('pre,code') || isMonospace(codeNode))
    && canonical(codeNode.textContent || '') === canonical(text)) {
    // Font family alone does not make an inline token a block. Browser copies
    // routinely inline the computed monospace style of a selected <code> span.
    return finishPastedMarkdown(codeNode.matches('pre') || /[\r\n]/.test(text)
      ? fencedComposerCode(text, languageOf(codeNode.querySelector('code') || codeNode))
      : inlineComposerCode(text))
  }
  // A selection inside a highlighted block can omit its enclosing pre/code.
  // Only accept a span-only code fragment, never infer a block from prose.
  if (/[\r\n]/.test(text)
    && template.content.querySelector('.hljs-keyword,.hljs-string,.hljs-comment,.hljs-number,.hljs-built_in')
    && Array.from(template.content.querySelectorAll('*')).every(node => node.matches('span,br'))) {
    return finishPastedMarkdown(fencedComposerCode(text))
  }
  let visited = 0
  let structured = false
  const source = text.replace(/\r\n?/g, '\n')
  const comparableSource = source.replace(/\u00a0/g, ' ')
  let codeOffset = 0
  const capturedCode = (node: HTMLElement) => {
    const code = (node.textContent || '').replace(/\u00a0/g, ' ')
    const start = comparableSource.indexOf(code, codeOffset)
    // Collapsing whitespace for whole-message comparison must not authorize
    // changing whitespace inside code (for example, a string literal).
    if (start < 0) throw new Error('Code text does not match clipboard')
    codeOffset = start + code.length
    return source.slice(start, codeOffset)
  }
  const render = (node: Node, depth: number): string => {
    if (++visited > 30_000 || depth > 100) throw new Error('Formatting limit')
    if (node.nodeType === Node.TEXT_NODE) return escapeMarkdown((node.textContent || '').replace(/\u00a0/g, ' '))
    if (!(node instanceof HTMLElement)) return ''
    const children = () => joinMarkdown(Array.from(node.childNodes, child => render(child, depth + 1)))
    const tag = node.tagName
    if (tag === 'PRE') { structured = true; return `\n\n${fencedComposerCode(capturedCode(node), languageOf(node.querySelector('code') || node))}\n\n` }
    if (tag === 'CODE' || (tag === 'SPAN' && isMonospace(node))) { structured = true; return inlineComposerCode(capturedCode(node)) }
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
    if (tag === 'B' || tag === 'STRONG' || /^(bold|[6-9]00)$/.test(node.style.fontWeight)) { structured = true; return wrapEmphasis(body, '**') }
    if (tag === 'I' || tag === 'EM' || node.style.fontStyle === 'italic') { structured = true; return wrapEmphasis(body, '*') }
    return tag === 'P' ? `\n\n${body}\n\n` : tag === 'DIV' && !body.endsWith('\n') ? `${body}\n` : body
  }
  try {
    const markdown = joinMarkdown(Array.from(template.content.childNodes, node => render(node, 0))).trim()
    return structured ? finishPastedMarkdown(markdown) : undefined
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
