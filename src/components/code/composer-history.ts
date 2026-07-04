export type ComposerHistoryDirection = 'previous' | 'next'

export interface ComposerHistoryState {
  entries: string[]
  cursor: number | null
}

export interface ComposerHistoryNavigationInput {
  direction: ComposerHistoryDirection
  value: string
  selectionStart: number
  selectionEnd: number
}

export const DEFAULT_COMPOSER_HISTORY_LIMIT = 100

export function createDefaultComposerHistoryState(): ComposerHistoryState {
  return {
    entries: [],
    cursor: null,
  }
}

export function addComposerHistoryEntry(
  history: ComposerHistoryState,
  value: string,
  limit = DEFAULT_COMPOSER_HISTORY_LIMIT
): ComposerHistoryState {
  const entry = value.trimEnd()
  if (!entry) return { ...history, cursor: null }

  const maxEntries = Math.max(1, limit)
  const entries = history.entries[history.entries.length - 1] === entry
    ? history.entries
    : [...history.entries, entry].slice(-maxEntries)

  return {
    entries,
    cursor: null,
  }
}

export function canUseComposerHistoryNavigation(input: ComposerHistoryNavigationInput) {
  const value = input.value || ''
  const selectionStart = Math.max(0, Math.min(input.selectionStart, value.length))
  const selectionEnd = Math.max(0, Math.min(input.selectionEnd, value.length))
  if (selectionStart !== selectionEnd) return false

  if (input.direction === 'previous') {
    return value.lastIndexOf('\n', Math.max(0, selectionStart - 1)) === -1
  }

  return value.indexOf('\n', selectionStart) === -1
}

export function navigateComposerHistory(
  history: ComposerHistoryState,
  direction: ComposerHistoryDirection,
  value: string
): { history: ComposerHistoryState; value: string; changed: boolean } {
  if (history.entries.length === 0) {
    return { history: { ...history, cursor: null }, value, changed: false }
  }

  const currentCursor = history.cursor
  const browsingHistory = currentCursor !== null && history.entries[currentCursor] === value
  const canStartBrowsing = currentCursor === null && value === ''

  if (!browsingHistory && !canStartBrowsing) {
    return { history: { ...history, cursor: null }, value, changed: false }
  }

  if (direction === 'previous') {
    const nextCursor = browsingHistory
      ? Math.max(0, currentCursor)
      : history.entries.length - 1
    const olderCursor = browsingHistory ? Math.max(0, nextCursor - 1) : nextCursor
    const nextValue = history.entries[olderCursor] || ''
    return {
      history: { ...history, cursor: olderCursor },
      value: nextValue,
      changed: nextValue !== value || history.cursor !== olderCursor,
    }
  }

  if (!browsingHistory || currentCursor === null) {
    return { history: { ...history, cursor: null }, value, changed: false }
  }

  const nextCursor = currentCursor + 1
  if (nextCursor >= history.entries.length) {
    return {
      history: { ...history, cursor: null },
      value: '',
      changed: value !== '' || history.cursor !== null,
    }
  }

  const nextValue = history.entries[nextCursor] || ''
  return {
    history: { ...history, cursor: nextCursor },
    value: nextValue,
    changed: nextValue !== value || history.cursor !== nextCursor,
  }
}
