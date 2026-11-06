import { useRef, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { CloseGlyph } from '@/components/IconGlyphs'
import { useModalFocusScope } from '@/hooks/useModalFocusScope'

// Full-viewport content inspection shares one shell, focus scope and toolbar
// geometry. The content renderer retains zoom, pan and source ownership.
export function ContentViewerDialog({ title, closeLabel, onClose, returnFocusRef, actions, children, testId, dismissOnClick = false }: {
  title: string
  closeLabel: string
  onClose: () => void
  returnFocusRef: RefObject<HTMLElement | null>
  actions?: ReactNode
  children: ReactNode
  testId?: string
  // Static images close on a completed click/tap; interactive diagrams do not.
  dismissOnClick?: boolean
}) {
  const closeRef = useRef<HTMLButtonElement | null>(null)
  const dialogRef = useModalFocusScope<HTMLDivElement>({ open: true, initialFocusRef: closeRef, returnFocusRef, onEscape: onClose })
  return createPortal(
    <div ref={dialogRef} className="code-content-viewer" role="dialog" aria-modal="true" aria-label={title} data-testid={testId}
      onClick={dismissOnClick ? onClose : undefined}>
      <header className="code-content-viewer-header">
        <span className="code-content-viewer-title">{title}</span>
        <div className="code-content-viewer-actions">
          {actions}
          <button ref={closeRef} type="button" onClick={event => { event.stopPropagation(); onClose() }} aria-label={closeLabel} title={closeLabel}><CloseGlyph /></button>
        </div>
      </header>
      <div className="code-content-viewer-body">{children}</div>
    </div>, document.body,
  )
}
