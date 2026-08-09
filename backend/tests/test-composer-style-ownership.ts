import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import postcss, { type AtRule, type Container, type Rule } from 'postcss'

import { readCodeStyleSource } from './style-source-reader'

const composerClassPrefixes = [
  'code-composer',
  'code-acp-composer',
  'code-pending-followup',
  'code-acp-pending-items',
  'code-acp-submission',
  'code-slash-menu',
  'code-slash-command',
  'code-plus-menu',
  'code-approval-menu',
  'code-approval-option',
  'code-approval-hand-glyph',
  'code-model-picker-menu',
  'code-model-menu',
  'code-model-submenu',
  'code-model-nested',
  'code-model-option',
  'code-speed-submenu',
  'code-speed-option',
  'code-model-matrix',
  'code-context-window',
  'code-tool-icon',
  'code-chevron',
  'code-menu-check',
  'code-menu-chevron-right',
  'code-acp-feedback',
  'code-acp-session-error',
  'code-acp-request',
  'code-acp-elicitation',
  'code-acp-authentication',
  'code-acp-auth-terminal',
  'code-acp-permission',
  'code-acp-sandbox',
  'code-acp-select-question',
] as const

const composerKeyframes = new Set([
  'code-voice-wave',
  'code-model-rocker-kick',
  'code-model-rocker-impact',
  'code-model-ultra-charge',
  'code-model-fast-kick',
  'code-model-charge-front',
  'code-model-matrix-reveal',
])

function splitSelectors(selectorList: string) {
  const selectors: string[] = []
  let current = ''
  let depth = 0
  let quote = ''
  for (const character of selectorList) {
    if (quote) {
      current += character
      if (character === quote) quote = ''
      continue
    }
    if (character === '"' || character === "'") {
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

function isComposerSelector(selector: string) {
  return composerClassPrefixes.some(prefix => (
    new RegExp(`\\.${prefix}(?:[-.:#\\s>+~\\[,]|$)`).test(selector)
  ))
}

function normalize(value: string) {
  return value.replace(/\s+/g, ' ').trim()
}

function orderedRuleRecords(source: string) {
  const composer: string[] = []
  const remaining: string[] = []
  const visit = (container: Container, context: string[] = []) => {
    for (const node of container.nodes || []) {
      if (node.type === 'atrule') {
        const atRule = node as AtRule
        if (/keyframes$/i.test(atRule.name) && composerKeyframes.has(atRule.params.trim())) {
          composer.push(`@${atRule.name} ${atRule.params}|${normalize(atRule.toString())}`)
        } else {
          visit(atRule, [...context, `@${atRule.name} ${normalize(atRule.params)}`])
        }
      } else if (node.type === 'rule') {
        const rule = node as Rule
        const body = normalize((rule.nodes || []).map(child => child.toString()).join(';'))
        for (const selector of splitSelectors(rule.selector)) {
          const record = `${context.join('>')}|${normalize(selector)}|${body}`
          const owner = isComposerSelector(selector) ? composer : remaining
          owner.push(record)
        }
      }
    }
  }
  visit(postcss.parse(source))
  return { composer, remaining }
}

function digest(records: string[]) {
  return crypto.createHash('sha256').update(JSON.stringify(records)).digest('hex')
}

const main = orderedRuleRecords(readCodeStyleSource('src/styles/main.css'))
const composer = orderedRuleRecords(readCodeStyleSource('src/styles/composer.css'))
const dark = orderedRuleRecords(readCodeStyleSource('src/styles/code-dark.css'))
const composerDark = orderedRuleRecords(readCodeStyleSource('src/styles/composer-dark.css'))

assert.equal(main.composer.length, 0, 'main.css must not retain Composer-owned selectors or keyframes')
assert.equal(dark.composer.length, 0, 'code-dark.css must not retain Composer-owned selectors')
assert.equal(composer.remaining.length, 0, 'composer.css must contain only Composer-owned rules')
assert.equal(composerDark.remaining.length, 0, 'composer-dark.css must contain only Composer-owned rules')

// These ordered hashes were captured from the two monolithic source files before
// extraction. Splitting comma groups into individual selectors proves that mixed
// rules kept their selector specificity, declaration bodies, media context, and
// relative order on both sides of the ownership boundary.
//
// This test locks only the Composer side of that boundary. The mutable
// main.css/code-dark.css remainder is owned by the newest extraction test
// (currently test-pet-style-ownership), so a later CSS split updates that single
// newest owner proof instead of every historical owner test.
assert.deepEqual(
  [composer.composer.length, digest(composer.composer)],
  [514, '63eb2bd78537ca490c61bc6cd088b630c80ccb09b93b6f3c4cda8826f7cba7d9'],
  'composer.css must preserve the ordered base Composer rule set from main.css',
)
assert.deepEqual(
  [composerDark.composer.length, digest(composerDark.composer)],
  [151, 'e47f36299c94a901369d26add5db92040fc42ab320999e5eadf1b8b51c96f082'],
  'composer-dark.css must preserve the ordered dark Composer rule set from code-dark.css',
)

console.log('test-composer-style-ownership passed')
