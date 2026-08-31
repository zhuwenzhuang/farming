import { useInteractionLayer } from '@/hooks/useInteractionLayer'
import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react'
import type { Agent } from '@/types/agent'
import { isCompactViewport } from '@/lib/responsive-mode'
import { projectCanDeleteWorktree } from './capabilities'
import { scheduleFocusRetries } from './focus-retry'
import {
  clampContextMenuPoint,
  estimateAgentContextMenuHeight,
  estimateContextMenuHeight,
  mobileActionMenuPoint,
  outwardContextMenuPoint,
} from './menu-position'
import type { ProjectGroup } from './types'

const MOBILE_PROJECT_CONTEXT_MENU_WIDTH = 286

export type WorkspaceContextMenu =
  | { kind: 'agent'; agentId: string; x: number; y: number; focusFirstItem: boolean }
  | { kind: 'project'; projectId: string; protectedAgentIds: string[]; x: number; y: number; returnFocusTarget: HTMLElement; focusFirstItem: boolean }
  | { kind: 'agent-session'; provider: string; sessionId: string; x: number; y: number; focusFirstItem: boolean }
  | { kind: 'options'; x: number; y: number; returnFocusTarget: HTMLElement | null; focusFirstItem: boolean }

type WorkspaceContextMenuTriggerEvent = ReactMouseEvent<HTMLElement> | ReactKeyboardEvent<HTMLElement>

interface UseWorkspaceContextMenuOptions {
  agents: Agent[]
  projects: ProjectGroup[]
  canCreateAgentBrowser: boolean
  canCreateAgentDesktop: (agent: Agent) => boolean
  focusAgent: (agentId: string) => void
  focusAgentSession: (provider: string, sessionId: string) => void
  focusProject: (projectId: string) => void
}

function isKeyboardEvent(event: WorkspaceContextMenuTriggerEvent): event is ReactKeyboardEvent<HTMLElement> {
  return 'key' in event
}

function isKeyboardMenuTrigger(event: WorkspaceContextMenuTriggerEvent) {
  return isKeyboardEvent(event) || (event.type === 'click' && event.detail === 0)
}

function acceptsKeyboardMenuTrigger(event: WorkspaceContextMenuTriggerEvent) {
  return !isKeyboardEvent(event) || event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')
}

function prepareMenuTrigger(event: WorkspaceContextMenuTriggerEvent) {
  if (!acceptsKeyboardMenuTrigger(event)) return false
  event.preventDefault()
  event.stopPropagation()
  return true
}

function anchoredMenuPoint(event: WorkspaceContextMenuTriggerEvent, estimatedHeight: number) {
  const pointBelowTarget = () => {
    const rect = event.currentTarget.getBoundingClientRect()
    return clampContextMenuPoint(rect.left + 24, rect.top + rect.height, estimatedHeight)
  }
  if (isKeyboardEvent(event)) return pointBelowTarget()
  if (event.type === 'click' && event.detail === 0) return pointBelowTarget()
  return clampContextMenuPoint(event.clientX, event.clientY, estimatedHeight)
}

