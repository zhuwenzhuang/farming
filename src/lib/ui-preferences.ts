export type UiAppearance = 'light' | 'dark'
export type UiLanguage = 'en' | 'zh'

export interface UiPreferences {
  appearance: UiAppearance
  language: UiLanguage
}

export const DEFAULT_UI_PREFERENCES: UiPreferences = {
  appearance: 'light',
  language: 'en',
}

export function normalizeUiAppearance(value: unknown): UiAppearance {
  return value === 'light' || value === 'dark' ? value : DEFAULT_UI_PREFERENCES.appearance
}

export function normalizeUiLanguage(value: unknown): UiLanguage {
  return value === 'zh' || value === 'en'
    ? value
    : DEFAULT_UI_PREFERENCES.language
}

export function resolveUiAppearance(preference: UiAppearance) {
  return preference
}
