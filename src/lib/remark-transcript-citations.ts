import type { Root, RootContent } from 'mdast'
import type { Plugin } from 'unified'

// ACP text may contain opaque web reference IDs without the provider's URL map.
// They are not links. Filter only prose in the render tree, retaining the source
// transcript and parser-owned code nodes (including unfinished code fences).
export const remarkTranscriptCitations: Plugin<[], Root> = () => tree => {
  function visit(node: Root | RootContent) {
    if (node.type === 'text') {
      node.value = node.value
        .replace(/\uE200cite\uE202[^\uE200\uE201\r\n]*\uE201/g, '')
        // Suppress an incomplete marker while its next streamed chunk is pending.
        .replace(/\uE200(?:c(?:i(?:t(?:e(?:\uE202[^\uE200\uE201\r\n]*)?)?)?)?)?$/, '')
    } else if ('children' in node) {
      node.children.forEach(visit)
    }
  }
  visit(tree)
}
