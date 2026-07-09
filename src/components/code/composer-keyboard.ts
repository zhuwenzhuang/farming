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
) {
  if (event.key !== 'Enter' || event.shiftKey) return false
  if (isComposerImeCompositionEvent(event, compositionActive)) return false
  if (shouldSuppressComposerEnterAfterComposition(event, lastCompositionEndAt, now)) return false
  if (event.ctrlKey || event.metaKey || event.altKey) {
    return (event.ctrlKey === true || event.metaKey === true) && event.altKey !== true
  }
  return true
}

export function composerDraftForSubmit(
  textareaValue: string | null | undefined,
  latestDraft: string,
) {
  return textareaValue || latestDraft
}
