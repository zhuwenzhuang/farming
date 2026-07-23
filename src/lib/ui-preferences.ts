export type UiAppearance = 'system' | 'light' | 'dark'
export type ResolvedUiAppearance = Exclude<UiAppearance, 'system'>
export type UiLanguage = 'en' | 'zh'

export interface UiPreferences {
  appearance: UiAppearance
  language: UiLanguage
}

export const DEFAULT_UI_PREFERENCES: UiPreferences = {
  appearance: 'system',
  language: 'en',
}

export function normalizeUiAppearance(value: unknown): UiAppearance {
  return value === 'system' || value === 'light' || value === 'dark'
    ? value
    : DEFAULT_UI_PREFERENCES.appearance
}

export function normalizeUiLanguage(value: unknown): UiLanguage {
  return value === 'zh' || value === 'en'
    ? value
    : DEFAULT_UI_PREFERENCES.language
}

export function resolveUiAppearance(preference: UiAppearance): ResolvedUiAppearance {
  if (preference !== 'system') return preference
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light'
}
