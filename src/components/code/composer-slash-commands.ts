import type { SlashCommandOption } from './capabilities'

export interface ComposerCommandTrigger {
  start: number
  end: number
  query: string
  trigger: '/' | '$'
}

export function findComposerCommandTrigger(draft: string, selectionStart: number): ComposerCommandTrigger | null {
  const cursor = Math.max(0, Math.min(selectionStart, draft.length))
  const lineStart = draft.lastIndexOf('\n', Math.max(0, cursor - 1)) + 1
  const lineBeforeCursor = draft.slice(lineStart, cursor)

  const slashMatch = lineBeforeCursor.match(/^(\s*)\/([A-Za-z0-9._:-]*)$/)
  if (slashMatch) {
    return {
      start: lineStart + (slashMatch[1]?.length ?? 0),
      end: cursor,
      query: slashMatch[2] ?? '',
      trigger: '/',
    }
  }

  const mentionMatch = lineBeforeCursor.match(/(^|\s)\$([A-Za-z0-9._:-]*)$/)
  if (!mentionMatch) return null

  return {
    start: lineStart + (mentionMatch.index ?? 0) + (mentionMatch[1]?.length ?? 0),
    end: cursor,
    query: mentionMatch[2] ?? '',
    trigger: '$',
  }
}

export function matchesComposerCommand(command: SlashCommandOption, query: string, trigger: '/' | '$') {
  const normalizedQuery = query.trim().toLowerCase()
  if (!command.command.startsWith(trigger)) return false
  if (!normalizedQuery) return true
  return (
    command.command.slice(1).toLowerCase().startsWith(normalizedQuery)
    || command.label.toLowerCase().includes(normalizedQuery)
  )
}

export function rankComposerCommand(command: SlashCommandOption, query: string) {
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) return 0
  return command.command.slice(1).toLowerCase().startsWith(normalizedQuery) ? 0 : 1
}

export function composerCommandTestId(command: string) {
  const suffix = command.replace(/^[/$]/, '').replace(/[^A-Za-z0-9_-]+/g, '-')
  return `code-slash-command-${suffix || 'root'}`
}
