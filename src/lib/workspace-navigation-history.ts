export type WorkspaceNavigationFileView = 'editor' | 'diff'

export type WorkspaceNavigationReason =
  | 'agent'
  | 'file'
  | 'cursor'

export type WorkspaceNavigationEntry =
  | {
      kind: 'agent'
      agentId: string
      reason: WorkspaceNavigationReason
      ts: number
    }
  | {
      kind: 'file'
      agentId: string
      filePath: string
      view: WorkspaceNavigationFileView
      lineNumber: number
      column: number
      endColumn?: number
      reason: WorkspaceNavigationReason
      ts: number
    }

export interface WorkspaceNavigationHistorySnapshot {
  entries: WorkspaceNavigationEntry[]
  index: number
}

export interface WorkspaceNavigationFileInput {
  agentId: string
  filePath: string
  view?: WorkspaceNavigationFileView
  lineNumber?: number
  column?: number
  endColumn?: number
  reason?: WorkspaceNavigationReason
}

export const WORKSPACE_NAVIGATION_MAX_ENTRIES = 50
export const WORKSPACE_NAVIGATION_CURSOR_SETTLE_MS = 650
export const WORKSPACE_NAVIGATION_REPLACE_MS = 1_000
export const WORKSPACE_NAVIGATION_NEAR_LINE_DELTA = 15
export const WORKSPACE_NAVIGATION_MEANINGFUL_LINE_DELTA = 30

export function emptyWorkspaceNavigationHistory(): WorkspaceNavigationHistorySnapshot {
  return {
    entries: [],
    index: -1,
  }
}

export function workspaceNavigationAgentEntry(agentId: string, now = Date.now()): WorkspaceNavigationEntry {
  return {
    kind: 'agent',
    agentId,
    reason: 'agent',
    ts: now,
  }
}

export function workspaceNavigationFileEntry(
  input: WorkspaceNavigationFileInput,
  now = Date.now()
): WorkspaceNavigationEntry {
  return {
    kind: 'file',
    agentId: input.agentId,
    filePath: input.filePath,
    view: input.view ?? 'editor',
    lineNumber: Math.max(1, input.lineNumber ?? 1),
    column: Math.max(1, input.column ?? 1),
    endColumn: input.endColumn,
    reason: input.reason ?? 'file',
    ts: now,
  }
}

export function workspaceNavigationEntriesMatchLocation(
  a: WorkspaceNavigationEntry,
  b: WorkspaceNavigationEntry
) {
  if (a.kind !== b.kind) return false
  if (a.kind === 'agent' && b.kind === 'agent') return a.agentId === b.agentId
  if (a.kind === 'file' && b.kind === 'file') {
    return a.agentId === b.agentId && a.filePath === b.filePath && a.view === b.view
  }
  return false
}

export function shouldReplaceWorkspaceNavigationEntry(
  current: WorkspaceNavigationEntry | undefined,
  next: WorkspaceNavigationEntry
) {
  if (!current) return false
  if (!workspaceNavigationEntriesMatchLocation(current, next)) return false
  if (current.kind === 'agent' && next.kind === 'agent') return true
  if (current.kind !== 'file' || next.kind !== 'file') return false

  const lineDelta = Math.abs(current.lineNumber - next.lineNumber)
  if (
    current.lineNumber === next.lineNumber
    && current.column === next.column
    && current.endColumn === next.endColumn
  ) {
    return true
  }

  if (next.reason === 'cursor') {
    if (lineDelta < WORKSPACE_NAVIGATION_MEANINGFUL_LINE_DELTA) return true
    if (next.ts - current.ts < WORKSPACE_NAVIGATION_REPLACE_MS) return true
  }

  if (lineDelta <= WORKSPACE_NAVIGATION_NEAR_LINE_DELTA) return true
  return false
}

export function pushWorkspaceNavigationEntry(
  state: WorkspaceNavigationHistorySnapshot,
  entry: WorkspaceNavigationEntry,
  maxEntries = WORKSPACE_NAVIGATION_MAX_ENTRIES
): WorkspaceNavigationHistorySnapshot {
  const currentEntry = state.entries[state.index]
  const replace = shouldReplaceWorkspaceNavigationEntry(currentEntry, entry)
  let entries = state.entries
  let index = state.index

  if (replace && index >= 0) {
    entries = entries.slice()
    entries[index] = entry
  } else {
    entries = entries.slice(0, index + 1)
    entries.push(entry)
    if (entries.length > maxEntries) {
      entries = entries.slice(entries.length - maxEntries)
    }
    index = entries.length - 1
  }

  return { entries, index }
}

export function workspaceNavigationShortcutDirection(
  event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'> & { code?: string },
  _platform = typeof navigator !== 'undefined' ? navigator.platform : ''
): -1 | 1 | null {
  const minusKey = event.key === '-' || event.key === '_' || event.code === 'Minus'
  if (!minusKey) return null
  if (!event.ctrlKey || event.metaKey || event.altKey) return null

  return event.shiftKey ? 1 : -1
}
