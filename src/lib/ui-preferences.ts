import {
  DEFAULT_CODE_CONTENT_FONT_SIZE,
  normalizeContentFontSize,
} from '@/lib/content-font-size'

export type UiAppearance = 'system' | 'light' | 'dark'
export type ResolvedUiAppearance = Exclude<UiAppearance, 'system'>
export type UiLanguage = 'en' | 'zh'
export type ComposerFollowUpBehavior = 'queue' | 'steer'

export interface UiPreferences {
  appearance: UiAppearance
  codeContentFontSize: number
  composerFollowUpBehavior: ComposerFollowUpBehavior
  language: UiLanguage
}

export const DEFAULT_UI_PREFERENCES: UiPreferences = {
  appearance: 'system',
  codeContentFontSize: DEFAULT_CODE_CONTENT_FONT_SIZE,
  composerFollowUpBehavior: 'queue',
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

export function normalizeComposerFollowUpBehavior(value: unknown): ComposerFollowUpBehavior {
  return value === 'steer' ? 'steer' : 'queue'
}

export { normalizeContentFontSize }

export function resolveUiAppearance(preference: UiAppearance): ResolvedUiAppearance {
  if (preference !== 'system') return preference
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light'
}
