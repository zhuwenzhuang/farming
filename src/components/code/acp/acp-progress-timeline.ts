export interface AcpProgressTimelineItem {
  id?: string
  type?: string
  kind?: string
  status?: string
}

export type AcpProgressFlowEntry<T extends AcpProgressTimelineItem> =
  | { kind: 'item'; item: T }
  | { kind: 'group'; id: string; items: T[] }

type ActionKind = 'edit' | 'read' | 'search' | 'execute' | 'fetch' | 'tool'

function actionKind(item: AcpProgressTimelineItem): ActionKind | null {
  const type = String(item.type || '').trim().toLowerCase()
  const kind = String(item.kind || '').trim().toLowerCase()
  if (type === 'thought' || type === 'progress' || type === 'plan') return null
  if (type === 'patch' || ['edit', 'delete', 'move'].includes(kind)) return 'edit'
  if (kind === 'read' || type === 'file-read' || type === 'read') return 'read'
  if (kind === 'search' || type === 'search' || type === 'web-search') return 'search'
  if (kind === 'execute' || type === 'command') return 'execute'
  if (kind === 'fetch') return 'fetch'
  return 'tool'
}

function actionLabel(kind: ActionKind, count: number) {
  if (kind === 'edit') return count === 1 ? 'Edited a file' : 'Edited files'
  if (kind === 'read') return count === 1 ? 'Read a file' : 'Read files'
  if (kind === 'search') return count === 1 ? 'Searched code' : `Searched code ${count} times`
  if (kind === 'execute') return count === 1 ? 'Ran a command' : 'Ran commands'
  if (kind === 'fetch') return count === 1 ? 'Fetched a resource' : 'Fetched resources'
  return count === 1 ? 'Used a tool' : 'Used tools'
}

export function acpActionGroupLabel(items: AcpProgressTimelineItem[]) {
  const failedCount = items.filter(item => (
    ['failed', 'rejected', 'cancelled', 'canceled'].includes(String(item.status || '').toLowerCase())
  )).length
  if (failedCount > 0) return failedCount === 1 ? 'Action failed' : `${failedCount} actions failed`

  const counts = new Map<ActionKind, number>()
  for (const item of items) {
    const kind = actionKind(item)
    if (!kind) continue
    counts.set(kind, (counts.get(kind) || 0) + 1)
  }
  if (counts.size === 0) return 'Reasoning'

  return [...counts.entries()]
    .map(([kind, count], index) => {
      const label = actionLabel(kind, count)
      return index === 0 ? label : `${label.charAt(0).toLowerCase()}${label.slice(1)}`
    })
    .join(', ')
}

export function isAcpProgressUpdate(item: AcpProgressTimelineItem) {
  return String(item.type || '').trim().toLowerCase() === 'progress'
}

function isAcpProgressBoundary(item: AcpProgressTimelineItem) {
  const type = String(item.type || '').trim().toLowerCase()
  return type === 'progress' || type === 'user-steer'
}

export function acpProgressFlowEntries<T extends AcpProgressTimelineItem>(
  items: T[],
): AcpProgressFlowEntry<T>[] {
  const entries: AcpProgressFlowEntry<T>[] = []
  let evidence: T[] = []
  const flushEvidence = () => {
    if (evidence.length === 0) return
    if (evidence.every(item => actionKind(item) === null)) {
      entries.push(...evidence.map(item => ({ kind: 'item' as const, item })))
      evidence = []
      return
    }
    entries.push({
      kind: 'group',
      id: `group:${String(evidence[0]?.id || '')}`,
      items: evidence,
    })
    evidence = []
  }

  for (const item of items) {
    if (String(item.type || '').trim().toLowerCase() === 'plan') continue
    if (!isAcpProgressBoundary(item)) {
      evidence.push(item)
      continue
    }
    flushEvidence()
    entries.push({ kind: 'item', item })
  }
  flushEvidence()
  return entries
}
