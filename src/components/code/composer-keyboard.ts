export const POST_COMPOSITION_ENTER_SUPPRESS_MS = 120

interface ComposerKeyboardEventLike {
  key: string
  shiftKey?: boolean
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
  isComposing?: boolean
  nativeEvent?: {
    isComposing?: boolean
    keyCode?: number
  }
}

export function isComposerImeCompositionEvent(event: ComposerKeyboardEventLike, compositionActive: boolean) {
  return (
    compositionActive
    || event.isComposing === true
    || event.nativeEvent?.isComposing === true
    || event.nativeEvent?.keyCode === 229
  )
}

export function shouldSuppressComposerEnterAfterComposition(
  event: ComposerKeyboardEventLike,
  lastCompositionEndAt: number,
  now = Date.now(),
) {
  return (
    event.key === 'Enter'
    && lastCompositionEndAt > 0
    && now - lastCompositionEndAt <= POST_COMPOSITION_ENTER_SUPPRESS_MS
  )
}

export function shouldSubmitComposerEnter(
  event: ComposerKeyboardEventLike,
  compositionActive: boolean,
  lastCompositionEndAt: number,
  now = Date.now(),
  enterSubmits = true,
) {
  if (event.key !== 'Enter' || event.shiftKey) return false
  if (isComposerImeCompositionEvent(event, compositionActive)) return false
  if (shouldSuppressComposerEnterAfterComposition(event, lastCompositionEndAt, now)) return false
  if (!enterSubmits) return false
  if (event.ctrlKey || event.metaKey || event.altKey) {
    return (event.ctrlKey === true || event.metaKey === true) && event.altKey !== true
  }
  return true
}

export function shouldAcceptComposerSuggestion(
  event: ComposerKeyboardEventLike,
  options: {
    compositionActive: boolean
    draft: string
    suggestion: string
    commandMenuOpen: boolean
    active: boolean
  },
) {
  return (
    event.key === 'Tab'
    && event.shiftKey !== true
    && !isComposerImeCompositionEvent(event, options.compositionActive)
    && options.active
    && !options.commandMenuOpen
    && options.draft.length === 0
    && options.suggestion.length > 0
  )
}

export function composerDraftForSubmit(
  textareaValue: string | null | undefined,
  latestDraft: string,
) {
  return textareaValue || latestDraft
}
