import { readPastedMarkdown } from './composer-markdown'
import { readPastedTextFormats } from './composer-paste-format'
import type { AgentComposerState } from './composer-state'
import type { ComposerContextReference } from './composer-message'

export const MAX_PASTED_TEXT_CHARS = 250_000

/** Count code points, matching the user's text rather than UTF-16 storage units. */
export function createPastedTextReference(text: string, html?: string): ComposerContextReference | null {
  if (text.length > MAX_PASTED_TEXT_CHARS) throw new Error('Pasted text exceeds 250,000 characters. Split it into smaller documents before pasting.')
  const textFormats = readPastedTextFormats(text, html)
  const editableMarkdown = readPastedMarkdown(text, html)
  if (Array.from(text).length <= 1000 && !textFormats) return null
  const firstLine = text.split(/\r\n|\r|\n/, 1)[0]?.trim() || 'Pasted text'
  return {
    id: `paste-${Date.now()}-${globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)}`,
    kind: 'pasted-text',
    label: Array.from(firstLine).slice(0, 80).join(''),
    text,
    ...(textFormats ? { textFormats } : {}),
    ...(editableMarkdown ? { editableMarkdown } : {}),
  }
}

export function attachPastedText(state: AgentComposerState, reference: ComposerContextReference, start: number, end: number) {
  return {
    ...state,
    draft: state.draft.slice(0, start) + state.draft.slice(end),
    contextReferences: [...(state.contextReferences || []), reference],
    history: { ...state.history, cursor: null },
  }
}

export function restorePastedText(state: AgentComposerState, id: string): AgentComposerState {
  const reference = state.contextReferences?.find(item => item.id === id && item.kind === 'pasted-text')
  if (!reference || reference.text === undefined) return state
  return {
    ...state,
    draft: state.draft + (state.draft ? '\n\n' : '') + (reference.editableMarkdown || reference.text),
    contextReferences: state.contextReferences?.filter(item => item.id !== id),
    history: { ...state.history, cursor: null },
  }
}

/** Intake is atomic: native plain paste, formatted insertion, or a folded snapshot. */
export function prepareComposerPaste(text: string, html: string | undefined, fold: boolean) {
  const reference = createPastedTextReference(text, html)
  if (fold && Array.from(text).length > 1000 && reference) return { reference }
  const markdown = reference?.editableMarkdown || readPastedMarkdown(text, html)
  return markdown ? { markdown } : null
}

/** Use native insertion so a formatted paste participates in browser undo/redo. */
export function insertFormattedComposerText(textarea: HTMLTextAreaElement, markdown: string) {
  textarea.focus({ preventScroll: true })
  if (!textarea.ownerDocument.execCommand('insertText', false, markdown)) {
    throw new Error('Formatted paste is unavailable. Use Shift+Cmd/Ctrl+V to paste plain text.')
  }
}
