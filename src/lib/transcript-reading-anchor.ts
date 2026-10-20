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
const TRANSCRIPT_BOTTOM_EPSILON = 2

export function transcriptBottomDistance(element: HTMLElement) {
  return element.scrollHeight - element.clientHeight - element.scrollTop
}

export function isTranscriptNearBottom(element: HTMLElement) {
  return transcriptBottomDistance(element) <= TRANSCRIPT_BOTTOM_FOLLOW_THRESHOLD
}

export function isTranscriptAtBottom(element: HTMLElement) {
  return transcriptBottomDistance(element) <= TRANSCRIPT_BOTTOM_EPSILON
}

function lastRenderedChild(element: Element) {
  let child = element.lastElementChild
  while (child && child.getClientRects().length === 0) child = child.previousElementSibling
  return child
}

export function hasTranscriptContentBelow(element: HTMLElement) {
  const last = lastRenderedChild(element)
  const content = last?.matches('[data-turn-id]') ? lastRenderedChild(last) || last : last
  return Boolean(content && content.getBoundingClientRect().bottom
    > element.getBoundingClientRect().bottom + TRANSCRIPT_BOTTOM_EPSILON)
}

export function shrinkTranscriptTurnRunway(element: HTMLElement) {
  const turn = element.querySelector<HTMLElement>(':scope > .turn-focus-runway')
  const content = turn && lastRenderedChild(turn)
  if (!turn || !content) return
  const rect = turn.getBoundingClientRect()
  const blank = Math.max(0, rect.bottom - content.getBoundingClientRect().bottom)
  // Keep a tiny scroll remainder so a geometry-only resize cannot masquerade
  // as the user's explicit return to bottom and resume following live output.
  const excess = transcriptBottomDistance(element) - TRANSCRIPT_BOTTOM_EPSILON * 2
  const shrink = Math.min(blank, excess)
  if (shrink > TRANSCRIPT_BOTTOM_EPSILON) {
    element.style.setProperty('--code-transcript-runway-height', `${Math.max(0, rect.height - shrink)}px`)
  }
}

export function captureTranscriptReadingAnchor(agentId: string, element: HTMLDivElement, skipPrompt = false): ReadingAnchor | null | undefined {
  if (isTranscriptAtBottom(element)) {
    return null
  }
  const scrollerRect = element.getBoundingClientRect()
  const turns = Array.from(element.querySelectorAll<HTMLElement>('[data-turn-id]'))
  const turn = turns.find(candidate => candidate.getBoundingClientRect().bottom > scrollerRect.top)
  if (!turn) return undefined
  const processItem = Array.from(turn.querySelectorAll<HTMLElement>('[data-process-item-id]'))
    .find(candidate => {
      // A bounded page repeats its owning prompt before the actual history.
      // When prepending, anchor the content after that fixed context instead.
      if (skipPrompt && candidate.dataset.processItemId === `${turn.dataset.turnId}-user`) return false
      const rect = candidate.getBoundingClientRect()
      return rect.bottom > scrollerRect.top
    })
  const target = processItem || turn
  const targetRect = target.getBoundingClientRect()
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
    position: { unit: 'pixel', value: scrollerRect.top - targetRect.top },
  }
}

export function persistTranscriptReadingAnchor(agentId: string, anchor: ReadingAnchor | null) {
  if (anchor) saveReadingAnchor(anchor)
  else clearReadingAnchor(readingAnchorAgentKey(agentId, 'chat'))
}

export function restoreTranscriptReadingAnchor(
  agentId: string,
  element: HTMLDivElement,
  anchor = readReadingAnchor(readingAnchorAgentKey(agentId, 'chat')),
): TranscriptAnchorRestoreResult {
  const key = readingAnchorAgentKey(agentId, 'chat')
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
  // The owning prompt can be present while the anchored history page is not.
  if (anchor.locator.childId && !processItem) return 'missing'
  const target = processItem || turn
  const targetRect = target.getBoundingClientRect()
  const scrollerRect = element.getBoundingClientRect()
  const targetOffset = anchor.position.unit === 'pixel'
    ? anchor.position.value
    : targetRect.height * anchor.position.value
  element.scrollTop += targetRect.top + targetOffset - scrollerRect.top
  return 'restored'
}
