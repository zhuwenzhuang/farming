import { useLayoutEffect, useRef } from 'react'
import type {
  ClipboardEvent,
  CompositionEvent,
  FormEvent,
  KeyboardEvent,
  RefObject,
} from 'react'
import { isMobileTouchViewport } from '@/lib/responsive-mode'

interface MobileCodeComposerInputProps {
  testId?: string
  active: boolean
  draft: string
  placeholder: string
  minHeight: number
  maxHeight: number
  editorRef: RefObject<HTMLDivElement | null>
  onFocus: () => void
  onBlur: () => void
  onInput: (event: FormEvent<HTMLDivElement>) => void
  onPaste: (event: ClipboardEvent<HTMLElement>) => void
  onCompositionStart: () => void
  onCompositionEnd: (event: CompositionEvent<HTMLDivElement>) => void
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void
  onSelectionIntent: () => void
}

export function useMobileComposerHeight(composerRef: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const composer = composerRef.current
    if (!composer) return undefined
    const main = composer.closest('.code-main') as HTMLElement | null
    const clear = () => {
      composer.style.removeProperty('--mobile-composer-current-height')
      main?.style.removeProperty('--mobile-composer-current-height')
    }
    const publish = () => {
      if (!isMobileTouchViewport()) {
        clear()
        return
      }
      const height = composer.getBoundingClientRect().height
      if (height <= 0) return
      const value = `${Math.ceil(height)}px`
      composer.style.setProperty('--mobile-composer-current-height', value)
      main?.style.setProperty('--mobile-composer-current-height', value)
    }

    publish()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(publish)
    observer?.observe(composer)
    window.addEventListener('resize', publish)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', publish)
      clear()
    }
  }, [composerRef])
}

export function mobileComposerSelectionOffset(root: HTMLElement | null) {
  if (!root || typeof window === 'undefined') return 0
  const selection = window.getSelection()
  if (!selection || selection.rangeCount <= 0) return (root.textContent || '').length
  const range = selection.getRangeAt(0)
  if (!root.contains(range.startContainer)) return (root.textContent || '').length
  const beforeRange = range.cloneRange()
  beforeRange.selectNodeContents(root)
  beforeRange.setEnd(range.startContainer, range.startOffset)
  return beforeRange.toString().length
}

export function setMobileComposerSelectionOffset(root: HTMLElement | null, offset: number) {
  if (!root || typeof window === 'undefined') return
  root.normalize()
  const targetOffset = Math.max(0, Math.min(offset, (root.textContent || '').length))
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let remaining = targetOffset
  let current = walker.nextNode()
  while (current) {
    const text = current.textContent || ''
    if (remaining <= text.length) {
      const range = document.createRange()
      range.setStart(current, remaining)
      range.collapse(true)
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
      return
    }
    remaining -= text.length
    current = walker.nextNode()
  }

  const range = document.createRange()
  range.selectNodeContents(root)
  range.collapse(false)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
}

export function mobileComposerPlainText(root: HTMLElement | null) {
  if (!root) return ''
  return (root.innerText || root.textContent || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\n$/, '')
}

export function MobileCodeComposerInput({
  testId = 'code-composer-input',
  active,
  draft,
  placeholder,
  minHeight,
  maxHeight,
  editorRef,
  onFocus,
  onBlur,
  onInput,
  onPaste,
  onCompositionStart,
  onCompositionEnd,
  onKeyDown,
  onSelectionIntent,
}: MobileCodeComposerInputProps) {
  const mirrorRef = useRef<HTMLDivElement | null>(null)

  useLayoutEffect(() => {
    const editor = editorRef.current
    const mirror = mirrorRef.current
    if (!editor || !mirror) return

    if ((editor.textContent || '') !== draft) {
      editor.textContent = draft
    }

    mirror.innerText = draft || 'M'
    editor.style.minHeight = `${minHeight}px`
    editor.style.maxHeight = `${maxHeight}px`
    editor.style.height = 'auto'
    const measuredHeight = mirror.scrollHeight || editor.scrollHeight
    const nextHeight = Math.min(maxHeight, Math.max(minHeight, measuredHeight))
    editor.style.height = `${nextHeight}px`
  }, [draft, editorRef, maxHeight, minHeight])

  useLayoutEffect(() => {
    const editor = editorRef.current
    if (!editor) return

    // Keep this closer to Telegram-style chat inputs: a plain contenteditable
    // surface, not a form field. Chrome/iOS AutoFill can still treat
    // ARIA/input/autocomplete hints as form-like signals, so remove those from
    // the raw node instead of setting "off" and hoping the browser honors it.
    editor.removeAttribute('autocomplete')
    editor.removeAttribute('aria-autocomplete')
    editor.removeAttribute('inputmode')
    editor.setAttribute('autocorrect', 'off')
    editor.setAttribute('autocapitalize', 'none')
    editor.setAttribute('spellcheck', 'false')
  }, [editorRef])

  return (
    <>
      <div
        data-testid={testId}
        ref={editorRef}
        className="code-composer-mobile-input"
        aria-disabled={!active}
        contentEditable={active ? 'true' : 'false'}
        suppressContentEditableWarning
        enterKeyHint="send"
        tabIndex={active ? 0 : -1}
        autoCorrect="off"
        autoCapitalize="none"
        spellCheck={false}
        data-placeholder={placeholder}
        data-lpignore="true"
        data-1p-ignore="true"
        data-bwignore="true"
        data-form-type="other"
        data-gramm="false"
        data-ms-editor="false"
        onFocus={onFocus}
        onBlur={onBlur}
        onInput={onInput}
        onPaste={onPaste}
        onCompositionStart={onCompositionStart}
        onCompositionEnd={onCompositionEnd}
        onKeyDown={onKeyDown}
        onKeyUp={onSelectionIntent}
        onMouseUp={onSelectionIntent}
      />
      <div
        ref={mirrorRef}
        className="code-composer-mobile-input-mirror"
        aria-hidden="true"
      />
    </>
  )
}
