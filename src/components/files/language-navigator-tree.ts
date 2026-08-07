import type { LanguageNavigatorSource } from './language-navigator-ownership'

export interface LanguageNavigatorNode {
  key: string
  id?: string
  name: string
  detail: string
  kind: number
  path: string
  lineNumber: number
  column: number
  source: LanguageNavigatorSource
  children?: LanguageNavigatorNode[]
  expanded?: boolean
  loading?: boolean
  error?: string
}

export function languageNavigatorLocationLabel(path: string, lineNumber: number) {
  const normalized = path.replace(/\\/g, '/')
  const basename = normalized.split('/').pop() || normalized
  return `${basename}:${lineNumber}`
}

export function languageNavigatorDirectoryLabel(path: string) {
  const segments = path.replace(/\\/g, '/').split('/').filter(Boolean)
  const directories = segments.slice(0, -1)
  if (directories.length === 0) return ''
  const suffix = directories.slice(-2).join('/')
  return directories.length > 2 ? `…/${suffix}` : suffix
}

export function updateLanguageNavigatorNode(
  nodes: LanguageNavigatorNode[],
  key: string,
  updater: (node: LanguageNavigatorNode) => LanguageNavigatorNode,
): LanguageNavigatorNode[] {
  return nodes.map(node => {
    if (node.key === key) return updater(node)
    if (!node.children?.length) return node
    return { ...node, children: updateLanguageNavigatorNode(node.children, key, updater) }
  })
}

export function toggleLanguageNavigatorNode(
  nodes: LanguageNavigatorNode[],
  key: string,
): LanguageNavigatorNode[] {
  return updateLanguageNavigatorNode(nodes, key, node => ({ ...node, expanded: !node.expanded }))
}

export function beginLanguageNavigatorNodeLoad(
  nodes: LanguageNavigatorNode[],
  key: string,
): LanguageNavigatorNode[] {
  return updateLanguageNavigatorNode(nodes, key, node => ({
    ...node,
    expanded: true,
    loading: true,
    error: undefined,
  }))
}

export function completeLanguageNavigatorNodeLoad(
  nodes: LanguageNavigatorNode[],
  key: string,
  children: LanguageNavigatorNode[],
): LanguageNavigatorNode[] {
  return updateLanguageNavigatorNode(nodes, key, node => ({
    ...node,
    loading: false,
    error: undefined,
    children,
  }))
}

export function failLanguageNavigatorNodeLoad(
  nodes: LanguageNavigatorNode[],
  key: string,
  error: string,
): LanguageNavigatorNode[] {
  return updateLanguageNavigatorNode(nodes, key, node => ({
    ...node,
    loading: false,
    error,
  }))
}
