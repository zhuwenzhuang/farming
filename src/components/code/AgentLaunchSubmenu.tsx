import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react'
import { ChevronRightGlyph } from '@/components/IconGlyphs'
import { agentDisplayName } from '@/lib/format'
import { isTouchInputViewport } from '@/lib/responsive-mode'
import { useMenuViewportBounds } from '@/hooks/useMenuViewportBounds'
import type { AgentLaunchOption } from './agent-launch-options'
import { AgentLaunchIcon } from './AgentLaunchIcon'

interface AgentLaunchSubmenuProps {
  label: string
  options: AgentLaunchOption[]
  testId?: string
  submenuTestId?: string
  onOpenDialog: () => void
  onSelect: (command: string) => void
}

export function AgentLaunchSubmenu({
  label,
  options,
  testId,
  submenuTestId,
  onOpenDialog,
  onSelect,
}: AgentLaunchSubmenuProps) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({ left: 0, top: 0 })
  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const closeTimerRef = useRef<number | null>(null)
  const hasOptions = options.length > 0
  useLayoutEffect(() => {
    const trigger = triggerRef.current
    const panel = panelRef.current
    if (!open || !trigger || !panel) return
    const owner = trigger.ownerDocument.defaultView
    if (!owner) return
    const viewport = owner.visualViewport
    const positionPanel = (event?: Event) => {
      if (event?.target instanceof Node && panel.contains(event.target)) return
      const rect = trigger.getBoundingClientRect()
      const width = panel.getBoundingClientRect().width
      const viewportRight = (viewport?.offsetLeft ?? 0) + (viewport?.width ?? owner.innerWidth)
      setPosition({
        left: rect.right + width + 14 > viewportRight ? rect.left - width - 6 : rect.right + 6,
        top: rect.top - 5,
      })
    }
    positionPanel()
    owner.addEventListener('scroll', positionPanel, true)
    owner.addEventListener('resize', positionPanel)
    viewport?.addEventListener('resize', positionPanel)
    viewport?.addEventListener('scroll', positionPanel)
    return () => {
      owner.removeEventListener('scroll', positionPanel, true)
      owner.removeEventListener('resize', positionPanel)
      viewport?.removeEventListener('resize', positionPanel)
      viewport?.removeEventListener('scroll', positionPanel)
    }
  }, [open])
  useMenuViewportBounds(open, panelRef, position)

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current === null) return
    window.clearTimeout(closeTimerRef.current)
    closeTimerRef.current = null
  }, [])

  const openSubmenu = useCallback(() => {
    if (!hasOptions) return
    clearCloseTimer()
    setOpen(true)
  }, [clearCloseTimer, hasOptions])

  const scheduleClose = useCallback(() => {
    clearCloseTimer()
    closeTimerRef.current = window.setTimeout(() => {
      setOpen(false)
      closeTimerRef.current = null
    }, 120)
  }, [clearCloseTimer])

  const handlePointerEnter = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== 'mouse') return
    openSubmenu()
  }, [openSubmenu])

  const focusFirstOption = useCallback(() => {
    window.setTimeout(() => {
      panelRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    }, 0)
  }, [])

  const handleTriggerKeyDown = useCallback((event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!hasOptions) return
    if (event.key === 'ArrowRight') {
      event.preventDefault()
      event.stopPropagation()
      openSubmenu()
      focusFirstOption()
    }
  }, [focusFirstOption, hasOptions, openSubmenu])

  const handleTriggerClick = useCallback((event: ReactMouseEvent<HTMLButtonElement>) => {
    if (hasOptions && event.detail > 0 && isTouchInputViewport()) {
      if (open) setOpen(false)
      else openSubmenu()
      return
    }
    onOpenDialog()
  }, [hasOptions, onOpenDialog, open, openSubmenu])

  const handlePanelKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft') return
    event.preventDefault()
    event.stopPropagation()
    setOpen(false)
    triggerRef.current?.focus()
  }, [])

  return (
    <div
      ref={rootRef}
      className="code-agent-launch-submenu"
      onPointerEnter={handlePointerEnter}
      onPointerLeave={scheduleClose}
      onFocus={() => clearCloseTimer()}
      onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setOpen(false)
        }
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        role="menuitem"
        className="code-agent-launch-submenu-trigger"
        data-testid={testId}
        aria-haspopup={hasOptions ? 'menu' : undefined}
        aria-expanded={hasOptions ? open : undefined}
        onClick={handleTriggerClick}
        onKeyDown={handleTriggerKeyDown}
      >
        <span>{label}</span>
        {hasOptions && <ChevronRightGlyph className="code-agent-launch-submenu-arrow" />}
      </button>
      {hasOptions && open && (
        <div
          ref={panelRef}
          className="code-agent-launch-submenu-panel"
          style={position}
          data-testid={submenuTestId}
          role="menu"
          onPointerEnter={() => clearCloseTimer()}
          onPointerLeave={scheduleClose}
          onKeyDown={handlePanelKeyDown}
        >
          {options.map(option => (
            <button
              key={option.name}
              type="button"
              role="menuitem"
              data-testid={`agent-launch-${option.name}`}
              onClick={() => onSelect(option.command || option.name)}
            >
              <AgentLaunchIcon name={option.name} />
              <span>{agentDisplayName(option.name)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
