import type { Root } from 'mdast'
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

export const remarkStreamingContent: Plugin<[{ phase: RichContentPhase }], Root> = ({ phase }) => (tree, file) => {
  if (phase === 'settled') return
  const source = String(file.value)
  function visit(node: Root | Root['children'][number]) {
    if (node.type === 'code' && node.lang?.toLowerCase() === 'mermaid') {
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
