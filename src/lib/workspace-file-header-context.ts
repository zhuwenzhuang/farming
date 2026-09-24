import type { WorkspaceFileTreeNode } from './workspace-file-tree'

// Built only when expansion/data changes. Scroll frames index this projection;
// they never walk the expanded tree or measure individual virtual rows.
export function workspaceFileHeaderParents(nodes: readonly WorkspaceFileTreeNode[], openPaths: ReadonlySet<string>) {
  const parents: string[] = []
  const visit = (children: readonly WorkspaceFileTreeNode[], parent: string) => {
    for (const node of children) {
      parents.push(parent)
      if (node.type === 'directory' && openPaths.has(node.path)) visit(node.children ?? [], node.path)
    }
  }
  visit(nodes, '')
  return parents
}

export function workspaceFileHeaderDirectory(parents: readonly string[], treeTop: number, boundary: number, bottom: number, rowHeight: number) {
  if (rowHeight <= 0 || boundary >= bottom || treeTop >= bottom || boundary <= treeTop) return ''
  return parents[Math.floor((boundary - treeTop) / rowHeight)] ?? ''
}

export function workspaceFileHeaderLabel(path: string, width: number, measure: (text: string) => number) {
  const segments = path.split('/')
  const full = segments.join(' / ')
  if (measure(full) <= width) return full
  for (let start = 1; start < segments.length; start++) {
    const suffix = `… / ${segments.slice(start).join(' / ')}`
    if (measure(suffix) <= width) return suffix
  }
  // The label surface ellipsizes the last name only after dropping all parents.
  return segments.length > 1 ? `… / ${segments[segments.length - 1]}` : full
}
