import { Selection } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'

/** Reconcile only the dead caret positions immediately outside our editable DOM. */
export function observeComposerCaretBoundary(view: EditorView, shell: HTMLElement) {
  const document = shell.ownerDocument
  const reconcile = () => {
    if (!view.editable || !view.hasFocus() || view.composing) return
    const caret = document.getSelection()
    if (!caret?.isCollapsed || caret.anchorNode !== shell) return
    const index = Array.from(shell.childNodes).indexOf(view.dom)
    if (index < 0 || (caret.anchorOffset !== index && caret.anchorOffset !== index + 1)) return

    // Focus alone is not proof of an editable caret. ProseMirror deliberately
    // ignores selections outside its DOM, so neither its model nor native input
    // can advance from this shell position without explicit reconciliation.
    const selection = caret.anchorOffset === index
      ? Selection.atStart(view.state.doc)
      : Selection.atEnd(view.state.doc)
    if (!selection.eq(view.state.selection)) view.dispatch(view.state.tr.setSelection(selection))
    view.focus()
  }
  const afterComposition = () => {
    // ProseMirror commits pending composition DOM mutations in a microtask.
    // Choosing the document end before that commit would restore a stale caret.
    queueMicrotask(() => { if (!view.isDestroyed) reconcile() })
  }

  document.addEventListener('selectionchange', reconcile)
  // Native movement need not emit keydown, and selectionchange may be delivered
  // after the next input event. Repair before composition takes ownership.
  shell.addEventListener('beforeinput', reconcile, true)
  shell.addEventListener('compositionstart', reconcile, true)
  shell.addEventListener('compositionend', afterComposition)
  return () => {
    document.removeEventListener('selectionchange', reconcile)
    shell.removeEventListener('beforeinput', reconcile, true)
    shell.removeEventListener('compositionstart', reconcile, true)
    shell.removeEventListener('compositionend', afterComposition)
  }
}
