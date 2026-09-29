import type { AgentComposerState } from './composer-state'
import type { ComposerContextReference } from './composer-message'

export const MAX_PASTED_TEXT_CHARS = 250_000

/** Count code points, matching the user's text rather than UTF-16 storage units. */
export function createPastedTextReference(text: string): ComposerContextReference | null {
  if (text.length > MAX_PASTED_TEXT_CHARS) throw new Error('Pasted text exceeds 250,000 characters. Split it into smaller documents before pasting.')
  if (Array.from(text).length <= 1000) return null
  const firstLine = text.split(/\r\n|\r|\n/, 1)[0]?.trim() || 'Pasted text'
  return {
    id: `paste-${Date.now()}-${globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)}`,
    kind: 'pasted-text',
    label: Array.from(firstLine).slice(0, 80).join(''),
    text,
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
    draft: state.draft + (state.draft ? '\n\n' : '') + reference.text,
    contextReferences: state.contextReferences?.filter(item => item.id !== id),
    history: { ...state.history, cursor: null },
  }
}
