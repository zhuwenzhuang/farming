import type { Root, PhrasingContent } from 'mdast'
import type { Plugin } from 'unified'

export type RichContentPhase = 'streaming' | 'settled' | 'interrupted'
export type PendingRichContent = Exclude<RichContentPhase, 'settled'> | undefined

export function richContentPhase(status?: string, stopReason?: string): RichContentPhase {
  if (status === 'inProgress') return 'streaming'
  if (['cancelled', 'canceled', 'interrupted', 'stopped', 'max_tokens', 'max_turn_requests', 'refusal', 'error', 'cancel_error'].includes(stopReason || '')) return 'interrupted'
  if (['interrupted', 'cancelled', 'canceled', 'failed'].includes(status || '')) return 'interrupted'
  return 'settled'
}

// Use parser-owned block positions; a fence-looking line in another block is
// never evidence that this block has completed. Container prefixes are allowed.
export function hasClosingCodeFence(raw: string): boolean {
  const lines = raw.split(/\r?\n/)
  const opening = lines[0]?.match(/^\s*(`{3,}|~{3,})/)
  if (!opening || lines.length < 2) return false
  const last = lines[lines.length - 1]?.replace(/^(?:[ \t]*>[ \t]?)+/, '').trim() || ''
  return last.length >= opening[1]!.length && [...last].every(char => char === opening[1]![0])
}

// Only inspect parser-owned inline containers. Completed links and code are
// opaque; GFM autolinks inside an unfinished destination must still be hidden.
function hidePendingLink(node: { children: PhrasingContent[] }, source: string, parse: (source: string) => Root) {
  const children = node.children
  const start = children[0]?.position?.start.offset
  const end = children[children.length - 1]?.position?.end.offset
  if (start === undefined || end === undefined) return
  const opaque = new Map<number, number>()
  function collectOpaque(nodes: PhrasingContent[]) {
    for (const child of nodes) {
      const from = child.position?.start.offset
      const to = child.position?.end.offset
      if (from !== undefined && to !== undefined && (child.type === 'inlineCode' || child.type === 'image'
        || (child.type === 'link' && source[from] === '['))) opaque.set(from, to)
      else if ('children' in child) collectOpaque(child.children)
    }
  }
  collectOpaque(children)
  const brackets: number[] = []
  for (let i = start; i < end; i++) {
    const skip = opaque.get(i)
    if (skip !== undefined) { i = skip - 1; continue }
    if (source[i] === '\\') { i++; continue }
    if (source[i] === '[') brackets.push(i)
    if (source[i] !== ']' || !brackets.length) continue
    const opening = brackets.pop()!
    if (source[i + 1] !== '(') continue
    let depth = 1
    let quote = ''
    let angle = false
    let j = i + 2
    for (; j < end; j++) {
      const char = source[j]!
      if (char === '\\') { j++; continue }
      if (quote) { if (char === quote) quote = ''; continue }
      if (angle) { if (char === '>') angle = false; continue }
      if ((char === '"' || char === "'") && /\s/.test(source[j - 1]!)) { quote = char; continue }
      if (char === '<' && j === i + 2) { angle = true; continue }
      if (char === '(') depth++
      if (char === ')' && --depth === 0) break
    }
    if (depth === 0) { i = j; continue }
    const cutoff = source[opening - 1] === '!' ? opening - 1 : opening
    // Preserve the parsed prefix (including emphasis), removing every node in
    // the pending suffix, even when GFM split its URL into an autolink node.
    function trim(nodes: PhrasingContent[]): PhrasingContent[] {
      return nodes.filter(child => {
        const from = child.position?.start.offset
        const to = child.position?.end.offset
        if (from === undefined || to === undefined || to <= cutoff) return true
        if (from >= cutoff) return false
        if (child.type === 'text') {
          // Reuse parser decoding for entities/escapes rather than slicing the
          // decoded value with raw-source offsets.
          const prefix = parse(source.slice(0, cutoff) + '\uFFFC')
          function findText(current: Root | Root['children'][number]): string | undefined {
            if (current.type === 'text' && current.position?.start.offset === from) return current.value
            if ('children' in current) {
              for (const nested of current.children) {
                const value = findText(nested as Root['children'][number])
                if (value !== undefined) return value
              }
            }
          }
          child.value = (findText(prefix) ?? '').replace(/\uFFFC$/, '')
        } else if ('children' in child) child.children = trim(child.children)
        return true
      })
    }
    node.children = trim(children)
    return
  }
}

export const remarkStreamingContent: Plugin<[{ phase: RichContentPhase }], Root> = function ({ phase }) {
  const parse = (value: string) => this.parse(value) as Root
  return (tree, file) => {
    if (phase === 'settled') return
    const source = String(file.value)
    function visit(node: Root | Root['children'][number]) {
      if (phase === 'streaming' && (node.type === 'paragraph' || node.type === 'tableCell' || node.type === 'heading')) hidePendingLink(node, source, parse)
      if (node.type === 'code') {
        const start = node.position?.start.offset
        const end = node.position?.end.offset
        if (start !== undefined && end !== undefined && !hasClosingCodeFence(source.slice(start, end))) {
          node.data = { ...node.data, hProperties: { ...node.data?.hProperties, 'data-content-pending': phase } }
        }
      }
      if ('children' in node) node.children.forEach(child => visit(child as Root['children'][number]))
    }
    visit(tree)
  }
}
