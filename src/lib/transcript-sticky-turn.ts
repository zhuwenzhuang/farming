import type { AgentTranscriptTurn, AgentTranscriptUserImage } from '@/components/code/acp/acp-entry-projection'

export interface StickyTurnPromptState {
  turnId: string
  summary: string
  text?: string
  images?: AgentTranscriptUserImage[]
}

export interface StickyTurnRectCandidate {
  turnId: string
  summary: string
  text?: string
  images?: AgentTranscriptUserImage[]
  turnTop: number
  turnBottom: number
  headerBottom: number
}

const STICKY_TURN_MIN_VISIBLE_BODY_PX = 56
const STICKY_TURN_HEADER_CLEARANCE_PX = 4
const STICKY_TURN_SCROLL_TOP_OFFSET_PX = 18
const COMPACT_STICKY_TURN_SCROLL_TOP_OFFSET_PX = 8
const MAX_STICKY_TURN_IMAGES = 3

export function turnStickyPromptImages(turn: AgentTranscriptTurn | undefined | null): AgentTranscriptUserImage[] {
  if (!turn || turn.handoffContext || turn.userSource) return []
  return (turn.userImages || [])
    .filter(image => Boolean(image && String(image.url || '').trim()))
    .slice(0, MAX_STICKY_TURN_IMAGES)
}

export function turnStickyPromptText(turn: AgentTranscriptTurn | undefined | null): string {
  if (!turn || turn.handoffContext || turn.userSource) return ''
  const message = String(turn.userMessage || '').replace(/\s+/g, ' ').trim()
  if (message) return message
  const nonImageAttachments = [
    ...(turn.userFiles || []).map(file => file.name),
    ...(turn.userAudios || []).map(audio => audio.name || 'Audio'),
  ].map(label => String(label || '').trim()).filter(Boolean)
  return nonImageAttachments.join(', ')
}

export function turnStickyPromptSummary(turn: AgentTranscriptTurn | undefined | null): string {
  if (!turn || turn.handoffContext || turn.userSource) return ''
  const message = String(turn.userMessage || '').replace(/\s+/g, ' ').trim()
  if (message) return message
  const attachments = [
    ...(turn.userImages || []).map(image => image.alt || 'Image'),
    ...(turn.userFiles || []).map(file => file.name),
    ...(turn.userAudios || []).map(audio => audio.name || 'Audio'),
  ].map(label => String(label || '').trim()).filter(Boolean)
  return attachments.join(', ')
}

export function shouldApplyTurnFocusRunway(
  turns: readonly AgentTranscriptTurn[],
  index: number,
  stickyTurnPromptEnabled: boolean,
  hasBoundaryBeforeTurn = false,
): boolean {
  if (!stickyTurnPromptEnabled) return false
  if (turns.length <= 1 || index !== turns.length - 1) return false
  if (hasBoundaryBeforeTurn) return false
  return Boolean(turnStickyPromptSummary(turns[index]))
}

export function resolveStickyTurnPromptFromRects(
  scrollerTop: number,
  candidates: readonly StickyTurnRectCandidate[],
): StickyTurnPromptState | null {
  for (const candidate of candidates) {
    if (!candidate.summary) continue
    if (candidate.turnBottom <= scrollerTop + STICKY_TURN_MIN_VISIBLE_BODY_PX) continue
    if (candidate.headerBottom <= scrollerTop + STICKY_TURN_HEADER_CLEARANCE_PX) {
      return {
        turnId: candidate.turnId,
        summary: candidate.summary,
        ...(candidate.text !== undefined ? { text: candidate.text } : {}),
        ...(candidate.images && candidate.images.length > 0 ? { images: candidate.images } : {}),
      }
    }
    if (candidate.turnTop >= scrollerTop) {
      break
    }
  }
  return null
}

export function resolveStickyTurnPrompt(
  element: HTMLDivElement | null,
  turns: readonly AgentTranscriptTurn[],
  enabled: boolean,
): StickyTurnPromptState | null {
  if (!enabled || !element || turns.length === 0) return null
  const scrollerRect = element.getBoundingClientRect()
  if (scrollerRect.height <= 0) return null
  const turnsById = new Map<string, AgentTranscriptTurn>()
  for (const turn of turns) {
    turnsById.set(turn.id, turn)
  }
  const turnElements = element.querySelectorAll<HTMLElement>('[data-turn-id]')
  const candidates: StickyTurnRectCandidate[] = []
  for (const turnElement of turnElements) {
    const turnId = turnElement.dataset.turnId || ''
    const turn = turnsById.get(turnId)
    const summary = turnStickyPromptSummary(turn)
    if (!turn || !summary) continue
    const text = turnStickyPromptText(turn)
    const images = turnStickyPromptImages(turn)
    const turnRect = turnElement.getBoundingClientRect()
    const userElement = turnElement.querySelector<HTMLElement>(
      `[data-process-item-id="${CSS.escape(turnId)}-user"]`,
    )
    const processSummaryElement = turnElement.querySelector<HTMLElement>(
      '[data-testid="code-agent-transcript-process-summary"]',
    )
    const userBottom = userElement ? userElement.getBoundingClientRect().bottom : turnRect.top
    const processSummaryRect = processSummaryElement?.getBoundingClientRect()
    const headerBottom = processSummaryRect && processSummaryRect.top - userBottom < 40
      ? Math.max(userBottom, processSummaryRect.bottom)
      : userBottom
    candidates.push({
      turnId,
      summary,
      text,
      images,
      turnTop: turnRect.top,
      turnBottom: turnRect.bottom,
      headerBottom,
    })
  }
  return resolveStickyTurnPromptFromRects(scrollerRect.top, candidates)
}

export function scrollTranscriptToTurnStart(
  element: HTMLDivElement,
  turnId: string,
  compact = false,
): boolean {
  const turnElement = element.querySelector<HTMLElement>(`[data-turn-id="${CSS.escape(turnId)}"]`)
  if (!turnElement) return false
  const scrollerRect = element.getBoundingClientRect()
  const turnRect = turnElement.getBoundingClientRect()
  const topOffset = compact ? COMPACT_STICKY_TURN_SCROLL_TOP_OFFSET_PX : STICKY_TURN_SCROLL_TOP_OFFSET_PX
  const nextScrollTop = Math.max(0, element.scrollTop + (turnRect.top - scrollerRect.top) - topOffset)
  element.scrollTop = nextScrollTop
  return true
}
