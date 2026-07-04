import { useEffect } from 'react'

interface BillingDialogProps {
  open: boolean
  onClose: () => void
}

export function BillingDialog({ open, onClose }: BillingDialogProps) {
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="dialog-overlay" data-testid="billing-overlay">
      <div className="history-dialog fx-crt-panel" data-testid="billing-dialog">
        <div className="dialog-header fx-crt-panel-compact">
          <div className="dialog-header-copy">
            <div className="dialog-header-title">Billing</div>
          </div>
          <button type="button" className="close-btn" onClick={onClose}>Close [Esc]</button>
        </div>
        <div className="history-empty billing-placeholder">
          No billing integration configured.
        </div>
      </div>
    </div>
  )
}
