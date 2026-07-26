import { Children, isValidElement, type ReactNode } from 'react'

export function markdownTextContent(children: unknown): string {
  if (children === null || children === undefined || typeof children === 'boolean') return ''
  if (typeof children === 'string' || typeof children === 'number') return String(children)
  if (Array.isArray(children)) return children.map(markdownTextContent).join('')
  if (isValidElement(children)) {
    return markdownTextContent((children.props as { children?: unknown }).children)
  }
  return ''
}

export function mermaidCodeBlockSource(children: ReactNode) {
  const child = Children.count(children) === 1 ? Children.only(children) : null
  if (!isValidElement(child)) return null
  const props = child.props as { className?: string; children?: ReactNode }
  if (!/\blanguage-mermaid\b/i.test(props.className || '')) return null
  return markdownTextContent(props.children).replace(/\n$/, '')
}
