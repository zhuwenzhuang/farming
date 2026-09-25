export interface ComposerContextTrigger {
  start: number
  end: number
  query: string
}

export function findComposerContextTrigger(draft: string, selectionStart: number): ComposerContextTrigger | null {
  const end = Math.max(0, Math.min(selectionStart, draft.length))
  const beforeCaret = draft.slice(0, end)
  const match = beforeCaret.match(/(^|[\s([{（【「])@([^\s@]*)$/u)
  if (!match) return null
  return {
    start: (match.index ?? 0) + (match[1]?.length ?? 0),
    end,
    query: match[2] || '',
  }
}
