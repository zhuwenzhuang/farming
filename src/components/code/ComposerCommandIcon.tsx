import {
  BookGlyph,
  DifferenceGlyph,
  FieldFlagGlyph,
  HandGlyph,
  McpGlyph,
  SettingsGlyph,
  SkillGlyph,
  SpeedGlyph,
  TerminalSquareGlyph,
} from '@/components/IconGlyphs'
import type { SlashCommandOption } from './capabilities'

export function ComposerCommandIcon({ command }: { command: SlashCommandOption }) {
  if (command.source === 'skill') return <SkillGlyph />
  const name = command.command.toLowerCase()
  if (name === '/model' || name === '/reasoning' || name === '/mode') return <SettingsGlyph />
  if (name === '/permissions') return <HandGlyph />
  if (name === '/goal') return <FieldFlagGlyph />
  if (name === '/review') return <DifferenceGlyph />
  if (name === '/mcp') return <McpGlyph />
  if (name === '/fast') return <SpeedGlyph />
  if (name === '/help' || name === '/skills') return <BookGlyph />
  return <TerminalSquareGlyph />
}
