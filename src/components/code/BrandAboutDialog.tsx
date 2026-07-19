import { createPortal } from 'react-dom'
import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import { appPath } from '@/lib/base-path'
import type { CodeCopy } from './copy'

const FARMING_GITHUB_URL = 'https://github.com/zhuwenzhuang/farming'

export function BrandAboutDialog({
  copy,
  version,
  onClose,
  returnFocusRef,
}: {
  copy: CodeCopy
  version: string
  onClose: () => void
  returnFocusRef: RefObject<HTMLElement | null>
}) {
  const closeButtonRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    closeButtonRef.current?.focus({ preventScroll: true })
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      returnFocusRef.current?.focus({ preventScroll: true })
    }
  }, [onClose, returnFocusRef])

  return createPortal(
    <div className="code-brand-backdrop" data-testid="code-brand-dialog" role="presentation" onPointerDown={onClose}>
      <section
        className="code-brand-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="code-brand-title"
        onPointerDown={event => event.stopPropagation()}
      >
        <button ref={closeButtonRef} type="button" className="code-brand-close" aria-label={copy.cancel} onClick={onClose}>×</button>
        <img className="code-brand-logo" src={appPath('/farming-2/app-icon-v2-180.png')} alt="" aria-hidden="true" />
        <div className="code-brand-heading">
          <h2 id="code-brand-title">Farming Code</h2>
          {version && <span>{version}</span>}
        </div>
        <div className="code-brand-story">
          <p>{copy.brandStoryOrigin}</p>
          <p>{copy.brandStoryPurpose}</p>
        </div>
        <a className="code-brand-github" href={FARMING_GITHUB_URL} target="_blank" rel="noreferrer">{copy.brandGithub}</a>
      </section>
    </div>,
    document.body,
  )
}
