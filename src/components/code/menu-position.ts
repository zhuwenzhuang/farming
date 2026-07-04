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

export function estimateAgentContextMenuHeight(agent: Agent | undefined) {
  const shape = agentMenuShape(agent)
  return estimateContextMenuHeight(shape.itemCount, shape.separatorCount)
}
