import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import * as monaco from 'monaco-editor'
import { writeClipboardText } from '@/lib/clipboard'
import type { CodeCopy } from '../code/copy'

const TOUCH_SOURCE_QUERY = '(max-width: 980px) and (any-pointer: coarse)'

// Native textareas normalize CRLF to LF. Convert their offsets without changing
// the file's line endings or selecting the wrong text after the first line.
function positionAt(text: string, offset: number) {
  const prefix = text.slice(0, offset)
  return { lineNumber: prefix.split('\n').length, column: offset - prefix.lastIndexOf('\n') }
}

export function useTouchFileSource() {
  const [enabled, setEnabled] = useState(() => window.matchMedia(TOUCH_SOURCE_QUERY).matches)
  useEffect(() => {
    const media = window.matchMedia(TOUCH_SOURCE_QUERY)
    const update = () => setEnabled(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  return enabled
}

export function FileEditorTouchSource({ value, readOnly, editorRef, label, activeTabDomId, copy }: {
  value: string
  readOnly: boolean
  editorRef: RefObject<monaco.editor.IStandaloneCodeEditor | null>
  label: string
  activeTabDomId: string
  copy: CodeCopy
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const copyRequestRef = useRef(0)
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [feedback, setFeedback] = useState<'copying' | 'copied' | 'failed' | 'uncertain' | null>(null)
  useEffect(() => () => {
    copyRequestRef.current++
    clearTimeout(copyTimerRef.current)
  }, [])

  const syncSelection = useCallback(() => {
    const textarea = textareaRef.current
    const editor = editorRef.current
    const model = editor?.getModel()
    if (!textarea || !editor || !model) return
    const start = positionAt(textarea.value, textarea.selectionStart)
    const end = positionAt(textarea.value, textarea.selectionEnd)
    editor.setSelection({ startLineNumber: start.lineNumber, startColumn: start.column,
      endLineNumber: end.lineNumber, endColumn: end.column })
  }, [editorRef])

  useEffect(() => {
    const textarea = textareaRef.current
    // React's synthetic onSelect depends on keyboard/mouse events. Native
    // selection handles and setSelectionRange also emit the DOM select event.
    textarea?.addEventListener('select', syncSelection)
    return () => textarea?.removeEventListener('select', syncSelection)
  }, [syncSelection])

  const changeText = (next: string) => {
    const editor = editorRef.current
    const model = editor?.getModel()
    if (readOnly || !editor || !model) return
    // Preserve the shared model and undo stack; only replace the changed span.
    const previous = model.getValue(monaco.editor.EndOfLinePreference.LF)
    let start = 0
    while (start < previous.length && start < next.length && previous[start] === next[start]) start++
    let end = previous.length
    let nextEnd = next.length
    while (end > start && nextEnd > start && previous[end - 1] === next[nextEnd - 1]) { end--; nextEnd-- }
    const from = positionAt(previous, start)
    const to = positionAt(previous, end)
    editor.executeEdits('native-file-input', [{ range: {
      startLineNumber: from.lineNumber, startColumn: from.column,
      endLineNumber: to.lineNumber, endColumn: to.column,
    }, text: next.slice(start, nextEnd) }])
    syncSelection()
    setFeedback(current => current === 'copying' ? current : null)
  }

  const selectAll = () => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.focus({ preventScroll: true })
    textarea.select()
    syncSelection()
    setFeedback(current => current === 'copying' ? current : null)
  }

  const copyText = async () => {
    const textarea = textareaRef.current
    if (!textarea || copyTimerRef.current !== undefined) return
    const text = textarea.selectionStart === textarea.selectionEnd
      ? textarea.value : textarea.value.slice(textarea.selectionStart, textarea.selectionEnd)
    const request = ++copyRequestRef.current
    setFeedback('copying')
    copyTimerRef.current = setTimeout(() => {
      copyRequestRef.current++
      copyTimerRef.current = undefined
      setFeedback('uncertain')
    }, 5000)
    const copied = await writeClipboardText(text)
    if (request !== copyRequestRef.current) return
    clearTimeout(copyTimerRef.current)
    copyTimerRef.current = undefined
    setFeedback(copied ? 'copied' : 'failed')
  }

  const feedbackText = feedback === 'copying' ? copy.codeBlockCopying
    : feedback === 'copied' ? copy.codeBlockCopied
      : feedback === 'uncertain' ? copy.codeBlockCopyUncertain : copy.copyFailed

  return <div id="code-file-editor-panel" role="tabpanel" aria-labelledby={activeTabDomId}
    className="code-file-touch-source" data-testid="code-file-touch-source">
    <div className="code-file-touch-toolbar code-content-toolbar">
      <button type="button" className="code-content-toolbar-text" onClick={selectAll}>{copy.selectAll}</button>
      <button type="button" className="code-content-toolbar-text" onClick={() => { void copyText() }} disabled={!value || feedback === 'copying'}>{copy.copy}</button>
      {feedback && <span role={feedback === 'failed' || feedback === 'uncertain' ? 'alert' : 'status'}>{feedbackText}</span>}
    </div>
    <textarea ref={textareaRef} aria-label={label} value={value} readOnly={readOnly}
      autoCapitalize="none" autoCorrect="off" spellCheck={false}
      onChange={event => changeText(event.currentTarget.value)} />
  </div>
}
