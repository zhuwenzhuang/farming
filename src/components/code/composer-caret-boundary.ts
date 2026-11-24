import { Selection } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'

/** Map a focused native caret at a document edge back into editable text. */
export function observeComposerCaretBoundary(view: EditorView, shell: HTMLElement, revealCaret: () => void) {
  const document = shell.ownerDocument
  const reconcile = () => {
    if (!view.editable || !view.hasFocus() || view.composing) return
    const caret = document.getSelection()
    if (!caret?.isCollapsed || !caret.anchorNode) return
    const { anchorNode, anchorOffset } = caret
    // The two native boundaries may be reported on the root itself or
    // immediately beside either wrapper. Sibling controls own their selections.
    const child = anchorNode === shell ? view.dom : shell
    const atStart = anchorNode === view.dom
      ? anchorOffset === 0
      : anchorNode.childNodes[anchorOffset] === child
    const atEnd = anchorNode === view.dom
      ? anchorOffset === anchorNode.childNodes.length
      : anchorNode.childNodes[anchorOffset - 1] === child
    if (!atStart && !atEnd) return
    const selection = atStart ? Selection.atStart(view.state.doc) : Selection.atEnd(view.state.doc)
    if (!selection.eq(view.state.selection)) view.dispatch(view.state.tr.setSelection(selection))
    view.focus()
  }
  const afterComposition = () => {
    // ProseMirror commits pending composition DOM mutations in a microtask.
    // Choosing the document end before that commit would restore a stale caret.
    queueMicrotask(() => { if (!view.isDestroyed) reconcile() })
  }

  const onSelectionChange = () => {
    if (!view.hasFocus() || view.composing) return
    reconcile()
    revealCaret()
  }
  document.addEventListener('selectionchange', onSelectionChange)
  // Native movement need not emit keydown, and selectionchange may be delivered
  // after the next input event. Repair before composition takes ownership.
  shell.addEventListener('beforeinput', reconcile, true)
  shell.addEventListener('compositionstart', reconcile, true)
  shell.addEventListener('compositionend', afterComposition)
  return () => {
    document.removeEventListener('selectionchange', onSelectionChange)
    shell.removeEventListener('beforeinput', reconcile, true)
    shell.removeEventListener('compositionstart', reconcile, true)
    shell.removeEventListener('compositionend', afterComposition)
  }
}
