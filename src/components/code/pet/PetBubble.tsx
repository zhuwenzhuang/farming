import type { ReactNode } from 'react'

interface PetBubbleAction {
  label: string
  primary?: boolean
  onClick: () => void
}

interface PetBubbleProps {
  title: string
  body: ReactNode
  closeLabel: string
  testId: string
  actions: PetBubbleAction[]
  announcement?: string
  error?: string
  children?: ReactNode
  onClose: () => void
}

export function PetBubble({
  title,
  body,
  closeLabel,
  testId,
  actions,
  announcement,
  error,
  children,
  onClose,
}: PetBubbleProps) {
  return (
    <section
      className="code-pet-bubble"
      data-pet-ui
      data-testid={testId}
      role="dialog"
      aria-modal="false"
      aria-label={title}
    >
      {announcement ? (
        <span className="code-visually-hidden" role="status" aria-live="polite">
          {announcement}
        </span>
      ) : null}
      <button
        type="button"
        className="code-pet-close"
        aria-label={closeLabel}
        onClick={onClose}
      >×</button>
      <div className="code-pet-bubble-heading">
        <strong>{title}</strong>
      </div>
      <p>{body}</p>
      {error ? <small className="code-pet-error" role="alert">{error}</small> : null}
      {children}
      {actions.length > 0 && (
        <div className="code-pet-actions">
          {actions.map(action => (
            <button
              key={action.label}
              type="button"
              className={action.primary ? 'primary' : undefined}
              onClick={action.onClick}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
    </section>
  )
}
