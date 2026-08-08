// Chat-surface reading anchors for agent transcripts. Builds on the shared
// storage layer in reading-anchor.ts, which owns persistence and keys.
import {
  clearReadingAnchor,
  readReadingAnchor,
  readingAnchorAgentKey,
  saveReadingAnchor,
  type ReadingAnchor,
} from './reading-anchor'

export type TranscriptAnchorRestoreResult = 'none' | 'restored' | 'missing' | 'expired'

export const TRANSCRIPT_BOTTOM_FOLLOW_THRESHOLD = 96

export function transcriptBottomDistance(element: HTMLElement) {
  return element.scrollHeight - element.clientHeight - element.scrollTop
}

export function isTranscriptNearBottom(element: HTMLElement) {
  return transcriptBottomDistance(element) <= TRANSCRIPT_BOTTOM_FOLLOW_THRESHOLD
}

export function captureTranscriptReadingAnchor(agentId: string, element: HTMLDivElement): ReadingAnchor | null | undefined {
  if (isTranscriptNearBottom(element)) {
    return null
  }
  const scrollerRect = element.getBoundingClientRect()
  const turns = Array.from(element.querySelectorAll<HTMLElement>('[data-turn-id]'))
  const turn = turns.find(candidate => candidate.getBoundingClientRect().bottom > scrollerRect.top)
  if (!turn) return undefined
  const processItem = Array.from(turn.querySelectorAll<HTMLElement>('[data-process-item-id]'))
    .find(candidate => candidate.getBoundingClientRect().bottom > scrollerRect.top)
  const target = processItem || turn
  const targetRect = target.getBoundingClientRect()
  const fraction = targetRect.height > 0
    ? Math.max(0, Math.min(1, (scrollerRect.top - targetRect.top) / targetRect.height))
    : 0
  const turnId = turn.dataset.turnId
  if (!turnId) return undefined
  return {
    version: 1,
    surface: 'chat',
    resource: { kind: 'agent', id: agentId },
    locator: {
      kind: 'message',
      id: turnId,
      ...(processItem?.dataset.processItemId ? { childId: processItem.dataset.processItemId } : {}),
    },
    position: { unit: 'fraction', value: fraction },
  }
}

export function persistTranscriptReadingAnchor(agentId: string, anchor: ReadingAnchor | null) {
  if (anchor) saveReadingAnchor(anchor)
  else clearReadingAnchor(readingAnchorAgentKey(agentId, 'chat'))
}

export function restoreTranscriptReadingAnchor(agentId: string, element: HTMLDivElement): TranscriptAnchorRestoreResult {
  const key = readingAnchorAgentKey(agentId, 'chat')
  const anchor = readReadingAnchor(key)
  if (!anchor) return 'none'
  if (anchor.surface !== 'chat' || anchor.resource.kind !== 'agent') {
    clearReadingAnchor(key)
    return 'expired'
  }
  const turn = element.querySelector<HTMLElement>(`[data-turn-id="${CSS.escape(anchor.locator.id)}"]`)
  if (!turn) return 'missing'
  const processItem = anchor.locator.childId
    ? turn.querySelector<HTMLElement>(`[data-process-item-id="${CSS.escape(anchor.locator.childId)}"]`)
    : null
  const target = processItem || turn
  const targetRect = target.getBoundingClientRect()
  const scrollerRect = element.getBoundingClientRect()
  const targetOffset = targetRect.height * anchor.position.value
  element.scrollTop += targetRect.top + targetOffset - scrollerRect.top
  return 'restored'
}
