import { Editor, Extension } from '@tiptap/core'
import { Plugin, TextSelection } from '@tiptap/pm/state'
import { useLayoutEffect, useRef, useState, type HTMLAttributes, type RefObject } from 'react'
import { composerDocumentText, literalComposerDocument, type ComposerDocument } from '../../../shared/composer-document.js'
import { composerEditorExtensions, composerTextOffset, composerTextPositions, editorDocument, guardComposerComposition, pasteComposerDocument, textSlice, replaceComposerText } from './composer-document-editor'
import type { ComposerInputElement, StructuredComposerElement } from './composer-input-element'

interface Props extends Omit<HTMLAttributes<StructuredComposerElement>, 'onChange'> {
  inputRef: RefObject<ComposerInputElement | null>
  value: string
  document?: ComposerDocument
  disabled: boolean
  placeholder: string
  onValueChange: (text: string, document: ComposerDocument) => void
  'data-testid': string
}
export function ComposerRichInput({ inputRef, value, document, disabled, placeholder, onValueChange, 'data-testid': testId, onPaste, ...props }: Props) {
  const mount = useRef<StructuredComposerElement>(null)
  const editorRef = useRef<Editor | null>(null)
  const current = useRef({ value, document, disabled, placeholder, onValueChange })
  current.current = { value, document, disabled, placeholder, onValueChange }
  const [error, setError] = useState('')
  useLayoutEffect(() => {
    const host = mount.current
    if (!host) return
    let external = false
    let revealFrame = 0
    const editor = new Editor({
      element: host,
      content: (current.current.document || literalComposerDocument(current.current.value)).doc,
      editable: !current.current.disabled,
      extensions: [...composerEditorExtensions, Extension.create({
        name: 'boundedComposerDocument', addProseMirrorPlugins: () => [new Plugin({ filterTransaction: tr => {
          if (!tr.docChanged) return true
          try { editorDocument(tr.doc); return true } catch (caught) { setError(String(caught)); return false }
        } })],
      })],
      enableInputRules: false, enablePasteRules: false,
      editorProps: {
        attributes: state => ({
          'data-testid': testId, role: 'textbox', 'aria-multiline': 'true',
          'data-placeholder': current.current.placeholder,
          // CSS child selectors ignore text nodes beside ProseMirror's breaks.
          'data-empty': String(state.doc.childCount === 1 && state.doc.firstChild?.type.name === 'paragraph' && state.doc.firstChild.content.size === 0),
          class: 'code-composer-document', spellcheck: 'false', 'aria-label': current.current.placeholder,
        }),
        handlePaste(view, event) {
          try { const handled = pasteComposerDocument(view, event); setError(''); return handled }
          catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); return true }
        },
      },
      onUpdate: ({ editor }) => {
        if (external) return
        const snapshot = editorDocument(editor.state.doc)
        setError(''); current.current.onValueChange(composerDocumentText(snapshot), snapshot)
      },
    })
    guardComposerComposition(editor.view)
    editorRef.current = editor
    const range = (start: number, end: number, direction?: 'forward' | 'backward' | 'none') => {
      const positions = composerTextPositions(editor.state.doc)
      const clamp = (offset: number) => positions[Math.max(0, Math.min(offset, positions.length - 1))] ?? 1
      editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, clamp(direction === 'backward' ? end : start), clamp(direction === 'backward' ? start : end))))
    }
    Object.defineProperties(host, {
      value: { configurable: true, get: () => composerDocumentText(editorDocument(editor.state.doc)), set: (text: string) => { editor.commands.setContent(replaceComposerText(editorDocument(editor.state.doc), text).doc) } },
      selectionStart: { configurable: true, get: () => composerTextOffset(editor.state.doc, editor.state.selection.from) },
      selectionEnd: { configurable: true, get: () => composerTextOffset(editor.state.doc, editor.state.selection.to) },
      selectionDirection: { configurable: true, get: () => editor.state.selection.anchor <= editor.state.selection.head ? 'forward' : 'backward' },
      disabled: { configurable: true, get: () => current.current.disabled },
    })
    host.setSelectionRange = range
    host.setRangeText = (text, start = host.selectionStart, end = host.selectionEnd) => {
      range(start, end)
      const tr = editor.state.tr
      if (tr.selection.$from.parent.type.spec.code) tr.insertText(text)
      else tr.replaceSelection(textSlice(text, editor.state.schema))
      editor.view.dispatch(tr)
    }
    host.select = () => range(0, host.value.length)
    host.focus = options => {
      if (editor.view.hasFocus()) return
      editor.view.dom.focus(options)
      // Native focus can put the DOM caret at the start while the editor still
      // holds its previous selection. Synchronize both before the next keystroke.
      editor.view.focus()
    }
    inputRef.current = host
    // Local echoes retain document/selection. Reveal after native input and
    // React layout settle; WebKit can scroll again after the input transaction.
    // Only an owner-driven replacement resets editor content.
    const restore = () => {
      const source = current.current.document || literalComposerDocument(current.current.value)
      const snapshot = composerDocumentText(source) === current.current.value ? source : replaceComposerText(source, current.current.value)
      if (editor.state.doc.eq(editor.schema.nodeFromJSON(snapshot.doc))) {
        cancelAnimationFrame(revealFrame)
        revealFrame = requestAnimationFrame(() => {
          if (editor.view.hasFocus()) editor.commands.scrollIntoView()
        })
        return
      }
      external = true
      try { editor.commands.setContent(snapshot.doc, { emitUpdate: false }) } finally { external = false }
    }
    restoreRef.current = restore
    return () => { cancelAnimationFrame(revealFrame); if (inputRef.current === host) inputRef.current = null; restoreRef.current = null; editorRef.current = null; editor.destroy() }
  }, [inputRef, testId])
  const restoreRef = useRef<(() => void) | null>(null)
  useLayoutEffect(() => { restoreRef.current?.() }, [value, document])
  useLayoutEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    editor.setEditable(!disabled, false)
    editor.view.dom.setAttribute('data-placeholder', placeholder)
    editor.view.dom.setAttribute('aria-label', placeholder)
  }, [disabled, placeholder])
  useLayoutEffect(() => {
    const dom = editorRef.current?.view.dom
    if (!dom) return
    dom.setAttribute('enterkeyhint', props.enterKeyHint || 'enter')
    dom.setAttribute('inputmode', props.inputMode || 'text')
    dom.setAttribute('autocapitalize', props.autoCapitalize || 'none')
    dom.setAttribute('autocorrect', props.autoCorrect || 'off')
  }, [props.enterKeyHint, props.inputMode, props.autoCapitalize, props.autoCorrect])
  return <><div {...props} ref={mount} aria-disabled={disabled} className="code-rich-input" data-composer-rich-input="true" onPasteCapture={onPaste} onKeyDown={undefined} onKeyDownCapture={props.onKeyDown} />{error ? <div className="code-related-session-error" role="alert">{error}</div> : null}</>
}