export function useWorkspaceContextMenu({
  agents, projects, canCreateAgentBrowser, canCreateAgentDesktop,
  focusAgent, focusAgentSession, focusProject,
}: UseWorkspaceContextMenuOptions) {
  const [contextMenu, setContextMenu] = useState<WorkspaceContextMenu | null>(null)
  const contextMenuRef = useRef<HTMLDivElement>(null)
  const userNavigatedRef = useRef(false)
  const focusIndexRef = useRef(-1)
  const closeContextMenu = useCallback(() => setContextMenu(null), [])
  const closeContextMenuAndRestoreFocus = useCallback(() => {
    const closingMenu = contextMenu
    setContextMenu(null)
    if (closingMenu?.kind === 'agent') focusAgent(closingMenu.agentId)
    else if (closingMenu?.kind === 'project') {
      window.requestAnimationFrame(() => {
        if (closingMenu.returnFocusTarget.isConnected) {
          closingMenu.returnFocusTarget.focus({ preventScroll: true })
        } else {
          focusProject(closingMenu.projectId)
        }
      })
    }
    else if (closingMenu?.kind === 'agent-session') focusAgentSession(closingMenu.provider, closingMenu.sessionId)
    else if (closingMenu?.kind === 'options' && closingMenu.returnFocusTarget) {
      window.requestAnimationFrame(() => closingMenu.returnFocusTarget?.focus({ preventScroll: true }))
    }
  }, [contextMenu, focusAgent, focusAgentSession, focusProject])
  const openAgentMenu = useCallback((event: WorkspaceContextMenuTriggerEvent, agentId: string) => {
    if (!prepareMenuTrigger(event)) return
    const agent = agents.find(candidate => candidate.id === agentId)
    const height = estimateAgentContextMenuHeight(agent, {
      canCreateBrowser: canCreateAgentBrowser,
      canCreateDesktop: Boolean(agent && canCreateAgentDesktop(agent)),
    })
    const point = anchoredMenuPoint(event, height)
    setContextMenu({ kind: 'agent', agentId, ...point, focusFirstItem: isKeyboardMenuTrigger(event) })
  }, [agents, canCreateAgentBrowser, canCreateAgentDesktop])
  const openProjectMenu = useCallback((
    event: WorkspaceContextMenuTriggerEvent,
    projectId: string,
    protectedAgentIds: readonly string[] = [],
  ) => {
    if (!prepareMenuTrigger(event)) return
    const rect = event.currentTarget.getBoundingClientRect()
    const project = projects.find(item => item.id === projectId)
    const itemCount = project?.hasMain ? 4 : projectCanDeleteWorktree(project) ? 8 : 7
    const separatorCount = project?.hasMain ? 1 : 2
    const estimatedHeight = estimateContextMenuHeight(itemCount, separatorCount) + itemCount * 8
    const point = isCompactViewport()
      ? mobileActionMenuPoint(rect, estimatedHeight, undefined, MOBILE_PROJECT_CONTEXT_MENU_WIDTH)
      : outwardContextMenuPoint(rect, estimatedHeight)
    setContextMenu({
      kind: 'project',
      projectId,
      protectedAgentIds: Array.from(new Set(protectedAgentIds)),
      ...point,
      returnFocusTarget: event.currentTarget,
      focusFirstItem: isKeyboardMenuTrigger(event),
    })
  }, [projects])

  const openAgentSessionMenu = useCallback((event: WorkspaceContextMenuTriggerEvent, provider: string, sessionId: string) => {
    if (!prepareMenuTrigger(event)) return
    const point = anchoredMenuPoint(event, estimateContextMenuHeight(3))
    setContextMenu({
      kind: 'agent-session',
      provider,
      sessionId,
      ...point,
      focusFirstItem: isKeyboardMenuTrigger(event),
    })
  }, [])
  const openOptionsContextMenu = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    prepareMenuTrigger(event)
    const rect = event.currentTarget.getBoundingClientRect()
    setContextMenu({
      kind: 'options',
      x: Math.max(8, rect.right - 164),
      y: Math.min(window.innerHeight - 12, rect.bottom + 6),
      returnFocusTarget: event.currentTarget,
      focusFirstItem: isKeyboardMenuTrigger(event),
    })
  }, [])

  const handleContextMenuNavigation = useCallback((
    event: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'preventDefault' | 'stopPropagation'>,
    menu: HTMLElement | null,
  ) => {
    if (!menu) return false
    const buttons = Array.from(menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
    if (buttons.length === 0) return false
    const activeIndex = buttons.findIndex(button => button === document.activeElement)
    const currentIndex = activeIndex !== -1
      ? activeIndex
      : Math.min(focusIndexRef.current, buttons.length - 1)
    const focusMenuButton = (index: number) => {
      userNavigatedRef.current = true
      event.preventDefault()
      event.stopPropagation()
      focusIndexRef.current = index
      buttons[index]?.focus()
      return true
    }

    if (event.key === 'Tab') {
      event.preventDefault()
      event.stopPropagation()
      const nextIndex = currentIndex === -1
        ? (event.shiftKey ? buttons.length - 1 : 0)
        : currentIndex + (event.shiftKey ? -1 : 1)
      if (nextIndex < 0 || nextIndex >= buttons.length) {
        closeContextMenuAndRestoreFocus()
        return true
      }
      return focusMenuButton(nextIndex)
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const direction = event.key === 'ArrowDown' ? 1 : -1
      const nextIndex = currentIndex === -1
        ? (direction > 0 ? 0 : buttons.length - 1)
        : (currentIndex + direction + buttons.length) % buttons.length
      return focusMenuButton(nextIndex)
    }
    if (event.key === 'Home' || event.key === 'End') {
      return focusMenuButton(event.key === 'Home' ? 0 : buttons.length - 1)
    }
    return false
  }, [closeContextMenuAndRestoreFocus])

  const handleContextMenuKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented) return
    handleContextMenuNavigation(event.nativeEvent, event.currentTarget)
  }, [handleContextMenuNavigation])

  useInteractionLayer({
    enabled: Boolean(contextMenu),
    elements: () => [contextMenuRef.current],
    onDismiss: reason => {
      if (reason === 'escape') closeContextMenuAndRestoreFocus()
      else closeContextMenu()
    },
  })

  useLayoutEffect(() => {
    if (!contextMenu) return
    const handleNativeKeyDown = (event: KeyboardEvent) => {
      if (handleContextMenuNavigation(event, contextMenuRef.current)) event.stopImmediatePropagation()
    }
    document.addEventListener('keydown', handleNativeKeyDown, true)
    return () => {
      document.removeEventListener('keydown', handleNativeKeyDown, true)
    }
  }, [closeContextMenu, contextMenu, handleContextMenuNavigation])

  useLayoutEffect(() => {
    if (!contextMenu) return
    userNavigatedRef.current = false
    focusIndexRef.current = -1
    if (!contextMenu.focusFirstItem) return
    return scheduleFocusRetries(() => {
      if (userNavigatedRef.current) return
      const menu = contextMenuRef.current
      const activeElement = document.activeElement
      if (!menu || (activeElement instanceof HTMLButtonElement && menu.contains(activeElement))) return
      const firstButton = menu.querySelector<HTMLButtonElement>('button:not(:disabled)')
      if (!firstButton) return
      focusIndexRef.current = 0
      firstButton.focus()
    }, { delays: [0, 80, 180, 360] })
  }, [contextMenu])

  return {
    contextMenu, contextMenuRef,
    agentMenu: contextMenu?.kind === 'agent' ? contextMenu : null,
    projectMenu: contextMenu?.kind === 'project' ? contextMenu : null,
    agentSessionMenu: contextMenu?.kind === 'agent-session' ? contextMenu : null,
    optionsMenu: contextMenu?.kind === 'options' ? contextMenu : null,
    closeContextMenu, closeContextMenuAndRestoreFocus,
    handleContextMenuKeyDown, handleContextMenuNavigation,
    openAgentMenu, openAgentSessionMenu, openOptionsContextMenu, openProjectMenu,
  }
}
