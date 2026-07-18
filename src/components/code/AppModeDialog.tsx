import { createPortal } from 'react-dom'
import { useEffect, useRef } from 'react'
import { appPath } from '@/lib/base-path'
import type { CodeCopy } from './copy'

export function AppModeDialog({
  canInstall,
  canFullscreen,
  fullscreenActive,
  copy,
  onClose,
  onInstall,
  onToggleFullscreen,
}: {
  canInstall: boolean
  canFullscreen: boolean
  fullscreenActive: boolean
  copy: CodeCopy
  onClose: () => void
  onInstall: () => void
  onToggleFullscreen: () => void
}) {
  const closeButtonRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeButtonRef.current?.focus({ preventScroll: true })
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      previousFocus?.focus({ preventScroll: true })
    }
  }, [onClose])

  return createPortal(
    <div className="code-app-mode-backdrop" data-testid="code-app-mode-dialog" role="presentation" onPointerDown={onClose}>
      <section
        className="code-app-mode-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="code-app-mode-title"
        onPointerDown={event => event.stopPropagation()}
      >
        <button ref={closeButtonRef} type="button" className="code-app-mode-close" aria-label={copy.cancel} onClick={onClose}>×</button>
        <header className="code-app-mode-heading">
          <img src={appPath('/farming-2/app-icon-v2-180.png')} alt="" aria-hidden="true" />
          <div>
            <h2 id="code-app-mode-title">{copy.appModeTitle}</h2>
            <p>{copy.appModeDescription}</p>
          </div>
        </header>

        <section className="code-app-mode-choice recommended">
          <span className="code-app-mode-recommended">{copy.appModeRecommended}</span>
          <h3>{copy.appModeInstallTitle}</h3>
          <p>{copy.appModeInstallDescription}</p>
          {canInstall && (
            <button type="button" className="code-app-mode-install" data-testid="code-app-mode-install" onClick={onInstall}>
              {copy.appModeInstallAction}
            </button>
          )}
          <ol className="code-app-mode-install-steps">
            <li>{copy.appModeInstallStepOne}</li>
            <li>{copy.appModeInstallStepTwo}</li>
          </ol>
        </section>

        {canFullscreen && (
          <section className="code-app-mode-choice temporary">
            <div>
              <h3>{copy.appModeFullscreenTitle}</h3>
              <p>{copy.appModeFullscreenDescription}</p>
            </div>
            <button type="button" data-testid="code-app-mode-fullscreen" onClick={onToggleFullscreen}>
              {fullscreenActive ? copy.exitFocusMode : copy.enterFocusMode}
            </button>
          </section>
        )}
      </section>
    </div>,
    document.body,
  )
}
