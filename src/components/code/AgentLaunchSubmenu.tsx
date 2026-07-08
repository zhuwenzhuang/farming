import { useCallback, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'
import { ChevronRightGlyph } from '@/components/IconGlyphs'
import { agentDisplayName } from '@/lib/format'
import type { AgentLaunchOption } from './agent-launch-options'

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
  const [side, setSide] = useState<'left' | 'right'>('right')
  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const closeTimerRef = useRef<number | null>(null)
  const hasOptions = options.length > 0

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current === null) return
    window.clearTimeout(closeTimerRef.current)
    closeTimerRef.current = null
  }, [])

  const openSubmenu = useCallback((trigger: HTMLElement | null = triggerRef.current) => {
    if (!hasOptions) return
    clearCloseTimer()
    const rect = trigger?.getBoundingClientRect()
    const expectedWidth = 156
    if (rect && rect.right + expectedWidth + 12 > window.innerWidth) {
      setSide('left')
    } else {
      setSide('right')
    }
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
    openSubmenu(event.currentTarget.querySelector<HTMLElement>('button'))
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
      openSubmenu(event.currentTarget)
      focusFirstOption()
    }
  }, [focusFirstOption, hasOptions, openSubmenu])

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
        onClick={onOpenDialog}
        onKeyDown={handleTriggerKeyDown}
      >
        <span>{label}</span>
        {hasOptions && <ChevronRightGlyph className="code-agent-launch-submenu-arrow" />}
      </button>
      {hasOptions && open && (
        <div
          ref={panelRef}
          className={`code-agent-launch-submenu-panel ${side}`}
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
              onClick={() => onSelect(option.name)}
            >
              {agentDisplayName(option.name)}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
