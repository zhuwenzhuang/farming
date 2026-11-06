import { useId, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { useInteractionLayer } from '@/hooks/useInteractionLayer'

/** Context inspection is an explicit toggle for both Chat and Terminal. */
export function ComposerContextWindow({ label, percentUsed, level, testId, children }: {
  label: string
  percentUsed: number
  level?: string
  testId: string
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const id = useId()
  useInteractionLayer({
    enabled: open,
    elements: () => [trigger.current],
    onDismiss: () => setOpen(false),
    returnFocus: () => trigger.current,
  })
  return (
    <button ref={trigger} type="button" className="code-composer-context-window"
      data-testid={testId} data-level={level} aria-label={label}
      aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}>
      <span className="code-context-window-ring" aria-hidden="true"
        style={{ '--context-percent': percentUsed } as CSSProperties} />
      <span id={id} className="code-context-window-popover" role="tooltip" hidden={!open}>
        {children}
      </span>
    </button>
  )
}
