import type { Agent } from '@/types/agent'
import { agentMenuShape } from './capabilities'

export const CONTEXT_MENU_WIDTH = 220
const CONTEXT_MENU_MARGIN = 8
const CONTEXT_MENU_ITEM_HEIGHT = 26
const CONTEXT_MENU_SEPARATOR_HEIGHT = 11
const CONTEXT_MENU_PADDING_HEIGHT = 10

interface ContextMenuViewport {
  width: number
  height: number
}

interface ContextMenuAnchorRect {
  left: number
  right: number
  top: number
}

interface ContextMenuActionAnchorRect extends ContextMenuAnchorRect {
  bottom: number
}

function currentViewport(): ContextMenuViewport {
  if (typeof window === 'undefined') {
    return {
      width: CONTEXT_MENU_WIDTH + CONTEXT_MENU_MARGIN * 2,
      height: CONTEXT_MENU_PADDING_HEIGHT + CONTEXT_MENU_MARGIN * 2,
    }
  }
  return { width: window.innerWidth, height: window.innerHeight }
}

export function estimateContextMenuHeight(itemCount: number, separatorCount = 0) {
  return CONTEXT_MENU_PADDING_HEIGHT
    + itemCount * CONTEXT_MENU_ITEM_HEIGHT
    + separatorCount * CONTEXT_MENU_SEPARATOR_HEIGHT
}

export function clampContextMenuPoint(
  x: number,
  y: number,
  estimatedHeight: number,
  viewport: ContextMenuViewport = currentViewport(),
  estimatedWidth = CONTEXT_MENU_WIDTH
) {
  const maxX = Math.max(CONTEXT_MENU_MARGIN, viewport.width - estimatedWidth - CONTEXT_MENU_MARGIN)
  const maxY = Math.max(CONTEXT_MENU_MARGIN, viewport.height - estimatedHeight - CONTEXT_MENU_MARGIN)

  return {
    x: Math.max(CONTEXT_MENU_MARGIN, Math.min(x, maxX)),
    y: Math.max(CONTEXT_MENU_MARGIN, Math.min(y, maxY)),
  }
}

export function outwardContextMenuPoint(
  anchor: ContextMenuAnchorRect,
  estimatedHeight: number,
  viewport: ContextMenuViewport = currentViewport(),
  estimatedWidth = CONTEXT_MENU_WIDTH
) {
  const rightX = anchor.right + CONTEXT_MENU_MARGIN
  const leftX = anchor.left - estimatedWidth - CONTEXT_MENU_MARGIN
  const x = rightX + estimatedWidth <= viewport.width - CONTEXT_MENU_MARGIN
    ? rightX
    : leftX >= CONTEXT_MENU_MARGIN
      ? leftX
      : clampContextMenuPoint(rightX, anchor.top, estimatedHeight, viewport, estimatedWidth).x

  return {
    x,
    y: clampContextMenuPoint(x, anchor.top, estimatedHeight, viewport, estimatedWidth).y,
  }
}

export function mobileActionMenuPoint(
  anchor: ContextMenuActionAnchorRect,
  estimatedHeight: number,
  viewport: ContextMenuViewport = currentViewport(),
  estimatedWidth = CONTEXT_MENU_WIDTH
) {
  const maxX = Math.max(CONTEXT_MENU_MARGIN, viewport.width - estimatedWidth - CONTEXT_MENU_MARGIN)
  const x = Math.max(CONTEXT_MENU_MARGIN, Math.min(anchor.right - estimatedWidth, maxX))
  const belowY = anchor.bottom + 6
  const maxY = Math.max(CONTEXT_MENU_MARGIN, viewport.height - estimatedHeight - CONTEXT_MENU_MARGIN)
  const aboveY = anchor.top - estimatedHeight - 6

  return {
    x,
    y: belowY <= maxY ? belowY : Math.max(CONTEXT_MENU_MARGIN, Math.min(aboveY, maxY)),
  }
}

export function estimateAgentContextMenuHeight(agent: Agent | undefined) {
  const shape = agentMenuShape(agent)
  return estimateContextMenuHeight(shape.itemCount, shape.separatorCount)
}
