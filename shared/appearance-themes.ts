import appearanceThemeData from './appearance-themes.json'

export const RESOLVED_APPEARANCES = ['light', 'dark', 'paper'] as const
export type ResolvedAppearance = typeof RESOLVED_APPEARANCES[number]

export interface AppearanceTerminalTheme extends Record<string, string> {
  background: string
  foreground: string
  cursor: string
  cursorAccent: string
  selectionBackground: string
  selectionInactiveBackground: string
}

export interface AppearanceTerminalSearchTheme extends Record<string, string> {
  matchBackground: string
  matchBorder: string
  matchOverviewRuler: string
  activeMatchBackground: string
  activeMatchBorder: string
  activeMatchColorOverviewRuler: string
}

export interface AppearanceThemeDefinition {
  css: Record<string, string>
  metadata: {
    colorScheme: string
    themeColor: string
  }
  terminal: AppearanceTerminalTheme
  terminalSearch: AppearanceTerminalSearchTheme
  monaco: {
    id: string
    base: string
    semantic: {
      type: string
      function: string
      variable: string
      enumMember: string
    }
    colors: Record<string, string>
  }
  mermaid: Record<string, string>
}

export type AppearanceThemeRegistry = Record<ResolvedAppearance, AppearanceThemeDefinition>

export const APPEARANCE_THEMES: AppearanceThemeRegistry = appearanceThemeData

export function isResolvedAppearance(value: unknown): value is ResolvedAppearance {
  return typeof value === 'string' && RESOLVED_APPEARANCES.includes(value as ResolvedAppearance)
}

export function appearanceTheme(value: unknown): AppearanceThemeDefinition {
  return APPEARANCE_THEMES[isResolvedAppearance(value) ? value : 'light']
}
