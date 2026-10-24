import { getSchema } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { Fragment, Slice, DOMParser as ProseMirrorParser, type Node as ProseMirrorNode, type Schema } from '@tiptap/pm/model'
import { EditorState, TextSelection } from '@tiptap/pm/state'
import { closeHistory } from '@tiptap/pm/history'
import type { EditorView } from '@tiptap/pm/view'
import { composerDocumentText, literalComposerDocument, normalizeComposerDocument, safeComposerLink, type ComposerDocument } from '../../../shared/composer-document.js'

export const composerEditorExtensions = [StarterKit.configure({
  horizontalRule: false, trailingNode: false,
  link: { autolink: false, openOnClick: false, linkOnPaste: false, isAllowedUri: url => safeComposerLink(url) },
})]
export const composerEditorSchema = getSchema(composerEditorExtensions)
export function editorDocument(node: ProseMirrorNode): ComposerDocument {
  const value = normalizeComposerDocument({ version: 1, doc: node.toJSON() })
  if (!value) throw new Error('Chat content exceeds the supported document limits.')
  return value
}
/** Map literal text offsets to ProseMirror positions for shared command/history controls. */
export function composerTextPositions(doc: ProseMirrorNode) {
  const positions: number[] = []; let offset = 0; let block = false
  doc.descendants((node, pos) => {
    if (node.isTextblock) { if (block) offset++; block = true; positions[offset] = pos + 1 }
    if (node.isText) { for (let i = 0; i <= (node.text?.length || 0); i++) positions[offset + i] = pos + i; offset += node.text?.length || 0 }
    if (node.type.name === 'hardBreak') { positions[offset++] = pos; positions[offset] = pos + 1 }
  })
  return positions.length ? positions : [1]
}
export function composerTextOffset(doc: ProseMirrorNode, position: number) {
  const map = composerTextPositions(doc)
  let index = 0
  while (index + 1 < map.length && (map[index + 1] ?? Infinity) <= position) index++
  return index
}
export function textSlice(text: string, schema: Schema = composerEditorSchema) {
  return new Slice(Fragment.fromArray(text.split('\n').flatMap((line, index) => [
    ...(index ? [schema.nodes.hardBreak!.create()] : []), ...(line ? [schema.text(line)] : []),
  ])), 0, 0)
}
export function replaceComposerText(document: ComposerDocument, text: string): ComposerDocument {
  const old = composerDocumentText(document)
  if (old === text) return document
  if (!text) return literalComposerDocument('')
  let start = 0; let end = 0
  while (start < old.length && start < text.length && old[start] === text[start]) start++
  while (end < old.length - start && end < text.length - start && old[old.length - 1 - end] === text[text.length - 1 - end]) end++
  // Never split a surrogate pair while replacing externally edited text.
  if (start > 0 && /[\uD800-\uDBFF]/.test(old[start - 1]!)) start--
  if (end > 0 && /[\uDC00-\uDFFF]/.test(old[old.length - end]!)) end--
  const state = EditorState.create({ schema: composerEditorSchema, doc: composerEditorSchema.nodeFromJSON(document.doc) })
  const map = composerTextPositions(state.doc)
  const from = map[start] ?? 1; const to = map[old.length - end] ?? state.doc.content.size - 1
  const inserted = text.slice(start, text.length - end)
  const transaction = state.tr.setSelection(TextSelection.create(state.doc, from, to))
  if (transaction.selection.$from.parent.type.spec.code) transaction.insertText(inserted)
  else transaction.replaceSelection(textSlice(inserted))
  const result = editorDocument(transaction.doc)
  // Block boundary deletion can change list structure; retain exact requested text.
  if (composerDocumentText(result) !== text) throw new Error('This text operation would change document structure. Edit the selected text in the input instead.')
  return result
}
export function pasteComposerDocument(view: EditorView, event: ClipboardEvent) {
  if (event.defaultPrevented) return true
  const data = event.clipboardData
  if (!data) return false
  const text = data.getData('text/plain'); const html = data.getData('text/html')
  if (text.length > 250_000 || html.length > 2_000_000) throw new Error('Pasted content is too large. Split it into smaller documents.')
  if (!text && !html) return false
  let language = ''; let vscodePlain = false
  try {
    const metadata: unknown = JSON.parse(data.getData('vscode-editor-data') || 'null')
    if (metadata && typeof metadata === 'object' && 'mode' in metadata && typeof metadata.mode === 'string') {
      vscodePlain = metadata.mode === 'plaintext'
      if (!vscodePlain && /^[\w#+.-]{1,64}$/.test(metadata.mode)) language = metadata.mode
    }
  } catch { /* Damaged source metadata is not evidence of a code block. */ }
  const tr = view.state.tr
  if (tr.selection.$from.parent.type.spec.code) tr.insertText(text)
  else if (language && text) tr.replaceSelectionWith(view.state.schema.nodes.codeBlock!.create({ language }, view.state.schema.text(text)))
  else if (html && !vscodePlain) {
    const dom = new DOMParser().parseFromString(html, 'text/html')
    dom.querySelectorAll('script,style,iframe,object,embed,meta,link').forEach(node => node.remove())
    dom.querySelectorAll('a').forEach(node => { if (!safeComposerLink(node.getAttribute('href'))) node.replaceWith(...node.childNodes) })
    dom.querySelectorAll('pre').forEach(pre => {
      pre.querySelectorAll('br').forEach(br => br.replaceWith(br.classList.contains('ProseMirror-trailingBreak') || br.hasAttribute('data-lexical-managed-linebreak') ? '' : '\n'))
    })
    const parser = ProseMirrorParser.fromSchema(view.state.schema)
    let slice = parser.parseSlice(dom.body)
    // Browser HTML copying uses non-breaking spaces to preserve ordinary spaces
    // at mark boundaries. Reconcile only when plain text proves that exact case.
    const parsedText = slice.content.textBetween(0, slice.content.size, '\n')
    if (!text.includes('\u00a0') && parsedText.includes('\u00a0') && parsedText.replace(/\u00a0/g, ' ') === text) {
      const walker = dom.createTreeWalker(dom.body, NodeFilter.SHOW_TEXT)
      while (walker.nextNode()) walker.currentNode.textContent = walker.currentNode.textContent?.replace(/\u00a0/g, ' ') || ''
      slice = parser.parseSlice(dom.body)
    }
    tr.replaceSelection(slice)
  } else tr.replaceSelection(textSlice(text, view.state.schema))
  editorDocument(tr.doc) // Reject atomically before committing an oversized document.
  view.dispatch(closeHistory(tr).scrollIntoView())
  view.dispatch(closeHistory(view.state.tr))
  return true
}
