/** Presentation only: offsets always address the authoritative plain-text snapshot. */
export interface PastedTextFormat {
  start: number
  end: number
  color?: string
  bold?: boolean
  italic?: boolean
  monospace?: boolean
}

const MAX_FORMAT_RUNS = 10_000
const safeColor = /^(?:#(?:[\da-f]{3}|[\da-f]{6})|rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\))$/i

/** Checkpoints are untrusted too; never persist arbitrary HTML or CSS. */
export function validatePastedTextFormats(value: unknown, text: string): PastedTextFormat[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_FORMAT_RUNS) return undefined
  const result: PastedTextFormat[] = []
  let previousEnd = 0
  for (const item of value) {
    if (!item || typeof item !== 'object') return undefined
    const { start, end, color, bold, italic, monospace } = item as Record<string, unknown>
    if (typeof start !== 'number' || typeof end !== 'number' || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < previousEnd || end <= start || end > text.length
      || (color !== undefined && (typeof color !== 'string' || !safeColor.test(color)))
      || [bold, italic, monospace].some(flag => flag !== undefined && typeof flag !== 'boolean')) return undefined
    result.push({ start, end, ...(color ? { color } : {}), ...(bold ? { bold: true } : {}), ...(italic ? { italic: true } : {}), ...(monospace ? { monospace: true } : {}) })
    previousEnd = end
  }
  return result.length ? result : undefined
}

export function readPastedTextFormats(text: string, html?: string): PastedTextFormat[] | undefined {
  if (!html || html.length > 2_000_000 || typeof document === 'undefined') return undefined
  // A detached template is inert: scripts, event handlers and remote resources are
  // never activated. Only text and an explicit inline-style allowlist are read.
  const template = document.createElement('template')
  template.innerHTML = html
  const runs: PastedTextFormat[] = []
  let content = ''
  let nodes = 0
  const append = (value: string, style: Omit<PastedTextFormat, 'start' | 'end'>) => {
    const start = content.length
    content += value.replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ')
    if (content.length > start && Object.keys(style).length) runs.push({ start, end: content.length, ...style })
  }
  const visit = (node: Node, inherited: Omit<PastedTextFormat, 'start' | 'end'>, depth: number) => {
    if (++nodes > 30_000 || depth > 100 || runs.length > MAX_FORMAT_RUNS || content.length > 250_000) throw new Error('Formatting limit')
    if (node.nodeType === Node.TEXT_NODE) { append(node.textContent || '', inherited); return }
    if (!(node instanceof HTMLElement)) return
    if (['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'TEMPLATE'].includes(node.tagName)) return
    if (node.tagName === 'BR') { append('\n', inherited); return }
    const block = ['DIV', 'P', 'PRE', 'LI', 'TR', 'H1', 'H2', 'H3', 'BLOCKQUOTE'].includes(node.tagName)
    if (block && content && !content.endsWith('\n')) append('\n', {})
    const style = { ...inherited }
    if (safeColor.test(node.style.color)) style.color = node.style.color
    if (['B', 'STRONG'].includes(node.tagName) || /^(bold|[6-9]00)$/.test(node.style.fontWeight)) style.bold = true
    if (['I', 'EM'].includes(node.tagName) || node.style.fontStyle === 'italic') style.italic = true
    if (['PRE', 'CODE'].includes(node.tagName) || /mono|consolas|menlo|courier/i.test(node.style.fontFamily)) style.monospace = true
    for (const child of node.childNodes) visit(child, style, depth + 1)
    if (block && content && !content.endsWith('\n')) append('\n', {})
  }
  try { for (const child of template.content.childNodes) visit(child, {}, 0) }
  catch { return undefined }
  const normalized = text.replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ')
  if (content !== normalized && content !== normalized + '\n') return undefined
  // Map normalized HTML offsets back to the original CRLF-preserving text.
  const offsets: number[] = [0]
  for (let index = 0; index < text.length; index++) {
    if (text[index] === '\r' && text[index + 1] === '\n') index++
    offsets.push(index + 1)
  }
  return validatePastedTextFormats(runs.filter(run => run.start < normalized.length).map(run => ({
    ...run, start: offsets[run.start]!, end: offsets[Math.min(run.end, normalized.length)]!,
  })), text)
}
