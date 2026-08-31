import { createPortal } from 'react-dom'
import { useRef } from 'react'
import { appPath } from '@/lib/base-path'
import { useModalFocusScope } from '@/hooks/useModalFocusScope'
import type { CodeCopy } from './copy'

export function AppModeDialog({
  canInstall,
  canFullscreen,
  fullscreenActive,
  installUnavailableReason,
  copy,
  onClose,
  onInstall,
  onToggleFullscreen,
}: {
  canInstall: boolean
  canFullscreen: boolean
  fullscreenActive: boolean
  installUnavailableReason: string
  copy: CodeCopy
  onClose: () => void
  onInstall: () => void
  onToggleFullscreen: () => void
}) {
  const closeButtonRef = useRef<HTMLButtonElement | null>(null)
  const returnFocusRef = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null)
  const dialogRef = useModalFocusScope({
    open: true,
    initialFocusRef: closeButtonRef,
    returnFocusRef,
    onEscape: onClose,
    dismissOnPointerOutside: true,
  })

  return createPortal(
    <div className="code-app-mode-backdrop" data-testid="code-app-mode-dialog" role="presentation">
      <section
        ref={dialogRef}
        className="code-app-mode-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="code-app-mode-title"
      >
        <button ref={closeButtonRef} type="button" className="code-app-mode-close" aria-label={copy.cancel} onClick={onClose}>×</button>
        <header className="code-app-mode-heading">
          <img src={appPath('/farming-2/app-icon-v2-180.png')} alt="" aria-hidden="true" />
          <div>
            <h2 id="code-app-mode-title">{copy.appModeTitle}</h2>
            <p>{copy.appModeDescription}</p>
          </div>
        </header>

        {canInstall ? (
          <section className="code-app-mode-choice recommended">
            <span className="code-app-mode-recommended">{copy.appModeRecommended}</span>
            <h3>{copy.appModeInstallTitle}</h3>
            <p>{copy.appModeInstallDescription}</p>
            <button type="button" className="code-app-mode-install" data-testid="code-app-mode-install" onClick={onInstall}>
              {copy.appModeInstallAction}
            </button>
            <ol className="code-app-mode-install-steps">
              <li>{copy.appModeInstallStepOne}</li>
              <li>{copy.appModeInstallStepTwo}</li>
            </ol>
          </section>
        ) : (
          <section className="code-app-mode-choice unavailable" data-testid="code-app-mode-install-unavailable">
            <h3>{copy.appModeInstallUnavailableTitle}</h3>
            <p>{installUnavailableReason}</p>
          </section>
        )}

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
