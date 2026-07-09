import { DEFAULT_REVIEW_PREFERENCES, normalizeReviewPreferences } from './state'
import type { ReviewPreferences } from './state'

export type GerritIgnoreWhitespace =
  | 'IGNORE_ALL'
  | 'IGNORE_LEADING_AND_TRAILING'
  | 'IGNORE_NONE'
  | 'IGNORE_TRAILING'

export type GerritDiffPreferences = {
  context?: number
  font_size?: number
  ignore_whitespace?: GerritIgnoreWhitespace
  intraline_difference?: boolean
  line_length?: number
  line_wrapping?: boolean
  manual_review?: boolean
  show_tabs?: boolean
  show_whitespace_errors?: boolean
  syntax_highlighting?: boolean
  tab_size?: number
}

export function reviewIgnoreWhitespaceFromGerrit(value: unknown): ReviewPreferences['ignoreWhitespace'] {
  if (value === 'IGNORE_ALL') return 'ALL'
  if (value === 'IGNORE_LEADING_AND_TRAILING') return 'LEADING_AND_TRAILING'
  if (value === 'IGNORE_TRAILING') return 'TRAILING'
  return 'NONE'
}

export function reviewIgnoreWhitespaceToGerrit(value: ReviewPreferences['ignoreWhitespace']): GerritIgnoreWhitespace {
  if (value === 'ALL') return 'IGNORE_ALL'
  if (value === 'LEADING_AND_TRAILING') return 'IGNORE_LEADING_AND_TRAILING'
  if (value === 'TRAILING') return 'IGNORE_TRAILING'
  return 'IGNORE_NONE'
}

export function reviewPreferencesFromGerritDiffPreferences(value: unknown): ReviewPreferences {
  const prefs = value && typeof value === 'object' && !Array.isArray(value)
    ? value as GerritDiffPreferences
    : {}
  return normalizeReviewPreferences({
    autoMarkReviewed: typeof prefs.manual_review === 'boolean'
      ? !prefs.manual_review
      : DEFAULT_REVIEW_PREFERENCES.autoMarkReviewed,
    context: prefs.context,
    fitToScreen: typeof prefs.line_wrapping === 'boolean'
      ? prefs.line_wrapping
      : DEFAULT_REVIEW_PREFERENCES.fitToScreen,
    fontSize: prefs.font_size,
    ignoreWhitespace: reviewIgnoreWhitespaceFromGerrit(prefs.ignore_whitespace),
    intralineDifference: prefs.intraline_difference,
    lineLength: prefs.line_length,
    showTabs: prefs.show_tabs,
    showTrailingWhitespace: prefs.show_whitespace_errors,
    syntaxHighlighting: prefs.syntax_highlighting,
    tabSize: prefs.tab_size,
  })
}

export function reviewPreferencesToGerritDiffPreferences(preferences: ReviewPreferences): GerritDiffPreferences {
  const normalized = normalizeReviewPreferences(preferences)
  return {
    context: normalized.context,
    font_size: normalized.fontSize,
    ignore_whitespace: reviewIgnoreWhitespaceToGerrit(normalized.ignoreWhitespace),
    intraline_difference: normalized.intralineDifference,
    line_length: normalized.lineLength,
    line_wrapping: normalized.fitToScreen,
    manual_review: !normalized.autoMarkReviewed,
    show_tabs: normalized.showTabs,
    show_whitespace_errors: normalized.showTrailingWhitespace,
    syntax_highlighting: normalized.syntaxHighlighting,
    tab_size: normalized.tabSize,
  }
}
