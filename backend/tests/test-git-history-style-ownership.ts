import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import postcss, { type AtRule, type Container, type Rule } from 'postcss'

import { readCodeStyleSource } from './style-source-reader'

function splitSelectors(selectorList: string) {
  const selectors: string[] = []
  let current = ''
  let depth = 0
  let quote = ''
  for (const character of selectorList) {
    if (quote) {
      current += character
      if (character === quote) quote = ''
    } else if (character === '"' || character === "'") {
      quote = character
      current += character
    } else if (character === '(' || character === '[') {
      depth += 1
      current += character
    } else if (character === ')' || character === ']') {
      depth -= 1
      current += character
    } else if (character === ',' && depth === 0) {
      selectors.push(current.trim())
      current = ''
    } else {
      current += character
    }
  }
  if (current.trim()) selectors.push(current.trim())
  return selectors
}

function isGitHistorySelector(selector: string) {
  return /\.code-git-history(?:[-.:#\s>+~,]|\[|$)/.test(selector)
}

function normalize(value: string) {
  return value.replace(/\s+/g, ' ').trim()
}

function orderedRuleRecords(source: string) {
  const owned: string[] = []
  const remaining: string[] = []
  const visit = (container: Container, context: string[] = []) => {
    for (const node of container.nodes || []) {
      if (node.type === 'atrule') {
        const atRule = node as AtRule
        visit(atRule, [...context, `@${atRule.name} ${normalize(atRule.params)}`])
      } else if (node.type === 'rule') {
        const rule = node as Rule
        const body = normalize((rule.nodes || []).map(child => child.toString()).join(';'))
        for (const selector of splitSelectors(rule.selector)) {
          const record = `${context.join('>')}|${normalize(selector)}|${body}`
          ;(isGitHistorySelector(selector) ? owned : remaining).push(record)
        }
      }
    }
  }
  visit(postcss.parse(source))
  return { owned, remaining }
}

function digest(records: string[]) {
  return crypto.createHash('sha256').update(JSON.stringify(records)).digest('hex')
}

const main = orderedRuleRecords(readCodeStyleSource('src/styles/main.css'))
const history = orderedRuleRecords(readCodeStyleSource('src/styles/git-history.css'))
const dark = orderedRuleRecords(readCodeStyleSource('src/styles/code-dark.css'))
const historyDark = orderedRuleRecords(readCodeStyleSource('src/styles/git-history-dark.css'))

assert.equal(main.owned.length, 0, 'main.css must not retain Git History selectors')
assert.equal(dark.owned.length, 0, 'code-dark.css must not retain dark Git History selectors')
assert.equal(history.remaining.length, 0, 'git-history.css must contain only Git History selectors')
assert.equal(historyDark.remaining.length, 0, 'git-history-dark.css must contain only Git History selectors')

// Captured before extraction. Selector-level records prove that mixed selector
// groups retained their declarations, specificity, media context, and owner
// order while the monolith retained its complete non-History rule sequence.
assert.deepEqual(
  [history.owned.length, digest(history.owned)],
  [97, '4c72521b49f9ce74614cad4de1013069aa2ab32045b3c805e7e6d01bb91769f3'],
)
assert.deepEqual(
  [main.remaining.length, digest(main.remaining)],
  [2571, 'a21dc70786fb7b2a821e13d68e1d7f4202c106f6b9b354264931a0709fd66c5e'],
)
assert.deepEqual(
  [historyDark.owned.length, digest(historyDark.owned)],
  [40, '6d6b7cffb57f7cf12a21db699c8f9f8a118ecc47dc4e1ad1219de665837ed98b'],
)
assert.deepEqual(
  [dark.remaining.length, digest(dark.remaining)],
  [965, '6c37c809c9f48e84d4e2f2707fce2efad1e9d9a84efd0434be8a344bc3256056'],
)

console.log('test-git-history-style-ownership passed')
