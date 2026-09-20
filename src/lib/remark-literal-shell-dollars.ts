import type { Root, RootContent } from 'mdast'
import type { Plugin } from 'unified'

// Two shell expansions can accidentally form one valid inline-math node, e.g.
// "$ENV/bin/python" "$ENV/script.py". Retain parser-owned positions and restore
// only this unambiguous shell shape; $x$, $a/b$ and display math stay supported.
export const remarkLiteralShellDollars: Plugin<[], Root> = () => (tree, file) => {
  const source = String(file.value)
  const shellExpansion = /^\$(?:[A-Za-z_][A-Za-z0-9_]*(?=[/"'])|\{[A-Za-z_][A-Za-z0-9_]*(?:\}|:[-+?=])|\()/
  function visit(parent: Root | RootContent) {
    if (!('children' in parent)) return
    for (let index = 0; index < parent.children.length; index++) {
      const child = parent.children[index]!
      const start = child.position?.start.offset
      const end = child.position?.end.offset
      if (child.type === 'inlineMath' && start !== undefined && end !== undefined
        && shellExpansion.test(source.slice(start))
        && (shellExpansion.test(source.slice(end - 1)) || /["';]/.test(child.value))) {
        parent.children[index] = { type: 'text', value: source.slice(start, end), position: child.position }
      } else {
        visit(child)
      }
    }
  }
  visit(tree)
}
