import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_REVIEW_PREFERENCES,
  reviewIgnoreWhitespaceFromGerrit,
  reviewIgnoreWhitespaceToGerrit,
  reviewPreferencesFromGerritDiffPreferences,
  reviewPreferencesToGerritDiffPreferences,
} from '../src/lib/review-model'

test('maps Gerrit ignore whitespace values without losing leading-and-trailing', () => {
  assert.equal(reviewIgnoreWhitespaceFromGerrit('IGNORE_NONE'), 'NONE')
  assert.equal(reviewIgnoreWhitespaceFromGerrit('IGNORE_TRAILING'), 'TRAILING')
  assert.equal(reviewIgnoreWhitespaceFromGerrit('IGNORE_LEADING_AND_TRAILING'), 'LEADING_AND_TRAILING')
  assert.equal(reviewIgnoreWhitespaceFromGerrit('IGNORE_ALL'), 'ALL')
  assert.equal(reviewIgnoreWhitespaceFromGerrit('unknown'), 'NONE')

  assert.equal(reviewIgnoreWhitespaceToGerrit('NONE'), 'IGNORE_NONE')
  assert.equal(reviewIgnoreWhitespaceToGerrit('TRAILING'), 'IGNORE_TRAILING')
  assert.equal(reviewIgnoreWhitespaceToGerrit('LEADING_AND_TRAILING'), 'IGNORE_LEADING_AND_TRAILING')
  assert.equal(reviewIgnoreWhitespaceToGerrit('ALL'), 'IGNORE_ALL')
})

test('maps Gerrit manual_review to Farming autoMarkReviewed explicitly', () => {
  assert.equal(reviewPreferencesFromGerritDiffPreferences({ manual_review: true }).autoMarkReviewed, false)
  assert.equal(reviewPreferencesFromGerritDiffPreferences({ manual_review: false }).autoMarkReviewed, true)
  assert.equal(reviewPreferencesToGerritDiffPreferences({ ...DEFAULT_REVIEW_PREFERENCES, autoMarkReviewed: true }).manual_review, false)
  assert.equal(reviewPreferencesToGerritDiffPreferences({ ...DEFAULT_REVIEW_PREFERENCES, autoMarkReviewed: false }).manual_review, true)
})

test('normalizes Gerrit diff preferences into Farming review preferences', () => {
  assert.deepEqual(reviewPreferencesFromGerritDiffPreferences({
    context: 25,
    font_size: 14,
    ignore_whitespace: 'IGNORE_LEADING_AND_TRAILING',
    intraline_difference: false,
    line_length: 160,
    line_wrapping: false,
    manual_review: true,
    show_tabs: false,
    show_whitespace_errors: false,
    syntax_highlighting: false,
    tab_size: 4,
  }), {
    autoMarkReviewed: false,
    context: 25,
    fitToScreen: false,
    fontSize: 14,
    ignoreWhitespace: 'LEADING_AND_TRAILING',
    intralineDifference: false,
    lineLength: 160,
    showTabs: false,
    showTrailingWhitespace: false,
    syntaxHighlighting: false,
    tabSize: 4,
  })
})

test('exports Farming review preferences as Gerrit-style diff preferences', () => {
  assert.deepEqual(reviewPreferencesToGerritDiffPreferences({
    autoMarkReviewed: true,
    context: 100,
    fitToScreen: true,
    fontSize: 13,
    ignoreWhitespace: 'ALL',
    intralineDifference: true,
    lineLength: 120,
    showTabs: true,
    showTrailingWhitespace: false,
    syntaxHighlighting: true,
    tabSize: 2,
  }), {
    context: 100,
    font_size: 13,
    ignore_whitespace: 'IGNORE_ALL',
    intraline_difference: true,
    line_length: 120,
    line_wrapping: true,
    manual_review: false,
    show_tabs: true,
    show_whitespace_errors: false,
    syntax_highlighting: true,
    tab_size: 2,
  })
})
