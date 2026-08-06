import { createPortal } from 'react-dom'
import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import { appPath } from '@/lib/base-path'
import { useEscapeKey } from '@/hooks/useKeyboard'
import type { UiLanguage } from '@/lib/ui-preferences'
import type { CodeCopy } from './copy'

const FARMING_GITHUB_URL = 'https://github.com/zhuwenzhuang/farming'
const FARMING_DOCS_URL: Record<UiLanguage, string> = {
  en: 'https://zhuwenzhuang.github.io/farming/en/',
  zh: 'https://zhuwenzhuang.github.io/farming/cn/',
}

export function BrandAboutDialog({
  copy,
  language,
  version,
  onClose,
  returnFocusRef,
}: {
  copy: CodeCopy
  language: UiLanguage
  version: string
  onClose: () => void
  returnFocusRef: RefObject<HTMLElement | null>
}) {
  const closeButtonRef = useRef<HTMLButtonElement | null>(null)
  useEscapeKey(onClose)

  useEffect(() => {
    // The return target is the sidebar trigger that opened this dialog; it stays
    // mounted for the dialog's lifetime, so capturing it here restores focus to
    // the same element the cleanup would have read.
    const returnFocusTarget = returnFocusRef.current
    closeButtonRef.current?.focus({ preventScroll: true })
    return () => {
      returnFocusTarget?.focus({ preventScroll: true })
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
        <div className="code-brand-links">
          <a className="code-brand-github" href={FARMING_DOCS_URL[language]} target="_blank" rel="noreferrer">
            {language === 'zh' ? '文档' : 'Documentation'}
          </a>
          <span aria-hidden="true"> · </span>
          <a className="code-brand-github" href={FARMING_GITHUB_URL} target="_blank" rel="noreferrer">{copy.brandGithub}</a>
        </div>
      </section>
    </div>,
    document.body,
  )
}
