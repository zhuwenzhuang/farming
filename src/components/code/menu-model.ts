export type ContextMenuEntry =
  | {
    type: 'item'
    id: string
    label: string
    ariaLabel?: string
    icon?: 'rename' | 'archive'
    removeIcon?: boolean
    checked?: boolean
    disabled?: boolean
    danger?: boolean
    hidden?: boolean
    onSelect: () => void
  }
  | {
    type: 'separator'
    id: string
    hidden?: boolean
  }

export function compactContextMenuEntries(entries: ContextMenuEntry[]) {
  const visible = entries.filter(entry => !entry.hidden)
  const compacted: ContextMenuEntry[] = []

  visible.forEach(entry => {
    if (entry.type === 'separator') {
      if (compacted.length === 0 || compacted[compacted.length - 1]?.type === 'separator') return
    }
    compacted.push(entry)
  })

  while (compacted[compacted.length - 1]?.type === 'separator') {
    compacted.pop()
  }

  return compacted
}
