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

  const slashMatch = lineBeforeCursor.match(/^(\s*)\/([^\s/]*)$/u)
  if (slashMatch) {
    return {
      start: lineStart + (slashMatch[1]?.length ?? 0),
      end: cursor,
      query: slashMatch[2] ?? '',
      trigger: '/',
    }
  }

  const mentionMatch = lineBeforeCursor.match(/(^|[\s([{（【「])\$([^\s$]*)$/u)
  if (!mentionMatch) return null
  if (mentionMatch[2] && /^[A-Z][A-Z0-9_]*$/.test(mentionMatch[2])) return null

  return {
    start: lineStart + (mentionMatch.index ?? 0) + (mentionMatch[1]?.length ?? 0),
    end: cursor,
    query: mentionMatch[2] ?? '',
    trigger: '$',
  }
}

export function matchesComposerCommand(command: SlashCommandOption, query: string, trigger: '/' | '$') {
  const normalizedQuery = query.trim().toLowerCase()
  if (trigger === '$' && command.source !== 'skill') return false
  if (trigger === '/' && !command.command.startsWith('/') && command.source !== 'skill') return false
  if (!normalizedQuery) return true
  const name = command.command.replace(/^[/$]/, '').toLowerCase()
  return (
    name.startsWith(normalizedQuery)
    || command.label.toLowerCase().includes(normalizedQuery)
    || (normalizedQuery.length >= 3 && command.description.toLowerCase().includes(normalizedQuery))
  )
}

export function rankComposerCommand(command: SlashCommandOption, query: string) {
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) return 0
  return command.command.replace(/^[/$]/, '').toLowerCase().startsWith(normalizedQuery) ? 0 : 1
}

export function composerCommandGroup(command: SlashCommandOption): 'Farming actions' | 'Agent commands' | 'Skills' {
  if (command.source === 'skill') return 'Skills'
  if (command.source === 'farming') return 'Farming actions'
  return 'Agent commands'
}

export function composerCommandTestId(command: string) {
  const suffix = command.replace(/^[/$]/, '').replace(/[^A-Za-z0-9_-]+/g, '-')
  return `code-slash-command-${suffix || 'root'}`
}
