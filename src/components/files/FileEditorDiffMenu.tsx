import { useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { CheckGlyph } from '@/components/IconGlyphs'
import { setFileEditorDiffMode, useFileEditorDiffPreference } from '@/lib/file-editor-diff-preference'
import type { CodeCopy } from '../code/copy'
import { useWorkspaceMenuKeyboard } from './useWorkspaceMenuKeyboard'

export function FileEditorDiffOptions({ copy, disabled, onSelect }: {
  copy: CodeCopy
  disabled: boolean
  onSelect: () => void
}) {
  const { enabled, layout } = useFileEditorDiffPreference()
  const current = enabled ? layout : 'off'
  return <>{([
    ['off', copy.closeDiff], ['inline', copy.diffInline], ['split', copy.diffSideBySide],
  ] as const).map(([mode, label]) => (
    <button key={mode} type="button" role="menuitemradio" aria-checked={current === mode} disabled={disabled}
      onClick={() => { setFileEditorDiffMode(mode); onSelect() }}>
      <span aria-hidden="true">{current === mode ? <CheckGlyph /> : null}</span>
      <span>{label}</span>
    </button>
  ))}</>
}

export function FileEditorDiffMenu({ copy, disabled, active, children }: {
  copy: CodeCopy
  disabled: boolean
  active: boolean
  children: ReactNode
}) {
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const close = () => setPosition(null)
  const closeWithFocus = () => { close(); triggerRef.current?.focus({ preventScroll: true }) }
  const onKeyDown = useWorkspaceMenuKeyboard({
    menuOpen: Boolean(position), positionKey: position, menuRef, triggerRef,
    onClose: close, onCloseWithFocusRestore: closeWithFocus, focusFirstItem: true,
  })
  const open = () => {
    const bounds = triggerRef.current?.getBoundingClientRect()
    if (bounds) setPosition({ left: Math.max(8, bounds.right - 224), top: bounds.bottom + 4 })
  }
  return <>
    <button ref={triggerRef} type="button" className={`code-file-editor-action narrow-overflow diff ${active ? 'active' : ''}`}
      data-testid="code-file-diff-menu-trigger" aria-label={active ? copy.fileDiff : copy.openFileDiff}
      title={copy.fileDiff} aria-haspopup="menu" aria-expanded={Boolean(position)} disabled={disabled}
      onClick={() => position ? close() : open()}
      onKeyDown={event => { if (event.key === 'ArrowDown') { event.preventDefault(); open() } }}>
      {children}
    </button>
    {position && createPortal(
      <div ref={menuRef} className="code-menu-surface code-menu-list code-file-editor-more-menu"
        data-testid="code-file-diff-menu" role="menu" aria-label={copy.fileDiff}
        style={position} onKeyDown={onKeyDown}>
        <FileEditorDiffOptions copy={copy} disabled={disabled} onSelect={closeWithFocus} />
      </div>, document.body,
    )}
  </>
}
